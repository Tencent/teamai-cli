# 基础 Harness

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: 帮助团队部署服务
---
# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

没有 frontmatter 时，`push` 会补上 `name` 和 `description`。新 skill 写到你的角色或当前项目给出的 `skills/<ns>/<name>/`。有多个时会问，并提供明确的共享根目录选项。`--role` 指定命名空间；`--shared` 把新资源放到整个团队共享的根目录，即使已有命名空间。它不能与 `--role` 或 `--project` 同用。已从命名空间交付的资源，编辑后仍回到原位置。选择命名空间且团队有 `manifest/roles.yaml` 或 `manifest/projects.yaml` 时，该空间必须由其中某个角色或项目声明。

角色或项目过滤 skill 时，共享根目录的 skill 仍按原有 tags 订阅规则交付。`--shared` 选择的是发布位置。

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# 代码审查规范
- 所有函数必须有 JSDoc 注释
- 禁止使用 `any` 类型
EOF

teamai push
```

成员不能删的 rule，写在 `teamai.yaml`：

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

你自己的 rule 会留下。`push` 只把已有团队 rule 的正文写回仓库。

## Agents

`agents/<name>.yaml`。`name` 与文件名一致。自己 commit，或在工具里改完后 `teamai push`。

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

`targets` 不写就发给所有已安装的工具。只给一个角色时放到 `agents/<namespace>/`，并在 `resources.agents` 里声明。

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

`pull` 按工具自己的格式写入它的 agents 目录：Codex 系列是 `<name>.toml`，Copilot 是 `<name>.agent.md`，Kiro 是 `<name>.json`，其余是 `<name>.md`。Trae 和 Trae CN 只在 Beta 设置“启用 Subagents 目录”打开时加载 `.trae/agents`，且只接受自己的模型 id，所以它们的副本不写 agent 的 `model`。Trae CN 在 `~/.trae-cn/agents` 的用户副本会写别名或 `tool_extras.trae-cn` 给出的模型。项目的 `.trae/agents` 两个版本都会读，所以从不写 `model`，其他键则同时取自 `tool_extras.trae` 和 `tool_extras.trae-cn`；两个版本给同一个键不同的值时，该 agent 在那里会被跳过，并给出点名该键的警告。`push` 会拒绝在该文件里修改或删除另一个版本给出的键。

单仓库模式下，已放入命名空间的 agent 的根目录副本会推送到放置后的文件。把它从 `.md` 转为 `.yaml` 会移除原文件，即使当前检出落后于自己已合并的 PR 也是如此。两种情况下，TeamAI 都会把放置后的文件与你上次合并的推送写入的 blob 对比。团队之后又编辑过该文件时，推送会停止并给出 `teamai push --carried <path>@<blob>` 命令。把这次修改带入根目录副本，再运行该命令。该选项只接受这一版本，直接重试或团队之后再次编辑都会再次停止推送。团队已删除的 agent 不会从根目录副本重新添加。没有 blob 的旧放置记录，只有在检出落后于团队修改时才能发现这次修改；你通过它推送的第一次编辑合并后，该记录会补上这次的 blob。

### 模型别名

`model: strong` 这类名字在 `models/aliases.yaml` 里按工具对应到具体模型：

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

别名以小写字母开头，后面可以是小写字母、数字或 `-`。某个 namespace 要换一套时，写 `models/<ns>/aliases.yaml`。

## Env、hooks 与 MCP server 按 namespace 划分

根目录的文件给所有人。`resources:` 里声明的 namespace 只给激活了它的成员，并替换根目录里的同名条目。

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml
```

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env: [checkout]
      hooks: [checkout]
      mcp: [checkout]
```

## Env（环境变量）

```bash
teamai env add API_ENDPOINT https://api.example.com --description "团队 API 地址"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: 团队 API 地址
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

密钥的值不进仓库。每人在自己机器上：

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### 按目录加载 Shell 环境变量

shell 获得其启动目录的团队环境变量，因此同时打开的多个项目各自拿到自己的。`teamai pull` 会在 shell 配置文件中加入一个区块（zsh 为 `.zshenv`，bash 为 bash 启动文件）。交互式 shell 在 `cd` 时切换环境变量，离开项目时恢复你自己的值。

