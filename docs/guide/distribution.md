# Distribution mechanism

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

Where files install, which repo they come from, and who receives them are all here. A file that is not in a namespace goes to everyone.

## Scope

### Project checkouts

Linked worktrees of the same repository share the project's TeamAI configuration and data, while each checkout receives resources in its own tool directories. `init` and `pull` install Git checkout hooks that seed a new worktree's enabled tool roots and pull its resources before the checkout command returns. Some agent tools create worktrees without running Git hooks, such as Claude Code's `EnterWorktree` and Codex CLI. Such a worktree is prepared the same way, in the background, on the first session start or tool use there.

A submodule clone created inside a superproject worktree inherits the original submodule's TeamAI configuration and data partition. Its first pull seeds the clone's tool roots from the original configuration, delivers resources into those roots, and installs hooks owned by that clone. Each checkout keeps its own hook ownership; full uninstall removes hooks recorded for every checkout. For targeted uninstall behavior, see [Uninstall](./faq.md#uninstall).

### Separate teamai repo

The team's assets live in their own repo. This project points at it.

This project:

```bash
cd /path/to/my-workspace
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

### Pin a workspace to a team revision

In a workspace with a separate git team repo, use `pull --team-ref` to try a remote branch, tag, or commit that contains `teamai.yaml`:

```bash
teamai pull --team-ref feature/review-skill
teamai pull --team-ref v2.3.0
teamai pull --team-ref 3f2c9a7d
teamai pull --team-ref main  # use your team's default branch to unpin
```

The pin stays in this workspace's local config and applies to all its checkouts and hook pulls. Branch pins follow new commits; tags and commits stay fixed. A commit must be reachable from a remote branch. `pull` and `status` show the pin.

A revision switch removes unchanged skill, rule, and agent copies the new revision lacks. Edited copies stay, and unpinning names edits that `push` would send to the default branch. While pinned, `push` sends nothing, and `source add`, `source remove` and `import` into the team wiki refuse; pull still reports usage and learnings. A failed or incomplete pinned pull exits 1. `--team-ref` with `--dry-run` is refused.

This requires a workspace install without user-scope inheritance or the same team installed at user scope. It does not apply to HTTP or single-repo mode. Other workspaces keep their own revision.

### Inside the project repo

This repo is the team repo. Assets go in `.teamai/`.

```bash
cd /path/to/my-workspace
teamai init . --agent claude,cursor
```

### Workspaces with repos inside

A workspace also delivers what the set-up repos under it select.
`teamai pull` in `ws/` finds them up to three folders down and names them.
It stops at a repo: folders and worktrees inside `svc-a/` belong to `svc-a`.
A skill, agent, hook, env key or MCP server two repos ship the same way arrives once; one that differs is held and named, and each repo keeps its own.
A child with another team repo is left out, with a line that says so.
Your agent in `svc-a/` still gets only `svc-a`'s resources.

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

`teamai push` sends every distributed resource type — skills, rules, agents, docs, env, hooks, mcp, models, claudemd, learnings, wiki, workflows, prompts, and scorers — with `--project` and `--role` namespace placement.

### Git permissions

Teammates push branches and open pull requests. The default branch stays protected.

### Git submodules

Turn this on in `teamai.yaml` when skills are git submodules. Each pull checks them out at the pinned revision.

```yaml
submodules: true
```

### Team scripts

`teamai.yaml` can name Node scripts. The CLI runs each one with its own Node, not a shell. `path` is relative to the team repo root and must stay inside that repo. A symlink that leaves the repo is rejected. The script's working directory is the team repo. A failure does not fail init or pull.

In workspace scope the script also receives the checkout TeamAI already resolved. The script decides what to write. TeamAI does not manage personal files, and it does not replace a file the script chooses to keep.

- `TEAMAI_REPO` — the team repo
- `TEAMAI_SCOPE` — `user`, or `project` for the workspace scope
- `TEAMAI_CHECKOUT` — this checkout, in workspace scope
- `TEAMAI_MAIN_CHECKOUT` — the main checkout TeamAI resolved, when it knows one
- `TEAMAI_PROJECT` — that same resolved identity, stable across worktrees of one repo

```yaml
scripts:
  preInit:
    path: scripts/pre-init.mjs
  postInit:
    path: scripts/post-init.mjs
  prePull:
    path: scripts/pre-pull.mjs
  postPull:
    path: scripts/deploy.mjs
  postDeploy:
    path: scripts/link-local.mjs
```

- `preInit` runs during `teamai init`, after local config is saved and before hooks are installed. It can read the terminal. Init waits with no timeout. A non-interactive init (no terminal, `CI`, or `TEAMAI_NONINTERACTIVE`) skips it. Run it later with `teamai script run preInit`.
- `postInit` runs after hooks are installed. Init waits, then syncs MCP, so a value the script collected takes effect. The same skip rule applies. `teamai script run postInit` runs it again and syncs MCP.
- `prePull` runs at the start of a full pull, before that scope is synced. It cannot read the terminal. Pull waits up to 90 seconds, then leaves it running. An inline pull does not run it.
- `postPull` runs after a full pull. A session start waits up to 90 seconds, then leaves it running. An interactive `teamai pull` does not wait. An inline pull does not run it. A failure is a line in `~/.teamai/debug.log`.
- `postDeploy` runs once for each new linked worktree or submodule checkout, when its first delivery finishes. Git's hook runs it before that git command returns, or, when that hook could not reach the team repo, the background pull after it does. For a worktree an agent tool created without Git hooks, or one made before TeamAI was set up, the tool's first session or tool use there runs it in the background. That path does not run `teamai init`. Pull waits up to 15 seconds. Run the script again with `teamai script run postDeploy`. It should be safe to repeat, and it should leave an existing personal file alone.

## Roles and projects

A role is a member's job, such as frontend. Someone who sets that role receives the resources the role lists.

A project is the service they are working on. After this directory is set to that project, it also receives the resources the project lists.

`knowledge` covers rules and shared instructions (`claudemd/`). A project can also declare learnings, env, hooks, mcp, models, docs, and wiki on its own.

```yaml
# manifest/roles.yaml
version: 1
roles:
  - id: frontend
    description: Web engineers
    resources:
      knowledge: [common, frontend]  # rules/<ns>/, claudemd/<ns>/
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
      knowledge: [checkout]   # rules/checkout/, claudemd/checkout/
      skills: [checkout]
      learnings: [checkout]
      agents: [checkout]
      env: [checkout]          # env/checkout/env.yaml
      hooks: [checkout]        # hooks/checkout/hooks.yaml
      mcp: [checkout]          # mcp/checkout/mcp.yaml
      models: [checkout]       # models/checkout/models.yaml
      docs: [checkout]         # docs/checkout/
      wiki: [github__acme__checkout]  # the slug teamai import printed as project:
```

Commit both files. In the project:

```bash
teamai roles set frontend
teamai projects set checkout
teamai pull
```

`repo.localPath` accepts home-relative paths such as `~/.teamai/team-repo`, including the native `~\.teamai\team-repo` form on Windows.

## Assigning roles in the team repo

By default each member picks their own role and can change it at any time. A team that also uses the effective roles as a limit — a hook that lets a `frontend` member's agent change `frontend/` and shared files only — wants that assignment to be a reviewed change in the team repo. `manifest/members.yaml` makes it one:

```yaml
# manifest/members.yaml
version: 1
members:
  alice: [frontend]
  bob: [backend, ki]
default: []        # roles of a member this file does not list
```

The first role listed is the member's primary role, the rest are additional. While the file exists:

- A member's effective roles are the ones assigned here. `teamai roles set` refuses, and so does the dashboard's Distribution page, which shows the roles instead of offering them.
- A member the file does not list holds `default` — no roles unless you say otherwise — and receives shared resources only, rather than the unfiltered sync a role-less member gets without this file.
- Who may assign roles is your forge's decision, as it already is for `roles.yaml`: a protected branch, a merge request, code owners for `manifest/`. teamai keeps no access list of its own.

The member key is the username in the member's own teamai config, which `teamai init` records from the git provider. Deleting the file hands role selection back to each member. teamai reads it from the team repo's fetched default branch, not from the clone on the member's machine, so editing or deleting that copy changes nothing: only what your forge merged counts.

A reassignment takes effect on the next pull.

A team hook reads the effective roles without parsing any config file:

```bash
teamai roles list --json
# {"roles":["frontend"],"primaryRole":"frontend","additionalRoles":[],"source":"assigned","assignmentFile":"manifest/members.yaml"}
```

`source` is `assigned` (listed in the file), `default` (not listed), `local` (no such file, so the member's own selection) or `none`.

This is not a boundary against a determined process running as the member: the agent runs as that member and could edit the config the username comes from, or teamai itself. What it gives you is a role change that is a reviewed team decision with a history, instead of one command on a laptop.

## Restricting skills to some members

Namespaces only filter for members who have set a role: a member with no `primaryRole` syncs everything, so `manifest/roles.yaml` alone restricts no one. With `manifest/members.yaml` in place that gap is closed — an unlisted member receives shared resources only. `teamai init` makes new members pick a role; members from before the manifest need `teamai roles set <role-id>` once. Their next pull withdraws teamai-delivered copies outside the new namespaces (locally modified copies are kept).

To remind members who never set a role, enforce a rule that asks the agent to check `teamai roles list` and prompt them — enforced rules cannot be deleted:

```yaml
# teamai.yaml
sharing:
  rules:
    enforced: [set-your-role]
```

Tags never restrict: a subscription only adds matching tagged skills. Restrict with namespaces + roles; use tags for opt-in extras.

## Tags

A tag is on a skill or a rule, in the team repo's `tags.yaml`. A member subscribes on their own machine. With no subscription, tags do nothing. After a subscription, skills and rules that carry those tags are pulled too. Untagged ones still follow roles and projects.

```yaml
# tags.yaml
skills:
  hai-deploy: [hai, infra]
rules:
  code-style: [coding]
```

```bash
teamai tags add skills hai-deploy hai infra
teamai tags subscribe hai
teamai pull
```

## Subscriptions

A subscription is another team's public skills. That team lists them in its own `teamai.yaml`:

```yaml
publicSkills:
  - deploy-helper
```

```bash
teamai source add https://github.com/other-team/teamai-public.git --name other-team
teamai source list
teamai source browse other-team
teamai source remove other-team
teamai push
```

`source add` writes into this team's repo. After `push` merges, every member's `pull` installs them. A source with no `publicSkills` is empty.

### HTTP source

```bash
teamai source add-http https://your-team-host/api --token <api-key>
teamai source list
teamai source remove-http
```

An install has one HTTP source. `add-http` is unavailable when the main repo is already `init --http`. The API is the [ClawPro HTTP backend](./http-contract.md).
