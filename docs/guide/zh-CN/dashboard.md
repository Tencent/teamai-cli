# Dashboard

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

浏览器打开 `http://localhost:3721`。侧栏是总览、团队执行、工作流运行、团队上下文、资源、分发、团队改进。数据是这台机器上的。

## 工作流运行（Workflow Runs）

工作流运行页为当前工作区列出两部分。**本机运行**是这台机器上的运行文件，实时读取：状态、已租用的步骤、等待回答的 HITL 请求，以及已结束运行的记录是否已送达团队。**团队上报历史**是 `teamai-reports` 分支上所有成员的运行记录。每行显示工作流、驱动、状态、命名结局、时长、token、团队修订（没有已推送提交包含这些定义时不显示；源哈希始终显示）以及交付的拉取请求。

页面显示运行记录会发布的内容，以及每个步骤的实时状态和等待中 HITL 请求的选项。输入、`for_each` 条目、输出、提示词、HITL 消息和本地路径都留在运行文件里。HITL 问题请在运行的驱动提问处阅读。

等待中的 approve 或 choose 请求可以在运行详情里回答。回答和 CLI 走同一个 `respond` 操作，渠道为 `dashboard`，`agent: false`，因此可以回答必需审批。回答带上页面显示的 pass：如果该请求期间已被回答或替换，页面会显示拒绝原因并刷新。其他网站无法提交回答。不带 `Origin` 请求头的请求（如普通 `curl`）也会被拒绝。这只表明回答来自浏览器，并不能阻止自行设置该请求头的本地脚本。

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
teamai session pull
teamai session list                                        # --all：全部项目
teamai session search <query>
teamai session resume <name> --platform claude-code
```

迁移从不覆盖。目标工作区里已有这个会话的副本时（不论是当前还是旧版 TeamAI 写的），`migrate` 输出 `already migrated as <id>`，不写任何东西，你在副本里新加的对话都会保留。要刷新副本，先用 `session rollback <id> --platform <工具> --cwd <工作区>` 删掉它，再迁移一次。`session resume` 遵循同一规则：已恢复到该工作区的会话会输出 `already restored as <id>`，保持原样。

脚本可用 `migrate <sessionId> -s <工具> -t <工具> --json`：stdout 只输出一行，格式与 `teamai workflow` 相同，即 `{ "data": ... }` 或 `{ "error": { "code", "message" } }`；进度信息走 stderr。`data` 包含目标 `sessionId`、`cwd`、`reused` 和 `fidelity` 报告。`error.code` 标明失败原因，如 `no_adapter`（未知工具）、`tool_unavailable`（源工具或目标工具未安装，或其 CLI 无法运行）、`not_found`、`unreadable`，退出码为 1。`--json` 从不询问：缺少会话 id、`-s` 或 `-t` 时以 `prompt_refused` 失败，`--push` 需要 `-y` 或 `--scrub`。

`--dry-run` 只预览。`--scrub` 先脱敏再归档；不加时，交互运行会询问，脚本需要 `-y`。`--all` 超过 10 条要确认（push 为 5 条）。归档在 `sessions/repos/<repo>/<author>/`，按会话自己的 git remote；否则归入 `_unattributed`。工作流步骤在自己工作树里运行的会话，归到该工作树所属检出目录的仓库下。

session 命令使用本项目安装的团队仓库克隆，没有时使用用户级安装的克隆，所以只有要指向另一个克隆时才需要 `--repo-root`。没有任何安装时，它们输出 `teamai is not set up for this directory.`，提示 `teamai init` 和 `--repo-root`，并以退出码 1 退出。

业务仓库自己当团队仓库时，归档在 `teamai-reports` 分支上。另一个 teamai 命令正在写这个分支时，`session push`、`session migrate --push` 和 `session pull` 输出 `Error: Another teamai command is writing teamai-reports`，以退出码 1 退出，不改动该分支。`migrate --push` 会保留它生成的副本。等另一个命令结束后再执行一次。

同一台机器上的 `session push`、`migrate --push` 和 `session pull` 会串行执行归档修改与 Git 发布。后来的命令最多等待十秒，仍被占用时会报告锁路径并提示重试。归档写入失败后，会先删除新文件或恢复原有 transcript 与 metadata，再返回错误；重试沿用会话名。若回滚本身失败，错误会指出保留的备份路径，便于恢复。
