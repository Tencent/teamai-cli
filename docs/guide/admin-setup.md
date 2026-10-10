# Admin Setup

> [English](admin-setup.md) | [简体中文](zh-CN/admin-setup.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

One admin does this. Everyone else follows [Path B in Getting Started](./getting-started.md#path-b--join-a-team).

Copy the demo that matches your team. Each one ends with `teamai doctor`: every line should pass.

| You want | Copy |
| --- | --- |
| A shared repo, resources in this project only | [Demo 1](#demo-1-separate-team-repo) |
| The same resources in every project on this machine | [Demo 2](#demo-2-user-scope) |
| This business repo to be the team repo | [Demo 3](#demo-3-single-repo) |
| Company-wide resources plus a project repo | [Demo 4](#demo-4-organization-plus-project) |
| Different people to receive different skills | [Demo 5](#demo-5-roles-and-projects) |

GitHub, GitLab, GitCode, CNB, TGit, and a private Git host all work. Token and self-hosted GitLab setup is in [Git Providers](./providers.md).

---

## Demo 1. Separate team repo

Create an empty repo (suggested name: `<team-name>-teamai`), give teammates write access, then:

```bash
cd /path/to/my-project
teamai init https://github.com/your-org/platform-teamai
teamai doctor
```

Send teammates the repo URL. They run the same `init` in their own project.

Resources land in this project (`.claude/skills/`, and the same for the other tools `init` found). A `scope:` field in `teamai.yaml` is ignored; only `--scope` on `init` decides.

---

## Demo 2. User scope

Same team repo. Resources install under your home directory, so every project on this machine sees them.

```bash
teamai init https://github.com/your-org/platform-teamai --scope user
teamai doctor
```

| | Project scope (Demo 1, default) | User scope (Demo 2) |
| --- | --- | --- |
| Installs into | the project directory | `~/` |
| Use it for | skills that belong to one repo | conventions and skills every repo should have |
| Together | a project install can also read the user install | see [Demo 4](#demo-4-organization-plus-project) |

---

## Demo 3. Single-repo

The business repo is the team repo. There is no second repository.

```bash
cd /path/to/my-project
teamai init . --agent claude,cursor
teamai doctor
```

`--agent` is repeatable or comma-separated (`claude,cursor`). Re-running `init .` keeps tools you already enabled and adds the ones you name. Omit `--agent` in a terminal and `init` asks; option 1, **Auto**, is the tools already installed under your home directory.

`init` commits this layout on the current branch. Push that branch so a clone is enough for the next person: their first `teamai` command or AI session finishes setup when their Git host is already logged in.

```text
my-project/
├── .teamai/
│   ├── teamai.yaml
│   ├── skills/
│   ├── rules/
│   ├── docs/
│   ├── agents/
│   ├── env/env.yaml          # committed; no secrets
│   ├── env/secrets.yaml      # names only, no values
│   ├── hooks/hooks.yaml
│   └── mcp/mcp.yaml
├── .claude/settings.json     # one settings file per --agent
└── src/
```

Add a skill or rule with `teamai push` (it opens a pull request). Edit `docs/`, `hooks/hooks.yaml`, and `mcp/mcp.yaml` with a normal commit. Put only non-secret values in `env/env.yaml`. Name a secret, without its value, in `env/secrets.yaml` — see [Team secrets](../designs/team-secrets.md).

One team setup stays tied to this repo. To share one knowledge base across many repos, use [Demo 1](#demo-1-separate-team-repo).

### Git permissions

On a protected default branch, a member needs to:

- push `teamai-reports` and `teamai-learnings`, and create those refs the first time
- push the feature branches `teamai push` creates
- open pull requests against the default branch

A member does not need to push `main` directly or hold admin rights. With `provider: git`, teamai pushes the branch and prints the command to open the pull request yourself.

---

## Demo 4. Organization plus project

Install the CLI once. Each scope has its own config and its own clone.

```bash
# once per developer: company skills, rules, docs, agents
teamai init https://github.com/your-org/engineering-practices --scope user

# in one service: project resources stay in front
cd /path/to/java-service
teamai init https://github.com/your-org/java-service-teamai --inherit-user-scope
teamai doctor
```

`teamai pull` refreshes the user-scope skills, rules, docs, agents, culture, and search index, then the project scope. User env, hooks, MCP, cross-team sources, and usage reporting are not inherited. Two resources with the same name stay in different directories; recall prefers the project copy.

---

## Demo 5. Roles and projects

Skip this demo when everyone should receive the same skills. With no `manifest/roles.yaml` and no `manifest/projects.yaml`, `pull` installs the repo root for every member.

A **role** is a job (`frontend`, `infra`). A **project** is which checkout this directory is (`checkout`, `billing`). A member receives the union of both. They do not override each other.

`skills/common/` is shared by every role that lists `common`. `skills/frontend/` reaches only roles and projects that list `frontend`. While roles or projects are in use, a skill left in the root `skills/` is delivered only when a member subscribes to its tag (`teamai tags subscribe <tag>`).

```text
platform-teamai/
├── teamai.yaml
├── manifest/
│   ├── roles.yaml
│   └── projects.yaml
├── skills/
│   ├── common/code-review/SKILL.md
│   └── frontend/react-patterns/SKILL.md
├── rules/
│   ├── common/style.md
│   └── frontend/react.md
└── env/
    ├── env.yaml
    └── frontend/env.yaml
```

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
  - id: infra
    description: Infrastructure
    resources:
      knowledge: [common, infra]
      skills:    [common, infra]
      agents:    [common, infra]
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

```yaml
# env/env.yaml — everyone
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint

# env/frontend/env.yaml — only where the frontend namespace is active
variables:
  - key: API_ENDPOINT
    value: https://web.example.com
```

The same commands write those manifests and open a pull request. Merge it, then each person picks a role in the directory where they work.

```bash
# admin, once
teamai roles add frontend --namespaces common,frontend -d "Web engineers"
teamai projects add checkout --namespaces checkout --name "Checkout service"

# each member, in their project
teamai roles set frontend
teamai projects set checkout
teamai pull
teamai list
```

`teamai list` should show `common` and `frontend` skills, plus anything under `skills/checkout/`. `learnings/checkout/` is visible only in a directory that has that project active. `learnings/` at the repo root stays shared.

A namespace is one path segment (`frontend`, not `web/frontend`).

To give one directory every project, `teamai init <repo> --project all`.

---

## Copy-paste teamai.yaml

Put this at the root of a separate team repo, or at `.teamai/teamai.yaml` in [Demo 3](#demo-3-single-repo). `init` writes one for you; replace the placeholders.

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

Every other field is in the [configuration reference](./reference.md#teamaiyaml-remote-team-config).

---

## What init writes on this machine

You do not hand-write this. After Demo 1 it looks like:

```yaml
# ~/.teamai/projects/<project>-<hash>/config.yaml
repo:
  localPath: ~/.teamai/projects/<project>-<hash>/team-repo
  remote: https://github.com/your-org/platform-teamai.git
username: alice
scope: project
projectRoot: /path/to/my-project
primaryRole: frontend          # after Demo 5
additionalRoles: []
```

User scope (Demo 2) uses `~/.teamai/config.yaml` and `scope: user`. Demo 4 adds `inheritUserScope: true` on the project config.

Where the clone, learnings, and reports actually sit is in the [data directory layout](../designs/data-directory-layout.md).
