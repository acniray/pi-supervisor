import * as fs from "node:fs";
import * as path from "node:path";
import { hashText } from "./judge-state.ts";

/**
 * Pointer-only index over each attempt's raw stdout.jsonl. It never copies tool
 * output: a hit points at the exact JSONL line, so retrieval returns原文.
 */

export interface EvidenceEntry {
  round: number;
  logDir: string;
  line: number;
  tool?: string;
  path?: string;
  claim?: string;
  criterionIds?: string[];
}

export interface EvidenceQuery {
  criterionId?: string;
  path?: string;
  round?: number;
  keyword?: string;
  limit?: number;
}

export interface EvidenceHit extends EvidenceEntry {
  excerpt: string;
}

function indexPath(root: string, sessionId: string): string {
  return path.join(root, `${hashText(sessionId)}.jsonl`);
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") rows.push(value as Record<string, unknown>);
    } catch { /* a killed writer can leave one partial line */ }
  }
  return rows;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: string; text: string } =>
    Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string")
    .map(block => block.text).join("\n");
}

/** Append pointers for one finished attempt. Safe to call repeatedly per attempt. */
export function indexAttempt(root: string, sessionId: string, round: number, logDir: string): number {
  const stdout = path.join(logDir, "stdout.jsonl");
  if (!fs.existsSync(stdout)) return 0;
  const starts = new Map<string, { tool?: string; path?: string }>();
  const entries: EvidenceEntry[] = [];
  const rows = readJsonl(stdout);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.type === "tool_execution_start") {
      const args = (row.args || {}) as Record<string, unknown>;
      starts.set(String(row.toolCallId), {
        tool: typeof row.toolName === "string" ? row.toolName : undefined,
        path: typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined,
      });
    } else if (row.type === "tool_execution_end") {
      const start = starts.get(String(row.toolCallId)) || {};
      const result = (row.result || {}) as Record<string, unknown>;
      const text = textOf(result.content);
      entries.push({
        round, logDir, line: index + 1, tool: start.tool || (typeof row.toolName === "string" ? row.toolName : undefined),
        path: start.path, claim: text ? text.slice(0, 400) : undefined,
      });
    }
  }
  if (!entries.length) return 0;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = indexPath(root, sessionId);
    fs.appendFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  } catch { return 0; }
  return entries.length;
}

function excerptAt(entry: EvidenceEntry, limit = 700): string {
  const stdout = path.join(entry.logDir, "stdout.jsonl");
  let line = "";
  try {
    const handle = fs.openSync(stdout, "r");
    try {
      const size = fs.fstatSync(handle).size;
      const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      line = buffer.toString("utf8").split("\n")[entry.line - 1] || "";
    } finally { fs.closeSync(handle); }
  } catch { return ""; }
  try {
    const row = JSON.parse(line);
    const result = row.type === "tool_execution_end" ? (row.result || {}) : {};
    return textOf(result.content).slice(0, limit);
  } catch { return ""; }
}

/** Query is only made when the caller has a concrete gap; never a fixed per-round cost. */
export function searchEvidence(root: string, sessionId: string, query: EvidenceQuery): EvidenceHit[] {
  const limit = Math.min(Math.max(query.limit || 5, 1), 20);
  const rows = readJsonl(indexPath(root, sessionId)) as unknown as EvidenceEntry[];
  const keyword = query.keyword?.toLowerCase();
  const hits: EvidenceHit[] = [];
  for (const entry of rows.reverse()) {
    if (query.round !== undefined && entry.round !== query.round) continue;
    if (query.path && entry.path !== query.path) continue;
    if (query.criterionId && !(entry.criterionIds || []).includes(query.criterionId)) continue;
    if (keyword && !(`${entry.claim || ""} ${entry.path || ""}`.toLowerCase().includes(keyword))) continue;
    const excerpt = excerptAt(entry);
    if (!excerpt) continue;
    hits.push({ ...entry, excerpt });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function clearIndex(root: string, sessionId: string): void {
  try { fs.rmSync(indexPath(root, sessionId), { force: true }); } catch { /* best effort */ }
}
