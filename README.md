# pi-supervisor

让长任务停在**用户认可的终点**，而不是停在主 Agent 的一句“完成了”。

Supervisor 从当前会话推断一份短契约：**目标、完成条件、必要限制**。确认后，每次主 Agent 停止时，独立判官核验完成证据：未闭环就给出下一步，证据齐全就结束监督，需要你处理时则暂停。

不需要维护额外目标文件。契约和监督状态保存在当前会话中，不修改项目代码。

## 安装

```bash
git clone https://github.com/acniray/pi-supervisor ~/.pi/agent/extensions/pi-supervisor
cd ~/.pi/agent/extensions/pi-supervisor
cp config.example.json config.json
$EDITOR config.json  # 填写自己的 judgeModel / judgeFailoverModel
```

无第三方依赖、无需构建，pi 直接加载 `index.ts`（同目录需保留 `judge.ts`、`judge-session.ts`、`quota.ts`）。测试需要 Node ≥ 22.6：

```bash
node --test *.test.ts
# 可选真实 pi 集成验证：仅访问临时 localhost 测试接口，不调用付费 provider
PI_SUPERVISOR_TEST_PI="$(command -v pi)" node --test *.test.ts
```

`config.json`、`verdicts.jsonl`、`judge-logs/` 和 `judge-sessions/` 已被 gitignore：包含本机配置、任务内容、判官输入输出及错误，不应提交或公开。

> `DEFAULTS` 中的模型与 agent 名称是作者本机取值，不保证在你的环境可用。请在 `config.json` 中覆盖。

## 先记住这五个命令

| 命令 | 作用 |
|---|---|
| `/supervisor start` | 推断并确认终点，建立新的监督任务；已经监督中时不重复启动 |
| `/supervisor pause` | 暂停 Supervisor，保留已确认的契约与监督进度 |
| `/supervisor resume` | 恢复暂停任务；空闲的 TUI/RPC 会话会立即续跑 |
| `/supervisor cancel` | **额外确认后**移除有效契约、放弃本次监督进度 |
| `/supervisor status` | 查看当前状态、终点、未闭环项及下一步；不带参数也可 |

**暂停和取消都只作用于 Supervisor，不打断正在运行的主 Agent。** 取消不回滚代码或提交，不删除对话与审计历史；要停止主 Agent，请使用 pi 自身的停止操作。

取消确认默认选中“不取消”；Esc、关闭确认框或无法显示交互界面都不会取消。取消后只能用 `start` 建立新任务，不能用 `resume` 恢复旧进度。

旧命令 `on/off/reset` 已弃用：只提示迁移，不改变状态。请分别使用明确的 `start/pause/resume/cancel`。

### 状态含义

- **未启用**：没有有效监督任务。
- **待确认**：正在推断或确认候选终点，尚未按新契约监督。
- **监督中**：按已确认契约核验、续跑。
- **已暂停**：保留原任务，等待 `resume`；需要人类处理、STOP 文件或达到上限也会进入这里。
- **已取消**：当前契约和监督进度已清除，历史仍可查。
- **已完成**：完成条件已有对应证据，监督结束；不会因下一条输入自动重启。

终端状态栏持续显示主状态；模型、费用、日志等诊断信息放在二级命令里。

## 确认终点，再开始监督

```text
/supervisor start
  → 根据当前会话推断目标、完成条件、必要限制
  → 编辑框确认；有修改意见则重新推断（最多 3 轮）
  → 确认后进入监督，空闲时立即推进下一步

主 Agent 停止
  → 判官逐项核验完成条件
     ├─ 证据不足：简短列出未闭环项 + 下一步，继续
     ├─ 条件均有证据：已完成
     ├─ 需要人类：已暂停，处理后 resume
     └─ 目标或限制变化：已暂停，replan 重新确认
```

编辑框默认只展示终点，不展示整套流程说明：

