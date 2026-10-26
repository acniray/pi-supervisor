# 判官可靠性、重试日志与恢复设计

用户已在当前会话确认完整修复，并指定“首轮轻量，重试默认全量”；随后要求执行修复。

## 目标与边界
- 判官输出不能因工具读文件或最后的 `agent_end` 大事件而丢失。
- 故障可分类、定位并单独重试，不依赖主 Agent 重做业务任务。
- 不修改用户配置、主备模型、启停默认值、失败/轮次上限；只使用已配置的一次 failover，不加无限自动重试。
- pause/cancel/session switch 只取消监督器拥有的工作；结果晚到不改新状态，不中断主 Agent。

## 方案
只扩大缓存/延长超时不能解决协议与可观测性问题；只补日志也不能修复误报。采用完整闭环：增量接流 + 重试留档 + 结构化故障 + 只重试判官的命令。

### 接流与尝试
新增无第三方依赖的 `judge.ts`，负责 UTF-8 解码、LF JSONL framing、最终 assistant 判定、usage 与子进程生命周期。
协议状态与有界诊断尾缓存分离。大工具/agent_end 事件不覆盖已提取的最终消息；跨字节中文和无末尾 LF 可正确处理。
只接受最终已完成的 assistant 答复，不能把 toolUse 中间文本或失败/abort 前的 JSON 当完成判定。
每次主/备尝试独立记录 ID、模型、耗时、usage、错误、输出总字节、最后事件/工具，并关联主 session。

### 日志
- 默认首次调用轻量；failover、bootstrap 降级重试、连续失败后的核验及显式 retry 在启动前开启全量。
- 每次全量尝试独立目录，保存 request.json、stdout.jsonl、stderr.log、text.txt、result.json，以及通过 `--session` 保存的判官 session.jsonl。
- 文件 0600、目录 0700；只采集本次请求及子进程输出，不采集环境变量、认证文件。日志可能包含任务敏感内容，不上传、不提交。
- 字节流直接写磁盘，不以尾缓存替代全量；超时、取消与进程错误也尽可能关闭文件并保存终态。
- 无法建立/完成全量留档时明确报 logging 错误，不能假称日志完整。首次调用的既往内容不能事后补录。
- 默认日志位于扩展 judge-logs/ 下，可用 judgeLogDir 覆盖；不自动删除本次诊断证据，用户可按目录清理。

### 恢复与展示
- 错误类别：spawn、timeout、exit、provider、parse、incomplete、logging、invalidated；不凭流片段推定 provider 故障。
- /supervisor retry：空闲且有 active/paused 契约时，只重试判官，默认全量；无业务续跑。成功清零连续判官失败计数，但未达成的暂停任务仍暂停；完成仍经过现有证据闸门。
- /supervisor diagnose：展示最近判官尝试、主备各自故障、日志目录与对应处理建议。错误概要及关联 ID 持久化到 supervisor-state，支持重载；旧状态兼容。
- judge 原有正常续跑行为保留；retry 不触发主 Agent。失败后通知、停止边界及 status 给出 diagnose/retry，不只说“检查配置”。

## 验收
真实已注册 handlers + 本地可控判官子进程（不调用真实 provider）覆盖：超大 agent_end、完整大 JSON、UTF-8 跨块、末行无 LF、最终消息优先、超时/异常退出、主备独立留档与总耗时/usage、首轮不全量、retry 不续跑、失败计数、重载、cancel/session switch 晚到保护及日志写入故障。
全套 node --test *.test.ts、模块导入、diff 检查及真实 pi 离线加载通过后再同步运行副本；保留 config.json 与 verdicts.jsonl，当前会话需 /reload 才加载新实现。
