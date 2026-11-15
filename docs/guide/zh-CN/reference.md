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
# language: en                # 可选。en 只用英文。省略或 zh 保持中英双语的 recall 规则、TodoWrite 提示和已合入 MR 提示。zh 时，摩擦提醒用中文
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

workflows:
  retention: 14d              # doctor --fix 保留已结算运行所留内容的时长：14d 这样的时长，或 never
  driver: local                # teamai score、benchmark run 等启动工作流的命令、score --drain 和会话启动所启动的运行使用的驱动：local、none 或驱动名

```

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto             # auto / prompt / skip
updateOtherInstallations: true # 同时更新其他已登记的 npm-global 副本；默认 false
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

成员设置按以下顺序读取，第一个设置了它的层级生效：

1. 环境变量或命令行参数，如果该设置有的话（`TEAMAI_AI_TOOL`、`TEAMAI_RECALL_DISABLED`、`--tools` 等）。
2. 命令所在 scope 的配置：workspace 或 self 安装是 `~/.teamai/projects/<slug>/config.yaml`，user scope 是 `~/.teamai/config.yaml`。
3. `~/.teamai/config.yaml`，即本机。它不需要 `repo` 或 `username`，没有 user scope 安装时也有效。
4. 团队的 `teamai.yaml`，如果该设置有对应的团队键。
5. 默认值。

成员设置包括 `ai.tool`、`workflows.*`、`recallEnabled`、`contributeHintEnabled`、`mrHintEnabled`、`coAuthorEnabled`、`usageReportEnabled`、`codexTrustEnabled`、`modelAliases`、`sessions`、`scoring`、`autoCompactTokens`、`updatePolicy` 和 `updateOtherInstallations`。`workflows.tools`、`workflows.allow` 和 `modelAliases` 中的每一项单独计算。`~/.teamai/config.yaml` 中的 `scoring` 只会让会话评判比团队的设置更严格（[已结束的会话](./scorers.md#已结束的会话)）。`updatePolicy`、`updateOtherInstallations` 和 `autoCompactTokens` 作用于整台机器，因此由一个 scope 决定：有 user scope 时由它决定，否则由运行的 scope 决定。其他键都属于某一个安装，不会从本机读取。`~/.teamai/config.yaml` 不是安装时，`doctor` 会列出其中这类键。

| 你想要 | 写入 | 位置 |
|---|---|---|
| 某一条命令用 Codex | `TEAMAI_AI_TOOL=codex teamai import --dir .` | shell |
| 所有 workspace 里 teamai 自己的 AI 调用都用 Codex | `ai: { tool: codex }` | `~/.teamai/config.yaml` |
| 但某一个 workspace 仍用 Claude | `ai: { tool: claude }` | 该 workspace 的 `~/.teamai/projects/<slug>/config.yaml` |
| 整个团队开启 recall | `sharing: { recall: { enabled: true } }` | 团队的 `teamai.yaml` |
| 在任何 workspace 都不评判你手动运行的会话 | `scoring: { sessions: { attended: off } }` | `~/.teamai/config.yaml` |
| 本机把工作流运行留下的内容保留一周（[运行留下的分支](./workflow.md#运行留下的分支)） | `workflows: { retention: 7d }` | `~/.teamai/config.yaml` |
| 把 `teamai score`、`teamai benchmark run` 等启动工作流的命令、`teamai score --drain` 和会话启动所启动的运行交给本机不运行的驱动 `acme-sandbox`：每个运行都等待它。`workflow start` 和 `resume` 不读取该设置 | `workflows: { driver: acme-sandbox }` | 团队的 `teamai.yaml` |

`teamai doctor` 会给出它所在 workspace 的配置文件路径。Dashboard 的[成员设置](./dashboard.md#成员设置member-settings)面板会为你选中的 workspace 显示同样的信息。

**本机一个默认值，一个 workspace 不同。** Ana 让 teamai 自己的 AI 调用和工作流步骤都跑在 Codex 上，并开启 recall。某个客户的仓库仍用 Claude，且不开 recall：

```yaml
# ~/.teamai/config.yaml：本机，不需要安装
ai: { tool: codex }
recallEnabled: true
workflows:
  tools: { default: codex }
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml：仅 ~/work/client
ai: { tool: claude }
recallEnabled: false
```

```console
$ cd ~/work/client && teamai doctor
ℹ Member settings:
  ai.tool: claude, from the workspace config /home/ana/.teamai/projects/<slug>/config.yaml (the machine says codex)
  workflows.tools.default: codex, from the machine config /home/ana/.teamai/config.yaml
  recallEnabled: false, from the workspace config /home/ana/.teamai/projects/<slug>/config.yaml (the machine says true, the team false)
