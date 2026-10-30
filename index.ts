/**
 * pi-supervisor — LLM-judged keep-going supervisor for pi.
 *
 * Two phases (no per-task files to edit):
 *
 * 1. BOOTSTRAP (first settle of an armed session, or /supervisor start|replan)
 *    A judge model reads the current session plus the repository (read-only tools),
 *    infers the supervision contract: mission, furthest progress, next steps,
 *    when to call the project's decision sub-agent, what must be recorded where,
 *    stop conditions and unattended-work rules.
 *    The user reviews/edits it in a dialog (an editor with an extra "修改意见"
 *    section), or it is auto-accepted with --supervise / autoConfirm.
 *    After confirmation the run continues IMMEDIATELY with next_steps[0].
 *
 * 2. ENFORCE (every later settle)
 *    The judge checks the contract against the last report and evidence:
 *      - goal reached    -> settle
 *      - human needed    -> settle and surface
 *      - otherwise       -> inject next_step (plus policy/record violations) and continue
 *    The judge may update furthest_progress / next_steps / policies and may request
 *    compaction at a durable checkpoint (compact_focus).
 *
 * User guidance can be added at any time with /supervisor note <text> (injected into
 * every judge call as highest-priority notes).
 *
 * The contract is stored in the session (custom entry), survives resume/compaction,
 * and needs no repository edits.
 *
 * Config (optional overrides only): ~/.pi/agent/extensions/pi-supervisor/config.json
 * Arm: /supervisor start | pi --supervise | project profile enabled:true
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { classifyStopError } from "./quota.ts";
import { addUsage, emptyUsage, resolveJudgeExtension, runJudgeOnce, type JudgeAttempt, type JudgeErrorKind, type JudgeResult, type JudgeRunContext, type UsageSummary } from "./judge.ts";
import { applyVerdict, canShortCircuit, clearState, hashText, invalidate as invalidateEvidence, needsDeepCheck, readState, snapshotRepo, stateDigest, writeState, type Invalidation, type TaskState } from "./judge-state.ts";
import { indexAttempt, searchEvidence } from "./evidence-index.ts";
import { escalationHint, findAgent, type AgentLookup } from "./agent-lookup.ts";
import { escalationPrompt, loadAgentDefinition, parseAdjudication, type EscalationAdjudication } from "./escalation.ts";

const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "pi-supervisor");
const CONFIG_PATH = process.env.PI_SUPERVISOR_CONFIG || process.env.STOP_SUPERVISOR_CONFIG || path.join(EXT_DIR, "config.json");
const CONTRACT_TYPE = "pi-supervisor-contract";
const STATE_TYPE = "pi-supervisor-state";
/** Audit trail for main-agent allowance outages. Custom entries never reach LLM context. */
const QUOTA_STATE_TYPE = "pi-supervisor-quota";
/** Legacy entry types written before the pi-supervisor rename; read for backward compatibility. */
const LEGACY_CONTRACT_TYPE = "stop-supervisor-contract";
const LEGACY_STATE_TYPE = "stop-supervisor-state";
const BOOTSTRAP_MARKER = "TASK: BOOTSTRAP_CONTRACT";
const ENFORCE_MARKER = "TASK: ENFORCE_CONTRACT";

// ---------------------------------------------------------------- types

/**
 * Waiting out a metered-allowance outage on the MAIN agent (not the judge).
 * Buckets are decided from the error text alone in quota.ts, so switching the main
 * model to another provider needs no code change — at most an `extraPatterns` entry.
 */
interface QuotaWaitConfig {
  enabled?: boolean;
  /** Fixed probe interval. Default 10 min; a failed probe costs 0 tokens. */
  intervalMs?: number;
  /** Give up after this many minutes of waiting. 0 = unlimited (default). */
  maxWaitMinutes?: number;
  /** Give up after this many probes. 0 = unlimited (default). */
  maxAttempts?: number;
  /** Stop immediately (and auto-pause) on errors needing a human, e.g. no funds. */
  permanentAsHumanNeeded?: boolean;
  /** Extra regex sources that force an error into the quota bucket. */
  extraPatterns?: string[];
  /** Regex sources that force an error out of the quota bucket. */
  ignorePatterns?: string[];
}

interface Profile {
  enabled?: boolean;
  autoConfirm?: boolean;
  judgeModel?: string;
  judgeThinking?: string;
  /** Fail over to this model once when the primary judge produces no usable verdict. */
  judgeFailoverModel?: string;
  judgeFailover?: boolean;
  judgeFailoverThinking?: string;
  judgeCommand?: string;
  judgeTimeoutMs?: number;
  /** Private full-log root; retries always log before spawning the judge. */
  judgeLogDir?: string;
  /** Consecutive no-new-evidence rounds before supervision pauses instead of looping. */
  stagnationRounds?: number;
  /** Real adjudication by the configured escalation agent before honouring human gates. */
  escalationTimeoutMs?: number;
  escalationMaxCalls?: number;
  /** Structured per-task judgement state and its evidence index. */
  judgeStateDir?: string;
  judgeIndexDir?: string;
  /** Explicit provider extensions for the judge only (e.g. npm:pi-provider-qoder). */
  judgeExtensions?: string[];
  /** Bootstrap judge timeout (read-only tools; can take minutes on big repos). */
  bootstrapTimeoutMs?: number;
  maxIterations?: number;
  maxJudgeFailures?: number;
  smartCompaction?: boolean;
  /** Give the enforcement judge read-only repo tools (slower, stricter verification). */
  enforceReadTools?: boolean;
  /** Decision escalation sub-agent that must be consulted before asking a human. */
  escalationAgent?: string;
  stopFile?: string;
  logFile?: string;
  /** Wait out a main-agent allowance outage instead of settling. */
  quotaWait?: QuotaWaitConfig;
  /** Optional fixed goal; used as a strong hint during bootstrap. */
  goal?: string;
}

interface Config {
  defaults?: Profile;
  projects?: Record<string, Profile>;
}

interface Contract {
  version: 1;
  mission: string;
  completion_criteria: string[];
  boundaries: string[];
  furthest_progress: string;
  next_steps: string[];
  decision_policy: string[];
  record_policy: string[];
  stop_conditions: string[];
  autonomy_rules: string[];
  /** Free-form user guidance, always injected into judge calls. */
  user_notes: string[];
  /** True when the contract was generated as a fallback after a judge failure. */
  provisional?: boolean;
  confirmed_by_user: boolean;
  updated_at: string;
}

type Lifecycle = "inactive" | "drafting" | "active" | "paused" | "cancelled" | "completed";

function judgeContractKey(contract: Contract): string {
  const keys: Array<keyof Contract> = ["mission", "completion_criteria", "boundaries", "decision_policy", "record_policy", "stop_conditions", "autonomy_rules"];
  return createHash("sha256").update(JSON.stringify(keys.map(key => contract[key]))).digest("hex");
}

interface JudgeDiagnosis {
  at: string;
  ok: boolean;
  error?: string;
  attempts: JudgeAttempt[];
}

function judgeRecovery(kind?: JudgeErrorKind): string {
  switch (kind) {
    case "spawn": return "检查 judgeCommand 是否存在及可执行；处理后 /supervisor retry。";
    case "logging": return "检查日志目录权限、可用空间及路径；处理后 /supervisor retry。";
    case "session": return "检查固定判官会话的路径、权限或缺失历史；不会自动清空旧上下文，处理后 /supervisor retry。";
    case "extension": return "检查 judgeExtensions 配置的包名或路径是否存在且可加载；判官仍禁用其它扩展，处理后 /supervisor retry。";
    case "timeout": return "查看最后事件/工具及完整日志，检查耗时或阻塞；必要时由你调整超时后 /supervisor retry。";
    case "provider": return "查看 provider 原始错误，处理认证、额度或服务问题后 /supervisor retry；不自动替换模型。";
    case "exit": return "查看 stderr.log 和退出原因；处理子进程错误后 /supervisor retry。";
    case "invalidated": return "本次已被暂停、取消或会话切换作废；不会应用旧结果。";
    default: return "查看最终文本和事件流；/supervisor retry 仅重试判官并自动全量留档，不重跑主 Agent。";
  }
}

interface Verdict {
  goal_achieved?: boolean;
  criteria_evidence?: Array<{ criterion: string; evidence: string }>;
  evidence_conflicts?: string[];
  contract_change?: string;
  human_needed?: boolean;
  reason?: string;
  criteria_met?: string[];
  unmet_conditions?: string[];
  next_step?: string;
  contract_updates?: Partial<Contract>;
  policy_violations?: string[];
  records_missing?: string[];
  compact_now?: boolean;
  compact_focus?: string;
}

function formatUsage(usage: UsageSummary): string {
  const calls = usage.calls > 0 ? usage.calls : usage.turns;
  return `in ${usage.input} / out ${usage.output} / cacheRead ${usage.cacheRead} / cacheWrite ${usage.cacheWrite} = ${usage.totalTokens} tokens · $${usage.cost.toFixed(4)}（${calls} 次判官调用）`;
}

const QUOTA_WAIT_DEFAULTS = {
  enabled: true,
  /** 10 minutes. A failed probe costs 0 tokens and 0 context, so a fixed interval is enough. */
  intervalMs: 600_000,
  maxWaitMinutes: 0,
  maxAttempts: 0,
  permanentAsHumanNeeded: true,
  extraPatterns: [] as string[],
  ignorePatterns: [] as string[],
};

type ResolvedQuotaWait = typeof QUOTA_WAIT_DEFAULTS;

const DEFAULTS = {
  quotaWait: QUOTA_WAIT_DEFAULTS,
  judgeModel: "openai-codex/gpt-6-astra",
  judgeThinking: "low",
  judgeFailoverModel: "opencode-go/space-bunny-free",
  judgeFailover: true,
  judgeTimeoutMs: 120_000,
  bootstrapTimeoutMs: 300_000,
  maxIterations: 300,
  maxJudgeFailures: 2,
  stagnationRounds: 3,
  escalationTimeoutMs: 180_000,
  escalationMaxCalls: 3,
  smartCompaction: true,
  escalationAgent: "astra-escalation",
  judgeCommand: "pi",
  stopFile: path.join(EXT_DIR, "STOP"),
  logFile: "verdicts.jsonl",
};

// ---------------------------------------------------------------- utilities

function readConfig(): Config {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Config;
  } catch {
    return {};
  }
}

function debugLog(message: string): void {
  const file = process.env.PI_SUPERVISOR_DEBUG || process.env.STOP_SUPERVISOR_DEBUG;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // best effort
  }
}

function resolvePath(p: string | undefined, base: string): string | undefined {
  if (!p) return undefined;
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.66);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[truncated ${text.length - max} chars]…\n${text.slice(-tail)}`;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } =>
      !!block && typeof block === "object" && (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("\n");
}

function gitInfo(cwd: string): string {
  const run = (args: string[]) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (error) {
      return `[git ${args.join(" ")} failed: ${String(error)}]`;
    }
  };
  return `# git log -8\n${truncateMiddle(run(["log", "--oneline", "-8"]), 1600)}\n\n# git status --short\n${truncateMiddle(run(["status", "--short"]), 1200) || "(clean)"}`;
}

function logLine(cwd: string, logFile: string | undefined, entry: Record<string, unknown>): void {
  try {
    const file = resolvePath(logFile, EXT_DIR) || path.join(EXT_DIR, "verdicts.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), cwd, ...entry })}\n`);
  } catch {
    // logging must never break the run
  }
}

/** Read the tail of the verdict log filtered to one session. */
function readSessionHistory(
  logFile: string | undefined,
  sessionId: string,
  limit: number,
): Array<Record<string, unknown>> {
  try {
    const file = resolvePath(logFile, EXT_DIR) || path.join(EXT_DIR, "verdicts.jsonl");
    const stat = fs.statSync(file);
    const maxBytes = 512_000;
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);
    const entries: Array<Record<string, unknown>> = [];
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (sessionId && entry.sessionId !== sessionId) continue;
        entries.push(entry);
      } catch {
        // partial first line of the tail window
      }
    }
    return entries.slice(-limit);
  } catch {
    return [];
  }
}

