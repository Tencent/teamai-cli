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

没有 frontmatter 时，`push` 会补上 `name` 和 `description`。新 skill 写到你的角色或当前项目给出的 `skills/<ns>/<name>/`。有多个时会问。`--role` 指定一个。

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

`pull` 按工具自己的格式写入它的 agents 目录：Codex 系列是 `<name>.toml`，Copilot 是 `<name>.agent.md`，Kiro 是 `<name>.json`，其余是 `<name>.md`。

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

在包含已初始化仓库的 workspace 中，Claude Code 和 CodeBuddy 通过各自的 local scope 而不是项目 MCP 文件获得这些 server，所以在其中某个仓库里启动的会话不会加载它们。在单仓库模式下，或 tclaude、Muse Code 读取该文件时，Claude Code 的 server 仍留在其中，这样的会话会加载它们。

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

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

## Docs（文档）

把文件放进团队仓库的 `docs/`，提交后成员 `pull` 时同步。某个目录只给一部分人时，在 `resources.docs` 里声明：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```
