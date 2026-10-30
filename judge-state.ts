import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Task-scoped structured judgement state. Derived only from verdicts and cheap
 * filesystem probes — never from an extra model summarization call.
 */

export type CriterionStatus = "met" | "unmet" | "pending" | "stale" | "conflict";

export interface EvidenceRef {
  kind: "file" | "test" | "git" | "other";
  path?: string;
  range?: string;
  /** Content fingerprint for files, repo snapshot id for tests. */
  fingerprint?: string;
  commit?: string;
  dirty?: string[];
  round: number;
  /** Where the raw record lives, so retrieval can return原文. */
  source?: string;
  claim?: string;
}

export interface CriterionState {
  id: string;
  criterion: string;
  status: CriterionStatus;
  evidence: EvidenceRef[];
  lastRound: number;
  verifiedAt: string;
  remaining?: string;
}

export interface TaskState {
  version: 1;
  progressSignature?: string;
  sessionId: string;
  /** Main-session branch tip this state was derived from; a different branch must rebuild. */
  branchTip?: string;
  contractKey: string;
  updatedAt: string;
  round: number;
  criteria: CriterionState[];
  open: string[];
  conflicts: string[];
  lastReportHash?: string;
  escalation?: string;
  /** Round when the evidence signature last changed; drives the stagnation guard. */
  lastProgressRound?: number;
  stagnantRounds?: number;
  /** Recent next_steps, newest last, to expose repetition to the judge. */
  recentNextSteps?: string[];
  /** Escalation adjudications spent on this task (bounded in config). */
  escalations?: number;
  lastVerdict?: { goalAchieved: boolean; humanNeeded: boolean; reason?: string; nextStep?: string };
}

export interface RepoSnapshot {
  head: string;
  dirty: string[];
}

const MAX_HASH_BYTES = 2 * 1024 * 1024;
const FILE_PATTERN = /(?:^|[\s"'`(])([\w@./-]*[\w-]\.(?:md|go|ts|tsx|js|json|jsonl|xlsx|txt|py|yml|yaml|sh))/g;

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function criterionId(criterion: string, index: number): string {
  return `C${index + 1}:${hashText(criterion).slice(0, 6)}`;
}

export function contractFingerprint(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** HEAD + porcelain; cheap and stable enough for test-evidence invalidation. */
export function snapshotRepo(cwd: string): RepoSnapshot | undefined {
  try {
    const run = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 }).trim();
    const head = run(["rev-parse", "HEAD"]);
    const dirty = run(["status", "--porcelain"]).split("\n").filter(Boolean)
      .map(line => line.slice(3).trim().replace(/^.* -> /, ""));
    return { head, dirty };
  } catch { return undefined; }
}

/** stat + (size-capped) content hash so an unchanged file is not re-read by the judge. */
export function fingerprintFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return undefined;
    const base = `${stat.mtimeMs}:${stat.size}`;
    if (stat.size > MAX_HASH_BYTES) return `${base}:large`;
    return `${base}:${createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16)}`;
  } catch { return undefined; }
}

export function extractPaths(text: string, cwd: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FILE_PATTERN)) {
    const raw = (match[1] || "").replace(/^\.\//, "");
    if (raw.length < 4 || raw.startsWith("http")) continue;
    const absolute = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
    if (absolute.startsWith(cwd)) found.add(absolute);
  }
  return [...found];
}

function fileRef(file: string, cwd: string, round: number, claim?: string): EvidenceRef | undefined {
  const fingerprint = fingerprintFile(file);
  if (!fingerprint) return undefined;
  return { kind: "file", path: file, fingerprint, round, claim: claim?.slice(0, 200),
    source: path.relative(cwd, file) };
}

