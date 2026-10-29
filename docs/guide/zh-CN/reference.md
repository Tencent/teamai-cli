# 参考

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 命令参考

完整列表见 [`skill-data/core/references/commands.md`](../../../skill-data/core/references/commands.md)，或运行 `teamai --help` 和 `teamai <command> --help`。

---

## 配置文件参考

### teamai.yaml（远端团队配置）

```yaml
team: my-team
description: 团队 AI 资源仓库
repo: https://github.com/your-org/your-repo.git
provider: github
# language: en                # 可选。en 只用英文。省略或 zh 保持中英双语的 recall 规则、TodoWrite 提示和已合入 MR 提示
# scope: 若存在则忽略。本机安装位置由 teamai init --scope 决定

reviewers:
  - reviewer1

packages:
  npm:
    - name: typescript
      version: "*"

sharing:
  rules:
    enforced: [code-review-guide]
  recall:
    enabled: false
  docs:
    localDir: ./.teamai/docs   # 默认 ~/.teamai/docs
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false
  autoCompact:
    tokens: 400000
  gitExclude:
    enabled: true              # init 为新团队写入 true
  contributeHint:
    enabled: true
  intervention:
    correctionKeywords: []
  webhooks:
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # session-start、session-stop、skill-use、push、pull，或 *
        secret: my-signing-key
        timeout: 5000
        retries: 3

```

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto             # auto / prompt / skip
scope: workspace               # workspace（init 默认）或 user；project 按 workspace 读取
projectRoot: /path/to/my-workspace
inheritUserScope: true
coAuthorEnabled: true
autoCompactTokens: 0           # 0 表示不参与团队的 autoCompact
gitExcludeEnabled: true
contributeHintEnabled: false
usageReportEnabled: false
codexTrustEnabled: false
scoring:
  isolation: verified          # 本作用域的评审必须是 verified；团队、评分器与此处取最严格的一项
toolRoots:
  claude: ~/.claude-work
  codex: ~/.codex-alt
ai:
  tool: codex                  # teamai 自身 AI 调用使用的工具；见下文 AI 工具
```

角色、项目和 tag 字段保存的是这个目录自己的选择。workspace 还会交付其中已初始化仓库的选择，这些选择在每次 pull 时读取，不会写入这里。参见[包含仓库的 workspace](./distribution.md#包含仓库的-workspace)。

#### 成员设置

成员设置依次读取环境覆盖、当前安装、本机、团队和默认值，`teamai doctor` 展示来源。`ai.tool` 选择知识生成使用的工具；继续支持召回、贡献提示、使用统计、会话发布、Co-author 和更新设置。`modelAliases` 仅用于使用成本核算，不配置 Agent 模型。Workflow 和评分设置不再生效，保存时保留各安装自己的设置。

#### AI 工具（`ai.tool`）

teamai 自身的 AI 调用（enrich、codebase、import、promote、投票评审）使用 teamai 能启动的第一个已安装工具：先是 Claude Code 及其内部版本，然后是 Codex 及其内部版本，再是[工具支持](./tool-support.md)中标记为支持 AI 调用的其他工具。要换用其他工具，指定一个工具 id，例如 `codex`。以下设置中第一个有值的生效：

1. `TEAMAI_AI_TOOL`，作用于单个 shell。
2. 命令所在的 workspace 或 self 安装的配置 `~/.teamai/projects/<slug>/config.yaml` 中的 `ai.tool`。
3. `~/.teamai/config.yaml` 中的 `ai.tool`，作用于本机。不在任何安装中运行的命令只读取这一项。

本机没有 user scope 安装时，`~/.teamai/config.yaml` 可以只包含这一项设置：

```yaml
# ~/.teamai/config.yaml
ai:
  tool: codex
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml，与 init 写入的字段放在一起
ai:
  tool: opencode
