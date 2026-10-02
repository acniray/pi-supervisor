# pi-supervisor

无人值守长任务的 **stop 监督者**。不需要为每个任务维护目标文件：它自己从**当前会话 + 仓库**
推断任务契约，在对话框里给你**可编辑的确认界面**（可以直接补充/修改意见），确认后**立刻继续执行**；
之后每次模型停止（settle）时用**另一个大模型**按契约判定：继续 / 放行 / 需要人类。

## 安装

pi 会从 `~/.pi/agent/extensions/<name>/index.ts` 加载扩展，所以直接克隆到那里即可：

```bash
git clone https://github.com/acniray/pi-supervisor ~/.pi/agent/extensions/pi-supervisor
cd ~/.pi/agent/extensions/pi-supervisor
cp config.example.json config.json
$EDITOR config.json          # 至少填 judgeModel / judgeFailoverModel
```

无第三方依赖、无需构建 —— pi 直接加载 TypeScript。跑单测只需要 Node ≥ 22.6（自带类型剥离）：

```bash
node --test quota.test.ts
```

`config.json` 与 `verdicts.jsonl` 都在 `.gitignore` 里：前者是你本机的真实配置（模型 id、绝对路径），
后者是判官每次判定/契约/错误文本的审计日志，都不应该进版本库。

装好后**任何会话都不会自动启用**：按会话 `/supervisor start`，或无人值守启动时用 `pi --supervise`。

> 代码里的 `DEFAULTS`（`judgeModel` / `judgeFailoverModel` / `escalationAgent`）是作者本机的取值，
> 只作为兜底；请一律在自己的 `config.json` 里覆盖成你的模型与决策子 agent 名称。

## 两阶段

```
首次 settle 或 /supervisor start|replan
   └─ BOOTSTRAP：判官以当前 session（用户请求/最近对话/主 Agent 汇报）为主要依据推断契约；
        仅在 session 提到文件/需验证关键事实时用只读工具少量取证（不默认扫描仓库）
        → 推断契约 → 打开编辑框（契约正文 + 「修改意见」区）
           ├─ 有修改意见 → 带意见重新推断（最多 3 轮）
           └─ 直接提交   → 确认 → 立即用 next_steps[0] 续跑任务（不再多调一次判官）
之后每次 settle
   └─ ENFORCE：判官按契约判定
        ├─ 未达成 → 注入 next_step + 需补齐的决策/记录项，继续
        ├─ 已达成 → 放行
        ├─ 需要人类 → 放行并提示
        └─ compact_now → 压缩后自动续跑（TUI/RPC）
```

契约字段（bootstrap 推断、enforce 滚动更新，存为会话内 custom entry，无需改仓库）：
`mission` / `furthest_progress` / `next_steps` / `decision_policy`（何时调用哪个决策子agent）/
`record_policy`（哪些问题记到哪） / `stop_conditions` / `autonomy_rules` / `user_notes`。

## 使用

### 启用方式（会话级，默认不自动启用）

- 默认**任何会话都不会自动启动**（config `defaults.enabled: false`，项目 profile 也默认 false）；
- 每个会话独立启用/停用，状态持久化在该会话内：
  - `/supervisor start`：本会话启用并建立契约；重启该会话后仍保持启用；
  - `pi --supervise`：仅本次进程启用（适合无人值守启动）；**显式传该 flag 会覆盖会话里已持久化的 off/paused 状态**（但不改写它，不带 flag 的下次启动仍按持久化状态）
  - `/supervisor off`（或 `pause`）：本会话持久停用；`/supervisor resume` 恢复；
  - `human-needed` 自动暂停也会持久化，避免你逐项处理时反复判定；
- 项目配置里的 `"enabled": true` 表示**该项目下所有会话自动启用**，只建议用于专用无人值守 worktree；多任务共用的 worktree 保持 false，按会话 `/supervisor start`。

