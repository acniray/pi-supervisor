import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: number;
  turns: number;
  calls: number;
}

export function emptyUsage(): UsageSummary {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0, turns: 0, calls: 0 };
}

export function addUsage(target: UsageSummary, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const u = usage as Record<string, unknown>;
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  const input = num(u.input), output = num(u.output), cacheRead = num(u.cacheRead), cacheWrite = num(u.cacheWrite);
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  target.reasoning += num(u.reasoning);
  target.totalTokens += num(u.totalTokens) || input + output + cacheRead + cacheWrite;
  target.cost += u.cost && typeof u.cost === "object" ? num((u.cost as Record<string, unknown>).total) : num(u.cost);
  target.turns += typeof u.turns === "number" ? num(u.turns) : 1;
}

export type JudgeErrorKind = "spawn" | "timeout" | "exit" | "provider" | "parse" | "incomplete" | "logging" | "session" | "extension" | "invalidated";

export interface JudgeAttempt {
  callId: string;
  attemptId: string;
  model: string;
  fullLogging: boolean;
  logComplete: boolean;
  logDir?: string;
  parentSessionId?: string;
  kind?: string;
  /** Judgement tier chosen by the caller; L0 never spawns a process. */
  tier?: "L0" | "L1" | "L2";
  reusedEvidence?: number;
  reverifiedEvidence?: number;
  retrievals?: number;
  escalation?: string;
  ok: boolean;
  errorKind?: JudgeErrorKind;
  error?: string;
  detail?: string;
  ms: number;
  usage?: UsageSummary;
  stdoutBytes: number;
  stderrBytes: number;
  lastEvent?: string;
  lastTool?: string;
}

export interface JudgeResult {
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
  errorKind?: JudgeErrorKind;
  attempts?: JudgeAttempt[];
  ms: number;
}

export interface JudgeRunContext {
  parentSessionId?: string;
  parentSessionFile?: string;
  parentSessionName?: string;
  kind?: string;
  fullLogging?: boolean;
}

export interface RunJudgeOnceOptions extends JudgeRunContext {
  prompt: string;
  cwd: string;
  withTools: boolean;
  model: string;
  thinking: string;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  callId?: string;
  logRoot?: string;
  /** Explicit provider extension paths; `--no-extensions` still blocks every other extension. */
  extensionPaths?: string[];
}

const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

/**
 * Resolve one explicitly allowed judge extension. Judge subprocesses keep
 * --no-extensions, so only configured provider packages can register models.
 */
export function resolveJudgeExtension(spec: string, cwd: string, agentDir: string): string {
  const value = spec.trim();
  if (!value) throw new Error("判官扩展配置为空");
  if (value.startsWith("builtin:")) throw new Error(`判官不接受 builtin 扩展：${value}`);
  if (value.startsWith("npm:")) {
    const name = value.slice(4);
    if (!NPM_PACKAGE.test(name)) throw new Error(`判官 npm 扩展包名无效：${name}`);
    const pkgDir = path.join(agentDir, "npm", "node_modules", name);
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) throw new Error(`判官找不到 npm 扩展：${name}（${pkgDir}）`);
    return pkgDir;
  }
  const resolved = path.resolve(cwd, value);
  if (!fs.existsSync(resolved)) throw new Error(`判官扩展路径不存在：${resolved}`);
  return resolved;
}

interface JudgeOutput {
  text: string;
  usage?: UsageSummary;
  sawEvents: boolean;
  stopReason?: string;
  providerError?: string;
  detail?: string;
  lastEvent?: string;
  lastTool?: string;
  complete: boolean;
}

/** LF framing and UTF-8 decoding, independent of the bounded diagnostic tail. */
export class JudgeOutputParser {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private skipping = false;
  private plain = "";
  private finalText = "";
  private deltaText = "";
  private sawEvents = false;
  private finalMessage = false;
  private stopReason: string | undefined;
  private providerError = "";
  private retryError = "";
  private diagnostics: string[] = [];
  private usage = emptyUsage();
  private lastEvent: string | undefined;
  private lastTool: string | undefined;
  private ended = false;
  // A huge ignored agent_end/tool record must not consume unbounded memory.
  private readonly maxLine = 4_000_000;

  push(chunk: Buffer): void {
    if (!this.ended) this.consume(this.decoder.write(chunk));
  }

