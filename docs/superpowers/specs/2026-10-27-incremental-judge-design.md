# 独立会话 + 结构化状态 + 增量核验

用户指定的架构：每轮独立短上下文判官、持久化结构化判定状态、增量证据验证、原始历史按需检索；禁止每轮模型总结、compaction 或压缩后分叉。

## 设计
- **会话**：每轮 `pi --mode json --no-session`，不继承上轮对话；每轮 `stdout.jsonl` 全量保留。
- **状态**：`state/<sha(sessionId)>.json`，按完成条件记录 status/证据引用/指纹/最后轮次。由 verdict + 文件指纹 + git 快照推导，无额外模型调用。contractKey、sessionId、branchTip 不符或文件损坏 → 丢弃重建。
- **索引**：`evidence-index/<sha(sessionId)>.jsonl`，只存 `(round, logDir, line, tool, path, claim)` 指针；读取时回到 `stdout.jsonl` 原始行。
- **失效**：文件按内容指纹；测试按 commit + dirty 集（被测代码变化即失效）；无法确定依赖的外部结论恒为待核验。
- **分级**：L0 仅在“明确未满足 + 汇报与证据均未变”时跳过模型且永不批准暂停；L1 无工具、注入状态与可复用证据；L2 触发于疑似完成/冲突/失效/显式 retry，允许工具并注入按需检索片段。
- **安全**：判定前后比对主会话分支 tip，变化即作废；完成仍过原证据闸门；L1 声称完成必须 L2 复核。
- **观测**：judge-attempt 记录 tier/复用数/重验数/检索数/升级原因；judge-usage 记录 token 与耗时。

## 非目标
向量库、常驻服务、摘要模型、压缩分叉、跨会话共享。