- 保持正文不变，在“修改意见”区留空提交：确认。
- 修改正文，或在“修改意见”区写要求：重新推断，不直接执行编辑后的文字。
- Esc：放弃候选。首次启动仍未启用；重新规划则保留旧契约与原状态。

缺少明确目标/完成条件、有待澄清问题时，不会启用；低置信度候选必须人工确认。推断失败也不会生成一份通用契约自动续跑。

契约包含 `mission`、`completion_criteria`、`boundaries`；完整详情保留进度、后续步骤、用户说明及已有决策/记录/停止规则。普通判定只能更新进度和步骤，不能悄悄改掉已确认的目标、条件或限制。

### 补充说明与重新规划

```text
/supervisor replan           # 为现有任务重新推断终点，确认前不替换旧契约
/supervisor note <说明>      # 追加用户说明，不触发重新推断
/supervisor details          # 完整有效契约：进度、规则、说明等
/supervisor judge            # 空闲时手动核验；暂停中不会因此自动续跑
/supervisor retry            # 只重试判官，自动开启全量日志；不触发主 Agent 续跑
/supervisor diagnose         # 当前 session 最近主备尝试、错误原因、日志路径和恢复建议
/supervisor history [n]      # 当前 session 的判定历史，默认 20 条
/supervisor usage            # 判官 token / 缓存 / 金额及最近调用
/supervisor quota            # 主模型额度等待的配置、状态和错误分类
```

`note` 是给监督判官的补充说明，不是直接发给主 Agent 的任务指令。改变目标、完成条件或限制时请用 `replan`；要给主 Agent 下令，在正常会话中输入。

暂停不会丢失计数与已确认进度；`start` 不会覆盖暂停任务。恢复原任务用 `resume`，另起任务先 `cancel` 再 `start`。

## 启用策略与无人值守

默认 `enabled: false`，新会话不会自动启用。可以按会话执行 `start`，也可显式无人值守启动：

```bash
pi --supervise
```

`--supervise` 会在新会话首次正常停止时推断终点，并自动接受**目标明确、无待澄清问题且置信度足够**的候选。`autoConfirm: true` 也仅跳过清晰候选的人工确认，不代表允许猜测目标。

**会话中明确保存的状态优先于 `--supervise` 和项目默认值。** 已暂停、取消或完成的任务，重启时不会被 flag/配置重新激活。恢复用 `resume`，开始新任务用 `start`。

项目 `enabled: true` 会为该目录（含子目录）下尚无明确监督状态的会话自动推断，建议只用于专用无人值守 worktree。非交互环境没有确认 UI，无法用 `cancel` 跳过确认；含歧义的候选也不会自动启用。

软停止入口：

```bash
touch ~/.pi/agent/extensions/pi-supervisor/STOP
```

命中后 Supervisor 暂停，**不代表目标达成**。移除 STOP 文件后再 `resume`。

## 配置参考

配置文件为 `~/.pi/agent/extensions/pi-supervisor/config.json`，每次读取时按项目路径合并覆盖；完整示例见 [config.example.json](config.example.json)。

