# TeamAI CLI — Team Onboarding & Usage Guide

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — the team collaboration layer for AI agents
>
> **Make every team continuously smarter with AI.** Define how agents work (Team Execution), give them team knowledge (Team Context), and turn real sessions into shared capability (Team Improvement). TeamAI manages Skills, Rules, Docs, Env, MCP, and more across Claude Code, Codex, CodeBuddy, WorkBuddy, OpenCode, Cursor, and other supported agents.

---

## Table of Contents

- [What TeamAI is](#what-teamai-is)
- [Core Concepts](#core-concepts)
- [Installation](#installation)
  - [Paste-able prompts](#paste-able-prompts)
- [Admin Initialization](#admin-initialization)
  - [Project Scope](#project-scope)
  - [User Scope](#user-scope)
  - [How to Choose a Scope?](#how-to-choose-a-scope)
  - [Single-repo mode (business repo is the team repo)](#single-repo-mode-business-repo-is-the-team-repo)
  - [Layer an organization repo under a project repo](#layer-an-organization-repo-under-a-project-repo)
- [Member Onboarding](#member-onboarding)
- [Day-to-Day Use](#day-to-day-use)
- [Sharing Team Resources](#sharing-team-resources)
- [Knowledge Capture & Retrieval](#knowledge-capture--retrieval)
- [Knowledge Base Health Report](#knowledge-base-health-report)
- [Commit Co-Author Attribution](#commit-co-author-attribution)
- [Team Culture](#team-culture)
- [Advanced Features](#advanced-features)
- [Configuration Reference](#configuration-reference)
- [Uninstall](#uninstall)
- [FAQ](#faq)

---

## What TeamAI is

Agents are strong as personal tools, but their learning stays personal: what one member's agent worked out yesterday does not reach anyone else's agent today.

TeamAI's product is one loop, not three separate products:

| Layer | Job | What you do in this CLI |
|-------|-----|-------------------------|
| **Team Execution** | Make every agent work the team's way | `init` / `pull` / `push` the shared harness (skills, rules, agents, hooks, MCP, env) |
| **Team Context** | Make every agent understand the team | recall, docs, learnings, codebase graph |
| **Team Improvement** | Make every execution improve the team | friction-based share-learnings, sessions, digest |

**Execute → Understand → Learn → Self-Improve.** Start with harness distribution; context and improvement grow as the team actually runs agents.

---

## Core Concepts

| Concept | Description |
|------|------|
| **Team Repo** | A Git repository that centrally stores the team's harness and knowledge (Skills / Rules / Docs / Env / Packages, plus learnings and wiki) |
| **Scope** | Where resources are installed: `project` (current project, default) or `user` (home directory) |
| **Team Execution** | One shared harness, distributed to every member's agents |
| **Team Context** | Searchable team knowledge so agents do not start from zero each session |
| **Team Improvement** | Session friction and usage signals that become new skills, rules, and knowledge |
| **Skills** | Custom skills the AI can invoke (a directory containing a `SKILL.md`) |
| **Rules** | Markdown-formatted team conventions, automatically merged into AI tool configs |
| **Docs** | Shared team documentation for the AI to reference |
| **Env** | Shared team environment variables, automatically injected into the shell |
| **Packages** | Team-wide npm packages and Claude Code plugins, installed explicitly with `teamai packages` |

```
┌───────────────┐    teamai push (MR)    ┌───────────────────┐
│ Your local     │ ──────────────────────→ │   Team Repo (Git) │
│ resources      │                         │ skills/rules/docs │
│ skills/rules   │ ←────────────────────── └───────────────────┘
└───────────────┘     teamai pull (auto)
                           │
                           ▼
                  ┌──────────────────┐
                  │  AI tools fetch   │
                  │  automatically    │
                  │ Claude / CodeBuddy│
                  │ Cursor / Codex    │
                  └──────────────────┘
```

---

## Installation

```bash
npm install -g teamai-cli

# Verify
teamai --version
```

**Prerequisites:** Node.js ≥ 20, Git (TGit users also need the `gf` CLI, and CNB users the `cnb` CLI — `teamai init` installs either automatically)

### Paste-able prompts

If you have not used Git, paste one of the [onboarding prompts](prompts/README.md) into your current AI tool (Claude Code, Codex, Cursor, CodeBuddy, WorkBuddy, OpenCode, Qoder, and other supported agents). The agent runs `teamai init` / `pull` / `push` / `doctor` and only asks when a web login or a choice is required.

| Situation | Prompt |
|-----------|--------|
| No team repo URL yet | [Getting started](prompts/getting-started.md) |
| You already have a repo URL | [Member](prompts/member.md) |
| Already initialized; day-to-day admin | [Admin](prompts/admin.md) |

---

## Admin Initialization

> Only one admin needs to do this — other members can skip to [Member Onboarding](#member-onboarding).

Create an empty repository on GitHub, GitLab (gitlab.com or a self-hosted instance), GitCode (gitcode.com), CNB (cnb.cool), TGit, or any private/self-hosted Git service (suggested naming: `TeamAi-<team-name>`). For providers that support repository creation, you can also run `teamai init` and create a missing repo when prompted.

For self-hosted GitLab, configure the instance and a Personal Access Token with `api` scope first:

```bash
export GITLAB_URL=https://git.example.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx
teamai init https://git.example.com/yourgroup/yourrepo
```

For an unknown host, `init` makes an anonymous GitLab sign-in page check with a three-second total timeout. If confirmed as GitLab, it stops before authentication, cloning, or writing configuration and asks you to set the instance URL and token, then retry. The check does not send tokens or follow redirects. If it cannot confirm GitLab, initialization continues with the generic `git` provider, which supports Git transport but cannot create repos or PRs/MRs automatically. Set `GITLAB_URL` explicitly for instances behind SSO, deployed under a subpath, or otherwise inaccessible to the check.

**Already initialized with `provider: git`?** Set the variables above and change `provider` to `gitlab` in the team repo's `teamai.yaml`. Setting the environment variables alone does not change an existing provider selection. A failed `teamai push` may already have pushed the branch; if its diagnostic detects GitLab, it prints these recovery steps. See [provider configuration](providers.md#gitlab-provider含自托管).

### Project Scope (default)

Resources are installed under the project directory (`<project>/.claude/skills/`, etc.), suited for project-specific skills and rules.

```bash
# project is the default — --scope can be omitted
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# equivalent alias: teamai init --repo https://github.com/yourorg/yourrepo
```

Resulting directory structure:

```
/path/to/my-project/          # your business repo — ZERO teamai residue
├── .claude/skills/              # Project-level skills (auto-synced)
├── .claude/rules/               # Project-level rules (auto-synced)
└── src/

~/.teamai/projects/my-project-<hash>/   # this project's machine-data partition
├── config.yaml
├── state.json
└── team-repo/                           # clone of the team repo
```

Project machine-data (config, state, the team-repo clone, search index, MCP
manifests, resource cache) lives in a per-project partition under
`~/.teamai/projects/<slug>/`, **not** in the business repo, so your workspace has no
teamai residue and a `git worktree` of the same repo shares one partition. Per-agent
project roots (`.claude/`, `.cursor/`, `.codebuddy/`, …) are still created inside the
workspace on **SessionStart** for the tool that just opened. For example, opening
Claude Code creates `.claude/`, then pull writes into it. A bare `teamai pull` still
skips tools whose project root does not exist, so it never invents agent directories
for tools you have not opened in this project.

> **Upgrading from an older teamai?** The first `teamai init` / `pull` / `push` after
> upgrading automatically migrates an existing `<repo>/.teamai/` into the partition
> (copy → verify → atomic switch), then leaves the old directory as `<repo>/.teamai.bak/`
> for you to delete once you've confirmed everything works. Read-only commands and the
> `hook-dispatch` path never migrate; `teamai --dry-run pull` previews the move.
> **Downgrading afterwards is not supported** — an older teamai would treat the project
> as uninitialized; `.teamai.bak/` is the manual rollback path.

If the repo has role-based skills enabled (i.e. `manifest/roles.yaml` exists), `teamai init` will also interactively ask you to choose:

- `primaryRole`: the target namespace for skill sync and push by default
- `additionalRoles`: additional skill namespaces to sync

You can also skip the interactive prompts via CLI flags for a fully non-interactive init (suitable for CI/CD or AI agents):

```bash
teamai init https://github.com/yourorg/yourrepo --scope project --role hai_dev --force
```

| Flag | Description |
|------|------|
| `[repo]` / `--repo <url>` | Team repo URL (positional preferred; `--repo` is a permanent alias) |
| `--scope <project\|user>` | Install scope, defaults to `project` (machine-data in `~/.teamai/projects/<slug>/`, resources in `<cwd>`). Use `user` for `~/` |
| `--inherit-user-scope` | Project scope only: also sync safe user resources and search user knowledge |
| `--no-inherit-user-scope` | Disable previously configured user-scope inheritance for this project |
| `--role <id>` | Directly specify the primary role, skipping the interactive role prompt |
| `--project <ids>` | Active logical project(s) from `manifest/projects.yaml` (comma-separated). Scopes which project resources and learnings this directory syncs. See [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role) below |
| `--force` | Overwrite existing config, skipping confirmation prompts |

#### Multi-project: `project` as a dimension orthogonal to `role`

When one team repo serves several projects, `project` is a second dispatch
dimension alongside `role`, declared by the admin in `manifest/projects.yaml`.
`role` answers "what is my job function"; `project` answers "which project this
directory belongs to". They are orthogonal and additive — a member gets the
**union** of their role namespaces and their active project namespaces (there is
no override between the two).

Project identity follows the working directory, exactly like `--role`:

```bash
cd ~/work/hai-inference && teamai init <team-repo> --project hai-inference
cd ~/work/billing       && teamai init <team-repo> --project billing
```

Each directory then syncs only its own project's skills/rules/CLAUDE.md and
learnings. Key points:

- **Learnings isolation.** `learnings/` at the repo root is shared with the whole
  team; a project's private learnings live under `learnings/<project-id>/` and
  only surface in `teamai recall` for members of that project. A directory with
  no active project sees the shared root only.
- **Not auto-activated.** Unlike a lone role, a lone project is not auto-selected
  — a member may legitimately belong to no project (they still get `common` and
  the shared learnings root).
- **Backward compatible.** A repo without `manifest/projects.yaml` behaves exactly
  as before; existing flat `learnings/*.md` stay shared with everyone (zero
  migration).
- **`teamai contribute`** lands a learning under the active project's subdirectory
  when exactly one project is active, otherwise at the shared root.

`manifest/projects.yaml` example:

```yaml
version: 1
projects:
  - id: hai-inference
    name: HAI Inference
    resources:
      knowledge: [hai-inference]
      skills:    [hai-inference]
      learnings: [hai-inference]
```

**Commands** (low-frequency correction/query, mirroring `teamai roles …`):

```bash
teamai projects list                 # Defined projects + the ones active in this directory
teamai projects set hai-inference    # Set active project(s) for this directory (overwrite; comma-separated or repeated; empty to clear)
teamai projects members hai-inference # Who is registered on a project
```

Member registration is a **side-effect of `init`**: running `teamai init --project <id>`
appends `<id>` to your `members/<user>.yaml` roster (append + dedupe across
directories), so the team can answer "who is on project X". `teamai push --project <id>`
pushes skills into that project's skills namespace (resolved from the manifest),
mirroring `teamai push --role`.

Example local config:

```yaml
repo:
  localPath: ~/.teamai/projects/my-project-<hash>/team-repo
  remote: https://github.com/group/repo.git
username: alice
scope: project
projectRoot: /path/to/my-project   # where resources land (this checkout)
inheritUserScope: true            # optional; project scope only
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

### User Scope

Resources are installed into your home directory (`~/.claude/skills/`, etc.), suited for general team conventions and cross-project skills.

```bash
teamai init https://github.com/yourorg/yourrepo --scope user
```

Resulting directory structure:

```
~/.teamai/
├── config.yaml          # Local config
├── team-repo/            # Clone of the team repo
│   ├── teamai.yaml      # Remote team config
│   ├── skills/ rules/ docs/ env/ members/
│   ├── manifest/roles.yaml  # Role definitions (when role-based skills are enabled)
│   └── learnings/       # Team knowledge base
~/.claude/skills/        # Team skills (auto-synced)
~/.claude/rules/         # Team rules (auto-synced)
```

### How to Choose a Scope?

| Dimension | Project Scope (default) | User Scope |
|------|-------------------|---------------|
| **Install location** | Under the project directory | Under `~/` |
| **Best for** | Project-specific skills and rules | General team conventions, cross-project skills |
| **Can coexist** | ✅ Yes; project stays active and can opt into safe user resources | ✅ Yes; remains a separate home-level install |

> **Local install location** is decided only by `teamai init`'s `--scope` (default `project`). A `scope` field in remote `teamai.yaml`, if present, is ignored.

### Single-repo mode (business repo is the team repo)

Instead of a separate team repo, you can make an existing project's own git repo double as the team repo. Run this inside the project:

```bash
cd /path/to/my-project
teamai init .                        # interactive: pick which AI tools to set up
teamai init . --agent claude,codex   # non-interactive: set up Claude Code + Codex
```

**Choosing which AI tools to set up.** Single-repo mode creates a per-tool directory in your repo (e.g. `.claude/`, `.codex/`) — it seeds the skills dir, injects the teamai hooks, and commits that tool's settings to main so teammates get them on clone. You control which tools:

- **`--agent <name...>`** — explicit list, repeatable or comma-separated: `--agent claude`, `--agent claude,codex`, `--agent claude --agent cursor`. Supported ids include `claude`, `codex`, `cursor`, `joycode`, `codebuddy`, `workbuddy`, and `dsh` (DeepSeek Harness).
- **Interactive (no `--agent`, a terminal)** — teamai shows a multi-select. Option 1 is **Auto**, which lists the AI tools already installed on your machine (`~/.claude`, `~/.codex`, …) and is the Enter default; the remaining options are the individual tools. Auto and specific tools can be combined.
- **Non-interactive (no `--agent`, no terminal — CI, hooks, clone-time bootstrap)** — teamai mirrors the tools you already use under your home dir (`~/.claude`, `~/.codex`, …). If none are found, it creates nothing (you still get the knowledge; run `teamai init .` later to pick tools).

**How it splits data across branches:**

| Data | Where it lives | Travels with `git clone`? |
|------|----------------|---------------------------|
| Knowledge: `skills/` `rules/` `docs/` `learnings/`, `teamai.yaml` | `.teamai/` on the **main** branch | ✅ Yes |
| Reports: `members/` `sessions/` `votes/` `stats/` | `teamai-reports` **orphan branch** | Pushed to `origin` (separate history) |
| Machine-local: `config.yaml`, `state.json`, search index, env backup, MCP manifests | `~/.teamai/projects/<slug>/` (**partition**, outside the repo) | ❌ No (per-machine) |
| Disposable git worktrees (`reports-wt/`, `knowledge-wt/`) | `.teamai/` (gitignored; rebuilt on demand) | ❌ No (per-machine) |

Machine-local data lives in the per-project **partition** outside the repo, so a
single-repo `.teamai/` holds only the team knowledge committed to main — `git
status` stays clean. Upgrading an older single-repo install relocates that machine
data into the partition automatically on the next `init`/`pull`/`push` (the
knowledge on main is left exactly in place).

**Clone = initialized.** Because knowledge and the `mode: self` marker in `.teamai/teamai.yaml` are committed to main, a teammate who clones the repo is auto-initialized: the next `teamai` command or AI session detects the marker, and (when their git provider is already authenticated) writes their local config, injects hooks, and registers them on the reports branch — no need to re-type repo/role. If they aren't authenticated yet, teamai prompts them to run `teamai init .` once.

**Safety.** Every git write teamai performs in single-repo mode (knowledge PRs and the reports orphan branch) runs in an isolated git worktree under `.teamai/`. Your working tree and current branch are never checked out, reset, or switched. Isolated worktree commits skip local git hooks (for example husky / lint-staged): a clean checkout from `origin/<default>` often has hook scripts without the locally generated `husky.sh`, and knowledge/report files should not run the business-repo lint pipeline. Your ordinary `git commit` in the business repo still runs hooks.

**Admin checklist after `teamai init .`:**

1. `teamai init .` already commits `.teamai/` (skills, rules, docs, learnings, `teamai.yaml`, `.gitignore`) plus each selected tool's settings (e.g. `.claude/settings.json`, `.codex/hooks.json`) to the current branch for you.
2. Push main so teammates can clone.
3. Add resources later with `teamai push` — it opens a PR against your repo (via an isolated worktree) rather than committing to your working tree. In single-repo mode you can author them either in an AI tool dir (e.g. `~/.claude/skills/`) **or** by dropping them straight into `.teamai/` in your repo:
   - `.teamai/skills/` — team skills
   - `.teamai/rules/` — shared rules
   - `.teamai/agents/` — subagent definitions (`<name>.yaml`, or legacy `<name>.md`)
   - `.teamai/env/env.yaml` — shared env vars

   `teamai push` scans all of these plus your AI tool dirs, and only surfaces genuine additions or edits (already-committed content is skipped). If you rename an agent's extension (e.g. `helper.md` → `helper.yaml`), delete the old file — `teamai push` won't remove it for you, and two files with the same stem would collide on pull.
4. **docs / hooks / mcp** are contributed by editing their file directly — they don't go through `teamai push`; a normal `git commit` + push ships them:
   - `.teamai/docs/` — team docs
   - `.teamai/hooks/hooks.yaml` — team hooks
   - `.teamai/mcp/mcp.yaml` — shared MCP servers

> **Heads-up on `env`.** In single-repo mode `.teamai/env/env.yaml` **is committed to main** (unlike standalone mode's per-machine env), so it travels to everyone who clones the repo. `env.yaml` stores plaintext key/value pairs — put only non-secret shared config there, and keep real secrets in your own untracked environment.

> **Limitation.** Single-repo mode ties one team setup to one business repo. If you need to share one team knowledge base across many business repos, use a standalone team repo (`teamai init <repo>`) instead.

### Layer an organization repo under a project repo

Use two Team Repos when some knowledge is organization-wide and other resources are project-specific. The CLI is installed only once, but each scope has its own local config and repository clone:

```bash
# Once per developer: organization-wide skills, rules, docs, agents, and learnings
teamai init https://github.com/yourorg/engineering-practices --scope user

# In a Java project: project resources stay active and recall prefers them
cd /path/to/java-service
teamai init https://github.com/yourorg/java-service-teamai --inherit-user-scope
```

With inheritance enabled, `teamai pull` refreshes user `skills`, `rules`, `docs`, `agents`, shared instructions/culture, and the user search index in their home-level locations, then refreshes the project scope in the project directory. User `env`, hooks, MCP definitions, cross-team sources, usage reporting, and remote repository writes are not inherited. The two configs and repositories remain separate; this feature composes their safe read paths rather than merging Git repositories or files. Installed resources with the same name remain in separate user/project paths, so the AI tool decides runtime precedence; Recall separately guarantees that a project entry shadows the same user resource type and filename.

---

## Member Onboarding

Once the admin shares the team repo URL with members (or forwards the [member prompt](prompts/member.md) with that URL filled in):

**Project-scoped teams (default):**

```bash
npm install -g teamai-cli
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# Done! AI tools now automatically have access to team resources
```

**User-scoped teams:**

```bash
npm install -g teamai-cli
teamai init https://github.com/yourorg/yourrepo --scope user
```

**HTTP mode (read-only consumer):**

For users or agents that don't need git access and only consume skills/rules:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- Read-only mode: `push` / `contribute` / `remove` are not available.
- No git clone required — skills/rules are delivered via a report/sync/ack lifecycle on a per-session basis.
- Supported agents automatically report their installed skill state at session start, and pull install/update/uninstall commands managed by the server.
- The API key is stored with `0600` permissions, or can be passed via the `TEAMAI_API_TOKEN` environment variable.

**Verify:**

```bash
teamai status                       # View status
teamai members                      # View team members
teamai list                         # All resource types (skills|rules|docs|env|agents|hooks|mcp) + local skills
teamai list mcp                     # Only team MCP servers
teamai list --source repo           # Team repo only
teamai list --source local          # Skills under each installed agent
teamai list --agent claude --verbose
teamai list env --reveal            # Show env values in plaintext (default: masked)

teamai skill                        # Equivalent to teamai list skills --source all
teamai skill show hai-deploy-test   # View a single skill's source / contributor / install locations / description summary
```

---

## Day-to-Day Use

### Auto-sync

`teamai init` already injected Hooks into your AI tools. **`teamai pull` runs automatically every time you start an AI session** — no manual action needed. In project scope, that SessionStart hook first creates the current agent's project root (e.g. `<project>/.claude` when Claude Code opens the repo) if it is missing, then pulls.

*(Note: Automatic sync on session start requires an agent that supports lifecycle hooks, such as Claude Code, Codex, Cursor, CodeBuddy, WorkBuddy, Qoder, OpenCode, Hermes, or OpenClaw. For tools without hooks support such as JoyCode or Gemini CLI, session start hooks do not fire, so you should run `teamai pull` manually to keep resources up to date.)*

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

> Project scope is isolated by default. When the current working directory contains a project-scope `.teamai/config.yaml`, `pull` processes that project and skips user scope unless the local config has `inheritUserScope: true`; in that case it first refreshes the safe user-resource channel. Without a project config in the current directory, `pull` processes user scope. User `env`, MCP definitions, sources, reporting, and writes remain isolated in project mode. Hooks are the one exception: a project scope's hooks are injected into your **HOME** tool settings (`~/.claude/settings.json`, …), not `<projectRoot>`, because the built-in hooks gate on the `cwd` handed to `hook-dispatch` and `~/.claude` always exists so the "installed tool" gate passes (see the Hooks section). Self single-repo mode keeps its hooks in the business repo so they travel on clone.

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/` and `docs/` keep their original sync behavior. `learnings/` at the root is shared with everyone, while `learnings/<project-id>/` subdirectories sync only for the directory's active projects (see [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role)).

### Team packages

`teamai packages` lets a team declare and restore npm packages and Claude Code plugins through the existing team repository. TeamAI invokes the native `npm` and `claude plugin` CLIs; it does not distribute package contents itself.

**Admin operations:**

Passing a target installs it and adds its declaration to the team repo's `teamai.yaml`:

```bash
# npm package (project dependency by default)
teamai packages install typescript

# Unscoped name@version is ambiguous with plugin@marketplace; identify npm explicitly
teamai packages install typescript@5.9.2 --npm

# Global npm CLI from a specific registry
teamai packages install eslint@latest --global \
  --registry https://registry.npmjs.org/

# Claude plugin
teamai packages install code-review@claude-plugins-official

# Share the updated teamai.yaml through the normal review flow
teamai push
```

An npm target accepts `name` or `name@version`. Because an unscoped `name@value` can also mean `plugin@marketplace`, use `--npm` when the suffix is not a declared or registered Claude marketplace. Scoped npm names (`@scope/name`), bare names, `--global`, and `--registry` already identify npm unambiguously and do not probe the Claude CLI. Local npm packages require a `package.json` in the current directory; use `--global` for machine-wide CLI tools. `--registry` is saved with that package declaration and must be an HTTP(S) URL without embedded credentials. Keep registry authentication in npm configuration or environment variables.

A Claude plugin target uses `plugin@marketplace`. The official `claude-plugins-official` marketplace is resolved automatically; another marketplace must already be registered with Claude Code so TeamAI can record its source. Use `--claude` to make the intended ecosystem explicit and get a marketplace-specific error when it is unavailable. Ambiguous targets fail without running either package manager. `--global` and `--registry` apply only to npm targets.

**Member operations:**

The existing SessionStart hook runs `teamai pull`. When the `packages` declaration changes, it asks the member to review `teamai.yaml` and install explicitly; it never runs third-party package or plugin code automatically. Pull remains detached so network latency cannot block the IDE. If a declaration arrives after the SessionStart output window, TeamAI safely queues the same notice for the next UserPromptSubmit in that session.

```bash
teamai packages             # Install every team declaration
teamai packages --dry-run   # Preview native commands without installing or writing files
teamai doctor              # Check runtimes and declared package/marketplace/plugin status
```

After a successful install, TeamAI writes a local snapshot to `teamai.lock` under the active scope's `.teamai` directory. The lock records installed versions and the declaration hash used by the SessionStart hint; it is not stored in the team repository. In user scope, machine-wide npm tools and Claude plugins are acknowledged once, while project npm dependencies are acknowledged separately for each working directory so installing in one repository cannot silence another repository's hint.

**Declaration format:**

`teamai packages install <target>` manages this section automatically:

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
    - name: eslint
      version: latest
      global: true
      registry: https://registry.npmjs.org/
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

- `npm[].version` defaults to `*`; `global` defaults to `false`.
- `claude.marketplaces` maps marketplace names to their repositories.
- Each Claude plugin must use `plugin@marketplace`, and that marketplace must be declared.
- Unknown or misspelled keys inside `packages` are rejected before install or push.
- Package declarations apply to the whole team; role and project filters do not change the package set.

### Excluding skills you don't need

If a skill shared by the team doesn't suit you, you can exclude it locally only — no need to modify the team repo, and it won't affect other members:

```bash
teamai skill exclude add using-superpowers
teamai pull                    # Remove it from local AI tools
teamai skill exclude list

teamai skill exclude remove using-superpowers
teamai pull                    # Re-sync
```

The exclusion list is stored in the `config.yaml` of the current user or project scope:

```yaml
excludedSkills:
  - using-superpowers
```

Exclusion rules take effect after role and tag filtering. When running `teamai pull`, excluded skills are not synced, and any copies previously installed by `pull` are cleaned up.

### Push local resources

```bash
teamai push          # Scan for new/modified resources, create an MR
teamai push --all    # Skip confirmation, push directly
teamai push --role pm  # Push this skill to skills/pm/<skill-name>/
```

**Namespace selection (new skills):** When pushing a new skill, the CLI automatically detects available namespaces and offers an interactive choice:

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- If `primaryRole` is set, the list of available namespaces is expanded from the manifest
- If `primaryRole` is not set, the team repo's directory structure is scanned automatically
- A single namespace is auto-selected; use `--role <id>` to choose one explicitly
- Modifying an existing skill automatically keeps its original namespace

**Updating an open PR instead of duplicating it:** If a resource is already waiting in an unmerged PR, re-running `teamai push` on it updates that existing PR in place (by force-pushing its branch) rather than opening a duplicate. Keep the resource selected to update its PR; deselect it to leave the PR untouched. Unrelated resources selected in the same run go into their own new PR. Once the PR merges (or its branch is removed from the remote), the record is cleared and the next push opens a fresh PR as usual.

**Automatic YAML frontmatter completion:** When pushing, the CLI automatically checks valid mapping-style `SKILL.md` frontmatter and fills in `name`/`description` if missing. Malformed or scalar frontmatter is left unchanged with a warning and must be fixed manually.

### Check status

```bash
teamai status        # Current scope, last sync time, resource stats
teamai status --all  # List every project data partition under ~/.teamai/projects
```

Under `Team resources`, `skills` counts the team repo entries shown by
`teamai list skills --source repo`: both flat skills (`skills/<name>/SKILL.md`)
and skills inside namespaces (`skills/<namespace>/<name>/SKILL.md`). Namespace
directories and modules bundled inside a skill are not counted separately. For
example, six skills under `skills/ai/` plus `skills/officecli/` count as seven.

`docs` counts files recursively under `docs/`, excluding hidden files and hidden
directories. Documents stored only in subdirectories are also discovered and
synced by `pull`. Learnings are not included in this resource summary; they are
shared at the root or selected by active projects, not by roles.

`--all` enumerates every project's machine-data partition and flags each as
**active** (project still on disk), **ORPHAN** (project moved/deleted — its
partition is safe to `rm -rf`), or **unknown** (no `anchor` file, so it cannot be
confirmed orphaned — never recommended for deletion). The ORPHAN verdict rests
only on the anchor, so a partition is never flagged for deletion on a hunch. teamai
never garbage-collects orphans automatically, so this is how you find partitions to
delete by hand.

### Role management

Roles control which skills each member sees. Admins define roles via `manifest/roles.yaml`; once a member selects their role, `pull` syncs skills from the matching namespace. Active tag subscriptions may additionally sync explicitly matching skills from other namespaces, but untagged skills in inactive namespaces are not included.

**Admin operations:**

```bash
# Initialize (interactively create the manifest)
teamai roles init

# Add a role
teamai roles add devops --namespaces common,infra -d "Infrastructure team"

# Update a role (add/remove namespaces, change description)
teamai roles update hai --add-namespaces infra
teamai roles update hai --remove-namespaces legacy -d "New description"

# Remove a role
teamai roles remove devops

# Preview changes
teamai roles add test --namespaces common,test --dry-run
```

The commands above automatically push a branch and create an MR; the change takes effect team-wide once merged.

**Member operations:**

```bash
# View available roles
teamai roles list

# Choose your own role
teamai roles set hai
teamai roles set hai --add pm    # Primary role hai + additional role pm

# Sync resources for the new role
teamai pull
```

> **Safe degradation:** If an admin removes a role that a member is still configured with, `pull` won't error out — it falls back to a full sync and prints a warning prompting the member to choose a new role.

### Tag subscriptions

Tags let members subscribe to selected skills and rules outside their role's default namespaces.

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
```

Admins can manage resource tags with `teamai tags add` and `teamai tags remove`. Run `teamai pull` after changing your subscriptions.

---

## Sharing Team Resources

This is Team Execution: define skills, rules, and other harness once, review via MR, then `teamai pull` delivers them to every agent.

### Skills

```bash
# Create a skill
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
# Deploy Helper
When the user requests a deployment, follow these steps:
1. Check that the current branch is master
2. Run tests `npm test`
3. Build `npm run build`
4. Deploy `./deploy.sh`
EOF

# Push to the team (YAML frontmatter is auto-completed)
teamai push

# Push to a specific role namespace
teamai push --role pm
```

> **Frontmatter auto-completion:** When pushing, the CLI checks the `SKILL.md` YAML frontmatter (`name`/`description`) and, if missing, derives and fills it in automatically from the directory name and content. You can also add more precise frontmatter yourself:
>
> ```yaml
> ---
> name: my-deploy-helper
> description: Automated skill for helping the team deploy services
> tags: [deploy, automation]
> ---
> ```
>
> Malformed YAML or a non-mapping frontmatter root is preserved unchanged and reported as a warning; fix it manually before pushing again.

With role-based skills enabled, the push target directory becomes:

- Default: `skills/<primaryRole>/<skill-name>/`
- Explicit override: `skills/<role>/<skill-name>/` (via `--role`)

### Rules

```bash
# Create a rule
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# Code Review Guidelines
- All functions must have JSDoc comments
- `any` type is not allowed
- Test coverage must be at least 80%
EOF

# Push
teamai push
```

> Admins can set enforced rules in `teamai.yaml` (`sharing.rules.enforced`), which members cannot delete.

### Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env list
teamai push
```

### Docs

Place documentation in the team repo's `docs/` directory; after pushing, team members will automatically receive it on their next `pull`.

### MCP servers

Declare each server once in the team repo's `mcp/mcp.yaml`. On `teamai pull` it is written into every installed tool's own MCP config, translated into that tool's native format.

```yaml
servers:
  - name: gpu-analysis
    description: GPU inventory and pricing queries
    transport: http                      # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    env:
      FORMATTER_MODE: strict
    requires: [npx]                      # skipped with a hint when npx is absent
    tools: [claude, cursor]              # optional; default is every capable tool
```

Where each tool's servers land:

| Tool | User scope | Project scope |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json` |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/mcp.json` | `<project>/.mcp.json` |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| codex | `~/.codex/config.toml` | not supported |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |


CodeBuddy Code's [MCP documentation](https://www.codebuddy.ai/docs/cli/mcp)
lists the project root's `.mcp.json` as its preferred project configuration.
This is separate from TeamAI's user-scope `~/.codebuddy/mcp.json` target.
Explicit `toolPaths.codebuddy.mcpProject` values in `teamai.yaml` still take
precedence. For an existing team that pins run
`teamai mcp remove` in the affected workspace before changing that value to
`.mcp.json`, then run `teamai mcp inject`. Review and preserve any personal
servers in either file; TeamAI does not migrate or delete the old file.
Claude Code also reads the root `.mcp.json`, so this file is shared by both tools.

Codex supports `stdio` and `http`; `sse` is skipped. Qoder supports the Claude-compatible `mcpServers` format in its scope-specific `.qoder/settings.json`. OpenCode supports `stdio` (written as its `type:"local"` shape) and `http` (`type:"remote"`); `sse` is skipped, and its servers live under the `mcp` key of the shared `opencode.json`. Ownership is tracked in `~/.teamai/managed-mcp.json` — hand-added servers are left alone; name collisions skip unless `--force`.

**Secrets.** Write `${VAR}`, never a literal, in `mcp.yaml`. Values resolve from the environment, then from `env/env.yaml` → `~/.teamai/env`. Unresolved variables skip the server with a hint.

teamai **resolves every `${VAR}` to its value and writes it verbatim** into each tool's config (new files are created `0600`). It does not rely on any tool's own env-var expansion: that expansion is fragile — most decisively, IDEs launched from the GUI (Dock/Launchpad) never inherit your shell's exported variables, so a `${VAR}` placeholder expands to empty and the server 401s. Resolving to plaintext makes the token present no matter how the tool is started.

> ⚠️ **The resolved token lands on disk.** Project-scope MCP configs (`.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`) then contain the literal secret — add them to `.gitignore` and never commit them.

Claude Code may show project `.mcp.json` servers as pending approval until you accept them once in an interactive session.

```bash
teamai mcp list              # servers, secret status, and where they are installed
teamai mcp inject            # apply now; --dry-run to preview, --force to override collisions
teamai mcp remove            # remove every teamai-managed server
```


---

## Knowledge Capture & Retrieval

This is Team Context plus the start of Team Improvement: capture what a session actually learned, then let the next agent find it.

### Contributing knowledge

The AI tracks your coding sessions via Hooks. When a session ends (the Stop hook), the system scores it by **friction** — whether you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (many tool calls, no friction) won't trigger; only a session where you actually hit a problem does. If it qualifies, the AI automatically reminds you:

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

The reminder lists the non-zero friction signals that triggered it. When the first task is available, it also includes a redacted, single-line task summary so you can decide whether the session is worth sharing. Using the built-in `/teamai-share-learnings` skill, the AI will automatically summarize the session's learnings and contribute them to the team knowledge base. Each session is prompted at most once.

For Codex, the Stop hook saves contribution and knowledge-reference reminders for the next UserPromptSubmit in the same session. It does not force an extra agent turn. Contribution reminders are delivered once and discarded if you contribute before the next prompt.

You can also specify a file manually:

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
```

#### Turning the hint off

Teams that route knowledge sharing through their own review flow (for example, a personal retrospective that opens ordinary PRs) can switch the hint off without touching the rest of the Stop hook — update checks, votes sync, and dashboard reporting keep running. Same two-tier pattern as recall:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.contributeHint.enabled` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `contributeHintEnabled` | `true` / `false`, takes priority over the team default |
| Environment variable | shell | `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` | Force-disables the hint (emergency kill switch) |

Only the nudge is affected: friction scoring, `teamai contribute --file`, and `/teamai-share-learnings` keep working when invoked manually.

### Searching knowledge

```bash
teamai recall "API timeout"
teamai recall "GPU out of memory"
```

- Supports mixed-language search
- Searches the project scope when the current working directory contains its config; with `inheritUserScope: true`, searches project first and user second, labeling results `[project]`/`[user]`. Otherwise searches user scope
- For the same resource type and filename, the project entry wins; different resource types with the same filename remain separate
- Consulted active-scope knowledge is automatically upvoted. Inherited user hits remain read-only while the project is active
- A lightweight relevance precheck is available via `teamai recall --check "<keywords>"`, which prints `RELEVANT score=<n> threshold=<n>` or `NOT_RELEVANT score=<n> threshold=<n>` without reading files or upvoting — the recall subagent uses it to skip retrieval on unrelated tasks. For a `RELEVANT` top hit it also reports `matched=`/`missing=` — the query terms that hit its title/tags and those that did not
- `RELEVANT` means a hit cleared the score threshold, i.e. reading files is worth the cost — it does not mean the knowledge base covers your subject. Use the `matched=`/`missing=` terms (and the `Matched:`/`Missing:` lines on full results) to make that judgement: a hit missing all your distinctive terms is topically adjacent, not an answer

### Enabling / Disabling Recall

The Recall feature is controlled by a two-tier configuration — admins set the team default, and members can override it locally:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.recall.enabled` | `true` / `false` (default `false`) |
| User override | `~/.teamai/config.yaml` | `recallEnabled` | `true` / `false`, takes priority over the team default |
| Environment variable | shell | `TEAMAI_RECALL_DISABLED=1` | Force-disables all recall hooks (emergency kill switch) |

```bash
teamai recall enable     # Enable recall, deploy the subagent and rules
teamai recall disable    # Disable recall, remove the subagent and rules
teamai recall status     # View the current effective status (team default + user override)
```

When disabled, `teamai pull` skips deploying the recall subagent, the recall rules injection block, and the TodoWrite reminder hook. Manually running `teamai recall <query>` to search is not affected by this switch.

### Knowledge Base Maintenance

Over time, some learnings accumulate low confidence scores (nobody upvoted them) or become stale. `teamai recall maintenance` keeps the knowledge base healthy:

| Flag | Description |
|------|-------------|
| `--prune` | Find learnings below the confidence threshold and remove them |
| `--threshold <n>` | Confidence threshold for pruning (default: `0.15`) |
| `--archive` | Move pruned entries to `archive/` instead of deleting permanently |
| `--confidence-writeback` | Recompute confidence scores from vote history and write them back to frontmatter |
| `--update-quality` | Identify high-recall but low-approval docs/rules/skills and generate AI-powered update drafts (`.draft.md` files) |
| `--dry-run` | Preview what would be done without making any changes |

```bash
# Preview stale entries without changing anything
teamai recall maintenance --prune --dry-run

# Archive low-confidence learnings (confidence < 0.15)
teamai recall maintenance --prune --archive

# Rewrite confidence scores to frontmatter based on current votes
teamai recall maintenance --confidence-writeback

# Find stale entries and generate update drafts
teamai recall maintenance --update-quality
```

After `--update-quality`, review the generated `.draft.md` files and rename them to `.md` to apply the updates.

### Promoting Learnings

When a learning reaches maturity, promote it to formal team knowledge (a skill, rule, or doc). Promotion criteria: confidence ≥ 0.90, ≥ 5 upvotes, ≥ 2 distinct contributors, age ≥ 14 days.

```bash
# List all promotion candidates
teamai recall promote

# Promote a specific learning (AI rewrites it into the target format)
teamai recall promote <learningId>

# Promote to a specific category
teamai recall promote <learningId> --category skills

# Preview what would happen without writing files
teamai recall promote <learningId> --dry-run
```

Options:

| Option | Description |
|--------|-------------|
| `--category <cat>` | Target category: `skills` \| `rules` \| `docs` |
| `--dry-run` | Show what would be done without making changes |

---

## Knowledge Base Health Report

The dashboard includes a built-in **KB Health** report page showing your team knowledge base's usage and health, covering everything captured by `teamai recall` votes, learnings, docs, rules, and skills.

```bash
# Start the dashboard, then click "KB Health" in the header
teamai dashboard

# The report is served directly at:
#   http://localhost:3721/kb-report
```

The report aggregates your local `~/.teamai` knowledge base (or the configured team repo) and renders on demand — no flags to pass.

### What the Report Shows

| Section | Description |
|---------|-------------|
| **Overview cards** | Total entries, total recalls, overall coverage %, contributors |
| **Coverage by type** | Breakdown of recall coverage across skills, rules, docs, learnings |
| **Top recalled** | Ranked list of most frequently recalled entries |
| **Silent entries** | Entries that have never been recalled — candidates for pruning or rewriting |
| **Recall trend** | Recall activity over time |
| **Author contributions** | Per-contributor entry counts and recall share |
| **Maintenance console** | Three action zones: entries ready to promote, entries suggested for archiving, and stale entries needing updates — each with a copyable command |

### Typical Workflow

```
Open the dashboard → KB Health page
   ↓
Review the Maintenance Console
   ↓
Promote mature learnings:
   teamai recall promote <learningId>
   ↓
Archive low-value entries:
   teamai recall maintenance --prune --archive
   ↓
Update stale docs/rules/skills:
   teamai recall maintenance --update-quality
   (review .draft.md → rename to .md)
   ↓
teamai push   # share the cleaned-up knowledge base with the team
```

---

## Commit Co-Author Attribution

AI coding tools stamp a `Co-Authored-By:` / attribution trailer on the commits they make. Teams that prefer a clean history can turn this off for everyone; individual members can still override it on their own machine. `teamai pull` applies the resolved intent to each installed tool's own config file.

The feature is controlled by the same two-tier pattern as recall:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.coAuthor.enabled` | `true` = keep the trailer / `false` = strip it. Omit the block entirely for "no opinion" (teamai touches nothing) |
| User override | `~/.teamai/config.yaml` | `coAuthorEnabled` | `true` / `false`, takes priority over the team default |

Per tool family, the trailer maps to a different setting:

| Tool family | File | Setting written | Scope | Reliability |
|------|------|------|------|------|
| Claude (`claude`, `codebuddy`, `workbuddy`) | `settings.json` | `attribution.commit` / `attribution.pr` set to `""` | user **or** project (follows the active scope) | Deterministic |
| Codex (`codex`) | `~/.codex/config.toml` | `commit_attribution = ""` | user only | Best-effort — only takes effect when `[features].codex_git_commit = true`, which teamai does not force |
| Cursor | `~/.cursor/cli-config.json` | `attribution.attributeCommitsToAgent = false` | user only | Best-effort — a [known upstream bug](https://forum.cursor.com/t/local-executor-ignores-cli-config-attribution-opt-out-forcing-co-authored-by-trailer/167722) can cause the local executor to ignore this |

Semantics:

- **Write-only, never delete.** Once teamai has written a value, dropping the team policy later leaves that value untouched — teamai never restores a trailer it stripped. To re-enable, set the intent back to `true` explicitly (which removes teamai's override so the tool's own default returns).
- **Idempotent.** teamai records what it last wrote per file (in `state.json` under `coAuthorManaged`) and skips a write when nothing would change.
- **Only installed tools are touched**, and existing keys/comments in each config file are preserved (key-level surgery, not regenerate-from-scratch).

Restart your AI tool session after a `pull` for the change to take effect.

---

## Team Culture

TeamAI supports injecting your team's culture into AI tools, so your AI coding assistant is aware of your team's culture, values, and coding standards in every session.

### Creating culture.md

The admin creates a `culture.md` file at the root of the team repo:

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  vision: A world where AI helps everyone
  values:
    - Innovation
    - Integrity
    - User First
team:
  name: Platform Team
  mission: Enable developers to ship faster
  goals:
    - Ship v2.0 by Q2
    - Improve test coverage to 90%
---

## Coding Standards

- All PRs must have at least one reviewer approval
- Direct pushes to master are prohibited
- Test coverage must be at least 80%

## Collaboration Norms

- Use conventional commits format
- PR descriptions must include ## Summary and ## Test Plan
- Major changes require a design doc first
```

### Frontmatter fields

| Field | Type | Description |
|------|------|------|
| `company.name` | string (required) | Company name |
| `company.mission` | string | Company mission |
| `company.vision` | string | Company vision |
| `company.values` | string[] | Company core values |
| `team.name` | string (required) | Team name |
| `team.mission` | string | Team mission |
| `team.goals` | string[] | Team goals |

The markdown body after the frontmatter becomes the body content of the team culture guidance, injected as a whole into `CLAUDE.md`.

### How it works

```
Team repo
├── culture.md          ← Maintained by admin
├── skills/
├── rules/
└── ...

teamai pull
    │
    ▼  Parse culture.md
    │  ├─ frontmatter → structured company/team info
    │  └─ body → team culture guidance body
    │
    ▼  Compile into a CLAUDE.md injection block
    │
    ▼  Inject into each AI tool's CLAUDE.md
       ├─ ~/.claude/CLAUDE.md
       ├─ ~/.cursor/CLAUDE.md
       └─ ...
```

The injected content sits between the `<!-- [teamai:culture:start] -->` and `<!-- [teamai:culture:end] -->` markers, is automatically updated on every `pull`, and does not affect any other content in the file.

### Viewing the result

After pulling, you can view the AI tool's CLAUDE.md directly:

```bash
teamai pull
cat ~/.claude/CLAUDE.md
```

You'll see an injection block like this:

```markdown
<!-- [teamai:culture:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Culture (teamai)

## Company: Acme Corp
**Mission:** Build great things
**Vision:** A world where AI helps everyone
**Values:** Innovation, Integrity, User First

## Team: Platform Team
**Mission:** Enable developers to ship faster
**Goals:**
- Ship v2.0 by Q2
- Improve test coverage to 90%

## Coding Standards
- All PRs must have at least one reviewer approval
...
<!-- [teamai:culture:end] -->
```

---

## Advanced Features

### HTTP Contract (for backend implementers)

When using `teamai init --http <baseUrl>`, the endpoint must implement the following APIs (authenticated via `Authorization: Bearer <api-key>`):

| Endpoint | Method | Purpose |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | Session start: upsert agent + installed skills |
| `{baseUrl}/api/local-agent/sync` | POST | Report status + return pending skill commands |
| `{baseUrl}/api/local-agent/commands/ack` | POST | Acknowledge a single command (`{ id, status, error }`) |

`POST /api/local-agent/sync` returns pending commands:

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

The backend may push an **`apply_model_config`** task whose `cmd` is JSON. Both
the documented candidate-set shape and the legacy single-model shape are accepted.
`{"models":[...]}` is a full snapshot; a direct model object is an incremental upsert.
`max_tokens` is optional (CodeBuddy / WorkBuddy `maxOutputTokens`); omitted or `0` defaults to `4096`. Claude does not use it.

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

The candidate set is applied only to the agent that reported the task. CodeBuddy uses
user-level `~/.codebuddy/models.json` (`{ "models": [...] }`). WorkBuddy uses
`~/.workbuddy/models.json`; both the current `{ "models": [...] }` shape and the legacy
top-level array are accepted, and an existing file keeps its shape. A workspace-scoped
CodeBuddy or WorkBuddy task uses `<workspace>/.codebuddy/models.json`, matching the
embedded model loader; that credential-bearing file is added to
`<workspace>/.codebuddy/.gitignore`. Workspace delivery is accepted only for a path
already present in the reporter's workspace bindings. User-owned entries with the same
model ID are preserved. Claude
gets an explicit profile at `~/.claude/teamai-models.json`
and also receives the gateway environment in `~/.claude/settings.json` when it has no
conflicting user-owned Anthropic gateway configuration. The conflict check inspects
both `settings.json` `env` and the process's shell environment (`export ANTHROPIC_*`),
so a user who runs Claude via shell env keeps their own gateway — TeamAI skips the write
and logs the skipped keys to `~/.teamai/reporter/errors.jsonl`. Protected keys are
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}`, and
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. A shell value that matches what TeamAI
last wrote (Claude re-injects `settings.json` `env` into the hook process) is recognized
as managed, not a user conflict, so a managed gateway can still be updated or removed on
later syncs. Unsupported agents acknowledge
the task as failed instead of writing another agent's config. Symlinked user config
files remain symlinks. These files are mode `0600`. A successful write is acknowledged with
`type: "apply_model_config"`; malformed payloads are acknowledged as `failed`. Unknown
future task types are silently skipped for protocol compatibility.

The reverse direction is reported through the existing `report` call: models that
TeamAI recorded in its model manifest and can still identify by model ID and provider
on disk are sent as `user_level.models` or, for workspace-scoped deliveries, the
matching `workspaces[].models`. Normal agent-added metadata does not suppress
the report. A successful apply triggers this report immediately in the same sync run.
User-owned models are omitted because the backend cannot resolve them. The server
requires both `provider` and `model_id`. Like skills and rules, the field is omitted
entirely when nothing qualifies, because a present array is treated as a full
snapshot. CodeBuddy, WorkBuddy, and Claude (the `ANTHROPIC_CUSTOM_MODEL_OPTION`
gateway in `~/.claude/settings.json`) expose a discoverable model config; other tools
report nothing. Reported entries always use `source: "enterprise"`. **`api_key` is
never reported back** — the ProxyToken stays on disk.

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

The HTTP contract is intended for custom integrations. End users only need the `teamai init --http` command described in [Member Onboarding](#member-onboarding).

### Codebase Knowledge Graph

`teamai import` parses a source code repo into a structured knowledge graph (stored under the team repo's `teamwiki/` directory), enabling structure-aware knowledge retrieval:

```bash
# Extract from a local directory
teamai import --dir /path/to/project

# Import from a remote repo
teamai import --from-repo https://github.com/org/repo

# Bulk-import all repos under an organization
teamai import --from-org myorg

# Bulk-import from an allowlist
teamai import --from-repo-list repos.yaml

# Extract learnings from a merged MR/PR
teamai import --from-mr https://github.com/org/repo/pull/123

# Incremental mode (skip unchanged files)
teamai import --from-repo https://github.com/org/repo --incremental

# Extract structure only, skip AI enrichment
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

AI-backed steps (`--deep-enrich`, knowledge enrichment) shell out to an AI coding CLI already installed on the machine instead of calling a model API directly. teamai probes `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` and uses the first one it finds. On macOS and Linux the probe runs through a login shell, so a CLI installed under `~/.nvm/` is found too. On Windows it uses the native `where`, which returns the npm shim (`%APPDATA%\npm\claude.cmd`) that Windows can actually launch — a Git Bash or WSL `bash` only reports MSYS paths such as `/c/Users/...`, which Windows cannot start.

For GitLab behind an API gateway, set `GITLAB_URL` and `GITLAB_API_PREFIX=api/gitlab` before running `teamai import --from-org https://gitlab.example.com/myorg`. Organization listing uses the configured prefix on every page; an unset or blank prefix defaults to `api/v4`.

The graph stores components, interfaces, configs, and cross-repo dependencies. `teamai recall` uses the graph for BM25 + graph-boosted ranking.

Dependency edges are extracted by two parallel tracks: a WASM tree-sitter **AST track** (TypeScript/JavaScript, Python, Go) that resolves imports, calls, and TS `implements` clauses to precise file-to-file edges (`code-ast`), and a regex **heuristic track** (all languages, `code-heuristic`) that also covers languages the AST track does not. AST results win on overlap. The AST parser needs no native toolchain; on load failure, extraction falls back to heuristics and records an `AST_UNAVAILABLE` gap. Set `TEAMAI_SKIP_AST=1` to force heuristic-only extraction.

```bash
# Extract code facts and the graph from a local repo (writes <repo>/teamwiki/)
teamai codebase --extract /path/to/repo --project my-service

# Incremental refresh: reuse the original repository path and project slug
teamai codebase --extract /path/to/repo --project my-service --incremental

# Generate deep knowledge docs from extracted evidence (--output is the repository root)
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# Reconcile teamwiki/product and teamwiki/docs with extracted code pages
teamai codebase --reconcile --output /path/to/repo

# Check the local graph; --output is the repository root, not teamwiki/
teamai codebase --lint --output /path/to/repo
```

### Dashboard

```bash
teamai dashboard             # Start the web dashboard (default port 3721)
teamai dashboard --port 8080
```

View team members' AI coding session status in real time.

#### Human Intervention Metrics

Each session card shows a `⚠ N` badge, counting the **number of human interventions** in that conversation — fewer interventions means the agent is better at getting things right on the first try. Hover to see a breakdown; each of the three signal types counts once:

| Type | Meaning | Data source |
|------|------|----------|
| `interrupt` | User pressed ESC to interrupt the agent mid-execution | An interrupted turn in the transcript |
| `toolReject` | User rejected a tool call (permission deny) | A tool_result marked as rejected in the transcript |
| `correction` | Within 60s after the agent stops, the user submits a follow-up prompt containing a correction keyword ("not right" / "redo" / "wrong" / 「違う」 / 「やり直し」 / etc. — Chinese, English and Japanese) | The stop → prompt_submit event pattern |

> Privacy: only counts are tracked — no prompt or transcript text is ever stored.

Intervention data is automatically aggregated and reported to the team's `stats/<user>.yaml` during `teamai pull`, and shown in the "Session Autonomy" leaderboard of `teamai digest`, with team averages and per-person intervention rate rankings — useful for verifying whether a skill/rule reduces intervention rates after rollout. Tools without a transcript (e.g. Cursor) degrade gracefully, tracking only `correction`.

#### Conversation Volume & Token Usage

Each session card also shows two badges:

| Badge | Meaning | Data source |
|------|------|----------|
| `💬 N` | The **number of human conversation turns** in the session (how many prompts were sent) | Count of `UserPromptSubmit` events |
| `⛁ X` | The session's cumulative **token usage** (hover to see input / output / cache read / cache write breakdown) | Claude Code `message.usage`, CodeBuddy `requests[].usage`, or Codex's latest session-level `token_usage_record`; legacy `event_msg.token_count` snapshots are summed once per rollout file |

> Privacy: only turn counts and token counts are tracked — no prompt or transcript text is ever stored.

These two metrics are likewise aggregated into `stats/<user>.yaml` (as `prompts` and `tokens` fields) during `teamai pull`, and shown in the "Conversation Volume & Token Usage" section of `teamai digest`, with team-wide totals, bucketed token totals, and per-person token usage rankings. Tools without transcript access (e.g. Cursor) degrade gracefully: turn counts are still tracked, while tokens show as 0 / N/A.

#### Daily Session Trends & Estimated Cost

The dashboard and digest compare the latest seven UTC calendar days with the seven days before them. A session belongs to the day of its first stop event, while each priced request belongs to its own UTC request day. Active time counts only adjacent event gaps of five minutes or less, so idle terminals do not inflate the result. A session succeeds when it ends without an error, interruption, or correction; rejected tool calls remain a separate intervention signal. Privacy-safe request details (model, token counts, estimated cost, and price-table version; no prompt or response content) stay in `~/.teamai/dashboard/requests.jsonl`, are deduplicated across repeated Stop hooks, and are removed after 90 days.

Cost is an API-equivalent estimate for recognized Claude model IDs, based on versioned public list prices and the input, output, cache-read, and cache-creation token buckets in the transcript. Cache creation uses the five-minute write rate because transcripts do not expose cache TTL. Unknown models and tools without usage details are excluded from both estimated cost and its coverage denominator. This estimate is useful for trends, but it is not an invoice or a subscription-seat charge.

Daily aggregates are added to `stats/<user>.yaml` during `teamai pull`; existing cumulative fields remain available as lifetime statistics. Resumed sessions are updated in place without double-counting completed sessions. Only aggregate counts and estimated micro-dollar totals are shared with the team repository; prompt text and per-request records stay local.

### Session Save

`teamai session save` folds the dashboard's existing per-session event stream (tool sequence, prompt turns, interventions) into a compact, privacy-scrubbed markdown summary — no LLM call, no new collection path.

```bash
teamai session save                    # record the most-recent session locally
teamai session save --session-id <id>  # record a specific session
teamai session save --push             # also push a "valuable" session to the team repo
teamai session save --push --force     # push even a trivial session
teamai session save --push --include-prompt  # also include the (redacted) first-ask line
```

**Local (always):** appends to `~/.teamai/session-logs/<year-month>.md`. Idempotent per session (a session already recorded that month is skipped), and logs older than 90 days are pruned automatically.

**Team (`--push`, opt-in):** commits the summary directly (no PR) to `sessions/<user>/<year-month>.md` in the team repo — the exact path `teamai digest` reads, so the session shows up under **Session Highlights**. Only a **valuable** session is pushed by default: one that shows friction (an interrupt / tool-reject / correction) or substantial tool use (≥ 3 distinct tools). Trivial sessions stay local unless you pass `--force`. On a read-only (HTTP-mode) team, `--push` fails gracefully and the local log is still kept.

> Privacy: the team-pushed payload is **counts + tool names only** by default. The first-ask prompt line is opt-in via `--include-prompt`, and even then it is run through the same secret redaction (`ghp_…` → `<REDACTED:…>`) used elsewhere. Local logs keep the redacted first-ask line since they never leave your machine.

### Hooks

Hooks automatically injected by `teamai init`:

| Hook Event | Action |
|-----------|------|
| `SessionStart` | Seed the current agent's project root (project scope), then auto pull + report session start |
| `PostToolUse` | Skill tracking + knowledge contribution detection + dashboard reporting |
| `UserPromptSubmit` | Slash command tracking |
| `Stop` | CLI update check + report session end |

```bash
teamai hooks list      # Show effective built-in and team hooks
teamai hooks inject    # Re-inject
teamai hooks remove    # Remove
```

The inject and remove commands only touch tools you actually have installed (i.e. whose `~/.<tool>/` root directory already exists). They never create root directories for tools listed in `toolPaths` but not installed.

> **Codex trust gate** — Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) gates non-managed hooks behind an explicit user trust step. After teamai writes `~/.codex/hooks.json`, Codex may skip a newly added or changed hook until you review/trust it in `/hooks` or Settings → Hooks. `teamai hooks inject` and `teamai doctor` print a reminder when Codex hooks are installed; teamai never edits Codex's `[hooks.state]` to auto-trust — trusting is left to you.

### Team Hooks Declaration

A team can declare custom hooks in the repo's `hooks/hooks.yaml`; `teamai pull` automatically distributes them to all members' AI tools:

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before commit
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 20 }
```

| Field | Description |
|------|------|
| `id` | Unique identifier, `^[a-z0-9-]+$` |
| `event` | Claude PascalCase event name (shared across tools) |
| `matcher` | Optional tool matcher |
| `tools` | Optional list of target tools (default = all tools that support hooks) |
| `builtin.disabled` | List of disabled built-in hooks |
| `builtin.overrides` | Only the `timeout` of a built-in hook can be overridden |

Security governance:
- `sharing.hooks.autoApply: false` (`teamai.yaml`): on pull, only prompts — requires manually confirming with `teamai hooks inject`
- `sharing.hooks.requireTeamScripts: true`: rejects any hook whose command isn't under `~/.teamai/team-scripts/`
- `TEAMAI_HOOKS_DISABLED=1`: disables all team hooks locally (built-in hooks are unaffected)

### Agents Resource Type

The team repo can maintain custom subagent definitions under an `agents/` directory (one `*.md` file per agent):

```text
team-repo/
  agents/
    code-reviewer.md      # Team custom subagent
    .removed              # tombstone (auto-managed by teamai remove agents <name>)
```

`teamai pull` copies these into each Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`). The CLI's built-in `teamai-recall.md` is deployed alongside team agents but is not uploaded by `teamai push`.

### OpenCode

[OpenCode](https://opencode.ai) is supported as a first-class tool. Because its config layout differs from the Claude family, teamai handles a few things specially:

- **Scopes.** OpenCode's user config lives under `~/.config/opencode/` while its project config lives under `<project>/.opencode/` — a different prefix from every other tool. teamai writes to the correct one per `--scope`, and only ever touches OpenCode files when OpenCode is actually installed for that scope (it never creates `~/.config/opencode/` for a non-user). Hooks are the one exception — they are always user-scoped, for the reason described below.
- **Skills** land in `.opencode/skills/` (project) or `~/.config/opencode/skills/` (user). OpenCode also reads `.claude/skills` natively, but teamai writes the OpenCode path too so an OpenCode-only user still gets them.
- **Subagents** are rendered into OpenCode's own `agents/*.md` format: frontmatter carries `description` + `mode: subagent` (plus `model` and any `tool_extras.opencode` fields such as `temperature`); the agent name comes from the filename. OpenCode does **not** read `.claude/agents`, so this native copy is required.
- **Rules** are copied into `.opencode/rules/` (or `~/.config/opencode/rules/`), but OpenCode does not auto-scan a rules directory — the files are inert until referenced. teamai therefore adds a `rules/*.md` glob to the `instructions` array in `opencode.json` and removes it again when the team's last rule goes away, editing only that one key and leaving your own `instructions` entries untouched.
- **Hooks** are delivered as an OpenCode *plugin*, not a settings-file entry — OpenCode has no `hooks` array; it auto-loads JS/TS plugins from **both** `~/.config/opencode/plugin/` and `<project>/.opencode/plugin/`. A plugin present in both dirs is loaded twice and would dispatch every event twice, so teamai keeps exactly one copy: `teamai-hooks.ts` in the user dir, which covers every project. Any project-scope copy left by an earlier layout is deleted on the next sync. This matches the other tools, whose `settings.json` hooks also live in HOME and gate on the `cwd` handed to `hook-dispatch`. The plugin subscribes to OpenCode's own events and shelling out to the same `teamai hook-dispatch` entry point every other tool uses. The event mapping mirrors the Claude built-in set: `session.created` → session-start, `session.idle` → stop, `chat.message` → prompt-submit, `tool.execute.after` → post-tool-use. The plugin forwards the same STDIN payload other agents send (`cwd`, `tool_name`, `tool_input`, `prompt`), and maps OpenCode's lowercase tool ids (`skill`, `todowrite`) back to the PascalCase matchers the handler registry expects. OpenCode cannot inject a hook's stdout back into the session, so hooks run purely for their side effects (status report / sync / update). Note that OpenCode *awaits* its named hooks (`chat.message`, `tool.execute.after`), so those dispatches briefly wait on the `teamai` subprocess before the agent continues; the errors are always swallowed so a hook can never fail the session. Server-pushed agent hooks (`teamai-agent-<slug>.ts`) install into the same user plugin dir.
- **MCP** servers live under the `mcp` key of the shared `opencode.json` (see the MCP section above).

### Qoder

Qoder is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.qoder/skills/`, `.qoder/rules/`, and `.qoder/agents/`. Hooks and MCP servers are merged into the scope-specific `.qoder/settings.json`, preserving unrelated user settings. The paths match Qoder's user and project configuration contracts.

### ZCode

ZCode is available as a built-in target. Skills deploy to `.zcode/skills/` (ZCode also reads the central `~/.agents/skills/`, which the `agents` entry covers), and subagents deploy as Claude-style Markdown to `.zcode/agents/`. Hooks are merged into the shared `~/.zcode/cli/config.json`, preserving unrelated keys such as plugin state. Two ZCode specifics the writer handles for you:

- Config-file hooks are **disabled by default** in ZCode — TeamAI forces `hooks.enabled: true` so the entries it writes actually fire.
- Hook entries use the `process` type (`bash -lc <dispatch>` as an argv vector) rather than a shell string, which sidesteps Windows PATH resolution landing on the WSL `bash.exe` instead of Git Bash.

These paths are verified against the ZCode desktop app: profiles created in its Subagents settings page land in `~/.zcode/agents/*.md`, and files placed there (e.g. by TeamAI) show up in the page's installed list. MCP servers deploy to `~/.agents/mcp.json` (user scope, Claude `mcpServers` shape — the same file ZCode's own MCP settings page reads). Project scope is not wired: ZCode stores workspace MCP under a different key (`mcp.servers` inside `.zcode/config.json`), which the Claude writer cannot emit. ZCode has no user-level rules directory convention, so rules are not synced.

### JoyCode

JoyCode is available as a built-in target. Skills, rules, and subagents are deployed to `.joycode/skills/`, `.joycode/rules/`, and `.joycode/agents/`. Rules use Cursor-compatible `.mdc` files, including the same derived frontmatter and body-only round-trip behavior described below. Subagents use Markdown with YAML frontmatter.

JoyCode rule cleanup is conservative: local `.mdc` and `.md` files absent from the team rule list are preserved unless an explicit team removal tombstone exists. This protects personal rules in the shared directory; an old team copy without a deletion record is retained rather than guessed to be stale.

For canonical YAML agents, push compares each local file with the corresponding tool rendering and merges only actual edits back into the original spec. Deployment `targets`, other tools' metadata, and fields absent from a tool's native format are preserved. Conflicting or unparseable edits are skipped rather than replacing the canonical agent.

**Hooks & Manual Sync**: JoyCode currently does not provide a lifecycle hooks mechanism or dedicated launcher/startup adapter (no `settings.json` hook array or `hooks.json` format). Consequently, opening JoyCode does not fire TeamAI's `SessionStart` event, and cannot trigger background `teamai pull`, telemetry reporting (`teamai track`), or auto-update checks. Users working with JoyCode must run `teamai pull` manually in the terminal to synchronize team resources, and `teamai push` to contribute changes. If JoyCode adds hooks or extension lifecycle events in future releases, a dedicated hook adapter can be connected.

### Cursor

Cursor project rules must live in `.cursor/rules/` as **`.mdc`** files with YAML frontmatter — a plain `.md` file there is silently ignored by Cursor. teamai therefore writes rules to Cursor as `<name>.mdc` (every other tool still gets a plain `.md`), deriving the frontmatter from the team rule:

- A rule scoped with a `paths:` list becomes `globs: "<comma-joined>"` + `alwaysApply: false` (Cursor auto-attaches it when a matching file is in context). The value is quoted because a glob starting with `*` is not valid YAML unquoted.
- A rule with no `paths` (a mandatory team rule) becomes `alwaysApply: true` (applied to every Cursor chat session).

Only the markdown body crosses between the two formats; each side keeps its own frontmatter. On `pull` the Cursor frontmatter is machine-derived (the body is copied over with leading/trailing blank lines normalized), so a `pull` → `push` round-trip is not seen as a content change. On `push`, editing a rule's body in `.cursor/rules/*.mdc` and running `teamai push` sends **only that body** upstream — the team rule keeps its own `paths:` frontmatter, so the rule's scope is never silently lost.

Two things are deliberately *not* pushed from Cursor's rules directory:

- A `.mdc` file with no matching team rule. `.cursor/rules/` is also where Cursor's own *New Cursor Rule* command writes personal rules, so teamai never offers those as new team resources.
- The CLI built-in rules, which are deployed (as `.mdc` for Cursor) rather than synced.

Upgrading from an earlier version: `.cursor/rules/*.md` copies written by the old layout are inert — Cursor never read them — so `pull`, `remove`, and `uninstall` delete them alongside the `.mdc` file. A `.md` you put there yourself is left alone.

### Miscellaneous

```bash
teamai doctor          # Config diagnostics
teamai stats           # Skill usage stats
teamai update --check  # Check for a CLI update without installing it
teamai update          # Check for and install a CLI update
teamai digest          # Generate the weekly team activity digest
teamai remove skills <name>   # Remove a resource
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
```

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

### Usage reporting

By default, `teamai pull` commits session/usage stats into the team repo.
Teams that pull from a read-only remote (or simply don't want stat commits)
can turn this off in `teamai.yaml`:

```yaml
usageReport: false
```

### CI Integration

`teamai ci extract-mr` plugs into your CI pipeline, automatically extracting knowledge from every MR/PR:

```bash
# Comment mode: post suggestions as comments (runs when the MR/PR is opened/updated)
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write mode: after merge, write approved suggestions into the knowledge base
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

Workflow:

1. MR opened/updated → CI triggers `--mode comment`, extracts knowledge suggestions and posts them as MR comments
2. Reviewer reviews the comments, marking unwanted suggestions as rejected (GitHub 👎 / TGit ☝️)
3. MR merged → CI triggers `--mode write`, writing non-rejected suggestions into the team knowledge repo

Ready-to-use templates:

- `examples/ci/github-actions-mr-extract.yml` (GitHub Actions)
- `examples/ci/coding-ci-mr-extract.yaml` (Coding CI / TGit)

### Cross-Team Skill Subscriptions

`teamai source` lets you subscribe to other teams' public skill repos, automatically fetching the latest skills on `pull`:

```bash
# Add a subscription source
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# List subscriptions
teamai source list

# Browse a subscription's skills
teamai source browse other-team

# Remove a subscription (also cleans up its skills)
teamai source remove other-team
```

A subscription source's skills are automatically synced locally on `teamai pull`, coexisting with the team's own skills. `teamai source add`/`remove` updates the active scope's team repo immediately, so local `list`, `browse`, and `pull` commands use the change before it is committed. The subscription itself is stored in the `sources` field of that repo's `teamai.yaml`. Run `teamai push` to open a PR with the config change; once it merges, every teammate's `teamai pull` picks up the new source automatically.

A source only shares the skills it opts in via a `publicSkills` list in its own `teamai.yaml`. If the repo has no `teamai.yaml`, or declares no `publicSkills`, `teamai source add` succeeds but warns that the source will sync **0 skills** — the source team has to publish a `publicSkills` list before anything flows through.

#### HTTP Source

In addition to a git subscription source, you can attach an HTTP source on top of an existing git main repo — useful for server-managed skill delivery:

```bash
# Attach an HTTP source (the git main repo is unaffected)
teamai source add-http https://your-team-host/api --token <api-key>

# View it (shown under "HTTP source")
teamai source list

# Detach and uninstall its resources
teamai source remove-http
```

An HTTP source reports status and pulls skill commands via hook dispatch on every session. Only one HTTP source is supported per install. If the main repo is already in HTTP mode (`init --http`), `add-http` is unavailable (the main repo already occupies the HTTP config).

---

## Configuration Reference

### teamai.yaml (remote team config)

```yaml
team: my-team
description: Team AI resource repo
repo: https://github.com/group/repo.git
provider: github
# scope: ignored if present — local install location is set by `teamai init --scope`

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
    enabled: false             # optional; members can override locally
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false             # optional; strip AI-tool commit trailers team-wide
  contributeHint:
    enabled: true              # optional; false = no /teamai-share-learnings nudge after high-friction sessions
```

### config.yaml (local config)

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/group/repo.git
username: your-name
updatePolicy: auto
scope: project                 # project (default from init) or user
projectRoot: /path/to/project  # project scope only
inheritUserScope: true         # optional; project scope only, defaults to false
coAuthorEnabled: true          # optional; per-machine co-author override
contributeHintEnabled: false   # optional; per-machine override of sharing.contributeHint.enabled
```

---

## Uninstall

`teamai uninstall` intelligently cleans up all teamai-managed resources, **preserving anything you created yourself**.

```bash
# Preview every managed path that will be removed (no actual changes)
teamai uninstall --dry-run

# Interactive confirmation
teamai uninstall

# Skip confirmation and uninstall directly (for scripts/CI)
teamai uninstall --force

# Uninstall only one tool's resources (mirrors `init --agent`)
teamai uninstall --agent claude
```

What gets removed:
- teamai hooks in AI tool settings
- The teamai rules block in CLAUDE.md (your own content is preserved)
- Team-synced skills, including OpenClaw workspace skills (your own skills are preserved)
- Team-synced rules
- Team-synced custom agents and CLI built-in agents (your own agents are preserved)
- The env block in your shell profile
- The `~/.teamai/` directory

### Uninstall a single tool (`--agent <tool>`)

`--agent <tool>` removes only that tool's teamai resources (hooks, CLAUDE.md block, skills, rules, team-synced custom agents, and built-in agents). The tool name is a key of `toolPaths` (e.g. `claude`, `codex`, `codebuddy`) and is matched case-insensitively. An unknown tool name aborts without deleting anything, lists the available tools, and exits with a non-zero status.

Shared resources (the env block, docs directory, and `~/.teamai/`) are removed **only when the target itself has teamai resources AND is the last tool still using teamai** — otherwise they are kept for the remaining tools. (So targeting a tool that has no teamai resources of its own is a no-op and leaves shared resources in place, even if it happens to be the only tool.)

The exclusion is durable: `uninstall --agent <tool>` drops the tool from `enabledAgents` and records it in `disabledAgents`, so a later `pull` (or another tool's session-start hook) will not resurrect its skills, rules, agents, CLAUDE.md block, or hooks. Running `init --agent <tool>` again clears the exclusion and re-enables sync for that tool.

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --scope user --role <role_id> --force
teamai pull
```

---

## FAQ

**Q: I have never used Git?**

Paste an [onboarding prompt](prompts/README.md) into your current AI tool and let it run the commands. Use [getting started](prompts/getting-started.md) if you do not have a repo URL yet, or [member](prompts/member.md) if you already have one.

**Q: Can user scope and project scope coexist?**

Yes, but project scope remains isolated by default. When the current working directory contains a project-scope config, it is active and user scope is skipped. Initialize user scope first, then initialize the project with `--inherit-user-scope` (or set `inheritUserScope: true` in the project's local config) to compose safe resources and Recall results. Executable and control-plane configuration (`env`, MCP) remains project-only; hooks are the exception — a non-self project scope injects them into HOME so `hook-dispatch` can gate on `cwd` (see the Hooks section).

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --force
```

**Q: After `teamai init` in a project, there is no `.claude/` (or `.cursor/`, `.codebuddy/`) directory?**

That is expected. `init` does not know which agent you will open. Open Claude Code / Cursor / CodeBuddy in the project: the SessionStart hook creates that tool's project root and then pulls. A bare `teamai pull` will not create missing agent roots.

**Q: Hooks aren't firing automatically?**

```bash
teamai doctor        # Diagnose
teamai hooks inject  # Re-inject
```

**Q: `push` says "no new resources detected"?**

`push` only detects new or modified resources. If nothing changed, there's nothing to push.

**Q: How do I delete resources that were already pushed?**

```bash
teamai remove skills <name>
teamai remove rules <name>
```

---

> **Repo**: https://github.com/Tencent/teamai-cli
> **Feedback**: file an Issue in the repo