function historyLine(entry: Record<string, unknown>): string {
  const ts = typeof entry.ts === "string" ? entry.ts.slice(11, 19) : "--:--:--";
  const event = String(entry.event ?? "?");
  const verdict = (entry.verdict ?? {}) as Verdict;
  const detail = verdict.reason || String(entry.error ?? entry.reason ?? entry.firstStep ?? entry.focus ?? "");
  const label =
    event === "done" ? "✅ 允许停止（达成）"
      : event === "human-needed" ? "⛔ 允许停止（需人类）"
        : event === "verdict" ? (verdict.goal_achieved ? "✅ 达成判定" : verdict.human_needed ? "⛔ 需人类判定" : `继续 #${String(entry.iteration ?? "?")}`)
          : event === "max-iterations" ? "⏹ 上限停止"
            : event === "bootstrap-failure" ? "bootstrap 失败"
              : event === "judge-failure" ? "判官失败"
                : event === "contract" ? "契约确认"
                  : event === "contract-provisional" ? "临时契约"
                    : event === "compact-done" ? "压缩完成"
                      : event === "compact-failed" ? "压缩失败"
                        : event === "quota-detected" ? "🪫 主模型额度耗尽"
                          : event === "quota-probe" ? `🪫 额度探测 #${String(entry.attempt ?? "?")}`
                            : event === "quota-recovered" ? "🔋 额度已恢复"
                              : event === "quota-giveup" ? "⏹ 放弃等待额度"
                                : event === "quota-permanent" ? "⛔ 需人类（非额度错误）"
                                  : event === "quota-aborted" ? "⏹ 取消额度等待"
                                    : event;
  return `${ts} ${label}${detail ? ` — ${truncateMiddle(detail.replace(/\s+/g, " "), 110)}` : ""}`;
}

/** Keep the UI visibly alive during long judge calls. Returns a stop function. */
function startHeartbeat(ctx: ExtensionContext, label: string): () => void {
  const started = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clear = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { if (ctx.hasUI) ctx.ui.setStatus("supervisor", undefined); } catch { /* noop */ }
  };
  const tick = () => {
    if (stopped) return;
    const seconds = Math.round((Date.now() - started) / 1000);
    try { if (ctx.hasUI) ctx.ui.setStatus("supervisor", `${label}（已 ${seconds}s）`); } catch { clear(); }
  };
  tick();
  timer = setInterval(tick, 5000);
  return clear;
}

/** `2h05m` / `12m30s` / `45s` — used by quota-wait status and notifications. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Why a quota wait ended. */
type SleepOutcome = "done" | "signal" | "stop-file";

/**
 * Sleep until `deadline`, waking immediately on abort and re-running `stopCheck`
 * once per 5s slice.
 *
 * Blocking inside the settle handler is deliberate: it keeps `pi --print` alive for
 * the whole wait (a detached timer would die with the process), and pi re-checks its
 * abort flag right after we return, so Esc still cancels cleanly.
 */
async function sleepUntil(
  deadline: number,
  signal: AbortSignal | undefined,
  stopCheck?: () => boolean,
): Promise<SleepOutcome> {
  while (Date.now() < deadline) {
    if (signal?.aborted) return "signal";
    if (stopCheck?.()) return "stop-file";
    const slice = Math.min(5000, deadline - Date.now());
    if (slice <= 0) break;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, slice);
      if (signal) {
        if (signal.aborted) { finish(); return; }
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }
  if (signal?.aborted) return "signal";
  if (stopCheck?.()) return "stop-file";
  return "done";
}

/** Status-bar countdown so a multi-hour wait never looks like a hang. */
function startQuotaCountdown(
  ctx: ExtensionContext,
  deadline: number,
  attempt: number,
  waitedSoFar: () => number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clear = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    try { if (ctx.hasUI) ctx.ui.setStatus("supervisor", undefined); } catch { /* noop */ }
  };
  const tick = () => {
    if (stopped) return;
    const remainMs = deadline - Date.now();
    if (remainMs <= 0) { clear(); return; }
    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "supervisor",
          `⏳ 等待额度恢复 · 第 ${attempt} 次探测 · 已等 ${formatDuration(waitedSoFar())} · 下次 ${formatDuration(remainMs)} 后（Esc 取消）`,
        );
      }
    } catch { clear(); }
  };
  tick();
  timer = setInterval(tick, 5000);
  return clear;
}

/** Merge config over the built-in quota-wait defaults; clamps nonsense intervals. */
function resolveQuotaWait(profile: Profile): ResolvedQuotaWait {
  const merged: QuotaWaitConfig = { ...QUOTA_WAIT_DEFAULTS, ...(profile.quotaWait || {}) };
  const interval = Number(merged.intervalMs);
  return {
    enabled: merged.enabled !== false,
    // Clamp rather than substitute: an explicit but silly interval (0, 300ms) becomes the
    // 5s floor instead of silently jumping to the 10-minute default. The floor exists so a
    // misconfigured interval can never turn into a hot loop against the provider.
    intervalMs: Number.isFinite(interval) && interval > 0
      ? Math.min(Math.max(Math.round(interval), 5_000), 86_400_000)
      : QUOTA_WAIT_DEFAULTS.intervalMs,
    maxWaitMinutes: Math.max(0, Math.round(Number(merged.maxWaitMinutes) || 0)),
    maxAttempts: Math.max(0, Math.round(Number(merged.maxAttempts) || 0)),
    permanentAsHumanNeeded: merged.permanentAsHumanNeeded !== false,
    extraPatterns: asStringArray(merged.extraPatterns, 50),
    ignorePatterns: asStringArray(merged.ignorePatterns, 50),
  };
}

function asStringArray(value: unknown, max = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

function normalizeContract(raw: Record<string, unknown>): Contract {
  const suppliedCriteria = raw.completion_criteria ?? raw.completionCriteria ?? raw.criteria ?? raw.completion_conditions;
  // Legacy contracts had no separate criteria. Preserve their confirmed mission as
  // the conservative endpoint; new drafts are validated before normalization.
  const completionCriteria = suppliedCriteria === undefined && typeof raw.mission === "string"
    ? asStringArray([raw.mission]) : asStringArray(suppliedCriteria);
  const boundaries = asStringArray(raw.boundaries ?? raw.necessary_boundaries ?? raw.restrictions ?? raw.necessary_restrictions);
  return {
    version: 1,
    mission: typeof raw.mission === "string" && raw.mission.trim() ? raw.mission.trim() : "(未推断出目标)",
    completion_criteria: completionCriteria,
    boundaries,
    furthest_progress: typeof raw.furthest_progress === "string" ? raw.furthest_progress.trim() : "(未知)",
    next_steps: asStringArray(raw.next_steps),
    decision_policy: asStringArray(raw.decision_policy),
    record_policy: asStringArray(raw.record_policy),
    stop_conditions: asStringArray(raw.stop_conditions),
    autonomy_rules: asStringArray(raw.autonomy_rules),
    user_notes: asStringArray(raw.user_notes),
    provisional: raw.provisional === true,
    confirmed_by_user: raw.confirmed_by_user === true,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
  };
}

function mergeContract(contract: Contract, updates: Partial<Contract> | undefined): Contract {
  if (!updates || typeof updates !== "object") return contract;
  return {
    ...contract,
    // Runtime updates may change progress only; user guidance is human-owned.
    furthest_progress: typeof updates.furthest_progress === "string" && updates.furthest_progress.trim()
      ? updates.furthest_progress.trim() : contract.furthest_progress,
    next_steps: updates.next_steps ? asStringArray(updates.next_steps) : contract.next_steps,
    user_notes: contract.user_notes,
    updated_at: new Date().toISOString(),
  };
}

function contractSummary(contract: Contract, details = false): string {
  const list = (items: string[]) => items.length ? items.map((item, i) => `  ${i + 1}. ${item}`).join("\n") : "  (无)";
  return [
    `目标: ${contract.mission}`,
    `完成条件:\n${list(contract.completion_criteria)}`,
    `必要限制:\n${list(contract.boundaries)}`,
    details ? `最远进度: ${contract.furthest_progress}` : "",
    details ? `后续步骤:\n${list(contract.next_steps)}` : "",
    details && contract.user_notes.length ? `用户补充说明:\n${list(contract.user_notes)}` : "",
    details ? `决策规则:\n${list(contract.decision_policy)}` : "",
    details ? `记录要求:\n${list(contract.record_policy)}` : "",
    details ? `停止条件:\n${list(contract.stop_conditions)}` : "",
    details ? `无人值守规则:\n${list(contract.autonomy_rules)}` : "",
  ].filter(Boolean).join("\n\n");
}

/** Both automatic and manual judgement use the same conservative evidence gate. */
function evaluateVerdict(current: Contract, raw: Verdict): { verdict: Verdict; replan: boolean } {
  const protectedKeys: Array<keyof Contract> = ["mission", "completion_criteria", "boundaries", "decision_policy", "record_policy", "stop_conditions", "autonomy_rules"];
  const changed = raw.contract_updates && protectedKeys.some(key =>
    Object.prototype.hasOwnProperty.call(raw.contract_updates, key) &&
    JSON.stringify(raw.contract_updates![key]) !== JSON.stringify(current[key]));
  if (changed || (typeof raw.contract_change === "string" && raw.contract_change.trim())) {
    return { replan: true, verdict: { ...raw, goal_achieved: false, human_needed: true,
      reason: "目标、完成条件或必要限制发生变化，需要重新确认。", next_step: "用 /supervisor replan 确认新终点。" } };
  }
  const items = Array.isArray(raw.criteria_evidence) ? raw.criteria_evidence : [];
  const missing = current.completion_criteria.filter(criterion => !items.some(item =>
    item && typeof item === "object" && item.criterion === criterion && typeof item.evidence === "string" && item.evidence.trim()));
  const conflicts = asStringArray(raw.evidence_conflicts);
  const unmet = asStringArray(raw.unmet_conditions);
  const invalidFields: string[] = (["unmet_conditions", "evidence_conflicts", "policy_violations", "records_missing"] as const).filter(key => {
    const value = raw[key];
    return value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string"));
  });
  if (raw.human_needed !== undefined && typeof raw.human_needed !== "boolean") invalidFields.push("human_needed");
  const gaps = [...unmet, ...missing, ...conflicts, ...invalidFields.map(key => `判定字段 ${key} 格式无效，需重新核验`)];
  const blocked = !current.completion_criteria.length || missing.length > 0 || conflicts.length > 0 || unmet.length > 0 || invalidFields.length > 0 ||
    asStringArray(raw.policy_violations).length > 0 || asStringArray(raw.records_missing).length > 0 || raw.human_needed === true;
  const goal = raw.goal_achieved === true && !blocked;
  return { replan: false, verdict: {
    ...raw, goal_achieved: goal,
    unmet_conditions: [...new Set(gaps)],
    ...(raw.goal_achieved === true && !goal ? {
      reason: "完成证据尚未闭环，不能仅凭完成汇报停止。",
      next_step: raw.next_step || `核验并提供证据：${gaps.join("；") || "补齐必要记录并解决规则冲突"}`,
    } : {}),
  } };
}

// ---------------------------------------------------------------- judge call

/**
 * Run the judge, and fail over to a backup model once if the primary attempt produced
 * no usable verdict (provider error, empty output, non-JSON, timeout, non-zero exit).
 */
async function runJudge(prompt: string, profile: Profile, cwd: string, withTools: boolean, timeoutOverrideMs?: number, signal?: AbortSignal, context: JudgeRunContext = {}): Promise<JudgeResult> {
  const command = profile.judgeCommand || DEFAULTS.judgeCommand;
  const primary = profile.judgeModel || DEFAULTS.judgeModel;
  const thinking = profile.judgeThinking || DEFAULTS.judgeThinking;
  const timeoutMs = timeoutOverrideMs ?? profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs;
  const callId = randomUUID();
  let extensionPaths: string[];
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    extensionPaths = asStringArray(profile.judgeExtensions, 8).map(spec => resolveJudgeExtension(spec, cwd, agentDir));
  } catch (error) {
    return { ok: false, error: `判官扩展加载前的解析失败：${String(error)}`, errorKind: "extension",
      failovers: [], attempts: [{ callId, attemptId: randomUUID(), model: primary, fullLogging: true, logComplete: false,
        kind: context.kind, ok: false, errorKind: "extension", error: String(error), ms: 0, stdoutBytes: 0, stderrBytes: 0 }], ms: 0 };
  }
  const base = { prompt, cwd, withTools, command, timeoutMs, signal, ...context, callId, extensionPaths,
    logRoot: resolvePath(profile.judgeLogDir || path.join(EXT_DIR, "judge-logs"), cwd) };
  const first = await runJudgeOnce({ ...base, model: primary, thinking });
  const fallback = profile.judgeFailover !== false ? profile.judgeFailoverModel : undefined;
  if (first.ok || signal?.aborted || first.errorKind === "logging" || first.errorKind === "session" || first.errorKind === "spawn" || !fallback || fallback === primary) return first;

  const second = await runJudgeOnce({ ...base, model: fallback,
    thinking: profile.judgeFailoverThinking || thinking, fullLogging: true });
  const usage = emptyUsage();
  if (first.usage) addUsage(usage, first.usage);
  if (second.usage) addUsage(usage, second.usage);
  const combined: JudgeResult = { ...second, ms: first.ms + second.ms,
    usage: usage.turns ? usage : undefined, attempts: [...first.attempts || [], ...second.attempts || []],
    failovers: [`${primary} → ${fallback}：主判官失败（${first.error || "未知原因"}）`] };
  if (!second.ok) combined.error = `主判官(${primary}) 失败：${first.error || "未知"} ｜ 备用判官(${fallback}) 失败：${second.error || "未知"}`;
  return combined;
}

