import * as fs from "node:fs";
import { findAgent, type AgentLookup } from "./agent-lookup.ts";

/**
 * Escalation is a real adjudication call, not a hint: the configured
 * escalation agent's persona is loaded from its markdown definition and run
 * through the same owned-subprocess transport as the judge.
 */
export interface AgentDefinition {
  name: string;
  path: string;
  body: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}

export interface EscalationAdjudication {
  humanRequired: Array<{ item: string; why?: string }>;
  executable: Array<{ action: string; why?: string }>;
  reason?: string;
  confidence?: string;
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (match) meta[match[1].toLowerCase()] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return { meta, body: text.slice(end + 4).trim() };
}

export function loadAgentDefinition(name: string | undefined, cwd: string, agentDir?: string): { definition?: AgentDefinition; lookup: AgentLookup } {
  const lookup = findAgent(name, cwd, agentDir);
  if (!lookup.name || !lookup.path) return { lookup };
  try {
    const { meta, body } = parseFrontmatter(fs.readFileSync(lookup.path, "utf8"));
    const tools = (meta.tools || "").split(",").map(item => item.trim()).filter(Boolean);
    return { lookup, definition: { name: lookup.name, path: lookup.path, body,
      model: meta.model, thinking: meta.thinking, tools: tools.length ? tools : undefined } };
  } catch {
    return { lookup };
  }
}

export function escalationPrompt(input: {
  agent: string; mission: string; criteria: string[]; unmet: string[]; conflicts: string[];
  report: string; judgeReason?: string; judgeNextStep?: string; round: number;
}): string {
  return `TASK: ESCALATION_ADJUDICATION

你是升级诊断者（${input.agent}）。监督判官与主 Agent 出现分歧：判官仍要求继续核验，主 Agent 声称剩余阻断全部需要人类批准。请判定**哪些阻断真的是人类门，哪些仍可由 Agent 执行**，不要给泛泛建议。

## 任务终点
${input.mission}

## 完成条件
${input.criteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}

## 结构化状态中的未闭环项
${input.unmet.length ? input.unmet.map(item => `- ${item}`).join("\n") : "(无)"}

## 冲突/缺失记录
${input.conflicts.length ? input.conflicts.map(item => `- ${item}`).join("\n") : "(无)"}

## 判官上一轮结论
理由：${input.judgeReason || "(无)"}
建议下一步：${input.judgeNextStep || "(无)"}

## 主 Agent 最近汇报（节选）
${input.report.slice(0, 3500) || "(无)"}

核验轮次：${input.round}

判断规则：
1. 只有需要人类权限、批准、授权、外部凭据、业务裁定或不可逆操作的事项才算 human_required。
2. 需要读文件、跑测试、比对原件、重放采集、补登记等，都属于 executable，即使工作量大。
3. 不得把"再核验一次"当作 human_required，也不得把真人类门说成可执行。
4. 无法判断时归入 human_required 并在 why 中说明缺什么信息。

严格输出 JSON：
{
  "human_required": [{"item": "待批事项", "why": "为什么必须人类"}],
  "executable": [{"action": "本轮可执行的具体动作（含目标文件/命令）", "why": "为什么 Agent 能做"}],
  "reason": "一句话结论",
  "confidence": "high|medium|low"
}`;
}

export function parseAdjudication(raw: string | undefined): EscalationAdjudication | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let value: any;
  try { value = JSON.parse(cleaned.slice(start, end + 1)); } catch { return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const texts = (input: unknown, key: string) => (Array.isArray(input) ? input : []).flatMap((item: any) => {
    const text = typeof item === "string" ? item : item?.[key];
    return typeof text === "string" && text.trim()
      ? [{ text: text.trim(), why: typeof item?.why === "string" ? item.why : undefined }]
      : [];
  });
  return {
    humanRequired: texts(value.human_required, "item").map(({ text, why }) => ({ item: text, why })),
    executable: texts(value.executable, "action").map(({ text, why }) => ({ action: text, why })),
    reason: typeof value.reason === "string" ? value.reason : undefined,
    confidence: typeof value.confidence === "string" ? value.confidence : undefined,
  };
}
