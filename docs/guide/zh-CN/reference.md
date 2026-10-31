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

成员设置按以下顺序读取，第一个设置了它的层级生效：

1. 环境变量或命令行参数，如果该设置有的话（`TEAMAI_AI_TOOL`、`TEAMAI_RECALL_DISABLED`、`--tools` 等）。
2. 命令所在 scope 的配置：workspace 或 self 安装是 `~/.teamai/projects/<slug>/config.yaml`，user scope 是 `~/.teamai/config.yaml`。
3. `~/.teamai/config.yaml`，即本机。它不需要 `repo` 或 `username`，没有 user scope 安装时也有效。
4. 团队的 `teamai.yaml`，如果该设置有对应的团队键。
5. 默认值。

成员设置包括 `ai.tool`、`workflows.*`、`recallEnabled`、`contributeHintEnabled`、`mrHintEnabled`、`coAuthorEnabled`、`usageReportEnabled`、`codexTrustEnabled`、`modelAliases`、`sessions`、`scoring`、`autoCompactTokens` 和 `updatePolicy`。`workflows.tools`、`workflows.allow` 和 `modelAliases` 中的每一项单独计算。`~/.teamai/config.yaml` 中的 `scoring` 只会让会话评判比团队的设置更严格（[已结束的会话](./scorers.md#已结束的会话)）。`updatePolicy` 和 `autoCompactTokens` 作用于整台机器，因此由一个 scope 决定：有 user scope 时由它决定，否则由运行的 scope 决定。其他键都属于某一个安装，不会从本机读取。`~/.teamai/config.yaml` 不是安装时，`doctor` 会列出其中这类键。

| 你想要 | 写入 | 位置 |
|---|---|---|
| 某一条命令用 Codex | `TEAMAI_AI_TOOL=codex teamai import --dir .` | shell |
| 所有 workspace 里 teamai 自己的 AI 调用都用 Codex | `ai: { tool: codex }` | `~/.teamai/config.yaml` |
| 但某一个 workspace 仍用 Claude | `ai: { tool: claude }` | 该 workspace 的 `~/.teamai/projects/<slug>/config.yaml` |
| 整个团队开启 recall | `sharing: { recall: { enabled: true } }` | 团队的 `teamai.yaml` |
| 在任何 workspace 都不评判你手动运行的会话 | `scoring: { sessions: { attended: off } }` | `~/.teamai/config.yaml` |

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

目录要在 home 下，或在 `~/.config/` 下面。Copilot 用自己的 `COPILOT_HOME`。

Cursor CLI 会搬两个目录：`CURSOR_DATA_DIR` 放会话记录，`CURSOR_CONFIG_DIR` 放写协同署名设置的 `cli-config.json`。用户级 `mcp.json`、`rules/`、`commands/` 不管这两个变量怎么设都留在 `~/.cursor`，所以它们仍然用默认路径。没设 `CURSOR_CONFIG_DIR` 时，配置根目录取 `$XDG_CONFIG_HOME/cursor`（设了该变量的话），否则取 `~/.cursor`。

#### 记录的工具主目录（`~/.teamai/tool-homes.json`）

有些工具会按变量搬家：`XDG_CONFIG_HOME`（OpenCode、Muse）、`OPENCODE_CONFIG_DIR`、`HERMES_HOME`、`HERMES_DATA_DIR_SUFFIX`、`PI_CODING_AGENT_DIR`（Pi）、`OMP_PROFILE`、`PI_PROFILE` 和 `PI_CONFIG_DIR`（Oh My Pi）、`CODEBUDDY_CONFIG_DIR`、`COPILOT_HOME`、`DSH_HOME`、`JOYCODE_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_HOME` 和 `OPENCLAW_PROFILE`。Hermes 还会搬到它的 `active_profile` 文件指定的 profile。teamai 每次运行都在已记录或搬过去的 Hermes 主目录里读这个文件，从不记录 profile，所以 `hermes profile use` 在下一次 pull 就生效。Oh My Pi 也会读 `PI_CODING_AGENT_DIR`，但 teamai 不把 Oh My Pi 的文件写到那里，因为那是 Pi 的目录。`pull` 和 `teamai hooks remove` 只改当前的 Hermes 或 Oh My Pi profile，因为各个 profile 并行使用。`teamai uninstall` 会从默认主目录、已记录或搬过去的主目录，以及它们下面的每个 profile 里，删除 teamai 的 Hermes hook 脚本、指令插件、它们在 `config.yaml` 里的条目和授权、SOUL.md 块，以及 teamai 的 Oh My Pi 扩展。在 Windows 上，Hermes 在 `%LOCALAPPDATA%\hermes`。工具自己的变量是相对路径时，和工具一样按运行 teamai 的目录解析；`XDG_CONFIG_HOME` 或 `%LOCALAPPDATA%` 是相对路径时会被忽略。teamai 会同步到搬过去的主目录。`teamai skill list`、`teamai skill show` 和 `teamai list skills --source local` 读取那里的技能，`teamai doctor` 也在那里检查工具是否已安装。设了 `XDG_CONFIG_HOME=/x` 时，OpenCode 的技能、agents、位于 `/x/opencode/rules` 的规则、位于 `/x/opencode/teamai-context.md` 的指令块、hook 插件，以及 MCP 和 `teamai models switch` 写的 `opencode.json` 都放到 `/x/opencode`。Muse 的技能、agents、MCP 配置、模型设置和 hooks 放到 `/x/muse`，它的用户规则和指令块是 `/x/muse/AGENTS.md`。设了 `PI_CODING_AGENT_DIR=/x` 时，Pi 的技能、MCP 配置、`models.json` 和扩展放到 `/x`，它的用户规则和指令块是 `/x/AGENTS.md`。设了 `CODEBUDDY_CONFIG_DIR=/x` 时，CodeBuddy 的技能、规则、agents、hooks、`CODEBUDDY.md` 和 MCP 文件（包括 `.codebuddy.json`）放到 `/x`。以前的版本把这四个工具的 hooks 写在默认主目录下。`pull`、`teamai hooks remove` 和 `teamai uninstall` 会删除这份副本：OpenCode 1.x 也会加载那里的插件，而留在那里的团队 hook 之后无法再识别并删除。[工具支持](tool-support.md)列出每个工具的主目录、移动它的变量，以及 teamai 把每类资源写到哪里。

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
