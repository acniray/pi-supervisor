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

import { execFileSync, spawn } from "node:child_process";
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
const READONLY_TOOLS = "read,grep,find,ls";

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

interface JudgeResult {
  ok: boolean;
  json?: Record<string, unknown>;
  text?: string;
  usage?: UsageSummary;
  raw?: string;
  stderr?: string;
  detail?: string;
  model?: string;
  failovers?: string[];
  error?: string;
  ms: number;
}

/** Token/cost usage aggregated across judge turns. */
interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
  /** Assistant messages observed (a failed provider attempt can produce one with zero usage). */
  turns: number;
  /** Judge invocations (one per runJudge call, failover included). */
  calls: number;
}

function emptyUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, turns: 0, calls: 0 };
}

function addUsage(target: UsageSummary, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cost = u.cost && typeof u.cost === "object" ? num((u.cost as Record<string, unknown>).total) : num(u.cost);
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.reasoning += num(u.reasoning);
  target.totalTokens += num(u.totalTokens) || (input + output + cacheRead + cacheWrite);
  target.cost += cost;
  target.turns += 1;
}

function formatUsage(usage: UsageSummary): string {
  const calls = usage.calls > 0 ? usage.calls : usage.turns;
  return `in ${usage.input} / out ${usage.output} / cacheRead ${usage.cacheRead} / cacheWrite ${usage.cacheWrite} = ${usage.totalTokens} tokens · $${usage.cost.toFixed(4)}（${calls} 次判官调用）`;
}

/**
 * Judge subprocesses run with `--mode json`, so stdout carries the full event stream
 * (including `usage`). Test stubs may print a plain JSON verdict instead; in that case
 * `sawEvents` is false and the caller falls back to the raw stdout as text.
 */
interface JudgeOutput {
  text: string;
  usage?: UsageSummary;
  sawEvents: boolean;
  /** Human-readable diagnosis of why the model produced no usable answer. */
  detail?: string;
}

