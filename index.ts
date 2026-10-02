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

interface Verdict {
  goal_achieved?: boolean;
  human_needed?: boolean;
  reason?: string;
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
  return {
    version: 1,
    mission: typeof raw.mission === "string" && raw.mission.trim() ? raw.mission.trim() : "(未推断出目标)",
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
  const mergedNotes = asStringArray(updates.user_notes);
  return {
    ...contract,
    mission: typeof updates.mission === "string" && updates.mission.trim() ? updates.mission.trim() : contract.mission,
    furthest_progress: typeof updates.furthest_progress === "string" && updates.furthest_progress.trim()
      ? updates.furthest_progress.trim() : contract.furthest_progress,
    next_steps: updates.next_steps ? asStringArray(updates.next_steps) : contract.next_steps,
    decision_policy: updates.decision_policy ? asStringArray(updates.decision_policy) : contract.decision_policy,
    record_policy: updates.record_policy ? asStringArray(updates.record_policy) : contract.record_policy,
    stop_conditions: updates.stop_conditions ? asStringArray(updates.stop_conditions) : contract.stop_conditions,
    autonomy_rules: updates.autonomy_rules ? asStringArray(updates.autonomy_rules) : contract.autonomy_rules,
    user_notes: mergedNotes.length ? [...contract.user_notes, ...mergedNotes] : contract.user_notes,
    updated_at: new Date().toISOString(),
  };
}

function contractSummary(contract: Contract): string {
  const list = (items: string[], max = 8) =>
    items.length ? items.slice(0, max).map((item, i) => `  ${i + 1}. ${item}`).join("\n") : "  (无)";
  return [
    contract.provisional
      ? "⚠ 临时契约（判官推断失败时生成）：只在 stop_conditions 明确满足时判达成，其余继续推进；可用 /supervisor replan 重建。"
      : "",
    `目标: ${truncateMiddle(contract.mission, 600)}`,
    `最远进度: ${truncateMiddle(contract.furthest_progress, 800)}`,
    `后续步骤:\n${list(contract.next_steps)}`,
    `决策升级(调用决策子agent):\n${list(contract.decision_policy, 5)}`,
    `记录规则:\n${list(contract.record_policy, 5)}`,
    `停止条件:\n${list(contract.stop_conditions, 5)}`,
    `无人值守规则:\n${list(contract.autonomy_rules, 5)}`,
    contract.user_notes.length ? `用户补充说明:\n${list(contract.user_notes, 5)}` : "",
  ].filter(Boolean).join("\n\n");
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
}

/** One judge attempt against a specific model. Surfaces provider errors instead of swallowing them. */
async function runJudgeOnce(options: RunJudgeOnceOptions): Promise<JudgeResult> {
  const { prompt, cwd, withTools, model, thinking, command, timeoutMs } = options;
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
async function runJudge(prompt: string, profile: Profile, cwd: string, withTools: boolean, timeoutOverrideMs?: number): Promise<JudgeResult> {
  const command = profile.judgeCommand || DEFAULTS.judgeCommand;
  const primary = profile.judgeModel || DEFAULTS.judgeModel;
  const thinking = profile.judgeThinking || DEFAULTS.judgeThinking;
  const timeoutMs = timeoutOverrideMs ?? profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs;
  const failovers: string[] = [];

  const base = { prompt, cwd, withTools, command, timeoutMs };
  const first = await runJudgeOnce({ ...base, model: primary, thinking });
  first.failovers = failovers;
  if (first.ok) return first;

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
  const fixedGoal = profile.goal?.trim()
    ? `\n用户已给出固定目标（以此为准）：${profile.goal.trim()}\n`
    : "";
  const feedbackBlock = feedback
    ? `\n## 用户对上一次推断的修改要求（必须满足）\n${feedback}\n`
    : "";
  const escalation = profile.escalationAgent || DEFAULTS.escalationAgent;
  const escalationBlock = `\n## 用户指定的决策子agent（硬约束）\n决策升级必须先调用 \`${escalation}\`（升级诊断）：\n- 遇到证据冲突/连续失败/架构或授权判断/阻塞时，主 Agent 先带目标、关键证据、已尝试方案与阻塞点去咨询它；\n- 它能给出方案 → 按其方案继续执行；\n- **只有它明确判定“必须人类介入”时**，才允许向用户提出介入请求。\ncontract 的 decision_policy 必须体现这套升级顺序；stop_conditions 中“必须停下等人类”必须限定为“升级诊断 agent 也判定必须人类介入”。\n`;
  return `${BOOTSTRAP_MARKER}

你是长任务无人值守执行的"监督者"。请**主要根据当前 session 的内容**推断本次任务的监督契约：用户最初请求、最近的对话上下文、主 Agent 已完成的汇报。

仓库信息只是辅助验证，不是主要依据：
- 只有当 session 中明确提到某个文件/路径/计划/文档，或需要验证 session 里的关键事实时，才用只读工具（read/grep/find/ls）读取**少量**文件，建议不超过 8 次调用；
- **不要**扫描仓库、**不要**枚举目录、**不要**默认读 AGENTS.md/docs/计划、**不要**做项目分析；
- session 信息不足时，把它写进 open_questions 并把 confidence 标低，而不是靠扫描仓库补全。

契约只描述**当前 session** 的任务。同一 cwd 下可能存在其他 session 的完全不同的任务，不得混入或推测当前 session 之外的范围。
${fixedGoal}${feedbackBlock}${escalationBlock}
${gitInfo(ctx.cwd)}

${sessionExcerpt(ctx)}

## 需要推断的内容（严格 JSON 输出，不要输出其它文字）
{
  "mission": "当前 session 要达成的最终目标的可验证定义（以 session 里的用户请求为准，精确、可判定）",
  "furthest_progress": "根据 session 汇报判断已经推进到哪一步；列出证据锚点（提交/文件/测试）；session 没说的不要编造",
  "next_steps": ["从当前状态到目标的有序、最小可执行步骤；每步应可独立实现/验证/提交"],
  "decision_policy": ["哪些情况必须先调用决策子agent（升级诊断）配合决策：触发条件/调用哪个/需要提供什么/结论记录到哪里。必须把用户指定的 ${escalation} 排在第一位，并写明“它给方案就按方案继续、它判必须人类介入才停下”。"],
  "record_policy": ["哪些问题必须记录以及记录到哪个文件/登记册；以 session 中提到过的文件/登记册为准，session 没提就写通用要求"],
  "stop_conditions": ["什么情况算目标达成可以停；什么情况必须停下等人类——必须限定为“升级诊断 agent 也判定必须人类介入”的情形（凭据/环境准入/职责外授权/目标歧义等）"],
  "autonomy_rules": ["无人值守纪律：不停下汇报、不等确认、单元闭环后直接进入下一个、决策按策略执行并记录等"],
  "confidence": "high|medium|low（仅凭 session 能否确定 mission/下一步）",
  "open_questions": ["需要用户补充才能提高判定质量的问题；没有则 []"],
  "confirmed_by_user": false
}

要求：
- mission / furthest_progress / next_steps 必须能由 session 内容（必要时加少量验证）判定；不要从仓库推断 session 之外的任务。
- decision_policy 与 record_policy 优先采用 session 中出现的名称与路径；session 未提及时写通用策略，不要凭空编造文件路径。
- 只有在确实缺少关键信息时才列 open_questions，并相应降低 confidence。`;
}

function buildEnforcePrompt(contract: Contract, ctx: ExtensionContext, lastText: string, iteration: number, escalationAgent: string): string {
  const usage = (() => {
    try {
      const u = ctx.getContextUsage();
      if (!u) return "unknown";
      return `tokens=${u.tokens ?? "?"} / window=${u.contextWindow} (${u.percent ?? "?"}%)`;
    } catch {
      return "unknown";
    }
  })();
  return `${ENFORCE_MARKER}

你是长任务无人值守执行的"监督者"。主 Agent 刚刚停止，请按已确认的监督契约判断：现在是否允许它停下？

## 监督契约（用户已确认）
${contract.provisional ? "\n⚠ 这是临时契约（判官推断失败时生成）：只允许在 stop_conditions 明确满足时判 goal_achieved；其余情况继续推进，并尽量补齐 next_steps/furthest_progress。\n" : ""}
${contractSummary(contract)}

${userNotesBlock(contract)}
## 主 Agent 本轮结束时的汇报
${truncateMiddle(lastText || "(无)", 8000)}

## 客观证据
${gitInfo(ctx.cwd)}

## 运行状态
- cwd：${ctx.cwd}
- 连续判定序号：${iteration}
- 上下文占用：${usage}

## 判定要求
1. 只有存在直接证据表明 mission 达成（或 stop_conditions 中的达成条件满足）才允许 goal_achieved=true。阶段性汇报（"本轮完成 N 个单元"、"干净检查点"、"下一单元已备好"）不算达成。
2. 契约要求调用决策子agent的情况出现却没有调用、或契约要求登记的问题没有登记 → 在 policy_violations / records_missing 中指出，并让主 Agent 先补齐。
3. **人类介入门槛（升级诊断优先）**：human_needed=true 必须同时满足：
   a) 主 Agent 已经调用升级诊断子agent ${escalationAgent}（在本轮汇报中给出它的结论）；
   b) ${escalationAgent} 明确判定必须人类介入（它无法给出可执行方案，且属于外部凭据/环境准入/职责外授权/目标歧义）；
   c) 说明具体需要人类提供什么；
   d) **当前不存在任何可自主推进的工作**。如果还有自主候选单元，即使存在待人类裁决的事项，也应 human_needed=false：让主 Agent 把待决项登记/挂起后跳过，继续独立自主单元，只在确实无事可做时才停。
   若不满足以上任一条：**不要**判 human_needed；把它写进 policy_violations（“未先调用升级诊断即请求人类介入”或“仍有自主工作就要求停下”），并把 next_step 写成：“先调用 ${escalationAgent}，提供目标、关键证据、已尝试方案与阻塞点；按其结论执行；若仍有自主工作，登记待决项后继续；只有它明确判定必须人类介入且无自主工作可做时，再在汇报里写明它的结论并停下等人”。
   契约已由用户确认，不要把契约内部尚不确定、但可安全按默认继续的事项当作 human_needed。
4. 根据本轮证据更新 furthest_progress（必须）与 next_steps（如有变化）放入 contract_updates；不要改变 mission/stop_conditions，除非证据表明用户改变了目标。
5. 压缩判断：只有当前检查点已持久化（进度/计划/提交可恢复）且后续不需要旧对话细节时才 compact_now=true，并在 compact_focus 写明摘要必须保留什么；不要仅因 token 占比高就要求压缩。
6. 你以提供的证据为准；若某个关键事实必须核对仓库文件才能判定，不要猜测，把它写成 next_step，让主 Agent 先去核对（并给出具体文件路径）。

## 输出（严格 JSON，不要输出其它文字）
{
  "goal_achieved": false,
  "human_needed": false,
  "reason": "一句话判定依据",
  "next_step": "未达成时主 Agent 立刻要做的下一步",
  "contract_updates": {"furthest_progress": "...", "next_steps": ["..."]},
  "policy_violations": ["未按决策契约处理的情况，例如未先调用升级诊断就请求人类介入（没有则 []）"],
  "records_missing": ["应登记而未登记的问题（没有则 []）"],
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
  let armed: boolean | undefined; // undefined = not decided yet for this session
  let contract: Contract | undefined;
  let lastVerdict: Verdict | undefined;
  let judging = false;
  let sessionMeta = { id: "", name: "", file: "" };
  let logCtx: { cwd: string; logFile?: string } = { cwd: process.cwd() };
  let pausedByStop = false;
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

  function persistState(stateArmed: boolean, statePaused: boolean, reason: string): void {
    try {
      pi.appendEntry(STATE_TYPE, { armed: stateArmed, paused: statePaused, reason, at: new Date().toISOString() });
    } catch {
      // best effort
    }
  }

  function captureSessionMeta(ctx: ExtensionContext): void {
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
    captureSessionMeta(ctx);
    try {
      const entries = ctx.sessionManager.getEntries();
      const last = [...entries].reverse().find(
        (entry) => entry.type === "custom" &&
          [CONTRACT_TYPE, LEGACY_CONTRACT_TYPE].includes((entry as { customType?: string }).customType ?? ""),
      );
      if (last) {
        contract = normalizeContract(((last as { data?: Record<string, unknown> }).data || {}) as Record<string, unknown>);
        debugLog(`contract restored from session: ${contract.mission.slice(0, 80)}`);
      }
      const lastState = [...entries].reverse().find(
        (entry) => entry.type === "custom" &&
          [STATE_TYPE, LEGACY_STATE_TYPE].includes((entry as { customType?: string }).customType ?? ""),
      );
      if (lastState) {
        const data = ((lastState as { data?: Record<string, unknown> }).data || {}) as { armed?: boolean; paused?: boolean; reason?: string };
        if (data.paused === true) {
          pausedByStop = true;
          armed = false; // keep the session paused across restarts until /supervisor resume
          debugLog(`session restored as paused (${data.reason || "?"})`);
        } else if (data.armed === true) {
          armed = true; // session was explicitly armed (e.g. /supervisor start)
          debugLog(`session restored as armed (${data.reason || "?"})`);
        } else if (data.armed === false) {
          armed = false; // session was explicitly disarmed
          debugLog(`session restored as disarmed (${data.reason || "?"})`);
        }
      }
    } catch (error) {
      debugLog(`contract restore failed: ${String(error)}`);
    }
  });

  pi.on("session_info_changed", (_event, ctx) => {
    captureSessionMeta(ctx);
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") {
      iterations = 0;
      judgeFailures = 0;
      // A human typing means they took over; drop the outage counters.
      resetQuotaState();
    }
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

  /** TUI/RPC review: editor pre-filled with the contract + a free-form feedback section. */
  async function promptContract(
    ctx: ExtensionContext,
    candidate: Contract,
    openQuestions: string[],
    useEditor: boolean,
  ): Promise<{ accepted: boolean; feedback?: string }> {
    const marker = "===== 修改意见（在下方输入 = 按你的意见重新推断；留空直接提交 = 确认并立即开始）=====";
    const base = [
      contractSummary(candidate),
      openQuestions.length ? `需要你补充的问题:\n${openQuestions.map((q) => `- ${q}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    const isConfirmWord = (text: string) => /^(确认|确定|继续|开始|开始吧|好的|好|可以|ok|okay|yes|y|go)$/i.test(text.trim());
    if (useEditor) {
      try {
        if (ctx.hasUI && typeof ctx.ui.editor === "function") {
          const prefill = `${base}\n\n${marker}\n`;
          const edited = await ctx.ui.editor("确认监督契约（直接提交=立即开始；在末尾写意见=重新推断）", prefill);
          if (edited === undefined) return { accepted: false };
          const pos = edited.indexOf(marker);
          if (pos >= 0) {
            const feedback = edited.slice(pos + marker.length).trim();
            if (!feedback) {
              const body = edited.slice(0, pos).trim();
              if (body && body !== base.trim()) {
                return { accepted: false, feedback: `请按以下契约文本重新生成（保持 JSON 结构不变）：\n${body}` };
              }
              return { accepted: true };
            }
            if (isConfirmWord(feedback)) return { accepted: true };
            return { accepted: false, feedback };
          }
          if (!edited.trim() || edited.trim() === prefill.trim()) return { accepted: true };
          if (isConfirmWord(edited)) return { accepted: true };
          return { accepted: false, feedback: edited.trim() };
        }
      } catch (error) {
        debugLog(`editor failed, falling back to confirm: ${String(error)}`);
      }
    }
    // Round 2+: show the updated contract in a confirm dialog instead of asking the user to edit again.
    const ok = await ctx.ui.confirm("确认更新后的监督契约", truncateMiddle(base, 3000));
    if (ok) return { accepted: true };
    const feedback = await ctx.ui.input("继续补充/修改意见（将再次重新推断；留空则取消）");
    if (!feedback || !feedback.trim()) return { accepted: false };
    if (isConfirmWord(feedback)) return { accepted: true };
    return { accepted: false, feedback: feedback.trim() };
  }

  async function runBootstrapJudge(profile: Profile, ctx: ExtensionContext, feedback: string): Promise<JudgeResult> {
    const prompt = buildBootstrapPrompt(profile, ctx, feedback);
    const first = await runJudge(prompt, profile, ctx.cwd, true, profile.bootstrapTimeoutMs ?? DEFAULTS.bootstrapTimeoutMs);
    recordJudgeUsage("bootstrap", first);
    if (first.ok) return first;
    log({ event: "bootstrap-retry-no-tools", error: first.error, detail: first.detail, model: first.model, failovers: first.failovers, ms: first.ms, stdoutTail: first.raw, stderrTail: first.stderr });
    try { ctx.ui.notify("pi-supervisor: 带工具推断超时/失败，改为无工具快速重试…", "warning"); } catch { /* noop */ }
    const noToolsPrompt = `${prompt}\n\n注意：本次没有工具，只能依据上方信息推断；不确定的内容写入 open_questions，禁止编造文件路径或 agent 名称。`;
    const second = await runJudge(
      noToolsPrompt,
      profile,
      ctx.cwd,
      false,
      Math.min(profile.judgeTimeoutMs ?? DEFAULTS.judgeTimeoutMs, 180_000),
    );
    recordJudgeUsage("bootstrap-retry", second);
    return second.ok ? second : first;
  }

  async function ensureContract(ctx: ExtensionContext, profile: Profile): Promise<Contract | undefined> {
    if (contract) return contract;
    let feedback = "";
    const accumulatedNotes: string[] = [];
    const timeoutSec = Math.round((profile.bootstrapTimeoutMs ?? DEFAULTS.bootstrapTimeoutMs) / 1000);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        try { ctx.ui.notify(`pi-supervisor: 已收到你的意见，正在据此重新推断契约（第 ${attempt + 1} 次）…`, "info"); } catch { /* noop */ }
      }
      const model = profile.judgeModel || DEFAULTS.judgeModel;
      try { ctx.ui.notify(`pi-supervisor: 开始推断任务契约（判官 ${model}，带只读工具，最长约 ${timeoutSec}s）`, "info"); } catch { /* noop */ }
      log({ event: "bootstrap-start", attempt: attempt + 1, model });
      const stopBeat = startHeartbeat(ctx, `判官推断任务契约中（最长约 ${timeoutSec}s）`);
      let result: JudgeResult;
      try {
        result = await runBootstrapJudge(profile, ctx, feedback);
      } finally {
        stopBeat();
      }
      const json = result.json;
      if (!result.ok || !json) {
        judgeFailures += 1;
        log({ event: "bootstrap-failure", error: result.error, detail: result.detail, model: result.model, failovers: result.failovers, ms: result.ms, stdoutTail: result.raw, stderrTail: result.stderr });
        const provisional: Contract = normalizeContract({
          mission: "继续推进当前任务：读取进度/计划文档，完成所有已批准且可安全执行的单元。",
          furthest_progress: "(判官不可用；以仓库与进度文档为准自行确认)",
          next_steps: [
            "读取进度/计划/矩阵文档，确认当前状态与下一个未闭环单元",
            "完成该单元（实现/验证/审查/提交）后进入下一个",
          ],
          decision_policy: ["遇到证据冲突、连续失败或无回退保障的决策时，调用项目升级诊断 agent，并记录结论"],
          record_policy: ["按仓库现有约定登记问题与残差，不新建平行台账"],
          stop_conditions: ["所有已批准且可安全执行的单元完成且残差已登记", "出现必须人类介入的凭据/环境/授权阻塞"],
          autonomy_rules: ["不停下汇报、不等确认，单元闭环后直接进入下一个"],
          provisional: true,
          confirmed_by_user: false,
        });
        contract = provisional;
        persistContract();
        log({ event: "contract-provisional", error: result.error, contract: provisional });
        ctx.ui.notify("pi-supervisor: 契约推断失败，先用临时契约继续推进（/supervisor replan 可重建）", "warning");
        return contract;
      }
      const candidate = normalizeContract(json);
      const openQuestions = asStringArray(json.open_questions, 5);
      const auto = profile.autoConfirm === true || pi.getFlag("supervise") === true || !ctx.hasUI;
      if (auto) {
        contract = candidate;
        persistContract();
        log({ event: "contract", auto: true, confidence: json.confidence, contract });
        if (ctx.hasUI) ctx.ui.notify("pi-supervisor: 契约已自动接受（--supervise），立即开始执行", "info");
        return contract;
      }
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-supervisor: 已推断任务契约（confidence=${String(json.confidence ?? "?")}），请确认`, "info");
      }
      const { accepted, feedback: userFeedback } = await promptContract(ctx, candidate, openQuestions, attempt === 0);
      if (accepted) {
        if (accumulatedNotes.length) candidate.user_notes = [...candidate.user_notes, ...accumulatedNotes];
        candidate.confirmed_by_user = true;
        contract = candidate;
        persistContract();
        log({ event: "contract", auto: false, confidence: json.confidence, contract });
        ctx.ui.notify("pi-supervisor: 契约已确认，立即开始执行", "info");
        return contract;
      }
      if (!userFeedback) {
        ctx.ui.notify("pi-supervisor: 未确认契约，本会话保持未启用", "warning");
        return undefined;
      }
      log({ event: "contract-feedback", attempt: attempt + 1, feedback: userFeedback });
      accumulatedNotes.push(userFeedback);
      feedback = userFeedback;
    }
    ctx.ui.notify("pi-supervisor: 多次未确认契约，放弃启用", "warning");
    return undefined;
  }