```bash
# 交互式：正常 pi，然后
/supervisor start              # 启用并立即推断契约（编辑框确认；直接提交=开始执行）
/supervisor replan             # 重推断契约（目标/范围变了、或要补充信息时）
/supervisor note <说明>        # 随时告诉监督者（会注入到之后每一次判定，最高优先级）
/supervisor                    # 查看状态（armed/session/judge/计数/契约/quotaWait/最近一次停止原因/最近判定）
/supervisor history [n]        # 查看本 session 的判定历史（默认 20 条）
/supervisor quota              # 查看主模型额度等待：配置/当前状态/最后一次错误/分类结果
/supervisor judge               # 立即手动判定一次（当场给结果/续跑）
/supervisor pause | resume      # 手动暂停/恢复自动判定（= off/on）
/supervisor off|on|reset       # 本会话停用/恢复/重置计数
```

- 每次**允许停止**（目标达成 / 需要人类 / 达到上限 / STOP 文件 / 判官连续失败）都会在转录里追加一条可见消息，写明允许停止的理由；
- `verdicts.jsonl` 每条记录带 `sessionId` / `sessionName` / `sessionFile`，同一 cwd 下多个 session 可按 session 关联；

# 无人值守：自动接受推断契约并立即开始
pi --supervise
```

软停止：`touch ~/.pi/agent/extensions/pi-supervisor/STOP`。

### 怎么和判官沟通

**第一轮**弹的是编辑框（预填契约正文，末尾有「修改意见」区）：

- **直接提交**（下方留空）→ 确认契约并立即开始执行；
- **在下方写内容** → 视为修改意见，会**重新推断一次**契约（会通知「已收到你的意见，正在据此重新推断契约（第 2 次）…」）；
- 只输入 `继续` / `确认` / `OK` 这类词 → 当作确认，不重新推断。

**第二轮及以后**弹的是普通确认框（展示更新后的契约）：确认 = 开始；取消后会再给一个输入框让你继续补充意见（最多 3 轮，之后放弃启用）。

你写的意见会同时存入契约的 `user_notes`，之后**每次判官判定都会当作最高优先级约束**；也可以随时用 `/supervisor note <说明>` 只加说明、不触发重新推断。

**注意**：编辑框里的文字是给**判官**的（修正契约），不是直接发给主 Agent 的任务指令；要直接给主 Agent 下令，在正常会话输入里写。

## 配置（可选覆盖）

`~/.pi/agent/extensions/pi-supervisor/config.json`：

```jsonc
{
  "defaults": { "enabled": false },
  "projects": {
    "/abs/path": {
      "enabled": false,             // true = 该项目所有会话自动启用（多任务 worktree 保持 false）
      "autoConfirm": false,         // true = 跳过确认（无人值守）
      "judgeModel": "<provider>/<judge-model>", // 主判官
      "judgeFailover": true,                     // 主判官失败时是否自动切备用
      "judgeFailoverModel": "<provider>/<fallback-model>", // 备用判官
      "judgeThinking": "low",
      "judgeTimeoutMs": 120000,     // enforce 判官超时
      "bootstrapTimeoutMs": 300000,  // bootstrap 判官超时（只读工具，慢）
      "maxIterations": 300,         // 连续续跑上限（用户输入后重置）
      "maxJudgeFailures": 2,        // 连续判官失败多少次后交还控制
      "smartCompaction": true,
      "enforceReadTools": false,    // enforce 判官是否带只读工具（慢但更严格）
      "escalationAgent": "escalation", // 人类介入前必须先咨询的决策子agent
      "quotaWait": {                       // 主模型额度耗尽时等待恢复（见下节）
        "enabled": true,
        "intervalMs": 600000,              // 固定探测间隔，默认 10 分钟（下限 5s，上限 24h）
        "maxWaitMinutes": 0,               // 0 = 无限等待
        "maxAttempts": 0,                  // 0 = 无限次探测
        "permanentAsHumanNeeded": true,    // 需人类的错误（欠费/掉登录）立刻停并自动暂停
        "extraPatterns": [],               // 追加「算额度」的正则（新 provider 不用改代码）
        "ignorePatterns": []               // 强制排除的正则（优先级最高）
      },
      "goal": null                  // 可选：固定目标提示，仍会推断步骤/策略
    }
  }
}
```

判官调用（独立进程，不加载本扩展、不开会话）：

```bash
pi --print --no-session --no-extensions --no-skills --no-context-files \
   [--tools read,grep,find,ls] --model <judgeModel> --thinking <level> "<prompt>"
