import { test } from "node:test";
import assert from "node:assert/strict";
import { JudgeOutputParser, parseJsonObject } from "./judge.ts";

const finalEvent = (text: string, stopReason = "stop") => JSON.stringify({ type: "message_end", message: {
  role: "assistant", content: [{ type: "text", text }], stopReason,
  usage: { input: 4, output: 6, totalTokens: 10 },
} });

function parse(bytes: Buffer, chunkSize = bytes.length) {
  const parser = new JudgeOutputParser();
  for (let offset = 0; offset < bytes.length; offset += chunkSize) parser.push(bytes.subarray(offset, offset + chunkSize));
  return parser.finish();
}

test("LF framing preserves split UTF-8, Unicode separators and a final line without LF", () => {
  const verdict = '{"reason":"中文🙂\u2028段落\u2029仍在同一条JSON记录"}';
  const output = parse(Buffer.from(finalEvent(verdict)), 1);
  assert.equal(output.complete, true);
  assert.equal(output.text, verdict);
  assert.deepEqual(parseJsonObject(output.text), { reason: "中文🙂\u2028段落\u2029仍在同一条JSON记录" });
  assert.equal(output.usage?.totalTokens, 10);
});

test("authoritative message_end replaces deltas instead of appending to them", () => {
  const input = [
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: '{"reason":"partial' } },
    JSON.parse(finalEvent('{"reason":"final"}')),
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  const output = parse(Buffer.from(input), 7);
  assert.equal(output.text, '{"reason":"final"}');
  assert.equal(output.complete, true);
});

test("an ignored agent_end record larger than the framing bound cannot erase a final verdict", () => {
  const final = '{"goal_achieved":false,"next_step":"继续核验"}';
  const input = finalEvent(final) + "\n" + JSON.stringify({ type: "agent_end", messages: [{ content: "x".repeat(4_200_000) }] }) +
    '\n{"type":"agent_settled","aborted":false}\n';
  const output = parse(Buffer.from(input), 64_000);
  assert.equal(output.text, final);
  assert.equal(output.complete, true);
  assert.equal(output.lastEvent, "agent_settled");
});

test("a final JSON verdict larger than the old total-output cap is retained in full", () => {
  const verdict = JSON.stringify({ goal_achieved: false, reason: "证据".repeat(100_000) });
  const output = parse(Buffer.from(finalEvent(verdict) + "\n"), 2048);
  assert.equal(output.text, verdict);
  assert.equal(output.complete, true);
  assert.equal(parseJsonObject(output.text)?.reason, "证据".repeat(100_000));
});

test("a later empty assistant does not reuse a previous JSON-looking tool preamble", () => {
  const input = finalEvent('{"goal_achieved":true}') + "\n" +
    '{"type":"message_start","message":{"role":"assistant"}}\n' +
    '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"toolUse"}}\n';
  const output = parse(Buffer.from(input));
  assert.equal(output.complete, false);
  assert.equal(output.text, "");
  assert.equal(output.stopReason, "toolUse");
});

test("JSON-looking deltas without a final message cannot complete judgement", () => {
  const input = '{"type":"message_start","message":{"role":"assistant"}}\n' + JSON.stringify({
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: '{"goal_achieved":true}' },
  }) + "\n";
  const output = parse(Buffer.from(input));
  assert.equal(output.text, '{"goal_achieved":true}');
  assert.equal(output.complete, false);
});

test("a provider error after a verdict invalidates completion instead of using stale text", () => {
  const output = parse(Buffer.from(finalEvent('{"goal_achieved":true}') + '\n{"type":"error","error":"connection lost"}\n'));
  assert.equal(output.complete, false);
  assert.equal(output.stopReason, "error");
  assert.match(output.detail!, /connection lost/);
});

test("plain and fenced JSON remain supported for external judge commands", () => {
  for (const input of ['{\n "goal_achieved": false\n}\n', '```json\n{"goal_achieved":false}\n```\n']) {
    const output = parse(Buffer.from(input), 3);
    assert.equal(output.sawEvents, false);
    assert.deepEqual(parseJsonObject(output.text), { goal_achieved: false });
  }
});

import * as fsx from "node:fs";
import * as osx from "node:os";
import * as pathx from "node:path";
import { resolveJudgeExtension } from "./judge.ts";

test("resolves npm: provider packages from the agent npm directory only", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "judge-ext-"));
  try {
    const pkg = pathx.join(dir, "npm", "node_modules", "pi-provider-qoder");
    fsx.mkdirSync(pathx.join(pkg, "dist"), { recursive: true });
    fsx.writeFileSync(pathx.join(pkg, "package.json"), JSON.stringify({ name: "pi-provider-qoder", pi: { extensions: ["./dist/index.js"] } }));
    fsx.writeFileSync(pathx.join(pkg, "dist", "index.js"), "export default () => {}");
    assert.equal(resolveJudgeExtension("npm:pi-provider-qoder", dir, dir), pkg);
    assert.throws(() => resolveJudgeExtension("npm:missing-pkg", dir, dir), /找不到/);
    assert.throws(() => resolveJudgeExtension("npm:../escape", dir, dir), /包名无效/);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});

test("resolves explicit paths and rejects builtins or nonexistent entries", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "judge-ext-path-"));
  try {
    const file = pathx.join(dir, "provider.ts"); fsx.writeFileSync(file, "export default () => {}");
    assert.equal(resolveJudgeExtension(file, dir, dir), file);
    assert.throws(() => resolveJudgeExtension("builtin:mcp", dir, dir), /builtin/);
    assert.throws(() => resolveJudgeExtension(pathx.join(dir, "nope.js"), dir, dir), /不存在/);
  } finally { fsx.rmSync(dir, { recursive: true, force: true }); }
});
