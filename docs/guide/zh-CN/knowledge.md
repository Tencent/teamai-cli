# 团队知识

> [English](../knowledge.md) | [简体中文](knowledge.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 知识沉淀与检索

这是 Team Context，也是 Team Improvement 的起点：先记下本次 Session 真正学到的东西，再让下一次 Agent 能检索到。

### 贡献知识

AI 通过 Hooks 追踪你的编码会话。当会话结束时（Stop hook），系统按**摩擦信号**评分——你是否打断/纠正了 AI、拒绝了工具调用，或 AI 反复重试出错的工具。又长又顺的会话（工具调用多但没摩擦）不会触发，真正踩过坑的会话才会。达标后会显示如下英文提醒：

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

提醒会列出实际触发它的非零摩擦信号；如果能取得首个任务，还会附上脱敏、单行化后的任务摘要，便于判断本次 session 是否值得分享。使用内置 `share` 工作流（`teamai skill get share`），AI 会自动总结本次 session 经验并贡献到团队知识库。每个 session 最多提示一次。

在 Codex 系列（`codex`、`codex-internal`、`tcodex`）中，Stop hook 会暂存贡献和知识引用提醒，在同一会话的下一次 UserPromptSubmit 交付，不会强制开启额外一轮。贡献提醒只交付一次；若下一次输入前已经贡献，则丢弃该提醒。

也可以手动指定文件：

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
teamai contribute --file /tmp/session.md --namespace payments
```

`--namespace` 只接受所选 scope 在 `manifest/projects.yaml` 中声明的活跃 learnings
namespace，它不一定等于项目 id。不可用或不安全的 namespace 会在经验入队前被拒绝。
不传该参数时保持上述默认行为；存在多个 namespace 时，命令会列出它们并提示如何选择。
`--dry-run` 只预览选中的路径，不写入；离线贡献在重试发布时仍保留该路径。

#### 关闭提醒

如果团队通过自己的评审流程沉淀知识（例如个人复盘后提交普通 PR），可以只关闭这条提醒，Stop hook 的其余功能（更新检查、votes 同步、dashboard 上报）照常运行。配置方式与 recall 相同，分两层：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.contributeHint.enabled` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `contributeHintEnabled` | `true` / `false`，优先级高于团队默认 |
| 环境变量 | shell | `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` | 强制关闭提醒（紧急开关） |

只影响提醒本身：摩擦评分、`teamai contribute --file` 和手动调用 `/teamai` 不受影响。

未开启 recall 时（默认关闭；团队在 `teamai.yaml` 设置 `sharing.recall.enabled: true`，或单台机器运行 `teamai recall enable`）也不会显示这条提醒：提醒指向 `share` 工作流，而 recall 关闭时 `teamai skill get share` 会拒绝执行。只读 HTTP 源上，或 teamai 配置文件存在但无法加载时，这条提醒也从不出现，因为 `share` 同样会拒绝；在未配置 teamai 的目录中也不会出现，尽管 `teamai skill get share` 在那里仍会提供。

### 搜索知识

```bash
teamai recall "API 超时"
teamai recall "GPU 内存不足"
```

- 支持中英文混合搜索
- 当前工作目录包含 project scope 配置时搜索该项目；配置 `inheritUserScope: true` 后先搜索 project、再搜索 user，并标注 `[project]`/`[user]` 来源；否则搜索 user scope
- 资源类型和文件名都相同时由 project 条目优先；不同资源类型即使文件名相同也分别保留
- 每次搜索是一次 run，其 id 跟在区块首行的结果数之后：`--- [teamai:recall:start] --- (2 results) run=<id>`。没有命中的搜索把它打印在唯一一行的末尾：`No matching learnings found for "<query>". run=<id>`。会话在 run 之后打开的当前 scope 文档会获得 upvote，详见 [Recall 采纳与 upvote](#recall-采纳与-upvote)。项目运行期间继承的 user 命中保持只读
- 当 project 配置存在但无法读取时，recall 不检索也不记录任何内容，既不退回 user scope，也不退回其后优先级更低的 project 配置（如旧的 `.teamai/config.yaml`）：输出 ``Nothing was searched: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` 并以 exit 1 退出；`--check` 同样如此，不输出任何判定。recall subagent 会原样转述这一行，而不是报告没有团队知识。完全没有配置时，recall 仍提示没有可用的 learnings 并以 exit 0 退出
- recall 构建索引时（尚无索引或索引格式过旧），如果团队 manifest 无法读取，仍会索引 learnings（若损坏的是 `manifest/projects.yaml`，只索引共享根目录），并提示一次哪些内容被排除，例如：``Recall indexed learnings only: <cause>. Docs, rules and skills stay out of recall until the team manifest is fixed and `teamai pull` rebuilds the index; `teamai doctor` shows the problem.``。skills 冲突且没有旧索引可沿用 skills 时，同样会给出提示。如果这个较小的索引无法覆盖写入旧索引，recall 在该 scope 不检索任何内容，而不是检索会返回被排除内容的旧索引，并提示：``Recall could not build the <scope> search index: <cause>. Recall skips the older index at <path>…``。其他原因导致的构建失败会显示具体原因，而不是 "No learnings available"
- 提供轻量相关性预检 `teamai recall --check "<关键词>"`，输出 `RELEVANT score=<n> threshold=<n>` 或 `NOT_RELEVANT score=<n> threshold=<n>`，不读取文件、不 upvote —— recall subagent 用它在任务与团队知识无关时跳过检索。当 top 命中为 `RELEVANT` 时，还会输出 `matched=`/`missing=`，即命中/未命中其 title 与 tag 的查询词
- `RELEVANT` 表示分数越过阈值、值得花成本读文件，**不代表**知识库覆盖了你要找的主题。请用 `matched=`/`missing=`（以及完整结果里的 `Matched:`/`Missing:` 行）自行判断：若关键区分词全部落在 missing 里，那条只是主题相邻，并非答案

### Recall 采纳与 upvote

手动反馈使用 `teamai recall feedback --positive <docId>` 或 `--negative <docId>`，作用于当前 scope。在命令前后添加全局参数 `--dry-run`，只预览请求的反馈，不修改投票，也不迁移配置或投票文件。预览会验证当前 scope 的配置，但不检查负面反馈能否减少票数；普通诊断日志仍会记录。

recall 会为返回的每篇文档计数（`recalled_count`）。运行 recall 的会话在 run 之后 24 小时内打开某篇返回的文档，该文档即被**采纳**，并获得一次 upvote（`upvoted_count`）。采纳指打开文档：如果 `teamai-recall` subagent 总结了某篇文档，而主 agent 只依据这段总结工作，就没有打开任何文档，也不会投票。只有可选开启的评判（`TEAMAI_UPVOTE_JUDGE=1`，见[开启 / 关闭 Recall](#开启--关闭-recall)）能为这种使用计分。

**recall 日志。** 每次 run 都写入当前 scope 的本地 recall 日志 `<data home>/dashboard/recall.jsonl`，该日志仅所有者可读写，从不推送。run 记录环境中的 agent 会话，以及每篇返回文档的 id、scope 和打印出的 `File:` 路径；没有命中的搜索也会记录。PostToolUse hook 追加运行 `teamai recall` 的 shell 调用，以及每次读取团队知识根目录下文件的调用。日志从不包含查询词、prompt、工具输出或文件内容。`teamai pull` 会清理日志：先删除超过 30 天的行，再从最旧的开始删到只剩 5,000 行，但从不删除最近 24 小时内尚未投票的读取，也不删除它投票所需的行。`--check`、`--dry-run` 和 `TEAMAI_RECALL_DISABLED=1` 不记录任何内容，既不写这份日志，也不写 `contribute-check` 读取的会话 recall 质量缓存。需要构建索引（尚无索引或索引格式过旧）的 `--dry-run` 在内存中构建并搜索，不保存索引。如果同一个索引缩减保护会拒绝实际重建，则继续搜索现有索引。

**run 归属哪个会话。** run 归属于自身直接运行 `teamai recall` 的 shell 调用所在的会话，因此一个 agent 运行另一个 agent 时（如 Claude 运行 `codex exec`），run 归内层 agent 的会话；只是打印了 recall 输出的调用不算。没有这样的调用时，只有环境中只设置了一个 agent 会话，run 才归该会话；否则该 run 从不投票。

**什么算打开文档。** 打开的路径必须就是 run 打印出的路径。

- agent 的读文件工具（`Read`、`read`、`view`、`read_file`、`ReadFile`）。
- 单独运行、或位于管道开头的一个读取命令：`cat`、`bat`、`less`、`more`、`head`、`tail`、`nl`、打印行的 `sed -n`，或带位置参数路径、`-Path` 或 `-LiteralPath` 的 PowerShell `Get-Content`、`gc`、`type` 和 `cat`；`gc` 和 `type` 仅在 agent 的 PowerShell 工具中、或所有路径都是 Windows 路径（带盘符或含 `\`）时才计入，因为在 POSIX shell 中 `type` 是不读取文件的内建命令。含 `;`、`&&`、`||` 或 `&` 的命令不算读取。agent 未报告状态时（如 Codex 的 shell），只有单独运行的读取命令才计入；输出中只有该命令自身的错误行（如 `cat: x.md: Permission denied`）或 shell 自身的诊断行（如 `bash: line 1: head: command not found`）时，视为读取失败；此类错误行点名的文件（如 `cat: x.md: …`）不算已读，该命令的其他文件仍计入。
- 输出展示了文件内容行的搜索：以该文件路径加 `:<行号>:` 开头的行（不带行号的 `grep` 和 `rg` 输出、以及 OpenCode 的逐文件标题行中，只加 `:`），或者该文件是唯一的搜索对象时，输出中有搜索工具的无匹配或汇总行（`No files found`、`No matches found`、`Found N matches`）以外的行（`grep`、`rg`、`ag`、`ack` 或 `git grep`，规则与读取命令相同；或 content 模式下的 `Grep` 这类搜索工具）。
- 列出文件（`Glob`、`ls`、`find`、`rg --files`、`grep -l`、搜索工具的文件列表）、计数（`grep -c`、count 模式）和失败的读取都不算。
- 在 Windows 上，路径无论怎样书写都计入：盘符大小写不同、使用 `\` 或 `/`，或用 Git Bash 的 `/c/…` 表示 `C:\…`。

**subagent。** 由 `teamai-recall` subagent 运行的 recall，其自身的读取从不计入；同一会话中主 agent 或其他 subagent 的读取则计入。subagent 用内部参数 `--caller teamai-recall` 标记自己的 run，Claude Code 以及 18.3.2 起的 OMP 也会在 hook 中注明该 subagent。主 agent 之后的读取能否计入 subagent 的 run，取决于 agent：见下表。

**何时投票。** Stop hook 将 run 与读取关联，每篇被采纳的文档每个会话只 upvote 一次；能显示 hook 输出的 agent 会打印 `[teamai] Adopted team knowledge this session: <ids>`。在会话最后一次 Stop 之后才读取文档的 subagent，会在其 SubagentStop 时计入（Claude Code、Codex、CodeBuddy 和 Qoder），此时不推送任何内容，主 agent 不必等待 git：投票由下一次 Stop 或 pull 推送。Copilot CLI 的 SessionEnd 与 Stop 一样计入并推送投票，因此最后一轮没有触发 Stop 的会话也能投票，但它不打印任何内容。`teamai pull` 会补记仍待处理的读取，例如之后再无 hook 触发的读取，或其 Stop 遇到投票文件被占用的读取。第二天恢复的会话再次打开该文档不会增加投票，除非它再次 recall 到该文档。

**各 agent 支持情况。** *直接 recall*：主 agent 运行 `teamai recall`，之后打开文档。*subagent 路径*：`teamai-recall` subagent 运行 recall，之后由主 agent 或其他 subagent 打开文档。

| Agent | 直接 recall | subagent 路径 |
|-------|-------------|---------------|
| Claude Code | 支持 | 支持 |
| Codex | 支持 | 支持，Codex 0.134 起，其 hook 会注明 subagent |
| CodeBuddy、WorkBuddy | 支持（未验证） | 支持，CodeBuddy 2.103.1 起，其在 subagent 内的 hook 携带主会话（WorkBuddy 未验证） |
| Qoder | 支持 | 支持（未验证） |
| Copilot CLI | 支持 | 不支持：subagent 有自己的会话，且没有 hook 将其关联到父会话 |
| Cursor | 支持 | 不支持：同 Copilot CLI |
| OpenCode | 支持 | 支持：`task` 调用将 subagent 的会话关联到父会话 |
| OMP | 支持，仅通过其 `bash` 调用的认领确定归属 | 支持：subagent 的会话文件位于父会话文件之下，父会话文件的会话头把两个会话关联起来（对照 OMP 18.4.8 验证） |
| Pi | 支持 | 不适用：TeamAI 不向 Pi 部署 subagent |
| ZCode | 支持 | 不支持：ZCode 在 subagent 内不运行 hook |
| OpenClaw、Hermes、Kiro、JoyCode | 不支持：没有 PostToolUse hook | 不支持 |

*未验证*：依据该 agent 文档记载或读源码得到的 hook 负载实现并测试，尚未在真实会话中核对。

**已知限制。**

- **Cursor、Copilot CLI 和 ZCode 的 subagent。** 在 subagent 中运行的 recall 从不为主 agent 的读取计分：Cursor 和 Copilot CLI 给 subagent 分配独立会话且不关联父会话，ZCode 在 subagent 内不运行 hook。主 agent 自己运行的 recall 可以正常投票。
- **OMP。** subagent 路径要求主会话文件已写入磁盘：主会话没有会话文件时（`--no-session`），subagent 无法关联到父会话，也不产生采纳。OMP 不在 shell 中设置会话变量，因此 run 只能通过运行它的 `bash` 调用的认领确定归属：OMP 把大段输出转存为 artifact 时，`run=` 行和投票都会丢失；从 Claude Code shell 启动的 OMP 会先把 run 记在 Claude 会话下，直到该认领将其纠正。
- **不计入的搜索。** OMP 的 `grep`（markdown 树形输出）和 Cursor 的 `Grep` 不产生证据；打开文档仍然计入。ZCode 打印的 `Grep` 行是相对其工作目录的路径，因此从团队仓库内的目录发起的 ZCode 搜索不计入。
- **没有 PostToolUse hook。** OpenClaw、Hermes、Kiro 和 JoyCode 会记录其 recall，但不记录读取，因此这些 recall 从不投票。
- **旧版 CLI。** 使用旧版 TeamAI 的成员仍从会话 transcript 投票，该路径以文件的 basename（`SKILL`、`setup`）而非 recall 打印的 id（`retry`、`common/setup`）作为 skill、子目录中的文档或 wiki 页面的键，因此这些投票落不到该文档上。顶层的 learnings 和文档不受影响，升级后即可解决。

**在 `teamai stats` 中查看。** 当前 scope 的 recall 日志中有 run 时，`teamai stats` 会在 skill 使用统计之后追加一个 recall 小节，列出最近执行过 recall 的 10 个会话，最新的在前：

```text
Recall (last 10 sessions):

  session   agent   runs  recalled  adopted
  3f2a9c1e  claude     3         3        1
  a41d07b2  codex      1         2        0
```

`session` 是 agent 会话 id 的前 8 个字符；subagent 自己的会话（OpenCode 的 task 工具）计入启动它的那个会话。`agent` 取自该会话中最新一个能确定 agent 的 run：认领该 run 的 hook 所属的 agent，否则为其环境变量指明的 agent；都无法确定时显示 `-`。`runs` 统计归属于该会话的 run，没有命中的搜索也算；会话有歧义且从未被确认的 run 不计入，`--check` 不算 run。`recalled` 统计这些 run 返回的不同文档数，`adopted` 统计其中已被 upvote 的文档数：仍在等待会话 Stop 的读取暂不计入。日志中没有 run 时，输出与之前完全相同。

### 开启 / 关闭 Recall

Recall 功能通过两级配置控制——管理员设置团队默认值，成员可在本地覆盖：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.recall.enabled` | `true` / `false`（默认 `false`） |
| 用户覆盖 | `~/.teamai/config.yaml` | `recallEnabled` | `true` / `false`，优先级高于团队默认 |
| 环境变量 | shell | `TEAMAI_RECALL_DISABLED=1` | 强制禁用所有 recall hooks（应急开关） |
| 环境变量 | shell | `TEAMAI_UPVOTE_JUDGE=1` | 可选开关：git 团队会话中，后台向本地已登录的 CLI 询问最新回复是否实质性用到了每条本会话尚未 upvote 的召回文档，并为该子集补记 upvote。已在本会话 upvote 台账中的文档（会话打开过它，或此前的评判已为它记 upvote）不会再送去评判，因此每篇文档每会话最多记一次 upvote；评判未采纳的文档会在后续轮次再次评判；项目激活时不会为继承的 user 作用域文档记 upvote。默认关闭；分离进程运行（不增加延迟），使用你自己的 CLI 订阅 |

```bash
teamai recall enable     # 开启 recall，部署 subagent 和 rules
teamai recall disable    # 关闭 recall，移除 subagent 和 rules
teamai recall status     # 查看当前生效状态（团队默认 + 用户覆盖）
```

在 `enable` 或 `disable` 后添加 `--dry-run`，可预览配置和托管文件的变化，不会写入磁盘。

关闭后，`teamai pull` 将跳过部署 recall subagent 和 TodoWrite 提醒 hook，并从团队指令中移除 recall 块。手动执行 `teamai recall <query>` 搜索不受此开关影响。

### 知识库维护

随着时间推移，部分 learnings 会积累低置信度（无人 upvote）或变得过时。`teamai recall maintenance` 可保持知识库健康：

参数见 [`commands.md`](../../../skill-data/core/references/commands.md) 和 `teamai recall maintenance --help`。

```bash
# 预览过时条目，不做任何修改
teamai recall maintenance --prune --dry-run

# 归档低置信度 learnings（置信度 < 0.15）
teamai recall maintenance --prune --archive

# 按当前投票重新计算并回写置信度分数
teamai recall maintenance --confidence-writeback

# 查找过时条目并生成更新草稿
teamai recall maintenance --update-quality
```

运行 `--update-quality` 后，审查生成的 `.draft.md` 文件，将满意的文件重命名为 `.md` 即可应用更新。

另一个 teamai 命令持有 learnings 或 reports checkout 的锁时，`recall maintenance` 与 `recall promote` 会以退出码 1 停止，不写入任何内容（`The learnings checkout is locked: …`）。待该命令结束后再运行。

maintenance 与 promote 只发布它们改动过的 learning。learnings 检出中无人提交的文件不会进入它们的提交。发布无法进行或推送失败时（`Maintenance changes stay local for now: …`），下一次 `teamai pull` 或 `contribute` 会发布这些改动，即使队列中没有 learning。在那次运行之后被手动编辑过的 learning 不会作为它的一部分发布：该编辑保持未提交，警告会指出文件名。检出中有人暂存（staged）的文件在发布后仍保持暂存；若 origin 也改动了它、无法按原样重新暂存，它的内容会保留为未暂存的改动，警告会指出该文件。

### 晋升 Learnings

当 learning 达到成熟标准时，可将其晋升为正式团队知识（skill、rule 或 doc）。晋升判据：置信度 ≥ 0.90、≥ 5 次 upvote、≥ 2 个不同贡献者、存在时长 ≥ 14 天。

```bash
# 列出所有可晋升候选
teamai recall promote

# 晋升指定 learning（AI 将其改写为目标格式）
teamai recall promote <learningId>

# 晋升到指定类别
teamai recall promote <learningId> --category skills

# 预览操作，不写入文件
teamai recall promote <learningId> --dry-run
```

参数见 [`commands.md`](../../../skill-data/core/references/commands.md) 和 `teamai recall promote --help`。

---

## 知识库健康报告

看板内置了一个 **KB Health**（知识库健康）报告页面，展示团队知识库的使用情况与健康状态，涵盖 `teamai recall` 投票、learnings、docs、rules 和 skills 采集到的所有数据。

```bash
# 启动看板后，进入 Team Context（知识库健康）或 Team Improvement（维护）
teamai dashboard

# 报告也可直接访问：
#   http://localhost:3721/kb-report
```

报告会聚合本地 `~/.teamai` 知识库（或已配置的团队仓库），打开页面即按需渲染，无需任何参数。

### 报告内容

| 区块 | 说明 |
|------|------|
| **概览卡片** | 总条目数、总召回次数、整体覆盖率%、贡献者数 |
| **各类型覆盖率** | skills、rules、docs、learnings 的召回覆盖率分类 |
| **高频召回排行** | 召回次数最多的条目排名列表 |
| **沉默条目** | 从未被召回的条目——待剪枝或重写的候选 |
| **最近召回月份** | 每条知识仅在最近一次召回的月份计数一次，不表示每月召回总次数 |
| **作者贡献** | 每位贡献者的条目数与召回占比 |
| **维护控制台** | 三个操作区：待晋升条目、建议归档条目、过时待更新条目，每条附可复制命令 |

### 典型工作流

```
打开看板 → Team Improvement
   ↓
查看维护控制台
   ↓
晋升成熟 learnings：
   teamai recall promote <learningId>
   ↓
归档低价值条目：
   teamai recall maintenance --prune --archive
   ↓
更新过时的 docs/rules/skills：
   teamai recall maintenance --update-quality
   （审查 .draft.md → 重命名为 .md）
   ↓
teamai push   # 将清理后的知识库分享给团队
```
