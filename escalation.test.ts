import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { escalationPrompt, loadAgentDefinition, parseAdjudication } from "./escalation.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-escalation-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("loads an agent definition with frontmatter, falling back to the project dir", () => {
  const project = path.join(root, "proj"); const agents = path.join(project, ".pi", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "escalation.md"),
    "---\nname: escalation\nmodel: qoder-cn/Qwen3.8-Max\nthinking: high\ntools: read,grep\n---\n诊断并给出结论。\n");
  const found = loadAgentDefinition("escalation", path.join(project, "worktree", "r3"), path.join(root, "nouser"));
  assert.equal(found.definition?.name, "escalation");
  assert.equal(found.definition?.model, "qoder-cn/Qwen3.8-Max");
  assert.equal(found.definition?.thinking, "high");
  assert.deepEqual(found.definition?.tools, ["read", "grep"]);
  assert.match(found.definition!.body, /诊断并给出结论/);
  assert.equal(loadAgentDefinition("missing-agent", project, path.join(root, "nouser")).definition, undefined);
});

test("parses the adjudication JSON and drops malformed entries", () => {
  const parsed = parseAdjudication(`\`\`\`json
{"human_required":[{"item":"安装批准","why":"不可逆"},{"item":""},"D1-D4 裁定"],
 "executable":[{"action":"重放 V5 采集","why":"只读"},"补登记"],
 "reason":"两项人类门，两项可执行","confidence":"high"}`)!
  assert.deepEqual(parsed.humanRequired.map(item => item.item), ["安装批准", "D1-D4 裁定"]);
  assert.deepEqual(parsed.executable.map(item => item.action), ["重放 V5 采集", "补登记"]);
  assert.equal(parsed.confidence, "high");
  assert.equal(parseAdjudication("not json"), undefined);
  assert.equal(parseAdjudication(undefined), undefined);
});

test("the escalation prompt separates human gates from executable work", () => {
  const prompt = escalationPrompt({ agent: "escalation", mission: "M", criteria: ["C1"],
    unmet: ["U1"], conflicts: [], report: "R", judgeReason: "未完成", judgeNextStep: "再核验", round: 7 });
  assert.match(prompt, /TASK: ESCALATION_ADJUDICATION/);
  assert.match(prompt, /只有需要人类权限/);
  assert.match(prompt, /不得把"再核验一次"当作 human_required/);
  assert.match(prompt, /human_required/);
});