$ cd ~/work/api && teamai import --dir .   # 跑在 codex 上，来自本机配置
```

**映射中的一项。** workspace 只设置 `workflows.tools` 的一项时，本机的其他项仍然生效：

```yaml
# ~/.teamai/config.yaml
workflows:
  tools: { default: codex, reviewer: claude }
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml
workflows:
  tools: { implementer: claude }
```

在这个 workspace 中，`implementer` 和 `reviewer` 跑在 Claude 上，其他 agent 跑在 Codex 上。

**一台笔记本比团队要求的共享得更少。** 团队会发布并评判每个会话。在自己的笔记本上，Ana 不把手动运行的会话发布到 `teamai-reports`，不评判这台机器运行的任务中的会话，并且每个 workspace 每天最多评判两个会话：

```yaml
# ~/.teamai/config.yaml
sessions:
  publish: { attended: off }
scoring:
  sessions: { unattended: off }
  daily_limit: 2
```

```console
$ cd ~/work/api && teamai doctor
ℹ Member settings:
  sessions.publish.attended: off, from the machine config /home/ana/.teamai/config.yaml (the team says auto)
ℹ Session judging: attended auto, set by scorers/scoring.yaml sessions; unattended off, set by ~/.teamai/config.yaml scoring.sessions.unattended; up to 2 sessions a day, set by ~/.teamai/config.yaml scoring.daily_limit.
```

本机的 `scoring` 不会开启评判，也不会提高上限：团队设为 `off` 时，本机的 `auto` 不起作用。workspace 自己的 `scoring` 仍然优先，按模式逐个生效。

`~/.teamai/config.yaml` 中类型错误的值会被跳过并给出警告，由下一层级决定。`workflows.allow` 例外：其中的错误值，或无法读取或解析的文件，会让工作流命令停止运行，直到你修正它。保存配置时不会把本机的值复制进 workspace 的文件；`recall enable` 和 `recall disable` 会写入它们自己的值。

#### AI 工具（`ai.tool`）

teamai 自身的 AI 调用（enrich、codebase、import、promote）使用 teamai 能启动的第一个已安装工具：先是 Claude Code 及其内部版本，然后是 Codex 及其内部版本，再是[工具支持](./tool-support.md)中标记为支持 AI 调用的其他工具。要换用其他工具，指定一个工具 id，例如 `codex`。以下设置中第一个有值的生效：

1. `TEAMAI_AI_TOOL`，作用于单个 shell。
2. 命令所在的 workspace 或 self 安装的配置 `~/.teamai/projects/<slug>/config.yaml` 中的 `ai.tool`。
3. `~/.teamai/config.yaml` 中的 `ai.tool`，作用于本机。不在任何安装中运行的命令只读取这一项。

`teamai init --agent <tool>` 会把安装配置中的 `ai.tool` 设为它列出的第一个 teamai 能启动的工具，除非该配置或 `~/.teamai/config.yaml` 已经指定了工具。

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

指定的名称不是 teamai 能启动的工具，或工具不在 PATH 上时，调用会失败，并说明该修改哪个文件中的哪个设置。当前目录的 workspace 配置无法读取时，调用同样会失败。重新 init 会保留 `ai`。工作流步骤也会回退到这些设置，见[工作流](./workflow.md)。

#### 迁移后的工具根目录（`toolRoots`）

Claude Code 用 `CLAUDE_CONFIG_DIR`、Codex 用 `CODEX_HOME`、Cursor CLI 用 `CURSOR_DATA_DIR` / `CURSOR_CONFIG_DIR` 时，`init` 会记下那些目录。认的键是 `claude`、`codex`、`cursor-data`、`cursor-config`。

```bash
CLAUDE_CONFIG_DIR=~/.claude-work teamai init
CLAUDE_CONFIG_DIR= teamai init    # 清掉记录
CODEX_HOME= teamai init
CURSOR_DATA_DIR=~/.cursor-data teamai init
CURSOR_CONFIG_DIR=~/.cursor-config teamai init
```

目录在 home 下或 `~/.config/` 下面时，teamai 会同步到那里。home 之外的目录也会记下，但只用于该工具的会话：teamai 从那里读会话，其他文件仍同步到工具的默认根目录，`init` 和 `teamai doctor` 会说明这一点。如果配置里已经记下了该工具在 home 下的根目录，`init` 会保留它，并说明怎样切换。Copilot 用自己的 `COPILOT_HOME`。工作流步骤启动 Claude Code 或 Codex 时，即使 shell 没有设这个变量，或把它设为另一个目录，也会把它设为 teamai 同步到的目录。记录的目录不存在时，pull 会跳过该工具，工作流步骤不会启动它，`teamai doctor` 会报 `Claude Code root exists` 或 `Codex root exists`。

Cursor CLI 会搬两个目录：`CURSOR_DATA_DIR` 放会话记录，`CURSOR_CONFIG_DIR` 放写协同署名设置的 `cli-config.json`。用户级 `mcp.json`、`rules/`、`commands/` 不管这两个变量怎么设都留在 `~/.cursor`，所以它们仍然用默认路径。没设 `CURSOR_CONFIG_DIR` 时，配置根目录取 `$XDG_CONFIG_HOME/cursor`（设了该变量的话），否则取 `~/.cursor`。

#### 记录的工具主目录（`~/.teamai/tool-homes.json`）

有些工具会按变量搬家：`XDG_CONFIG_HOME`（OpenCode、Muse）、`OPENCODE_CONFIG_DIR`、`HERMES_HOME`、`HERMES_DATA_DIR_SUFFIX`、`PI_CODING_AGENT_DIR`（Pi）、`OMP_PROFILE`、`PI_PROFILE` 和 `PI_CONFIG_DIR`（Oh My Pi）、`CODEBUDDY_CONFIG_DIR`、`COPILOT_HOME`、`DSH_HOME`、`JOYCODE_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME` 和 `OPENCLAW_PROFILE`。Hermes 还会搬到它的 `active_profile` 文件指定的 profile。teamai 每次运行都在已记录或搬过去的 Hermes 主目录里读这个文件，从不记录 profile，所以 `hermes profile use` 在下一次 pull 就生效。Oh My Pi 也会读 `PI_CODING_AGENT_DIR`，但 teamai 不把 Oh My Pi 的文件写到那里，因为那是 Pi 的目录。`pull` 和 `teamai hooks remove` 只改当前的 Hermes 或 Oh My Pi profile，因为各个 profile 并行使用。`teamai uninstall` 会从默认主目录、已记录或搬过去的主目录，以及它们下面的每个 profile 里，删除 teamai 的 Hermes hook 脚本、指令插件、它们在 `config.yaml` 里的条目和授权、SOUL.md 块，以及 teamai 的 Oh My Pi 扩展。在 Windows 上，Hermes 在 `%LOCALAPPDATA%\hermes`。工具自己的变量是相对路径时，和工具一样按运行 teamai 的目录解析；`XDG_CONFIG_HOME` 或 `%LOCALAPPDATA%` 是相对路径时会被忽略。teamai 会同步到搬过去的主目录。`teamai skill list`、`teamai skill show` 和 `teamai list skills --source local` 读取那里的技能，`teamai doctor` 也在那里检查工具是否已安装。设了 `XDG_CONFIG_HOME=/x` 时，OpenCode 的技能、agents、位于 `/x/opencode/rules` 的规则、位于 `/x/opencode/teamai-context.md` 的指令块、hook 插件，以及 MCP 和 `teamai models switch` 写的 `opencode.json` 都放到 `/x/opencode`。Muse 的技能、agents、MCP 配置、模型设置和 hooks 放到 `/x/muse`，它的用户规则和指令块是 `/x/muse/AGENTS.md`。设了 `PI_CODING_AGENT_DIR=/x` 时，Pi 的技能、MCP 配置、`models.json` 和扩展放到 `/x`，它的用户规则和指令块是 `/x/AGENTS.md`。设了 `CODEBUDDY_CONFIG_DIR=/x` 时，CodeBuddy 的技能、规则、agents、hooks、`CODEBUDDY.md` 和 MCP 文件（包括 `.codebuddy.json`）放到 `/x`。以前的版本把这四个工具的 hooks 写在默认主目录下。`pull`、`teamai hooks remove` 和 `teamai uninstall` 会删除这份副本：OpenCode 1.x 也会加载那里的插件，而留在那里的团队 hook 之后无法再识别并删除。[工具支持](tool-support.md)列出每个工具的主目录、移动它的变量，以及 teamai 把每类资源写到哪里。

第一次看到该变量的 `pull` 会在该目录存在时把主目录记到 `~/.teamai/tool-homes.json`，整台机器共用这一份记录；pull 不会替换已有的记录。`teamai init` 也会记录，并且会替换已有的记录：工具自己的变量（`HERMES_HOME`、`OPENCLAW_PROFILE` 等）在目录还不存在时也记，`XDG_CONFIG_HOME` 要等目录存在才记。Hermes 在 Windows 上的默认目录只会补上缺的记录。所以请在你的工具运行的 shell 里运行 `init`。之后即使在没设该变量的 shell 里 pull，各个 scope 也仍然同步到那里；工作流步骤启动[工具支持](./tool-support.md#在迁移后的主目录启动的工作流步骤)列出的工具时，也会把它的变量设为这个主目录。要换主目录，带着新值运行 `teamai init`。要清掉记录，把变量设为空再运行一次。记录的目录不存在时，`teamai doctor` 会报 `<tool> home exists`；shell 里的变量指向别的目录时，会报 `<tool> home matches <variable>`。

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

### 团队工具（`tools/`）

团队用的是某个已支持工具的内部版本或分支时，可以把它加成内置工具的实例，不用等新版本。实例只改命令、home 和路径，沿用该工具的启动参数，以及会话、token、hook 和 MCP 格式。实例只能扩展 Claude Code（`claude`）或 Codex（`codex`）；扩展其他工具的实例会被拒绝并指出文件，直到 teamai 支持该工具（[工具支持](./tool-support.md#工具实例)）。有自己 home 的实例有自己的会话；沿用该工具 home 的实例写的就是该工具的会话，收到的文件也和该工具放在同一处，包括 `init` 为它记录的目录（`toolRoots`）：它自己的 `paths` 中位于该工具路径所在目录或其默认 home 下的路径，和该工具的路径一样随之移动，其余的保持原处。

```yaml
# 团队仓库中的 tools/acme-claude.yaml
schemaVersion: v1alpha1
name: acme-claude                  # 与文件名相同
extends: claude                    # 它是哪个内置工具的实例
command: acme-claude               # PATH 上可执行文件的名字，不能是路径
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
# paths: { skills: .acme-claude/skills }   # 可选；不写时用 claude 的路径，放到 .acme-claude/ 下；设了 command，项目里也是这样
```

成员像启用其他工具一样启用它：

```bash
teamai init --agent claude,acme-claude
teamai pull                                        # skills、rules、hooks 和 MCP 写到 .acme-claude/
teamai workflow start review --tools default=acme-claude
teamai score --session <id> --source acme-claude --scorer review-quality
```

步骤运行 `acme-claude`，会话从 `$ACME_CLAUDE_CONFIG_DIR/projects/` 读取，未设置时从 `~/.acme-claude/projects/` 读取；用户级 pull 也写到这个目录。实例的 `env` 移动的主目录，teamai 会像记录工具自己的变量那样记录下来（[记录的工具主目录](#记录的工具主目录teamaitool-homesjson)），所以在没有这个变量的 shell 里运行 pull 或 `uninstall` 也会用它，teamai 启动实例的命令时也会把这个变量设为该主目录。`init` 移动或清除这条记录时，会删除 teamai 留在原主目录里的 hooks，并说明留在那里的技能、规则和 MCP 服务器。记录、续跑和打分都算在 `acme-claude` 名下，不会算成 Claude 的。在项目里，Claude Code 和 Codex 在每个 linked worktree 中都从主 checkout 读取团队 hooks，而实例把它们放在自己的主目录里，只对运行过 pull 的 checkout 生效；所以要在 linked worktree 里用实例的团队 hooks，先在那里运行一次 `teamai pull`。

如果 `env` 是 `XDG_CONFIG_HOME` 或 `XDG_DATA_HOME`，teamai 不使用你给它设置的值。这个值属于所有读取它的工具，所以实例的 home 这时是 `~/<dir>`。

**接受命令。** 设了 `command` 的实例会运行队友指定的程序。第一次运行时在终端里询问：

```text
Tool "acme-claude" comes from the team repo (…/tools/acme-claude.yaml, content 3f9a1c0e7b2d), which you have not accepted on this machine. It runs acme-claude as you, with your files, in place of claude. Review the file before you accept it.
Run it? [y/N]
```

你输入的一行只回答这个问题。同一终端上正在等待的审批或选择，会在你回答后重新询问。`teamai workflow cancel` 会让这个问题不经回答直接结束，命令不会运行。按 Ctrl-C 会停止运行而不作回答，`teamai workflow resume` 会再问一次。

无人值守的运行（`TEAMAI_MODE=unattended`、CI、没有终端）会以 `tool_not_accepted` 拒绝，直到有人在终端里接受一次。Codex 实例的 hooks 也要靠它的命令来信任，所以在终端里运行 `teamai pull` 需要这个命令时会问同一个问题；无人值守的 pull，或者回答否，会让这些 hooks 保持未信任，并给出提示。接受结果按文件内容记在 `~/.teamai/trust/tools.json`：不改这个文件的提交不会再问，改了文件会再问。只设 `home` 或 `paths` 的实例运行内置命令，不需要接受。设了 `home` 而没设 `command` 的实例只移动用户主目录：在项目里，它用所扩展工具的路径（`.claude/` 或 `.codex/`），也就是内置命令读取的位置；同时启用了该工具时，两者读同一份副本，对其中任一个运行 `teamai uninstall --agent` 都会把它留给另一个。设了 `command` 的实例在项目里也把这些路径放到自己的主目录下，因为它自己的构建可能读取项目里它自己的目录。`paths` 会替换这两种路径。设了 `home` 时，不论运行的是哪个命令，命令运行时都会把工具的主目录变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`）设为这个主目录（主目录嵌套在别的目录里也一样），所以它读到的就是 teamai 写到那里的内容。实例的用户级 `paths` 如果落在 `home.dir` 之外，不论有没有设 `command`，都会被拒绝，因为在这个主目录启动的工具一个也读不到；工具不论主目录在哪都会读取的路径除外，比如 Codex 读取的 `~/.agents/skills`：把这些 `paths` 指到 `home.dir` 里面，或者去掉 `home`；`env` 写的是实例自己的变量，teamai 也会把它设为同一个主目录，写成该工具的主目录变量时 teamai 会拒绝。实例的主目录如果是另一个工具的（内置工具或另一个实例），不论是 `home.dir` 直接写成那个目录，还是实例的变量或 `toolRoots` 让它解析到那里，teamai 都会拒绝，因为两个工具共用一个主目录会互相覆盖文件；实例的变量指向你的 home 目录本身时也会拒绝。要解除这两种拒绝，把变量指向一个独立的目录，再重新运行 `teamai init`：它的 `--agent` 接受被拒绝的实例，并替换那条记录；pull 不会改动已记录的主目录。实例被接受后，teamai 读取、导出和导入它的会话时也用它的命令；接受之前用内置命令。

