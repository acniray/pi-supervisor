import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Only the external judge/config boundary is faked. All tests invoke the real
// registered extension handlers and inspect their persisted/queued effects.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-supervisor-test-"));
const configPath = path.join(root, "config.json");
const oldConfig = process.env.PI_SUPERVISOR_CONFIG;
process.env.PI_SUPERVISOR_CONFIG = configPath;
const judgePath = path.join(root, "judge.cjs");
fs.writeFileSync(judgePath, `#!/usr/bin/env node
const fs = require('node:fs');
const count = Number(fs.existsSync('judge-count') ? fs.readFileSync('judge-count', 'utf8') : 0) + 1;
fs.writeFileSync('judge-count', String(count));
const sessionIndex = process.argv.indexOf('--session');
const sessionPath = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
let history = [];
if (sessionPath) history = fs.readFileSync(sessionPath, 'utf8').split('\\n').filter(Boolean).map(line => {try{return JSON.parse(line)}catch{return null}}).filter(Boolean);
fs.writeFileSync('context-' + count + '.json', JSON.stringify(history));
const last = history.filter(e => e.type !== 'session').at(-1);
const userId = 'fixture-user-' + count;
if (sessionPath) fs.appendFileSync(sessionPath, JSON.stringify({type:'message',id:userId,parentId:last?.id || null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:process.argv.at(-1)}]}}) + '\\n');
const response = 'reply-' + count + '.json';
let done = false;
const watcher = fs.watch('.', check);
function check() {
  if (done || !fs.existsSync(response)) return;
  let value; try { value = JSON.parse(fs.readFileSync(response, 'utf8')); } catch { return; }
  done = true; watcher.close();
  const output = value.raw === undefined ? JSON.stringify(value) : value.raw;
  if (sessionPath) {
    fs.appendFileSync(sessionPath, JSON.stringify({type:'message',id:'fixture-assistant-' + count,parentId:userId,timestamp:new Date().toISOString(),message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:output}]}}) + '\\n');
  }
  if (value.stderr) fs.writeSync(2, value.stderr);
  fs.writeSync(1, output + (value.noFinalNewline ? '' : '\\n'));
  process.exitCode = value.code || 0;
}
fs.writeFileSync('call-' + count + '.json', JSON.stringify(process.argv.slice(2)));
check();
`, { mode: 0o755 });
const config: any = { defaults: {
  judgeCommand: judgePath, judgeModel: "fixture/primary", judgeFailover: false,
  judgeTimeoutMs: 2000, bootstrapTimeoutMs: 2000,
  logFile: path.join(root, "verdicts.jsonl"), stopFile: path.join(root, "STOP"),
  judgeLogDir: path.join(root, "judge-logs"),
  judgeSessionDir: path.join(root, "judge-sessions"),
}, projects: {} };
fs.writeFileSync(configPath, JSON.stringify(config));
const { default: extension } = await import("./index.ts");
after(() => {
  if (oldConfig === undefined) delete process.env.PI_SUPERVISOR_CONFIG;
  else process.env.PI_SUPERVISOR_CONFIG = oldConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

const baseContract = {
  version: 1, mission: "交付可靠的取消功能", completion_criteria: ["取消后不再续跑", "重载不复活任务"],
  boundaries: ["不打断主 Agent"], furthest_progress: "已实现一半", next_steps: ["补齐回归测试"],
  decision_policy: ["保留已确认的升级边界"], record_policy: ["记录重要决策"],
  stop_conditions: ["所有完成条件有证据"], autonomy_rules: ["仅在批准范围内工作"],
  user_notes: [], confirmed_by_user: true, updated_at: "2026-10-22T00:00:00Z",
};
const candidate = (mission = baseContract.mission) => ({ ...baseContract, mission, confidence: "high", open_questions: [] });
const custom = (customType: string, data: any) => ({ type: "custom", customType, data });
const contractEntry = (value: any = baseContract) => custom("pi-supervisor-contract", value);
const stateEntry = (lifecycle: string, extra: any = {}) => custom("pi-supervisor-state", {
  lifecycle, armed: lifecycle === "active", paused: lifecycle === "paused", ...extra,
});
const evidence = () => baseContract.completion_criteria.map((criterion, i) => ({ criterion, evidence: `测试文件第 ${i + 1} 个用例通过` }));
const success = () => ({ goal_achieved: true, human_needed: false, criteria_evidence: evidence(), unmet_conditions: [], reason: "所有完成条件均有测试证据" });

async function waitFile(file: string): Promise<void> {
  if (fs.existsSync(file)) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Judge did not create ${file}`)); }, 3000);
    const watcher = fs.watch(path.dirname(file), () => {
      if (!fs.existsSync(file)) return;
      clearTimeout(timer); watcher.close(); resolve();
    });
    if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
}

async function harness(options: any = {}) {
  const cwd = fs.mkdtempSync(path.join(root, "session-"));
  config.projects[cwd] = options.profile || {};
  fs.writeFileSync(configPath, JSON.stringify(config));
  let entries: any[] = options.entries ? structuredClone(options.entries) : [];
  let sessionId = path.basename(cwd);
  const events = new Map<string, Function>();
  const commands = new Map<string, any>();
  const notifications: string[] = [];
  const statuses: Array<string | undefined> = [];
  const sends: any[] = [];
  const confirmations: any[] = [];
  const editors: string[] = [];
  let aborts = 0;
  let responseIndex = 0;
  let selectAnswer: any = "不取消";
  let editorAnswer: any = undefined;
  let compactOptions: any;
  const ctx: any = {
    cwd, hasUI: options.hasUI !== false, mode: "tui", signal: new AbortController().signal,
    isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => undefined,
    abort: () => { aborts += 1; }, compact: (value: any) => { compactOptions = value; },
    sessionManager: {
      getEntries: () => entries, getBranch: () => entries,
      getSessionId: () => sessionId, getSessionName: () => sessionId, getSessionFile: () => undefined,
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "实现可靠的取消功能" }] }),
    },
    ui: {
      notify: (value: string) => notifications.push(value),
      setStatus: (_key: string, value: string | undefined) => statuses.push(value),
      select: async (title: string, choices: string[]) => { confirmations.push({ title, choices }); return typeof selectAnswer === "function" ? selectAnswer() : selectAnswer; },
      editor: async (_title: string, prefill: string) => { editors.push(prefill); return typeof editorAnswer === "function" ? editorAnswer(prefill) : editorAnswer; },
      confirm: async () => false, input: async () => undefined,
    },
  };
  const bus = new Map<string, Set<Function>>();
  const pi: any = {
    events: {
      on: (name: string, callback: Function) => { const set = bus.get(name) || new Set(); set.add(callback); bus.set(name, set); return () => set.delete(callback); },
      emit: (name: string, payload: any) => { for (const callback of bus.get(name) || []) callback(payload); },
    },
    on: (name: string, callback: Function) => events.set(name, callback),
    registerFlag: () => {}, getFlag: () => options.flag === true,
    registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (type: string, data: any) => entries.push(custom(type, structuredClone(data))),
    sendUserMessage: (text: string) => sends.push({ text, triggerTurn: true }),
    sendMessage: (message: any, delivery: any) => sends.push({ ...message, ...delivery }),
  };
  extension(pi);
  const command = async (text: string) => commands.get("supervisor").handler(text, ctx);
  const event = async (name: string, value: any = {}) => events.get(name)?.(value, ctx);
  await event("session_start");
  return {
    cwd, ctx, notifications, statuses, sends, confirmations, editors, command, event,
    get entries() { return entries; }, get aborts() { return aborts; },
    get compactOptions() { return compactOptions; },
    get state() { return entries.filter(e => e.customType === "pi-supervisor-state").at(-1)?.data; },
    get contract() { return entries.filter(e => e.customType === "pi-supervisor-contract").at(-1)?.data; },
    set select(value: any) { selectAnswer = value; }, set editor(value: any) { editorAnswer = value; },
    enqueue(value?: any) {
      const id = ++responseIndex;
      if (value !== undefined) this.reply(id, value);
      // A completion claim from the cheap path is always re-verified (L2), so the
      // fixture answers the escalation call with the same verdict.
      if (value && typeof value === "object" && !("raw" in value) && value.goal_achieved === true && value.human_needed !== true &&
        baseContract.completion_criteria.every((criterion: string) =>
          (value.criteria_evidence || []).some((item: any) => item?.criterion === criterion && typeof item.evidence === "string" && item.evidence.trim()))) this.reply(++responseIndex, value);
      return id;
    },
    reply(id: number, value: any) { fs.writeFileSync(path.join(cwd, `reply-${id}.json`), JSON.stringify(value)); },
    waitCall: (id: number) => waitFile(path.join(cwd, `call-${id}.json`)),
    callCount: () => Number(fs.existsSync(path.join(cwd, "judge-count")) ? fs.readFileSync(path.join(cwd, "judge-count"), "utf8") : 0),
    callArgs: (id: number) => JSON.parse(fs.readFileSync(path.join(cwd, `call-${id}.json`), "utf8")),
    nativeContext: (id: number) => JSON.parse(fs.readFileSync(path.join(cwd, `context-${id}.json`), "utf8")),
    promptOf: (logDir: string) => JSON.parse(fs.readFileSync(path.join(logDir, "request.json"), "utf8")).prompt,
    audit: () => fs.existsSync(config.defaults.logFile) ? fs.readFileSync(config.defaults.logFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.sessionId === sessionId) : [],
    bus: (name: string, payload: any) => pi.events.emit(name, payload),
    say: (text: string) => event("turn_end", { message: { role: "assistant", content: [{ type: "text", text }] } }),
    settle: (outcome = "completed") => event("agent_before_settle", { outcome, context: { pendingMessages: [], contextMessages: [], contextEntries: [] } }),
    async status(details = false) { await command(details ? "details" : "status"); return notifications.at(-1)!; },
    async switchSession(next: any[] = []) { entries = structuredClone(next); sessionId = `another-session-${path.basename(cwd)}`; await event("session_start"); },
    async restoreBranch(next: any[]) { entries = structuredClone(next); await event("session_start"); },
  };
}

for (const lifecycle of ["paused", "cancelled", "completed"]) {
  test(`${lifecycle} survives input, reload and --supervise`, async () => {
    const h = await harness({ flag: true, entries: [contractEntry(), stateEntry(lifecycle)] });
    await h.event("input", { source: "interactive" });
    assert.equal(await h.settle(), undefined);
    assert.equal(h.callCount(), 0);
    const status = await h.status();
    assert.match(status, new RegExp(`${lifecycle}|${{ paused: "已暂停", cancelled: "已取消", completed: "已完成" }[lifecycle]}`));
    if (lifecycle !== "paused") assert.ok(!status.includes(baseContract.mission));
  });
}

test("cancel defaults negative and declining has no persisted side effects", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active", { iterations: 7 })] });
  const before = structuredClone(h.entries);
  await h.command("cancel");
  assert.equal(h.confirmations[0].choices[0], "不取消");
  assert.deepEqual(h.entries, before);
  assert.match(await h.status(), /active|监督中/);
});

test("confirmed cancel clears effective task/progress but never aborts the main agent", async () => {
  const h = await harness({ flag: true, entries: [contractEntry(), stateEntry("active", { iterations: 7 })] });
  h.select = "取消";
  await h.command("cancel");
  assert.equal(h.state.lifecycle, "cancelled");
  assert.equal(h.state.iterations, 0);
  assert.equal(h.aborts, 0);
  assert.equal(h.sends.length, 0);
  assert.ok(!(await h.status()).includes(baseContract.mission));
  await h.event("session_start");
  await h.command("resume");
  assert.equal(await h.settle(), undefined);
  assert.equal(h.callCount(), 0);
});

test("headless or unavailable default-negative confirmation cannot cancel", async () => {
  const h = await harness({ hasUI: false, entries: [contractEntry(), stateEntry("active")] });
  h.select = "取消";
  await h.command("cancel");
  assert.equal(h.state.lifecycle, "active");
  assert.equal(h.confirmations.length, 0);
});

test("switching sessions resets lifecycle, contract and pending-operation ownership", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused", { iterations: 8 })] });
  await h.switchSession();
  const status = await h.status();
  assert.match(status, /inactive|未开始/);
  assert.ok(!status.includes(baseContract.mission));
  await h.command("resume");
  assert.equal(h.sends.length, 0);
});

test("legacy paused entries restore safely and progress survives ordinary input", async () => {
  const h = await harness({ flag: true, entries: [
    custom("stop-supervisor-contract", baseContract), custom("stop-supervisor-state", { armed: false, paused: true, iterations: 7, judgeFailures: 1 }),
  ] });
  await h.event("input", { source: "interactive" });
  await h.command("resume");
  assert.equal(h.state.iterations, 7);
  assert.equal(h.state.judgeFailures, 1);
  assert.equal(h.sends.length, 1);
});

for (const sub of ["on", "off", "reset"]) {
  test(`deprecated ${sub} gives migration guidance without changing task`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
    const before = structuredClone(h.entries);
    await h.command(sub);
    assert.deepEqual(h.entries, before);
    assert.match(h.notifications.at(-1)!, /start.*pause.*resume.*cancel/);
  });
}

test("start is idempotent while active and resume requires a paused contract", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  await h.command("start");
  assert.equal(h.callCount(), 0);
  await h.switchSession([stateEntry("paused")]);
  await h.command("resume");
  assert.notEqual(h.state.lifecycle, "active");
  assert.equal(h.sends.length, 0);
});

test("initial draft is not active; declining it cannot be overridden by --supervise", async () => {
  const h = await harness({ flag: true });
  const id = h.enqueue();
  const pending = h.command("start");
  await h.waitCall(id);
  assert.match(await h.status(), /drafting|待确认/);
  assert.ok(!h.entries.some(e => e.data?.lifecycle === "active"));
  h.reply(id, { ...candidate(), confidence: "low" });
  await pending;
  assert.match(await h.status(), /inactive|未开始/);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.callCount(), 1);
});

test("bootstrap failure does not establish a generic fallback or leave supervision enabled", async () => {
  const h = await harness({ flag: true });
  h.enqueue({ raw: "failed", code: 1 }); h.enqueue({ raw: "failed again", code: 1 });
  await h.command("start");
  assert.equal(h.contract, undefined);
  assert.match(await h.status(), /inactive|未开始/);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.callCount(), 2);
});

for (const failed of [false, true]) {
  test(`abandoned replan (${failed ? "failure" : "decline"}) retains old contract and state`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry("active", { iterations: 7 })] });
    if (failed) { h.enqueue({ raw: "bad", code: 1 }); h.enqueue({ raw: "bad", code: 1 }); }
    else h.enqueue(candidate("另一个终点"));
    await h.command("replan");
    assert.equal(h.contract.mission, baseContract.mission);
    assert.equal(h.state.lifecycle, "active");
    assert.equal(h.state.iterations, 7);
    assert.equal(h.sends.length, 0);
  });
}

for (const sub of ["pause", "cancel"]) {
  test(`${sub} invalidates an in-flight enforcement result`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
    const id = h.enqueue();
    const pending = h.settle();
    await h.waitCall(id);
    h.select = "取消";
    await h.command(sub);
    const before = structuredClone(h.entries);
    h.reply(id, { goal_achieved: false, next_step: "不该执行", contract_updates: { furthest_progress: "迟到结果" } });
    assert.equal(await pending, undefined);
    assert.deepEqual(h.entries, before);
    assert.equal(h.sends.length, 0);
  });
}

test("late bootstrap cannot resurrect a cancelled draft", async () => {
  const h = await harness(); h.editor = (prefill: string) => prefill;
  const id = h.enqueue(); const pending = h.command("start");
  await h.waitCall(id); h.select = "取消"; await h.command("cancel");
  const before = structuredClone(h.entries);
  h.reply(id, candidate()); await pending;
  assert.deepEqual(h.entries, before);
  assert.equal(h.state.lifecycle, "cancelled");
  assert.equal(h.sends.length, 0);
});

test("cancel then start rejects the old generation even though lifecycle is active again", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const id = h.enqueue(); const old = h.settle(); await h.waitCall(id);
  h.select = "取消"; await h.command("cancel");
  h.enqueue(candidate("全新任务")); h.editor = (prefill: string) => prefill;
  await h.command("start");
  h.reply(id, success()); await old;
  assert.equal(h.contract.mission, "全新任务");
  assert.equal(h.state.lifecycle, "active");
  assert.equal(h.sends.length, 1);
});

test("manual judgement while paused cannot resume, and cancellation drops late manual results", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")] });
  h.enqueue({ goal_achieved: false, reason: "还需补测", next_step: "补测" });
  await h.command("judge");
  assert.equal(h.sends.filter(s => s.triggerTurn).length, 0);
  assert.equal(h.state.lifecycle, "paused");
  const id = h.enqueue(); const pending = h.command("judge"); await h.waitCall(id);
  h.select = "取消"; await h.command("cancel"); const before = structuredClone(h.entries);
  h.reply(id, success()); await pending;
  assert.deepEqual(h.entries, before);
  assert.equal(h.state.lifecycle, "cancelled");
});

test("cancel invalidates quota sleep and prevents a subsequent probe", async (t) => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { quotaWait: { intervalMs: 5000 } } });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  await h.event("turn_end", { message: { role: "assistant", stopReason: "error", errorMessage: "usage limit reached" } });
  const pending = h.settle("error");
  h.select = "取消"; await h.command("cancel");
  t.mock.timers.tick(5000);
  assert.equal(await pending, undefined);
  assert.equal(h.state.lifecycle, "cancelled");
  assert.equal(h.sends.length, 0);
});

test("old compaction callback cannot send after pause and resume", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ goal_achieved: false, next_step: "继续补测", compact_now: true });
  await h.settle(); assert.ok(h.compactOptions);
  const callback = h.compactOptions.onComplete;
  await h.command("pause"); await h.command("resume");
  const count = h.sends.length;
  callback({ tokensBefore: 1000, estimatedTokensAfter: 500 });
  await Promise.resolve();
  assert.equal(h.sends.length, count);
});

const invalidVerdicts: Array<[string, any]> = [
  ["a long reason is not criterion evidence", { goal_achieved: true, reason: "a".repeat(100) }],
  ["duplicate evidence cannot cover a different criterion", { ...success(), criteria_evidence: [evidence()[0], evidence()[0]] }],
  ["bare criterion names are not evidence", { ...success(), criteria_evidence: baseContract.completion_criteria }],
  ["unmet conditions block completion", { ...success(), unmet_conditions: ["重载测试未通过"] }],
  ["missing records block completion", { ...success(), records_missing: ["重要决策未登记"] }],
  ["policy violations block completion", { ...success(), policy_violations: ["越过必要限制"] }],
  ["human-needed conflicts with completion", { ...success(), human_needed: true }],
  ["malformed human-needed cannot be ignored", { ...success(), human_needed: "true" }],
  ["evidence conflicts require targeted checking", { ...success(), evidence_conflicts: ["提交与测试输出不一致"] }],
  ...["unmet_conditions", "evidence_conflicts", "policy_violations", "records_missing"].flatMap(field =>
    ["仍有阻塞", null, [{ issue: "尚待核验" }]].map(value => [
      `malformed ${field} (${JSON.stringify(value)}) blocks completion`,
      { ...success(), [field]: value },
    ] as [string, any])),
];
for (const [name, verdict] of invalidVerdicts) {
  test(name, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
    h.enqueue(verdict); const result = await h.settle();
    assert.notEqual(h.state.lifecycle, "completed");
    assert.ok(!JSON.stringify(result).includes("✅"));
  });
}

test("criterion-level evidence completes once and --supervise cannot restart it", async () => {
  const h = await harness({ flag: true, entries: [contractEntry(), stateEntry("active")] });
  h.enqueue(success()); const result = await h.settle();
  assert.equal(h.state.lifecycle, "completed");
  assert.ok(JSON.stringify(result).includes("✅"));
  assert.equal(await h.settle(), undefined);
  assert.equal(h.callCount(), 2, "cheap pass then deep verification");
});

test("manual completion uses the same evidence gate as automatic enforcement", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ goal_achieved: true, reason: "没有证据不能完成" });
  await h.command("judge");
  assert.notEqual(h.state.lifecycle, "completed");
  assert.ok(!h.sends.some(s => (s.content || "").includes("✅")));
  h.enqueue(success()); await h.command("judge");
  assert.equal(h.state.lifecycle, "completed");
});

test("runtime endpoint changes require re-confirmation and cannot overwrite the old endpoint", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ ...success(), contract_updates: { mission: "偷偷改目标", completion_criteria: ["删掉测试就完成"], boundaries: [] } });
  await h.settle();
  assert.equal(h.contract.mission, baseContract.mission);
  assert.deepEqual(h.contract.completion_criteria, baseContract.completion_criteria);
  assert.deepEqual(h.contract.boundaries, baseContract.boundaries);
  assert.equal(h.state.lifecycle, "paused");
  assert.match(h.notifications.join("\n"), /replan/);
});

test("confirmation/status are short, retained constraints stay in details, ordinary continuation is concise", async () => {
  const h = await harness(); h.editor = (prefill: string) => prefill;
  h.enqueue({ ...candidate(), decision_policy: Array.from({ length: 20 }, (_, i) => `附加策略-${i}-${"复杂细节".repeat(20)}`) });
  await h.command("start");
  assert.ok(h.editors[0].includes("完成条件"));
  assert.ok(h.editors[0].includes("必要限制"));
  assert.ok(!h.editors[0].includes("附加策略-19"));
  assert.ok((await h.status()).length < 700);
  assert.ok((await h.status(true)).includes("附加策略-19"));
  h.enqueue({ goal_achieved: false, reason: "重载回归未验证", unmet_conditions: ["重载不复活任务"], next_step: "运行重载测试" });
  const result = await h.settle();
  const text = result.entries[0].content;
  assert.ok(text.includes("重载不复活任务"));
  assert.ok(text.includes("运行重载测试"));
  assert.ok(text.length < 800);
  assert.ok(h.statuses.at(-1)?.includes("监督中"));
});

// These exercise the real subprocess boundary; only the external judge is a fixture.
function judgeEvents(verdict: any, noiseSize = 180_000): string {
  const assistant = { role: "assistant", content: [{ type: "text", text: JSON.stringify(verdict) }],
    usage: { input: 10, output: 20, totalTokens: 30 }, stopReason: "stop" };
  const tool = { role: "toolResult", toolName: "read", toolCallId: "large-read",
    content: [{ type: "text", text: "工具原件🙂".repeat(Math.ceil(noiseSize / 6)) }], isError: false };
  return [
    { type: "message_end", message: assistant },
    { type: "agent_end", messages: [tool, assistant], willRetry: false },
    { type: "agent_settled", aborted: false },
  ].map(row => JSON.stringify(row)).join("\n");
}

test("large agent_end cannot evict a valid final judgement", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ raw: judgeEvents(success()) });
  h.enqueue({ raw: judgeEvents(success()) });
  await h.settle();
  assert.equal(h.state.lifecycle, "completed");
  assert.equal(h.callCount(), 2, "cheap pass then deep verification");
});

test("failover logs the complete retry privately and preserves both attempts", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")],
    profile: { judgeFailover: true, judgeFailoverModel: "fixture/backup" } });
  const raw = judgeEvents(success());
  h.enqueue({ raw: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "not a JSON verdict" }], stopReason: "stop", usage: { input: 4, output: 6, totalTokens: 10 } } }) });
  const stderr = "retry diagnostic\n".repeat(2000);
  h.enqueue({ raw, stderr });
  h.enqueue({ raw, stderr });
  await h.settle();
  assert.equal(h.state.lifecycle, "completed");
  const attempts = h.audit().filter(row => row.event === "judge-attempt");
  assert.equal(attempts.length, 3, "primary failure, backup pass, then deep verification");
  assert.equal(attempts[2].tier, "L2");
  assert.equal(attempts[0].fullLogging, true, "every round keeps its raw log for later retrieval");
  assert.equal(attempts[0].errorKind, "parse");
  assert.equal(attempts[0].model, "fixture/primary");
  assert.equal(attempts[1].fullLogging, true);
  assert.equal(attempts[1].logComplete, true);
  assert.equal(attempts[1].model, "fixture/backup");
  assert.equal(attempts[0].callId, attempts[1].callId);
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
  assert.equal(h.callArgs(1).includes("--no-session"), true);
  const dir = attempts[1].logDir;
  assert.equal(fs.readFileSync(path.join(dir, "stdout.jsonl"), "utf8"), raw + "\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).stderr, stderr.slice(-2000));
  const request = JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8"));
  assert.equal(request.parentSessionId, path.basename(h.cwd));
  assert.match(request.prompt, /TASK: ENFORCE_CONTRACT/);
  assert.equal(h.callArgs(2).includes("--no-session"), true, "each round is an independent session");
  assert.equal(fs.existsSync(path.join(dir, "session.jsonl")), false, "native history lives in judge-sessions, not a per-attempt copy");
  assert.equal(fs.existsSync(path.join(dir, "stderr.log")), false);
  assert.equal(fs.existsSync(path.join(dir, "text.txt")), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).text, JSON.stringify(success()));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const file of ["request.json", "stdout.jsonl", "result.json"])
      assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  }
  const usage = h.audit().find(row => row.event === "judge-usage");
  assert.equal(usage.ms, attempts.reduce((sum, row) => sum + row.ms, 0), "usage covers every attempt of the round");
  assert.ok(usage.usage.totalTokens >= 40);
});

test("every judgement round keeps its own raw log, independent of success or failure", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ raw: "bad first answer" }); await h.settle();
  assert.equal(h.state.judgeFailures, 1);
  h.enqueue(success()); await h.settle();
  const attempts = h.audit().filter(row => row.event === "judge-attempt");
  assert.equal(attempts.length, 3, "failure round, retry round, then deep verification");
  for (const attempt of attempts) {
    assert.equal(attempt.fullLogging, true);
    assert.equal(attempt.logComplete, true);
    assert.ok(fs.existsSync(path.join(attempt.logDir, "stdout.jsonl")));
  }
});

for (const lifecycle of ["paused", "active"]) {
  test(`retry only judges while ${lifecycle}, clearing failures without running the main agent`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry(lifecycle, { iterations: 7, judgeFailures: 2 })] });
    h.enqueue({ goal_achieved: false, reason: "仍缺证据", next_step: "补证" });
    await h.command("retry");
    assert.equal(h.callCount(), 1);
    assert.equal(h.state.lifecycle, lifecycle);
    assert.equal(h.state.iterations, 7);
    assert.equal(h.state.judgeFailures, 0);
    assert.equal(h.sends.filter(s => s.triggerTurn).length, 0);
    assert.equal(h.callArgs(1).includes("--no-session"), true, "retry is still an independent round");
  });
}

test("failed retry while active honors the existing consecutive-failure pause limit", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active", { judgeFailures: 1 })], profile: { maxJudgeFailures: 2 } });
  h.enqueue({ raw: "bad retry" }); await h.command("retry");
  assert.equal(h.state.lifecycle, "paused");
  assert.equal(h.state.judgeFailures, 2);
  assert.equal(h.sends.length, 0);
});

test("log finalization failure rejects a valid verdict instead of claiming full logging succeeded", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")] });
  const id = h.enqueue(); const pending = h.command("retry"); await h.waitCall(id);
  const args = h.callArgs(id);
  const dir = fs.readdirSync(config.defaults.judgeLogDir).map(name => path.join(config.defaults.judgeLogDir, name)).find(dir => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8")).parentSessionId === path.basename(h.cwd); } catch { return false; }
  })!;
  fs.mkdirSync(path.join(dir, "result.json"));
  h.reply(id, success()); await pending;
  assert.equal(h.state.lifecycle, "paused");
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "logging");
  assert.equal(h.state.lastJudge.attempts[0].logComplete, false);
  assert.equal(h.sends.length, 0);
});

test("diagnose can read legacy audit errors after reload without inventing full logs", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused", { judgeFailures: 2 })] });
  fs.appendFileSync(config.defaults.logFile, JSON.stringify({ event: "judge-usage", sessionId: path.basename(h.cwd),
    ts: "2026-10-26T05:28:47.806Z", ok: false, model: "fixture/old-judge", error: "legacy judge 输出不是 JSON", stdoutTail: "old tail only" }) + "\n");
  await h.command("diagnose");
  assert.match(h.notifications.at(-1)!, /legacy judge 输出不是 JSON/);
  assert.match(h.notifications.at(-1)!, /旧版|摘要/);
  assert.match(h.notifications.at(-1)!, /retry/);
  assert.equal(h.callCount(), 0);
});

test("failed retry retains a classified diagnosis and failure count across reload", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused", { judgeFailures: 2 })] });
  h.enqueue({ raw: "bad retry" }); await h.command("retry");
  assert.equal(h.callCount(), 1);
  assert.equal(h.state.lifecycle, "paused");
  assert.equal(h.state.judgeFailures, 3);
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "parse");
  const dir = h.state.lastJudge.attempts[0].logDir;
  await h.event("session_start");
  await h.command("diagnose");
  assert.match(h.notifications.at(-1)!, /parse/);
  assert.ok(h.notifications.at(-1)!.includes(dir));
  assert.match(h.notifications.at(-1)!, /retry/);
  assert.equal(h.callCount(), 1);
  assert.equal(h.sends.length, 0);
});

for (const action of ["cancel", "switch-session", "resume", "pause"]) {
  test(`${action} discards an in-flight diagnostic retry without aborting the main agent`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry(action === "pause" ? "active" : "paused", { judgeFailures: 2 })] });
    const id = h.enqueue(); const pending = h.command("retry");
    await h.waitCall(id);
    if (action === "cancel") { h.select = "取消"; await h.command("cancel"); }
    else if (action === "switch-session") await h.switchSession();
    else await h.command(action);
    const before = structuredClone(h.entries);
    const sendsBefore = h.sends.length;
    h.reply(id, success()); await pending;
    assert.deepEqual(h.entries, before);
    assert.equal(h.sends.length, sendsBefore);
    assert.equal(h.aborts, 0);
    const logs = fs.readdirSync(config.defaults.judgeLogDir).filter(name => name.includes("-"));
    const dir = logs.map(name => path.join(config.defaults.judgeLogDir, name)).find(dir => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, "request.json"), "utf8")).parentSessionId === path.basename(h.cwd); } catch { return false; }
    })!;
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    assert.equal(saved.errorKind, "invalidated");
  });
}

test("retry completion still requires criterion evidence and never starts the main agent", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")] });
  h.enqueue({ goal_achieved: true, reason: "不能自报完成" }); await h.command("retry");
  assert.equal(h.state.lifecycle, "paused");
  h.enqueue(success()); await h.command("retry");
  assert.equal(h.state.lifecycle, "completed");
  assert.equal(h.sends.filter(s => s.triggerTurn).length, 0);
});

test("spawn failure is diagnosed without retrying the same missing command on a backup model", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")],
    profile: { judgeCommand: path.join(root, "missing-judge"), judgeFailover: true, judgeFailoverModel: "fixture/backup" } });
  await h.command("retry");
  assert.equal(h.state.lastJudge.attempts.length, 1);
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "spawn");
  assert.match(h.notifications.at(-1)!, /judgeCommand/);
  assert.equal(h.sends.length, 0);
});

test("session shutdown invalidates an owned judge before a reload replaces its runtime", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")] });
  const id = h.enqueue(); const pending = h.command("retry"); await h.waitCall(id);
  await h.event("session_shutdown", { reason: "reload" });
  const before = structuredClone(h.entries);
  h.reply(id, success()); await pending;
  assert.deepEqual(h.entries, before);
  assert.equal(h.sends.length, 0);
  assert.equal(h.aborts, 0);
});

test("timeout diagnostics retain complete output and never report completion", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")], profile: { judgeTimeoutMs: 300 } });
  const id = h.enqueue(); const pending = h.command("retry"); await h.waitCall(id); await pending;
  assert.equal(h.state.lifecycle, "paused");
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "timeout");
  const dir = h.state.lastJudge.attempts[0].logDir;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).errorKind, "timeout");
  assert.ok(fs.existsSync(path.join(dir, "stdout.jsonl")));
  assert.equal(h.sends.length, 0);
});

test("unwritable full-log location fails explicitly before launching a paid retry", async () => {
  const blocked = path.join(root, "not-a-log-directory"); fs.writeFileSync(blocked, "file");
  const h = await harness({ entries: [contractEntry(), stateEntry("paused")], profile: { judgeLogDir: blocked } });
  await h.command("retry");
  assert.equal(h.callCount(), 0);
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "logging");
  assert.match(h.notifications.at(-1)!, /日志|logging/);
  assert.equal(h.state.lifecycle, "paused");
});

test("a final assistant errorMessage blocks completion even when stopReason says stop", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ raw: JSON.stringify({ type: "message_end", message: { role: "assistant",
    content: [{ type: "text", text: JSON.stringify(success()) }], stopReason: "stop", errorMessage: "fixture final provider failure" } }) });
  await h.settle();
  assert.notEqual(h.state.lifecycle, "completed");
  assert.equal(h.state.judgeFailures, 1);
  assert.equal(h.state.lastJudge.attempts[0].errorKind, "provider");
});

for (const stopReason of ["toolUse", "error"]) {
  test(`a ${stopReason} assistant cannot pass as a completed JSON verdict`, async () => {
    const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
    h.enqueue({ raw: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(success()) }], stopReason,
      ...(stopReason === "error" ? { errorMessage: "fixture provider error" } : {}) } }) });
    await h.settle();
    assert.notEqual(h.state.lifecycle, "completed");
    assert.equal(h.state.judgeFailures, 1);
  });
}


const judgePrompts = (h: any) => h.audit().filter((row: any) => row.event === "judge-attempt").map((row: any) => h.promptOf(row.logDir));

function evidenceVerdict(file: string, overrides: Record<string, unknown> = {}) {
  return { goal_achieved: false, human_needed: false, reason: "部分完成",
    criteria_evidence: [{ criterion: baseContract.completion_criteria[0], evidence: `直接读取 ${file} 确认` }],
    unmet_conditions: [baseContract.completion_criteria[1]], ...overrides };
}

test("each round is an independent session but reuses the verified structured state", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const file = path.join(h.cwd, "evidence.md"); fs.writeFileSync(file, "verified content");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  await h.say("第二轮：继续核验其它条件");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  assert.equal(h.callArgs(1).includes("--no-session"), true);
  assert.equal(h.callArgs(2).includes("--no-session"), true);
  const [first, second] = judgePrompts(h);
  assert.match(first, /首次核验/);
  assert.match(second, /结构化状态/);
  assert.match(second, /已满足/);
  assert.ok(second.includes(file), "reused evidence is named so the judge need not re-read it");
  assert.match(second, /仍然有效、可直接复用的证据/);
  assert.doesNotMatch(second, /部分完成/, "previous round's free text is not replayed");
});

test("pause, resume and reload keep the structured state for the next round", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const file = path.join(h.cwd, "kept.md"); fs.writeFileSync(file, "kept");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  await h.command("pause"); await h.command("resume"); await h.event("session_start");
  await h.say("恢复后继续");
  h.enqueue({ goal_achieved: false, reason: "继续" }); await h.command("judge");
  assert.match(judgePrompts(h).at(-1)!, /已满足/);
});

test("cancel then start does not inherit the previous task's state", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const file = path.join(h.cwd, "old-task.md"); fs.writeFileSync(file, "old");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  h.select = "取消"; await h.command("cancel");
  h.editor = (prefill: string) => prefill; h.enqueue(candidate()); await h.command("start");
  h.enqueue({ goal_achieved: false, reason: "新任务" }); await h.command("judge");
  assert.match(judgePrompts(h).at(-1)!, /首次核验/);
});

test("confirming a changed contract resets the state instead of carrying old criteria", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const file = path.join(h.cwd, "old-contract.md"); fs.writeFileSync(file, "old");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  h.editor = (prefill: string) => prefill;
  h.enqueue({ ...candidate(), completion_criteria: ["新的完成条件"] }); await h.command("replan");
  h.enqueue({ goal_achieved: false, reason: "新契约" }); await h.command("judge");
  assert.match(judgePrompts(h).at(-1)!, /首次核验/);
});

test("a cloned main session and a rewound branch cannot reuse another task's state", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const file = path.join(h.cwd, "branch.md"); fs.writeFileSync(file, "branch");
  const before = structuredClone(h.entries);
  h.enqueue(evidenceVerdict(file)); await h.settle();
  await h.restoreBranch(before);
  await h.say("回退后继续");
  fs.writeFileSync(file, "changed after rewind");
  h.enqueue({ goal_achieved: false, reason: "回退后" }); await h.command("judge");
  assert.match(judgePrompts(h).at(-1)!, /失效|待重新核验/, "rewound evidence must not be reused blindly");
  await h.switchSession(h.entries);
  h.enqueue({ goal_achieved: false, reason: "新会话" }); await h.command("judge");
  assert.match(judgePrompts(h).at(-1)!, /首次核验/);
});

test("L0 keeps an unchanged unmet condition without spending a model call", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.enqueue({ goal_achieved: false, human_needed: false, reason: "仍缺证据",
    criteria_evidence: [], unmet_conditions: baseContract.completion_criteria }); await h.settle();
  assert.equal(h.callCount(), 1);
  await h.settle();
  assert.equal(h.callCount(), 1, "no new model call when nothing changed");
  assert.ok(h.audit().some(row => row.event === "judge-l0"));
  assert.equal(h.state.iterations, 2);
});

test("a completion claim is re-verified by a deep L2 call before the pause is allowed", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { enforceReadTools: true } });
  h.enqueue(success()); await h.settle();
  assert.equal(h.state.lifecycle, "completed");
  const attempts = h.audit().filter(row => row.event === "judge-attempt");
  assert.deepEqual(attempts.map(row => row.tier), ["L1", "L2"]);
  assert.ok(h.callArgs(1).includes("--no-tools"));
  assert.ok(h.callArgs(2).includes("--tools"));
  assert.match(attempts[1].escalation, /L1 声称完成/);
});

test("changed evidence is marked stale and only that condition is re-verified", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { enforceReadTools: true } });
  const file = path.join(h.cwd, "changed.md"); fs.writeFileSync(file, "v1");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  fs.writeFileSync(file, "v2");
  await h.say("第二轮：文件已改，请复核");
  h.enqueue({ goal_achieved: false, reason: "文件已改" }); await h.settle();
  const prompt = judgePrompts(h).at(-1)!;
  assert.match(prompt, /失效|待重新核验/);
  assert.doesNotMatch(prompt, /仍然有效、可直接复用的证据\n- \[.*changed\.md/, "a changed file is not offered as reusable");
  assert.equal(h.audit().filter(row => row.event === "judge-attempt").at(-1)!.tier, "L2");
});

test("a candidate with open questions asks for clarification instead of reporting abandonment", async () => {
  const h = await harness();
  h.editor = (prefill: string) => prefill;
  h.enqueue({ ...candidate(), open_questions: ["#31 是否已被取代？"] });
  await h.command("start");
  assert.equal(h.contract, undefined, "supervision must not start with unresolved questions");
  const notified = h.notifications.join("\n");
  assert.doesNotMatch(notified, /已放弃/);
  assert.match(notified, /澄清|待确认/);
  assert.ok(h.editors[0].includes("#31 是否已被取代"), "the question is shown in the editor");
});

test("answering the open questions re-infers the contract and only then starts", async () => {
  const h = await harness();
  let answered = false;
  h.editor = (prefill: string) => answered ? prefill : (answered = true, `${prefill}按 §G-98 已取代，视为闭合`);
  h.enqueue({ ...candidate(), open_questions: ["#31 是否已被取代？"] });
  h.enqueue(candidate());
  await h.command("start");
  assert.equal(h.callCount(), 2, "clarification feedback triggers a fresh inference");
  assert.equal(h.contract?.mission, baseContract.mission);
  assert.equal(h.state.lifecycle, "active");
});

test("a missing escalation agent is treated as unset, with a hint instead of a warning", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")],
    profile: { escalationAgent: "definitely-not-installed" } });
  await h.command("details");
  assert.match(h.notifications.at(-1)!, /escalation:.*未找到.*按未设置处理/);
  h.enqueue({ goal_achieved: false }); await h.settle();
  const prompt = judgePrompts(h).at(-1)!;
  assert.doesNotMatch(prompt, /升级诊断|escalation/);
  assert.equal(h.notifications.some(n => /definitely-not-installed/.test(n) && /警告|warning/i.test(n)), false);
});

test("a project-level escalation agent is discovered and named in the judgement prompt", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { escalationAgent: "escalation" } });
  fs.mkdirSync(path.join(h.cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(h.cwd, ".pi", "agents", "escalation.md"), "# escalation");
  h.enqueue({ goal_achieved: false }); await h.settle();
  assert.match(judgePrompts(h).at(-1)!, /escalation/);
  assert.match(judgePrompts(h).at(-1)!, /升级诊断/);
  await h.command("details");
  assert.match(h.notifications.at(-1)!, /escalation: escalation/);
});

test("resume explains the real state instead of claiming there is nothing to resume", async () => {
  const active = await harness({ entries: [contractEntry(), stateEntry("active")] });
  await active.command("resume");
  assert.match(active.notifications.at(-1)!, /监督中|正在进行/);
  assert.match(active.notifications.at(-1)!, /retry|pause/);
  assert.equal(active.state.lifecycle, "active");

  const orphan = await harness({ entries: [contractEntry(), stateEntry("paused")] });
  orphan.entries.splice(0, orphan.entries.length, stateEntry("paused"));
  await orphan.event("session_start");
  await orphan.command("resume");
  assert.match(orphan.notifications.at(-1)!, /缺少有效契约/);

  const done = await harness({ entries: [contractEntry(), stateEntry("completed")] });
  await done.command("resume");
  assert.match(done.notifications.at(-1)!, /已结束|已完成|start/);
});

test("supervision waits while an async subagent of this session is still running", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  const sessionId = path.basename(h.cwd);
  h.bus("subagent:async-started", { id: "run-1", sessionId });
  h.enqueue({ goal_achieved: false }); await h.settle();
  assert.equal(h.callCount(), 0, "no judgement while a child still runs");
  assert.ok(h.audit().some(row => row.event === "settle-deferred"));
  h.bus("subagent:async-complete", { runId: "run-1", sessionId });
  h.enqueue({ goal_achieved: false }); await h.settle();
  assert.equal(h.callCount(), 1);
  assert.equal(h.state.lifecycle, "active");
});

test("another session's subagent does not block this session, and stale starts stop blocking", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")] });
  h.bus("subagent:async-started", { id: "foreign", sessionId: "some-other-session" });
  h.enqueue({ goal_achieved: false }); await h.settle();
  assert.equal(h.callCount(), 1, "a foreign run must not gate this session");

  const stale = await harness({ entries: [contractEntry(), stateEntry("active")] });
  stale.bus("subagent:async-started", { id: "run-old", sessionId: path.basename(stale.cwd), startedAt: Date.now() - 3 * 60 * 60 * 1000 });
  stale.enqueue({ goal_achieved: false }); await stale.settle();
  assert.equal(stale.callCount(), 1, "a run that never reported completion cannot block forever");
});

test("a repeated no-progress verdict pauses instead of looping forever", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { stagnationRounds: 3 } });
  const same = { goal_achieved: false, human_needed: false, reason: "仍未完成",
    criteria_evidence: [], unmet_conditions: baseContract.completion_criteria,
    next_step: "派发只读核验，采集完整 Git 状态与锁记录" };
  for (let round = 0; round < 4; round += 1) { h.enqueue(same); await h.settle(); await h.say(`第 ${round + 2} 轮：剩余阻断都是人类批准门`); }
  assert.ok(h.say);
  assert.equal(h.state.lifecycle, "paused");
  assert.match(h.state.reason, /stagnation/);
  assert.ok(h.audit().some(row => row.event === "judge-stagnation"));
});

test("new evidence resets the stagnation counter", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { stagnationRounds: 3 } });
  const file = path.join(h.cwd, "new-evidence.md"); fs.writeFileSync(file, "v1");
  const stuck = { goal_achieved: false, human_needed: false, reason: "仍未完成",
    criteria_evidence: [], unmet_conditions: baseContract.completion_criteria, next_step: "再核验" };
  h.enqueue(stuck); await h.settle(); await h.say("第二轮");
  h.enqueue(stuck); await h.settle(); await h.say("第三轮");
  h.enqueue(evidenceVerdict(file)); await h.settle();
  assert.equal(h.state.lifecycle, "active", "new evidence must not be treated as stagnation");
});

test("the stagnation prompt shows the repeated next steps so the judge must change course", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { stagnationRounds: 2 } });
  const stuck = { goal_achieved: false, human_needed: false, reason: "仍未完成",
    criteria_evidence: [], unmet_conditions: baseContract.completion_criteria, next_step: "重复派发只读核验" };
  h.enqueue(stuck); await h.settle(); await h.say("第二轮");
  h.enqueue(stuck); await h.settle(); await h.say("第三轮");
  h.enqueue({ ...stuck, next_step: "确认人类批准门" }); await h.settle();
  const prompt = judgePrompts(h).at(-1)!;
  assert.match(prompt, /连续 \d+ 轮无新增证据/);
  assert.match(prompt, /重复派发只读核验/);
  assert.match(prompt, /human_needed/);
});

function installEscalationAgent(h: any) {
  fs.mkdirSync(path.join(h.cwd, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(h.cwd, ".pi", "agents", "escalation.md"),
    "---\nname: escalation\nthinking: low\n---\n判断哪些阻断需要人类，哪些仍可执行。\n");
}
const adjudication = (human: any[], executable: any[], reason = "判定") =>
  ({ human_required: human, executable, reason, confidence: "high" });

test("escalation turns an approval-only claim into executable work instead of pausing", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { escalationAgent: "escalation" } });
  installEscalationAgent(h);
  h.enqueue({ ...success(), human_needed: true, reason: "剩余都是人类批准门" });
  h.enqueue(adjudication([], [{ action: "重放 V5 采集并比对哈希", why: "只读可执行" }], "仍有可执行工作"));
  const result = await h.settle();
  assert.equal(h.state.lifecycle, "active", "must not pause when escalation finds executable work");
  assert.match(JSON.stringify(result), /重放 V5/);
  assert.ok(h.audit().some(row => row.event === "escalation-override"));
  assert.equal(h.state.escalations ?? 1, 1);
});

test("escalation confirms real human gates and pauses with the item list", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { escalationAgent: "escalation" } });
  installEscalationAgent(h);
  h.enqueue({ ...success(), human_needed: true });
  h.enqueue(adjudication([{ item: "安装批准", why: "不可逆" }], [], "需要人类"));
  const result = await h.settle();
  assert.equal(h.state.lifecycle, "paused");
  assert.match(h.state.reason, /escalation human gate/);
  assert.match(JSON.stringify(result), /安装批准/);
  assert.ok(h.audit().some(row => row.event === "escalation-human-gate"));
});

test("escalation calls are bounded per task, then the original human gate applies", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active", { escalations: 1 })], profile: { escalationMaxCalls: 1 } });
  installEscalationAgent(h);
  h.enqueue({ ...success(), human_needed: true });
  const result = await h.settle();
  assert.equal(h.state.lifecycle, "paused");
  assert.ok(h.audit().some(row => row.event === "escalation-skipped"));
  assert.match(JSON.stringify(result), /已暂停/);
});

test("stagnation consults escalation before pausing and continues on executable advice", async () => {
  const h = await harness({ entries: [contractEntry(), stateEntry("active")], profile: { stagnationRounds: 2, escalationAgent: "escalation" } });
  installEscalationAgent(h);
  const stuck = { goal_achieved: false, human_needed: false, reason: "仍未完成",
    criteria_evidence: [], unmet_conditions: baseContract.completion_criteria, next_step: "再核验" };
  h.enqueue(stuck); await h.settle(); await h.say("第二轮");
  h.enqueue(stuck); await h.settle(); await h.say("第三轮");
  h.enqueue(stuck);
  h.enqueue(adjudication([], [{ action: "补齐 89 项候选适用性登记" }], "可执行"));
  const result = await h.settle();
  assert.equal(h.state.lifecycle, "active");
  assert.match(JSON.stringify(result), /补齐 89 项候选适用性登记/);
});

test("a configured goal is no longer injected into contract inference", async () => {
  const h = await harness({ profile: { goal: "旧目标：优先 2a051f2f 的 #31" } });
  h.editor = (prefill: string) => prefill;
  h.enqueue(candidate());
  await h.command("start");
  const prompt = h.promptOf(h.audit().find((row: any) => row.kind === "bootstrap").logDir);
  assert.doesNotMatch(prompt, /2a051f2f/);
  assert.doesNotMatch(prompt, /用户固定目标/);
  assert.ok(h.audit().some((row: any) => row.event === "goal-ignored"));
  assert.equal(h.contract?.mission, baseContract.mission, "the confirmed contract still governs");
});
