# 配置示例

> [English](../admin-setup.md) | [简体中文](admin-setup.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

加入已有仓库，看[加入团队](./getting-started.md#加入团队)。

## 安装范围

只进当前项目：

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
```

这台机器上的每个项目：

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
```

公司级文件在 `~/`，这个服务的文件在项目里：

```bash
teamai init https://github.com/your-org/engineering-practices --scope user
cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
```

业务仓库自己就是团队仓库：

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
```

## 仓库

`init` 会写 `teamai.yaml`。独立团队仓库放在仓库根目录。业务仓库自己当团队仓库时，文件是 `.teamai/teamai.yaml`，并带 `mode: self`。

```yaml
team: platform
description: Platform team AI resources
repo: https://github.com/your-org/platform-teamai.git
provider: github
sharing:
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
```

`init .` 还会在当前分支建出这些目录：

```text
.teamai/teamai.yaml
.teamai/skills/
.teamai/rules/
.teamai/docs/
.teamai/env/env.yaml
.teamai/mcp/mcp.yaml
```

skill 和 rule 用 `teamai push`。`docs/`、`hooks/hooks.yaml`、`mcp/mcp.yaml` 自己 commit。

### Git 权限

同事能推分支、能开 pull request。主干保持保护。

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

## 模型

`models/models.yaml`。密钥留在每人自己的机器上。

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

## 环境变量

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope"
teamai push
```

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

把这个文件提交。

## 角色和项目

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: frontend
    description: Web engineers
    resources:
      knowledge: [common, frontend]
      skills: [common, frontend]
      agents: [common, frontend]
```

```yaml
# manifest/projects.yaml
version: 1
projects:
  - id: checkout
    name: Checkout service
    resources:
      knowledge: [checkout]
      skills: [checkout]
      learnings: [checkout]
      agents: [checkout]
```

```text
skills/common/code-review/SKILL.md
skills/frontend/react-patterns/SKILL.md
skills/checkout/
learnings/checkout/
```

把这两份文件提交。在项目里：

```bash
teamai roles set frontend
teamai projects set checkout
teamai pull
```