/** Verdict → state, without any model call. Criteria are matched by exact text. */
export function applyVerdict(
  previous: TaskState | undefined,
  input: {
    sessionId: string; branchTip?: string; contractKey: string; round: number;
    criteria: string[];
    verdict: {
      goal_achieved?: boolean; human_needed?: boolean; reason?: string; next_step?: string;
      criteria_evidence?: Array<{ criterion?: string; evidence?: string }>;
      unmet_conditions?: string[]; evidence_conflicts?: string[]; records_missing?: string[];
    };
    report: string;
    cwd: string;
    escalationIncrement?: number;
    repo?: RepoSnapshot;
    now?: string;
  },
): TaskState {
  const now = input.now || new Date().toISOString();
  const prior = previous && previous.contractKey === input.contractKey && previous.sessionId === input.sessionId
    ? previous : undefined;
  const byCriterion = new Map((prior?.criteria || []).map(item => [item.criterion, item]));
  const evidenceItems = Array.isArray(input.verdict.criteria_evidence) ? input.verdict.criteria_evidence : [];
  const unmet = input.verdict.unmet_conditions || [];

  const criteria: CriterionState[] = input.criteria.map((criterion, index) => {
    const id = criterionId(criterion, index);
    const old = byCriterion.get(criterion);
    const supplied = evidenceItems.find(item => item.criterion === criterion && typeof item.evidence === "string");
    if (supplied) {
      const text = supplied.evidence!;
      const refs = extractPaths(text, input.cwd).map(file => fileRef(file, input.cwd, input.round, text)).filter(Boolean) as EvidenceRef[];
      const looksLikeTest = /\b(test|go test|pytest|npm test|jest)\b/i.test(text);
      if (looksLikeTest && input.repo) refs.push({ kind: "test", round: input.round, commit: input.repo.head,
        dirty: input.repo.dirty.slice(0, 200), claim: text.slice(0, 200), source: "verdict" });
      if (!refs.length) refs.push({ kind: "other", round: input.round, claim: text.slice(0, 200), source: "verdict" });
      return { id, criterion, status: "met", evidence: refs, lastRound: input.round, verifiedAt: now };
    }
    const blocked = unmet.find(item => item === criterion || item.includes(criterion.slice(0, 24)));
    if (blocked) return { id, criterion, status: "unmet", evidence: old?.evidence || [], lastRound: input.round,
      verifiedAt: now, remaining: blocked };
    if (old) return { ...old, id };
    return { id, criterion, status: "pending", evidence: [], lastRound: 0, verifiedAt: now };
  });

  const conflicts = [...new Set([...(input.verdict.evidence_conflicts || []), ...(input.verdict.records_missing || [])])];
  const signature = evidenceSignature(criteria, conflicts);
  const progressed = !prior?.progressSignature || prior.progressSignature !== signature;
  const nextStep = (input.verdict.next_step || "").trim();
  return {
    version: 1, progressSignature: signature, sessionId: input.sessionId, branchTip: input.branchTip, contractKey: input.contractKey,
    updatedAt: now, round: input.round, criteria,
    open: [...new Set(unmet)],
    conflicts,
    lastReportHash: hashText(input.report),
    escalation: input.verdict.goal_achieved ? "candidate-completion" : undefined,
    lastProgressRound: progressed ? input.round : (prior?.lastProgressRound ?? input.round),
    stagnantRounds: progressed ? 0 : (prior?.stagnantRounds ?? 0) + 1,
    recentNextSteps: [...(prior?.recentNextSteps || []), ...(nextStep ? [nextStep.slice(0, 160)] : [])].slice(-3),
    escalations: (prior?.escalations ?? 0) + (input.escalationIncrement ?? 0),
    lastVerdict: { goalAchieved: input.verdict.goal_achieved === true, humanNeeded: input.verdict.human_needed === true,
      reason: input.verdict.reason, nextStep: input.verdict.next_step },
  };
}

export interface Invalidation {
  stale: CriterionState[];
  reason: string;
}

/**
 * Cheap validity pass. A stale/unknown dependency becomes stale (must re-verify);
 * it never silently keeps an old PASS.
 */
