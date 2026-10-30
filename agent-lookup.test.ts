import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { escalationHint, findAgent } from "./agent-lookup.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-lookup-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const userDir = path.join(root, "user");
fs.mkdirSync(path.join(userDir, "agents"), { recursive: true });
fs.writeFileSync(path.join(userDir, "agents", "user-level.md"), "# agent");

test("finds a user-level agent and reports its file", () => {
  const found = findAgent("user-level", root, userDir);
  assert.equal(found.name, "user-level");
  assert.equal(found.path, path.join(userDir, "agents", "user-level.md"));
});

test("finds a project-level agent from a nested cwd or worktree", () => {
  const project = path.join(root, "repo");
  const nested = path.join(project, "worktree", "r3");
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(project, ".pi", "agents", "escalation.md"), "# agent");
  const found = findAgent("escalation", nested, userDir);
  assert.equal(found.path, path.join(project, ".pi", "agents", "escalation.md"));
  assert.ok(found.searched.some(entry => entry.includes(path.join(project, ".pi", "agents"))));
});

test("a missing agent is empty rather than an error, with the searched paths kept for the hint", () => {
  const missing = findAgent("nope", root, userDir);
  assert.equal(missing.name, undefined);
  assert.ok(missing.searched.length >= 2);
  assert.match(escalationHint(missing, "nope"), /未找到.*按未设置处理/);
  assert.match(escalationHint(findAgent(undefined, root, userDir)), /未配置/);
});

test("rejects unsafe names instead of probing arbitrary paths", () => {
  for (const name of ["../secret", "a b", "", "x/y"]) {
    const found = findAgent(name, root, userDir);
    assert.equal(found.name, undefined);
    assert.equal(found.searched.length, 0);
  }
});
