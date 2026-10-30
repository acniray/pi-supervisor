# Incremental Judge 实施记录

- 新增 `judge-state.ts`（状态、指纹、失效、L0/L2 判据、原子写、清除）与 `evidence-index.ts`（指针索引、按需原文读取）。
- `judge.ts` 移除 session 复用/检查点，全部改为 `--no-session`；attempt 增加 tier/复用/重验/检索/升级字段。
- `index.ts` 新增 `runTieredJudge`（L0→L1→按需 L2）、增量提示词、检索注入、分支 tip 安全校验、状态清除（cancel/新契约）。
- 删除 `judge-session.ts` 与原生会话复用测试；新增 state/index 单测与 9 个 handler 回归。
- 测试：109/109 通过，tsc 通过。
- 已知限制：回退到与判定时完全相同的主会话快照时，状态仍会复用（同一对话，语义等价）；依赖关系无法建模的外部证据每次都会重验。
