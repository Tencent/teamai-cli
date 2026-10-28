# Dashboard

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

浏览器打开 `http://localhost:3721`。侧栏是总览、团队执行、工作流运行、评分器、团队上下文、资源、分发、团队改进。数据是这台机器上的。

## 会话共享（Session sharing）

总览页的**会话共享**面板针对当前工作区，说明在每种[运行模式](workflow.md#有人值守与无人值守的运行)下会话是否发布到 `teamai-reports`、是否评分，以及原因：

- 每种模式的发布和评分策略，以及它来自哪项设置，如 `the default` 或 `teamai.yaml sessions.publish.unattended`。`ask` 目前等同于 `off`。
- 本机在每种模式下捕获的会话：活跃、等待 drain、保留在本机、等待归档、已归档。文件已不存在的会话不计入。另有已结束运行中等待归档的步骤会话。
- 正在等待的内容，以及要运行的 drain。drain 只结束并发布与其运行模式相同的会话，因此在有人值守的机器上，面板会为无人值守会话给出 `TEAMAI_MODE=unattended teamai score --drain`，在 Windows 上则是 `$env:TEAMAI_MODE='unattended'; teamai score --drain`。
- 归档位置、`daily_limit`、评判会话的评分器、teamai 不读取其会话的已启用工具，以及 `teamai doctor` 报告的设置问题。

**本机**是启动 `teamai dashboard` 的 shell 的运行模式。面板只显示计数和设置名，从不显示会话内容，也不修改任何设置。相关设置见[会话](sharing.md#会话)和[已结束的会话](scorers.md#已结束的会话)。

## 工作流运行（Workflow Runs）

工作流运行页为当前工作区列出三部分。**本机运行**是这台机器上的运行文件，实时读取：状态、已租用的步骤、等待回答的 HITL 请求，以及已结束运行的记录是否已送达团队。**团队上报历史**是 `teamai-reports` 分支上所有成员的运行记录。每行显示工作流、驱动、状态、命名结局、时长、token、团队修订（没有已推送提交包含这些定义时不显示；源哈希始终显示）以及交付的拉取请求。

**交接的运行**是有人[发布](workflow.md#在另一台机器上继续运行)的运行中的运行，每个都附带接手它的命令：

| 行 | 所需条件 | 下一步 |
|---|---|---|
| `release` · 待接手 · alice | 需要人工：only a person can answer the approval at ship | 由人运行 `teamai workflow resume <run> --claim` |
| `ship-issue` · 待接手 · alice | 无：运行器可以完成 | 在该仓库的检出中运行 `teamai workflow resume --next` |
| `release-docs` · 待接手 · alice | 运行器需要：环境变量 `SIGNING_KEY`、运行 notes 的工具。本机缺少：sign requires env SIGNING_KEY, which has no value here → teamai env set SIGNING_KEY, or set it in the environment | 在该仓库的检出中运行 `teamai workflow resume --next` |
| `nightly-report` · 持有中 · bob | — | `teamai workflow resume <run> --claim` 从 bob 接管 |

在交出运行的那个安装上，下一步改为 `teamai workflow resume <run>`，在那里把它收回。待接手的本机运行，或现在由其他安装持有的本机运行，会在状态下方注明。**运行器需要**（需要人工的运行上为**其机器需要**）列出剩余步骤的 `requires.env` 键和提示词步骤：照[其作业](workflow.md#从-ci-接手交出的运行)那样在运行器上配好。**本机缺少**是本机缺的那部分，与 `teamai workflow resume` 列为 `cannot run here` 的一致。状态栏统计待接手的运行和需要人工的运行。页面本身不认领任何运行：命令在接手运行的机器上启动驱动。

页面显示运行记录会发布的内容，以及每个步骤的实时状态和等待中 HITL 请求的选项。输入、`for_each` 条目、输出、提示词、HITL 消息和本地路径都留在运行文件里。HITL 问题请在运行的驱动提问处阅读。运行详情显示每个 pass 的产出：它分支上的 commit、为它交付的拉取请求，以及 `teamai contribute` 在它的 attempt 中记录的经验。

等待中的 approve 或 choose 请求可以在运行详情里回答。回答和 CLI 走同一个 `respond` 操作，渠道为 `dashboard`，`agent: false`，因此可以回答必需审批。在 agent 会话中启动的仪表盘记录为 `agent: true`，与从该 shell 回答相同，不能回答必需审批。回答带上页面显示的 pass：如果该请求期间已被回答或替换，页面会显示拒绝原因并刷新。其他网站无法提交回答。不带 `Origin` 请求头的请求（如普通 `curl`）也会被拒绝。这只表明回答来自浏览器，并不能阻止自行设置该请求头的本地脚本。

## 评分器（Scorers）

评分器页面显示每个有标签的[评分器](scorers.md)的通过率，数据来自 `teamai-reports` 上的 `scores/<member>/<YYYY-MM>.jsonl` 和本机的标签存储。它回答两个问题：评分器的通过率是否在变化，以及它是否因工具、模型、团队修订或定义而不同。

**一次只看一个度量。** 一个度量固定了评分器、评分标准版本（`rubric.sourceHash`，有 `teamRevision` 时一并显示）、来源（`workflow` 或 `session`）、运行模式，以及评审（人工标注，或评审的工具和记录的模型）。其中任何一项不同的标签都不会合并统计。评分器有模型评审时默认打开模型评审的度量，即使成员人工标注的会话更多也是如此；并默认打开标签带有 `teamRevision` 的最新评分标准，因此未提交的草稿不会成为默认视图。其他度量列在数字上方。没有运行模式的标签计入“未记录”。

**页面显示：**

- 7、30、90 或 180 天时间窗口内的通过率，以及标签数、通过数和未通过数。时间窗口按标签的评分时间计算，而不是工作发生的时间。之后重新评分的标签只计一次，计在重新评分的时间。
- 每周趋势。没有标签的一周显示为空缺，而不是 0%。
- **按值统计的标签**：此度量中保存每个值的标签有多少，以及该值对应的分数，分数高的在前。这些计数加起来等于标签数，因此有两个以上取值的评分器不会丢掉区分各种未通过的信息，也可以从中读出精确率或召回率。值按标签保存的原样显示。
- 通过与否以每个标签保存的结果为准。修改评分器的 `passingScore` 不会改变过去的结果。
- **分组依据**：工具、模型、团队修订、智能体定义、团队资产交付时针对的角色、项目或标签、指纹，或工作使用的团队技能。列出两个技能的标签会同时计入两组。模型分组会把工具报告的模型和仅请求的模型分开。没有记录该项的标签记为“未记录”。工作流标签按它评审的那一轮的智能体分组，从运行记录中读取。在记录智能体之前的运行只提供定义。
- **按团队提交拆分。** 给出团队仓库的一个提交。标签的团队修订包含该提交时算作“之后”，由本机团队克隆中的 `git merge-base --is-ancestor` 检查。没有团队修订、或修订不在本机克隆中的标签记为“未记录”。拆分也作用于每个分组，因此可以比较加载某个技能的会话在修改该技能的提交前后的表现。
- **未通过的标签**，最新优先：作者、评分时间、平台和使用的技能。页面每次列出 25 条，最多 1,000 条，点击 **显示更多** 列出后面的标签。选择一个分组即可只列出它的未通过标签。已推送到团队归档的会话显示 `teamai session resume <name> --platform <platform>`。工作流标签可以打开它的运行。
- **摩擦提醒**（会话度量）：摩擦提醒触发过和未触发的会话，其中有多少有此度量的标签，以及其中多少通过。它只统计此时间窗口内（最多最近 30 天）在本机开始的你自己的会话，因为提醒状态只保存在本机。项目工作区统计它自己的会话。用户范围工作区统计本机上在所有项目工作区之外开始的会话。通过率只计算已标注的会话。本机没有提醒状态的会话记为“未记录”。会话的状态文件在最后一次写入一天后被删除时，teamai 会把它的提醒是否触发保留 30 天。

**评审者与人工标注的一致性**（会话度量）。[人工标注](scorers.md#手动标注会话)是成员自己对会话的判断。这个面板说明评审者的通过率是否可信：

```text
评审者与人工标注的一致性   13 个人工标注的会话
评审者                           标签数  已配对  一致  一致率  评审通过，人工未通过  评审未通过，人工通过
claude-code / claude-sonnet-4-5  23      8       6     75%     1                     1
codex / gpt-5.1-codex            12      3       1     33%     2                     0
人工标注                         13

不一致之处
人工标注         标注人  评审结论   评审者                           评分时间    打开
missed-bug 未通过  bob     good 通过  claude-code / claude-sonnet-4-5  10/27/2026  未推送到团队归档
partial 未通过     alice   good 通过  codex / gpt-5.1-codex            10/26/2026  teamai session resume claude-code_add-a-timeout-to-the-webhook-client_20261026 --platform claude-code
```

这里 Codex 评审者让两个团队判为未通过的会话通过了，因此它的通过率偏高。打开这些会话，然后改进评分标准的提示词或标签描述。

- 时间窗口内该评分标准的每个评审标签，与其会话最新的人工标注配对，无论由谁、何时标注。只有评分标准仍列有该值时，人工标注才会配对：以 `teamai pull` 缓存的评分器为准，或以本机团队克隆中该评分标准的标签所带团队修订处的评分器文件为准。因此修改提示词后，新评分标准的评审标签会与已有的人工标注配对。
- 一致性按通过与否计算。**评审通过，人工未通过**表示评审者比成员宽松，**评审未通过，人工通过**表示它更严格。
- **不一致之处**列出每一处不一致，最新的在前。
- 评分器表格的**与人工标注一致**列显示每个评分器默认度量的同一结果。

基准测试运行的标签不计入。页面只读取标签和记录的配置，从不读取或显示评审的推理、提示词、对话记录、diff 或会话自身的 id。

来自会话和工作流运行的标签反映的是工具在实际遇到的工作上的表现。要在相同任务上比较工具、模型或团队资产，请运行基准测试。

## 资源（Resources）

资源页列出团队仓库里的每条规则在当前工作区的情况：名称、命名空间、描述，以及 `pull` 是否会把它交付到这里。根规则人人都收到；命名空间规则跟随活跃的知识命名空间；同名根规则被活跃命名空间规则取代时会标注「已取代」；被标签订阅排除的规则也会标注。

## 人工干预指标（Human Intervention）

每个会话计三种次数：中途打断（`interrupt`）、拒绝工具调用（`toolReject`）、结束后马上用「不对 / 重来 / wrong」这类词纠正（`correction`）。

团队可以加自己的词：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, "no era eso"]
```

改完后下次 `pull` 起的新输入才按新词计算。上报到团队的是次数，不是原文。

## 对话量与 Token 用量

会话行上有对话轮数和 token。拿不到用量的工具，token 显示为 0。

7 天趋势只统计你自己的会话：teamai 启动的会话（如工作流步骤）不计入。趋势下方按[运行模式](workflow.md#有人值守与无人值守的运行)拆分最近 7 天结束的会话：有人值守、无人值守，以及记录模式之前的会话 `not recorded`。参见[使用统计上报](reporting.md#按运行模式统计你的会话)。

## 会话产出（Session Outcomes）

总览的**已结束会话的产出**面板显示当前工作区最近 30 天内被使用统计上报计入的会话：产出了 commit、拉取请求或经验的会话占比；按运行模式和产出分行，带每个会话的 token 和干预次数（参见[使用统计上报](reporting.md#你的会话产出了什么)）；以及最近的会话和它们的 commit、拉取请求链接和经验。

会话行和会话详情显示 `teamai contribute` 为该会话记录的经验。它的 commit 和拉取请求在会话空闲 6 小时后才计入，那时会话行已离开列表，因此显示在上述面板中。这些 ID、哈希和链接只保存在本机。

## Session Save（会话存档）

```bash
teamai session save
teamai session save --session-id <id>
teamai session save --push
teamai session save --push --force
```

本地写到 `~/.teamai/session-logs/<年-月>.md`。`--push` 把有摩擦或用了至少 3 种工具的会话交到团队的 `teamai-reports` 分支。默认不带 prompt 原文。

## Session 同步与迁移

`teamai session` 在工具之间迁移完整会话，或归档到团队仓库。`session save` 仍是脱敏摘要。

平台：`claude-code`、`codex`、`codebuddy`、`codebuddy-ide`、`cursor`、`workbuddy` 和 `opencode`（通过 2.0 及以上版本的 `opencode` CLI；作为目标时，目标工作区必须已存在）。`teamai session platforms` 查看本机已安装的。 CodeBuddy CLI 和 WorkBuddy 的项目目录名超过 255 个 UTF-8 字节时，使用工具原生的 180 字节前缀和 hash，长工作区路径也能列出、读取和迁移会话。在 Windows 上，`cursor` 和 `workbuddy` 不能作为 migrate 或 resume 的目标：它们要等 `sqlite3` CLI 登记后才会列出会话，所以 TeamAI 直接拒绝，而不是写一份它们永远不显示的副本。

```bash
teamai session migrate <sessionId> -s codebuddy-ide -t claude-code
teamai session migrate --all -s codebuddy -t claude-code   # --limit 可限量
teamai session rollback <id> --platform claude-code
teamai session push --source codebuddy                     # --all：该平台全部工作区
teamai session push --session <id> --source claude-code    # 只推送这一个会话，已脱敏
teamai session pull
teamai session list                                        # --all：全部项目
teamai session search <query>
teamai session resume <name> --platform claude-code
```

迁移从不覆盖。目标工作区里已有这个会话的副本时（不论是当前还是旧版 TeamAI 写的），`migrate` 输出 `already migrated as <id>`，不写任何东西，你在副本里新加的对话都会保留。要刷新副本，先用 `session rollback <id> --platform <工具> --cwd <工作区>` 删掉它，再迁移一次。`session resume` 遵循同一规则：已恢复到该工作区的会话会输出 `already restored as <id>`，保持原样。

脚本可用 `migrate <sessionId> -s <工具> -t <工具> --json`：stdout 只输出一行，格式与 `teamai workflow` 相同，即 `{ "data": ... }` 或 `{ "error": { "code", "message" } }`；进度信息走 stderr。`data` 包含目标 `sessionId`、`cwd`、`reused` 和 `fidelity` 报告。`error.code` 标明失败原因，如 `no_adapter`（未知工具）、`tool_unavailable`（源工具或目标工具未安装，或其 CLI 无法运行）、`not_found`、`unreadable`，退出码为 1。`--json` 从不询问：缺少会话 id、`-s` 或 `-t` 时以 `prompt_refused` 失败，`--push` 需要 `-y` 或 `--scrub`。

`--dry-run` 只预览。`--scrub` 先脱敏再归档；不加时，交互运行会询问，脚本需要 `-y`。`--all` 超过 10 条要确认（push 为 5 条）。`push --session <id>` 只推送 `--source` 的这一个会话，不限工作区，总会脱敏，也不询问。归档在团队仓库 `teamai-reports` 分支的 `sessions/repos/<repo>/<author>/`，按会话自己的 git remote；否则归入 `_unattributed`。工作流步骤在自己工作树里运行的会话，归到该工作树所属检出目录的仓库下。

session 命令使用本项目安装的团队仓库克隆，没有时使用用户级安装的克隆，所以只有要指向另一个克隆时才需要 `--repo-root`。没有任何安装时，它们输出 `teamai is not set up for this directory.`，提示 `teamai init` 和 `--repo-root`，并以退出码 1 退出。

旧版 teamai 归档在默认分支上的会话仍可在那里读取。`session list`、`search` 和 `pull` 会读取两处，先读 `teamai-reports`，两处都有的会话只列出一次。`session resume` 先读 `teamai-reports`，再读旧归档。teamai 0.28.0 及更早版本只读取默认分支，因此要让每位成员都升级，才能看到队友归档在 `teamai-reports` 上的会话。无人值守任务用 `teamai score --drain` 归档自己的会话（见[会话](sharing.md#会话)）。

另一个 teamai 命令正在写 `teamai-reports` 时，`session push`、`session migrate --push` 和 `session pull` 输出 `Error: Another teamai command is writing teamai-reports`，以退出码 1 退出，不改动该分支。`migrate --push` 会保留它生成的副本。等另一个命令结束后再执行一次。

同一台机器上的 `session push`、`migrate --push` 和 `session pull` 会串行执行归档修改与 Git 发布。后来的命令最多等待十秒，仍被占用时会报告锁路径并提示重试。归档写入失败后，会先删除新文件或恢复原有 transcript 与 metadata，再返回错误；重试沿用会话名。若回滚本身失败，错误会指出保留的备份路径，便于恢复。
