# 配置示例

> [English](../admin-setup.md) | [简体中文](admin-setup.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

抄一块。然后跑 `teamai doctor`。加入已有仓库，看[加入团队](./getting-started.md#加入团队)。

| 要抄的 | |
| --- | --- |
| 文件装在哪 | [Scope](#scope) |
| `teamai.yaml` 和仓库 | [仓库](#仓库) |
| npm 包和 Claude 插件 | [Packages](#packages) |
| 共用的模型网关 | [Models](#models) |
| 环境变量 | [Env](#env) |
| MCP server | [MCP](#mcp) |
| 不同的人收到不同的 skill | [Demo 5](#demo-5-角色和项目) |

---

## Scope

只进当前项目：

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
```

这台机器上的每个项目都能用：

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
```

公司级文件在 `~/`，这个服务自己的文件在项目里：

```bash
teamai init https://github.com/your-org/engineering-practices --scope user

cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
```

业务仓库自己就是团队仓库，没有第二个仓库：

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
```

`teamai.yaml` 里的 `scope:` 不起作用。只有 `init` 的 `--scope` 算数。

---

## 仓库

建一个空仓库，名字用 `<团队名>-teamai`。给同事分支写权限，主干保持保护。同事在自己的项目里跑同一条 `init`。

`init` 会写一份 `teamai.yaml`。把占位符换成你的。独立团队仓库放在仓库根目录。业务仓库自己当团队仓库时，放在 `.teamai/teamai.yaml`。

```yaml
team: platform
description: Platform team AI resources
repo: https://github.com/your-org/platform-teamai.git
provider: github

reviewers:
  - alice

sharing:
  recall:
    enabled: true
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
```

其余字段见[配置参考](./reference.md#teamaiyaml远端团队配置)。Token 和自建 GitLab 见 [Git Provider](./providers.md)。

业务仓库自己当团队仓库时，`init .` 把下面这棵目录提交到当前分支：

```text
my-project/
├── .teamai/
│   ├── teamai.yaml
│   ├── skills/
│   ├── rules/
│   ├── docs/
│   ├── agents/
│   ├── env/env.yaml
│   ├── env/secrets.yaml
│   ├── hooks/hooks.yaml
│   └── mcp/mcp.yaml
└── .claude/settings.json
```

skill 和 rule 用 `teamai push`，它会开 pull request。`docs/`、`hooks/hooks.yaml`、`mcp/mcp.yaml` 用普通 commit。

### Git 权限

同事有分支写权限、能开 pull request 就够了。主干保持保护。不需要管理员权限。

`teamai push` 推一个功能分支并开 pull request。上报和学习记录走 `teamai-reports`、`teamai-learnings` 这两个分支，第一次推送时创建它们。`provider: git` 时，teamai 推送分支并打印手动开 pull request 的命令。

---

## Packages

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

上面的命令会把 `packages:` 写进 `teamai.yaml`：

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

每台机器 pull 之后跑 `teamai packages`。字段说明见[团队包](./member-guide.md#团队包)。

---

## Models

团队仓库里的 `models/models.yaml`。密钥不写在文件里，每人在自己机器上配。

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

字段说明见[模型配置](./reference.md#模型配置)。

---

## Env

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint
```

```yaml
# env/secrets.yaml — 只写名字，不写值
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
```

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope"
teamai push
```

---

## MCP

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
```

把这个文件提交。`teamai pull` 会写进已安装的工具。

---

## Demo 5. 角色和项目

所有人收同一套 skill 时，跳过这份。没有这两份文件时，`pull` 把仓库根目录发给每个成员。

角色是岗位（`frontend`）。项目是这个目录（`checkout`）。pull 两份都装。

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: frontend
    description: Web engineers
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]
```

```yaml
# manifest/projects.yaml
version: 1
projects:
  - id: checkout
    name: Checkout service
    resources:
      knowledge: [checkout]
      skills:    [checkout]
      learnings: [checkout]
      agents:    [checkout]
```

```text
skills/common/code-review/SKILL.md      # 列出 common 的角色都会收到
skills/frontend/react-patterns/SKILL.md # 只有 frontend
skills/checkout/                       # 只有 checkout 这个项目
```

```bash
teamai roles add frontend --namespaces common,frontend -d "Web engineers"
teamai projects add checkout --namespaces checkout --name "Checkout service"

teamai roles set frontend
teamai projects set checkout
teamai pull
teamai list
```

前两条会写入 manifest 并开一个 pull request。合并之后，在项目目录里运行后四条。`teamai list` 能看到 `common`、`frontend` 和 `skills/checkout/`。