```

- bootstrap 始终带只读工具；enforce 默认不带工具（约 8–9 秒/次）。
- bootstrap 是 **session-first**：以当前 session 的「用户最初请求 + 最近对话 + 主 Agent 汇报」为主要依据推断契约；git log/status 作为辅助验证；
  只有在 session 中明确提到文件/路径/计划时，判官才用只读工具（read/grep/find/ls）读取少量文件（≤ 8 次调用），**不默认扫描仓库/枚举 docs/读 AGENTS.md**。
- 同一 cwd 下多个 session 各自 bootstrap、各自保存契约，互不影响。
- 超时（`bootstrapTimeoutMs`，默认 300s）后自动**无工具重试一次**；再失败则生成**临时契约**继续推进（不阻塞任务），可用 `/supervisor replan` 重建。
- 判官失败时 **fail-open 向"继续推进"**：按契约 `next_steps[0]` 继续，并写日志；
  连续失败超过 `maxJudgeFailures` 才交还控制。
- 所有事件写入 `verdicts.jsonl`（`contract` / `bootstrap-continue` / `enforce-start` /
  `verdict` / `done` / `judge-failure` / `handler-error` …），便于事后审计。

## 可见性（判官/压缩进行中你能看到什么）

- 判官开始工作时：通知 `开始推断任务契约（判官 <model>，带只读工具，最长约 Ns）`；
- 判官运行期间：状态栏每 5 秒刷新 `判官推断任务契约中（已 Ns）` / `监督模型判定中（已 Ns）`（TUI 在 footer，pi-web 在状态区），不会"看起来卡死"；
- 带工具推断超时/失败时：通知 `带工具推断超时/失败，改为无工具快速重试…`；
- 契约确认/自动接受、判定完成/需要人类：均有通知；
- **压缩时**：通知 `判定为可压缩检查点，开始压缩上下文（保留：…）`，状态栏显示 `压缩上下文中…`；完成后通知 `压缩完成（<before> → <after> tokens），继续任务`，失败则通知 `压缩失败（原因），直接继续任务`；
- 全部事件写入 `verdicts.jsonl`（`bootstrap-start` / `bootstrap-retry-no-tools` / `enforce-start` / `compact-requested` / `compact-done` / `compact-failed` / `verdict` / `done` …）。

## 人类介入门槛（升级诊断优先）

出现需要确认/决策/阻塞时，流程固定为：

```
主 Agent 遇到需要确认/证据冲突/阻塞
   └─ 先调用升级诊断子agent（默认 escalation，config: escalationAgent）
        ├─ 它给出方案  → 按其方案继续执行（不停）
        └─ 它判定必须人类介入 → 写明其结论并停止，等人类处理
