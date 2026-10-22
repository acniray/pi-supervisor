# Endpoint-driven Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved endpoint-driven supervisor: unmistakable lifecycle, confirmed cancellation without interrupting the main agent, compact contracts and evidence-based verdicts.

**Architecture:** Keep the existing TypeScript extension and session custom-entry persistence. Replace competing armed/paused semantics with one authoritative lifecycle and operation-generation checks around asynchronous work. Preserve judge/quota transport while simplifying contract confirmation and enforcement; use integration tests against the real registered handlers rather than source-text assertions.

**Tech Stack:** TypeScript, Node.js ≥22.6, node:test; no new dependencies or build step.

**Spec:** `docs/superpowers/specs/2026-10-22-endpoint-driven-supervisor-design.md` (approved by user).

## Global Constraints

- 沿用现有 TypeScript 扩展与会话存储，不新增依赖。
- 取消需额外确认一次；确认后移除当前有效契约、放弃本次监督进度。
- 取消只作用于 Supervisor，不中断主 Agent，不回滚代码或提交，也不删除对话历史。
- 显式暂停、取消和完成状态高于项目默认值及 `--supervise`。
- 契约确认前不得进入监督；推断失败不得自动建立通用执行契约。
- 进度可以更新，但不能借进度更新悄悄修改目标、完成条件或限制。
- 证据不足时补证，不直接宣告完成。
- No unrelated quota-classification, budget, dashboard, agent orchestration, or dependency changes.

## Review Focus

1. Restoring a cancelled/completed session with historical contracts or `--supervise` must not revive it (Task 1).
2. A late bootstrap/manual/enforce result, quota timer or compaction callback after pause/cancel must never send a new directive or overwrite newer state (Tasks 1–2).
3. Declined confirmation, unavailable UI, failed inference and abandoned replan must leave the prior task intact and never imply successful cancellation/activation (Task 2).
4. Session switch/reload, legacy custom entries and persisted progress must not leak a task from another session or restore cancelled progress (Task 1).
5. Contradictory/malformed verdicts and unsolicited endpoint changes must not declare success or silently change the confirmed goal (Task 3).

---

## Ownership and file structure

One writer owns this tightly coupled lifecycle/contract integration in `index.ts`, its tests and README. Separate concurrent writers would overlap the same closure, command handlers and settle path. Parent stays read-only until implementation and fresh review complete.

- Modify `index.ts`: lifecycle/persistence, async invalidation, commands, contract confirmation, prompts and concise status.
- Create `supervisor.test.ts`: actual extension handler integration tests and test-only API/context fixtures; use temporary files/processes only for the external judge/config boundary.
- Modify `README.md`: one primary command vocabulary and endpoint-driven usage; preserve accurate advanced quota/config reference.
- Optionally extract a small dependency-free `supervision.ts` only if it materially simplifies real behavior tests; do not restructure unrelated transport/logging code.
- Update this plan's task checkboxes as each test cycle completes.

The extension's public registration interface stays `default function (pi: ExtensionAPI): void`. No new production-only testing API is required: Node can import `index.ts` because upstream SDK imports are type-only.

### Task 1: Authoritative lifecycle and asynchronous invalidation

**Files:** `index.ts` (extension closure, session restore, input, quota helpers, settle/compaction paths); `supervisor.test.ts`.

**Interfaces:** Consume existing session custom entries and actual `ExtensionAPI` callbacks. Produce a persisted lifecycle with `inactive`, `drafting`, `active`, `paused`, `cancelled`, `completed` states; a monotonically changing operation generation/session identity that every asynchronous send/state mutation must validate. Internal naming is implementation-owned; external status and command semantics are fixed by the spec.

- [x] Write handler-level failing tests for: pause survives `supervise=true`; cancelled history cannot restore a contract; a second session starts clean; completed task cannot auto-restart; existing legacy armed/paused entries restore safely; input does not revive terminal states or erase persisted supervision progress.
- [x] Run `node --test supervisor.test.ts`; verify failures are the above real behavioral regressions, not missing SDK/runtime dependencies.
- [x] Implement the authoritative state and backwards-compatible restore, resetting closure state at session boundaries. Persist terminal tombstones so older contract entries cannot resurrect. Persist progress needed by pause/resume; cancellation clears task-local counters, verdict and quota state while retaining historical audit entries.
- [x] Add failing deferred-work tests: pause/cancel during enforce/manual/bootstrap, quota sleep and smart-compaction callback; cancel then start again must reject the old generation. Use controllable external judge responses/test timers rather than sleeping.
- [x] Guard all awaited results, failover/retry branches, quota probes and compaction callbacks before applying results or sending directives; never call the main agent's abort API for cancellation.
- [x] Run `node --test *.test.ts`; all lifecycle and existing quota tests pass.
- [x] Commit the tested lifecycle change.

### Task 2: Explicit commands and transactional confirmation

**Files:** `index.ts` (command registration, ensureContract/promptContract, flag startup policy); `supervisor.test.ts`.