  private consume(text: string): void {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start);
      const part = end < 0 ? text.slice(start) : text.slice(start, end);
      if (!this.skipping) {
        this.pending += part;
        if (this.pending.length > this.maxLine) {
          // It is unsafe to parse a suffix as a new record. Discard until LF.
          this.skipping = true;
          this.pending = "";
        }
      }
      if (end < 0) return;
      if (!this.skipping) this.record(this.pending);
      this.pending = "";
      this.skipping = false;
      start = end + 1;
    }
  }

  private record(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let record: Record<string, any>;
    try { record = JSON.parse(trimmed); } catch {
      if (!this.sawEvents && this.plain.length < this.maxLine) this.plain += line + "\n";
      return;
    }
    if (!record || typeof record !== "object" || typeof record.type !== "string") {
      if (!this.sawEvents && this.plain.length < this.maxLine) this.plain += line + "\n";
      return;
    }
    this.sawEvents = true;
    this.plain = "";
    this.lastEvent = record.type;
    if (record.type === "message_start" && record.message?.role === "assistant") {
      this.finalText = this.deltaText = "";
      this.stopReason = undefined;
      this.finalMessage = false;
      this.providerError = "";
    } else if (record.type === "message_update") {
      const event = record.assistantMessageEvent;
      if (event?.type === "text_delta" && typeof event.delta === "string") {
        if (this.deltaText.length + event.delta.length <= this.maxLine) this.deltaText += event.delta;
      }
    } else if (record.type === "message_end" && record.message?.role === "assistant") {
      const message = record.message;
      addUsage(this.usage, message.usage);
      this.finalText = Array.isArray(message.content) ? message.content
        .filter((block: any) => block?.type === "text" && typeof block.text === "string")
        .map((block: any) => block.text).join("\n") : "";
      this.deltaText = "";
      this.finalMessage = true;
      this.stopReason = message.stopReason;
      this.providerError = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
      this.diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics.slice(0, 2).map((item: unknown) =>
        (typeof item === "string" ? item : JSON.stringify(item)).slice(0, 200)) : [];
      const tool = Array.isArray(message.content) ? message.content.find((block: any) => block?.type === "toolCall") : undefined;
      if (tool?.name) this.lastTool = tool.name;
    } else if (record.type === "error") {
      this.providerError = String(record.error || record.reason || "judge stream error");
      this.stopReason = "error";
    } else if (record.type === "auto_retry_end" && record.success === false) {
      this.retryError = String(record.finalError || "auto retry failed");
    } else if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
      if (typeof record.toolName === "string") this.lastTool = record.toolName;
    }
  }

  finish(): JudgeOutput {
    if (!this.ended) {
      this.consume(this.decoder.end());
      if (this.pending && !this.skipping) this.record(this.pending);
      this.pending = "";
      this.ended = true;
    }
    const parts = [
      this.providerError ? `provider=${this.providerError}` : "",
      this.retryError ? `autoRetryFinal=${this.retryError}` : "",
      this.stopReason && this.stopReason !== "stop" ? `stopReason=${this.stopReason}` : "",
      this.diagnostics.length ? `diagnostics=${this.diagnostics.join(" | ")}` : "",
    ].filter(Boolean);
    return {
      text: this.sawEvents ? this.finalText || this.deltaText : this.plain,
      usage: this.usage.turns ? { ...this.usage } : undefined,
      sawEvents: this.sawEvents,
      stopReason: this.stopReason,
      providerError: this.providerError || undefined,
      detail: parts.join("; ") || undefined,
      lastEvent: this.lastEvent,
      lastTool: this.lastTool,
      complete: !this.sawEvents || this.finalMessage && this.stopReason === "stop" && !this.providerError,
    };
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

interface FullLog {
  dir: string;
  sessionId: string;
  stdout: number;
}

function privateFile(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
}

function openFullLog(options: RunJudgeOnceOptions, callId: string, attemptId: string): FullLog {
  const root = options.logRoot!;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${new Date().toISOString().replace(/[:.]/g, "-")}-${attemptId}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const sessionId = randomUUID();
  let stdout: number | undefined;
  try {
    privateFile(path.join(dir, "request.json"), JSON.stringify({
      callId, attemptId, parentSessionId: options.parentSessionId, parentSessionFile: options.parentSessionFile,
      parentSessionName: options.parentSessionName, kind: options.kind,
      model: options.model, thinking: options.thinking, cwd: options.cwd,
      withTools: options.withTools, timeoutMs: options.timeoutMs, prompt: options.prompt,
    }, null, 2) + "\n");
    stdout = fs.openSync(path.join(dir, "stdout.jsonl"), "wx", 0o600);
    return { dir, sessionId, stdout };
  } catch (error) {
    if (stdout !== undefined) fs.closeSync(stdout);
    throw error;
  }
}

function writeAll(fd: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) {
    const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
    if (!written) throw new Error("short log write");
    offset += written;
  }
}