```

- bootstrap 会把这条规则写进契约的 decision_policy / stop_conditions；
- enforcement 判官会检查：**没有先调用升级诊断、或没有它的结论，就不允许判 human_needed**；
  未升级就请求人类会被记入 policy_violations，并让主 Agent 先去咨询升级诊断；
- **还有可自主推进的工作时不允许停**：即使存在待人类裁决的事项，也会走登记/挂起待决项后继续独立单元，只有确实无事可做时才判 human_needed；
- 每条续跑消息都会重述这条规则。

### 人类介入时自动暂停

判官判 `human_needed` 时，supervisor 会**自动暂停自己**（避免你逐项确认时反复触发判定）：

- 停止消息会写明“已自动暂停…处理完后用 /supervisor resume 恢复”；
- 暂停状态持久化到会话，重启 pi 也保持暂停；
- 处理完毕后 `/supervisor resume`：恢复监督；若会话空闲且处于 TUI/RPC，会立即续跑一次继续任务。

## 失败诊断与 fail over

- **真实错误会被读出来并落盘**：判官子进程用 `--mode json` 运行，解析器会读取 assistant 消息的 `errorMessage` / `stopReason` / `diagnostics` 以及事件流里的 `error` / `auto_retry_start` / `auto_retry_end`，因此 `verdicts.jsonl` 里记的是**真实原因**（如 `provider=403 …FreeTierError`、`autoRetryFinal=429 …`），而不是笼统的 "output not JSON"。失败时还会存 `stdoutTail` / `stderrTail`（各 2000 字符），保证事后可回溯。
- **通知与停止消息带原因**：fail-open 续跑消息、`⏹ 监督模型连续失败 N 次` 停止消息都会内嵌真实错误与 failover 记录（截断到 300–800 字符）。
- **判官 fail over（单次）**：主判官因 *provider 错误 / 空回复 / 非 JSON / 超时 / 进程非 0 退出* 拿不到可用结论时，自动改用 `judgeFailoverModel` 重试一次（bootstrap / enforce / 手动判定都适用），并记 `judge-failover` 事件（含主判官的真实错误）。
  - 启用：`"judgeFailover": true` + `"judgeFailoverModel": "<provider/model>"`；
  - 关闭：`"judgeFailover": false`；
  - 默认备用：见 `DEFAULTS.judgeFailoverModel`（建议改成你自己的备用模型）；
  - 两个模型都失败时，错误信息会同时列出主、备两边的真实原因。
- 只有在两个模型都拿不到结论、且连续失败超过 `maxJudgeFailures` 时才会停止无人值守（停止 ≠ 目标达成）。

## 主模型额度耗尽：等待恢复后自动续跑

主 Agent 因为**额度/配额用尽**而报错时（最典型的是 `Error: Codex error: The usage limit has been reached`），
supervisor 不会就此交还控制，而是**在 settle 处阻塞等待，然后让 pi 重发同一个请求**，直到额度恢复。

```
主 Agent 报额度错 → settle(outcome=error)
   └─ 按 errorMessage 文本分类（与 provider 无关）
        ├─ quota      → 状态栏倒计时 + 阻塞等待 intervalMs → 剔除失败轮 → pi 重发同一请求
        │                 ├─ 成功 → 下一次 settle 是 completed → 记 quota-recovered，正常走判官
        │                 └─ 又失败 → 回到本分支，再等一个 intervalMs
        ├─ permanent  → 立刻停（欠费/掉登录/区域/模型或工作区配置错），等待无用；按 human-needed 自动暂停
        └─ other      → 不接管，维持原行为（瞬时错误由 pi 内置 auto-retry 负责）