```jsonc
{
  "defaults": { "enabled": false },
  "projects": {
    "/abs/path/to/worktree": {
      "enabled": false,
      "autoConfirm": false,
      "judgeModel": "<provider>/<judge-model>",
      "judgeFailover": true,
      "judgeFailoverModel": "<provider>/<fallback-model>",
      "judgeThinking": "low",
      "judgeTimeoutMs": 120000,
      "bootstrapTimeoutMs": 300000,
      "maxIterations": 300,          // 累计监督轮次上限，暂停/恢复和普通输入不清零
      "maxJudgeFailures": 2,         // 达到连续失败上限后暂停
      "smartCompaction": true,       // TUI 中在合适检查点整理上下文
      "enforceReadTools": false,
      "escalationAgent": "escalation", // 可用的升级诊断 agent，不是每个任务的强制步骤
      "stopFile": "~/.pi/agent/extensions/pi-supervisor/STOP",
      "logFile": "verdicts.jsonl",
      "judgeLogDir": "~/.pi/agent/extensions/pi-supervisor/judge-logs",
      "judgeStateDir": "~/.pi/agent/extensions/pi-supervisor/state",
      "judgeIndexDir": "~/.pi/agent/extensions/pi-supervisor/evidence-index",
      "judgeExtensions": [],           // 例如 ["npm:pi-provider-qoder"]，只给判官加载指定 provider
      "goal": null,                  // 可选的固定目标提示，仍需形成明确终点
      "quotaWait": {
        "enabled": true,
        "intervalMs": 600000,        // 默认 10 分钟，下限 5s，上限 24h
        "maxWaitMinutes": 0,         // 0 = 无限
        "maxAttempts": 0,            // 0 = 无限
        "permanentAsHumanNeeded": true,
        "extraPatterns": [],
        "ignorePatterns": []
      }
    }
  }
}
```

项目按精确路径或最长目录前缀匹配。项目字段覆盖 defaults，嵌套对象也是浅合并，覆盖 `quotaWait` 时请留意。

### 判官、失败与证据

判官是独立 `pi --mode json --no-extensions --no-skills --no-context-files` 子进程，不加载本扩展。判官子进程默认仍以 `--no-extensions` 启动，只加载 `judgeExtensions` 中明确列出的扩展。第三方 provider（例如 qoder-cn 由 npm 包 `pi-provider-qoder` 注册）必须在此列出，否则判官会报 “No models matching”，即使主会话能正常使用：

```jsonc
"judgeExtensions": ["npm:pi-provider-qoder"]
```

支持 `npm:<包名>`（从 `$PI_CODING_AGENT_DIR/npm/node_modules` 解析）、绝对路径或相对 cwd 的路径；`builtin:` 与不存在的路径会被拒绝，且在启动子进程前失败，不会产生调用费用。该开关只影响判官，不放宽主 Agent 或其它扩展。

每轮判定都是独立的 `--no-session` 判官进程；bootstrap/候选 replan 同样独立：

- 推断阶段可用只读工具，主要依据当前会话；只核对明确提及的关键事实，不默认扫描仓库。
- 正常核验默认无工具；需要判官自行查证时可设置 `enforceReadTools: true`，会增加耗时。
- 完成结论必须为每项完成条件提供对应证据；缺项、未完成项、规则/记录缺口、证据冲突或仍需人类时，都不能仅凭 `goal_achieved: true` 放行。
- 缺少可验证证据时要求补证，不要求每次扫描仓库或重复整套流程。
- 是否咨询决策 agent、哪些记录必须补齐，以已确认契约为准，不再给每条续跑消息附加固定的升级诊断长说明。

主判官出现 provider 错误、空输出、非 JSON、超时或非零退出时，可用备用模型重试一次。推断阶段还会尝试一次无工具推断；仍失败就保留原状态，不建立新契约。

正常核验失败不等于完成：未到连续失败上限时按现有契约继续核验，达到上限则暂停。手动 `judge` 失败不改变启停状态；显式 `retry` 失败会计入连续失败次数，并遵守原暂停上限。有效判定成功后清零连续失败次数，不能据此认定目标完成。

JSONL 按 LF 增量解析并正确处理跨块 UTF-8；最终判定与诊断尾缓存分离，不会再被大量工具输出或最后的 `agent_end` 消息汇总挤掉。只有完成的最终 assistant 消息可进入现有证据闸门；`toolUse`、中断、provider 错误和未完成流中的 JSON 不能冒充最终判定。每个协议记录的解析上限为 4,000,000 个 UTF-16 码元（含边界值），超大记录丢弃至下个 LF，不把残片重新当 JSON；全量原始日志不受该解析上限截断。

### escalationAgent：真实的升级裁决

