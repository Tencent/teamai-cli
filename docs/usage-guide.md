# TeamAI CLI — Team Onboarding & Usage Guide

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — the team collaboration layer for AI agents
>
> **Make every team continuously smarter with AI.** Define how agents work (Team Execution), give them team knowledge (Team Context), and turn real sessions into shared capability (Team Improvement). TeamAI manages Skills, Rules, Docs, Env, MCP, and more across Claude Code, Codex, GitHub Copilot CLI, CodeBuddy, WorkBuddy, OpenCode, Pi, Cursor, and other supported agents.

---

## Table of Contents

- [What TeamAI is](#what-teamai-is)
- [Core Concepts](#core-concepts)
- [Installation](#installation)
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
- [Command Reference](#command-reference)
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

---

## Admin Initialization

> Only one admin needs to do this — other members can skip to [Member Onboarding](#member-onboarding).

Create an empty repository on GitHub, GitLab (gitlab.com or a self-hosted instance), GitCode (gitcode.com), CNB (cnb.cool), TGit, or any private/self-hosted Git service (suggested naming: `TeamAi-<team-name>`). For providers that support repository creation, you can also run `teamai init` and create a missing repo when prompted.

> **CNB exception:** the `cnb login` token can create neither an organization (`group-manage:rw`) nor a repo (`group-resource:rw`), so `init` prints a web link to create them instead — `https://cnb.cool/new/groups` for a missing org, `https://cnb.cool/new/repos` for a repo — then you re-run. Use a `CNB_TOKEN` access token carrying those scopes to let the CLI create them directly.

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
├── team-repo/                           # clone of the team repo (knowledge on the default branch)
├── learnings-wt/                        # checkout of the `teamai-learnings` orphan branch
├── pending-learnings/                   # contributions not published yet
└── reports-wt/                          # checkout of the `teamai-reports` orphan branch
```

Independent git clones use the same split as single-repo mode: `members/` `sessions/` `votes/` `stats/` go to the `teamai-reports` orphan branch and `learnings/` goes to `teamai-learnings` (both checkouts sit **beside** the clone, not inside it). Knowledge (`skills/` `rules/` `docs/` `teamai.yaml`) stays on the default branch, reached by pull request. Report files and learnings already on `main` are left in place: `members/` keeps being read from the default-branch copy as a read-only inherited root (nothing copied or deleted; when the same file exists on both, the branch copy wins), other reports are ignored from then on, and learnings keep being read.

In both modes, commands that only read reports (`members`, `digest`, `projects members`, `stats`, `viz`) never create or push the `teamai-reports` branch. `teamai pull` refreshes the reports checkout from `origin` before it rebuilds the search index (vote hotness) and skill recommendations. Report writers (session save `--push`, Stop-hook votes, member registration, auto-report) merge into origin's latest copy of the member's file first, so the same member reporting from two machines does not lose a session, vote, or stats entry.

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

At the role prompt, enter one or more comma-separated role numbers. The first number becomes `primaryRole` and the remaining numbers become `additionalRoles` (for example, `1,3`).

You can also skip the interactive prompts via CLI flags for a fully non-interactive init (suitable for CI/CD or AI agents):

```bash
GITHUB_TOKEN=ghp_... teamai init https://github.com/yourorg/yourrepo --scope project --role hai_dev --force
```

Without a terminal `init` never waits on a person: every prompt takes its default, and a provider that would need a browser login fails at once and names the credential to prepare (`GITHUB_TOKEN` / `GH_TOKEN` for GitHub, `CNB_TOKEN` for CNB, `GITLAB_TOKEN` for GitLab, `GITCODE_TOKEN` for GitCode). TGit is the exception: it has no unattended token — `TGIT_TOKEN` is REST-API-only and git.woa.com rejects it for `git clone` — so run `gf auth login` once in an interactive shell on that machine and unattended runs reuse the credential it stores. `git` itself runs with its prompts closed: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo` (no askpass dialog) and `GCM_INTERACTIVE=never`, each only when you have not set it yourself. `ssh` is left alone: its batch flag is only reachable through `GIT_SSH_COMMAND`, which would override whatever `core.sshCommand` each repository configured, so an ssh remote that still needs a passphrase or an unknown-host confirmation is yours to close — `git config core.sshCommand 'ssh -o BatchMode=yes'` on that repository, or export `GIT_SSH_COMMAND` for the run. A run counts as non-interactive when stdin is not a TTY, or when `CI` or `TEAMAI_NONINTERACTIVE` is set, so an agent sandbox that allocates a pseudo-terminal can still declare itself unattended.

| Flag | Description |
|------|------|
| `[repo]` / `--repo <url>` | Team repo URL (positional preferred; `--repo` is a permanent alias) |
| `--scope <project\|user>` | Install scope, defaults to `project` (machine-data in `~/.teamai/projects/<slug>/`, resources in `<cwd>`). Use `user` for `~/` |
| `--inherit-user-scope` | Project scope only: also sync safe user resources and search user knowledge |
| `--no-inherit-user-scope` | Disable previously configured user-scope inheritance for this project |
| `--role <id>` | Directly specify the primary role, skipping the interactive role prompt |
| `--project <ids>` | Active logical project(s) from `manifest/projects.yaml` (comma-separated). Scopes which project resources and learnings this directory syncs. Pass `all` to activate every project the manifest declares. See [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role) below |
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
- **Activate everything at once.** `--project all` is a reserved value: it
  expands to every id the manifest declares and persists that snapshot, so a
  monorepo's onboarding docs carry one line instead of a list that drifts
  whenever a project is added. It is an explicit opt-in to every project —
  project-private learnings included — and re-running `init` re-resolves it. A
  project whose id is literally `all` is covered by the expansion but cannot be
  selected on its own through this flag; `teamai projects set all` takes plain
  ids and still activates exactly it.
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
      agents:    [hai-inference]   # optional
```

The project id and every namespace under `resources:` become a directory name
(`skills/<namespace>/`, `learnings/<namespace>/`, `agents/<namespace>/`), so
neither may escape the directory it names.

A **namespace** must be a single path segment: no `/`, `\`, `:` or control
character, no trailing `.` or space, and not a Windows device name (`CON`, `NUL`,
`AUX`, `PRN`, `CONIN$`, `CONOUT$`, `COM1`–`COM9`, `LPT1`–`LPT9`, including the
superscript forms Windows also reads as device numbers, with or without an extension).
Windows strips a trailing period or space from every path component, so `.. `
would arrive as `..` and escape the parent while `frontend.` would arrive as
`frontend` and land in another namespace's directory; the same rule rules out `.`
and `..`. Anything else a filesystem accepts stays valid — a non-ASCII name, one
holding a space inside it, or one that merely starts like a device (`console`).
Two namespaces of the same resource type may not differ only by case (`frontend`
and `Frontend`, or under Unicode case folding `σ` and `ς`): on the default Windows and macOS filesystems they are one
directory, so a role or project scoped to one would read the other's resources.
The check spans both manifests, since `roles.yaml` and `projects.yaml` share the
same `skills/`, `knowledge/` and `agents/` directories.

A **project id** keeps its own older and narrower rule, because it is also typed
on the command line and split on commas: letters, digits, `.`, `_` and `-`, and
not `.` or `..`.

A manifest that breaks either rule fails to parse, and the error names the
offending entry.

**Commands** (low-frequency correction/query, mirroring `teamai roles …`):

```bash
teamai projects list                 # Defined projects + the ones active in this directory
teamai projects set hai-inference    # Set active project(s) for this directory (overwrite; comma-separated or repeated; empty to clear)
teamai projects members hai-inference # Who is registered on a project
```

Member registration is a **side-effect of `init`**: running `teamai init --project <id>`
appends `<id>` to your `members/<user>.yaml` roster (append + dedupe across
directories), so the team can answer "who is on project X". `teamai push --project <id>`
pushes each new resource into that project's namespace for its own resource type
(resolved from the manifest): a skill into `resources.skills`, a rule into
`resources.knowledge`, an agent into `resources.agents`. If the project declares
no namespace for a type being pushed, the push stops and names that type rather
than writing to the shared root, where the resource would reach everyone.

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
├── team-repo/            # Clone of the team repo (knowledge on the default branch)
│   ├── teamai.yaml      # Remote team config
│   ├── skills/ rules/ docs/ env/
│   ├── manifest/roles.yaml  # Role definitions (when role-based skills are enabled)
│   └── learnings/       # Learnings written before they moved to their own branch
├── learnings-wt/        # Checkout of `teamai-learnings` (the team knowledge base)
├── pending-learnings/   # Contributions not published yet
├── reports-wt/          # Checkout of `teamai-reports` (`members/` `sessions/` `votes/` `stats/`)
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

| Data | Where it lives | How it is written | Needs write access to the default branch? |
|------|----------------|-------------------|-------------------------------------------|
| Knowledge: `skills/` `rules/` `docs/` `env/` `agents/`, `teamai.yaml` | `.teamai/` on the **main** branch | `teamai push` → pull request | No: push a branch, open a pull request |
| `learnings/` | `teamai-learnings` **orphan branch** | `teamai contribute` → direct push | No |
| Reports: `members/` `sessions/` `votes/` `stats/` | `teamai-reports` **orphan branch** | `init`, `session save`, hooks, pull auto-report | No |
| Machine-local: `config.yaml`, `state.json`, search index, env backup, MCP manifests | `~/.teamai/projects/<slug>/` (**partition**, outside the repo) | local only | — |
| Disposable git worktrees (`reports-wt/`, `learnings-wt/`, `knowledge-wt/`) and the contribution queue (`pending-learnings/`) | `.teamai/` (gitignored; rebuilt on demand) | local only | — |

Learnings a team wrote before they moved to their own branch stay on the default
branch, exactly where they are. Nothing is copied, deleted or migrated: that
directory is still read, so every existing learning keeps coming back from
`teamai recall`. New learnings go to `teamai-learnings`.

**Minimum Git permissions with a protected default branch.**

A member needs to:

- push to `teamai-reports` and `teamai-learnings`, and create either ref when it
  does not exist yet
- push the feature branches `teamai push` creates
- open pull requests against the default branch

A member does not need to:

- push directly to `main` / `master`
- bypass branch protection, or hold admin rights

Turn protection on and everyday use keeps working: `init` registers the member,
`pull` syncs, `contribute` publishes, and `push` opens a pull request. With
`provider: git` teamai cannot open that pull request for you — it pushes the
branch and prints the command to open it by hand. `teamai contribute` never
needs it. An HTTP backend is unaffected: it writes through its API and has no
branches at all.

Machine-local data lives in the per-project **partition** outside the repo, so a
single-repo `.teamai/` holds only the team knowledge committed to main — `git
status` stays clean. Upgrading an older single-repo install relocates that machine
data into the partition automatically on the next `init`/`pull`/`push` (the
knowledge on main is left exactly in place).

**Clone = initialized.** Because knowledge and the `mode: self` marker in `.teamai/teamai.yaml` are committed to main, a teammate who clones the repo is auto-initialized: the next `teamai` command or AI session detects the marker, and (when their git provider is already authenticated) writes their local config, injects hooks, and registers them on the reports branch — no need to re-type repo/role. If they aren't authenticated yet, teamai prompts them to run `teamai init .` once.

**Safety.** Every git write teamai performs in single-repo mode (knowledge PRs and the reports orphan branch) runs in an isolated git worktree under `.teamai/`. Your working tree and current branch are never checked out, reset, or switched. Isolated worktree commits skip local git hooks (for example husky / lint-staged): a clean checkout from `origin/<default>` often has hook scripts without the locally generated `husky.sh`, and knowledge/report files should not run the business-repo lint pipeline. Your ordinary `git commit` in the business repo still runs hooks.

**Admin checklist after `teamai init .`:**

1. `teamai init .` already commits `.teamai/` (skills, rules, docs, an empty `learnings/`, `teamai.yaml`, `.gitignore`) plus each selected tool's settings (e.g. `.claude/settings.json`, `.codex/hooks.json`) to the current branch for you. Contributions do not go there: `teamai contribute` pushes them to the `teamai-learnings` branch.
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

Once the admin shares the team repo URL with members:

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

teamai skill                        # teamai list skills --source all, then the CLI-served built-in catalog
teamai skill show hai-deploy-test   # View a single skill's source / contributor / install locations / description summary

teamai skill list --json            # The built-in skills the installed CLI serves, machine-readable
teamai skill get core               # Print a built-in workflow: core | setup | wiki | share
teamai skill get wiki --full        # ...with its references and templates appended
teamai skill path wiki              # The packaged directory, for the scripts a skill ships
```

#### Built-in skills are versioned with the CLI

The built-in workflows (`core`, `setup`, `wiki`, `share`) ship inside the npm package
and are printed by the installed binary with `teamai skill get`, so what an agent reads
always matches the CLI version it is running — `npm i -g teamai-cli@latest` is the
update, with no pull needed for the content to be current. Agents receive a single file
from the CLI, `~/.<tool>/skills/teamai/SKILL.md` (or wherever that tool keeps team skills: OpenClaw's
workspace, `HERMES_HOME`), a small discovery stub that points at
those commands. Older releases copied the whole tree into every agent directory, where it
went stale between pulls; `teamai pull` removes those leftovers, keeping a copy of every
removed file under `~/.teamai/removed-skills/`, one directory per pull (until `teamai uninstall`,
which removes `~/.teamai/` and this archive with it). Only files whose content a release shipped
are removed: a packaged file you edited, or a skill of your own under one of the old names, is
yours and stays. A directory that also holds a file of your own is kept, with only the
packaged files removed, and named in the pull output. `share` is served only while recall is
on (off by default; `sharing.recall.enabled: true` in `teamai.yaml` for the team, or
`teamai recall enable` for one machine): until then `teamai skill get share` refuses and says so.
It also refuses on a read-only HTTP source, where `teamai contribute` cannot write, and when a
teamai config exists but cannot be loaded (the refusal says what failed: for a file that does not parse, which file and where; for one that fails validation, which field and why),
since recall and the source are then unknown. The legacy names still
resolve: `teamai skill get team-wiki-codebase` serves `wiki`.

---

## Day-to-Day Use

### Auto-sync

`teamai init` already injected Hooks into your AI tools. **`teamai pull` runs automatically every time you start an AI session** — no manual action needed. In project scope, that SessionStart hook first creates the current agent's project root (e.g. `<project>/.claude` when Claude Code opens the repo) if it is missing, then pulls.

*(Note: Automatic sync on session start requires an agent that supports lifecycle hooks, such as [CC], Codex, GitHub Copilot CLI, Cursor, CodeBuddy, WorkBuddy, Qoder, Kiro, OpenCode, Oh My Pi, Pi, Hermes, or OpenClaw. Kiro runs the hook when a TeamAI-rendered custom agent is activated in an interactive CLI session; its in-memory built-in default agent is not writable, and non-interactive mode does not fire `agentSpawn`. For tools without a teamai-writable hooks surface such as JoyCode or Gemini CLI, run `teamai pull` manually.)*

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

A manual `teamai pull` ends by running the `teamai doctor` checks and printing each one that failed, with its fix — including whether the skills it just reported syncing are readable on disk for every enabled tool. It prints nothing when they all pass, and the exit code is unchanged. The SessionStart hook path and `--dry-run` run no checks at all, so session startup stays as fast as before. Provider checks (`gh`/`gf` authentication) are left to `teamai doctor`: the pull just used the provider.

> Project scope is isolated by default. When the current working directory contains a project-scope `.teamai/config.yaml`, `pull` processes that project and skips user scope unless the local config has `inheritUserScope: true`; in that case it first refreshes the safe user-resource channel. Without a project config in the current directory, `pull` processes user scope. User `env`, MCP definitions, sources, reporting, and writes remain isolated in project mode. Hooks are the one exception: a project scope's hooks are injected into your **HOME** tool settings (`~/.claude/settings.json`, …), not `<projectRoot>`, because the built-in hooks gate on the `cwd` handed to `hook-dispatch` and `~/.claude` always exists so the "installed tool" gate passes (see the Hooks section). In a directory with no teamai config (no project config and no user scope), the team hooks do nothing: no reminders, and no session or skill usage is recorded; only machine-level work runs (the CLI update check, the session-start pull, the local agent, and package hints a pull stashed). A project config that exists but cannot be read counts as none, never as the user scope. Self single-repo mode keeps its hooks in the business repo so they travel on clone.

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/` and `docs/` keep their original sync behavior; `agents/<namespace>/` follows the role's `agents` namespaces (see [Agents Resource Type](#agents-resource-type)). `learnings/` at the root is shared with everyone, while `learnings/<project-id>/` subdirectories sync only for the directory's active projects (see [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role)).

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
teamai doctor              # Check runtimes, declared package/marketplace/plugin status, and what actually landed on disk; exits 1 when any check fails
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

Exclusion rules take effect after role and tag filtering. When running `teamai pull`, excluded skills are not synced, and any copies previously installed by `pull` are cleaned up. `teamai doctor` checks the resulting set against what is on disk, and asks nothing of an excluded skill.

### Push local resources

```bash
teamai push          # Scan for new/modified resources, create an MR
teamai push --all    # Skip confirmation, push directly
teamai push --role pm  # Push into the pm namespace (skills/pm/, rules/pm/, agents/pm/)
```

**Namespace selection (new resources):** When pushing a new skill, rule or agent, the CLI automatically detects available namespaces and offers an interactive choice:

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- Each resource type resolves from its own axis: skills from the `skills` namespaces, rules from `knowledge`, agents from `agents`. A push that carries several types asks once per axis
- If `primaryRole` is set, the list of available namespaces is expanded from the manifest
- If `primaryRole` is not set, the team repo's directory structure is scanned automatically for skills; a new rule or agent stays at the shared root
- A single namespace is auto-selected; use `--role <id>` to choose one explicitly
- Modifying an existing resource automatically keeps its original namespace
- The chosen destination is printed for each resource, e.g. `[rules] my-rule → rules/pm/my-rule.md`
- A roles manifest that exists but cannot answer stops the push instead of falling back to the shared root. One that is missing the configured role: fix `manifest/roles.yaml`, run `teamai roles set <role>`, or pass `--role <ns>`. One that cannot be read or parsed, or is empty, stops the push at its scan (exit 2), before `--role` is consulted, because the scan needs the manifest to tell which namespaces are yours: fix `manifest/roles.yaml` first. A team with no `manifest/roles.yaml` at all keeps the pre-manifest behavior
- `teamai push --dry-run` resolves the same destinations and stops on the same unresolvable namespace, so it never reports a push as viable that the real command refuses
- When several namespaces could take a new resource and there is no terminal to ask on (CI, a hook, `TEAMAI_NONINTERACTIVE`), push stops with exit 2, lists them, and asks for `--role <ns>`
- `--role`/`--project` places new resources only. An edit of a shared-root rule or agent stays at the shared root, and push says so
- A placed resource stays maintainable from the machine that published it. While its PR is open, the open-PR record routes a later edit of the author's own copy back to that PR; once the file is on the default branch, `state.json` records where push put it, so the edit goes back to the same file, and an agent published into a namespace this directory has not activated is still editable rather than skipped as having no active source
- `teamai remove rules <name>` accepts the bare name the author's copy carries as well as the published `<namespace>/<name>`; it reports which one it resolved to, and removes both the namespaced team file and the author's copy at the rules root. If the team repo cannot be refreshed first, or this machine's placement records cannot be updated and saved, `remove` stops with exit 1 and removes nothing, because either can resolve the name to the wrong files
- A local agent is an edit of the team agent it was delivered from: one in an active namespace or at the shared root first, then one this machine placed. Only when neither exists does `--role`/`--project` decide, and the agent is new in that namespace; if that namespace already holds an agent of that name, the agent is skipped rather than written over it, as a rule would be. Two active agents of one name stay ambiguous and are skipped, flag or not. The same agent name may exist in several namespaces, so a copy in an inactive one you did not name never blocks publishing yours. A placed agent that changed on the team since this machine last synced it is held until you run `teamai pull`, because agents have no pre-push sync. In single-repo mode, a root copy under `.teamai/` that matches an older version of the file it was placed at is held too: nothing refreshes it, so it is an old copy rather than an edit
- A new resource is never placed on top of one that is already there. If the resolved namespace already holds that name, the push stops and names the file: pull and edit the existing copy, rename yours, or pick another namespace with `--role <ns>`
- An agent whose namespace is not active here stays editable through its placement record, and `pull` delivers it for the same reason, so your copy tracks the team file. An active namespace holding that name wins: that agent is the one deployed here
- A resource awaiting review in an open PR keeps that PR's destination — unless this push names a namespace other than the one recorded (the shared root counts as one), in which case the flag decides, the open PR is left untouched, and the collision is reported
- If the team repo cannot be refreshed at the start of a push, `--project` stops instead of placing by a possibly stale `manifest/projects.yaml`; so does any new resource placed without `--role`, because its destination comes from that clone (`manifest/roles.yaml`, its absence, or the namespaces the repo already has). Fix the pull and retry, or name the namespace with `--role <ns>`. `push` also stops, and pushes nothing, when this machine's placement records cannot be updated and saved
- A placement record is written only once the pushed file has landed on the default branch, so a PR closed without merging leaves none behind, whatever became of its branch. It is dropped again when the team deletes that file, or when a shared-root file of the same name appears (your root copy then follows that file, and `pull` warns). `push`, `pull` and `remove` settle this before they read the records. `teamai remove` itself leaves the record alone: its deletion reaches the default branch only when its PR merges, and until then a retried `remove` still resolves the bare name to the namespaced file. If the file reached the default branch with content other than what you pushed (for example a reviewer changed the PR before a squash merge), it is not recorded, and push says so once; run `teamai pull` and edit that file as the team file it now is
- Your own copy of a rule you published into a namespace stays at the rules root. When that namespace is active here, `pull` updates that copy instead of writing a second one under `rules/<namespace>/`; when it is not, `pull` leaves it alone. It is swept only once the team file it was placed at is gone

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

Roles control which skills, namespaced rules and namespaced agents each member sees. Admins define roles via `manifest/roles.yaml`; once a member selects their role, `pull` syncs skills from the matching namespace. Active tag subscriptions may additionally sync explicitly matching skills from other namespaces, but untagged skills in inactive namespaces are not included.

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

The `--namespaces` list is applied to `knowledge`, `skills` and `agents` alike. The commands above automatically push a branch and create an MR; the change takes effect team-wide once merged.

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

Admins can manage resource tags with `teamai tags add` and `teamai tags remove`. Run `teamai pull` after changing your subscriptions; it does a full sync even when the team repo has not changed, so newly matched resources are installed and unsubscribed ones are removed. The checks at the end of that pull verify the newly matched skills reached every enabled tool.

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

Variables live in the team repo's `env/env.yaml`. `teamai env add` writes the first three fields; `roles` and `projects` are hand-edited, as they are for hooks and MCP servers:

```yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint        # optional
  - key: CHECKOUT_DB_URL
    value: https://checkout-db.internal
    projects: [checkout]                  # optional; default is every directory
  - key: DEPLOY_REGISTRY
    value: registry.internal
    roles: [devops]                       # optional; default is every member
```

`roles` and `projects` follow the same rule as on MCP servers and hooks: omitted reaches everyone, `[]` reaches nobody among members who use that axis, an axis the member has not configured filters nothing, and the two compose as **AND**. A variable that no longer matches is removed from `env.sh` on the next pull, even one that reports `Already synced` because the team repo has not moved, so changing role, running `teamai projects set` or upgrading the CLI takes it out of the member's shell without `--force`. Until that pull runs, `teamai doctor` reports a withheld variable that `env.sh` still exports, so the previous project's secrets are not left live in silence. `teamai env add` on an existing key keeps whatever `roles:`/`projects:` it already carries.

`pull` reports what reached this member, naming the declared total when the two differ (`Synced 1 of 3 env variable(s)`), so a variable that was scoped away is distinguishable from one that was lost.

Because the shell profile holds a single teamai block pointing at one `env.sh`, a machine that pulls in several project-scoped directories ends up with the last-pulled directory's variables in new shells. Each directory's own `env.sh` stays correct; it is the shell profile that can only point at one of them.

On `pull`, when `injectShellProfile` is enabled (default), the env block goes into `~/.zshrc` if `$SHELL` is zsh, otherwise `~/.bashrc` — except on Windows: `$SHELL` is normally unset there, and Git Bash starts as a *login* shell that never reads `.bashrc`, so teamai instead prefers an existing `~/.bash_profile`, then `~/.bash_login`, then `~/.profile`, falling back to `~/.bashrc` only when none of them exist (a zsh installed via MSYS2/Cygwin, which does set `$SHELL`, still resolves to `.zshrc`). This matches Git for Windows' own fallback in `/etc/profile.d/bash_profile.sh`, whose guard is `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]` — it only synthesizes a `.bash_profile` that sources `.bashrc` in that same one case, which is why a stray `~/.profile` (even one that just sources something else, e.g. `~/.local/bin/env`) is enough to make `.bashrc` alone go unread. Override the target file with `sharing.env.shellProfilePath` in `teamai.yaml`.

Every pull re-runs this order to find the file the current environment actually reads, then follows every reference from it to one of the other four candidate filenames — transitively, through as many hops as it takes — looking for a candidate that already carries the block, rather than duplicating it. A chain through a file outside that fixed set of five (e.g. a custom `~/.config/shell/profile` some setups source instead) is not followed. This is what keeps the Git-for-Windows bootstrap above from moving the target out from under it: that same guard condition means a first pull into `.bashrc` leaves the exact state that makes the next login shell auto-generate a `~/.bash_profile` sourcing it, and without following that forwarding relationship the next pull would prefer the newly-created file and inject a second block there, leaving the original — still working, just loaded further away — reported as a dead leftover. The same reasoning covers a plain `.profile` that flat-guards a source of `.bashrc` for interactive shells (`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`), two hops from whatever a login shell reads first.

Only two literal line shapes count as a real reference, though: a bare `source X` / `. X` on a line by itself, or the exact self-referential existence guard Git for Windows itself generates, `test -f X && . X` / `[ -f X ] && . X` (tested and sourced path the same file), also on a line by itself — in both cases `X` must be an unquoted `~/name` or an unquoted-or-double-quoted `$HOME/name` (never a quoted `~`, never a single-quoted `$HOME`: a shell does not expand either, so a reference that looks right there would source a literal, nonexistent path). Anything else — a trailing redirection or extra argument on the source itself, an `||` fallback, an unrelated `&&`-chained command, a condition this can't independently verify — is not recognized, and falls back to the order-based pick rather than being guessed at. This is a deliberately narrow, closed set of two forms rather than an attempt to parse arbitrary shell conditionals: matching everything a real shell script could do to make a line conditional (or to disguise one as inert text) needs an actual shell parser, and no fixed-size grammar ever finishes that job. Nothing inside an `if`, `for`/`while`/`until`, `case`, `select`, a function body, or a `(...)`/`{...}` group counts, however it's guarded — none of those are guaranteed to run (a subshell or brace group's body may always run, but its exports never reach the caller either way) — which also means the standard Debian/Ubuntu `.profile` template (the same source, but nested two `if`s deep, checking `$BASH_VERSION` on the way) is not recognized and falls back to the order-based pick. Nothing textually after an unconditional, top-level `return` or `exit` counts either, since control never reaches it. Anything this can't resolve one way or the other, and a block sitting in a candidate nothing in the chain actually reaches, is never preferred over the order-based pick — otherwise a stale block left by a pre-#682 install would outrank the correct file forever, silently reintroducing #682 on upgrade.

`doctor` (and the check `pull` runs automatically afterward) also flags a teamai env block left behind in a *different* candidate file — e.g. a block a pre-#682 install wrote to `.bashrc` before this file-selection logic changed — even if that block is broken and was never functional. `teamai uninstall` removes it.

### Docs

Place documentation in the team repo's `docs/` directory; after pushing, team members will automatically receive it on their next `pull`.

### MCP servers

Declare each server once in the team repo's `mcp/mcp.yaml`. On `teamai pull` it is written into every installed tool's own MCP config, translated into that tool's native format. Tools outside `enabledAgents` or listed in `disabledAgents` are skipped.

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
    requires: [npx]                      # skipped with a hint when npx is absent from PATH
    tools: [claude, cursor]              # optional; default is every capable tool
    roles: [devops]                      # optional; default is every member
    projects: [checkout]                 # optional; default is every directory
```

`requires` is resolved from `PATH`. On Windows a name also matches a `PATHEXT` suffix (`uvx` matches `uvx.exe` / `uvx.cmd`).

`roles` lists role ids from `manifest/roles.yaml`. A server ships to a member when one of their roles (`primaryRole` or `additionalRoles`) is listed; `roles: []` ships to nobody, the same way `tools: []` does. A member with no role configured receives every server, matching the unfiltered fallback skills and rules use. When a member changes role, servers that no longer match are removed on the next pull. Hand-added servers are never touched. An id that is not in `roles.yaml` produces one warning per pull. A teamai release older than this field ignores it and installs the server for everyone.

`projects` lists project ids from `manifest/projects.yaml` and follows the same rule on the other axis: a server ships to a directory when one of the projects it is bound to (`teamai projects set`) is listed; `projects: []` ships to nobody; a directory bound to no project receives every server. `teamai projects set` to another project removes the ones that no longer match on the next pull. An id that is not in `projects.yaml` produces one warning per pull, and so does a `projects:` key in a team that has no `projects.yaml` at all, where no id can be checked.

One caveat on the empty list, which applies to `roles: []` just as it always has. "Ships to nobody" holds among members who use that axis. A member who has not configured it at all is unfiltered and still receives the entry, because an unconfigured axis filters nothing. A legacy role that could not be resolved because `manifest/roles.yaml` does not load is not "unconfigured": that member receives no role-scoped entry until the manifest is fixed. Use `tools: []` or remove the entry if you need it to reach no one at all.

A missing `projects.yaml` does not switch the key off. A directory's active projects come from its own `config.yaml`, so a directory bound to `billing` still filters out a `projects: [checkout]` server whether or not the manifest is there. What the manifest gives you is the ability to check the ids.

The two axes are independent and compose as **AND**: `roles: [frontend]` with `projects: [checkout]` reaches frontend members of checkout, not everyone on either. That is the same way `tools:` and `roles:` already compose, and deliberately not the union that role and project *resource namespaces* take — which answers the different question of which directories to sync.

This is the cost these keys exist to control: a team with five projects and three servers each gives every member of a role fifteen server processes and fifteen tool lists in the context of every session.

Where each tool's servers land:

| Tool | User scope | Project scope |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json` |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/mcp.json` | `<project>/.mcp.json` |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| copilot | `$COPILOT_HOME/mcp-config.json` | `<project>/.github/mcp.json` |
| codex | `~/.codex/config.toml` | not supported |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| qoder-cn | `~/.qoder-cn/settings.json` | `<project>/.qoder/settings.json` |
| kiro | `~/.kiro/settings/mcp.json` | `<project>/.kiro/settings/mcp.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |
| omp | `~/.omp/agent/mcp.json` | `<project>/.omp/mcp.json` |


CodeBuddy Code's [MCP documentation](https://www.codebuddy.ai/docs/cli/mcp)
lists the project root's `.mcp.json` as its preferred project configuration.
This is separate from TeamAI's user-scope `~/.codebuddy/mcp.json` target.
Explicit `toolPaths.codebuddy.mcpProject` values in `teamai.yaml` still take
precedence. For an existing team that pins run
`teamai mcp remove` in the affected workspace before changing that value to
`.mcp.json`, then run `teamai mcp inject`. Review and preserve any personal
servers in either file; TeamAI does not migrate or delete the old file.
Claude Code also reads the root `.mcp.json`, so this file is shared by both tools.

Copilot uses its native `mcpServers` schema: `stdio` becomes `type: "local"`, remote transports keep `http` or `sse`, and every managed entry gets the required `tools: ["*"]` allowlist. TeamAI honors `COPILOT_HOME`; project configuration uses Copilot CLI's documented `.github/mcp.json` repository location. See [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers). Codex supports `stdio` and `http`; `sse` is skipped. Qoder supports the Claude-compatible `mcpServers` format in its scope-specific `.qoder/settings.json`. Kiro supports the same `mcpServers` format in its dedicated, mcpServers-only `.kiro/settings/mcp.json` (see [Kiro's MCP configuration docs](https://kiro.dev/docs/mcp/configuration/)). OpenCode supports `stdio` (written as its `type:"local"` shape) and `http` (`type:"remote"`); `sse` is skipped, and its servers live under the `mcp` key of the shared `opencode.json`. Ownership is tracked in `~/.teamai/managed-mcp.json` — hand-added servers are left alone; name collisions skip unless `--force`.

**Secrets.** Write `${VAR}`, never a literal, in `mcp.yaml`. Values resolve from the environment, then from `env/env.yaml` → `~/.teamai/env`. Unresolved variables skip the server with a hint.

teamai **resolves every `${VAR}` to its value and writes it verbatim** into each tool's config (new files are created `0600`). It does not rely on any tool's own env-var expansion: that expansion is fragile — most decisively, IDEs launched from the GUI (Dock/Launchpad) never inherit your shell's exported variables, so a `${VAR}` placeholder expands to empty and the server 401s. Resolving to plaintext makes the token present no matter how the tool is started.

> ⚠️ **The resolved token lands on disk.** Project-scope MCP configs (`.mcp.json`, `.github/mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`) then contain the literal secret — add them to `.gitignore` and never commit them.

Claude Code may show project `.mcp.json` servers as pending approval until you accept them once in an interactive session.

```bash
teamai mcp list              # servers, secret status, roles restriction, and where they are installed
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

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

The reminder lists the non-zero friction signals that triggered it. When the first task is available, it also includes a redacted, single-line task summary so you can decide whether the session is worth sharing. Using the built-in `share` workflow (`teamai skill get share`), the AI will automatically summarize the session's learnings and contribute them to the team knowledge base. Each session is prompted at most once.

For the Codex family (`codex`, `codex-internal`, `tcodex`), the Stop hook saves contribution and knowledge-reference reminders for the next UserPromptSubmit in the same session. It does not force an extra agent turn. Contribution reminders are delivered once and discarded if you contribute before the next prompt.

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

Only the nudge is affected: friction scoring, `teamai contribute --file`, and `/teamai` keep working when invoked manually.

The reminder is also withheld while recall is off (the default until `sharing.recall.enabled: true` in `teamai.yaml`, or `teamai recall enable` on one machine): it points at the `share` workflow, and `teamai skill get share` refuses until recall is on. It never appears on a read-only HTTP source, or while a teamai config exists but cannot be loaded, where `share` refuses too, nor in a directory where teamai is not set up, although `teamai skill get share` still serves there.

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
# Start the dashboard, then open "Team Context" (KB Health) or "Team Improvement" (maintenance)
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
| **Last-recall month** | Each entry counts once in its latest recall month, not monthly recall volume |
| **Author contributions** | Per-contributor entry counts and recall share |
| **Maintenance console** | Three action zones: entries ready to promote, entries suggested for archiving, and stale entries needing updates — each with a copyable command |

### Typical Workflow

```
Open the dashboard → Team Improvement
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

If core graph extraction or writing fails, the import reports an error without marking the commit as synced. The next incremental run retries that commit.

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

When extract finds components, it writes `teamwiki/evidence/code/<project>/_manifest.json` even if AI enrichment is skipped or produces nothing, so `--deep-enrich` can start.

### Dashboard

```bash
teamai dashboard             # Start the web dashboard (default port 3721)
teamai dashboard --port 8080
```

The sidebar contains **Overview**, **Team Execution**, **Team Context** and **Team Improvement**. Overview summarizes the three modules. Execution shows this machine's sessions, filters by working directory and AI tool, and opens complete session details. Context contains KB Health (including author contributions and never-recalled entries); Improvement contains local trends and the original promotion/archive/quality-update maintenance commands. Commands are displayed for use in your terminal; the dashboard does not execute them.

Use the header to select English or Simplified Chinese and light, dark, or system theme. Preferences are saved in browser storage when available. User prompts, AI output, knowledge titles and commands are not translated. The standalone `/kb-report` remains available as the original complete report.

Live status is **local**, using the existing events/SSE stream with automatic reconnect and a session reconciliation poll. Recently ended sessions remain visible for the existing 30-second retention window. Knowledge reports show their local/team scope and generation time, **not a claimed team sync time or cross-member live status**. A failed refresh is labeled and any previous result is retained until a successful retry.

#### Human Intervention Metrics

Each session row shows the **number of human interventions**. Hover over the count or open Details for the breakdown; each of the three signal types counts once:

| Type | Meaning | Data source |
|------|------|----------|
| `interrupt` | User pressed ESC to interrupt the agent mid-execution | An interrupted turn in the transcript |
| `toolReject` | User rejected a tool call (permission deny) | A tool_result marked as rejected in the transcript |
| `correction` | Within 60s after the agent stops, the user submits a follow-up prompt containing a correction keyword ("not right" / "redo" / "wrong" / 「違う」 / 「やり直し」 / etc. — Chinese, English and Japanese built in, plus any team keywords) | The stop → prompt_submit event pattern |

> Privacy: shared intervention statistics contain counts. The local dashboard event stream can retain secret-redacted prompt summaries (capped at 200 characters) and AI output for session details; `~/.teamai/debug.log` records the same redacted prompt summary. These are not uploaded by this page.

Keywords in a space-separated script (English, Spanish, ...) must appear as a whole word, so Spanish "segundo" does not count as `undo`. Chinese and Japanese keywords match as substrings. The built-in list covers only Chinese, English and Japanese; a correction typed in any other language is not detected until the team adds its own words in `teamai.yaml`. Team words are merged with the built-in list and matched case-insensitively under the same rules:

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, deshaz, "no era eso", "otra vez"]
```

The prompt is checked when the `UserPromptSubmit` hook captures it, so a change to the team keywords applies to new prompts after the next `teamai pull`; sessions recorded earlier are not re-evaluated.

Matching normalizes both the prompt and keywords to Unicode NFC. For example, `réessaye` matches `re\u0301essaye`, where `\u0301` is a combining acute accent. Accents remain significant, so `reessaye` does not match. Normalization applies only to matching and does not change the 60-second correction window. Correction detection uses the original prompt in memory; the original is then discarded, while the locally stored summary is secret-redacted and capped at 200 characters.

Intervention data is automatically aggregated and reported to the team's `stats/<user>.yaml` during `teamai pull`, and shown in the "Session Autonomy" leaderboard of `teamai digest`, with team averages and per-person intervention rate rankings — useful for verifying whether a skill/rule reduces intervention rates after rollout. Tools without a transcript (e.g. Cursor) degrade gracefully, tracking only `correction`.

#### Conversation Volume & Token Usage

Each session row also shows two columns; Details retains secret-redacted captured prompt summaries, Markdown AI output, timestamps and the last tool:

| Column | Meaning | Data source |
|------|------|----------|
| Prompts | The **number of human conversation turns** in the session (how many prompts were sent) | Count of `UserPromptSubmit` events |
| Tokens | The session's cumulative **token usage** (hover to see input / output / cache read / cache write breakdown) | Claude Code `message.usage`, CodeBuddy `requests[].usage`, or Codex's latest session-level `token_usage_record`; legacy `event_msg.token_count` snapshots are summed once per rollout file |

> Privacy: shared turn/token metrics contain counts only. Redacted prompt summaries and output in dashboard details remain on this machine.

These two metrics are likewise aggregated into `stats/<user>.yaml` (as `prompts` and `tokens` fields) during `teamai pull`, and shown in the "Conversation Volume & Token Usage" section of `teamai digest`, with team-wide totals, bucketed token totals, and per-person token usage rankings. Tools without transcript access (e.g. Cursor) degrade gracefully: turn counts are still tracked, while tokens show as 0 / N/A.

#### Daily Session Trends & Estimated Cost

The dashboard and digest compare the latest seven UTC calendar days with the seven days before them. The dashboard cost card now uses **average known estimated cost per priced session**: sum the available priced-request costs of sessions whose first Stop falls within the period, then divide by the number of those sessions with at least one priced request. Unpriced sessions are excluded; a priced zero-cost session is included. The card reports priced-session coverage. A resumed session keeps its first-Stop cohort and adds its available costs, even if a request occurred on another day. The original `avgRequestCostMicros` API field and digest request-day accounting remain unchanged. A session belongs to the day of its first stop event, while each priced request belongs to its own UTC request day. Active time counts only adjacent event gaps of five minutes or less, so idle terminals do not inflate the result. A session succeeds when it ends without an error, interruption, or correction; rejected tool calls remain a separate intervention signal. Privacy-safe request details (model, token counts, estimated cost, and price-table version; no prompt or response content) stay in `~/.teamai/dashboard/requests.jsonl`, are deduplicated across repeated Stop hooks, and are removed after 90 days.

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

**Team (`--push`, opt-in):** commits the summary directly (no PR) to `sessions/<user>/<year-month>.md` on the `teamai-reports` branch — the exact path `teamai digest` reads, so the session shows up under **Session Highlights**. Only a **valuable** session is pushed by default: one that shows friction (an interrupt / tool-reject / correction) or substantial tool use (≥ 3 distinct tools). Trivial sessions stay local unless you pass `--force`. On a read-only (HTTP-mode) team, `--push` fails gracefully and the local log is still kept.

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

`hooks list` prints the built-in set per tool, because the set is not universal: Copilot also gets `SessionEnd`, OMP's extension covers four events without the `Skill` / `TodoWrite` matchers, OpenClaw maps only `SessionStart` + `UserPromptSubmit`, and Hermes only `SessionStart`. Tools the hook pipeline installs nothing for (e.g. JoyCode) are omitted, and so is Kiro — its `SessionStart` command is embedded as `hooks.agentSpawn` by the agent sync, so it exists only for the agents you actually synced.

The inject and remove commands only touch tools you actually have installed (i.e. whose `~/.<tool>/` root directory already exists). They never create root directories for tools listed in `toolPaths` but not installed.

On Windows, the built-in hook dispatch commands that shell out through bash (e.g. Claude, Codex, Cursor, Copilot CLI) reference Git Bash by absolute path — standard install locations first, then the `HKLM\SOFTWARE\GitForWindows` registry as fallback — so they never resolve to the WSL `bash.exe` launcher; if Git Bash cannot be found they degrade to bare `bash`.

> **Codex trust gate** — Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) gates non-managed hooks behind an explicit user trust step. After teamai writes `~/.codex/hooks.json`, Codex may skip a newly added or changed hook until you review/trust it in `/hooks` or Settings → Hooks. `teamai hooks inject` and `teamai doctor` print a reminder when Codex hooks are installed; teamai never edits Codex's `[hooks.state]` to auto-trust — trusting is left to you.

### Team Hooks Declaration

A team can declare custom hooks in the repo's `hooks/hooks.yaml`; `teamai pull` automatically distributes them to supported hook adapters. Pi is currently limited to TeamAI's built-in lifecycle bridge: custom hooks and built-in overrides from this file are not applied to Pi.

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before commit
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]
    roles: [devops]                      # optional; default is every member
    projects: [checkout]                 # optional; default is every directory

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
| `roles` | Optional list of role ids from `manifest/roles.yaml` (default = every member; `[]` = nobody). Applied before the security gates below; a role change removes the previous role's hooks on the next pull. Ignored by older teamai releases. |
| `projects` | Optional list of project ids from `manifest/projects.yaml` (default = every directory; `[]` = nobody). Matches the projects this directory is bound to via `teamai projects set`; a rebind removes the previous project's hooks on the next pull. ANDs with `roles`. Ignored by older teamai releases. |
| `builtin.disabled` | List of disabled built-in hooks |
| `builtin.overrides` | Only the `timeout` of a built-in hook can be overridden |

Security governance:
- `sharing.hooks.autoApply: false` (`teamai.yaml`): on pull, only prompts — requires manually confirming with `teamai hooks inject`
- `sharing.hooks.requireTeamScripts: true`: rejects any hook whose command isn't under `~/.teamai/team-scripts/`
- `TEAMAI_HOOKS_DISABLED=1`: disables all team hooks locally (built-in hooks are unaffected)

### Agents Resource Type

The team repo can maintain custom subagent definitions under an `agents/` directory (one `*.yaml` or legacy `*.md` file per agent). Root-level files reach every member. One level of subdirectories scopes agents by role or project, the same way `rules/<namespace>/` works:

```text
team-repo/
  agents/
    code-reviewer.md              # Team custom subagent, shared with everyone
    frontend/vr-reviewer.yaml     # Only for roles/projects whose `agents:` lists `frontend`
    .removed                      # tombstone (auto-managed by teamai remove agents <name>)
```

```yaml
# manifest/roles.yaml (manifest/projects.yaml takes the same key)
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # optional; omitted = root-level agents only
```

Every namespace that takes effect — `knowledge`, `skills` and `agents` — becomes a
directory name, so it must be a single path segment: no `/`, `\`, `:` or control
character, no trailing `.` or space, and not a Windows device name, and no two
namespaces of one resource type may differ only by case — in `manifest/roles.yaml`
exactly as in `manifest/projects.yaml`, and across the two. A role's
`learnings:` is accepted for backward compatibility and ignored at runtime
(learnings are namespaced by project, not by role), so it names no directory and
is not checked.

`teamai pull` copies these into each Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`), flattened by file name, so two active namespaces must not define the same agent name (pull reports the collision and skips the scope). `teamai pull` writes `<name>.toml` for Codex tools, `<name>.json` for Kiro, `<name>.agent.md` for Copilot, and `<name>.md` for every other tool. When a member changes role, agents of the namespaces that stopped being active are removed on the next pull, unless the deployed copy was edited locally, in which case it is kept with a warning. Without a configured role, every agent syncs. `teamai push` resolves the source using the same active role and project namespaces as pull. It writes edits to that source and skips ambiguous destinations with a warning; an agent with only inactive sources is also skipped. Skipped agents do not block other resources in the same push. A new agent is placed the way a new skill is: `--role <ns>` or `--project <id>` (that project's `agents` namespace) names the directory, and with neither flag it resolves from the primary role's `agents` namespaces. It only stays at the shared root — where every member receives it — when no namespace resolves, and push warns when that happens (see [Push local resources](#push-local-resources)). Cleanup checks each tool separately, respecting YAML `targets` and legacy format support. An active same-named agent protects a deployed file only when it targets that tool and output file. `teamai remove agents <name>` records a tombstone. A namespaced agent can be named as `<namespace>/<name>`; a bare name that only one namespace has resolves to it, and a bare name found in several places is refused, with the qualified names listed, rather than removed from all of them. The next pull on every other machine deletes `<name>.agent.md`, `<name>.md`, `<name>.toml` and `<name>.json` from each synced tool's agents directory. That cleanup also runs when the pull finds the team repo unchanged. Removing a namespaced agent tombstones `<namespace>/<name>` only, so the same name in another namespace is untouched; a member's flattened `<name>` copy is cleaned, and not pushed again, when it can be that agent's copy (the namespace is active for them, or their machine placed the agent) and their directory does not still receive an agent of that name from another active namespace. A member who never had that namespace keeps their own agent of the same name. The CLI's built-in `teamai-recall` profile is deployed alongside team agents but is not uploaded by `teamai push`.

### GitHub Copilot CLI

GitHub Copilot CLI is supported for its official custom-instructions, Rules, Skills, custom-agent, hooks, and MCP surfaces, plus TeamAI Docs and Env delivery:

- **Scopes.** User resources live below `$COPILOT_HOME` (default `~/.copilot`); project resources live below `<project>/.github`. TeamAI honors `COPILOT_HOME` for detection and every user-scope read or write.
- **Skills.** `teamai pull` writes user skills to `$COPILOT_HOME/skills/` and project skills to `.github/skills/`. Edits in either scope are detected by `teamai push` like other TeamAI skills.
- **Custom instructions.** TeamAI injects team culture and shared instructions into `$COPILOT_HOME/copilot-instructions.md` for user scope or `.github/copilot-instructions.md` for project scope. Marker-delimited TeamAI blocks are replaced idempotently, while text outside the markers remains user-owned. `teamai uninstall` removes only the managed blocks.
- **Rules.** Team rules become native `*.instructions.md` files under `$COPILOT_HOME/instructions/` or `.github/instructions/`. TeamAI derives Copilot's required `applyTo` frontmatter from the team rule's `paths`; a rule without `paths` uses `**`. On push, only the Markdown body flows back, preserving the team-owned `paths` metadata. Unknown Copilot instruction files remain user-owned and are not uploaded or deleted.
- **Custom agents.** Team agents become official `<name>.agent.md` profiles under `$COPILOT_HOME/agents/` or `.github/agents/`. TeamAI maps compatible tool names onto Copilot's primary aliases, preserves Copilot-only frontmatter through `tool_extras.copilot`, and removes only profiles that match team agents or the built-in recall profile. User-authored profiles remain untouched. See [GitHub's custom-agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
- **Team Context recall.** The built-in `teamai-recall.agent.md` profile receives only `execute`, `read`, and `search`. It invokes the existing `teamai recall` pipeline, so Copilot can retrieve learnings, codebase evidence, and teamwiki results without copying or creating a second knowledge store.
- **Docs and Env.** Team docs sync to the configured local docs directory (`~/.teamai/docs` by default, or the project-relative equivalent in project scope). Team env values sync to the scope's managed `env.sh`; launch Copilot from a shell that has sourced that file. TeamAI does not copy environment values into Copilot configuration.
- **Hooks and private telemetry.** TeamAI writes a dedicated version-1 hook file at `$COPILOT_HOME/hooks/teamai.json` or `.github/hooks/teamai.json`. It uses Copilot's VS Code-compatible PascalCase events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`) so hook payloads retain the snake_case fields consumed by TeamAI, and emits `bash`, `powershell`, and fallback `command` fields. Session IDs, skill usage, prompt counts, lifecycle state, and final token totals feed the local dashboard. Copilot prompt text, assistant output, transcript paths, and request metadata are never stored; if final token counters are absent, the session is still recorded without token data. For resumed sessions, TeamAI records a path-free log byte boundary at SessionStart and captures a marker already present only when it is neither closed nor claimed by the previous run. Shutdown counters must link to that marker or to one written after the boundary. If a marker appears only after SessionStart and SessionEnd has no provider timestamp, its run cannot be proven and the session remains recorded without token data. The file is reconciled idempotently while preserving unrelated entries. TeamAI never edits Copilot's `settings.json`.
- **MCP.** `teamai pull` and `teamai mcp inject` merge local and remote servers into `$COPILOT_HOME/mcp-config.json` or `.github/mcp.json` using Copilot's native schema. TeamAI tracks ownership outside the Copilot file, so repeated pulls are idempotent and `mcp remove` or uninstall removes only TeamAI-owned entries. Hand-authored servers and `settings.json` remain unchanged.

Team hooks still come from the team's `hooks/hooks.yaml`: edit that source in the team repository and use the normal pull/push workflow. TeamAI does not reverse-import arbitrary native hook entries from a Copilot configuration file.

### OpenCode

[OpenCode](https://opencode.ai) is supported as a first-class tool. Because its config layout differs from the Claude family, teamai handles a few things specially:

- **Scopes.** OpenCode's user config lives under `~/.config/opencode/` while its project config lives under `<project>/.opencode/` — a different prefix from every other tool. teamai writes to the correct one per `--scope`, and only ever touches OpenCode files when OpenCode is actually installed for that scope (it never creates `~/.config/opencode/` for a non-user). Hooks are the one exception — they are always user-scoped, for the reason described below.
- **Skills** land in `.opencode/skills/` (project) or `~/.config/opencode/skills/` (user). OpenCode also reads `.claude/skills` natively, but teamai writes the OpenCode path too so an OpenCode-only user still gets them.
- **Subagents** are rendered into OpenCode's own `agents/*.md` format: frontmatter carries `description` + `mode: subagent` (plus `model` and any `tool_extras.opencode` fields such as `temperature`); the agent name comes from the filename. OpenCode does **not** read `.claude/agents`, so this native copy is required.
- **Rules** are copied into `.opencode/rules/` (or `~/.config/opencode/rules/`), but OpenCode does not auto-scan a rules directory — the files are inert until referenced. teamai therefore adds a `rules/*.md` glob to the `instructions` array in `opencode.json` and removes it again when the team's last rule goes away, editing only that one key and leaving your own `instructions` entries untouched.
- **Hooks** are delivered as an OpenCode *plugin*, not a settings-file entry — OpenCode has no `hooks` array; it auto-loads JS/TS plugins from **both** `~/.config/opencode/plugin/` and `<project>/.opencode/plugin/`. A plugin present in both dirs is loaded twice and would dispatch every event twice, so teamai keeps exactly one copy: `teamai-hooks.ts` in the user dir, which covers every project. Any project-scope copy left by an earlier layout is deleted on the next sync. This matches the other tools, whose `settings.json` hooks also live in HOME and gate on the `cwd` handed to `hook-dispatch`. The plugin subscribes to OpenCode's own events and shelling out to the same `teamai hook-dispatch` entry point every other tool uses. The event mapping mirrors the Claude built-in set: `session.created` → session-start, `session.idle` → stop, `chat.message` → prompt-submit, `tool.execute.after` → post-tool-use. The plugin forwards the same STDIN payload other agents send (`cwd`, `tool_name`, `tool_input`, `prompt`), and maps OpenCode's lowercase tool ids (`skill`, `todowrite`) back to the PascalCase matchers the handler registry expects. OpenCode cannot inject a hook's stdout back into the session, so hooks run purely for their side effects (status report / sync / update). Note that OpenCode *awaits* its named hooks (`chat.message`, `tool.execute.after`), so those dispatches briefly wait on the `teamai` subprocess before the agent continues; the errors are always swallowed so a hook can never fail the session. Server-pushed agent hooks (`teamai-agent-<slug>.ts`) install into the same user plugin dir.
- **MCP** servers live under the `mcp` key of the shared `opencode.json` (see the MCP section above).

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) is supported through its documented skills, instruction, and extension surfaces:

- **Scopes.** Project skills and TeamAI-managed rules are written to `.pi/skills/` and `.pi/rules/`. User-scope copies use `~/.pi/agent/skills/` and `~/.pi/agent/rules/`.
- **Instructions.** Project instructions use `AGENTS.md`; user instructions use `~/.pi/agent/AGENTS.md`. Pi also accepts `CLAUDE.md` as a project instruction file, but TeamAI keeps the canonical TeamAI block in `AGENTS.md`.
- **Hooks.** TeamAI generates one user-scoped `teamai-hooks.ts` under `~/.pi/agent/extensions/`. It maps `session_start` → session-start, `before_agent_start` → prompt-submit, and `agent_settled` → stop; `tool_execution_start` caches the tool's input, and `tool_execution_end` dispatches post-tool-use forwarding that cached input as `tool_input` (no separate result/output field — matching the OMP adapter's post-tool-use payload). Pi loads both user and project extension roots, so TeamAI never creates a project copy — a second copy would double-dispatch every event, the same single-copy policy as the OMP adapter. An older TeamAI-managed project copy is removed during the next sync, and injection never overwrites a same-named file that lacks the TeamAI marker. Pi has no settings file for self mode to commit, so a fresh clone still needs one `teamai init`/`pull` on that machine before Pi hooks are active there. Any targeted removal — the explicit `teamai hooks remove` command, or a scoped `teamai uninstall --agent pi` — deletes this shared extension outright, the same single-file removal semantics as the OMP adapter: Pi has no way to scope one shared file to a single project, so it doesn't pretend to preserve it for other projects while the extension keeps firing for this one anyway; files without the TeamAI marker are never removed. `teamai hooks list` always reports this global path. Pi profile overrides (`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported — same as the OMP adapter — and the default `~/.pi/agent/` layout is used. Because the extension is one shared file rather than a per-project one, a scoped removal is not durable in a multi-project setup: the next `teamai init`/`pull` in any other scope where Pi is still enabled re-creates it, and hook dispatch has no per-project exclusion check, so hooks can resume firing in the project that was just uninstalled from. This is the same trade-off the OMP adapter already ships with.
- **Team hooks boundary.** The Pi adapter installs only the built-in lifecycle bridge. Custom team hooks and built-in hook overrides declared in `hooks/hooks.yaml` are skipped with a warning. Full team-hook and per-project ownership semantics require a separate cross-adapter design and are deferred to a follow-up PR.
- **Server-pushed agent hooks.** HTTP-source hooks are installed as `teamai-agent-<slug>.ts` extensions in the same global extension directory. Unsupported lifecycle events are skipped with a warning.
- **MCP and subagents.** Pi has no adapter in this phase for MCP or TeamAI custom subagent files.

### Qoder

Qoder is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.qoder/skills/`, `.qoder/rules/`, and `.qoder/agents/`. Hooks and MCP servers are merged into the scope-specific `.qoder/settings.json`, preserving unrelated user settings. The paths match Qoder's user and project configuration contracts.

Qoder CN is a separate distribution that keeps its **user** directory at `~/.qoder-cn` instead of `~/.qoder`, so it is a separate built-in target (`qoder-cn`) rather than part of `qoder`. Only the user scope differs: user-scope resources go to `~/.qoder-cn/{skills,rules,agents}` and hooks/MCP to `~/.qoder-cn/settings.json`, while project-scope resources keep Qoder's `<project>/.qoder/` layout. It reads the same Claude-compatible resource formats, so content is identical and only the user-scope root changes. Install both editions and TeamAI syncs each one to its own user directory; neither needs a symlink.

### Kiro

Kiro is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.kiro/skills/`, `.kiro/steering/`, and `.kiro/agents/`, matching [Kiro's documented layouts](https://kiro.dev/docs/skills/) for workspace skills, [steering](https://kiro.dev/docs/steering/), and custom agents. Subagents are rendered as JSON so they work with both Kiro CLI 2.x and 3.x. Each rendered agent preserves Kiro-specific fields and custom hooks, and adds a managed `hooks.agentSpawn` command that dispatches TeamAI's `session-start` event when that custom agent is activated in an interactive CLI session. This verified CLI 2.x hook is embedded in `.kiro/agents/*.json`, not written to the standalone `.kiro/hooks/` surface introduced for IDE 1.x and CLI 3.x; Kiro's in-memory built-in default agent cannot be modified, and `--no-interactive` does not fire `agentSpawn`. MCP servers merge into the scope-specific `.kiro/settings/mcp.json` (see the MCP section above).

### ZCode

ZCode is available as a built-in target. Skills deploy to `.zcode/skills/` (ZCode also reads the central `~/.agents/skills/`, which the `agents` entry covers), and subagents deploy as Claude-style Markdown to `.zcode/agents/`. Hooks are merged into the shared `~/.zcode/cli/config.json`, preserving unrelated keys such as plugin state. Two ZCode specifics the writer handles for you:

- Config-file hooks are **disabled by default** in ZCode — TeamAI forces `hooks.enabled: true` so the entries it writes actually fire.
- On Windows, hook entries launch through a hidden **wscript VBS launcher** (`wscript.exe <teamai-hook-dispatch.vbs> <dispatch tail>`): wscript is a GUI-subsystem binary, so hook runs never flash a console window, and the launcher spools STDIN to a temp file so the payload reaches `hook-dispatch`. Timeouts are network-scale per event (180s session start, 60s stop / prompt submit, 30s post-tool-use) so a session-start dispatch carrying a repo pull is not killed mid-flight. Payloads containing multi-byte text may degrade at the launcher's ANSI-codepage spool step — identity fields are salvaged so degraded dispatches stay linked to the session; uninstall removes both the entries and the script.
- On POSIX, entries are plain `bash -lc <dispatch>` argv vectors and the launcher is not written; on both platforms the command tail is stored verbatim as the entry's last argv element, which is what managed-entry detection and the managed-hooks manifest match against.

These paths are verified against the ZCode desktop app: profiles created in its Subagents settings page land in `~/.zcode/agents/*.md`, and files placed there (e.g. by TeamAI) show up in the page's installed list. MCP servers deploy to `~/.agents/mcp.json` (user scope, Claude `mcpServers` shape — the same file ZCode's own MCP settings page reads). Project scope is not wired: ZCode stores workspace MCP under a different key (`mcp.servers` inside `.zcode/config.json`), which the Claude writer cannot emit. ZCode has no user-level rules directory convention, so rules are not synced.

### Oh My Pi

Oh My Pi (OMP) is available as a built-in target. TeamAI deploys skills, rules, and subagents to OMP's native directories — `.omp/skills/`, `.omp/rules/`, and `.omp/agents/` at project scope, and `~/.omp/agent/skills/`, `~/.omp/agent/rules/`, and `~/.omp/agent/agents/` at user scope (user-scope resources live under the agent directory `~/.omp/agent/`, a different prefix from the project one, so TeamAI switches prefixes with the scope). Instructions (`claudemd`) deploy to the matching `AGENTS.md`, and MCP servers merge into `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json` (Claude `mcpServers` shape — see the MCP section above). Skills are one-level `<name>/SKILL.md` bundles and TeamAI fills in a `description` on sync, which OMP's native skill provider requires to discover a skill. These paths follow OMP's documented discovery layout (verified against OMP 18.2.5). Hooks ride OMP's extension runner: `teamai pull` writes a single generated extension to `~/.omp/agent/extensions/teamai-hooks.ts` (never a project copy — OMP auto-loads both roots and would double-dispatch every event), which forwards OMP's `session_start` / `session_stop` / `before_agent_start` / `tool_result` events to the same `teamai hook-dispatch` entry point every other agent uses, gated on the session `cwd`. The `session_stop` handler returns nothing, so a dispatch can never force a session continuation, and there is no matcher-scoped post-tool-use pass because OMP's tool ids are lowercase (`bash`, `read`, …) and it has no `Skill` / `TodoWrite` tool. `teamai uninstall` removes the extension. OMP profiles (`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported; the default `~/.omp/agent/` layout is used.

### DeepSeek Harness

DeepSeek Harness (`dsh`) is supported for TeamAI skills and shared resources. DSH's official Claude-hook bridge is a profile plugin rather than a settings-file hook surface, so when a user-level `~/.dsh/` installation is present, `teamai init`, `teamai pull`, or `teamai hooks inject` writes a Claude-compatible hook config and a Cordis patch under `~/.teamai/dsh/`.

TeamAI prints the exact absolute patch path. Add that `--patch` flag to the command that starts your DSH profile, for example `dsh tui --patch "<printed-path>"`. This is a one-time launcher opt-in; `teamai hooks remove` and `teamai uninstall` remove the TeamAI patch while preserving other hook entries in the generated config.

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
teamai doctor --json   # Same diagnostics as JSON on stdout (CI, hooks, agents)
teamai stats           # Skill usage stats
teamai update --check  # Check for a CLI update without installing it
teamai update          # Check for and install a CLI update
teamai digest          # Generate the weekly team activity digest
teamai remove skills <name>   # Remove a resource (asks for confirmation)
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # Skip the prompt, for scripts and CI
```

`teamai doctor` exits with code 0 only when every check passes, and code 1 when any check fails. Before initialization, it reports the missing configuration without assuming a Git provider. The same checks run at the end of a manual `teamai pull`, minus the provider ones and minus any check that pull already reported in its own words on that run. A check marked informational — currently only `No stale env blocks left behind` — still counts toward `doctor`'s exit code, but a pull does not fold its failure into `Pull finished, but N check(s) failed`: a leftover file from an earlier install is cleanup, not a sign this pull broke anything, so it is still named but on its own, gentler line.

Besides the provider, clone, config and hook checks, `doctor` verifies what reached your machine. `<tool> is installed` fails when `enabledAgents` lists a tool that nothing would be delivered to, which is the case where a pull reports success and that tool receives nothing. It asks the same resolver the sync uses, so a tool that keeps its skills somewhere other than its tool root, as OpenClaw does with its workspace directory, is judged where the sync would actually write. It reports an installed tool as passing too, so `--json` carries one entry per enabled tool either way. The checks at the end of a pull cover the scope that pull resolved from the current directory; run `teamai doctor` in another scope to check that one. `Skills delivered to <tool>` compares the skills your role namespaces, tag subscriptions and exclusions resolve to against what is on disk for each installed tool: it reports a skill that was never delivered separately from one that arrived unreadable — `SKILL.md` missing, its frontmatter unparseable, or its `name` not matching the directory, which keeps the agent from ever discovering it. `Team docs delivered` compares the docs bundle against `sharing.docs.localDir`, which has one destination rather than one per tool; each expected document has to be a file that can be read, so a directory or a dangling link sitting on the name counts as missing.

`Rules delivered to <tool>` and `Agents delivered to <tool>` do the same for the other two per-tool resources, and both ask the handler where an item lands rather than deriving a path: a rule's filename and content change per tool (`.md` verbatim, `.mdc` with derived `globs`/`alwaysApply`, `.instructions.md` with `applyTo`), and an agent's destination comes from its render, with `targets:` deciding which tools are owed a copy at all. A delivered rule is compared with the bytes the handler renders for that tool, not merely read for the keys its tool needs: a `.mdc` whose `globs` no longer match the team rule's `paths:` applies to the wrong files while carrying a perfectly legal `alwaysApply`, and that reads here as `delivered from an older copy` — the same label as a body that drifted, because both landed successfully and are still wrong. An agent is compared with the bytes its render produces, so a copy left behind by an older spec — a plain pull skips a scope whose team repo has not changed, so it can sit there indefinitely — is reported as `delivered from an older spec` rather than passing as present. `Every team agent reaches a tool` names an agent that renders for no installed tool — usually a spec that does not parse, or a `targets:` list naming only tools you do not have. These two are `doctor`-only: they read every rule per tool and parse every agent, which would spend the budget the checks at the end of a pull run under.

Two tools do not read a rules directory, so a per-file check cannot speak for them and each gets one of its own. `Team rules are active in opencode` checks that `opencode.json` still lists the glob the pull owns under `instructions`: OpenCode does not auto-scan `.opencode/rules`, so without it every delivered `.md` is inert while the per-file check keeps passing. `Team rules are inlined in Hermes SOUL.md` compares the teamai-managed block of `SOUL.md` with what the team rules inline to, since Hermes reads standing instructions from that one file rather than from a directory — a deleted block, or one left on an older rule set, is a tool reading the wrong rules with nothing on disk to show for it.

`MCP servers delivered to <tool>` compares each server the team's `mcp.yaml` resolves for that tool against the entry in the tool's own config, and names any the reconcile skipped with its reason. The comparison is the entry, not the name: reconciliation leaves an entry teamai does not own alone, so a server of your own under a team name holds the key while the team's definition never arrives, and a stale copy is just as undelivered. Both are reported as `not the team's definition`, and only `teamai pull --force` replaces an entry teamai did not write. An unresolved `${VAR}` is reported here with the variable's name, which is otherwise said once during a pull and never again. An `mcp.yaml` that does not parse is not a team without MCP: it is reported as `Team MCP servers can be read` with the parse error, since it injects nothing into any tool and every run after the first is silent about it. `Env variables injected in shell profile` no longer stops at finding the marker comment: it checks that `env/env.yaml` parses and declares its variables under the `variables:` key (a plain `KEY: value` mapping parses as none, while an explicit `variables: []` is a configuration with nothing to deliver and fails nothing), that each one reached `env.sh` with the value `env.yaml` declares — a key left over from an older value exports it to every shell and MCP server until the next pull, and the comparison reads `env.sh` back through the generator's own inverse, so a multiline value quoted across several lines is matched rather than called stale — and that the injected block would actually load it — an unquoted Windows path degrades to something a POSIX shell cannot read, so `source` never runs and nothing says so. `No stale env blocks left behind` is a separate check: which file `pull` prefers has changed over time (Windows Git Bash's login shell reads `.bash_profile`/`.bash_login`/`.profile`, never `.bashrc`), and a pull only ever adds a block, never migrates an old one away, so a dead block from an earlier install or platform change can sit in another candidate file indefinitely. It names every such file (checking `.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login` and `.profile`, current and legacy spellings alike) and points at `teamai uninstall` to remove them — separately from delivery, so a working env block never reads as broken just because an old one is still lying around.

`Contributed learnings are published` fails while `teamai contribute` has notes queued that could not be pushed. A manual `teamai pull` does not repeat it at the end when the pull has already said it: the pull tries to publish the queue and reports the outcome itself, with the push error that made it fail — more than this check can tell you. If the pull never got that far, because the team repo failed to refresh, the check is printed as usual.

`--json` prints the same report as one object on stdout and routes every log line to stderr, so `teamai doctor --json 2>/dev/null` parses whole. The exit code is unchanged. Each check carries the fix suggestion it prints in human mode:

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

`scope` is `null` before initialization. `packages` is present only when the team repo declares packages, and carries the rendered report lines. `notes` appears only when there is an advisory — today, the Codex trust-gate reminder.

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

On Windows, the update check, installation, and hook refresh run without opening console windows.

### Usage reporting

By default, `teamai pull` commits session/usage stats into the team repo.
Pull waits up to 5 seconds for the reporting batch, then continues its other
work while reporting finishes. A late successful push still updates the local
reported snapshots. Skill usage is recorded per scope, in the data directory of
the project teamai is set up for where the session ran (or the user scope), so
each target reports only its own; a directory without teamai records none. A
target removes its usage events only after it confirms success; failed pushes
preserve them. The affected sync locks remain
held until reporting finishes, preventing another pull from racing the report.

This is best-effort reporting, not crash-safe delivery: termination between a
remote push and local acknowledgement can still cause duplicate statistics.
It does not provide durable per-target deduplication for partial multi-repo
reports. The 5-second wait limit does not cancel Git or force the CLI process
to exit while a subprocess is still running.

Teams that pull from a read-only remote (or simply don't want stat commits)
can turn this off in `teamai.yaml`:

```yaml
usageReport: false
```

### Git submodules

If your team distributes skills as git submodules, opt in with `submodules: true`
in `teamai.yaml`:

```yaml
submodules: true
```

On every pull, teamai runs `git submodule update --init` so submodule-based
skills are populated at the revisions pinned by the team repo (git-repo
backends only; the full submodule history is fetched, since a shallow fetch
cannot check out older pins). Disabled by default. If the update fails, pull
logs a warning and holds back the recorded revision, so the next pull
re-syncs and retries the update instead of skipping it. Note: submodule
fetching relies on the ambient git credentials — private submodules on hosts
authenticated by per-command token injection (rather than a configured
credential helper) will not authenticate.

### Post-pull scripts

Teams often deploy more than teamai's built-in surfaces (models a client
offers, machine-local installs, a PATH shim). `scripts.postPull` in
`teamai.yaml` declares a Node entrypoint teamai runs once a pull has fully
finished, for the team repo that owns this machine's deployment — the
project scope's repo when a project is active, otherwise the user scope's
(an inherited user scope brings resources and knowledge only, not deploys):

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

The path is relative to the team repo root; one that resolves outside it
(symlink included) is rejected. On the
session-start path the script runs as a child of the pull process and is
waited on under a fixed budget (`TEAMAI_POSTPULL_TIMEOUT_SEC` is exported so
the script can self-limit its heavy steps); on expiry the script is left
running rather than killed, and the next pull reconciles. An interactive
`teamai pull` launches it fire-and-forget into the terminal instead. A bad
path, a missing file or a failed spawn is a line in `~/.teamai/debug.log`
(`postPull: launched / exited / timed out`), never a failed pull.

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

If the review-status API returns a non-2xx response, write mode fails closed: the job exits without writing files, committing, or pushing to the team knowledge repo.

Comment mode also fails closed when it cannot list the existing marker comment, so a transient provider error cannot create a duplicate comment.

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

## Command Reference

| Command | Description |
|---------|-------------|
| `teamai init` | Initialize: OAuth login, link repo, register member, inject hooks |
| `teamai pull` | Pull team resources and inject into local AI tools |
| `teamai push` | Push local resources to a branch and open a Merge Request |
| `teamai packages [install] [target]` | Install declared npm packages and Claude plugins; with a target, also update `teamai.yaml`. Bare `teamai packages` installs everything; `teamai packages install <target>` adds one |
| `teamai status` | Show local vs team repo diff and resource counts, including namespaced skills and nested docs |
| `teamai contribute` | Share session experience to the team repo's `teamai-learnings` branch |
| `teamai recall <query>` | Search the team knowledge base (BM25 + graph-boost) |
| `teamai recall enable/disable/status` | Toggle or check recall state |
| `teamai recall promote [learningId]` | Promote a high-confidence learning to formal knowledge (skills/rules/docs) |
| `teamai recall maintenance` | Maintain knowledge base health: prune low-confidence learnings, writeback confidence scores, flag stale entries |
| `teamai import` | Import knowledge (`--dir`, `--from-repo`, `--from-org`, `--from-repo-list`, `--from-mr`) |
| `teamai codebase --extract [path]` | Extract code facts and build the local graph under `teamwiki/` |
| `teamai codebase --deep-enrich` | Generate deep knowledge docs from extracted evidence |
| `teamai codebase --reconcile` | Reconcile product documentation with extracted code knowledge |
| `teamai codebase --lint` | Knowledge graph health check |
| `teamai ci extract-mr --url <url>` | CI: extract knowledge from MR, post comments, write after merge |
| `teamai members` | List team members |
| `teamai projects` | Bind a working directory to one or more logical projects |
| `teamai roles` | Manage team roles and namespaces |
| `teamai tags` | Manage tag-based skill/rule filtering |
| `teamai skill exclude add/remove/list` | Manage skills excluded from local sync ([usage guide](#excluding-skills-you-dont-need)) |
| `teamai source` | Manage skill subscription sources (other teams or your org's shared repos) |
| `teamai remove <type> <name>` | Remove a resource and open MR |
| `teamai session save` | Record a privacy-scrubbed session summary to a monthly log (`--push` feeds `digest`) |
| `teamai digest` | Generate weekly team usage digest |
| `teamai doctor` | Diagnose configuration issues (`--json` for CI, hooks and agents) |
| `teamai uninstall` | Remove all teamai resources and hooks |

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
    enabled: true              # optional; false = no /teamai nudge after high-friction sessions
  intervention:
    correctionKeywords: []     # optional; extra course-correction words merged with the built-in zh/en/ja list
  webhooks:                    # optional; notify external endpoints on team events (see "Webhook notifications")
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # any of: session-start, session-stop, skill-use, push, pull, or "*" for all
        secret: my-signing-key # optional; enables the X-TeamAI-Signature header
        timeout: 5000          # optional; per-request timeout in ms (default 5000)
        retries: 3             # optional; retry attempts on failure (default 3)
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
toolRoots:                     # optional; per-machine tool roots (see below)
  claude: ~/.claude-work
```

#### Relocated tool roots (`toolRoots`)

A tool that can be told to keep its configuration somewhere else — Claude Code, through `CLAUDE_CONFIG_DIR` — reads nothing that teamai writes to the team-wide default. `toolRoots` names the directory that tool actually uses, keyed by the same tool id as `toolPaths`, and every path teamai resolves for it (skills, rules, agents, `CLAUDE.md`, settings, and the user-scope MCP config) moves there with it. Other tools are untouched, and so are project-scope paths: those hang off the project root, where a per-machine root has nothing to say. Hooks are the exception that makes this worth recording — they are injected into your home directory even in project scope, so they follow `toolRoots` in both.

`teamai init` fills it in for you: whenever `CLAUDE_CONFIG_DIR` is set, init records the directory it points at and prints it. That includes `CLAUDE_CONFIG_DIR=~/.claude`, which is not the same as leaving the variable unset — Claude Code reads `.claude.json` from inside the configured directory, so teamai writes the MCP config to `~/.claude/.claude.json` rather than `~/.claude.json`. `init` is also the only command that reads the variable, because it lives in one shell profile while teamai also runs from session hooks and other terminals; resolving it per run would make the sync target depend on who started the process. A re-init keeps a root that was recorded earlier, so running `init` from a shell without the variable does not send the sync back to the default. When a re-init does move the root, the hooks teamai injected into the previous root's `settings.json` are removed so that Claude stops syncing into the new one; the skills, rules and `CLAUDE.md` block written there are left in place and named in the output. A project-scope `init` that has no record of its own and no variable to read starts from the user-scope record, since the root is a fact about the machine and project hooks land in your home directory. To end a relocation, run `init` once with the variable set but blank (`CLAUDE_CONFIG_DIR= teamai init …`): the record is cleared and the old root released the same way. Along with the hooks, the old root loses the teamai-managed MCP servers and any gateway credentials the local agent delivered there; they are active configuration, unlike the skills and rules.

A root has to be somewhere teamai can recognize the tool at: a directory in your home other than `~/.config` itself (`~/.claude-work`), or a `~/.config/<name>` directory (a leading `~/` is expanded). Those are the two shapes the "is this tool installed?" check can look for; anything deeper, or outside your home directory, is refused with a warning rather than silently half-applied.

`import --from-claude` and skill-use tracking read the recorded root as well, so a relocated Claude Code's rules are importable and its skills count as installed.

`toolRoots` currently applies to `claude` only, and any other tool id is refused with a warning. A root is only honest for a tool whose every user-scope write goes through `toolPaths`; the other tools still write somewhere teamai resolves separately — OMP's extension directory, the Codex and Cursor co-author files, OpenCode's plugin directory — so moving their `toolPaths` entries would leave the rest behind. Copilot CLI has its own mechanism: set `COPILOT_HOME`.

If you set or change `CLAUDE_CONFIG_DIR` after initializing, `teamai doctor` reports it: the `Claude Code root matches CLAUDE_CONFIG_DIR` check (built only when this config syncs Claude Code) compares the variable against the root this config actually syncs to and tells you to re-run `teamai init` — or, for a value teamai cannot sync to, says why. With the variable unset, the check stays out of the report.

### Webhook notifications (`sharing.webhooks`)

Notify external endpoints when team events happen. Each endpoint declares a `url`, a `type` (`json`, `feishu`, or `wecom`), and the `events` it subscribes to; `secret`, `timeout` (default `5000` ms), and `retries` (default `3`) are optional.

**Events and when they fire:**

| Event | Fires when |
| --- | --- |
| `session-start` | An AI session starts |
| `session-stop` | An AI session ends (includes Copilot's `SessionEnd`) |
| `skill-use` | A skill is invoked |
| `push` | `teamai push` **actually completes a real push** — not on `--dry-run`, a cancelled selection, a no-change run, or a failed PR creation |
| `pull` | `teamai pull` completes a real (non-`--dry-run`) sync |
| `*` | Wildcard — subscribe to every event above |

**Payload.** Only whitelisted, non-sensitive fields are sent: `skillName` for `skill-use`, `sessionId` for session events; `push`/`pull` carry the event and metadata only. Raw tool input and tool output are **never** forwarded, and the whole body is passed through teamai's secret redactor before it leaves the machine.

**Signature.** When `secret` is set, each request carries `X-TeamAI-Signature: sha256=<hmac>`, an HMAC-SHA256 computed over the exact request body — so a receiver can verify authenticity. `teamai webhook list` and `teamai webhook test` inspect and exercise configured endpoints.

---

## Model profiles

Model profiles point Claude Code, Codex, OpenCode, CodeBuddy, and WorkBuddy at a shared model gateway. Nothing changes an agent until you run `teamai models switch`; after that, `teamai pull` keeps the switched agents on the team's latest catalog.

There are two sources, both in the same format:

- `team:<id>` comes from the team repository's `models/models.yaml`. It holds URLs and model IDs, never a key.
- `local:<id>` is a personal profile in `~/.teamai/models/models.yaml`, visible only on this machine.

Plain `<id>` works while it is unique; if a team and a personal profile share an ID, write `team:<id>` or `local:<id>`.

### Team catalog

Create `models/models.yaml` in the team repository:

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}          # placeholder; each member configures the real key locally
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3               # the first model is the default
          - deepseek-v4-flash
```

- `base_url` is the gateway root. TeamAI calls it directly for `anthropic` and adds `/v1` for the OpenAI protocols, which matches [TokenHub](https://cloud.tencent.com/document/product/1823/130078).
- `protocols` lists what the models in a group support: `anthropic`, `openai-chat-completions`, `openai-responses`. Put models with different protocol support in separate groups; each model ID appears once.
- `api_key` must be the literal `${API_KEY}`. Unknown fields, duplicate model IDs, and URLs with credentials, a query, or a fragment are rejected, and `teamai push` refuses an invalid catalog.

Which agents can use a profile follows from its protocols:

| Agent | Needs | What `switch` writes |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json`: gateway URL and key in `env`, every model in the `/model` picker, `opus`/`sonnet`/`haiku` mapped to matching gateway models (or the default) |
| Codex | `openai-responses` | `~/.codex/config.toml`: the default model and a `[model_providers.teamai]` block |
| OpenCode | any | `opencode.json`: one provider per protocol with every model |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json`: one entry per model |

The example above has no `openai-responses` group, so Codex is left alone; add that protocol once your gateway serves those models over the Responses API.

### Use a team profile

```bash
teamai models list                     # profiles, compatible agents, and where each is active
teamai models switch tokenhub          # asks for the key the first time
```

`switch` updates every installed, compatible agent. Narrow it with `--agent claude` (repeatable), pick the default model with `--model deepseek-v4-flash`, or preview with `--dry-run`.

To avoid storing the key, reference an environment variable instead:

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

Codex, OpenCode, CodeBuddy, and WorkBuddy then read the variable themselves. Claude Code cannot, so `switch` writes the resolved key into `~/.claude/settings.json`. There is no `--api-key <value>` option, because arguments end up in shell history and process lists. Key files are written with mode `0600`.

When the team edits the catalog, `teamai pull` re-applies it to the agents you switched to it.

### Personal profiles

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

Omit flags to be prompted. Edit a personal profile with `configure`: `--name`, `--base-url`, `--model` (adds models), and `--protocol` (serves the models over another protocol; combine with `--model` to limit it to those models). You can also edit `~/.teamai/models/models.yaml` directly. Personal IDs may not reuse a team profile's ID.

### Switching back

```bash
teamai models restore                  # every agent TeamAI switched
teamai models restore --agent codex
```

TeamAI changes only the fields and entries it manages and records what they were before its first switch; `restore` puts that back. If you change a managed field yourself (for example the gateway URL in Claude's `env`), later switches, pulls, and restores leave that agent alone. Picking another model with Claude's `/model` is not treated as a takeover. Codex's `~/.codex/auth.json` is never touched.

Claude notes: `switch` refuses while `settings.json` enables Bedrock, Vertex, or Foundry. It warns when the current shell exports `ANTHROPIC_*` values that differ from what TeamAI writes, because sessions started from that shell keep those values.

Other commands:

```bash
teamai models show tokenhub            # key source, gateway, models, agents
teamai models remove local:my-gateway  # agents keep their settings; restore still works
```

A full user-scope `teamai uninstall` restores managed model settings first and stops, keeping the record, if one cannot be restored. Project-scope uninstall leaves these machine-wide settings alone.

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
- TeamAI-managed model settings are restored first when ownership is still intact
- teamai hooks in AI tool settings
- The teamai rules block in CLAUDE.md (your own content is preserved)
- Team-synced skills, including OpenClaw workspace skills (your own skills are preserved)
- Team-synced rules
- Team-synced custom agents and CLI built-in agents (your own agents are preserved)
- The env block in your shell profile — every candidate file (`.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`) carrying a block that sources this scope's own `env.sh` is cleaned, not only the one file `pull` would choose today; a block sourcing a different scope's `env.sh` is left alone
- The `~/.teamai/` directory

### Uninstall a single tool (`--agent <tool>`)

`--agent <tool>` removes only that tool's teamai resources (hooks, CLAUDE.md block, skills, rules, team-synced custom agents, and built-in agents). The tool name is a key of `toolPaths` (e.g. `claude`, `codex`, `codebuddy`) and is matched case-insensitively. An unknown tool name aborts without deleting anything, lists the available tools, and exits with a non-zero status.

Shared resources (the env block, docs directory, and `~/.teamai/`) are removed **only when the target itself has teamai resources AND is the last tool still using teamai** — otherwise they are kept for the remaining tools. (So targeting a tool that has no teamai resources of its own is a no-op and leaves shared resources in place, even if it happens to be the only tool.)

The exclusion is durable: `uninstall --agent <tool>` drops the tool from `enabledAgents` and records it in `disabledAgents`, so a later `pull` (or another tool's session-start hook) will not resurrect its skills, rules, agents, CLAUDE.md block, or hooks. Running `init --agent <tool>` again clears the exclusion and re-enables sync for that tool.

The same `enabledAgents` whitelist (from `init --agent`) also gates CLI built-in skills/rules/agents and CLAUDE.md-class injects: an already-installed tool outside the list is neither written to nor deleted from, even if its root directory already exists. `teamai remove` respects the same whitelist for agents, rules, and skills, `teamai push` reads no rules or agents from a tool outside it, and `teamai pull` / `teamai mcp inject` respect it for MCP servers. Editing `enabledAgents` without `init` still invalidates the last-pull skip cache for newly added tools.

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --scope user --role <role_id> --force
teamai pull
```

---

## FAQ

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

Dashboard workspace selection supports installed project scopes and user scope. Linked worktrees share a project. The all-workspaces view shows all local sessions and the startup knowledge scope. Health report sections are integrated into Team Context and Team Improvement. Restart the dashboard to discover newly installed scopes.
