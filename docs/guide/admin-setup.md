# Setup demos

> [English](admin-setup.md) | [简体中文](zh-CN/admin-setup.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

Joining a repo that already exists is [Join a team](./getting-started.md#join-a-team).

## Scope

This project:

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
```

This machine:

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
```

Company files in `~/`, this service in the project:

```bash
teamai init https://github.com/your-org/engineering-practices --scope user
cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
```

This repo is the team repo:

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
```

## Repo

`init` writes `teamai.yaml`. A separate team repo keeps it at the repo root. When this repo is the team repo, the file is `.teamai/teamai.yaml` and includes `mode: self`.

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

`init .` also creates this layout on the current branch:

```text
.teamai/teamai.yaml
.teamai/skills/
.teamai/rules/
.teamai/docs/
.teamai/env/env.yaml
.teamai/mcp/mcp.yaml
```

`teamai push` sends skills and rules. Commit `docs/`, `hooks/hooks.yaml`, and `mcp/mcp.yaml` yourself.

### Git permissions

Teammates push branches and open pull requests. The default branch stays protected.

## Packages

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

After pull, `teamai packages`.

## Models

`models/models.yaml`. The key stays on each machine.

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

## Env

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

Commit the file.

## Roles and projects

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

Commit both files. In the project:

```bash
teamai roles set frontend
teamai projects set checkout
teamai pull
```
