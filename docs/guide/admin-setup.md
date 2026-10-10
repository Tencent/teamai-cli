# Setup demos

> [English](admin-setup.md) | [简体中文](zh-CN/admin-setup.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

Copy one block. Then `teamai doctor`. Joining a repo that already exists is [Join a team](./getting-started.md#join-a-team).

| Copy | |
| --- | --- |
| Where files install | [Scope](#scope) |
| `teamai.yaml` and the repo | [Repo](#repo) |
| npm packages and Claude plugins | [Packages](#packages) |
| A shared model gateway | [Models](#models) |
| Env vars | [Env](#env) |
| MCP servers | [MCP](#mcp) |
| Different skills for different people | [Demo 5](#demo-5-roles-and-projects) |

---

## Scope

This project only:

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
```

Every project on this machine:

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
```

Company files in `~/`, this service's files in the project:

```bash
teamai init https://github.com/your-org/engineering-practices --scope user

cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
```

The business repo is the team repo (no second repository):

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
```

`scope:` in `teamai.yaml` is ignored. `--scope` on `init` is what counts.

---

## Repo

Empty repo, named `<team-name>-teamai`. Teammates can push branches. The default branch stays protected. They run the same `init` in their project.

`init` writes `teamai.yaml`. Replace the placeholders. Separate team repo: file at the repo root. Business repo is the team repo: `.teamai/teamai.yaml`.

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

Other fields: [configuration reference](./reference.md#teamaiyaml-remote-team-config). Token and self-hosted GitLab: [Git Providers](./providers.md).

When the business repo is the team repo, `init .` commits this layout on the current branch:

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

Skills and rules: `teamai push` (opens a pull request). `docs/`, `hooks/hooks.yaml`, `mcp/mcp.yaml`: a normal commit.

### Git permissions

Teammates need permission to push branches and to open pull requests. Leave the default branch protected. Admin rights are not required.

`teamai push` pushes a feature branch and opens a pull request. Reports and learnings use the branches `teamai-reports` and `teamai-learnings`, and the first push creates them. With `provider: git`, teamai pushes the branch and prints the command to open the pull request.

---

## Packages

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

That writes `packages:` into `teamai.yaml`:

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

On each machine, after pull: `teamai packages`. Field list: [Team packages](./member-guide.md#team-packages).

---

## Models

`models/models.yaml` in the team repo. The key is not in the file. Each person sets it locally.

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

Field list: [Model profiles](./reference.md#model-profiles).

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
# env/secrets.yaml — name only, no value
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

Commit the file. `teamai pull` writes it into each installed tool.

---

## Demo 5. Roles and projects

Skip this when everyone gets the same skills. Without these two files, `pull` installs the repo root for every member.

A role is a job (`frontend`). A project is this checkout (`checkout`). Pull installs both.

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
skills/common/code-review/SKILL.md      # every role that lists common
skills/frontend/react-patterns/SKILL.md # frontend only
skills/checkout/                       # checkout project only
```

```bash
teamai roles add frontend --namespaces common,frontend -d "Web engineers"
teamai projects add checkout --namespaces checkout --name "Checkout service"

teamai roles set frontend
teamai projects set checkout
teamai pull
teamai list
```

The first two commands write the manifests and open a pull request. After it is merged, run the last four in the project directory. `teamai list` shows `common`, `frontend`, and `skills/checkout/`.