// ---------------------------------------------------------------- prompt builders

function sessionExcerpt(ctx: ExtensionContext): string {
  try {
    const projection = ctx.sessionManager.buildSessionProjection();
    const messages = projection.messages || [];
    const userTexts: string[] = [];
    const assistantTexts: string[] = [];
    for (const message of messages) {
      const role = (message as { role?: string }).role;
      const text = messageText(message).trim();
      if (!text) continue;
      if (role === "user") userTexts.push(truncateMiddle(text, 2500));
      if (role === "assistant") assistantTexts.push(truncateMiddle(text, 2500));
    }
    const firstUser = userTexts.slice(0, 2);
    const recentUser = userTexts.slice(-3).filter((text) => !firstUser.includes(text));
    const lastAssistant = assistantTexts.slice(-6);
    let sessionName = "";
    try { sessionName = ctx.sessionManager.getSessionName() || ""; } catch { /* noop */ }
    return [
      "## 当前 session",
      `- session 名称: ${sessionName || "(未命名)"}`,
      `- cwd: ${ctx.cwd}`,
      `- 会话消息数: ${messages.length}`,
      "",
      `## 用户最初请求（前 ${firstUser.length} 条，判定任务范围的首要根据）`,
      firstUser.length ? firstUser.map((t, i) => `### 请求 ${i + 1}\n${t}`).join("\n\n") : "(无)",
      recentUser.length
        ? `## 最近的用户指令（${recentUser.length} 条）\n${recentUser.map((t, i) => `### 最近 ${i + 1}\n${t}`).join("\n\n")}`
        : "",
      `## 主 Agent 最近的完成汇报（${lastAssistant.length} 条）`,
      lastAssistant.length ? lastAssistant.map((t, i) => `### 汇报 ${i + 1}\n${t}`).join("\n\n") : "(无)",
    ].filter(Boolean).join("\n\n");
  } catch (error) {
    return `[session excerpt failed: ${String(error)}]`;
  }
}

function userNotesBlock(contract: Contract): string {
  return contract.user_notes.length
    ? `## 用户补充说明（最高优先级，必须遵守）\n${contract.user_notes.map((n) => `- ${n}`).join("\n")}\n`
    : "";
}

function buildBootstrapPrompt(profile: Profile, ctx: ExtensionContext, feedback: string, escalation?: string): string {
  return `${BOOTSTRAP_MARKER}

根据当前 session 中用户的请求，推断一个简洁、可核验的监督终点。
监督目标是判断“是否到达用户认可的终点”，不是为每个任务生成一套复杂流程。

只从会话确定任务范围；不要混入同一仓库内其他 session 的任务。
仓库只用于核对会话明确提及的关键事实；只读工具最多建议 8 次，不扫描目录或默认读取计划。
信息不足时提出具体 open_questions，不要编造目标、文件、规则或授权。
${profile.goal?.trim() ? `用户固定目标：${profile.goal.trim()}` : ""}
${feedback ? `用户对上次候选的修改要求（必须满足）：\n${feedback}` : ""}
${escalation ? `已配置的可用升级诊断 agent：${escalation}；仅在会话或必要决策规则要求时采用，不强制每个任务调用。` : ""}

${sessionExcerpt(ctx)}

${gitInfo(ctx.cwd)}

严格输出 JSON：
{
  "mission": "最终要交付什么；不是阶段动作",
  "completion_criteria": ["少量、可独立核验的完成条件；每项明确证据来源"],
  "boundaries": ["用户明确的范围、必要限制和授权边界；没有则 []"],
  "furthest_progress": "会话已提供的进度与证据，不编造",
  "next_steps": ["从当前进度到终点最小的下一步"],
  "decision_policy": ["仅保留会话明确要求或任务必要的决策规则；没有则 []"],
  "record_policy": ["仅保留必要记录要求；没有则 []"],
  "stop_conditions": ["仅保留额外停止或需人类处理的条件；没有则 []"],
  "autonomy_rules": ["仅保留明确的自主执行限制；没有则 []"],
  "confidence": "high|medium|low",
  "open_questions": ["会影响终点或边界、必须澄清的问题；没有则 []"]
}
不要为了填满字段增添决策、登记、升级或无人值守流程。`;
}