- 在项目中：加载该项目的环境变量。设置 `inheritUserScope: true` 时也加载用户级 scope 的变量，但项目声明的键以项目为准，用户级 scope 的密钥始终不会加载。
- 在包含已初始化仓库的 workspace 中：加载它自己的环境变量加上这些仓库的。两者取值不同的键会被暂缓（held）：之前安装的值保持不变，`pull` 会指出它。
- 尚未被 pull 登记的项目：什么都不加载，直到你在那里 pull。
- 其他位置：加载用户级 scope 的环境变量。
- git 无法读取仓库时（未安装 git、`.git` 损坏、`safe.directory`）：什么都不加载。

`injectShellProfile: false` 会为该团队的 scope 关闭此功能。

限制：

- 只有 bash 和 zsh 按目录加载环境变量。在 fish、PowerShell 或不启动这两种 shell 的工具中，请通过 `teamai env exec --` 运行命令。
- 团队环境变量不能设置控制 shell 或 loader 的名称，例如 `BASH_ENV`、`HOME`、`IFS`、`PROMPT_COMMAND`，或以 `__TEAMAI_` 开头的名称。pull 会警告并忽略它们。
- `teamai doctor` 会检查在此目录启动的 shell 是否加载了本 scope 的环境变量。

## Hooks

`teamai init` 会装上这些内置 hook：

| 事件 | 做什么 |
|------|--------|
| `SessionStart` | 拉取团队资源，并记下会话开始 |
| `PostToolUse` | 记录 skill 使用 |
| `UserPromptSubmit` | 记录输入 |
| `Stop` | 检查 CLI 更新，并记下会话结束 |

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

只处理已经安装的工具。

团队自己的 hook 写在 `hooks/hooks.yaml`，自己 commit。`id` 只用小写字母、数字和 `-`。`builtin` 只放在根文件里，用来关掉某条内置 hook，或改它的超时。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]
```

只给一个项目时写到 `hooks/<ns>/hooks.yaml`。

```yaml
sharing:
  hooks:
    autoApply: false          # pull 只提示，要自己跑 teamai hooks inject
    requireTeamScripts: true  # command 必须在 ~/.teamai/team-scripts/ 下
```

本机全部停用团队 hook：`TEAMAI_HOOKS_DISABLED=1`。

## MCP Server

Muse 保存 stdio server 时可能省略 `type`。pull 和移除操作会兼容这种格式；其他 server 发生变化时，个人 server 和未变更的受管条目保持原样。

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000
  - name: local-formatter
    transport: stdio
    command: npx
    args: ["-y", "@acme/formatter-mcp"]
    env:
      FORMATTER_MODE: strict
    requires: [npx]
    tools: [claude, cursor]
```

密钥写 `${VAR}`，并在 `env/secrets.yaml` 里声明。只给一个项目时，写到 `mcp/<ns>/mcp.yaml`。

ZCode 的 server 写入 `~/.zcode/cli/config.json` 或项目的 `.zcode/config.json`，位于 `mcp.servers` 下。这基于 3.16.2 源码，尚未认证 3.15.1。Pull 只从 `~/.agents/mcp.json` 移走未被修改的 teamai 条目。原生配置中有 server 后，桌面应用不再读取该备用文件，doctor 会列出其中的其他 server。

WorkBuddy 按顺序使用第一个已存在的用户文件：`~/.workbuddy/.mcp.json`、`~/.workbuddy/mcp.json`、`~/.codebuddy.json`。`CODEBUDDY_CONFIG_DIR` 会移动最后一个文件。项目使用 `.mcp.json`，仅有 `mcp.json` 时使用后者。开启 `sharing.gitExclude` 后，server 写入 `.codebuddy.json` 的 `projects[<项目路径>].mcpServers`。这些路径基于 CodeBuddy 2.168.0 引擎，尚未认证 WorkBuddy 启动器的主目录绑定。Pull 只从旧项目文件 `.workbuddy/mcp.json` 移除未被修改的 teamai 条目。

主目录或项目中存在 `.workbuddy-ai/` 时（WorkBuddy 5.7+），默认技能路径改为 `.workbuddy-ai/skills`。其他内容仍要等 `.workbuddy/` 存在才写入，所以只有 `.workbuddy-ai/` 的成员收不到规则、团队指令、agent、MCP server 和钩子，`teamai doctor` 会以 `workbuddy receives ...` 失败并列出被搁置的项。