**调整内置工具。** 与内置工具同名的实例用来调整它。它的 `paths` 整体替换该工具的路径，和 `toolPaths` 条目一样，并且优先于 `toolPaths`。它只能设 `paths`：设了 `command` 或 `home` 的会被 teamai 拒绝，这两项属于有自己名字的实例，比如 `name: acme-codex` 加 `extends: codex`。只有 Claude Code 和 Codex 能这样调整；其他工具的 `tools/<tool>.yaml` 会被拒绝，改用 `teamai.yaml` 里的 `toolPaths.<tool>` 条目移动它的路径：

```yaml
# tools/claude.yaml
schemaVersion: v1alpha1
name: claude
extends: claude
paths: { skills: .claude/team-skills, rules: .claude/rules }
```

`teamai doctor` 会列出这类 `paths` 丢掉的每个键：``paths in tools/claude.yaml replaces claude's default entry whole and drops keys the default provides: `settings` (.claude/settings.json — hook reconciliation silently skips the tool), …``。

**自己的版本。** `~/.teamai/tools/<name>.yaml` 放你自己的实例。teamai 只读这个目录，从不写入。这里的实例会替换团队同名实例（只对你生效），不需要接受；`workflow resume --next` 会忽略它，因为接手的是队友的运行，用团队的工具。

