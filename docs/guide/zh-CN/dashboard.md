# Dashboard

> [English](../dashboard.md) | [简体中文](dashboard.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard             # 启动 Web 面板（默认端口 3721）
teamai dashboard --port 8080
```

侧栏包含 **Overview（总览）**、**Team Execution（团队执行）**、**Team Context（团队上下文）**、**Team Improvement（团队改进）**。总览汇总三模块；执行页展示本机会话，支持按仓库（同一仓库的所有 worktree 合为一项）和 AI 工具筛选及完整详情；上下文页保留 KB Health（含作者贡献和从未召回条目）；改进页保留本机趋势及晋升、归档、质量更新维护命令。命令需在终端使用，页面不执行维护操作。

页头支持英文/简体中文及日间/夜间/跟随系统主题，浏览器存储可用时记住偏好。用户输入、AI 输出、知识标题和命令保持原文。独立 `/kb-report` 继续提供原有完整报告。

实时状态仅限**本机**，沿用事件流与 SSE，支持自动重连并轮询校准会话状态。最近结束会话仍按原有 30 秒保留窗口展示。知识报告显示本机/团队来源及报告生成时间，**不将其称为团队同步时间或跨成员实时状态**。刷新失败时明确提示，并保留上一次成功结果供参考。

工作区切换覆盖已安装的项目范围和用户范围；同一项目的 worktree 归为一个项目，全部工作区视图显示全部本机会话及启动时的知识库范围。新安装范围后重启仪表盘即可发现。

## 人工干预指标（Human Intervention）

每个会话行显示**人工干预次数**，悬停或打开详情可查看分类明细，三类信号各计一次：

| 类型 | 含义 | 数据来源 |
|------|------|----------|
| `interrupt` | 用户在 agent 执行中途按 ESC 打断 | transcript 中被中断的 turn |
| `toolReject` | 用户拒绝某个工具调用（permission deny） | transcript 中标记拒绝的 tool_result |
| `correction` | agent stop 后 60s 内用户追加含「不对 / 重来 / 错了 / wrong / redo / 違う / やり直し」等纠偏词（内置中、英、日，外加团队自定义词）的 prompt | stop → prompt_submit 事件模式 |

> 隐私：团队共享的干预统计仅含计数。本机 dashboard 事件流可保存经密钥脱敏且最长 200 个字符的输入摘要与 AI 输出用于详情展示；`~/.teamai/debug.log` 会记录相同的脱敏输入摘要。页面不会上传这些内容。

以空格分词的文字（英语、西班牙语等）中的纠偏词必须整词匹配，因此西班牙语 "segundo" 不会被算作 `undo`；中文、日文纠偏词仍按子串匹配。内置列表只覆盖中、英、日三种语言，其他语言的纠偏在团队于 `teamai.yaml` 添加自己的词之前不会被识别。团队词与内置列表合并，忽略大小写，遵循同样的匹配规则：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, deshaz, "no era eso", "otra vez"]
```

匹配在 `UserPromptSubmit` hook 捕获 prompt 时完成，因此修改团队纠偏词后，下一次 `teamai pull` 之后的新 prompt 才会生效；之前记录的会话不会重新评估。

匹配时，prompt 和纠偏词都会转换为 Unicode NFC 形式。例如，`réessaye` 可以匹配 `re\u0301essaye`，其中 `\u0301` 是组合尖音符。重音符号仍有区别，因此 `reessaye` 不匹配。规范化仅用于匹配，不会改变 60 秒的纠偏时间窗口。纠偏检测在内存中使用原始 prompt，随后丢弃原文；本机仅保存经密钥脱敏且最长 200 个字符的摘要。

干预数据会随 `teamai pull` 自动聚合上报到团队 `stats/<user>.yaml`，并在 `teamai digest` 的「会话自主性」榜单中给出团队均值与人均干预率排行，可用于验证某个 skill / rule 上线后干预率是否下降。无 transcript 的工具（如 Cursor）会优雅降级，只统计 `correction`。

## 对话量与 Token 用量

每个会话行还显示以下两列；详情保留经密钥脱敏的输入摘要、Markdown AI 输出、时间戳和最近工具：

| 列 | 含义 | 数据来源 |
|------|------|----------|
| 对话轮数 | 该会话里**人类对话的轮数**（发了几次 prompt） | `UserPromptSubmit` 事件数 |
| Token | 该会话累计 **token 用量**（鼠标悬停看 输入 / 输出 / 缓存读 / 缓存写 明细） | Claude Code `message.usage`、CodeBuddy `requests[].usage`，或 Codex 最新的会话级 `token_usage_record`；旧版 `event_msg.token_count` 按 rollout 文件各取最新快照后累加 |

> 隐私：团队共享的轮数和 Token 指标仅含计数。Dashboard 详情中的脱敏输入摘要和输出保留在本机。

这两项同样随 `teamai pull` 聚合到 `stats/<user>.yaml`（`prompts` 与 `tokens` 字段），并在 `teamai digest` 的「对话量与 Token 用量」板块给出团队对话总轮数、token 总量（分桶）与人均 token 用量排行。拿不到 transcript 的工具（如 Cursor）会优雅降级：仍统计对话轮数，token 显示为 0 / N/A。

## 每日会话趋势与估算成本

Dashboard 和 digest 会比较最近 7 个 UTC 自然日与此前 7 天。Dashboard 费用卡片改为**有定价数据会话的平均已知估算费用**：先筛选首次 Stop 落在该窗口的会话，汇总这些会话已知的已定价请求费用，再除以其中至少有一个已定价请求的会话数。无定价数据的会话不进分母；已定价且费用为零的会话计入。卡片展示定价覆盖数。恢复执行的会话仍归属首次 Stop 日期，其他日期的已知请求费用也计入该会话。原有 `avgRequestCostMicros` 接口字段和 digest 按请求日期统计的口径不变。会话归属到首次 stop 事件所在日期，每个已定价请求则归属到请求自身的 UTC 日期；

活跃时长只累计不超过 5 分钟的相邻事件间隔，避免终端空闲时间把数据放大。会话结束时没有错误、中断或纠偏才计为成功；被拒绝的工具调用仍作为独立干预信号统计。仅包含模型、token 数、估算成本和价格表版本的请求明细保存在本地 `~/.teamai/dashboard/requests.jsonl`，不包含提示词或回复内容；重复 Stop 不会重复写入，超过 90 天会自动清理。

成本是 API 等价估算值：对可识别的 Claude 模型，根据带版本的公开目录价，以及 transcript 中的输入、输出、缓存读取和缓存写入 token 分桶计算。由于 transcript 不提供缓存 TTL，缓存写入按 5 分钟费率估算。未知模型以及无法取得详细用量的工具不会进入估算成本，也不会进入成本覆盖率分母。该数据适合观察趋势，但不等同于账单或订阅席位费用。

每日聚合会在 `teamai pull` 时写入 `stats/<user>.yaml`；原有累计字段继续作为历史总量展示。恢复执行的会话会在原记录上更新，不会重复累计已完成会话。团队仓库只接收聚合计数和按微美元保存的估算总额；prompt 原文与逐请求记录保留在本机。

## Session Save（会话存档）

`teamai session save` 把 dashboard 已有的**单次会话事件流**（工具调用序列、prompt 轮次、干预记录）折叠成一份精简、脱敏的 markdown 摘要——不调用 LLM，也不新增采集路径。

```bash
teamai session save                    # 存档当前 agent 会话（否则为最近一次会话，本地）
teamai session save --session-id <id>  # 存档指定会话
teamai session save --push             # 把「有价值」的会话推送到团队仓库
teamai session save --push --force     # 即便是琐碎会话也推送
teamai session save --push --include-prompt  # 额外带上（脱敏后的）首个 prompt 行
```

**本地（始终执行）：** 追加到 `~/.teamai/session-logs/<年-月>.md`。按会话幂等（当月已记录的会话会跳过），且超过 90 天的日志会自动清理。每条记录用 `Project:` 标出会话所属的仓库（同一仓库的所有 worktree 相同），用 `Directory:` 标出其工作目录。

月度日志的读取、完整会话 ID 去重与写入使用跨进程锁串行执行，最多等待五秒，失败后提示重试；更新通过原子替换保留完整文件，读取失败时不覆盖原记录。团队摘要复用同一写入事务。

**团队（`--push`，需显式开启）：** 直接提交（不走 PR）到 `teamai-reports` 分支的 `sessions/<user>/<年-月>.md`——正是 `teamai digest` 读取的路径，于是该会话会出现在 **Session Highlights** 板块。默认只推送**有价值**的会话：出现摩擦（interrupt / tool-reject / correction）或工具使用充分（≥ 3 种不同工具）。琐碎会话除非加 `--force`，否则只留本地。对只读（HTTP 模式）的团队，`--push` 会优雅失败并保留本地日志。

> 隐私：推送到团队的内容默认**只含计数 + 工具名**。首个 prompt 行需通过 `--include-prompt` 显式开启，且即便开启也会经过与别处一致的密钥脱敏（`ghp_…` → `<REDACTED:…>`）。本地日志因为不出本机，会保留脱敏后的首个 prompt 行。