**Interfaces:** Consume Task 1 lifecycle and generation guards. Produce `start`, `pause`, `resume`, `cancel` as the sole primary task controls; secondary `judge/replan/note/history/usage/quota` must not bypass those controls.

- [x] Write failing command tests: decline cancel leaves contract/progress unchanged; confirm cancel persists cancelled state and removes the effective contract without aborting main execution; unavailable confirmation UI cannot cancel; `resume` without a paused contract gives actionable guidance; deprecated `on/off/reset` do not mutate state; repeated start of an active task is idempotent.
- [x] Run `node --test supervisor.test.ts` and observe those behavioral failures.
- [x] Implement cancellation with a default-negative confirmation, clear task data only after approval, and expose a persistent readable status. If the available SDK confirmation helper does not default negative, use a select with “不取消” as the first option. Without UI, refuse destructive cancellation rather than treating missing UI as approval.
- [x] Write failing tests for initial contract-confirmation decline, bootstrap failure, and replan decline/failure retaining the previous contract/status. Also test overlapping draft/cancel operations and manual `judge` while paused/terminal cannot implicitly resume execution.
- [x] Make contract establishment transactional: build candidate locally, confirm, then commit; restore previous state on decline/failure. No provisional fallback task. `--supervise`/profile auto-confirm remain allowed only for a clear candidate and a never-explicitly-stopped session, not as overrides of user task state.
- [x] Run `node --test *.test.ts`; all command, confirmation, async and quota regressions pass.
- [x] Commit the tested command change.

### Task 3: Short endpoint contract, concise evidence checks and documentation

**Files:** `index.ts` (Contract/Verdict, normalization, merge, summaries, bootstrap/enforce/continuation/status builders); `supervisor.test.ts`; `README.md`.

**Interfaces:** Consume confirmed lifecycle/contract operations. Extend the stored contract with explicit completion criteria and necessary boundaries while retaining legacy policy/user-note data for compatibility. Runtime progress updates may change only progress/next steps, never mission/criteria/boundaries/policies. Verdicts must support criterion-level evidence, unmet conditions and goal/scope conflict without accepting a bare unsupported `goal_achieved:true`.

- [x] Write failing behavior tests: short confirmation exposes goal/criteria/restrictions rather than full policy essays; supplementary details remain available; a runtime contract update cannot replace a confirmed endpoint; legacy contracts preserve necessary restrictions.
- [x] Write failing verdict tests: completion requires evidence covering every criterion; absent evidence, contradictory goal/human flags or remaining unmet conditions cannot complete; conflict proposes re-confirmation without silently modifying the endpoint; an ordinary continue response produces a compact actionable message.
- [x] Run `node --test supervisor.test.ts` and confirm the missing behavior failures.
- [x] Simplify bootstrap prompt to infer an explicit endpoint, few checkable criteria and essential boundaries from session evidence; preserve confirmed additional constraints without hardcoded verbose “keep going” essays. Low-confidence/critical-open-question candidates cannot auto-activate.
- [x] Simplify enforcement to criterion verification and concise evidence/unmet/next-step output. Request deeper investigation only on missing/conflicting evidence; goal/range changes require user confirmation. Produce a completed lifecycle only for supported success and persist it before stopping.
- [x] Replace verbose default status with current lifecycle, endpoint, compact progress and actionable next command. Put model/usage/history and full retained contract details behind existing or explicit detail commands. Update README and command help, including migration from on/off/reset, cancellation scope and flag precedence.
- [x] Run `node --test *.test.ts`, `git diff --check`, and a real module import smoke check `node -e "import('./index.ts').then(m => console.log(typeof m.default))"`; expect all tests passing, no whitespace errors and `function`.
- [x] Commit final integration/docs. Report changed files, test counts/commands, known limitations and any unfulfilled spec requirement; do not claim interactive TUI verification without actually performing it.

## Final acceptance

A fresh read-only reviewer checks the actual diff and approved spec, concentrating on the five Review Focus conditions. Parent validates findings against source/tests, fixes material issues with regression tests, and reruns the full test suite. No implementation-mode or product-scope expansion is authorized by this plan.

## Execution evidence

- Tasks 1–3 were integrated together because lifecycle, transactional commands and verdict application share the same extension closure; final delivery uses one integrated correction/docs commit after the initial implementation commit.
- Behavioral red run: 35 tests, 16 failures. First green run: 35/35 handler tests and 12/12 quota tests.
- Fresh read-only review found no P0/P1 and one P2: malformed verdict blocker fields could be silently discarded. Added failing string/null/invalid-array regressions, fixed conservative validation, and also reproduced/fixed a malformed `human_needed` flag.
- Final verification: `node --test *.test.ts` — 60 passed, 0 failed; dynamic import prints `function`; `git diff --check` is clean.
- README and example-config comments now match command migration, cancellation scope, state precedence, short endpoint confirmation and evidence checks.
- No live TUI, real-provider judge-quality or billing verification was performed.