升级诊断不是提示，而是**实际调用**：Supervisor 读取该 agent 的 markdown 定义（frontmatter 的 `model`/`thinking`/`tools` + 正文角色说明），用同一套判官传输（超时、全量日志、主备）跑一次，并要求它严格输出：

```json
{"human_required":[{"item":"...","why":"..."}],"executable":[{"action":"...","why":"..."}],"reason":"...","confidence":"high"}
```

触发时机：
- 判官给出 `human_needed=true` 时 → **先做升级裁决**，不直接暂停；
- 连续 `stagnationRounds` 轮无新证据、准备停滞暂停时 → 先做升级裁决。

裁决结果的处理：
| 裁决 | 处理 |
|---|---|
| 只有可执行项 | 不暂停，把该项作为 `next_step` 继续，并重置停滞计数 |
| 有人类门 | 暂停，列出待批项与原因；可执行项一并展示 |
| 无可用结论 / agent 未配置 | 按原语义处理（human_needed 暂停 / 停滞暂停），日志注明原因 |

- 每次任务最多 `escalationMaxCalls`（默认 3）次，超时 `escalationTimeoutMs`（默认 180s），计数写入结构化状态、随任务隔离。
- agent 缺失不告警、不阻塞，按未设置处理。
- 裁决仍不是放行条件：`goal_achieved` 依旧要过证据闸门。

### escalationAgent 的解析与提示

`escalationAgent` 不是自动执行器：扩展与判官都不会调用它（判官子进程禁用扩展，无法派 subagent）。它的作用是让判官知道“有哪个升级诊断 agent 可用”，从而在**证据冲突/判断困难**时建议主 Agent 先做一次升级诊断，而不是直接要求人类介入。

- 生效范围：推断契约时写入提示词；L1/L2 核验提示词中会带上已解析的 agent 名与该规则。
- 解析路径：`$PI_CODING_AGENT_DIR/agents/<name>.md`（默认 `~/.pi/agent/agents/`），以及 cwd 及其最多 6 级祖先的 `<project>/.pi/agents/<name>.md`——worktree 内也能找到仓库根部定义的项目级 agent。
- 找不到时**不告警、不阻塞**：直接按“未设置”处理，不把不存在的名字写进提示词；`/supervisor details` 与 `/supervisor diagnose` 会显示 `escalation: <name> 未找到，按未设置处理`。
- 它只是建议，不是放行条件：最终仍要满足证据闸门，且不得用升级诊断替代人类批准。

### 独立会话 + 结构化状态 + 增量核验

每轮判定都是**新的短上下文判官会话**，不继承上一轮对话；历史不再靠长上下文携带，而是靠两层持久化：

| 层 | 位置 | 作用 |
|---|---|---|
| 结构化状态 | `state/<session 摘要>.json` | 按完成条件记录状态、证据引用、指纹、最后核验轮次 |
| 证据索引 | `evidence-index/<session 摘要>.jsonl` | 只存指向 `judge-logs/<attempt>/stdout.jsonl` 的行号，不复制正文 |

状态**不使用模型总结**：由判官的 `criteria_evidence` / `unmet_conditions` 结合文件指纹、git HEAD 与 dirty 集直接推导。

判定按三档进行：

- **L0**：已有明确未满足条件，且本轮汇报哈希、证据指纹都未变化 → 直接维持“不允许暂停”，不调用模型（永远不会用它批准暂停）。
- **L1**：有进展但历史证据仍有效 → 独立会话、无工具，只输入契约、状态摘要、可复用证据与新一轮汇报。
- **L2**：疑似完成、存在冲突、证据失效/缺失、显式 `retry` → 允许只读工具，并按需检索历史原文；仍只核验失效或可疑项。

失效规则按证据类型区分：文件比对内容指纹；测试结果绑定 commit 与 dirty 集，被测代码变化即失效；无法确定依赖的外部结论一律标为待核验。**缓存的 PASS 永远不会直接导致允许暂停**，最终完成仍需经过原有证据闸门。

