# Judge Session Reuse Implementation Plan

> **For agentic workers:** Use executing-plans for this cohesive transport/lifecycle change; parent is sole writer and one read-only review checks the final diff.

**Goal:** Reuse one native judge session for an active supervision task, without implementing memory or retrieval.
**Architecture:** Persist task-bound session identity in main-session state. Resume that file in judge.ts under a per-file writer lock; keep per-attempt diagnostic snapshots separate.
**Tech Stack:** TypeScript, Node built-ins, pi native JSONL, node:test; no added dependency.
**Spec:** docs/superpowers/specs/2026-10-26-judge-session-reuse-design.md

## Global Constraints
- No structured memory, retrieval tools, skills, vector DB or resident judge service.
- Preserve user's models/config values, timeout/limits, evidence gate and judge-only retry semantics.
- Bootstrap/candidate replan remains separate; confirmed tasks gain native continuity.
- One source writer on feat/reuse-judge-session; no worktree/merge/push requested.

## Review Focus
- Cancel/resume races cannot create concurrent writers to the same native file.
- A cloned/switched/navigated main session cannot consume a sibling task's judge future.
- Native JSONL after killed processes and unfinished tool calls remains safely resumable.
- Full diagnostic snapshots keep the same native session identity and do not overwrite history.
- Reusing a path must actually restore prior assistant/tool history in a real model request.

### Task 1 — RED handler regressions
Files: supervisor.test.ts.
- [x] Make fake external judge append native messages and record actual startup context instead of replacing the file.
- [x] Assert same file/ID and prior history on second enforce/manual/retry/failover; retain lifecycle/permission assertions.
- [x] Assert persistence through reload and reset through cancellation/new task/replan/session switch.
- [x] Run focused tests and record intended failures.

### Task 2 — Native session transport
Files: judge-session.ts (new if focused helper needed), judge.ts, judge.test.ts / judge-session.test.ts.
- [x] Implement private session create/validate, per-file serialized use, recovery of complete native records and audit snapshots.
- [x] Add RED tests for cancelled queued writers and failed-attempt history before implementing each seam.
- [x] Keep authoritative streaming final-message gate unchanged.
- [x] Run focused transport tests.

### Task 3 — Bind lifecycle and prompts
Files: index.ts, supervisor.test.ts.
- [x] Persist/restore owner-bound task token, stable contract fingerprint and native session association.
- [x] Wire enforce/manual/retry/failover to the same file; rotate on task/contract changes.
- [x] Keep current branch boundaries, current contract authority and diagnostic visibility.
- [x] Run full suite and typecheck.

### Task 4 — Native integration and delivery
Files: native local integration test, README.md, config.example.json, .gitignore.
- [x] Verify real pi second HTTP request contains first-round messages/tool evidence using localhost SSE.
- [x] Run full tests/types/import/offline pi loading and one independent read-only review.
- [x] Sync installed module files, preserving config.json, verdicts.jsonl and existing judge logs/sessions.
- [x] Report commands, evidence and /reload requirement. Do not auto-push.

## Ledger
- Baseline a343fc0: 88 tests passing.
- User explicitly deferred memory and chose native session continuity; implementation is bounded to that scope.
- RED: seven handler tests failed for missing continuous history/ID and owner/branch isolation; the reload-shutdown race also failed before adding cleanup.
- Implemented stable session identity/checkpoint state, private native-file helper, reload-shared writer queue, per-attempt immutable snapshots and lifecycle isolation.
- Native integration: real pi + isolated localhost SSE provider restored prior assistant and read-tool result across models, excluded a sibling future on rewind, and retried an interrupted stream without replaying partial assistant text. No paid provider called.
- Verification: PI_SUPERVISOR_TEST_PI=/home/ubuntu/.local/bin/pi node --test *.test.ts — 103/103 passed, 0 skipped; full tsc and git diff --check pass.
- Ruling: bootstrap/candidate replan stays isolated until confirmation; this prevents an abandoned candidate from polluting the established task. Reuse is for confirmed-task judgements only.
- Final read-only review: OK with notes, no P0/P1. Fixed existing loose native-file/directory permissions by rejecting unsafe reuse, and persisted native leaf immediately before verdict application; both regression tests failed first. Final full suite including native integration: 106/106 passed, no skipped tests; tsc/diff clean.
- Ruling: null is an intentional saved EMPTY branch checkpoint; undefined follows latest. Restored associations with missing leaf are rejected rather than coerced to null. Normalizing null to latest would leak abandoned first-attempt history; explicit-root regression passes.
- Ruling: sessionReused means that the selected native branch already had messages, not that its last verdict succeeded. A custom marker or failed latest turn does not erase earlier valid history; actual provider filtering and interrupted-stream integration validate safe continuation.
- Delivery: installed helper/transport/entrypoint/tests/docs synchronized, installed native-inclusive suite 106/106 passed, real pi offline loading passed. Source and installed modules match; config SHA and pre-existing audit bytes preserved. Backup: /home/ubuntu/.pi/agent/backups/pi-supervisor/20261026T112836Z-before-native-session-reuse. Current sessions need /reload. No structured memory/retrieval implementation, commit, merge or push performed.