```

**为什么可以一直等**：探测请求就是主 Agent 的真实请求，失败时 `usage` 全 0，**不花 token**。
并且失败的那一轮会用 `context_edit`（`replacement: null`）从模型上下文里剔除 —— 这正是 pi 自己
auto-retry 用的机制（`_omitRecoveryAttempt`）—— 所以重发出去的上下文和故障前**逐字节一致**，
等 10 小时也不会让上下文增长一个 token。

**阻塞在 settle handler 内**（而不是事后定时器）是有意的：`pi --print` / headless 下进程不会退出，
所以无人值守也能等；同时 pi 在 handler 返回后会重新检查 abort 标志，**Esc 依然能立刻打断**。

### 分类只看错误文本，不看 provider

分桶规则在 `quota.ts`，全部来自本机真实会话语料，换主模型不需要改代码：

| 桶 | 典型样本 | 行为 |
|---|---|---|
| `quota` | `Codex error: The usage limit has been reached`、`You have hit your ChatGPT usage limit (team plan). Try again in ~132 min.`、`429 {"type":"GoUsageLimitError"…}`、`429 {"code":"1310","message":"您已达到每周/每月使用上限…"}`、`insufficient_quota`、`quota exceeded`、`out of budget`、`subscription_sharing_usage_limit_exceeded` | 等待重试 |
| `permanent` | `402 … Insufficient account funds`、`credit balance is too low`、`Login expired`、`invalid_api_key`、`unsupported_country_region_territory`、`model is not supported`、`No API provider registered`、`Privacy settings` | 立刻停 + 自动暂停 |
| `other` | `429 status code (no body)`、`fetch failed`、`Connection error.`、`504 Gateway Time-out`、`servers are currently overloaded`、`inference exceeds tpm/rpm limit`、`terminated`、超时、abort 类 | **不接管** |

> `tpm/rpm` 这类 429 虽然同时带 `429` 和 `limit`，但是秒级恢复的限流，pi 内置 auto-retry 已经在管；
> 分类器有专门的护栏把它挡在 `quota` 之外，不会误等几小时。

新 provider 的措辞用配置解决，不用改代码：

```jsonc
"quotaWait": { "extraPatterns": ["^MyGateway: daily cap"], "ignorePatterns": ["beta feature unavailable"] }
```

优先级：`ignorePatterns` > `extraPatterns` > `tpm/rpm` 护栏 > 内置 permanent > 内置 quota > other。

### 中断与上限

- **Esc** → 立刻取消等待，正常 settle（记 `quota-aborted` reason=user-abort）；
- **STOP 文件** → 每 5s 检查一次，命中就停（`quota-aborted` reason=stop-file）；
- `maxAttempts` / `maxWaitMinutes`（默认都是 0 = 无限）→ 超限记 `quota-giveup` 并写一条可见停止消息；
- 等待期间**完全不调判官**（判官常常和主 Agent 同账号，同样没额度），也不占用
  `iterations` / `maxIterations` / `judgeFailures`；
- 你手动发消息 = 接管，额度计数自动清零。

### 可见性

- 状态栏每 5s：`⏳ 等待额度恢复 · 第 3 次探测 · 已等 20m · 下次 9m40s 后（Esc 取消）`；
- 通知：进入等待 / 额度已恢复 / 取消 / 放弃 / 需人类处理；
- `verdicts.jsonl`：`quota-detected`（含命中的规则名）/ `quota-probe` / `quota-recovered` /
  `quota-giveup` / `quota-permanent` / `quota-aborted`；
- 会话内追加 `pi-supervisor-quota` custom entry（不进 LLM 上下文），记录 attempts / waitedMs / 错误文本；
- `/supervisor quota` 随时查看当前配置、等待状态、最后一次错误和它的分类结果。

### 测试

`quota.ts` 是零依赖纯函数，单测覆盖本机采集的 30 类真实报错：

```bash
cd ~/.pi/agent/extensions/pi-supervisor && node --test quota.test.ts
```

## Token 统计

- `/supervisor usage`：查看本进程累计 + 本 session 日志累计（token / 缓存 / 金额）+ 最近几次调用明细；
- `/supervisor status` 也会显示 `judge tokens（本进程）`；
- 统计范围：**判官调用**（bootstrap / enforce / manual / retry）与 **supervisor 触发的 compact**；每次调用以 `judge-usage` 事件写入 `verdicts.jsonl`（带 `kind` / `ms` / `usage`）；
- 预备：判官子进程用 `--mode json` 运行，从事件流里读取每次 assistant turn 的 `usage` 并汇总；测试用 plain-text stub 时会退化为无 usage（不影响判定）；
- 不包含：主 Agent 自身对话、以及 supervisor 注入消息（contract/continuation）给主会话带来的间接 token。

## 兼容性（从 stop-supervisor 重命名）

- 目录/配置：`~/.pi/agent/extensions/pi-supervisor/`；
- 会话中旧版写入的 `stop-supervisor-contract` / `stop-supervisor-state` entry **仍会被读取并恢复**（契约与暂停状态）；新写入使用 `pi-supervisor-contract` / `pi-supervisor-state`；
- 环境变量：新名 `PI_SUPERVISOR_CONFIG` / `PI_SUPERVISOR_DEBUG`，旧名 `STOP_SUPERVISOR_*` 仍可用；
- 命令 `/supervisor` 与 CLI flag `--supervise` 不变。

## 边界

- 只处理 `outcome=completed` 的停止；**Esc/abort 绝不强行续跑**；有 queued 消息时不插手。
- `outcome=error` 只在错误文本被判定为**额度/配额耗尽**时才接管（见「主模型额度耗尽」一节）；
  其余 provider 错误维持原行为，一行不改。
- print/json 模式进程会在 settle 后退出，无法热压缩；headless 长跑建议 RPC 或 `--supervise` 循环。
- 契约存在会话里：resume/压缩后自动恢复，不会重新 bootstrap。

## License

MIT — 见 [LICENSE](LICENSE)。