function parseJudgeOutput(stdout: string): JudgeOutput {
  let sawEvents = false;
  let finalText = "";
  let deltaText = "";
  const usage = emptyUsage();
  const providerErrors: string[] = [];
  const stopReasons: string[] = [];
  const retryErrors: string[] = [];
  let retryFinalError: string | undefined;
  let diagnostics: string[] = [];

  const push = (list: string[], value: unknown) => {
    if (typeof value === "string" && value.trim() && !list.includes(value.trim())) list.push(value.trim());
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type === "message_update") {
      sawEvents = true;
      const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (event?.type === "text_delta" && typeof event.delta === "string") deltaText += event.delta;
    } else if (record.type === "message_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        sawEvents = true;
        addUsage(usage, message.usage);
        push(stopReasons, message.stopReason);
        push(providerErrors, message.errorMessage);
        if (Array.isArray(message.diagnostics)) {
          for (const item of message.diagnostics as unknown[]) {
            const text = typeof item === "string" ? item : JSON.stringify(item);
            if (text) diagnostics.push(text.slice(0, 200));
          }
        }
        const content = message.content;
        if (Array.isArray(content)) {
          const text = content
            .filter((block): block is { type: string; text: string } =>
              !!block && typeof block === "object" && (block as { type?: string }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string")
            .map((block) => block.text)
            .join("\n");
          if (text.trim()) finalText = text;
        }
      }
    } else if (record.type === "error") {
      sawEvents = true;
      push(providerErrors, record.error);
      push(providerErrors, record.reason);
    } else if (record.type === "auto_retry_start") {
      push(retryErrors, record.errorMessage);
    } else if (record.type === "auto_retry_end") {
      if (record.success === false) retryFinalError = typeof record.finalError === "string" ? record.finalError : retryFinalError;
    }
  }

  const parts: string[] = [];
  if (providerErrors.length) parts.push(`provider=${providerErrors.join(" / ")}`);
  if (retryFinalError) parts.push(`autoRetryFinal=${retryFinalError}`);
  else if (retryErrors.length) parts.push(`autoRetry=${retryErrors.join(" / ")}`);
  if (stopReasons.length && stopReasons.some((reason) => reason !== "stop")) {
    parts.push(`stopReason=${stopReasons.join(",")}`);
  }
  if (diagnostics.length) parts.push(`diagnostics=${diagnostics.slice(0, 2).join(" | ")}`);
  if (!parts.length && usage.turns > 0 && !finalText && !deltaText) {
    parts.push(`模型返回空内容（${usage.turns} 次 assistant 消息，usage 全为 0，stopReason=${stopReasons.join(",") || "?"}）`);
  }

  return {
    text: finalText || deltaText,
    usage: usage.turns > 0 ? usage : undefined,
    sawEvents,
    detail: parts.length ? parts.join("; ") : undefined,
  };
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

interface RunJudgeOnceOptions {
  prompt: string;
  cwd: string;
  withTools: boolean;
  model: string;
  thinking: string;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** One judge attempt against a specific model. Surfaces provider errors instead of swallowing them. */
async function runJudgeOnce(options: RunJudgeOnceOptions): Promise<JudgeResult> {
  const { prompt, cwd, withTools, model, thinking, command, timeoutMs, signal } = options;
  if (signal?.aborted) return { ok: false, error: "supervision operation invalidated", ms: 0 };
  const args = [
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    ...(withTools ? ["--tools", READONLY_TOOLS] : ["--no-tools"]),
    "--model", model,
    "--thinking", thinking,
    prompt,
  ];
  const started = Date.now();

  return await new Promise<JudgeResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Omit<JudgeResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, model, ms: Date.now() - started });
    };
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      const partial = parseJudgeOutput(stdout);
      finish({
        ok: false,
        error: `judge 超时 ${timeoutMs}ms${partial.detail ? `（${partial.detail}）` : ""}；已收到 ${stdout.length}B 输出`,
        text: partial.text,
        usage: partial.usage,
        detail: partial.detail,
        raw: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      });
    }, timeoutMs);
    const onAbort = () => {
      // This is our judge subprocess, never the main agent or its run signal.
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish({ ok: false, error: "supervision operation invalidated" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-120_000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-20_000); });
    child.on("error", (error) => finish({ ok: false, error: `judge 进程启动失败: ${String(error)}`, stderr: stderr.slice(-2000) }));
    child.on("close", (code) => {
      const output = parseJudgeOutput(stdout);
      const text = output.sawEvents ? output.text : stdout;
      if (code !== 0) {
        const stderrTail = stderr.trim().slice(-800);
        finish({
          ok: false,
          error: `judge 进程退出码 ${code}${output.detail ? `（${output.detail}）` : ""}${stderrTail ? `：${stderrTail}` : ""}`,
          text,
          usage: output.usage,
          detail: output.detail,
          raw: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        });
        return;
      }
      const parsed = parseJsonObject(text);
      if (!parsed) {
        finish({
          ok: false,
          error: output.detail
            ? `judge 未产出可用结果：${output.detail}`
            : `judge 输出不是 JSON：${text.trim().slice(-500) || "(空)"}`,
          text,
          usage: output.usage,
          detail: output.detail,
          raw: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        });
        return;
      }
      finish({ ok: true, json: parsed, text, usage: output.usage, detail: output.detail, raw: stdout.slice(-4000), stderr: stderr.slice(-1000) });
    });
  });
}

/**
 * Run the judge, and fail over to a backup model once if the primary attempt produced
 * no usable verdict (provider error, empty output, non-JSON, timeout, non-zero exit).
 */
async function runJudge(prompt: string, profile: Profile, cwd: string, withTools: boolean, timeoutOverrideMs?: number, signal?: AbortSignal): Promise<JudgeResult> {
  const command = profile.judgeCommand || DEFAULTS.judgeCommand;
  const primary = profile.judgeModel || DEFAULTS.judgeModel;
  const thinking = profile.judgeThinking || DEFAULTS.judgeThinking;
  const timeoutMs = timeoutOverrideMs ?? profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs;
  const failovers: string[] = [];

  const base = { prompt, cwd, withTools, command, timeoutMs, signal };
  const first = await runJudgeOnce({ ...base, model: primary, thinking });
  first.failovers = failovers;
  if (first.ok || signal?.aborted) return first;

  const failoverEnabled = profile.judgeFailover !== false;
  const fallback = failoverEnabled ? profile.judgeFailoverModel : undefined;
  if (!fallback || fallback === primary) return first;

  failovers.push(`${primary} → ${fallback}：主判官失败（${first.error ?? "未知原因"}）`);
  const second = await runJudgeOnce({
    ...base,
    model: fallback,
    thinking: profile.judgeFailoverThinking || thinking,
  });
  second.failovers = failovers;
  if (second.ok) return second;

  return {
    ...second,
    error: `主判官(${primary}) 失败：${first.error ?? "未知"} ｜ 备用判官(${fallback}) 失败：${second.error ?? "未知"}`,
  };
}
function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return typeof value === "object" && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
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

