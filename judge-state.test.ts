import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { applyVerdict, canShortCircuit, fingerprintFile, invalidate, needsDeepCheck, readState,
  snapshotRepo, stateDigest, writeState, type TaskState } from "./judge-state.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-judge-state-"));
const stateRoot = path.join(root, "state");
after(() => fs.rmSync(root, { recursive: true, force: true }));

const contract = ["取消后不再续跑", "重载不复活任务"];
const contractKey = "k1";
const sid = "session-a";

function verdict(overrides: Record<string, unknown> = {}) {
  return { goal_achieved: false, human_needed: false, reason: "还没完成",
    criteria_evidence: [{ criterion: contract[0], evidence: "已读取 /tmp/x.md 并确认" }],
    unmet_conditions: [contract[1]], ...overrides } as any;
}

test("verdict becomes per-criterion state with file evidence fingerprints", () => {
  const file = path.join(root, "evidence.md"); fs.writeFileSync(file, "内容");
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 1, criteria: contract, cwd: root,
    verdict: verdict({ criteria_evidence: [{ criterion: contract[0], evidence: `读取 ${file}` }] }),
    report: "第一轮汇报", repo: { head: "abc", dirty: [] } });
  assert.equal(state.criteria[0].status, "met");
  assert.equal(state.criteria[0].evidence[0].kind, "file");
  assert.equal(state.criteria[0].evidence[0].fingerprint, fingerprintFile(file));
  assert.equal(state.criteria[1].status, "unmet");
  assert.match(stateDigest(state), /已满足/);
});

test("changed file invalidates its evidence, unchanged file stays reusable", () => {
  const file = path.join(root, "changing.md"); fs.writeFileSync(file, "v1");
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 1, criteria: contract, cwd: root,
    verdict: verdict({ criteria_evidence: [{ criterion: contract[0], evidence: `读取 ${file}` }] }), report: "r1" });
  assert.equal(invalidate(state, { head: "h", dirty: [] }, root).stale.length, 0);
  fs.writeFileSync(file, "v2");
  const afterChange = invalidate(state, { head: "h", dirty: [] }, root);
  assert.equal(afterChange.stale.length, 1);
  assert.equal(state.criteria[0].status, "stale");
});

test("a test result survives only while its commit and dirty set are unchanged", () => {
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 1, criteria: contract, cwd: root,
    verdict: verdict({ criteria_evidence: [{ criterion: contract[0], evidence: "go test ./... 全绿" }],
      unmet_conditions: [] }), report: "r1", repo: { head: "c1", dirty: [] } });
  assert.equal(state.criteria[0].evidence[0].kind, "test");
  assert.equal(invalidate(state, { head: "c1", dirty: [] }, root).stale.length, 0);
  assert.equal(invalidate(state, { head: "c2", dirty: [] }, root).stale.length, 1);
});

test("unknown external evidence is always re-verified, never reused silently", () => {
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 1, criteria: contract, cwd: root,
    verdict: verdict({ criteria_evidence: [{ criterion: contract[0], evidence: "短信网关返回值正确" }],
      unmet_conditions: [] }), report: "r1" });
  assert.equal(state.criteria[0].evidence[0].kind, "other");
  assert.equal(invalidate(state, { head: "h", dirty: [] }, root).stale.length, 1);
  assert.match(needsDeepCheck(state, { stale: state.criteria, reason: "" })!, /失效|原始来源/);
});

test("L0 short-circuit only fires for a stable unmet condition, never for completion", () => {
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 1, criteria: contract, cwd: root,
    verdict: verdict({ criteria_evidence: [], unmet_conditions: [contract[1]] }), report: "r1" });
  const quiet = canShortCircuit(state, state.lastReportHash!, { stale: [], reason: "" });
  assert.match(quiet!, /未满足/);
  assert.equal(canShortCircuit(state, "另一份汇报", { stale: [], reason: "" }), undefined);
  assert.equal(canShortCircuit({ ...state, conflicts: ["冲突"] }, state.lastReportHash!, { stale: [], reason: "" }), undefined);
  assert.equal(canShortCircuit({ ...state, escalation: "candidate-completion" }, state.lastReportHash!, { stale: [], reason: "" }), undefined);
  assert.equal(canShortCircuit(undefined, "x", { stale: [], reason: "" }), undefined);
});

test("state round-trips, rejects another contract, and survives corrupt or foreign-branch files", () => {
  const state = applyVerdict(undefined, { sessionId: sid, contractKey, round: 3, criteria: contract, cwd: root, branchTip: "tip-1",
    verdict: verdict({ criteria_evidence: [], unmet_conditions: contract }), report: "r3" });
  writeState(stateRoot, state);
  assert.equal(readState(stateRoot, sid, contractKey, [])?.round, 3);
  assert.equal(readState(stateRoot, sid, "other-contract", []), undefined);
  assert.equal(readState(stateRoot, sid, contractKey, ["only-other-branch"]), undefined);
  fs.writeFileSync(path.join(stateRoot, `${createHash("sha256").update(sid).digest("hex").slice(0, 16)}.json`), "{broken");
  assert.equal(readState(stateRoot, sid, contractKey, ["tip-1"]), undefined, "foreign branch must be rejected");
});

test("repo snapshot tolerates a non-git directory", () => {
  assert.equal(snapshotRepo(path.join(root, "not-a-repo")), undefined);
});