  /** Persist a visible "why we are allowed to stop" message in the transcript. */
  function stopBoundary(content: string) {
    return {
      entries: [{ type: "custom_message" as const, customType: "pi-supervisor-stop", content, display: true }],
    };
  }

  function buildContinuation(options: {
    iteration: number;
    reason: string;
    nextStep: string;
    contract: Contract;
    violations?: string[];
    missingRecords?: string[];
    showContract?: boolean;
    extraNote?: string;
    escalationAgent?: string;
  }): string {
    const { iteration, reason, nextStep, contract: current, violations = [], missingRecords = [], showContract, extraNote, escalationAgent } = options;
    const escalation = escalationAgent || DEFAULTS.escalationAgent;
    return [
      `[pi-supervisor] 第 ${iteration} 次判定：目标未达成，继续推进。`,
      showContract ? `已建立监督契约（本会话有效，后续按此执行）：\n${contractSummary(current)}\n` : "",
      reason ? `判定依据：${reason}` : "",
      extraNote || "",
      violations.length ? `先按契约补齐（未按决策契约处理）：\n${violations.map((v) => `- ${v}`).join("\n")}` : "",
      missingRecords.length ? `先按契约登记（应记录未记录）：\n${missingRecords.map((v) => `- ${v}`).join("\n")}` : "",
      nextStep ? `下一步：${nextStep}` : "下一步：按契约 next_steps 继续执行。",
      `决策规则：遇到需要确认/证据冲突/阻塞时，先调用 ${escalation}（升级诊断）决策；它能给方案就按其方案继续；只有它明确判定必须人类介入时才停止等待。`,
      "不要输出收尾汇报、不要等待确认；完成当前单元后直接进入下一个。只有契约 stop_conditions 满足或出现升级诊断确认必须人类介入的硬阻塞时才停止。",
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
    log({ event: "quota-giveup", reason, rule: quotaState.lastRule || null, attempts: quotaState.attempts, waitedMs: quotaState.waitedMs });
    const detail = `已等待 ${formatDuration(quotaState.waitedMs)}，探测 ${quotaState.attempts} 次`;
    resetQuotaState();
    try { ctx.ui.notify(`pi-supervisor: 放弃等待额度恢复 — ${reason}`, "error"); } catch { /* noop */ }
    return stopBoundary([
      "[pi-supervisor] ⏹ 允许停止 — 放弃等待额度恢复",
      `原因：${reason}（${detail}）`,
      "说明：不是目标达成。额度恢复后用 /supervisor resume 继续。",
    ].join("\n"));
  }

  /**
   * The main agent's run ended in a provider error. Only a metered-allowance outage is
   * worth waiting out; every other error keeps the historical hands-off behavior so we
   * never fight an abort or a real failure.
   *
   * Waits ONE interval inside this handler, then asks pi to re-issue the same request.
   * The failed attempt is omitted from the projection with a `context_edit` draft —
   * exactly what pi's own auto-retry does — so the replayed request is byte-identical
   * to the pre-outage one and a 10-hour outage adds zero tokens to the context.
   */
  async function handleQuotaError(
    ctx: ExtensionContext,
    profile: Profile,
    event: AgentBeforeSettleEvent,
  ): Promise<AgentBeforeSettleEventResult | undefined> {
    const quotaWait = resolveQuotaWait(profile);
    if (!quotaWait.enabled) return;

    const classification = classifyStopError(lastErrorMessage, {
      extraPatterns: quotaWait.extraPatterns,
      ignorePatterns: quotaWait.ignorePatterns,
    });
    const errorText = truncateMiddle(lastErrorMessage ?? "(无错误文本)", 400);
    const stopFile = resolvePath(profile.stopFile || DEFAULTS.stopFile, ctx.cwd);

    if (classification.kind === "permanent") {
      log({ event: "quota-permanent", rule: classification.rule ?? null, error: lastErrorMessage });
      if (!quotaWait.permanentAsHumanNeeded) return;
      pausedByStop = true;
      armed = false;
      persistState(false, true, `permanent-error(${classification.rule ?? "?"}): ${errorText}`);
      resetQuotaState();
      try { ctx.ui.notify(`pi-supervisor: 主模型错误需人类处理（${classification.rule}）— ${errorText}`, "error"); } catch { /* noop */ }
      return stopBoundary([
        "[pi-supervisor] ⛔ 允许停止 — 主模型报错且等待无用（需要人类处理）",
        `匹配规则：${classification.rule ?? "?"}`,
        `错误：${errorText}`,
        "说明：这不是额度/配额耗尽，重试不会自愈（充值、重登、区域、模型或工作区配置问题）。",
        "supervisor 已自动暂停；处理完后用 /supervisor resume 恢复。",
      ].join("\n"));
    }

    // Transient or unrecognized: pi's built-in auto-retry owns these. Do not interfere.
    if (classification.kind !== "quota") return;

    if (stopFile && fs.existsSync(stopFile)) {
      log({ event: "quota-aborted", reason: "stop-file", stopFile, attempts: quotaState.attempts, waitedMs: quotaState.waitedMs });
      resetQuotaState();
      return stopBoundary(`[pi-supervisor] ⏹ 停止等待额度 — 检测到 STOP 文件\n路径：${stopFile}\n说明：人工软停止，不代表目标达成。`);
    }

    if (quotaState.attempts > 0) {
      if (quotaWait.maxAttempts > 0 && quotaState.attempts >= quotaWait.maxAttempts) {
        return quotaGiveUp(ctx, `已达最大探测次数 ${quotaWait.maxAttempts}`);
      }
      const maxWaitMs = quotaWait.maxWaitMinutes * 60_000;
      if (maxWaitMs > 0 && quotaState.waitedMs >= maxWaitMs) {
        return quotaGiveUp(ctx, `已超出最长等待 ${quotaWait.maxWaitMinutes} 分钟`);
      }
    }

    if (quotaState.attempts === 0) {
      quotaState.startedAt = Date.now();
      quotaState.lastRule = classification.rule ?? "";
      log({
        event: "quota-detected",
        rule: classification.rule ?? null,
        error: lastErrorMessage,
        intervalMs: quotaWait.intervalMs,
        maxWaitMinutes: quotaWait.maxWaitMinutes,
        maxAttempts: quotaWait.maxAttempts,
      });
      try {
        ctx.ui.notify(
          `pi-supervisor: 主模型额度已用尽，进入等待重试（每 ${formatDuration(quotaWait.intervalMs)} 探测一次${quotaWait.maxWaitMinutes > 0 ? `，上限 ${quotaWait.maxWaitMinutes} 分钟` : "，无上限"}；Esc 或 STOP 文件可中断）`,
          "warning",
        );
      } catch { /* noop */ }
    }
    quotaState.lastError = lastErrorMessage ?? quotaState.lastError;

    quotaState.attempts += 1;
    const attempt = quotaState.attempts;
    const deadline = Date.now() + quotaWait.intervalMs;
    const sleepStart = Date.now();
    log({ event: "quota-probe", attempt, intervalMs: quotaWait.intervalMs, waitedMs: quotaState.waitedMs, rule: classification.rule ?? null });
    persistQuotaState("waiting");

    quotaWaiting = true;
    const stopBeat = startQuotaCountdown(ctx, deadline, attempt, () => quotaState.waitedMs + (Date.now() - sleepStart));
    let outcome: SleepOutcome;
    try {
      outcome = await sleepUntil(deadline, ctx.signal, () => Boolean(stopFile && fs.existsSync(stopFile)));
    } finally {
      stopBeat();
      quotaWaiting = false;
      quotaState.waitedMs += Date.now() - sleepStart;
      try { if (ctx.hasUI) ctx.ui.setStatus("supervisor", undefined); } catch { /* noop */ }
    }

    if (outcome !== "done") {
      const reason = outcome === "signal" ? "user-abort" : "stop-file";
      log({ event: "quota-aborted", reason, attempt, waitedMs: quotaState.waitedMs });
      resetQuotaState();
      try { ctx.ui.notify(`pi-supervisor: 已取消额度等待（${reason === "user-abort" ? "Esc/abort" : "STOP 文件"}）`, "info"); } catch { /* noop */ }
      if (outcome === "stop-file") {
        return stopBoundary("[pi-supervisor] ⏹ 停止等待额度 — 检测到 STOP 文件\n说明：人工软停止，不代表目标达成。");
      }
      return; // the user took over; let pi settle
    }

    const targetId = findErroredEntryId(event, ctx);
    if (targetId) {
      // Drops the empty errored assistant turn from the model context, which both keeps
      // the replay clean and makes the boundary continuable (finalRole is no longer assistant).
      return { continue: true, entries: [{ type: "context_edit", targetId, replacement: null }] };
    }
    // Nothing to omit (already omitted, or not persisted yet). A short custom message still
    // makes the context runnable; it costs one line.
    return {
      continue: true,
      entries: [{
        type: "custom_message",
        customType: "pi-supervisor",
        display: true,
        content: `[pi-supervisor] 额度等待第 ${attempt} 次探测：请从中断处直接继续，不要复述或回应本条消息。`,
      }],
    };
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    const cwd = ctx.cwd; // capture: ctx can go stale inside deferred callbacks
    const profile = resolveProfile(ctx.cwd);
    captureSessionMeta(ctx);
    logCtx = { cwd, logFile: profile.logFile };
    const canHotCompact = ctx.mode === "tui" || ctx.mode === "rpc";
    if (pi.getFlag("supervise") === true) {
      // An explicit --supervise launch always wins over a persisted off/paused state,
      // but it does not rewrite the persisted state (plain restarts keep it).
      armed = true;
      pausedByStop = false;
    } else if (armed === undefined) {
      armed = profile.enabled === true;
    }
    debugLog(`settle cwd=${cwd} mode=${ctx.mode} armed=${armed} contract=${contract ? "yes" : "no"} outcome=${event.outcome} pending=${ctx.hasPendingMessages()}`);
    if (!armed || judging || quotaWaiting) return;
    if (ctx.hasPendingMessages() || (event.context.pendingMessages?.length ?? 0) > 0) return; // pi will continue anyway

    if (event.outcome !== "completed") {
      // User abort: never fight it. Provider error: only a metered-allowance outage is
      // worth waiting out — every other error keeps the historical hands-off behavior.
      if (event.outcome === "error") return await handleQuotaError(ctx, profile, event);
      return;
    }

    // A completed turn after an outage means the allowance came back.
    if (quotaState.attempts > 0) {
      log({ event: "quota-recovered", attempts: quotaState.attempts, waitedMs: quotaState.waitedMs, rule: quotaState.lastRule || null });
      try { ctx.ui.notify(`pi-supervisor: 🔋 额度已恢复（等待 ${formatDuration(quotaState.waitedMs)}，探测 ${quotaState.attempts} 次），继续任务`, "info"); } catch { /* noop */ }
      persistQuotaState("recovered");
      resetQuotaState();
    }

    const stopFile = resolvePath(profile.stopFile || DEFAULTS.stopFile, cwd);
    if (stopFile && fs.existsSync(stopFile)) {
      ctx.ui.notify(`pi-supervisor: 检测到 ${stopFile}，监督者让出`, "info");
      log({ event: "stopped", reason: "stop-file", stopFile });
      return stopBoundary(`[pi-supervisor] ⏹ 允许停止 — 检测到 STOP 文件\n路径：${stopFile}\n说明：这是人工软停止开关，不代表目标达成。`);
    }

    const maxIterations = profile.maxIterations ?? DEFAULTS.maxIterations;
    if (iterations >= maxIterations) {
      ctx.ui.notify(`pi-supervisor: 已达最大续跑次数 ${maxIterations}，交还控制`, "warning");
      log({ event: "max-iterations", iterations });
      return stopBoundary(`[pi-supervisor] ⏹ 允许停止 — 达到最大续跑次数 ${maxIterations}\n说明：不是目标达成。需要继续时请发消息，或调大 config 里的 maxIterations。`);
    }

    judging = true;
    try {
      // ---- bootstrap: infer + confirm contract, then start the task immediately
      if (!contract) {
        contract = await ensureContract(ctx, profile);
        if (!contract) return;
        iterations += 1;
        const firstStep = contract.next_steps[0] || "读取进度/计划文档确认当前状态，然后按 mission 继续下一个未闭环单元";
        log({ event: "bootstrap-continue", iteration: iterations, firstStep });
        return {
          continue: true,
          entries: [{
            type: "custom_message",
            customType: "pi-supervisor",
            display: true,
            content: buildContinuation({
              escalationAgent: profile.escalationAgent || DEFAULTS.escalationAgent,
              iteration: iterations,
              reason: "监督契约已确认，立即开始执行。",
              nextStep: firstStep,
              contract,
              showContract: true,
            }),
          }],
        };
      }

      const lastText = lastAssistantText || (() => {
        try {
          const messages = event.context.contextMessages || [];
          const last = [...messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
          return messageText(last);
        } catch { return ""; }
      })();

      log({ event: "enforce-start", iteration: iterations + 1, contractUpdatedAt: contract.updated_at });
      const stopBeat = startHeartbeat(ctx, "监督模型判定中");
      let result: JudgeResult;
      try {
        result = await runJudge(
          buildEnforcePrompt(contract, ctx, lastText, iterations + 1, profile.escalationAgent || DEFAULTS.escalationAgent),
          profile,
          cwd,
          profile.enforceReadTools === true,
        );
      } finally {
        stopBeat();
      }
      recordJudgeUsage("enforce", result);

      if (!result.ok || !result.json) {
        judgeFailures += 1;
        log({
          event: "judge-failure",
          error: result.error,
          detail: result.detail,
          model: result.model,
          failovers: result.failovers,
          ms: result.ms,
          failures: judgeFailures,
          stdoutTail: result.raw,
          stderrTail: result.stderr,
        });
        const maxFailures = profile.maxJudgeFailures ?? DEFAULTS.maxJudgeFailures;
        if (judgeFailures <= maxFailures) {
          // fail-open toward progress: keep going by the contract instead of stalling
          iterations += 1;
          const fallback = contract.next_steps[0] || "按契约 mission 继续下一个未闭环单元（先读取进度/计划文档确认状态）";
          return {
            continue: true,
            entries: [{
              type: "custom_message",
              customType: "pi-supervisor",
              display: true,
              content: buildContinuation({
                escalationAgent: profile.escalationAgent || DEFAULTS.escalationAgent,
                iteration: iterations,
                reason: `监督模型暂时不可用（${truncateMiddle(result.error ?? "未知原因", 300)}${result.failovers?.length ? `；failover：${result.failovers.join("；")}` : ""}）。`,
                nextStep: fallback,
                contract,
                extraNote: "判官恢复后会在下一次 stop 重新判定；若你发现契约已不适用，用 /supervisor note 说明。",
              }),
            }],
          };
        }
        ctx.ui.notify(`pi-supervisor: 监督模型连续失败(${judgeFailures})：${truncateMiddle(result.error ?? "未知原因", 200)}`, "warning");
        return stopBoundary(`[pi-supervisor] ⏹ 允许停止 — 监督模型连续失败 ${judgeFailures} 次\n最后错误：${result.error ?? "(unknown)"}${result.failovers?.length ? `\nfailover 记录：${result.failovers.join("；")}` : ""}\n说明：不是目标达成；判官恢复或 /supervisor resume 后可继续。`);
      }

      judgeFailures = 0;
      const verdict = result.json as Verdict;
      lastVerdict = verdict;
      contract = mergeContract(contract, verdict.contract_updates);
      persistContract();
      log({
        event: "verdict",
        iteration: iterations + 1,
        ms: result.ms,
        verdict,
        contextPercent: (() => { try { return ctx.getContextUsage()?.percent ?? null; } catch { return null; } })(),
      });

      if (verdict.goal_achieved === true) {
        const stopText = [
          "[pi-supervisor] ✅ 允许停止 — 目标已达成",
          verdict.reason ? `判定依据：${verdict.reason}` : "",
          `契约目标：${truncateMiddle(contract.mission, 400)}`,
          `最远进度：${truncateMiddle(contract.furthest_progress, 400)}`,
          `判定序号：第 ${iterations + 1} 次`,
        ].filter(Boolean).join("\n");
        iterations = 0;
        ctx.ui.notify(`pi-supervisor: 判定目标已达成 — ${verdict.reason || ""}`, "info");
        log({ event: "done", verdict, stopText });
        return stopBoundary(stopText);
      }

      if (verdict.human_needed === true) {
        pausedByStop = true;
        armed = false;
        persistState(false, true, `human-needed: ${verdict.reason || ""}`);
        const stopText = [
          "[pi-supervisor] ⛔ 允许停止 — 需要人类介入",
          verdict.reason ? `判定依据：${verdict.reason}` : "",
          verdict.next_step ? `需要你处理：${verdict.next_step}` : "",
          `契约目标：${truncateMiddle(contract.mission, 300)}`,
          `判定序号：第 ${iterations + 1} 次`,
          "",
          "supervisor 已自动暂停（避免你逐项处理时反复判定）；处理完后用 /supervisor resume 恢复无人值守。",
        ].filter(Boolean).join("\n");
        ctx.ui.notify(`pi-supervisor: 需要人类介入，已自动暂停 — ${verdict.reason || verdict.next_step || ""}`, "warning");
        log({ event: "human-needed", verdict, stopText, autoPaused: true });
        return stopBoundary(stopText);
      }

      iterations += 1;
      const continuation = buildContinuation({
        escalationAgent: profile.escalationAgent || DEFAULTS.escalationAgent,
        iteration: iterations,
        reason: verdict.reason || "",
        nextStep: verdict.next_step || contract.next_steps[0] || "",
        contract,
        violations: asStringArray(verdict.policy_violations, 5),
        missingRecords: asStringArray(verdict.records_missing, 5),
      });

      if (verdict.compact_now === true && profile.smartCompaction !== false && canHotCompact) {
        const focus = verdict.compact_focus || "保留：mission、已完成的单元与提交、未闭环清单、决策记录、记录规则、next_steps 及其证据锚点、用户补充说明。";
        log({ event: "compact-requested", iteration: iterations, focus });
        try {
          ctx.ui.notify(`pi-supervisor: 判定为可压缩检查点，开始压缩上下文（保留：${truncateMiddle(focus, 160)}）`, "info");
          if (ctx.hasUI) ctx.ui.setStatus("supervisor", "压缩上下文中…");
        } catch { /* noop */ }
        const resume = (
          compactResult?: { tokensBefore?: number; estimatedTokensAfter?: number },
          compactError?: Error,
        ) => {
          try {
            if (compactResult) {
              log({
                event: "compact-done",
                tokensBefore: compactResult.tokensBefore ?? null,
                estimatedTokensAfter: compactResult.estimatedTokensAfter ?? null,
              });
              ctx.ui.notify(`pi-supervisor: 压缩完成（${compactResult.tokensBefore ?? "?"} → ${compactResult.estimatedTokensAfter ?? "?"} tokens），继续任务`, "info");
            } else if (compactError) {
              log({ event: "compact-failed", error: String(compactError) });
              ctx.ui.notify(`pi-supervisor: 压缩失败（${compactError.message}），直接继续任务`, "warning");
            }
          } catch { /* noop */ }
          // Resume only when the session is idle; compaction callbacks can fire while pi
          // is still finalizing. Retry briefly, then fall back to a queued follow-up.
          const sendWhenIdle = (text: string) => {
            let tries = 0;
            const attempt = () => {
              tries += 1;
              try {
                if (ctx.isIdle()) {
                  pi.sendUserMessage(text);
                  return;
                }
              } catch (error) {
                log({ event: "resume-idle-check", error: String(error), tries });
              }
              if (tries < 40) {
                setTimeout(attempt, 500);
                return;
              }
              try {
                pi.sendMessage({ customType: "pi-supervisor", content: text, display: true }, { deliverAs: "followUp", triggerTurn: true });
              } catch (error2) {
                log({ event: "resume-failed", error: String(error2) });
              }
            };
            attempt();
          };
          sendWhenIdle(continuation);
        };
        ctx.compact({
          customInstructions: focus,
          onComplete: (result: { tokensBefore?: number; estimatedTokensAfter?: number; usage?: unknown }) => {
            if (result?.usage) {
              const usage = emptyUsage();
              addUsage(usage, result.usage);
              addUsage(usageTotals, usage);
              log({ event: "judge-usage", kind: "compact", usage });
            }
            resume(result);
          },
          onError: (error: Error) => resume(undefined, error),
        });
        return; // settle; the compaction callback restarts the run
      }

      return {
        continue: true,
        entries: [{ type: "custom_message", customType: "pi-supervisor", content: continuation, display: true }],
      };
    } catch (error) {
      log({
        event: "handler-error",
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      try { ctx.ui.notify(`pi-supervisor: 内部错误，交还控制 — ${String(error)}`, "error"); } catch { /* noop */ }
      return stopBoundary(`[pi-supervisor] ⏹ 停止 — 扩展内部错误\n${String(error)}`);
    } finally {
      judging = false;
      try { if (ctx.hasUI) ctx.ui.setStatus("supervisor", undefined); } catch { /* noop */ }
    }
  });

  pi.registerFlag("supervise", {
    description: "Arm pi-supervisor for this session and auto-confirm the inferred contract",
    type: "boolean",
  });

  pi.registerCommand("supervisor", {
    description: "pi-supervisor: status | history [n] | usage | quota | start | replan | note <text> | judge | pause | resume | reset",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      const sub = (raw.split(/\s+/)[0] || "").toLowerCase();
      const rest = raw.slice(sub.length).trim();
      const profile = resolveProfile(ctx.cwd);
      captureSessionMeta(ctx);
      logCtx = { cwd: ctx.cwd, logFile: profile.logFile };
      if (sub === "off" || sub === "pause") {
        armed = false;
        pausedByStop = true;
        persistState(false, false, `manual ${sub}`);
        ctx.ui.notify(`pi-supervisor: 本会话已暂停（${sub}）；用 /supervisor resume 恢复`, "info");
        return;
      }
      if (sub === "on" || sub === "resume") {
        armed = true;
        pausedByStop = false;
        iterations = 0;
        persistState(true, false, `resume ${sub}`);
        ctx.ui.notify("pi-supervisor: 已恢复监督（resume）", "info");
        const canAutoStart = ctx.mode === "tui" || ctx.mode === "rpc";
        if (contract && canAutoStart && ctx.isIdle()) {
          const esc = profile.escalationAgent || DEFAULTS.escalationAgent;
          log({ event: "resume-continue" });
          pi.sendUserMessage(buildContinuation({
            escalationAgent: esc,
            iteration: iterations + 1,
            reason: "监督者已恢复（resume），继续按契约推进。",
            nextStep: contract.next_steps[0] || "按契约继续下一个未闭环单元",
            contract,
          }));
        }
        return;
      }
      if (sub === "reset") {
        iterations = 0;
        judgeFailures = 0;
        ctx.ui.notify("pi-supervisor: 计数已重置", "info");
        return;
      }
      if (sub === "note") {
        if (!contract) {
          ctx.ui.notify("pi-supervisor: 还没有契约；先用 /supervisor start 建立", "warning");
          return;
        }
        if (!rest) {
          ctx.ui.notify("用法：/supervisor note <要告诉监督者的说明>", "warning");
          return;
        }
        contract = { ...contract, user_notes: [...contract.user_notes, rest], updated_at: new Date().toISOString() };
        persistContract();
        ctx.ui.notify(`pi-supervisor: 已记录说明，后续每次判定都会看到（共 ${contract.user_notes.length} 条）`, "info");
        return;
      }
      if (sub === "start" || sub === "replan") {
        if (sub === "replan") contract = undefined;
        armed = true;
        pausedByStop = false;
        iterations = 0;
        persistState(true, false, `start ${sub}`);
        const built = await ensureContract(ctx, profile);
        if (!built) {
          ctx.ui.notify("pi-supervisor: 未建立契约（保持启用，将在下次 stop 重试）", "warning");
          return;
        }
        const canAutoStart = ctx.mode === "tui" || ctx.mode === "rpc"; // print/json one-shot: triggering a turn from a command is unreliable
        if (!canAutoStart) {
          ctx.ui.notify("pi-supervisor: 契约已就绪；在当前会话的下一次 stop 起按契约监督", "info");
        } else if (ctx.isIdle()) {
          const firstStep = built.next_steps[0] || "读取进度/计划文档确认当前状态，然后按 mission 继续下一个未闭环单元";
          log({ event: "command-continue", iteration: 1, firstStep });
          ctx.ui.notify("pi-supervisor: 契约已就绪，开始执行", "info");
          try {
            pi.sendUserMessage(buildContinuation({
              escalationAgent: profile.escalationAgent || DEFAULTS.escalationAgent,
              iteration: 1,
              reason: "监督契约已确认，立即开始执行。",
              nextStep: firstStep,
              contract: built,
              showContract: true,
            }));
          } catch (error) {
            log({ event: "command-continue-failed", error: String(error) });
          }
        } else {
          ctx.ui.notify("pi-supervisor: 契约已就绪；当前 run 未结束，下一次 stop 起按契约监督", "info");
        }
        return;
      }
      if (sub === "judge") {
        if (!contract) {
          ctx.ui.notify("pi-supervisor: 还没有契约；先 /supervisor start 建立", "warning");
          return;
        }
        if (!ctx.isIdle()) {
          ctx.ui.notify("pi-supervisor: 当前 run 未结束；它 stop 时会自动判定", "warning");
          return;
        }
        armed = true;
        ctx.ui.notify("pi-supervisor: 手动判定一次…", "info");
        const esc = profile.escalationAgent || DEFAULTS.escalationAgent;
        const result = await runJudge(
          buildEnforcePrompt(contract, ctx, lastAssistantText, iterations + 1, esc),
          profile,
          ctx.cwd,
          profile.enforceReadTools === true,
        );
        recordJudgeUsage("manual", result);
        if (!result.ok || !result.json) {
          log({ event: "judge-failure", error: result.error, detail: result.detail, model: result.model, failovers: result.failovers, ms: result.ms, manual: true, stdoutTail: result.raw, stderrTail: result.stderr });
          ctx.ui.notify(`pi-supervisor: 判官失败 — ${result.error ?? "unknown"}`, "warning");
          return;
        }
        const verdict = result.json as Verdict;
        lastVerdict = verdict;
        contract = mergeContract(contract, verdict.contract_updates);
        persistContract();
        log({ event: "manual-judge", verdict, ms: result.ms });
        if (verdict.goal_achieved === true) {
          ctx.ui.notify(`pi-supervisor: 手动判定 → 目标已达成 — ${verdict.reason || ""}`, "info");
          pi.sendMessage({
            customType: "pi-supervisor-stop",
            content: `[pi-supervisor] ✅ 手动判定：目标已达成\n判定依据：${verdict.reason || "(无)"}`,
            display: true,
          }, { triggerTurn: false });
          return;
        }
        if (verdict.human_needed === true) {
          pausedByStop = true;
          armed = false;
          persistState(false, true, `manual judge human-needed: ${verdict.reason || ""}`);
          ctx.ui.notify(`pi-supervisor: 手动判定 → 需要人类介入（已自动暂停） — ${verdict.reason || ""}`, "warning");
          pi.sendMessage({
            customType: "pi-supervisor-stop",
            content: `[pi-supervisor] ⛔ 手动判定：需要人类介入\n判定依据：${verdict.reason || ""}\n需要你处理：${verdict.next_step || ""}\n\nsupervisor 已自动暂停；处理完后用 /supervisor resume 恢复。`,
            display: true,
          }, { triggerTurn: false });
          return;
        }
        iterations += 1;
        const continuation = buildContinuation({
          escalationAgent: esc,
          iteration: iterations,
          reason: verdict.reason || "手动判定：继续推进",
          nextStep: verdict.next_step || contract.next_steps[0] || "",
          contract,
          violations: asStringArray(verdict.policy_violations, 5),
          missingRecords: asStringArray(verdict.records_missing, 5),
        });
        ctx.ui.notify("pi-supervisor: 手动判定 → 继续推进", "info");
        pi.sendUserMessage(continuation);
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
      const history = readSessionHistory(profile.logFile, sessionMeta.id, 2000);
      const notable = history
        .filter((entry) => ["verdict", "done", "human-needed", "stopped", "max-iterations", "contract", "contract-provisional", "bootstrap-failure", "judge-failure", "compact-done", "compact-failed", "quota-detected", "quota-recovered", "quota-giveup", "quota-permanent", "quota-aborted"].includes(String(entry.event)))
        .slice(-6);
      const last = [...history].reverse().find((entry) => ["done", "human-needed", "stopped", "max-iterations"].includes(String(entry.event)));
      const lastStop = last
        ? `${String(last.event) === "done" ? "✅ 目标达成" : String(last.event) === "human-needed" ? "⛔ 需人类" : "⏹ 非达成停止"} — ${truncateMiddle(String((last.verdict as Verdict | undefined)?.reason || last.error || "(无理由)"), 300)}`
        : "(本 session 尚无停止判定)";
      const status = [
        `armed: ${armed === undefined ? `auto(${profile.enabled === true || pi.getFlag("supervise") === true})` : String(armed)}${armed === false && pausedByStop ? "（已自动/手动暂停，/supervisor resume 恢复）" : ""}  ·  session: ${sessionMeta.name || "(未命名)"}  ·  id: ${sessionMeta.id || "?"}`,
        `judge: ${profile.judgeModel || DEFAULTS.judgeModel} · failOver→${profile.judgeFailover === false ? "(关闭)" : (profile.judgeFailoverModel || DEFAULTS.judgeFailoverModel)} · enforceReadTools=${profile.enforceReadTools === true} · bootstrapTimeout=${Math.round((profile.bootstrapTimeoutMs ?? DEFAULTS.bootstrapTimeoutMs) / 1000)}s · escalation=${profile.escalationAgent || DEFAULTS.escalationAgent}`,
        `iterations: ${iterations}/${profile.maxIterations ?? DEFAULTS.maxIterations}  ·  judge failures: ${judgeFailures}/${profile.maxJudgeFailures ?? DEFAULTS.maxJudgeFailures}`,
        (() => {
          const qw = resolveQuotaWait(profile);
          return `quotaWait: ${qw.enabled ? `on · 每 ${formatDuration(qw.intervalMs)} 探测` : "off"}${quotaState.attempts > 0 ? ` · 当前第 ${quotaState.attempts} 次 · 累计 ${formatDuration(quotaState.waitedMs)}` : ""}`;
        })(),
        contract
          ? `contract: ${contract.provisional ? "临时（推断失败兜底）" : "已确认"} · updated ${contract.updated_at} · next_steps ${contract.next_steps.length} · user_notes ${contract.user_notes.length}`
          : "contract: 未建立（首次 stop 或 /supervisor start 时推断）",
        `最近一次允许停止: ${lastStop}`,
        `judge tokens（本进程）: ${formatUsage(usageTotals)}`,
        `recent（最近 ${notable.length} 条判定事件，完整用 /supervisor history):\n${notable.length ? notable.map(historyLine).join("\n") : "(无)"}`,
        contract ? `\n当前契约:\n${contractSummary(contract)}` : "",
      ].filter(Boolean).join("\n");
      ctx.ui.notify(truncateMiddle(status, 4500), "info");
    },
  });
}