它的 `command` 同样是 PATH 上的一个命令名。要运行你自己编译的版本，把它所在的目录加到 PATH，再写可执行文件的名字：

```yaml
# ~/.teamai/tools/acme-claude.yaml
schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude-dev           # 在 ~/src/acme-claude/bin 里找到；写成 ~/src/acme-claude/bin/acme-claude-dev 会被拒绝
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
```

```bash
export PATH="$HOME/src/acme-claude/bin:$PATH"     # 写在 ~/.zshrc 或 ~/.bashrc 里
teamai workflow start review --tools default=acme-claude
```

**实例从哪里来。** `tools/<name>.yaml`，或存放 `TOOL.yaml`（内容相同）的文件夹 `tools/<name>/`，把文件移进去不影响已有的接受；以及你的角色或项目为 workflows 激活的每个 namespace 下的 `tools/<namespace>/<name>.yaml`（替换根目录的同名实例）。两个激活的 namespace 定义同一个名字，或同一 scope 的两个团队仓库对同一个名字定义不同，算冲突：两个都不用，并给出提示。workspace 的实例会替换 user scope 的同名实例，和驱动定义一样。文件里出现 `command`、`home`、`paths` 以外的键，或 `command` 是 `./scripts/acme-claude` 这样的路径、含有 `:`、`*` 或 `?`，都会被拒绝，并指出问题：路径上的程序可以在文件不变的情况下被改掉，接受就管不到它。teamai 只在 PATH 的目录里查找 `command`，Windows 上也一样，不在检出目录里查找，所以除非成员的 PATH 含有 `.` 或空条目，检出目录里的同名文件不会代替它运行。