安全约束：判定开始前记录主会话分支 tip，判定期间会话发生变化则结果作废；状态文件损坏、版本不符或属于其他契约/主会话时安全回退到完整判定。

**停滞保护**：结构化状态记录证据签名与已连续无进展的轮次。连续 `stagnationRounds`（默认 3）轮没有新增证据时，判官提示词会强制其改口或改道（给出不同的可执行动作，或判定需要人类批准），并展示前两轮重复的建议；若仍无进展，Supervisor 直接暂停并说明原因，不再无限循环。

`/supervisor diagnose` 显示每轮的 `L0/L1/L2` 路径、复用/重验证据条数、检索次数与升级原因；`judge-usage` 记录 token 与耗时，便于比较改造前后的开销。

### 重试默认全量日志

默认**首轮轻量，重试自动全量**，不需要修改现有配置：
- 主判官失败后的备用模型尝试；
- 推断失败后的无工具重试；
- 连续判定失败后的下一次核验（包括 resume 后）；
- 显式 `/supervisor retry`。

每个主/备尝试有独立 attempt ID，同一组主备共享 call ID，并关联主 session。全量记录在子进程启动前建立，字节流直接落盘，不以尾缓存冒充完整日志：

```text
~/.pi/agent/extensions/pi-supervisor/judge-logs/<时间>-<attempt-id>/
  request.json    # 实际提示词、模型、工具/超时设置、主 session 与判官会话关联
  stdout.jsonl    # 完整 stdout 事件流（排查截断/最后工具/超时点的主要证据）
  result.json    # 判定、usage、退出原因、stderr 摘要、最终文本、错误分类
```

每轮都有独立的全量日志，用于事后检索原始证据，不按次复制会话文件，也不单独写 `text.txt`/`stderr.log`（后者并入 `result.json`）。检索条目只存行号指针，所以不会重复占用磁盘。旧版本目录保持原样，不自动迁移或删除。

可用 `judgeLogDir` 改变目录。每次尝试的目录权限为 0700、文件为 0600；仅本地保存，不额外采集环境变量或认证文件。但提示词和读文件结果可能包含敏感内容，请勿公开这些原始日志。默认不自动删除证据，排查结束后可自行清理尝试目录。

超时、取消和进程错误也会尽可能关闭日志、记录终态；日志路径无法建立时在启动判官前报 `logging`，写入失败时明确标注未完成，不能假称全量日志成功。首次轻量调用的原始 stdout/stderr 无法事后补录，但已确认任务的原生完整消息历史仍会保留。

### 故障处理与仅重试判官

`diagnose` 区分 `spawn / timeout / exit / provider / parse / incomplete / logging / session / invalidated`，显示每次尝试的模型、耗时、实际输出总字节、最后事件/工具、日志路径和处理建议。不能仅凭流片段中的 usage/stopReason 认定 provider 故障。主备均失败仍保留两者记录；usage 和耗时统计包括主备两次尝试。

```text
/supervisor diagnose   # 看具体原因；旧版 session 则回读已有审计摘要，不虚构完整日志
/supervisor retry      # 仅重新核验已有契约，默认全量留档
/supervisor diagnose   # 查看本次重试的原件及结果
/supervisor resume     # 确认后另行恢复主 Agent 的推进
```

`retry` 只在空闲且有 active/paused 有效契约时执行；不重新运行主 Agent 的业务任务、不自动换模型、不改配置、不追加无限重试。暂停任务若未达成仍保持暂停；若证据确实闭环则正常完成，仍沿用逐条件证据闸门。主 Agent 忙碌时不会并发启动判官。暂停、取消、resume 或会话切换会使旧尝试失效，不能让迟到结果覆盖当前任务。

更新扩展文件后，当前会话需执行 `/reload` 才加载新实现。

### 可见性与历史

状态栏保留当前主状态，推断/核验时附带已用时间，额度等待时显示倒计时。候选确认、放弃、暂停、取消、完成均有明确反馈。

