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
const response = 'reply-' + count + '.json';
let done = false;
const watcher = fs.watch('.', check);
function check() {
  if (done || !fs.existsSync(response)) return;
  let value; try { value = JSON.parse(fs.readFileSync(response, 'utf8')); } catch { return; }
  done = true; watcher.close();
  console.log(value.raw === undefined ? JSON.stringify(value) : value.raw);
  process.exitCode = value.code || 0;
}
fs.writeFileSync('call-' + count + '.json', JSON.stringify(process.argv.slice(2)));
check();
`, { mode: 0o755 });
const config: any = { defaults: {
  judgeCommand: judgePath, judgeModel: "fixture/primary", judgeFailover: false,
  judgeTimeoutMs: 2000, bootstrapTimeoutMs: 2000,
  logFile: path.join(root, "verdicts.jsonl"), stopFile: path.join(root, "STOP"),
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
  const pi: any = {
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
    enqueue(value?: any) { const id = ++responseIndex; if (value !== undefined) this.reply(id, value); return id; },
    reply(id: number, value: any) { fs.writeFileSync(path.join(cwd, `reply-${id}.json`), JSON.stringify(value)); },
    waitCall: (id: number) => waitFile(path.join(cwd, `call-${id}.json`)),
    callCount: () => Number(fs.existsSync(path.join(cwd, "judge-count")) ? fs.readFileSync(path.join(cwd, "judge-count"), "utf8") : 0),
    settle: (outcome = "completed") => event("agent_before_settle", { outcome, context: { pendingMessages: [], contextMessages: [], contextEntries: [] } }),
    async status(details = false) { await command(details ? "details" : "status"); return notifications.at(-1)!; },
    async switchSession(next: any[] = []) { entries = structuredClone(next); sessionId = "another-session"; await event("session_start"); },
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
  assert.equal(h.callCount(), 1);
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
