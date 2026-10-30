import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Locate an escalation subagent by name across the same places pi-subagents
 * loads agents from: the user agent dir and `<project>/.pi/agents` for the cwd
 * and its ancestors (worktrees often keep agents at the repository root).
 * A missing agent is not an error: callers treat it as "not configured".
 */
export interface AgentLookup {
  name?: string;
  path?: string;
  searched: string[];
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const MAX_ANCESTORS = 6;

export function findAgent(name: string | undefined, cwd: string, agentDir?: string): AgentLookup {
  const trimmed = (name || "").trim();
  if (!trimmed) return { searched: [] };
  if (!NAME.test(trimmed)) return { searched: [] };
  const searched: string[] = [];
  const candidates: string[] = [];
  const home = agentDir || path.join(os.homedir(), ".pi", "agent");
  candidates.push(path.join(home, "agents", `${trimmed}.md`));
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    candidates.push(path.join(dir, ".pi", "agents", `${trimmed}.md`));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const file of candidates) {
    searched.push(file);
    try { if (fs.statSync(file).isFile()) return { name: trimmed, path: file, searched }; } catch { /* keep looking */ }
  }
  return { searched };
}

/** One-line hint for diagnose/details; empty text means "treat as unset". */
export function escalationHint(lookup: AgentLookup, configured?: string): string {
  if (lookup.name) return `escalation: ${lookup.name}（${lookup.path}）`;
  if (!configured?.trim()) return "escalation: 未配置（按未设置处理）";
  return `escalation: \`${configured.trim()}\` 未找到，按未设置处理（已搜索 ${lookup.searched.length} 处）`;
}