/** A single owned subprocess; resolves after close, so timeout/abort output is drained. */
export async function runJudgeOnce(options: RunJudgeOnceOptions): Promise<JudgeResult> {
  const { prompt, cwd, withTools, model, thinking, command, timeoutMs, signal } = options;
  const started = Date.now();
  const callId = options.callId || randomUUID(), attemptId = randomUUID();
  const parser = new JudgeOutputParser();
  let raw = "", stderr = "", stdoutBytes = 0, stderrBytes = 0;
  let fullLog: FullLog | undefined;
  let failure: { kind: JudgeErrorKind; error: string } | undefined;

  const finish = (code: number | null, closeSignal?: string | null): JudgeResult => {
    const output = parser.finish();
    const ms = Date.now() - started;
    const json = parseJsonObject(output.text);
    if (!failure) {
      if (code !== 0) failure = { kind: "exit", error: `judge 进程退出码 ${code}${closeSignal ? ` (${closeSignal})` : ""}${stderr.trim() ? `：${stderr.trim().slice(-800)}` : ""}` };
      else if (output.providerError || output.stopReason === "error" || output.stopReason === "aborted") failure = { kind: "provider", error: `judge provider 失败：${output.detail || output.stopReason}` };
      else if (!output.complete) failure = { kind: "incomplete", error: `judge 未完成最终答复：${output.detail || output.lastEvent || "无最终 assistant 消息"}` };
      else if (!json) failure = { kind: "parse", error: `judge 输出不是可用 JSON：${output.text.trim().slice(-500) || "(空)"}` };
    }
    const result: JudgeResult = { ok: !failure, ...(failure ? { error: failure.error, errorKind: failure.kind } : { json }),
      text: output.text, usage: output.usage, detail: output.detail, raw: raw.slice(-4000), stderr: stderr.slice(-2000), model, ms };
    const attempt: JudgeAttempt = { callId, attemptId, model, kind: options.kind, fullLogging: options.fullLogging === true,
      logComplete: false, parentSessionId: options.parentSessionId, logDir: fullLog?.dir,
      ok: result.ok, error: result.error, errorKind: result.errorKind, detail: output.detail,
      ms, usage: output.usage, stdoutBytes, stderrBytes, lastEvent: output.lastEvent, lastTool: output.lastTool };
    result.attempts = [attempt];
    if (fullLog) {
      try {
        fs.closeSync(fullLog.stdout); fullLog.stdout = -1;
        attempt.logComplete = result.errorKind !== "logging";
        privateFile(path.join(fullLog.dir, "result.json"), JSON.stringify({ ...result, exitCode: code, signal: closeSignal || null }, null, 2) + "\n");
      } catch (error) {
        result.ok = attempt.ok = attempt.logComplete = false;
        result.errorKind = attempt.errorKind = "logging";
        result.error = attempt.error = `judge 全量日志写入失败：${String(error)}；目录 ${fullLog.dir}`;
        delete result.json;
      } finally {
        if (fullLog.stdout >= 0) { try { fs.closeSync(fullLog.stdout); } catch { /* already closed */ } }
      }
    }
    return result;
  };
  if (signal?.aborted) {
    failure = { kind: "invalidated", error: "supervision operation invalidated" };
    return finish(null);
  }
  if (options.fullLogging) {
    try {
      if (!options.logRoot) throw new Error("judgeLogDir 未配置");
      fullLog = openFullLog(options, callId, attemptId);
    } catch (error) {
      failure = { kind: "logging", error: `judge 无法开启全量日志：${String(error)}；路径 ${options.logRoot || "(无)"}` };
      return finish(null);
    }
  }
  const extensionArgs = (options.extensionPaths || []).flatMap(entry => ["--extension", entry]);
  // Every round is an independent session: history lives in stdout logs + index.
  const args = ["--mode", "json", ...extensionArgs, "--no-session",
    "--no-extensions", "--no-skills", "--no-context-files",
    ...(withTools ? ["--tools", "read,grep,find,ls"] : ["--no-tools"]),
    "--model", model, "--thinking", thinking, prompt];

  return await new Promise<JudgeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (kind: JudgeErrorKind, error: string) => {
      if (!failure || kind === "logging") failure = { kind, error };
      try { child.kill("SIGKILL"); } catch { /* close/error will settle */ }
    };
    const onAbort = () => stop("invalidated", "supervision operation invalidated");
    try { child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) {
      failure = { kind: "spawn", error: `judge 进程启动失败：${String(error)}` };
      resolve(finish(null)); return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      raw = (raw + chunk.toString()).slice(-8000);
      parser.push(chunk);
      if (fullLog && fullLog.stdout >= 0) {
        try { writeAll(fullLog.stdout, chunk); }
        catch (error) { stop("logging", `judge 全量 stdout 写入失败：${String(error)}；目录 ${fullLog.dir}`); }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => { if (!failure) failure = { kind: "spawn", error: `judge 进程启动失败：${String(error)}` }; });
    child.on("close", (code, closeSignal) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(finish(code, closeSignal));
    });
    timer = setTimeout(() => stop("timeout", `judge 超时 ${timeoutMs}ms；已收到 ${stdoutBytes}B stdout / ${stderrBytes}B stderr`), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