// ---------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  debugLog(`loaded cwd=${process.cwd()} config=${CONFIG_PATH}`);
  let lastAssistantText = "";
  let iterations = 0;
  let judgeFailures = 0;
  /** errorMessage of the most recent assistant turn that ended with stopReason "error". */
  let lastErrorMessage: string | undefined;
  /** True while blocked in a quota wait, so a nested settle cannot re-enter. */
  let quotaWaiting = false;
  const quotaState = { attempts: 0, waitedMs: 0, startedAt: 0, lastError: "", lastRule: "" };
  let lifecycle: Lifecycle = "inactive";
  // Flags/profile enablement apply only to a new session with no explicit state.
  let hasExplicitState = false;
  let operationGeneration = 0;
  let operationController = new AbortController();
  let draftPrevious: Lifecycle | undefined;
  let latestContext: ExtensionContext | undefined;
  function invalidate(): void {
    operationGeneration += 1;
    operationController.abort();
    operationController = new AbortController();
    judging = false;
    quotaWaiting = false;
  }
  const isCurrent = (generation: number) => generation === operationGeneration;
  const stateLabel = () => ({ inactive: "未开始", drafting: "待确认", active: "监督中", paused: "已暂停", cancelled: "已取消", completed: "已完成" })[lifecycle];
  function refreshStatus(): void {
    try { if (latestContext?.hasUI) latestContext.ui.setStatus("supervisor", `Supervisor · ${stateLabel()}`); } catch { /* UI unavailable */ }
  }
  function heartbeat(ctx: ExtensionContext, label: string, generation: number): () => void {
    const signal = operationController.signal;
    const stop = startHeartbeat(ctx, `${stateLabel()} · ${label}`);
    const clear = () => { stop(); if (isCurrent(generation)) refreshStatus(); };
    signal.addEventListener("abort", clear, { once: true });
    return () => { signal.removeEventListener("abort", clear); clear(); };
  }
  function pauseTask(reason: string): void {
    invalidate();
    draftPrevious = undefined;
    lifecycle = "paused";
    persistState(reason);
  }
  let contract: Contract | undefined;
  let lastVerdict: Verdict | undefined;
  let lastJudge: JudgeDiagnosis | undefined;
  let escalationUnavailable = false;
  /** Async child runs owned by this session; supervision must not judge mid-work. */
  const runningSubagents = new Map<string, number>();
  const SUBAGENT_STALE_MS = 2 * 60 * 60 * 1000;
  function pruneSubagents(): void {
    const now = Date.now();
    for (const [id, startedAt] of runningSubagents) if (now - startedAt > SUBAGENT_STALE_MS) runningSubagents.delete(id);
  }
  function ownedByThisSession(payload: any): boolean {
    const owner = payload?.sessionId ?? payload?.parentSessionId;
    return !owner || owner === sessionMeta.id;
  }
  let judging = false;
  let sessionMeta = { id: "", name: "", file: "" };
  let logCtx: { cwd: string; logFile?: string } = { cwd: process.cwd() };
  const usageTotals = emptyUsage();

  /** Accumulate and log token usage for one judge/compaction call. */
  function recordJudgeUsage(kind: string, result: JudgeResult): void {
    if (result.usage) addUsage(usageTotals, result.usage);
    usageTotals.calls += result.attempts?.length || 1;
    lastJudge = { at: new Date().toISOString(), ok: result.ok, error: result.error, attempts: result.attempts || [] };
    for (const attempt of result.attempts || []) log({ event: "judge-attempt", ...attempt });
    if (result.failovers?.length) {
      log({ event: "judge-failover", kind, model: result.model ?? null, failovers: result.failovers });
    }
    log({
      event: "judge-usage",
      kind,
      ms: result.ms,
      ok: result.ok,
      model: result.model ?? null,
      usage: result.usage ?? null,
      detail: result.detail ?? null,
      error: result.ok ? null : (result.error ?? null),
      errorKind: result.errorKind ?? null,
      attempts: result.attempts ?? [],
      stdoutTail: result.ok ? null : (result.raw ?? null),
      stderrTail: result.ok ? null : (result.stderr ?? null),
    });
  }

  function persistState(reason: string): void {
    hasExplicitState = true;
    try {
      pi.appendEntry(STATE_TYPE, {
        lifecycle, armed: lifecycle === "active", paused: lifecycle === "paused",
        iterations, judgeFailures, lastVerdict, lastJudge, reason, at: new Date().toISOString(),
      });
    } catch { /* best effort */ }
    refreshStatus();
  }

  function captureSessionMeta(ctx: ExtensionContext): void {
    latestContext = ctx;
    try {
      const file = ctx.sessionManager.getSessionFile();
      sessionMeta = {
        id: ctx.sessionManager.getSessionId() || "",
        name: ctx.sessionManager.getSessionName() || "",
        file: file ? path.basename(file) : "",
      };
    } catch {
      // best effort; session association is nice-to-have
    }
  }

  /** Log with the current session identity so verdicts can be filtered per session. */
  function log(entry: Record<string, unknown>): void {
    logLine(logCtx.cwd, logCtx.logFile, {
      sessionId: sessionMeta.id,
      sessionName: sessionMeta.name,
      sessionFile: sessionMeta.file,
      ...entry,
    });
  }

  function judgeContext(kind: string): JudgeRunContext {
    // Independent session per round; history is carried by state + evidence index.
    return { parentSessionId: sessionMeta.id, parentSessionFile: sessionMeta.file,
      parentSessionName: sessionMeta.name, kind, fullLogging: true };
  }


  interface TierOutcome {
    tier: "L0" | "L1" | "L2";
    l0Reason?: string;
    result?: JudgeResult;
    state?: TaskState;
    invalidation: Invalidation;
    changed?: boolean;
    reused: number;
    reverified: number;
    retrievals: number;
    escalation?: string;
  }

  /** Resolve the configured escalation agent across user + project agent dirs. */
  function escalationFor(profile: Profile, cwd: string): AgentLookup & { configured?: string } {
    const configured = (profile.escalationAgent || "").trim() || undefined;
    const lookup = findAgent(configured, cwd);
    if (configured && !lookup.name) escalationUnavailable = true;
    else if (lookup.name) escalationUnavailable = false;
    return { ...lookup, configured };
  }

  function stateRoots(profile: Profile, cwd: string): { state: string; index: string } {
    return {
      state: resolvePath(profile.judgeStateDir || path.join(EXT_DIR, "state"), cwd)!,
      index: resolvePath(profile.judgeIndexDir || path.join(EXT_DIR, "evidence-index"), cwd)!,
    };
  }

  function incrementalPrompt(input: {
    contract: Contract; state?: TaskState; tier: "L1" | "L2"; stale: string[];
    snippets: string; report: string; round: number; escalation?: string;
    stagnantRounds?: number; recentNextSteps?: string[];
  }): string {
    const valid = (input.state?.criteria || []).filter(item => item.status === "met" && item.evidence.length);
    const evidenceLines = valid.slice(0, 12).map(item => {
      const refs = item.evidence.map(ref => ref.kind === "file"
        ? `${ref.path}（指纹 ${ref.fingerprint?.slice(0, 24)}，第 ${ref.round} 轮核验）`
        : `${ref.kind}（第 ${ref.round} 轮核验）`).join("；");
      return `- [${item.id}] ${item.criterion.slice(0, 100)}：${refs}`;
    });
    return `TASK: ENFORCE_CONTRACT

你是终点核验者。抓住终点：只在完成条件都有当前有效证据时允许暂停。

## 已确认契约
${contractSummary(input.contract, true)}

## 结构化状态（扩展维护，非模型总结）
${input.state ? stateDigest(input.state) : "(首次核验，无历史状态)"}

## 仍然有效、可直接复用的证据
${evidenceLines.length ? evidenceLines.join("\n") : "(无)"}

## 失效/待重新核验
${input.stale.length ? input.stale.map(id => `- ${id}`).join("\n") : "(无)"}
${input.snippets ? `\n## 历史证据片段（按需检索，原始记录在 judge-logs）\n${input.snippets}\n` : ""}
## 主 Agent 最近汇报
${truncateMiddle(input.report || "(无)", 6000)}

${(input.stagnantRounds ?? 0) >= 1 ? `## 停滞告警（已连续 ${input.stagnantRounds} 轮无新增证据）
上一轮建议：${(input.recentNextSteps || []).slice(-2).map(step => `\n- ${step}`).join("") || "(无)"}
本轮必须二选一，不得重复上面的建议：
- 给出与之前不同、且本轮可执行的具体动作（目标文件/命令/委派对象）；
- 若剩余阻断只能由人类批准/授权解决，置 human_needed=true 并在 unmet_conditions 列出待批项。
` : ""}${input.escalation ? `升级诊断 agent：${input.escalation}。若因证据冲突/判断困难而要 human_needed，先建议主 Agent 用它做一次升级诊断；仅当确实需要人类权限/批准时才可直接 human_needed。\n` : ""}核验序号：${input.round}
本轮路径：${input.tier}${input.tier === "L2" ? "（可用只读工具，只核验失效/缺失/可疑项，不要重读仍有效的证据）" : "（无工具：依据上面状态与本轮汇报判断）"}

规则：
1. 逐项核验 completion_criteria；goal_achieved=true 必须每项有当前有效证据，且无未完成条件、证据冲突、规则违反或缺失记录。
2. criteria_evidence 每项给出 criterion 原文与 evidence；引用已复用证据时注明其路径/轮次即可，不必重读。
3. 历史通过不等于当前通过：失效证据、未标注来源的结论都按未核验处理。
4. 只有用户目标改变、关键前提失效或新证据确实动摇终点时填 contract_change。
5. human_needed 仅在确实需要人处理且无独立可推进工作时为 true；goal_achieved 与 human_needed 不同时为 true。
6. 一般继续只报告最重要的未闭环条件与下一步。

严格输出 JSON：
{
  "goal_achieved": false, "human_needed": false, "reason": "一句话依据",
  "criteria_evidence": [{"criterion": "原完成条件完整文本", "evidence": "具体证据（路径/轮次/结果）"}],
  "unmet_conditions": [], "evidence_conflicts": [], "contract_change": "",
  "next_step": "最小可执行动作",
  "contract_updates": {"furthest_progress": "", "next_steps": []},
  "policy_violations": [], "records_missing": [], "compact_now": false, "compact_focus": ""
}`;
  }

  function wouldComplete(verdict: Verdict | undefined, contract: Contract): boolean {
    if (!verdict || verdict.goal_achieved !== true || verdict.human_needed === true) return false;
    const supplied = Array.isArray(verdict.criteria_evidence) ? verdict.criteria_evidence : [];
    if (asStringArray(verdict.unmet_conditions).length || asStringArray(verdict.evidence_conflicts).length ||
      asStringArray(verdict.policy_violations).length || asStringArray(verdict.records_missing).length) return false;
    return contract.completion_criteria.every(criterion => supplied.some(item =>
      item && item.criterion === criterion && typeof item.evidence === "string" && item.evidence.trim()));
  }

  /**
   * Ask the configured escalation agent to separate real human gates from work
   * the main agent can still do. Runs at most escalationMaxCalls times per task.
   */
  async function adjudicate(input: {
    ctx: ExtensionContext; profile: Profile; contract: Contract; report: string;
    verdict?: Verdict; round: number; signal?: AbortSignal; state?: TaskState;
  }): Promise<{ ok: boolean; admin?: EscalationAdjudication; error?: string; logDir?: string; skipped?: boolean }> {
    const spent = input.state?.escalations ?? 0;
    const limit = input.profile.escalationMaxCalls ?? DEFAULTS.escalationMaxCalls;
    if (limit > 0 && spent >= limit) return { ok: false, skipped: true, error: `已达 escalation 上限 ${limit}` };
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const { definition, lookup } = loadAgentDefinition(input.profile.escalationAgent, input.ctx.cwd, agentDir);
    if (!definition) {
      log({ event: "escalation-skipped", reason: "agent not found", configured: input.profile.escalationAgent || null,
        searched: lookup.searched.length });
      return { ok: false, skipped: true, error: "escalation agent 未找到，按未设置处理" };
    }
    const prompt = `${escalationPrompt({
      agent: definition.name,
      mission: input.contract.mission,
      criteria: input.contract.completion_criteria,
      unmet: asStringArray(input.verdict?.unmet_conditions),
      conflicts: asStringArray(input.verdict?.evidence_conflicts),
      report: input.report,
      judgeReason: input.verdict?.reason,
      judgeNextStep: input.verdict?.next_step,
      round: input.round,
    })}

## 角色定义（来自 ${definition.name} 的 agent 文件）
${definition.body.slice(0, 4000)}`;
    const withTools = Array.isArray(definition.tools) && definition.tools.length > 0 &&
      definition.tools.every(tool => ["read", "grep", "find", "ls"].includes(tool));
    const derived: Profile = { ...input.profile,
      judgeModel: definition.model || input.profile.judgeModel,
      judgeThinking: definition.thinking || input.profile.judgeThinking,
      judgeFailover: false };
    const result = await runJudge(prompt, derived, input.ctx.cwd, withTools,
      input.profile.escalationTimeoutMs ?? DEFAULTS.escalationTimeoutMs, input.signal, judgeContext("escalation"));
    recordJudgeUsage("escalation", result);
    const admin = result.ok ? parseAdjudication(result.text) : undefined;
    const last = result.attempts?.at(-1);
    log({ event: "escalation", ok: Boolean(admin), model: result.model ?? null, ms: result.ms,
      humanRequired: admin?.humanRequired.length ?? 0, executable: admin?.executable.length ?? 0,
      error: result.error ?? (admin ? null : "adjudication 解析失败"), logDir: last?.logDir ?? null });
    return { ok: Boolean(admin), admin, error: result.error, logDir: last?.logDir };
  }

  async function runTieredJudge(input: {
    ctx: ExtensionContext; profile: Profile; contract: Contract; report: string;
    round: number; signal?: AbortSignal; kind: string; allowL0?: boolean; forceDeep?: boolean;
  }): Promise<TierOutcome> {
    const { ctx, profile, contract, report, round, signal, kind } = input;
    const escalationAgentName = escalationFor(profile, ctx.cwd).name;
    const roots = stateRoots(profile, ctx.cwd);
    let branchIds: string[] = [];
    let tip: string | undefined;
    try {
      const entries = ctx.sessionManager.getBranch() as Array<{ id?: string }>;
      branchIds = entries.map(entry => entry.id).filter((id): id is string => typeof id === "string");
      tip = branchIds.at(-1);
    } catch { /* branch info is best effort; state keying still isolates by session */ }
    const contractKey = judgeContractKey(contract);
    const state = readState(roots.state, sessionMeta.id, contractKey, branchIds);
    const repo = snapshotRepo(ctx.cwd);
    const invalidation = state ? invalidateEvidence(state, repo, ctx.cwd) : { stale: [], reason: "" };
    const reused = (state?.criteria || []).filter(item => item.status === "met").reduce((total, item) => total + item.evidence.length, 0);

    if (input.allowL0 !== false) {
      const l0Reason = canShortCircuit(state, hashText(report), invalidation);
      if (l0Reason) return { tier: "L0", l0Reason, state, invalidation, reused, reverified: 0, retrievals: 0 };
    }

    const staleIds = invalidation.stale.map(item => item.id);
    let retrievals = 0;
    let snippets = "";
    const preDeep = input.forceDeep === true ? "显式重试，执行深度核验" : needsDeepCheck(state, invalidation);

    const runTier = async (tier: "L1" | "L2", escalation?: string): Promise<JudgeResult> => {
      if (tier === "L2") {
        const queries: Array<{ path?: string; keyword?: string }> = [];
        for (const criterion of state?.criteria || []) {
          if (!["stale", "pending", "conflict"].includes(criterion.status)) continue;
          const file = criterion.evidence.find(ref => ref.kind === "file" && ref.path)?.path;
          queries.push(file ? { path: file } : { keyword: criterion.criterion.slice(0, 24) });
        }
        const hits = queries.slice(0, 4).flatMap(query => searchEvidence(roots.index, sessionMeta.id, { ...query, limit: 2 }));
        retrievals = hits.length;
        snippets = hits.map(hit => `- ${hit.tool || "tool"} ${hit.path || ""}（第 ${hit.round} 轮）：${hit.excerpt.slice(0, 420)}`).join("\n");
      }
      const result = await runJudge(incrementalPrompt({ contract, state, tier, stale: staleIds, snippets, report, round,
        escalation: escalationAgentName, stagnantRounds: state?.stagnantRounds, recentNextSteps: state?.recentNextSteps }),
        profile, ctx.cwd, tier === "L2" && profile.enforceReadTools === true, undefined, signal,
        { ...judgeContext(kind), fullLogging: true });
      for (const attempt of result.attempts || []) {
        attempt.tier = tier;
        attempt.reusedEvidence = reused;
        attempt.reverifiedEvidence = invalidation.stale.length;
        attempt.retrievals = retrievals;
        attempt.escalation = escalation;
      }
      return result;
    };

    const beforeTip = tip;
    const unchanged = () => {
      try {
        return (ctx.sessionManager.getBranch() as Array<{ id?: string }>).at(-1)?.id === beforeTip;
      } catch { return true; }
    };

    let result: JudgeResult;
    let tier: "L1" | "L2" = preDeep ? "L2" : "L1";
    if (preDeep) {
      result = await runTier("L2", preDeep);
    } else {
      result = await runTier("L1");
      const claimed = result.ok && wouldComplete(result.json as Verdict, contract);
      if (claimed) {
        // Never accept a completion claim from the cheap path.
        const deep = await runTier("L2", "L1 声称完成，升级深度核验");
        const usage = emptyUsage();
        if (result.usage) addUsage(usage, result.usage);
        if (deep.usage) addUsage(usage, deep.usage);
        result = { ...deep, ms: result.ms + deep.ms, usage: usage.turns ? usage : undefined,
          attempts: [...result.attempts || [], ...deep.attempts || []] };
        tier = "L2";
      }
    }

    if (!unchanged()) return { tier, result, state, invalidation, changed: true, reused, reverified: invalidation.stale.length, retrievals };
    if (!result.ok || !result.json) return { tier, result, state, invalidation, reused, reverified: invalidation.stale.length, retrievals };

    const next = applyVerdict(state, { sessionId: sessionMeta.id, branchTip: beforeTip, contractKey, round,
      criteria: contract.completion_criteria, verdict: result.json as Verdict, report, cwd: ctx.cwd, repo });
    writeState(roots.state, next);
    for (const attempt of result.attempts || []) if (attempt.logDir) indexAttempt(roots.index, sessionMeta.id, round, attempt.logDir);
    log({ event: "judge-path", tier, reused, reverified: invalidation.stale.length, retrievals,
      escalation: input.forceDeep ? "force" : preDeep || undefined });
    return { tier, result, state: next, invalidation, reused, reverified: invalidation.stale.length, retrievals };
  }

  function judgeDiagnosisText(profile?: Profile, cwd?: string): string {
    if (!lastJudge) {
      const old = readSessionHistory(logCtx.logFile, sessionMeta.id, 200).filter(entry => entry.event === "judge-usage").at(-1);
      if (!old) return "Supervisor：本 session 尚无判官诊断记录；/supervisor retry 可对有效任务全量留档核验。";
      return [`Supervisor 旧版判官摘要 · ${String(old.ts || "")} · ${String(old.model || "未知模型")}`,
        truncateMiddle(String(old.error || (old.ok ? "调用成功" : "判官失败")), 1600),
        "旧版只留摘要/尾部，不能还原主备完整输入输出，也不能据此断言 provider 故障。",
        "/supervisor retry 只重试判官并自动全量留档；原始历史不能事后补录。"].join("\n");
    }
    const rows = lastJudge.attempts.map((attempt, index) => [
      `${index + 1}. ${attempt.model} · ${attempt.ok ? "成功" : attempt.errorKind || "失败"} · ${attempt.ms}ms`,
      `   调用 ${attempt.callId} / 尝试 ${attempt.attemptId}`,
      attempt.tier ? `   路径 ${attempt.tier}${attempt.escalation ? `（${attempt.escalation}）` : ""} · 复用 ${attempt.reusedEvidence ?? 0} 条 · 重验 ${attempt.reverifiedEvidence ?? 0} 条 · 检索 ${attempt.retrievals ?? 0} 次` : "",
      `   输出 ${attempt.stdoutBytes}B / stderr ${attempt.stderrBytes}B；最后事件 ${attempt.lastEvent || "无"}${attempt.lastTool ? ` / 工具 ${attempt.lastTool}` : ""}`,
      attempt.error ? `   ${truncateMiddle(attempt.error, 500)}` : "",
      attempt.logDir ? `   ${attempt.logComplete ? "全量日志" : "日志留档未完成"}：${attempt.logDir}`
        : attempt.fullLogging ? "   全量日志未能建立，错误见上方。" : "   首轮轻量摘要（无全量原始流，不能事后补录）。",
      !attempt.ok ? `   ${judgeRecovery(attempt.errorKind)}` : "",
    ].filter(Boolean).join("\n"));
    return [`Supervisor 判官诊断 · ${lastJudge.ok ? "最近调用成功" : "最近调用失败，非目标达成"} · ${lastJudge.at}`,
      ...rows, profile && cwd ? escalationHint(escalationFor(profile, cwd), profile.escalationAgent) : "",
      "恢复入口：/supervisor retry（只核验，不续跑主 Agent）；确认后 /supervisor resume。"].join("\n");
  }

  function judgeFailureHint(): string {
    const last = lastJudge?.attempts.at(-1);
    return [`故障：${last?.errorKind || "判定失败"}。${judgeRecovery(last?.errorKind)}`,
      last?.logDir ? `全量日志：${last.logDir}` : "重试将自动开启全量日志。",
      "诊断：/supervisor diagnose；仅重试判官：/supervisor retry。"].join("\n");
  }

  function resolveProfile(cwd: string): Profile {
    const config = readConfig();
    const projects = config.projects || {};
    if (projects[cwd]) return { ...config.defaults, ...projects[cwd] };
    const prefix = Object.keys(projects)
      .filter((key) => cwd.startsWith(key.endsWith("/") ? key : `${key}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return { ...config.defaults, ...projects[prefix] };
    return { ...config.defaults };
  }

  pi.on("session_start", (_event, ctx) => {
    invalidate();
    lifecycle = "inactive";
    hasExplicitState = false;
    draftPrevious = undefined;
    contract = undefined;
    lastVerdict = undefined;
    lastJudge = undefined;
    lastAssistantText = "";
    lastErrorMessage = undefined;
    iterations = 0;
    judgeFailures = 0;
    resetQuotaState();
    Object.assign(usageTotals, emptyUsage());
    sessionMeta = { id: "", name: "", file: "" };
    captureSessionMeta(ctx);
    logCtx = { cwd: ctx.cwd, logFile: resolveProfile(ctx.cwd).logFile };
    try {
      // Current branch only: a cancelled or completed sibling must not leak here.
      const entries = ctx.sessionManager.getBranch();
      for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const value = entry as unknown as { customType: string; data?: Record<string, unknown> };
        const data = value.data || {};
        if ([CONTRACT_TYPE, LEGACY_CONTRACT_TYPE].includes(value.customType)) {
          contract = normalizeContract(data);
        }
        if ([STATE_TYPE, LEGACY_STATE_TYPE].includes(value.customType)) {
          hasExplicitState = true;
          const saved = data.lifecycle;
          lifecycle = saved === "active" || saved === "paused" || saved === "cancelled" || saved === "completed"
            ? saved : (data.paused === true ? "paused" : data.armed === true ? "active" : "inactive");
          iterations = typeof data.iterations === "number" && Number.isFinite(data.iterations) ? Math.max(0, Math.floor(data.iterations)) : 0;
          judgeFailures = typeof data.judgeFailures === "number" && Number.isFinite(data.judgeFailures) ? Math.max(0, Math.floor(data.judgeFailures)) : 0;
          lastVerdict = data.lastVerdict && typeof data.lastVerdict === "object" ? data.lastVerdict as Verdict : undefined;
          lastJudge = data.lastJudge && typeof data.lastJudge === "object" && Array.isArray((data.lastJudge as JudgeDiagnosis).attempts)
            ? data.lastJudge as JudgeDiagnosis : undefined;
          if (lifecycle === "cancelled" || lifecycle === "completed") contract = undefined;
        }
      }
      if (lifecycle === "cancelled" || lifecycle === "completed") contract = undefined;
      if (contract?.provisional) {
        // Old generic fallbacks are history, not permission to resume blindly.
        contract = undefined;
        lifecycle = "inactive";
        hasExplicitState = true;
      }
      if (lifecycle === "active" && !contract) lifecycle = "inactive";
    } catch (error) {
      debugLog(`session restore failed: ${String(error)}`);
      lifecycle = "inactive";
      hasExplicitState = true;
      contract = undefined;
    }
    refreshStatus();
  });
  // pi-subagents publishes async run boundaries on the shared event bus.
  pi.events?.on("subagent:async-started", (payload: any) => {
    if (!payload) return;
    if (!ownedByThisSession(payload)) return;
    const id = String(payload.id ?? payload.runId ?? "");
    const startedAt = Number(payload.startedAt);
    if (id) runningSubagents.set(id, Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now());
  });
  for (const event of ["subagent:async-complete", "subagent:process-terminal", "subagent:foreground-complete"]) {
    pi.events?.on(event, (payload: any) => {
      const id = String(payload?.runId ?? payload?.id ?? "");
      if (id) runningSubagents.delete(id);
      else if (!payload?.sessionId || payload.sessionId === sessionMeta.id) runningSubagents.clear();
    });
  }
  pi.on("session_shutdown", () => { invalidate(); runningSubagents.clear(); });
  pi.on("session_info_changed", (_event, ctx) => {
    captureSessionMeta(ctx);
  });

  pi.on("input", (event) => {
    if (event.source === "extension") return;
    invalidate();
    if (lifecycle === "drafting") {
      lifecycle = draftPrevious || "inactive";
      draftPrevious = undefined;
      persistState("draft abandoned by human input");
    }
    // Taking over invalidates pending work, not the confirmed task or progress.
    resetQuotaState();
    refreshStatus();
  });
  pi.on("turn_end", (event) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (!message || message.role !== "assistant") return;
    // Captured here rather than at settle time: pi renders the errored turn into the
    // transcript, but reading it from the boundary context is not guaranteed once a
    // previous probe already omitted it via context_edit.
    lastErrorMessage = message.stopReason === "error" && message.errorMessage ? message.errorMessage : undefined;
    const text = messageText(message);
    if (text) lastAssistantText = text;
  });

  function persistContract(): void {
    if (!contract) return;
    try {
      pi.appendEntry(CONTRACT_TYPE, contract);
    } catch {
      // best effort
    }
  }

  /** Review only the endpoint by default; explicit feedback regenerates a draft. */
  async function promptContract(
    ctx: ExtensionContext,
    candidate: Contract,
    openQuestions: string[],
    generation: number,
  ): Promise<{ accepted: boolean; feedback?: string }> {
    const blocking = openQuestions.length > 0;
    const marker = blocking
      ? "===== 对以上待澄清项的答复（填写后重新推断；留空=不确认；Esc=放弃）====="
      : "===== 修改意见（留空提交=确认；Esc=放弃）=====";
    const base = [contractSummary(candidate), blocking ? `待澄清（未解决前不会启用监督）:\n${openQuestions.map(q => `- ${q}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
    if (!ctx.hasUI || typeof ctx.ui.editor !== "function") return { accepted: false };
    try {
      const edited = await ctx.ui.editor("确认监督终点", `${base}\n\n${marker}\n`);
      if (!isCurrent(generation) || edited === undefined) return { accepted: false };
      const pos = edited.indexOf(marker);
      if (pos < 0) return { accepted: false, feedback: edited.trim() || undefined };
      const feedback = edited.slice(pos + marker.length).trim();
      const body = edited.slice(0, pos).trim();
      if (feedback) return { accepted: false, feedback };
      if (body !== base.trim()) return { accepted: false, feedback: body || undefined };
      return { accepted: true };
    } catch { return { accepted: false }; }
  }

  async function runBootstrapJudge(profile: Profile, ctx: ExtensionContext, feedback: string, generation: number): Promise<JudgeResult> {
    const prompt = buildBootstrapPrompt(profile, ctx, feedback, escalationFor(profile, ctx.cwd).name);
    const signal = operationController.signal;
    const first = await runJudge(prompt, profile, ctx.cwd, true, profile.bootstrapTimeoutMs ?? DEFAULTS.bootstrapTimeoutMs, signal, judgeContext("bootstrap"));
    if (!isCurrent(generation)) return first;
    recordJudgeUsage("bootstrap", first);
    if (first.ok || first.errorKind === "spawn" || first.errorKind === "logging") return first;
    log({ event: "bootstrap-retry-no-tools", error: first.error, detail: first.detail, ms: first.ms });
    const second = await runJudge(`${prompt}\n本次无工具，只根据会话推断；不确定的写入 open_questions。`, profile, ctx.cwd, false,
      Math.min(profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs, 180_000), signal, judgeContext("bootstrap-retry"));
    if (isCurrent(generation)) recordJudgeUsage("bootstrap-retry", second);
    return second;
  }

  async function ensureContract(ctx: ExtensionContext, profile: Profile, replan = false): Promise<Contract | undefined> {
    if (lifecycle === "drafting") return undefined;
    const previous = lifecycle;
    const oldContract = contract;
    invalidate();
    const generation = operationGeneration;
    draftPrevious = previous;
    hasExplicitState = true;
    // A reload during the first draft must not let --supervise silently retry it.
    if (!oldContract) persistState("draft requested");
    lifecycle = "drafting";
    refreshStatus();
    let feedback = "";
    const notes: string[] = [];
    const stopBeat = heartbeat(ctx, "正在推断终点", generation);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        log({ event: "bootstrap-start", attempt: attempt + 1, replan });
        const result = await runBootstrapJudge(profile, ctx, feedback, generation);
        if (!isCurrent(generation)) return undefined;
        if (!result.ok || !result.json) {
          log({ event: "bootstrap-failure", error: result.error, detail: result.detail, ms: result.ms });
          ctx.ui.notify("Supervisor：推断失败，未启用新契约；用 /supervisor start 或 replan 重试。", "warning");
          return undefined;
        }
        const json = result.json;
        const candidate = normalizeContract(json);
        const questions = asStringArray(json.open_questions);
        const validEndpoint = typeof json.mission === "string" && json.mission.trim().length > 0 &&
          asStringArray(json.completion_criteria ?? json.completionCriteria ?? json.criteria ?? json.completion_conditions).length > 0;
        if (!validEndpoint) questions.push("需要明确目标和至少一项可核验的完成条件。");
        const clear = validEndpoint && questions.length === 0 && (json.confidence === "high" || json.confidence === "medium");
        // No UI is not consent. Only explicit opt-in may accept a clear draft.
        const auto = clear && (profile.autoConfirm === true || pi.getFlag("supervise") === true);
        if (!clear && !ctx.hasUI) {
          ctx.ui.notify("Supervisor：终点存在歧义，未启用；请在交互会话中确认。", "warning");
          return undefined;
        }
        const answer = auto ? { accepted: true } : await promptContract(ctx, candidate, questions, generation);
        if (!isCurrent(generation)) return undefined;
        if (answer.accepted && validEndpoint && questions.length === 0) {
          candidate.confirmed_by_user = true;
          candidate.user_notes = [...new Set([...(oldContract?.user_notes || []), ...candidate.user_notes, ...notes])];
          contract = candidate;
          if (!replan) { iterations = 0; judgeFailures = 0; lastVerdict = undefined; }
          lifecycle = "active";
          draftPrevious = undefined;
          // A confirmed or replanned task starts with a clean structured state.
          try { clearState(stateRoots(profile, ctx.cwd).state, sessionMeta.id); } catch { /* best effort */ }
          persistContract();
          persistState("contract confirmed");
          log({ event: "contract", auto, contract });
          ctx.ui.notify("Supervisor：终点已确认，开始监督。", "info");
          return contract;
        }
        if (questions.length > 0 && !answer.feedback) {
          // Confirming an ambiguous candidate is not consent: it must be resolved first.
          ctx.ui.notify(truncateMiddle(`Supervisor：终点仍有待澄清项，未启用监督。请在“修改意见/答复”区回答后重试：\n${questions.map(q => `- ${q}`).join("\n")}`, 1200), "warning");
          log({ event: "contract-needs-clarification", questions });
          return undefined;
        }
        if (!answer.feedback) {
          ctx.ui.notify("Supervisor：未确认新契约，原状态保持不变。", "info");
          return undefined;
        }
        notes.push(answer.feedback);
        feedback = notes.join("\n\n");
        log({ event: "contract-feedback", attempt: attempt + 1, feedback: answer.feedback });
      }
      ctx.ui.notify("Supervisor：尚未确认终点，原状态保持不变。", "warning");
      return undefined;
    } finally {
      if (isCurrent(generation) && lifecycle === "drafting") {
        lifecycle = previous;
        draftPrevious = undefined;
        persistState("draft abandoned");
      }
      stopBeat();
    }
  }
  /** Persist a visible "why we are allowed to stop" message in the transcript. */
  function stopBoundary(content: string) {
    return {
      entries: [{ type: "custom_message" as const, customType: "pi-supervisor-stop", content, display: true }],
    };
  }

  function buildContinuation(options: {
    iteration: number; reason: string; nextStep: string; contract: Contract;
    unmet?: string[]; violations?: string[]; missingRecords?: string[];
    showContract?: boolean; extraNote?: string; escalationAgent?: string;
  }): string {
    const { reason, nextStep, contract: current, unmet = [], violations = [], missingRecords = [], showContract, extraNote } = options;
    const gaps = [...unmet, ...violations, ...missingRecords];
    return [
      "[Supervisor] 继续推进。",
      showContract ? contractSummary(current) : "",
      `未完成：${truncateMiddle(gaps.join("；") || reason || "终点尚未验证", 400)}`,
      `下一步：${truncateMiddle(nextStep || current.next_steps[0] || "核验尚未闭环的完成条件", 500)}`,
      extraNote || "",
      "按已确认的范围和限制执行；无需回应本条监督消息。",
    ].filter(Boolean).join("\n");
  }
  function resetQuotaState(): void {
    quotaState.attempts = 0;
    quotaState.waitedMs = 0;
    quotaState.startedAt = 0;
    quotaState.lastError = "";
    quotaState.lastRule = "";
  }

  function persistQuotaState(phase: "waiting" | "recovered"): void {
    try {
      pi.appendEntry(QUOTA_STATE_TYPE, {
        phase,
        attempts: quotaState.attempts,
        waitedMs: quotaState.waitedMs,
        startedAt: quotaState.startedAt ? new Date(quotaState.startedAt).toISOString() : null,
        rule: quotaState.lastRule || null,
        error: truncateMiddle(quotaState.lastError, 400),
        at: new Date().toISOString(),
      });
    } catch { /* best effort */ }
  }

  /**
   * Entry id of the assistant message that just failed, so it can be omitted from the
   * model projection the same way pi's own auto-retry does (_omitRecoveryAttempt).
   */
  function findErroredEntryId(event: AgentBeforeSettleEvent, ctx: ExtensionContext): string | undefined {
    type Projected = { sourceEntry?: { id?: string; type?: string }; messages?: Array<{ role?: string; stopReason?: string }> };
    const projected = (event.context?.contextEntries ?? []) as Projected[];
    for (let i = projected.length - 1; i >= 0; i--) {
      const entry = projected[i];
      if (entry?.sourceEntry?.type !== "message" || !entry.sourceEntry.id) continue;
      if (entry.messages?.some((m) => m?.role === "assistant" && m?.stopReason === "error")) return entry.sourceEntry.id;
    }
    try {
      type Raw = { id?: string; type?: string; message?: { role?: string; stopReason?: string } };
      const raw = [...ctx.sessionManager.getEntries()].reverse() as Raw[];
      return raw.find((e) => e.type === "message" && e.message?.role === "assistant" && e.message?.stopReason === "error")?.id;
    } catch { return undefined; }
  }

  function quotaGiveUp(ctx: ExtensionContext, reason: string): AgentBeforeSettleEventResult {
    log({ event: "quota-giveup", reason, rule: quotaState.lastRule, attempts: quotaState.attempts, waitedMs: quotaState.waitedMs });
    const detail = `已等待 ${formatDuration(quotaState.waitedMs)}，探测 ${quotaState.attempts} 次`;
    resetQuotaState();
    pauseTask(reason);
    ctx.ui.notify(`Supervisor：已暂停额度等待 — ${reason}`, "warning");
    return stopBoundary(`[Supervisor] 已暂停，非目标达成。\n${reason}（${detail}）\n额度恢复后用 /supervisor resume 继续。`);
  }

  async function handleQuotaError(ctx: ExtensionContext, profile: Profile, event: AgentBeforeSettleEvent, generation: number): Promise<AgentBeforeSettleEventResult | undefined> {
    const quotaWait = resolveQuotaWait(profile);
    if (!quotaWait.enabled) return;
    const classification = classifyStopError(lastErrorMessage, { extraPatterns: quotaWait.extraPatterns, ignorePatterns: quotaWait.ignorePatterns });
    const stopFile = resolvePath(profile.stopFile || DEFAULTS.stopFile, ctx.cwd);
    const stopExists = () => Boolean(stopFile && fs.existsSync(stopFile));
    if (classification.kind === "permanent") {
      if (!quotaWait.permanentAsHumanNeeded) return;
      log({ event: "quota-permanent", rule: classification.rule, error: lastErrorMessage });
      pauseTask("main-model permanent error");
      resetQuotaState();
      return stopBoundary(`[Supervisor] 已暂停，需要处理主模型错误，非目标达成。\n${truncateMiddle(lastErrorMessage || "", 400)}\n处理后 /supervisor resume。`);
    }
    if (classification.kind !== "quota") return;
    if (stopExists()) return quotaGiveUp(ctx, "检测到 STOP 文件");
    if (quotaWait.maxAttempts > 0 && quotaState.attempts >= quotaWait.maxAttempts) return quotaGiveUp(ctx, `已达最大探测次数 ${quotaWait.maxAttempts}`);
    if (quotaWait.maxWaitMinutes > 0 && quotaState.waitedMs >= quotaWait.maxWaitMinutes * 60_000) return quotaGiveUp(ctx, `已超出最长等待 ${quotaWait.maxWaitMinutes} 分钟`);
    if (quotaState.attempts === 0) {
      quotaState.startedAt = Date.now();
      quotaState.lastRule = classification.rule || "";
      log({ event: "quota-detected", rule: classification.rule, error: lastErrorMessage });
      ctx.ui.notify("Supervisor：主模型额度耗尽，等待后重试；pause/cancel、Esc 或 STOP 可中断。", "warning");
    }
    quotaState.lastError = lastErrorMessage || "";
    const attempt = ++quotaState.attempts;
    const started = Date.now();
    const deadline = started + quotaWait.intervalMs;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, operationController.signal]) : operationController.signal;
    quotaWaiting = true;
    persistQuotaState("waiting");
    log({ event: "quota-probe", attempt, intervalMs: quotaWait.intervalMs, waitedMs: quotaState.waitedMs });
    const stopBeat = startQuotaCountdown(ctx, deadline, attempt, () => quotaState.waitedMs + Date.now() - started);
    let outcome: SleepOutcome;
    try {
      outcome = await sleepUntil(deadline, signal, stopExists);
    } finally {
      stopBeat();
      if (isCurrent(generation)) { quotaWaiting = false; quotaState.waitedMs += Date.now() - started; refreshStatus(); }
    }
    if (!isCurrent(generation) || lifecycle !== "active") return;
    if (outcome === "stop-file") return quotaGiveUp(ctx, "检测到 STOP 文件");
    if (outcome === "signal") {
      log({ event: "quota-aborted", reason: "user-abort" });
      resetQuotaState();
      return;
    }
    const targetId = findErroredEntryId(event, ctx);
    if (targetId) return { continue: true, entries: [{ type: "context_edit", targetId, replacement: null }] };
    return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
      content: "[Supervisor] 额度探测：从中断处继续，不要复述本条消息。" }] };
  }
  function interpretVerdict(raw: Verdict, ctx: ExtensionContext, options: { deferHumanPause?: boolean } = {}): { verdict: Verdict; replan: boolean } {
    const checked = evaluateVerdict(contract!, raw);
    lastVerdict = checked.verdict;
    contract = mergeContract(contract!, checked.replan ? undefined : checked.verdict.contract_updates);
    persistContract();
    if (checked.verdict.goal_achieved === true) {
      invalidate();
      lifecycle = "completed";
      // The confirmed endpoint remains in history, not as a resumable task.
      contract = undefined;
      persistState("goal achieved with criterion evidence");
      log({ event: "done", verdict: checked.verdict });
      ctx.ui.notify("Supervisor：完成条件均已核验，监督结束。", "info");
    } else if (checked.verdict.human_needed === true) {
      if (options.deferHumanPause) {
        // The caller asks the escalation agent whether this is really human.
        persistState("human needed (pending escalation)");
      } else pauseTask(checked.replan ? "endpoint requires confirmation" : "human needed");
      log({ event: "human-needed", verdict: checked.verdict });
      ctx.ui.notify(checked.replan ? "Supervisor：终点或限制变化，已暂停；用 /supervisor replan 重新确认。" : "Supervisor：需要你处理，已暂停；处理后 /supervisor resume。", "warning");
    } else {
      persistState("verdict progress");
    }
    return checked;
  }

  function verdictStop(verdict: Verdict, replan: boolean): AgentBeforeSettleEventResult {
    return stopBoundary(verdict.goal_achieved === true
      ? `[Supervisor] ✅ 目标达成\n${verdict.reason || "完成条件均有直接证据"}`
      : `[Supervisor] 已暂停，非目标达成。\n${verdict.reason || "需要人类处理"}\n${verdict.next_step || ""}\n${replan ? "/supervisor replan" : "/supervisor resume"}`);
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    captureSessionMeta(ctx);
    const profile = resolveProfile(ctx.cwd);
    logCtx = { cwd: ctx.cwd, logFile: profile.logFile };
    if (!hasExplicitState && lifecycle === "inactive" && (pi.getFlag("supervise") === true || profile.enabled === true)) {
      if (event.outcome === "aborted" || event.outcome === "error" || ctx.hasPendingMessages() || judging || quotaWaiting) return;
      pruneSubagents();
      if (runningSubagents.size > 0) {
        log({ event: "settle-deferred", reason: "subagent running before contract", runs: [...runningSubagents.keys()] });
        return;
      }
      const built = await ensureContract(ctx, profile);
      if (!built || (lifecycle as Lifecycle) !== "active") return;
      return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
        content: buildContinuation({ iteration: iterations + 1, reason: "终点已确认", nextStep: built.next_steps[0] || "核验并推进完成条件", contract: built, showContract: true }) }] };
    }
    if (lifecycle !== "active" || !contract || judging || quotaWaiting) return;
    if (event.outcome === "aborted" || ctx.hasPendingMessages() || event.context?.pendingMessages?.length) return;
    pruneSubagents();
    if (runningSubagents.size > 0) {
      log({ event: "settle-deferred", reason: "subagent running", runs: [...runningSubagents.keys()] });
      return;
    }
    const generation = operationGeneration;
    if (event.outcome === "error") return handleQuotaError(ctx, profile, event, generation);
    if (quotaState.attempts > 0) {
      log({ event: "quota-recovered", attempts: quotaState.attempts, waitedMs: quotaState.waitedMs });
      resetQuotaState();
    }
    const stopFile = resolvePath(profile.stopFile || DEFAULTS.stopFile, ctx.cwd);
    if (stopFile && fs.existsSync(stopFile)) {
      pauseTask("STOP file");
      log({ event: "stopped", reason: "STOP file" });
      return stopBoundary("[Supervisor] 已暂停：检测到 STOP 文件，非目标达成。移除后 /supervisor resume。");
    }
    if (iterations >= (profile.maxIterations ?? DEFAULTS.maxIterations)) {
      pauseTask("max iterations");
      log({ event: "max-iterations", iteration: iterations });
      return stopBoundary("[Supervisor] 已暂停：达到监督轮次上限，非目标达成。检查后 /supervisor resume 或调整上限。");
    }
    const signal = operationController.signal;
    judging = true;
    const stopBeat = heartbeat(ctx, "正在核验终点", generation);
    try {
      const last = event.context?.contextMessages?.length ? messageText([...event.context.contextMessages].reverse().find(m => m.role === "assistant")) : lastAssistantText;
      const outcome = await runTieredJudge({ ctx, profile, contract, report: last || lastAssistantText, round: iterations + 1, signal, kind: "enforce" });
      if (!isCurrent(generation) || lifecycle !== "active") return;
      if (outcome.changed) {
        log({ event: "judge-session-changed", tier: outcome.tier });
        persistState("session changed during judge");
        return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
          content: buildContinuation({ iteration: iterations + 1, reason: "判定期间会话已变化，本轮结论作废", nextStep: contract.next_steps[0] || "核验未完成条件", contract }) }] };
      }
      if (outcome.tier === "L0") {
        iterations += 1;
        judgeFailures = 0;
        log({ event: "judge-l0", iteration: iterations, reason: outcome.l0Reason, reused: outcome.reused });
        persistState("l0 stable unmet");
        return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
          content: buildContinuation({ iteration: iterations, reason: `结构化状态未变化：${outcome.l0Reason}`, nextStep: contract.next_steps[0] || "核验未完成条件", contract }) }] };
      }
      const result = outcome.result!;
      recordJudgeUsage("enforce", result);
      if (!result.ok || !result.json) {
        judgeFailures += 1;
        log({ event: "judge-failure", error: result.error, errorKind: result.errorKind, detail: result.detail, ms: result.ms });
        persistState("judge failure");
        if (judgeFailures >= (profile.maxJudgeFailures ?? DEFAULTS.maxJudgeFailures)) {
          pauseTask("judge failure limit");
          return stopBoundary(`[Supervisor] 已暂停：判官连续失败，非目标达成。\n${judgeFailureHint()}`);
        }
        return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
          content: buildContinuation({ iteration: iterations + 1, reason: "判定失败，不能认定完成；/supervisor diagnose 查看原因，retry 可全量留档只重试判官", nextStep: contract.next_steps[0] || "核验未完成条件", contract }) }] };
      }
      judgeFailures = 0;
      iterations += 1;
      const { verdict, replan } = interpretVerdict(result.json as Verdict, ctx, { deferHumanPause: true });
      log({ event: "verdict", iteration: iterations, verdict, ms: result.ms });
      const stagnationLimit = profile.stagnationRounds ?? DEFAULTS.stagnationRounds;
      const stagnant = outcome.state?.stagnantRounds ?? 0;
      const humanGate = verdict.human_needed === true;
      const stalled = stagnationLimit > 0 && stagnant >= stagnationLimit && verdict.goal_achieved !== true;
      if (humanGate || stalled) {
        // Before honouring a human gate (or pausing for stagnation), ask the
        // configured escalation agent what is truly blocked on a human.
        const judged = await adjudicate({ ctx, profile, contract, report: last || lastAssistantText,
          verdict, round: iterations, signal, state: outcome.state });
        if (!isCurrent(generation) || lifecycle !== "active") return;
        const admin = judged.admin;
        const executable = admin?.executable ?? [];
        const human = admin?.humanRequired ?? [];
        if (admin && executable.length > 0 && human.length === 0) {
          const next = executable[0].action;
          iterations += 1;
          try {
            const state2 = applyVerdict(outcome.state, { sessionId: sessionMeta.id, branchTip: outcome.state?.branchTip,
              contractKey: judgeContractKey(contract), round: iterations, criteria: contract.completion_criteria,
              verdict: { goal_achieved: false, human_needed: false, reason: `escalation：${admin.reason || "仍有可执行工作"}`,
                next_step: next, unmet_conditions: executable.map(item => item.action) } as Verdict,
              report: `escalation:${admin.reason || ""}`, cwd: ctx.cwd, escalationIncrement: 1, repo: snapshotRepo(ctx.cwd) });
            writeState(stateRoots(profile, ctx.cwd).state, state2);
          } catch { /* state stays as-is; next round re-derives */ }
          judgeFailures = 0;
          log({ event: "escalation-override", human: human.length, executable: executable.length, nextStep: next });
          persistState("escalation: executable work remains");
          return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
            content: buildContinuation({ iteration: iterations, reason: `升级诊断：仍需执行（${admin.reason || "存在可执行动作"}）`,
              nextStep: next, contract: contract!, unmet: executable.map(item => item.action) }) }] };
        }
        if (admin && human.length > 0) {
          log({ event: "escalation-human-gate", items: human.map(item => item.item).slice(0, 6), reason: admin.reason ?? null });
          pauseTask("escalation human gate");
          return stopBoundary(`[Supervisor] 已暂停：升级诊断确认以下阻断需要人类处理，非目标达成。\n` +
            human.slice(0, 6).map(item => `- ${item.item}${item.why ? `：${item.why}` : ""}`).join("\n") +
            (executable.length ? `\n另有可执行项（恢复后优先）：\n${executable.slice(0, 4).map(item => `- ${item.action}`).join("\n")}` : "") +
            "\n处理后 /supervisor resume。");
        }
        if (stalled) {
          const recent = (outcome.state?.recentNextSteps || []).slice(-2).reverse();
          log({ event: "judge-stagnation", rounds: stagnant, nextSteps: recent, escalation: judged.ok ? "no-adjudication" : judged.error ?? null });
          pauseTask("judge stagnation");
          return stopBoundary(`[Supervisor] 已暂停：连续 ${stagnant} 轮无新增证据，非目标达成。\n` +
            `最近建议：${recent.map(step => `\n- ${truncateMiddle(step, 160)}`).join("") || "(无)"}\n` +
            (judged.skipped ? `升级诊断不可用：${judged.error}。\n` : "升级诊断未给出可用结论。\n") +
            "若剩余阻断需要人类批准或授权，请处理后 /supervisor resume；若要继续核验，请先补充新的证据或改变核验方式。");
        }
        // No usable adjudication: honour the original human boundary.
        if (humanGate) {
          pauseTask(replan ? "endpoint requires confirmation" : "human needed");
          log({ event: "human-needed", verdict, escalation: judged.skipped ? "unavailable" : "no-verdict" });
          ctx.ui.notify(replan ? "Supervisor：终点或限制变化，已暂停；用 /supervisor replan 重新确认。" : "Supervisor：需要你处理，已暂停；处理后 /supervisor resume。", "warning");
          return verdictStop(verdict, replan);
        }
      }
      if (verdict.goal_achieved === true || verdict.human_needed === true) return verdictStop(verdict, replan);
      const continuation = buildContinuation({ iteration: iterations, reason: verdict.reason || "终点尚未验证",
        nextStep: verdict.next_step || contract!.next_steps[0] || "核验未完成的完成条件", contract: contract!,
        unmet: asStringArray(verdict.unmet_conditions), violations: asStringArray(verdict.policy_violations), missingRecords: asStringArray(verdict.records_missing) });
      if ((profile.smartCompaction ?? DEFAULTS.smartCompaction) && verdict.compact_now === true && ctx.mode === "tui") {
        const compactionGeneration = operationGeneration;
        const compactSignal = operationController.signal;
        const focus = verdict.compact_focus || `保留目标、完成条件、限制与进度。\n${contractSummary(contract!, true)}`;
        const stopCompact = heartbeat(ctx, "正在整理上下文", compactionGeneration);
        let queued = false;
        const resume = () => {
          if (queued || !isCurrent(compactionGeneration) || lifecycle !== "active" || compactSignal.aborted) return;
          queued = true;
          // Do not leave an unbounded polling timer that could survive task changes.
          if (ctx.isIdle() && !ctx.hasPendingMessages()) pi.sendUserMessage(continuation);
          else log({ event: "compact-continue-deferred", reason: "agent not idle; next settle will re-evaluate" });
        };
        const complete = () => {
          stopCompact();
          if (!isCurrent(compactionGeneration)) return;
          log({ event: "compact-done", focus });
          resume();
        };
        const failed = (error: Error) => {
          stopCompact();
          if (!isCurrent(compactionGeneration)) return;
          log({ event: "compact-failed", error: String(error) });
          resume();
        };
        try { ctx.compact({ customInstructions: focus, onComplete: complete, onError: failed }); }
        catch (error) { failed(error as Error); }
        return;
      }
      return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", content: continuation, display: true }] };
    } finally {
      if (isCurrent(generation)) judging = false;
      stopBeat();
    }
  });
  pi.registerFlag("supervise", {
    description: "Arm pi-supervisor for this session and auto-confirm the inferred contract",
    type: "boolean",
  });

  pi.registerCommand("supervisor", {
    description: "Supervisor: start | pause | resume | cancel | status（更多：retry/diagnose/details/replan/note/judge/history/usage/quota）",
    handler: async (args, ctx) => {
      captureSessionMeta(ctx);
      const raw = (args || "").trim();
      const sub = (raw.split(/\s+/)[0] || "status").toLowerCase();
      const rest = raw.slice(sub === "status" && !raw ? 0 : sub.length).trim();
      const profile = resolveProfile(ctx.cwd);
      logCtx = { cwd: ctx.cwd, logFile: profile.logFile };
      if (sub === "pause") {
        if (lifecycle !== "active" && lifecycle !== "drafting") {
          ctx.ui.notify("Supervisor：当前没有正在监督的任务。", "info");
          return;
        }
        pauseTask("manual pause");
        ctx.ui.notify("Supervisor：已暂停，契约与进度保留；/supervisor resume 恢复。", "info");
        return;
      }
      if (sub === "resume") {
        if (lifecycle === "active") {
          ctx.ui.notify("Supervisor：监督正在进行，无需 resume。要重新核验用 /supervisor retry；要停下用 /supervisor pause。", "info");
          return;
        }
        if (lifecycle === "drafting") {
          ctx.ui.notify("Supervisor：终点尚待确认，无需 resume；完成确认或 /supervisor cancel 放弃。", "info");
          return;
        }
        if (lifecycle === "completed" || lifecycle === "cancelled") {
          ctx.ui.notify(`Supervisor：任务${stateLabel()}，无法恢复；用 /supervisor start 建立新任务。`, "info");
          return;
        }
        if (lifecycle === "paused" && !contract) {
          ctx.ui.notify("Supervisor：暂停任务缺少有效契约，无法恢复；请用 /supervisor start 重建终点。", "warning");
          return;
        }
        if (lifecycle !== "paused") {
          ctx.ui.notify("Supervisor：当前没有可恢复的暂停任务；/supervisor start 建立新任务。", "info");
          return;
        }
        invalidate();
        lifecycle = "active";
        persistState("manual resume");
        ctx.ui.notify("Supervisor：已恢复监督。", "info");
        if ((ctx.mode === "tui" || ctx.mode === "rpc") && ctx.isIdle() && !ctx.hasPendingMessages()) {
          pi.sendUserMessage(buildContinuation({ iteration: iterations + 1, reason: "恢复已确认的任务", nextStep: contract.next_steps[0] || "核验未完成条件", contract }));
        }
        return;
      }
      if (sub === "cancel") {
        if (lifecycle !== "active" && lifecycle !== "paused" && lifecycle !== "drafting") {
          ctx.ui.notify(`Supervisor：${stateLabel()}，没有可取消的有效任务。`, "info");
          return;
        }
        if (!ctx.hasUI || typeof ctx.ui.select !== "function") {
          ctx.ui.notify("Supervisor：无法显示默认不取消的确认，未取消；请在交互会话中操作。", "warning");
          return;
        }
        const generation = operationGeneration;
        let approved = false;
        try { approved = await ctx.ui.select("取消监督？移除契约与监督进度，不中断主 Agent。", ["不取消", "取消"]) === "取消"; } catch { /* default negative */ }
        if (!isCurrent(generation)) return;
        if (!approved) { ctx.ui.notify("Supervisor：未取消，状态不变。", "info"); return; }
        invalidate();
        draftPrevious = undefined;
        lifecycle = "cancelled";
        contract = undefined;
        try { clearState(stateRoots(profile, ctx.cwd).state, sessionMeta.id); } catch { /* best effort */ }
        lastVerdict = undefined;
        lastJudge = undefined;
        lastErrorMessage = undefined;
        iterations = 0;
        judgeFailures = 0;
        resetQuotaState();
        persistState("manual cancel");
        log({ event: "cancelled" });
        ctx.ui.notify("Supervisor：已取消，契约与监督进度已清除；主 Agent 继续运行。重新监督请 /supervisor start。", "info");
        return;
      }
      if (sub === "on" || sub === "off" || sub === "reset") {
        ctx.ui.notify("Supervisor：on/off/reset 已弃用；请使用 start/pause/resume/cancel/status。", "info");
        return;
      }
      if (sub === "start" || sub === "replan") {
        if (lifecycle === "drafting" || (sub === "start" && lifecycle === "active")) {
          ctx.ui.notify(`Supervisor：${stateLabel()}；/supervisor status 查看。`, "info");
          return;
        }
        if (sub === "start" && lifecycle === "paused" && contract) {
          ctx.ui.notify("Supervisor：保留了暂停任务；用 resume 恢复，或先 cancel 再 start。", "info");
          return;
        }
        if (sub === "replan" && !contract) {
          ctx.ui.notify("Supervisor：没有有效契约可重新规划；请 /supervisor start。", "warning");
          return;
        }
        const built = await ensureContract(ctx, profile, sub === "replan");
        if (!built || lifecycle !== "active") return;
        if ((ctx.mode === "tui" || ctx.mode === "rpc") && ctx.isIdle() && !ctx.hasPendingMessages()) {
          pi.sendUserMessage(buildContinuation({ iteration: iterations + 1, reason: "终点已确认", nextStep: built.next_steps[0] || "核验并推进完成条件", contract: built, showContract: true }));
        }
        return;
      }
      if (sub === "note") {
        if (!contract || (lifecycle !== "active" && lifecycle !== "paused")) { ctx.ui.notify("Supervisor：没有有效契约；请先 start。", "warning"); return; }
        if (!rest) { ctx.ui.notify("用法：/supervisor note <补充说明>", "warning"); return; }
        invalidate();
        contract = { ...contract, user_notes: [...contract.user_notes, rest], updated_at: new Date().toISOString() };
        persistContract();
        persistState("user note");
        ctx.ui.notify("Supervisor：补充说明已保留；若改变终点或限制，请 replan 重新确认。", "info");
        return;
      }
      if (sub === "judge" || sub === "retry") {
        if (!contract || (lifecycle !== "active" && lifecycle !== "paused")) { ctx.ui.notify("Supervisor：没有有效监督任务；请先 start。", "warning"); return; }
        if (!ctx.isIdle() || judging || quotaWaiting) { ctx.ui.notify("Supervisor：当前忙碌，稍后会自动判定。", "info"); return; }
        const generation = operationGeneration;
        const signal = operationController.signal;
        judging = true;
        const retry = sub === "retry";
        const stopBeat = heartbeat(ctx, retry ? "正在重试判官（全量日志）" : "正在手动核验", generation);
        try {
          const outcome = await runTieredJudge({ ctx, profile, contract, report: lastAssistantText, round: iterations + 1, signal,
            kind: retry ? "manual-retry" : "manual", allowL0: false, forceDeep: retry });
          if (!isCurrent(generation) || !contract || (lifecycle !== "active" && lifecycle !== "paused")) return;
          if (outcome.changed) {
            log({ event: "judge-session-changed", tier: outcome.tier });
            ctx.ui.notify("Supervisor：判定期间会话已变化，本轮结果作废；按状态再试。", "warning");
            return;
          }
          const result = outcome.result!;
          recordJudgeUsage(retry ? "manual-retry" : "manual", result);
          if (!result.ok || !result.json) {
            if (retry) judgeFailures += 1;
            if (retry && lifecycle === "active" && judgeFailures >= (profile.maxJudgeFailures ?? DEFAULTS.maxJudgeFailures)) pauseTask("judge failure limit");
            else persistState(retry ? "manual retry failed" : "manual judge failed");
            ctx.ui.notify(`Supervisor：判官核验失败，未续跑主 Agent。\n${judgeFailureHint()}`, "warning"); return;
          }
          judgeFailures = 0;
          const wasActive = lifecycle === "active";
          const { verdict, replan } = interpretVerdict(result.json as Verdict, ctx);
          log({ event: "manual-judge", verdict, ms: result.ms });
          if (verdict.goal_achieved === true || verdict.human_needed === true) {
            const boundary = verdictStop(verdict, replan);
            for (const entry of boundary.entries || []) {
              if (entry.type === "custom_message") pi.sendMessage({ customType: "pi-supervisor-stop", content: entry.content, display: true }, { triggerTurn: false });
            }
          } else if (!retry && wasActive && lifecycle === "active" && !ctx.hasPendingMessages()) {
            pi.sendUserMessage(buildContinuation({ iteration: iterations + 1, reason: verdict.reason || "终点尚未验证", nextStep: verdict.next_step || contract!.next_steps[0] || "核验完成条件", contract: contract!,
              unmet: asStringArray(verdict.unmet_conditions), violations: asStringArray(verdict.policy_violations), missingRecords: asStringArray(verdict.records_missing) }));
          } else ctx.ui.notify(`Supervisor：已判定，${lifecycle === "paused" ? "仍保持暂停" : "保持监督状态"}；未发送主 Agent 续跑指令。${retry ? "全量日志见 /supervisor diagnose。" : ""}`, "info");
        } finally { if (isCurrent(generation)) judging = false; stopBeat(); }
        return;
      }
      if (sub === "diagnose") {
        ctx.ui.notify(judgeDiagnosisText(profile, ctx.cwd), lastJudge?.ok === false ? "warning" : "info");
        return;
      }
      if (sub === "quota") {
        const quotaWait = resolveQuotaWait(profile);
        const cls = classifyStopError(lastErrorMessage, {
          extraPatterns: quotaWait.extraPatterns,
          ignorePatterns: quotaWait.ignorePatterns,
        });
        const text = [
          `enabled: ${quotaWait.enabled}  ·  interval: ${formatDuration(quotaWait.intervalMs)}  ·  maxWait: ${quotaWait.maxWaitMinutes > 0 ? `${quotaWait.maxWaitMinutes}min` : "无限"}  ·  maxAttempts: ${quotaWait.maxAttempts > 0 ? String(quotaWait.maxAttempts) : "无限"}`,
          `state: ${quotaState.attempts > 0
            ? `${quotaWaiting ? "等待中" : "已探测"} · 第 ${quotaState.attempts} 次 · 累计 ${formatDuration(quotaState.waitedMs)}${quotaState.lastRule ? ` · rule=${quotaState.lastRule}` : ""}`
            : "空闲（当前没有额度等待）"}`,
          `lastError: ${truncateMiddle(lastErrorMessage ?? "(无)", 300)}`,
          `classify: ${cls.kind}${cls.rule ? ` (${cls.rule})` : ""}`,
          quotaWait.extraPatterns.length ? `extraPatterns: ${quotaWait.extraPatterns.join(" | ")}` : "",
          quotaWait.ignorePatterns.length ? `ignorePatterns: ${quotaWait.ignorePatterns.join(" | ")}` : "",
          "额度类错误会在 settle 处阻塞等待，然后让 pi 重发同一请求（失败探测 0 token，并用 context_edit 把失败轮从上下文里剔除，所以 0 上下文增长）；Esc 或 STOP 文件中断。非额度的 provider 错误维持原行为，不接管。",
        ].filter(Boolean).join("\n");
        ctx.ui.notify(truncateMiddle(text, 4000), "info");
        return;
      }
      if (sub === "history") {
        const n = Math.min(Math.max(parseInt(rest || "20", 10) || 20, 1), 200);
        const entries = readSessionHistory(profile.logFile, sessionMeta.id, 2000).slice(-n);
        const text = entries.length
          ? entries.map(historyLine).join("\n")
          : "(本 session 暂无判定历史；先跑一次并触发 stop 后即可看到)";
        ctx.ui.notify(truncateMiddle(`pi-supervisor history · ${sessionMeta.name || sessionMeta.id || "(未命名)"}（最近 ${entries.length} 条）\n${text}`, 4500), "info");
        return;
      }
      if (sub === "usage") {
        const logged = readSessionHistory(profile.logFile, sessionMeta.id, 5000)
          .filter((entry) => entry.event === "judge-usage" && entry.usage);
        const sessionUsage = emptyUsage();
        for (const entry of logged) addUsage(sessionUsage, entry.usage);
        sessionUsage.calls = logged.reduce((total, entry) => total + (Array.isArray(entry.attempts) ? entry.attempts.length || 1 : 1), 0);
        const recent = logged.slice(-8);
        const text = [
          `本进程: ${formatUsage(usageTotals)}`,
          `本 session（日志累计）: ${formatUsage(sessionUsage)}`,
          recent.length
            ? `最近 ${recent.length} 次:\n${recent.map((entry) => `  ${String(entry.ts).slice(11, 19)} ${String(entry.kind)} — ${String((entry.usage as UsageSummary | undefined)?.totalTokens ?? "?")} tokens`).join("\n")}`
            : "最近调用: (无)",
          "统计范围：判官调用（bootstrap / enforce / manual / retry）与 supervisor 触发的 compact；不含主 Agent 自身、也不含注入消息带来的间接开销。历史日志按 session 过滤。",
        ].join("\n");
        ctx.ui.notify(truncateMiddle(text, 4000), "info");
        return;
      }
      if (sub === "details") {
        const escalationLine = escalationHint(escalationFor(profile, ctx.cwd), profile.escalationAgent);
        ctx.ui.notify([contract ? contractSummary(contract, true) : `Supervisor：${stateLabel()}，没有有效契约。`, escalationLine].join("\n\n"), "info");
        return;
      }
      if (sub !== "status") {
        ctx.ui.notify("用法：/supervisor start | pause | resume | cancel | status\n更多：retry/diagnose/details/replan/note/judge/history/usage/quota", "info");
        return;
      }
      const next = lifecycle === "active" ? "pause / cancel" : lifecycle === "paused" && contract ? `${lastJudge?.ok === false ? "retry / " : ""}resume / cancel` : lifecycle === "drafting" ? "确认终点 / cancel" : "start";
      const status = [
        `Supervisor · ${stateLabel()}`,
        contract ? `终点：${truncateMiddle(contract.mission, 160)}` : "当前无有效契约。",
        lastVerdict?.goal_achieved === false ? `未闭环：${truncateMiddle(asStringArray(lastVerdict.unmet_conditions).join("；") || lastVerdict.reason || "尚待核验", 180)}` : "",
        contract && lastVerdict?.next_step ? `下一步：${truncateMiddle(lastVerdict.next_step, 180)}` : "",
        `操作：/supervisor ${next}`,
        lastJudge?.ok === false ? "判官故障：/supervisor diagnose；/supervisor retry 只重试判官并全量留档。" : "",
        "详情：details · 诊断：diagnose / history / usage / quota",
      ].filter(Boolean).join("\n");
      ctx.ui.notify(status, "info");

    },
  });
}