```text
Tool instance …/tools/acme-claude.yaml is not valid: it sets sessions, and an instance sets only command, home and paths. …
Tool instance …/tools/acme-claude.yaml is not valid: command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude. …
Tool instance …/tools/acme-kiro.yaml is not valid: extends: an instance extends claude or codex; teamai does not support an instance of kiro or any other tool yet. …
```

实例会收到 teamai 自带的 agents（如 `teamai-recall`）和团队的 `agents/`，格式与它扩展的工具相同，并使用该工具的模型别名和 `tool_extras`；`teamai push` 会带上对实例副本的修改。在项目里，agent 目录就是该工具目录的实例（没设 `command`，或 `paths` 指向该目录）读取该工具的 agent 文件，这些文件按该工具来渲染，该工具用 `teamai models switch` 切换后也一样。`targets` 写了该工具的 agent 也会发给它的实例；只想发给某个实例时，写实例的名字。[工具支持](./tool-support.md)页面只列出实例可以扩展的工具，不列出实例本身。

---

## 模型配置

`teamai models switch` 才会改 Agent。之后 `pull` 让已切换的 Agent 跟上团队目录。

`team:<id>` 来自 `models/models.yaml`，以及当前 namespace 的 `models/<ns>/models.yaml`，不含密钥。`local:<id>` 在 `~/.teamai/models/models.yaml`。同名时要写前缀。