```

指定的名称不是 teamai 能启动的工具，或工具不在 PATH 上时，调用会失败，并说明该修改哪个文件中的哪个设置。当前目录的 workspace 配置无法读取时，调用同样会失败。重新 init 会保留 `ai`。

#### 迁移后的工具根目录（`toolRoots`）

Claude Code 用 `CLAUDE_CONFIG_DIR`、Codex 用 `CODEX_HOME`、Cursor CLI 用 `CURSOR_DATA_DIR` / `CURSOR_CONFIG_DIR` 时，`init` 会记下那些目录。认的键是 `claude`、`codex`、`cursor-data`、`cursor-config`。

```bash
CLAUDE_CONFIG_DIR=~/.claude-work teamai init
CLAUDE_CONFIG_DIR= teamai init    # 清掉记录
CODEX_HOME= teamai init
CURSOR_DATA_DIR=~/.cursor-data teamai init
CURSOR_CONFIG_DIR=~/.cursor-config teamai init
```

目录要在 home 下，或在 `~/.config/` 下面。Copilot 用自己的 `COPILOT_HOME`。

Cursor CLI 会搬两个目录：`CURSOR_DATA_DIR` 放会话记录，`CURSOR_CONFIG_DIR` 放写协同署名设置的 `cli-config.json`。用户级 `mcp.json`、`rules/`、`commands/` 不管这两个变量怎么设都留在 `~/.cursor`，所以它们仍然用默认路径。没设 `CURSOR_CONFIG_DIR` 时，配置根目录取 `$XDG_CONFIG_HOME/cursor`（设了该变量的话），否则取 `~/.cursor`。

#### 记录的工具主目录（`~/.teamai/tool-homes.json`）

有些工具会按变量搬家：`XDG_CONFIG_HOME`（OpenCode、Muse）、`OPENCODE_CONFIG_DIR`、`HERMES_HOME`、`HERMES_DATA_DIR_SUFFIX`、`PI_CODING_AGENT_DIR`（Pi）、`OMP_PROFILE`、`PI_PROFILE` 和 `PI_CONFIG_DIR`（Oh My Pi）、`CODEBUDDY_CONFIG_DIR`、`COPILOT_HOME`、`DSH_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME` 和 `OPENCLAW_PROFILE`。Hermes 还会搬到它的 `active_profile` 文件指定的 profile。teamai 每次运行都在已记录或搬过去的 Hermes 主目录里读这个文件，从不记录 profile，所以 `hermes profile use` 在下一次 pull 就生效。Oh My Pi 也会读 `PI_CODING_AGENT_DIR`，但 teamai 不把 Oh My Pi 的文件写到那里，因为那是 Pi 的目录。`pull` 和 `teamai hooks remove` 只改当前的 Hermes 或 Oh My Pi profile，因为各个 profile 并行使用。`teamai uninstall` 会从默认主目录、已记录或搬过去的主目录，以及它们下面的每个 profile 里，删除 teamai 的 Hermes hook 脚本、指令插件、它们在 `config.yaml` 里的条目和授权、SOUL.md 块，以及 teamai 的 Oh My Pi 扩展。在 Windows 上，Hermes 在 `%LOCALAPPDATA%\hermes`。工具自己的变量是相对路径时，和工具一样按运行 teamai 的目录解析；`XDG_CONFIG_HOME` 或 `%LOCALAPPDATA%` 是相对路径时会被忽略。teamai 会同步到搬过去的主目录。`teamai skill list`、`teamai skill show` 和 `teamai list skills --source local` 读取那里的技能，`teamai doctor` 也在那里检查工具是否已安装。设了 `XDG_CONFIG_HOME=/x` 时，OpenCode 的技能、agents、位于 `/x/opencode/rules` 的规则、位于 `/x/opencode/teamai-context.md` 的指令块、hook 插件，以及 MCP 写入的 `opencode.json` 都放到 `/x/opencode`。Muse 的技能、agents、MCP 配置和 hooks 放到 `/x/muse`，它的用户规则和指令块是 `/x/muse/AGENTS.md`。设了 `PI_CODING_AGENT_DIR=/x` 时，Pi 的技能、MCP 配置 和扩展放到 `/x`，它的用户规则和指令块是 `/x/AGENTS.md`。设了 `CODEBUDDY_CONFIG_DIR=/x` 时，CodeBuddy 的技能、规则、agents、hooks、`CODEBUDDY.md` 和 MCP 文件（包括 `.codebuddy.json`）放到 `/x`。以前的版本把这四个工具的 hooks 写在默认主目录下。`pull`、`teamai hooks remove` 和 `teamai uninstall` 会删除这份副本：OpenCode 1.x 也会加载那里的插件，而留在那里的团队 hook 之后无法再识别并删除。[工具支持](tool-support.md)列出每个工具的主目录、移动它的变量，以及 teamai 把每类资源写到哪里。

第一次看到该变量的 `pull` 会在该目录存在时把主目录记到 `~/.teamai/tool-homes.json`，整台机器共用这一份记录；pull 不会替换已有的记录。`teamai init` 也会记录，并且会替换已有的记录：工具自己的变量（`HERMES_HOME`、`OPENCLAW_PROFILE` 等）在目录还不存在时也记，`XDG_CONFIG_HOME` 要等目录存在才记。Hermes 在 Windows 上的默认目录只会补上缺的记录。所以请在你的工具运行的 shell 里运行 `init`。之后即使在没设该变量的 shell 里 pull，各个 scope 也仍然同步到那里。要换主目录，带着新值运行 `teamai init`。要清掉记录，把变量设为空再运行一次。记录的目录不存在时，`teamai doctor` 会报 `<tool> home exists`；shell 里的变量指向别的目录时，会报 `<tool> home matches <variable>`。

工具的技能目录、agents 目录、规则目录或指令块文件变了之后，teamai 在旧位置放的副本会留下。别的 shell、别的项目或别的工具可能还在读那个位置，teamai 无法判断。`places` 会记下 agents 目录、规则目录和指令块文件。第一次把它们送到新位置的 pull 会点名旧位置，之后 teamai 不再更新那里的副本。确认没有工具再读那个位置后，自己删掉即可。

### Webhook 通知（`sharing.webhooks`）

| 事件 | 何时发送 |
| --- | --- |
| `session-start` | 会话开始 |
| `session-stop` | 会话结束 |
| `skill-use` | 调用了某个 skill |
| `push` | `teamai push` 真正推上去 |
| `pull` | `teamai pull` 真正同步完 |
| `*` | 以上全部 |

不发工具入参和输出。设了 `secret` 就带 `X-TeamAI-Signature`。

```bash
teamai webhook list
teamai webhook test
teamai webhook test --dry-run
```

---

## ZCode hook stdout 容量

Doctor 会按 UTF-8 字节计算项目规则回复序列化后的大小，并与 `~/.zcode/cli/config.json` 中的 `hooks.maxOutputBytes`（默认 32768）比较。这只是大小下界：其他会话提示还会增加完整回复的字节数。即使 hook 已注册，ZCode 仍会截断超限的标准输出，并静默丢弃截断后无法解析的回复。请缩短规则，或将该正整数上限增大到足以容纳完整回复，再启动新的 ZCode 会话。TeamAI 不会自行修改上限或截断规则。

## Kiro 生命周期 hooks

Kiro CLI V3 会为所有 agent（包括默认 agent）加载 `~/.kiro/hooks/teamai.json`。pull 和 hook 注入会安装其中的 SessionStart hook，无需先同步团队 agent。`hooks list` 和 `doctor` 检查它；移除 hooks 或用户级卸载会删除它，项目级卸载保留这份共享用户 hook。同名个人文件会被保留并提示。启用独立 hook 前，pull 和 hook 注入会从现有 Kiro agent（包括成员编辑过的副本）中仅移除 TeamAI 旧的 `agentSpawn` 命令，保留个人 hooks 和 agent 字段。生命周期集成需要 V3，Kiro 2.x 不加载这份独立 hook。团队有给 Kiro 的 hook 时，pull 还会写 `~/.kiro/hooks/teamai-team.json`，每个事件一条，经 teamai 运行这些 hook；移除 hooks 和卸载时也会删除它。
