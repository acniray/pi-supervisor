# 判官原生 session 复用

用户选择：结构化 memory、检索工具、skill 和向量库暂缓，先保证同一监督任务连续判定。采用现有 pi CLI 的原生 --session 文件恢复，不新增常驻进程或数据库。

## 范围
- 已确认任务的 enforce、judge、retry 和主备 failover 使用同一原生判官会话；每次进程可以重新启动，但恢复同一历史。
- 独立于主 Agent 会话；bootstrap/候选 replan 尚未确认，维持独立推断，不污染正在监督的判官会话。
- pause/resume、普通输入和 /reload 保留关联；cancel 后新 start、确认新契约、换主会话隔离旧关联。
- 主会话当前分支持久化关联（任务 token、owner session ID、契约指纹），不把旧兄弟分支的判官历史混入当前分支。
- 不修改模型、超时、失败上限、完成证据闸门和 retry 不续跑主 Agent 的语义。不承诺 session 复用必然解决所有超时。

## 实现
- index.ts 持有持久化 JudgeSessionRef；指纹只涵盖用户确认的稳定契约字段，不包含每轮进度/时间。确认新契约时换 token，即使文本相同也隔离新任务。
- 固定会话存放于 judgeSessionDir（默认扩展 judge-sessions/）；路径由 parent session 和随机 token 派生，不接受模型指定任意任务路径。
- judge.ts 接受 sessionPath / judgeSessionId，先创建或校验 0700/0600 的原生 session，再传 --session。以 session 文件为键串行化进程使用；取消与恢复竞态须等旧进程关闭后才允许同文件新 writer。
- 保存原生历史而非每轮生成新 header。对超时/失败仅恢复完整落盘记录，不将半截输出当作通过判定；必要的协议尾部修复不得悄悄删除审计原件。
- 每次全量重试仍有独立 request/stdout/stderr/text/result 目录，session.jsonl 是该次结束后的原生会话快照；metadata 显示固定会话 ID/路径和是否已存在上下文。
- 判官提示词明确：当前契约/本轮候选和证据优先于历史；历史旧通过结论不等于新候选通过，未变化的有效查证可承接；失败轮不视为有效判定。
- diagnose 显示固定会话路径，能辨别“记录了日志”与“确实恢复了会话”。

## 验收
- 连续两轮固定文件/ID 相同，第二轮能看到第一轮 assistant 和工具结果，不仅文件名相同。
- failover、retry、pause/resume、重载保持；cancel/new start、确认 replan、换主会话隔离；主分支导航不读兄弟分支未来历史。
- 单文件 writer 串行；取消/超时不污染新任务；全量快照完整性和权限不退化。
- 真实 pi 子进程 + localhost SSE fixture 验证第二次 HTTP 请求含第一轮对话/工具上下文，且无付费模型调用。
- 全测试、类型检查、离线实际 pi 加载与运行副本校验；保留用户配置和历史审计。