`verdicts.jsonl` 记录推断、契约、判定、完成、取消、失败、逐次判官尝试及额度事件，并附 `sessionId` / `sessionName` / `sessionFile`，方便区分同一目录下的不同会话。最近诊断概要和固定判官会话关联/检查点也写入当前主会话分支的监督状态，重载后仍可恢复。`history`、`usage`、`diagnose` 按当前 session 查询。

`usage` 统计判官调用（bootstrap / enforce / manual / retry），不包含主 Agent 自身 token，也不包含注入监督消息给主会话造成的间接开销；供应商未返回 usage 时不会估算成真实消耗。

## 主模型额度耗尽：等待恢复

主 Agent 因额度/配额耗尽报错时，Supervisor 在停止边界等待后重试原请求，不会为每次探测调用判官或占用监督轮次。

错误分类来自 `quota.ts`，只看错误文本，不绑定 provider：

| 分类 | 例子 | 行为 |
|---|---|---|
| `quota` | `The usage limit has been reached`、`GoUsageLimitError`、每周/月上限、`insufficient_quota`、`out of budget` | 等待后重试 |
| `permanent` | 欠费、`invalid_api_key`、登录过期、不支持的区域/模型、工作区配置错误 | 默认立即暂停，等待人工处理 |
| `other` | 空体 429、tpm/rpm 限流、网络错误、504、超时、abort | 不接管，保留 pi 原有行为 |

新 provider 措辞可以用配置补充：

```jsonc
"quotaWait": {
  "extraPatterns": ["^MyGateway: daily cap"],
  "ignorePatterns": ["beta feature unavailable"]
}
```

优先级：`ignorePatterns` > `extraPatterns` > tpm/rpm 护栏 > 内置 permanent > 内置 quota > other。

- 默认每 10 分钟探测一次；`maxAttempts` / `maxWaitMinutes` 为 0 时不设总上限。
- Esc 中断等待；`pause` / 确认后的 `cancel` 会使旧等待与探测失效；STOP 文件每 5 秒检查。
- 达到等待上限、STOP 或永久性错误时进入暂停，不冒充“已完成”。
- 识别到失败消息 entry 时，用 `context_edit` 从后续模型上下文移除该失败轮，避免重复堆积；这不删除对话历史，也不保证供应商不计费。
- 普通用户输入会清零额度等待计数，但不清除监督进度或重新激活终态。
- `/supervisor quota` 查看配置、等待状态、最后错误与分类；日志包含 `quota-detected` / `quota-probe` / `quota-recovered` / `quota-giveup` / `quota-permanent` / `quota-aborted` 等事件。

## 恢复、兼容与边界

- 每个 session 独立保存有效契约和状态；切换会话不会继承另一个会话的任务。
- 已取消/完成的状态会压住历史契约；历史仍可查，但不会恢复为有效任务。
- 老版本 `stop-supervisor-contract` / `stop-supervisor-state` 仍可读取。旧通用临时契约不再作为可执行授权；请重新 `start` 确认终点。
- 新写入使用 `pi-supervisor-contract` / `pi-supervisor-state`；配置环境变量为 `PI_SUPERVISOR_CONFIG` / `PI_SUPERVISOR_DEBUG`，兼容旧 `STOP_SUPERVISOR_*` 名称。
- `outcome=aborted` 不强行续跑；有排队消息时不插手。非额度类错误不接管。
- pause/cancel、新任务、重新规划、人工接管或会话切换后，旧判官结果、额度定时器和压缩回调不得发送新指令或覆盖新状态。
- 智能压缩仅在 TUI 路径使用；其他模式走普通监督续跑，不依赖热压缩。
- 自动测试覆盖实际注册的命令/事件处理器和延迟回调；真实模型质量、供应商计费以及交互界面的视觉表现仍需在你的 pi 环境中验证。

## License

MIT — 见 [LICENSE](LICENSE)。