### 团队目录

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

`api_key` 必须是 `${API_KEY}`。`base_url` 不要以 `/v1` 结尾。第一个模型是默认。

| Agent | 协议 | `switch` 写入 |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json` |
| Codex | `openai-responses` | `~/.codex/config.toml` |
| OpenCode | 除 `gemini` 外任意 | `opencode.json` |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json` (CodeBuddy 跟随记录的主目录) |
| Pi | 除 `gemini` 外任意 | `~/.pi/agent/models.json` |
| OMP | 除 `gemini` 外任意 | `~/.omp/agent/models.yml`，或 `OMP_PROFILE`（或 `PI_PROFILE`）和 `PI_CONFIG_DIR` 指定的 agent 目录 |
| Muse Code | `openai-responses` | `<Muse 主目录>/settings.json`（已记录目录，否则使用 `$XDG_CONFIG_HOME/muse` 或 `~/.config/muse`），密钥以 `META_API_KEY` 写入 `~/.teamai/models/env.sh`，由 shell 配置文件加载 |
| Antigravity CLI | `gemini` | 在 `~/.gemini/antigravity-cli/settings.json` 写 `modelProvider: "gemini"`，并在 `~/.teamai/models/agy-env.sh` 里定义一个 `agy` shell 函数（由 shell 配置文件加载），只为 agy 设置 `GEMINI_API_KEY` 和 `GOOGLE_GEMINI_BASE_URL` |