function buildBootstrapPrompt(profile: Profile, ctx: ExtensionContext, feedback: string): string {
  return `${BOOTSTRAP_MARKER}

根据当前 session 中用户的请求，推断一个简洁、可核验的监督终点。
监督目标是判断“是否到达用户认可的终点”，不是为每个任务生成一套复杂流程。

只从会话确定任务范围；不要混入同一仓库内其他 session 的任务。
仓库只用于核对会话明确提及的关键事实；只读工具最多建议 8 次，不扫描目录或默认读取计划。
信息不足时提出具体 open_questions，不要编造目标、文件、规则或授权。
${profile.goal?.trim() ? `用户固定目标：${profile.goal.trim()}` : ""}
${feedback ? `用户对上次候选的修改要求（必须满足）：\n${feedback}` : ""}
${profile.escalationAgent ? `已配置的可用升级诊断 agent：${profile.escalationAgent}；仅在会话或必要决策规则要求时采用，不强制每个任务调用。` : ""}

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

function buildEnforcePrompt(contract: Contract, ctx: ExtensionContext, lastText: string, iteration: number, _escalationAgent: string): string {
  return `${ENFORCE_MARKER}

你是终点核验者。根据已确认的契约、主 Agent 汇报和直接证据，判断是否真正完成。

## 已确认契约（目标、完成条件与必要限制不可由运行时偷偷改变）
${contractSummary(contract, true)}

${userNotesBlock(contract)}
## 主 Agent 最近汇报
${truncateMiddle(lastText || "(无)", 8000)}

## 客观证据
${gitInfo(ctx.cwd)}

核验序号：${iteration}

规则：
1. 逐项核验 completion_criteria。goal_achieved=true 必须每项有直接证据，且无未完成条件、证据冲突、规则违反或缺失记录；汇报篇幅、口头承诺、阶段检查点不算完成证据。
2. criteria_evidence 每项包含 criterion（原完成条件完整文本）和 evidence（对应文件/测试/提交/工具结果的具体证据）。重复项不能替代其他条件。无法验证就列入 unmet_conditions 并给出最小核验动作。
3. 已确认终点保持稳定。通常只更新 furthest_progress / next_steps；不要输出 mission / completion_criteria / boundaries 或其他约束的修改。只有用户目标改变、关键前提失效、或新证据确实动摇终点时，填写 contract_change，要求重新确认，不自行采用新目标。
4. human_needed 仅在权限、凭据、目标歧义等确实需要人处理且无独立可推进工作时为 true；遵守已确认的必要决策策略，但不额外强制调用默认升级 agent。goal_achieved 与 human_needed 不可同时为 true。
5. 一般继续时只报告最重要的未闭环条件和下一步。可安全自主处理的事项不制造人类阻塞。
6. compact_now 仅在检查点已持久化、压缩不会丢失后续必要信息时为 true；compact_focus 必须要求保留目标、全部完成条件、必要限制和进度。

严格输出 JSON：
{
  "goal_achieved": false,
  "human_needed": false,
  "reason": "一句话依据",
  "criteria_evidence": [{"criterion": "原完成条件完整文本", "evidence": "该条件的具体证据"}],
  "unmet_conditions": ["尚未闭环的完成条件；没有则 []"],
  "evidence_conflicts": ["证据矛盾；没有则 []"],
  "contract_change": "仅终点或边界确需重新确认时说明，否则空串",
  "next_step": "最小可执行核验或推进动作",
  "contract_updates": {"furthest_progress": "最新有证据的进度", "next_steps": ["下一步"]},
  "policy_violations": [],
  "records_missing": [],
  "compact_now": false,
  "compact_focus": ""
}`;
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
  let judging = false;
  let sessionMeta = { id: "", name: "", file: "" };
  let logCtx: { cwd: string; logFile?: string } = { cwd: process.cwd() };
  const usageTotals = emptyUsage();

  /** Accumulate and log token usage for one judge/compaction call. */
  function recordJudgeUsage(kind: string, result: JudgeResult): void {
    if (result.usage) addUsage(usageTotals, result.usage);
    usageTotals.calls += 1;
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
      stdoutTail: result.ok ? null : (result.raw ?? null),
      stderrTail: result.ok ? null : (result.stderr ?? null),
    });
  }

  function persistState(reason: string): void {
    hasExplicitState = true;
    try {
      pi.appendEntry(STATE_TYPE, {
        lifecycle, armed: lifecycle === "active", paused: lifecycle === "paused",
        iterations, judgeFailures, lastVerdict, reason, at: new Date().toISOString(),
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
    const marker = "===== 修改意见（留空提交=确认；Esc=放弃）=====";
    const base = [contractSummary(candidate), openQuestions.length ? `待澄清:\n${openQuestions.map(q => `- ${q}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
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
    const prompt = buildBootstrapPrompt(profile, ctx, feedback);
    const signal = operationController.signal;
    const first = await runJudge(prompt, profile, ctx.cwd, true, profile.bootstrapTimeoutMs ?? DEFAULTS.bootstrapTimeoutMs, signal);
    if (!isCurrent(generation)) return first;
    recordJudgeUsage("bootstrap", first);
    if (first.ok) return first;
    log({ event: "bootstrap-retry-no-tools", error: first.error, detail: first.detail, ms: first.ms });
    const second = await runJudge(`${prompt}\n本次无工具，只根据会话推断；不确定的写入 open_questions。`, profile, ctx.cwd, false,
      Math.min(profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs, 180_000), signal);
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
          persistContract();
          persistState("contract confirmed");
          log({ event: "contract", auto, contract });
          ctx.ui.notify("Supervisor：终点已确认，开始监督。", "info");
          return contract;
        }
        if (!answer.feedback) {
          ctx.ui.notify("Supervisor：已放弃新契约，原状态保持不变。", "info");
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
  function interpretVerdict(raw: Verdict, ctx: ExtensionContext): { verdict: Verdict; replan: boolean } {
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
      pauseTask(checked.replan ? "endpoint requires confirmation" : "human needed");
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
      const built = await ensureContract(ctx, profile);
      if (!built || lifecycle !== "active") return;
      return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
        content: buildContinuation({ iteration: iterations + 1, reason: "终点已确认", nextStep: built.next_steps[0] || "核验并推进完成条件", contract: built, showContract: true }) }] };
    }
    if (lifecycle !== "active" || !contract || judging || quotaWaiting) return;
    if (event.outcome === "aborted" || ctx.hasPendingMessages() || event.context?.pendingMessages?.length) return;
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
      const result = await runJudge(buildEnforcePrompt(contract, ctx, last || lastAssistantText, iterations + 1, profile.escalationAgent || DEFAULTS.escalationAgent),
        profile, ctx.cwd, profile.enforceReadTools === true, undefined, signal);
      if (!isCurrent(generation) || lifecycle !== "active") return;
      recordJudgeUsage("enforce", result);
      if (!result.ok || !result.json) {
        judgeFailures += 1;
        log({ event: "judge-failure", error: result.error, detail: result.detail, ms: result.ms });
        persistState("judge failure");
        if (judgeFailures >= (profile.maxJudgeFailures ?? DEFAULTS.maxJudgeFailures)) {
          pauseTask("judge failure limit");
          return stopBoundary("[Supervisor] 已暂停：判官连续失败，非目标达成。检查配置后 /supervisor resume。");
        }
        return { continue: true, entries: [{ type: "custom_message", customType: "pi-supervisor", display: true,
          content: buildContinuation({ iteration: iterations + 1, reason: "判定失败，不能认定完成", nextStep: contract.next_steps[0] || "核验未完成条件", contract }) }] };
      }
      judgeFailures = 0;
      iterations += 1;
      const { verdict, replan } = interpretVerdict(result.json as Verdict, ctx);
      log({ event: "verdict", iteration: iterations, verdict, ms: result.ms });
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
    description: "Supervisor: start | pause | resume | cancel | status（更多：details/replan/note/judge/history/usage/quota）",
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
        if (lifecycle !== "paused" || !contract) {
          ctx.ui.notify("Supervisor：没有可恢复的暂停任务；/supervisor start 建立新任务。", "warning");
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
        lastVerdict = undefined;
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
      if (sub === "judge") {
        if (!contract || (lifecycle !== "active" && lifecycle !== "paused")) { ctx.ui.notify("Supervisor：没有有效监督任务；请先 start。", "warning"); return; }
        if (!ctx.isIdle() || judging || quotaWaiting) { ctx.ui.notify("Supervisor：当前忙碌，稍后会自动判定。", "info"); return; }
        const generation = operationGeneration;
        const signal = operationController.signal;
        judging = true;
        const stopBeat = heartbeat(ctx, "正在手动核验", generation);
        try {
          const result = await runJudge(buildEnforcePrompt(contract, ctx, lastAssistantText, iterations + 1, profile.escalationAgent || DEFAULTS.escalationAgent),
            profile, ctx.cwd, profile.enforceReadTools === true, undefined, signal);
          if (!isCurrent(generation) || !contract || (lifecycle !== "active" && lifecycle !== "paused")) return;
          recordJudgeUsage("manual", result);
          if (!result.ok || !result.json) { ctx.ui.notify("Supervisor：手动判定失败，状态不变。", "warning"); return; }
          const wasActive = lifecycle === "active";
          const { verdict, replan } = interpretVerdict(result.json as Verdict, ctx);
          log({ event: "manual-judge", verdict, ms: result.ms });
          if (verdict.goal_achieved === true || verdict.human_needed === true) {
            const boundary = verdictStop(verdict, replan);
            for (const entry of boundary.entries || []) {
              if (entry.type === "custom_message") pi.sendMessage({ customType: "pi-supervisor-stop", content: entry.content, display: true }, { triggerTurn: false });
            }
          } else if (wasActive && lifecycle === "active" && !ctx.hasPendingMessages()) {
            pi.sendUserMessage(buildContinuation({ iteration: iterations + 1, reason: verdict.reason || "终点尚未验证", nextStep: verdict.next_step || contract!.next_steps[0] || "核验完成条件", contract: contract!,
              unmet: asStringArray(verdict.unmet_conditions), violations: asStringArray(verdict.policy_violations), missingRecords: asStringArray(verdict.records_missing) }));
          } else ctx.ui.notify("Supervisor：已判定，仍保持暂停；未发送续跑指令。", "info");
        } finally { if (isCurrent(generation)) judging = false; stopBeat(); }
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
        sessionUsage.calls = logged.length;
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
        ctx.ui.notify(contract ? contractSummary(contract, true) : `Supervisor：${stateLabel()}，没有有效契约。`, "info");
        return;
      }
      if (sub !== "status") {
        ctx.ui.notify("用法：/supervisor start | pause | resume | cancel | status\n更多：details/replan/note/judge/history/usage/quota", "info");
        return;
      }
      const next = lifecycle === "active" ? "pause / cancel" : lifecycle === "paused" && contract ? "resume / cancel" : lifecycle === "drafting" ? "确认终点 / cancel" : "start";
      const status = [
        `Supervisor · ${stateLabel()}`,
        contract ? `终点：${truncateMiddle(contract.mission, 160)}` : "当前无有效契约。",
        lastVerdict?.goal_achieved === false ? `未闭环：${truncateMiddle(asStringArray(lastVerdict.unmet_conditions).join("；") || lastVerdict.reason || "尚待核验", 180)}` : "",
        contract && lastVerdict?.next_step ? `下一步：${truncateMiddle(lastVerdict.next_step, 180)}` : "",
        `操作：/supervisor ${next}`,
        "详情：details · 诊断：history / usage / quota",
      ].filter(Boolean).join("\n");
      ctx.ui.notify(status, "info");

    },
  });
}