export function invalidate(state: TaskState, repo: RepoSnapshot | undefined, cwd: string): Invalidation {
  const stale: CriterionState[] = [];
  for (const criterion of state.criteria) {
    if (criterion.status !== "met" && criterion.status !== "unmet") continue;
    for (const ref of criterion.evidence) {
      if (ref.kind === "file" && ref.path) {
        const now = fingerprintFile(ref.path);
        if (!now || now !== ref.fingerprint) { criterion.status = "stale"; stale.push(criterion); break; }
      } else if (ref.kind === "test") {
        const changed = !repo || repo.head !== ref.commit ||
          (ref.dirty || []).some(file => repo.dirty.includes(file)) ||
          // Unknown dependency graph: any new dirty path could affect the test.
          repo.dirty.some(file => !(ref.dirty || []).includes(file));
        if (changed) { criterion.status = "stale"; stale.push(criterion); break; }
      } else if (ref.kind === "other") {
        criterion.status = "stale"; stale.push(criterion); break;
      }
    }
  }
  return { stale, reason: stale.length ? `证据失效：${stale.map(item => item.id).join(",")}` : "" };
}

function evidenceSignature(criteria: CriterionState[], conflicts: string[]): string {
  return [criteria.map(item => `${item.id}:${item.status}:${item.evidence.map(ref =>
    ref.fingerprint || ref.commit || ref.kind).sort().join(",")}`).join("|"), [...conflicts].sort().join("|")].join("::");
}

export function stateDigest(state: TaskState): string {
  const rows = state.criteria.map(item => {
    const label = { met: "已满足", unmet: "未满足", pending: "待核验", stale: "已失效", conflict: "冲突" }[item.status];
    const refs = item.evidence.length ? `；证据 ${item.evidence.length} 条（${item.evidence.map(ref =>
      ref.kind === "file" ? path.basename(ref.path || "") : ref.kind).slice(0, 6).join(", ")}）` : "";
    return `- [${item.id}] ${label}：${item.criterion.slice(0, 160)}${refs}${item.remaining ? `（${item.remaining.slice(0, 120)}）` : ""}`;
  });
  return [`第 ${state.round} 轮结构化状态：`, ...rows,
    state.open.length ? `未闭环：${state.open.slice(0, 6).join("；")}` : "",
    state.conflicts.length ? `冲突/缺记录：${state.conflicts.slice(0, 4).join("；")}` : ""].filter(Boolean).join("\n");
}

/** L0: an explicit unmet condition still holds and nothing relevant changed. */
export function canShortCircuit(state: TaskState | undefined, reportHash: string, invalidation: Invalidation): string | undefined {
  if (!state) return undefined;
  if (state.conflicts.length) return undefined;
  if (state.escalation === "candidate-completion") return undefined;
  const unmet = state.criteria.filter(item => item.status === "unmet" && item.remaining);
  if (!unmet.length) return undefined;
  if (invalidation.stale.some(item => unmet.includes(item))) return undefined;
  if (state.lastReportHash === reportHash) return `未满足条件保持不变：${unmet[0].remaining!.slice(0, 120)}`;
  return undefined;
}

/** L2 triggers: completion claim, conflicts, missing/stale evidence for claimed criteria. */
export function needsDeepCheck(state: TaskState | undefined, invalidation: Invalidation, verdict?: { goal_achieved?: boolean; criteria_evidence?: unknown[] }): string | undefined {
  if (verdict?.goal_achieved) return "疑似全部满足，需深度核验";
  if (state?.conflicts.length) return "存在证据冲突或缺失记录";
  if (invalidation.stale.length) return `有 ${invalidation.stale.length} 项证据失效`;
  const met = (state?.criteria || []).filter(item => item.status === "met");
  if (met.length && met.some(item => item.evidence.some(ref => ref.kind === "other"))) return "存在无原始来源的证据";
  return undefined;
}

function stateFile(root: string, sessionId: string): string {
  return path.join(root, `${hashText(sessionId)}.json`);
}

export function readState(root: string, sessionId: string, contractKey: string, branchIds: string[]): TaskState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(root, sessionId), "utf8")) as TaskState;
    if (value?.version !== 1 || value.sessionId !== sessionId || value.contractKey !== contractKey) return undefined;
    // A state derived from another branch must not leak into this one.
    if (value.branchTip && branchIds.length && !branchIds.includes(value.branchTip)) return undefined;
    return value;
  } catch { return undefined; }
}

export function clearState(root: string, sessionId: string): void {
  try { fs.rmSync(stateFile(root, sessionId), { force: true }); } catch { /* best effort */ }
}

export function writeState(root: string, state: TaskState): void {
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = stateFile(root, state.sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* best effort: a lost state rebuilds safely, never blocks judging */ }
}