工具主目录或配置的 MCP 路径改变时，pull 保留旧副本并提示一次。确认没有工具读取后再删除。Doctor 会报告工具不读取的映射、已移动的文件，以及仅在项目根目录启动会话时才读取的项目 MCP。MCP 通道未知的内部版本只显示提示，不猜测配置路径。

在包含已初始化仓库的 workspace 中，Claude Code、CodeBuddy 和 WorkBuddy 通过各自的 local scope 而不是项目 MCP 文件获得这些 server，所以在其中某个仓库里启动的会话不会加载它们。在单仓库模式下，或 tclaude、Muse Code 读取该文件时，Claude Code 的 server 仍留在其中，这样的会话会加载它们。

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

`mcp inject` 和 `mcp remove` 遇到无法读取或解析的工具配置时返回退出码 1，`--dry-run` 也一样。其他工具仍可能更新；命令会列出这些变更，并报告操作未完成。修复警告中指出的配置后，重新运行该命令。无法读取的配置及其归属记录会保留，供重试使用。

Muse 调整 JSON 对象的键顺序不会被视为个人修改。移除时会核对记录的内容（包括嵌套对象），仍会保留实际修改过命令、参数或环境变量的 server。旧记录如果没有内容指纹，需要团队 Git 历史中与原 hash 匹配的定义作为依据；无法证明时会保留 server 并提示。

## 模型

`models/models.yaml` 自己 commit。密钥留在每人自己的机器上。只给一个项目时写 `models/<ns>/models.yaml`。

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

```bash
teamai models switch tokenhub
```

## 团队包

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

pull 之后跑 `teamai packages`。

## 会话

无人值守的运行现在默认发布自己的会话。在 CI、云虚拟机或托管任务中，[`teamai score --drain`](scorers.md#无人值守任务结束前运行-drain) 会把本机记录为无人值守的已捕获会话，以及在这里驱动的工作流运行的步骤会话，脱敏后归档到 `teamai-reports`。本地驱动在无人值守运行结束时执行它。要保持原来的行为，设置 `unattended: off`：

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

`sessions.publish` 按运行模式分别取 `off`、`ask` 或 `auto`。下面写出的是默认值：

```yaml
# teamai.yaml
sessions:
  publish: { attended: ask, unattended: auto }
```

`ask` 目前等同于 `off`，所以成员的会话只会通过 `teamai session push` 等命令归档。有人值守的 `auto` 在会话六小时没有任何活动后归档它，由评判已结束会话的后台任务完成。发布总会脱敏。HTTP 团队没有会话归档，因此在那里 `sessions.publish` 等同于 `off`，`teamai doctor` 会说明这一点。

成员的 `config.yaml` 优先，按模式分别生效。它没有写的模式沿用 `teamai.yaml`：

```yaml
# config.yaml
sessions:
  publish: { attended: ask }   # 只设置有人值守；无人值守仍按团队设置
```

值不是 `off`、`ask` 或 `auto` 时，`teamai doctor` 会报告它所在的文件和键，teamai 忽略该值，这种模式交给下一级。分支的 `teamai.yaml` 含有这样的值时，`teamai review --branch` 判定失败。会话是否评判由 `scorers/scoring.yaml` 中的 `sessions` 决定，见[已结束的会话](scorers.md#已结束的会话)。

## Docs（文档）

把文件放进团队仓库的 `docs/`，提交后成员 `pull` 时同步。某个目录只给一部分人时，在 `resources.docs` 里声明：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```

self 模式下，如果当前分支落后于默认分支，推送修改过的 skill 会在可能覆盖主干文件时以 exit 2 停止。检查覆盖整个 skill 目录，包括参考文件和删除操作，即使本地改的是另一个文件也会检查。先合并默认分支、解决 skill 差异，再重试；已包含主干修改的副本可以正常推送。

团队在原命名空间重新加入退役 agent 后，应直接编辑该命名空间源文件，旧的平铺副本作为备份保留。删除退役的根目录副本不会把剩余工具副本变成新 agent。即使 checkout 已跟上默认分支，编辑或转换已放置的 agent 仍会检查上次投递的 blob。
