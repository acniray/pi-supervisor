import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { indexAttempt, searchEvidence, clearIndex } from "./evidence-index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evidence-index-"));
const sid = "session-x";
after(() => fs.rmSync(root, { recursive: true, force: true }));

const logDir = path.join(root, "log-1");
fs.mkdirSync(logDir);
const rows = [
  { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "/data/x/matrix.md" } },
  { type: "tool_execution_end", toolCallId: "t1", toolName: "read",
    result: { content: [{ type: "text", text: "matrix: 0 PASS / 4 PARTIAL" }] }, isError: false },
  { type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: { path: "/data/x/docs", pattern: "sheet" } },
  { type: "tool_execution_end", toolCallId: "t2", toolName: "grep",
    result: { content: [{ type: "text", text: "sheet1 差异已登记" }] }, isError: false },
];
fs.writeFileSync(path.join(logDir, "stdout.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const indexRoot = path.join(root, "index");

test("indexes tool results as pointers and retrieves原文 from the exact line", () => {
  assert.equal(indexAttempt(indexRoot, sid, 3, logDir), 2);
  const byPath = searchEvidence(indexRoot, sid, { path: "/data/x/matrix.md" });
  assert.equal(byPath.length, 1);
  assert.equal(byPath[0].round, 3);
  assert.match(byPath[0].excerpt, /0 PASS/);
  const byKeyword = searchEvidence(indexRoot, sid, { keyword: "sheet1" });
  assert.equal(byKeyword[0].tool, "grep");
  assert.equal(searchEvidence(indexRoot, sid, { round: 2 }).length, 0);
  assert.equal(searchEvidence(indexRoot, sid, { round: 3, limit: 1 }).length, 1);
});

test("index survives malformed trailing lines and a missing log directory", () => {
  const dir = path.join(root, "log-2"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "stdout.jsonl"), JSON.stringify(rows[0]) + "\n" + JSON.stringify(rows[1]) + "\n" + '{"type":"tool_execu');
  assert.equal(indexAttempt(indexRoot, sid, 4, dir), 1);
  assert.equal(searchEvidence(indexRoot, sid, { round: 4 }).length, 1);
  assert.equal(indexAttempt(indexRoot, sid, 5, path.join(root, "missing")), 0);
});

test("clearIndex drops only the indexed pointers, not the raw logs", () => {
  clearIndex(indexRoot, sid);
  assert.equal(searchEvidence(indexRoot, sid, { round: 3 }).length, 0);
  assert.ok(fs.existsSync(path.join(logDir, "stdout.jsonl")));
});