上面的例子没有 `openai-responses`，所以不会改 Codex 和 Muse Code；也没有 `gemini`，所以也不会改 Antigravity CLI。

提供 Gemini API 的网关可以接到 Antigravity CLI：

```yaml
profiles:
  - id: gemini-gw
    name: Team Gemini gateway
    base_url: https://llm-gw.example.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [gemini]
        models:
          - gemini-3.8-flash
```

执行 `teamai models switch gemini-gw --agent agy` 后，agy 会带着密钥发送 `POST https://llm-gw.example.com/v1beta/models/gemini-3.8-flash:streamGenerateContent`。模型仍是在 agy 里选的那个（`/model`）：agy 发送的是它自己目录里的 Gemini 模型 id，所以网关需要提供这些模型。

Gemini CLI 也读这两个变量，所以 teamai 从不 export 它们，而是定义一个只为 agy 设置它们的函数；你自己 export 的密钥也不会替换它：

```bash
# ~/.teamai/models/agy-env.sh
unalias agy 2>/dev/null || true
agy() { GEMINI_API_KEY="${API_KEY}" GOOGLE_GEMINI_BASE_URL='https://llm-gw.example.com' command agy "$@"; }
```

```bash
export GEMINI_API_KEY=my-own-key   # 写在 ~/.zshrc 里，给 Gemini CLI 用
agy                                # 仍然用团队密钥和网关
gemini                             # 仍然用 my-own-key 和 Google
```

teamai 自己运行的 agy（AI 调用、本地工作流步骤、评分 judge）从这个文件读取密钥和网关。

脚本不会继承 shell 函数，所以 `bash deploy.sh` 里调用的 `agy` 不走网关。先在脚本里 source 这个文件：`. ~/.teamai/models/agy-env.sh`。

### 使用团队配置

```bash
teamai models list
teamai models switch tokenhub
teamai models switch --agent claude --model deepseek-v4-flash
teamai models switch --dry-run
```

不带名字会列出全部配置再问你。密钥放环境变量，不要写进命令参数：

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

### 团队配置按 namespace 划分

`models/<ns>/models.yaml` 会整份替换根目录里同 `id` 的配置。声明方式和 env 一样，见 [Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)。

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

换了网关地址要重新 `teamai models switch team:<id>`。两个 namespace 抢同一个 id 时，这次不更新模型。

### 个人配置

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

个人 id 不能和团队配置重名。

### 恢复

```bash
teamai models restore
teamai models restore --agent codex
teamai models remove local:my-gateway
```

只还原 TeamAI 改过的字段。你自己改过的 Agent，之后的 switch 和 restore 会跳过。

## ZCode hook stdout 容量

Doctor 会按 UTF-8 字节计算项目规则回复序列化后的大小，并与 `~/.zcode/cli/config.json` 中的 `hooks.maxOutputBytes`（默认 32768）比较。这只是大小下界：其他会话提示还会增加完整回复的字节数。即使 hook 已注册，ZCode 仍会截断超限的标准输出，并静默丢弃截断后无法解析的回复。请缩短规则，或将该正整数上限增大到足以容纳完整回复，再启动新的 ZCode 会话。TeamAI 不会自行修改上限或截断规则。

## Kiro 生命周期 hooks

Kiro CLI V3 会为所有 agent（包括默认 agent）加载 `~/.kiro/hooks/teamai.json`。pull 和 hook 注入会安装其中的 SessionStart hook，无需先同步团队 agent。`hooks list` 和 `doctor` 检查它；移除 hooks 或用户级卸载会删除它，项目级卸载保留这份共享用户 hook。同名个人文件会被保留并提示。启用独立 hook 前，pull 和 hook 注入会从现有 Kiro agent（包括成员编辑过的副本）中仅移除 TeamAI 旧的 `agentSpawn` 命令，保留个人 hooks 和 agent 字段。生命周期集成需要 V3，Kiro 2.x 不加载这份独立 hook。团队有给 Kiro 的 hook 时，pull 还会写 `~/.kiro/hooks/teamai-team.json`，每个事件一条，经 teamai 运行这些 hook；移除 hooks 和卸载时也会删除它。
