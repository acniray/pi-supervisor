# Judge Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for one cohesive implementation; one read-only final reviewer checks the whole diff.

**Goal:** Reliable judge output, automatic full retry diagnostics, and judge-only recovery.
**Architecture:** Move subprocess transport and streaming state into judge.ts. Keep contracts, lifecycle and conservative completion gating in index.ts; extend the existing real-handler fixture.
**Tech Stack:** TypeScript, Node built-ins, node:test, no new dependency.
**Spec:** docs/superpowers/specs/2026-10-26-judge-recovery-design.md

## Global Constraints
- Preserve configured models, config values, failure/iteration limits and user-owned contracts.
- First attempt lightweight; retries full before process spawn. Private local artifacts.
- No main-agent aborts, hidden business continuation, unlimited retries or stale result side effects.
- Current checkout was clean at 3338a3f; work is on fix/judge-retry-diagnostics, one writer. No new worktree or external writer.
- No live paid model requests. Deployment must preserve installed config/audit data.

## Review Focus
- A retry races with cancel, resume or session replacement; no stale state or next turn.
- A provider emits valid-looking JSON then toolUse/error; do not accept an interim verdict.
- Large JSONL records, chunk splits and missing final newline; preserve authoritative text.
- Full-log setup/write fails; truthful errors and no leaked handles/paid fallback loop.
- A fallback succeeds after primary failure; preserve both attempts, elapsed time and usage.

### Task 1: Reproduce transport and retry logging failures
Files: supervisor.test.ts.
- [x] Extend only the external fake judge with stderr/persistent-session support.
- [x] Add assertions for a >120k agent_end with a valid verdict, first-vs-retry logs, distinct primary/backup attempts, and manual retry without main-agent turns.
- [x] Run focused tests; confirm behavioral failures on baseline.

### Task 2: Implement transport and per-attempt diagnostics
Files: judge.ts (new), judge.test.ts (new), index.ts.
Interfaces: runJudgeOnce(RunJudgeOnceOptions): Promise<JudgeResult>; JudgeOutputParser consumes Buffer and produces text/usage/stop diagnostics; JudgeResult includes attempts.
- [x] Add failing parser cases for UTF-8 splitting, unterminated LF, authoritative message replacement, toolUse/error and large records.
- [x] Implement independent framing/final-message state, actual byte counts, private full logs, explicit error categories and close/abort cleanup.
- [x] Move only judge transport/usage primitives out of index.ts; retain existing public lifecycle.
- [x] Wire retry contexts, per-attempt audit, correct combined usage/time.
- [x] Run transport and handler tests; resolve failures before continuing.

### Task 3: Diagnose and judge-only retry
Files: index.ts, supervisor.test.ts.
- [x] Add RED cases for retry paused/active, counts, restored diagnostics and invalidated late results.
- [x] Add diagnose/retry handlers, session-bound fault summaries, recovery guidance, retry-only no-turn behavior.
- [x] Run the entire suite.

### Task 4: Documentation, independent review, deployment
Files: README.md, config.example.json, .gitignore, installed extension copy.
- [x] Document retry logging semantics, paths/privacy, diagnose/retry and reload.
- [x] Run node --test *.test.ts, module import, git diff --check.
- [x] Fresh read-only review of full diff, targeted regression fixes if needed.
- [x] Back up installed implementation; synchronize source module/tests/docs, not config.json/verdicts.jsonl. Verify checksums and real offline pi loading.
- [x] Report exact verification and required /reload; do not claim live provider recovery.

## Execution ledger
- Baseline: node --test *.test.ts — 60 passed, 0 failed.
- Decision: user said “修复吧” after confirming the design; execute now without another approval round. Parent is sole writer; scout only inspected immutable HEAD.
- RED: eight transport/retry/terminal-message tests failed on original implementation; later retry-limit, log-completeness and legacy-diagnosis regressions also failed before their fixes.
- Tasks 1–3 implemented: node --test *.test.ts — 87 passed, 0 failed. Large final messages/agent_end, split UTF-8, primary+backup usage, full logs, finalization failures, restored diagnostics and cancel/pause/resume/session-switch are covered.
- Ruling: baseline tsc already reported TS2367 after ensureContract mutates lifecycle asynchronously. Add a Lifecycle assertion at that guard, retaining its runtime check, to make type verification usable; no behavioral change.
- Source real pi offline loading succeeds and registers --supervise. A real pi subprocess against a localhost SSE fixture also persisted native system/assistant session messages and full raw logs at private permissions (no paid provider).
- Final review first failed with upstream_unavailable_error; exactly one same-channel retry completed. Review found an errorMessage + stop conflict; regression failed before the fix, then full suite passed 88/88 and tsc passed.
- Final Ruling: reject the review permission finding — umask only removes permission bits, never adds them. An explicit umask 022 experiment produced 0700/0600/0600, and handler/native probes also assert private permissions. No redundant chmod added; no security regression is accepted.
- Final Ruling: keep the inclusive 4,000,000 UTF-16-code-unit framing bound, which bounds JS buffer storage. It is not a Unicode display-character limit; README now states the exact units and inclusive boundary. Changing > to >= would reject a supported boundary record.
- Final acceptance: installed copy synchronized (including judge.ts); installed 88/88 tests and real pi offline loading passed. SHA-256 confirms installed code matches source and config.json/verdicts.jsonl are unchanged. Backup: /home/ubuntu/.pi/agent/backups/pi-supervisor/20261026T063842Z-before-judge-recovery. Current sessions need /reload; no paid-provider recovery is claimed. Source changes are retained on fix/judge-retry-diagnostics. In the follow-up the user authorized committing/pushing that branch; main is not merged or rewritten, and private runtime data stays untracked.
