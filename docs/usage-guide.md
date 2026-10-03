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

`TEAMAI_GITLAB_HOST=git.example.com` also works without `GITLAB_URL`: the API then goes to `https://git.example.com`. When both are set they must name the same host, otherwise teamai stops before sending the token.

For an unknown host, `init` makes an anonymous GitLab sign-in page check with a three-second total timeout. If confirmed as GitLab, it stops before authentication, cloning, or writing configuration and asks you to set the instance URL and token, then retry. The check does not send tokens or follow redirects. If it cannot confirm GitLab, initialization continues with the generic `git` provider, which supports Git transport but cannot create repos or PRs/MRs automatically. Set `GITLAB_URL` explicitly for instances behind SSO, deployed under a subpath, or otherwise inaccessible to the check.

Members who only sync and never need the CLI to open merge requests can skip the token: see [plain Git with `--provider git`](#member-onboarding).

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
teamai residue and a `git worktree` of the same repo shares one partition. The first
`teamai pull` in a new worktree does a full sync into it, even when the team repo has
not changed since another checkout pulled. Until a worktree has pulled, `teamai push`
there stops if it finds a team rule or skill that differs from the team repo, since it
cannot tell a teammate's update from your edit. `teamai pull` replaces those files, so
copy any you edited somewhere safe, pull, put your edits back and push again. Per-agent
project roots (`.claude/`, `.cursor/`, `.codebuddy/`, …) are still created inside the
workspace. `teamai init` creates the root of each tool you choose, then ends with a
pull that fills it: name the tools with `--agent <tool>`, or, in a terminal without
`--agent`, pick them from the same picker single-repo mode uses (option 1, **Auto**,
is the tools installed under your home dir and the Enter default). The choice is
added to `enabledAgents`, so a re-run adds tools without dropping earlier ones.
Otherwise **SessionStart** creates the root of the tool that just opened: opening
Claude Code creates `.claude/`, then pull writes into it. A bare `teamai pull`, and a
non-interactive `init` without `--agent`, still skip tools whose project root does
not exist, so they never invent agent directories for tools you have not
chosen or opened in this project.

A new worktree does not wait for that first session. In project scope, `teamai init`
and `teamai pull` install a git hook in the repository's local git config, shared by
every worktree: `hook.teamai-post-checkout` and `hook.teamai-post-merge` (Git 2.54 or
later). Git runs it beside any `core.hooksPath` hook
manager and any `.git/hooks` script. When `git worktree add`, or an app that runs
the same checkout hooks, makes a new checkout, the hook creates the project roots of
`enabledAgents` (when that is empty, the roots the main checkout has) and pulls into
the worktree before the command returns, so the first session there already has the
team's skills, rules and MCP servers. That pull reads the team clone as it is when it
was fetched in the last 24 hours (and fetches it first otherwise), and subscribed
sources from their cached clones; a full `teamai pull --silent` then runs in the
background to fetch the team repo, sources, learnings and reports. A branch switch does nothing.
Hosts that skip checkout hooks need a setup step that finishes `teamai pull` before
the AI tool starts. For Codex CLI 0.160.0, create the checkout with `git worktree add`, run
`teamai pull` there, then launch `codex exec -C <worktree>`; its native
`codex exec --worktree` path skips `post-checkout`.
After `git pull` (`post-merge`), the hook fetches the team repo, waiting at most 5 seconds,
and delivers its changes before `git pull` returns; past 5 seconds, and for sources,
learnings and reports, the same background pull takes over. In single-repo mode it
delivers the knowledge `git pull` just brought, with no network. The hook prints nothing and always exits 0, so a failed pull never
fails the git command. A failure inside it (the team repo fetch failed, or stopped at the
5-second cap and the background pull did not finish it; another teamai process held the
project's sync lock longer than the hook waits, 5 seconds after `git pull` (including
single-repo mode) and 60 seconds for a new worktree; incomplete resource, hook or MCP
delivery) is written to `~/.teamai/debug.log` and recorded: `teamai doctor`
names it with its fix, and each interactive `teamai pull` mentions it until one completes. The
background pull retries, and a hook or interactive pull clears the record only after all startup delivery
stages succeed. `teamai doctor`
also reports whether the hook is installed and, when it is not, why. It follows the scope rules below: no project config, or one
that cannot be read, means no sync; an unreadable config's reason is kept in
`~/.teamai/debug.log`. The command is one `sh` line that runs
`teamai hook-dispatch <event> --tool git` with Git's arguments, finding `teamai`
through `~/.teamai/bin` as the agent hooks do.

With Git older than 2.54 and no `core.hooksPath`, teamai instead adds a block between
`# >>> teamai git hook` and `# <<< teamai git hook <<<` markers to `.git/hooks/post-checkout`
and `.git/hooks/post-merge`, right after the shebang, creating the script when there is
none; the script's other lines are kept. The block runs the same command, silently, and
does not change the script's exit status. With `core.hooksPath` set (a hook manager), or
a hook script that is a symlink or not an executable shell script, teamai writes nothing, and `teamai doctor`
advises: upgrade Git to 2.54 or later; or, if the team agrees to commit it, run
`command -v teamai >/dev/null 2>&1 && teamai hook-dispatch <event> --tool git "$@" >/dev/null 2>&1 || true`
from the post-checkout and post-merge hooks your manager defines (with `post-checkout` or
`post-merge` as `<event>`), wrapped in `sh -c '...'` when its config is not a shell script.
That line does nothing on a machine without teamai.
Existing hook contents and permissions are preserved. Reading or writing a hook can
fail: `init` and `hooks inject` propagate that error; a Git-started pull records it
and the next `teamai pull` retries.

Once Git is 2.54 or later, the next `teamai pull` installs the config hook and takes the
block out, so the hook does not run twice. `teamai pull --dry-run` says when it would
install or update the hook and writes nothing. `teamai uninstall` in the project removes
the `hook.teamai-post-checkout` and `hook.teamai-post-merge` entries and the marked
blocks; other hooks and script lines stay. A script left with only its shebang is the
one teamai created, and is deleted.

> **Upgrading from an older teamai?** The first `teamai init` / `pull` / `push` /
> `contribute` (or `import --from-mr`) after upgrading automatically migrates an existing `<repo>/.teamai/` into the partition
> (copy → verify → atomic switch), then leaves the old directory as `<repo>/.teamai.bak/`
> for you to delete once you've confirmed everything works. When another checkout of the
> repo already migrated, the old directory's queue of unpublished learnings moves into the
> partition's first, never into the backup. If the partition already
> exists but its `config.yaml` cannot be read, or is missing, the migration keeps
> `<repo>/.teamai/` and warns with the path: fix or restore that file (or move the
> config-less partition aside), and the next of those commands finishes the job.
> Until the old directory's data has moved, `contribute`, `import --from-mr` and
> `init` (except `--scope user`) stop with exit code 1 and save nothing, naming the
> cause: another teamai command holding its lock, a partition `config.yaml` as above,
> or an old queue that could not move.
> Deal with that, then run them again. `contribute --scope user` and
> `import --from-mr --output` do not write this project's queue, so they neither
> migrate nor stop. Read-only commands and the
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
| `--project <ids>` | Active logical project(s) from `manifest/projects.yaml` (comma-separated). Scopes which project resources and learnings this directory syncs. Pass `all` to activate every project the manifest declares. When omitted, an interactive `init` offers an optional project picker. See [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role) below |
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

When `manifest/projects.yaml` declares projects and `--project` is omitted,
interactive `init` asks which projects belong to this directory after role
selection. Enter comma-separated numbers to choose several; press Enter to keep
the directory project-less. Without an interactive terminal, init keeps the
empty project set and prints `teamai projects set <id>` as the follow-up. An
explicit `--project` skips the picker.

- **Learnings isolation.** `learnings/` at the repo root is shared with the whole
  team; a project's private learnings live under `learnings/<project-id>/` and
  only surface in `teamai recall` for members of that project. A directory with
  no active project sees the shared root only.
- **Not auto-activated.** Unlike a lone role, a lone project is not auto-selected
  — a member may legitimately belong to no project (they get the shared
  learnings root and the namespaces their role lists, such as `common`; with no
  role, no namespace skills).
- **Root skills arrive through a tag.** While the team uses roles or projects,
  the root `skills/` is the tag catalog: `teamai tags subscribe <tag>` delivers
  a root skill. When a pull removes skills that are no longer delivered, for
  example after picking a role or project, it names them in one line.
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
teamai projects set hai-inference --dry-run # Preview the selection without saving it
teamai projects members hai-inference # Who is registered on a project

# Admin: edit manifest/projects.yaml and open a PR (all support --dry-run)
teamai projects add checkout --namespaces common,checkout --name "Checkout"  # The first add creates projects.yaml
teamai projects update checkout --add-namespaces payments --remove-namespaces common
teamai projects remove checkout
```

`--namespaces` sets the same namespaces on every project resource type
(`knowledge`, `skills`, `learnings`, `agents`); `update` adds or removes them on
each type's own list, so a hand-edited per-type layout survives. Neither touches
`env`, `hooks`, `mcp`, `models` or `docs`: declare those by hand (see
[Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)),
because a member on an older CLI cannot read them. After
`projects remove`, a directory that still has the project active warns on its
next pull, falls back to role-only filtering, and has the project's deployed
skills, rules and agents cleaned up — as long as the project's content is still
in the team repo, since that is what identifies the deployed copies. Delete the
content in a later change, after members have pulled.

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
| Machine-local: `config.yaml`, `state.json`, search index (one per checkout), env backup, MCP manifests, the `reports-wt/` and `learnings-wt/` checkouts, the contribution queue (`pending-learnings/`) | `~/.teamai/projects/<slug>/` (**partition**, outside the repo, shared by every worktree) | local only | — |
| Disposable knowledge-PR worktree (`knowledge-wt/`) | `.teamai/` (gitignored; rebuilt on demand) | local only | — |

Git checks a branch out in one worktree only, so every checkout of the repo
shares the `teamai-learnings` and `teamai-reports` checkouts and the queue. An
older teamai kept them in each checkout's `.teamai/`. `init`, `pull`, `push`,
`contribute` and `import --from-mr` move that checkout's queue into the partition, and the first command that needs
a side-branch checkout removes the old one. An old checkout with uncommitted
changes is kept, and the command names it: nothing is published to or recalled
from that branch until you commit, move or delete those changes, and
`recall maintenance` and `recall promote` stop. Queued learnings stay queued
and recallable. A learning an older `import --from-mr` (0.25.0 to 0.26.0-beta.3) wrote into a
learnings checkout and never committed does not count: the next `pull` or
`contribute` (or an `import --from-mr` that queues a learning) queues and publishes it (in the project's
namespace, named as `contribute` names it) and says where it was, so the old
checkout can go. If the branch or the queue already has it, by its `source_mr`
or its content, it is deleted instead, and the message names the learning that
has it. Maintenance and promote also stop, naming the cause, when the
checkout cannot be created, such as when `teamai-learnings` is checked out
somewhere else.
A git-mode install of the same project keeps its checkouts at the same paths.
After switching modes, teamai refuses a checkout that belongs to the other
repository and prints the `git worktree remove` command that clears it: nothing
is published to it, indexed from it (its votes included) or rewritten in it
(`recall maintenance` and `recall promote` stop). Learnings still queued by the old install are moved
to `pending-learnings.<old kind>` in the same data home, never published by the
new one; `init` says how many and where, and deletes the search indexes built
for the old repository (the next `recall` rebuilds them). Re-running `init`
against another team repository of the same kind does the same, to
`pending-learnings.<kind>-<repo>` (for example
`pending-learnings.git-github.com-org-team-a`); the same repository written
another way (with or without `.git`, SSH or HTTPS) keeps the queue. Before it
clones the other team repository, or reuses a clone of it an earlier `init` left, `init` moves the old `config.yaml` to
`config.yaml.previous` beside it and says so: if `init` stops before it saves
the new config, every command asks for `teamai init` instead of running the old
team's config against the new clone. Run `init` again: it carries that config's
settings (agents, tool roots) from `config.yaml.previous`. When the old
install's `config.yaml` exists but cannot be read, nothing says whose the queue is:
`init` moves it to `pending-learnings.unknown`, names that file and deletes the search indexes. A checkout that had
not been upgraded yet keeps its old queue the same way: the next command there
moves it to `pending-learnings.self` and names the path. The other way round, when
`init --self` in one checkout switches a git-mode project and another checkout that
still has its old install takes the knowledge from main, the next `init`, `pull`,
`push`, `contribute` or `import --from-mr` there moves that install's queue to
`pending-learnings.git` and the rest of it (config, clone, env and the like) to
`<checkout>/.teamai.bak/`, leaving the knowledge in place. `teamai uninstall` lists every queue
with learnings not published yet before it asks to confirm.
A `contribute` or `import --from-mr` that queues its learning while a migration is
moving this checkout's data, or while `init` switches the project's mode or team repository, waits
for it (up to 3 seconds). If the install it started with has changed by then, it
saves nothing and exits 1 (`This project's teamai install changed while this
command ran`); run it again. If the other command is still at it after the wait,
it exits 1 the same way (`Another teamai command is moving this project's queued
learnings`). A learning queued just before the switch is set aside with the old
install's queue and never published to the new repository. This needs this
version on both sides: an older teamai's `contribute` running beside a migration
can still leave its learning in `.teamai.bak/`.
A checkout teamai cannot show to be this repository's is refused the same way and
never removed: one whose `.git` leads to a repository that was moved or deleted,
or one this repository no longer registers (its clone was deleted and cloned
again, as `init` does when it switches to another team repository at the same
path). Move it aside, or delete it if it holds nothing you need.

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
data into the partition automatically on the next `init`/`pull`/`push`/`contribute` (the
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

   `teamai push` scans all of these plus your AI tool dirs, and only surfaces genuine additions or edits (already-committed content is skipped). A rule or skill under `.teamai/` that matches an older version of the team's file, as it does when your branch is behind the default branch, is not an edit either: push skips it with a warning rather than revert a teammate's update. If you rename an agent's extension (e.g. `helper.md` → `helper.yaml`), delete the old file — `teamai push` won't remove it for you, and two files with the same stem would collide on pull.
4. **docs / hooks / mcp** are contributed by editing their file directly — they don't go through `teamai push`; a normal `git commit` + push ships them:
   - `.teamai/docs/` — team docs
   - `.teamai/hooks/hooks.yaml` — team hooks
   - `.teamai/mcp/mcp.yaml` — shared MCP servers

> **Heads-up on `env`.** In single-repo mode `.teamai/env/env.yaml` **is committed to main** (unlike standalone mode's per-machine env), so it travels to everyone who clones the repo. `env.yaml` stores plaintext key/value pairs — put only non-secret shared config there. Declare a secret without its value in `.teamai/env/secrets.yaml` (see [Team secrets](designs/team-secrets.md)) and keep the value in your own untracked environment.

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

**Plain Git, no platform token (`--provider git`):**

When the team repo is on a platform whose provider needs a token (for example self-hosted GitLab and `GITLAB_TOKEN`), a member who never needs the CLI to open PRs/MRs can use their existing Git authentication (SSH key or credential helper) instead:

```bash
teamai init https://gitlab.example.com/yourgroup/yourrepo --provider git
```

- `--provider` skips auto-detection and uses the named provider: `tgit`, `github`, `cnb`, `gitlab`, `gitcode`, or `git`. `git` runs no platform login or token check.
- The choice is saved in this machine's local config only. An existing `teamai.yaml` is not changed, so other members keep the team's provider. When `init` creates a new `teamai.yaml`, `--provider git` still records the provider `init` would detect without it. If the host is a self-hosted GitLab that is not configured, `init` stops and asks for `GITLAB_URL` rather than record `git` as the team default.
- `--provider gitlab` on a self-hosted instance still needs `GITLAB_URL` or `TEAMAI_GITLAB_HOST` (and `GITLAB_TOKEN`). Without either `init` stops, because the GitLab API would otherwise target gitlab.com.
- `pull` works as usual. `push` pushes the branch but cannot open a PR/MR, so open it on the Git host yourself; the command exits non-zero because that step did not run.
- Re-running `teamai init` without `--provider` returns to auto-detection.

**HTTP mode (read-only consumer):**

For users or agents that don't need git access and only consume skills/rules:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- Read-only mode: `push` / `contribute` / `remove` are not available, and `import --from-mr` cannot publish its learning (`--dry-run` and `--output` still work).
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

`teamai init` already injected Hooks into your AI tools and ended with a pull, so your first session has the team's skills, rules and MCP servers. **`teamai pull` runs automatically every time you start an AI session** — no manual action needed. In project scope, that SessionStart hook first creates the current agent's project root (e.g. `<project>/.claude` when Claude Code opens the repo) if it is missing, then pulls.

*(Note: Automatic sync on session start requires an agent that supports lifecycle hooks, such as [CC], Codex, GitHub Copilot CLI, Cursor, CodeBuddy, WorkBuddy, Qoder, Kiro, OpenCode, Oh My Pi, Pi, Hermes, or OpenClaw. Kiro runs the hook when a TeamAI-rendered custom agent is activated in an interactive CLI session; its in-memory built-in default agent is not writable, and non-interactive mode does not fire `agentSpawn`. For tools without a teamai-writable hooks surface such as JoyCode or Gemini CLI, run `teamai pull` manually.)*

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

A command with no `--dry-run` preview, such as `teamai init`, `teamai hooks remove`, `teamai models add` / `configure` / `remove`, `teamai bind-project` or `teamai codebase --extract`, refuses the flag: it prints `teamai <command> has no --dry-run preview, nothing was run` and exits 1.

A manual `teamai pull` ends by running the `teamai doctor` checks and printing each one that failed, with its fix — including whether the skills it just reported syncing are readable on disk for every enabled tool. It prints nothing when they all pass, and the exit code is unchanged. The SessionStart hook path and `--dry-run` run no checks at all, so session startup stays as fast as before. Provider checks (`gh`/`gf` authentication) are left to `teamai doctor`: the pull just used the provider.

**Pull keeps a skill, rule or agent you changed.** For each checkout, pull records what it wrote at each skill, rule and agent path. On a full sync, a copy that no longer matches that record is kept, and pull names it, while the copies of other tools still update. A skill counts as one copy: a change to any of its team files keeps the whole skill, and files only you added do not count. If the team version has not changed, pull prints ``Kept <path>: you changed it since teamai delivered it. Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.`` If it has, whether the team changed it or your [local model alias override](#local-override) did, pull warns and asks you to merge that change into your copy before you push it, and `teamai push` warns about that copy too, since the SessionStart pull runs silently. `--force` keeps these copies too, and `--dry-run` prints `Would keep <path>` for each. When the team removes an item, a copy you changed stays, and pull names it. There is no record before your first full pull with this version, so that pull overwrites as earlier versions did, and your changes are protected from then on. The same goes for a new worktree's first pull, and for a copy teamai never delivered to that path. `teamai remove` and installs from the local agent still rewrite the team rules without this check. An older CLI that saves state drops the record.

> Project scope is isolated by default. When the current working directory contains a project-scope `.teamai/config.yaml`, `pull` processes that project and skips user scope unless the local config has `inheritUserScope: true`; in that case it first refreshes the safe user-resource channel. Without a project config in the current directory, `pull` processes user scope. User `env`, MCP definitions, sources, reporting, and writes remain isolated in project mode. Hooks are the one exception: a project scope's built-in hooks are injected into your **HOME** tool settings (`~/.claude/settings.json`, …), not `<projectRoot>`, because they gate on the `cwd` handed to `hook-dispatch` and `~/.claude` always exists so the "installed tool" gate passes (see the Hooks section). The team's own hooks (`hooks/hooks.yaml`) for Claude Code and Codex go to the main checkout instead, ungated (`<main checkout>/.claude/settings.local.json`, `<main checkout>/.codex/hooks.json`), so every worktree of the project shares one copy. These paths follow the project `toolPaths`; Claude uses `settings.local.json` beside its configured settings file. For a bare repository, each worktree keeps its own copy because there is no main checkout; other tools keep them in HOME, run only when the `cwd` is inside the project. In a directory with no teamai config (no project config and no user scope), the team hooks do nothing: no reminders, and no session or skill usage is recorded; only machine-level work runs (the CLI update check, the session-start pull, the local agent, and package hints a pull stashed). For the team hooks and skill usage, a project config that exists but cannot be read counts as none, never as the user scope or as a lower-priority project config (such as a legacy `.teamai/config.yaml`) behind it. `pull` follows the same rule: it syncs no scope there, prints ``Nothing was synced: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` and exits 1 (with `--silent`, it prints nothing and still exits 1); a session start there runs no pull, seeds no agent directory and stashes no package hint. A hook whose `cwd` was deleted (a session that outlives its worktree) keeps the scope its session last recorded, so the session's last events and skill uses stay with the project, and its share reminder follows the project's settings, instead of the user scope's. This needs the session's earlier events in the local event log, which compaction trims to active sessions, and does not cover Copilot, whose events record no directory. Self single-repo mode keeps its hooks in the business repo so they travel on clone.

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/<namespace>/` and `claudemd/<namespace>/` follow the `knowledge` namespaces, and a `docs/<namespace>/` follows the `docs` namespaces once one is declared (see [Docs](#docs)); `agents/<namespace>/` follows the role's `agents` namespaces (see [Agents Resource Type](#agents-resource-type)). `learnings/` at the root is shared with everyone, while `learnings/<project-id>/` subdirectories sync only for the directory's active projects (see [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role)).

**A namespace item replaces the root item of the same name.** With a role or project configured, an item in an active namespace is delivered instead of the root item that has the same name. The whole item is replaced; nothing is merged:

- A skill replaces the root skill of the same directory name, including a root skill you receive through a tag. The install removes the files of the version it replaces. Files that no team version of the skill has stay.
- An agent replaces the root agent of the same file stem.
- A rule replaces the root rule of the same first-level file name: `rules/<ns>/<name>.md` replaces `rules/<name>.md`, in Hermes' `SOUL.md` block and the rules Codex's session-start hook adds too. Deeper paths such as `rules/<ns>/<dir>/<name>.md` replace nothing, and neither does a namespace rule your tag subscriptions leave out. In rule directories you share with rules of your own (JoyCode, OMP, Pi, Copilot), the replaced root rule's copy is removed only while it is what teamai delivered (the current root rule, or the one of your last pull); an edited copy stays, and each pull names it, since the tool loads it beside the namespace rule.
- A `claudemd/<ns>/<name>.md` file replaces `claudemd/<name>.md` in the managed block.

When the namespace stops being active, the next pull delivers the root item again. If two active namespaces define the same skill or agent name, they compete for one installed file, so pull reports an error that names both files, does not update that type in that run, and keeps what is installed (for skills, recall keeps the ones it had indexed too); the other resource types still sync. Two active namespaces with the same rule or shared-instructions name are both delivered, because each keeps its own place (`rules/<ns>/` locally, its own section of the block); only the root one gives way. `push` writes an edit of a replaced item back to its namespace, never to the root, and recall indexes the skills and rules you receive rather than every one in the repo. A replacement that cannot be used replaces nothing: a skill directory without `SKILL.md` is not delivered and pull names it, and while an agent file does not parse the agent it would replace stays installed. `teamai doctor` lists each replacement as a note. Without roles or projects nothing changes: every namespace is delivered beside the root, and `doctor` lists each name the team repo defines more than once.

Put shared content that a project may need to override at the root, not in a namespace every role activates. A root item gives way to an active namespace; a namespace item never does. For example, keep the company's `rules/code-style.md` at the root, and a checkout project that needs different conventions adds `rules/checkout/code-style.md`. Members with `checkout` active get the project's version, and everyone else keeps the shared one. Had the shared rule lived in `rules/common/code-style.md`, a checkout member would receive both.

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
teamai skill exclude add using-superpowers --dry-run # Preview without changing config or pull state
teamai skill exclude add using-superpowers
teamai pull                    # Remove it from local AI tools
teamai skill exclude list

teamai skill exclude remove using-superpowers --dry-run # Preview without changing config or pull state
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

Before scanning, `push` refreshes unedited old rule copies from the team repo. For Copilot, it compares Markdown bodies independently of the generated `applyTo` header and renders updates in `.instructions.md` format. Local body edits are preserved. This applies to project rules and user rules under `COPILOT_HOME`. Each copy it refreshes is recorded as delivered, so the next `teamai pull` still updates it instead of keeping it as your change.

When only the team's `paths` change, `push` also refreshes Copilot's `applyTo` if the local file still matches a recorded version's generated copy. A locally edited header is preserved in this case.

Rule pre-sync skips tools excluded by `enabledAgents` or `disabledAgents`, even if their configuration directories still exist.

```bash
teamai push          # Scan for new/modified resources, create an MR
teamai push --all    # Skip confirmation, push directly
teamai push --role pm  # Push into the pm namespace (skills/pm/, rules/pm/, agents/pm/)
teamai push --branch feature/gitee-destination  # Use an explicit destination branch
```

`--branch` names the branch that receives a new push; an existing open PR is always updated on its recorded branch. TeamAI refuses to start a push when the team-repo clone has user changes (modified, staged, untracked, or conflicted files); TeamAI-owned `teamai.yaml`, the env files `teamai env add` edited, and sync-lock state are handled separately. Commit or stash other local changes first.

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
- A local agent is an edit of the team agent it was delivered from: one in an active namespace first, then one this machine placed, then the shared-root agent either of them replaces. Only when none exists does `--role`/`--project` decide, and the agent is new in that namespace; if that namespace already holds an agent of that name, the agent is skipped rather than written over it, as a rule would be. Two active agents of one name stay ambiguous and are skipped, flag or not. The same agent name may exist in several namespaces, so a copy in an inactive one you did not name never blocks publishing yours. A placed agent that changed on the team since this checkout last synced it is held, because agents have no pre-push sync. Pull keeps your changed copy, so save your edit, delete the copy, run `teamai pull --force`, reapply the edit and push again. In single-repo mode, a root copy under `.teamai/` that matches an older version of the file it was placed at is held too: nothing refreshes it, so it is an old copy rather than an edit
- A new resource is never placed on top of one that is already there. If the resolved namespace already holds that name, the push stops and names the file: pull and edit the existing copy, rename yours, or pick another namespace with `--role <ns>`
- An agent whose namespace is not active here stays editable through its placement record, and `pull` delivers it for the same reason, so your copy tracks the team file. It replaces a shared-root agent of the same name, as an active namespace's agent would. An active namespace holding that name wins: that agent is the one deployed here
- A resource awaiting review in an open PR keeps that PR's destination — unless this push names a namespace other than the one recorded (the shared root counts as one), in which case the flag decides, the open PR is left untouched, and the collision is reported
- If the team repo cannot be refreshed at the start of a push, `--project` stops instead of placing by a possibly stale `manifest/projects.yaml`; so does any new resource placed without `--role`, because its destination comes from that clone (`manifest/roles.yaml`, its absence, or the namespaces the repo already has). Fix the pull and retry, or name the namespace with `--role <ns>`. `push` also stops, and pushes nothing, when this machine's placement records cannot be updated and saved
- A placement record is written only once the pushed file has landed on the default branch, so a PR closed without merging leaves none behind, whatever became of its branch. It is dropped again when the team deletes that file. Without roles or projects it is also dropped when a shared-root file of the same name appears (your root copy then follows that file, and `pull` warns). With a role or project, the placed resource replaces that shared-root one here instead, and the record stays. `push`, `pull` and `remove` settle this before they read the records. `teamai remove` itself leaves the record alone: its deletion reaches the default branch only when its PR merges, and until then a retried `remove` still resolves the bare name to the namespaced file. If the file reached the default branch with content other than what you pushed (for example a reviewer changed the PR before a squash merge), it is not recorded, and push says so once; run `teamai pull` and edit that file as the team file it now is
- Your own copy of a rule you published into a namespace stays at the rules root. When that namespace is active here, `pull` updates that copy instead of writing a second one under `rules/<namespace>/`; when it is not, `pull` leaves it alone. With a role or project configured, a shared-root rule of the same name is not delivered onto that copy: your placed rule replaces it. It is swept only once the team file it was placed at is gone

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

Most tools get one file per rule in their rules directory. Codex, `codex-internal` and `tcodex` read no rules directory (`.codex/rules/` holds Codex's own `*.rules` command policies), so `pull` writes no rule file for them. In user scope the team rules go into a `<!-- [teamai:team-rules:start] -->` block of the tool's own `AGENTS.md` (`~/.codex/AGENTS.md`, `~/.codex-internal/AGENTS.md`, `~/.tcodex/AGENTS.md`; a `toolRoots` entry moves it), which only that tool reads. In a project their session-start hook adds the project's team rules to each session instead: the project `AGENTS.md` is the owners' file, and other tools with a rules format of their own read it too. Hermes gets the same text in its `SOUL.md` block. Frontmatter is dropped, so a rule with `paths:` applies everywhere there, led by an `Applies to files matching: <globs>` line. Codex runs the hook again after a compaction or a clear, and adds nothing when it resumes a session, which already holds the rules. A subagent Codex spawns gets them through the `SubagentStart` hook. The public Codex runs only trusted hooks. teamai trusts the hooks it writes automatically; if automatic trust is disabled or fails, approve them in `/hooks` to receive the project rules.

The culture, shared-instructions and recall blocks follow the same split. In user scope they go to that same `AGENTS.md`, and your own content outside the markers is kept. In a project the session-start hook adds them with the rules, and `pull` leaves the project `AGENTS.md` unchanged.

> A `toolPaths` in the team `teamai.yaml` replaces the built-in defaults whole. A team that sets it should give each Codex-family entry `userScope.claudemd: .codex/AGENTS.md` (`.codex-internal/…`, `.tcodex/…`) for the user-scope rules and blocks, and drop its `rules` path, since Codex never reads that directory. A top-level `claudemd` would put the blocks back in the project `AGENTS.md`, so leave it out. In a project the hook needs only the entry's `settings` path, where it is installed. The `codex` entry also needs `mcpProject: .codex/config.toml` for the project's team MCP servers.

> Upgrading from a release that copied rules to `.codex/rules/`: the next `pull` removes the `.md` copies teamai delivered there, including `teamai-recall.md`. Cleanup follows the recorded `toolRoots` location and checks both a publisher's bare local filename and its namespaced copy. A copy you edited is kept and named in a warning, and the `*.rules` files are never touched. A copy of a rule the team has since removed is deleted only if it matches its recorded delivery hash; without that record, it is kept and named too. The same pull adds `additionalContextLimit: 0` and a `SubagentStart` entry to the teamai hooks in `hooks.json`, which teamai then trusts again in the public Codex (see [Hooks](#hooks)).

### Env, hooks and MCP servers by namespace

Env variables, team hooks and MCP servers are each a list file in the team
repo's root, shared with everyone, plus one file per namespace:

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml              root, shared
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml         only where <ns> is active
```

A namespace is declared the same way as for skills and agents, under
`resources:` of a role in `manifest/roles.yaml` or a project in
`manifest/projects.yaml`, each type with its own key. A member's active
namespaces are the union of their roles' and their directory's projects':

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env:   [checkout]
      hooks: [checkout]
      mcp:   [checkout]
```

- **Override.** An active namespace entry replaces the root entry of the same
  name, whole: a variable by `key`, a hook by `id`, a server by `name` (its
  `command`, `args`, `env` and `tools:` together; an override without `tools:`
  reaches every tool). There is no field merge.
- **Conflicts stop the type, not the pull.** The same name twice in one file,
  the same name in two active namespaces, or an active file that does not parse
  or cannot be read means that type is not applied this run: what is installed stays as it is, and
  the warning names the file(s) and the fix. Hooks and MCP no longer remove every
  managed entry when their file is invalid. The built-in hooks are still
  installed where missing, so a first `teamai init` gets the session-start pull that applies
  the fix later; when `hooks/hooks.yaml` itself does not parse, they get their
  defaults, and only in a tool that has no teamai hook yet.
- **Deactivating** a namespace (`teamai projects set`, `teamai roles set`)
  restores the overridden root entries and removes the namespace-only ones on
  the next pull, `Already synced` included. `env.sh` is rewritten even when
  `env/env.yaml` is missing or empty.
- **Directory names** match a declared namespace case-folded, as for docs:
  `env: [checkout]` reads `env/Checkout/env.yaml` on every filesystem, and
  `env add --project checkout` writes to that file.
- **MCP `${VAR}`** resolves from the same resolved env set.
- **Legacy mode** (a member with no role and a team without `projects.yaml`)
  reads the root files only, as before; `teamai doctor` lists a name the root file
  repeats.
- **Where a value comes from.** `teamai env list`, `teamai mcp list`,
  `teamai hooks list` and `teamai list <env|hooks|mcp> --source repo` show each
  entry's namespace and whether it overrides the root, and name every entry that
  is not delivered, with why; `teamai status` counts per namespace and names
  them too; `teamai doctor` lists each override as a note. A variable takes your
  value for this team when you set one with `teamai env set KEY`, else the file's;
  the environment doesn't override either, and `env.sh` exports that value (not one
  set with `--from-env`). `teamai env list` and `teamai list env` show that value
  with where it comes from, `team` or `env.yaml`.
- **Upgrade every member first.** teamai 0.25.0 and the 0.26.0 betas reject a
  `resources:` key they do not know, so declaring `env`, `hooks` or `mcp` breaks
  their pull. From this version on, an unknown `resources:` key only warns, and
  `teamai roles` and `teamai projects` keep it when they save the manifest.

The per-entry keys these files replace:

| Key | On | Now |
|---|---|---|
| `projects:` | env, hooks, MCP | removed: the entry reaches nobody; pull, the list commands and status warn with the file to move it to |
| `roles:` | env | removed, the same way |
| `roles:` | hooks, MCP | deprecated: still filters for one minor release, as in 0.25.0, including a name the root file repeats under different `roles:`; pull warns and `teamai doctor` has a check, both naming every target file |

There is no automatic migration: move each entry into the namespace file the
warning names, and drop the key.
When `teamai env add` updates an existing variable that still carries a removed
per-entry `projects:` or `roles:` key, it keeps that key and warns that pull
will not deliver the variable, naming the namespace file to move it to.

An entry with any other key its schema does not know, such as a mistyped `role:`,
reaches nobody as well, and pull, the list commands, status and `teamai doctor` name the
file, the entry and the key. Correct the key or remove it. A key that a later
teamai version adds is unknown to an older one too, so upgrade every member
before the team uses a new entry key.

A hooks or MCP file that has none of its top-level keys, such as `server:` for
`servers:`, is treated like a file that does not parse: pull keeps the installed
servers or hooks, and pull and `teamai doctor` name the file, the keys found and
the key expected. An extra top-level key next to `servers:` or `hooks:` is ignored.

### Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add API_ENDPOINT https://checkout.internal --project checkout   # the project's env namespace file
teamai env remove API_ENDPOINT --role checkout                          # env/checkout/env.yaml
teamai env list
teamai push
```

Variables live in the team repo's `env/env.yaml`, and per namespace in
`env/<ns>/env.yaml` (see [Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)).
`teamai env add` and `teamai env remove` edit the root file, or with
`--role <ns>` / `--project <id>` that namespace's file; `--project` uses the one
env namespace the project declares, and `--role` warns when no role or project
declares that namespace, since its file then reaches nobody. Neither command
edits a file that does not parse, and `--project` changes nothing when the team
repo cannot be refreshed, since a stale `manifest/projects.yaml` may name the
wrong namespace. `teamai push` picks up a change to any of them.

```yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint        # optional
```

**Secrets.** A secret the team needs is declared with no value, in
`env/secrets.yaml` or a namespace's `env/<ns>/secrets.yaml` (active like
`env/<ns>/env.yaml`, and a namespace entry replaces the root entry with the same
key). Each member keeps the value on their own machine.

```yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope   # optional
    url: https://github.com/settings/tokens     # optional: where a member gets one
```

```bash
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai env remove GITHUB_TOKEN        # a key env.yaml does not set; --secret for one both files carry
teamai push
```

`teamai env add KEY --secret` declares a key, or updates its description and url,
in the root file or, with `--role` / `--project`, the namespace's; it takes no
value and prints none.

Each member sets their value for this directory's team, never as an argument:

```bash
teamai env set GITHUB_TOKEN                               # prompts, without echo
teamai env set GITHUB_TOKEN --stdin                       # from a pipe
teamai env set GITHUB_TOKEN --from-env WORK_GITHUB_TOKEN  # read from that variable when used
teamai env set GITHUB_TOKEN --global                      # for every team on this machine
teamai env unset GITHUB_TOKEN [--global]
```

`env set` accepts a key the scope declares as a secret or, without `--global`, an
`env.yaml` variable it receives, and stores the value in
`~/.teamai/secrets/teams/<hash>.json` (mode `0600`), one file per team
repo, named by the team repo URL in your `~/.teamai/config.yaml` (not `teamai.yaml`'s `repo:`) so renaming `team:` keeps it; with `--global`, in `~/.teamai/secrets/machine.json`, for every team on the
machine, and a value set for a team still wins. Outside any scope, `--global`
accepts any valid key and notes that no team declares it yet. A value stays the
kind the key had when you set it: once the team stops declaring a secret that
`env.yaml` also sets, your value is not used for the variable, and `env list`
says to run `teamai env unset KEY`, then `teamai env set KEY`.
`teamai env list` and `teamai list env` show each declared secret as
`team` (you set it for this team), `global` (you set it for the machine),
`environment` (your own environment has a value for it), `missing`, or
`unreadable` (your values file can't be read), and never show a value, `--reveal` included. A key declared as a
secret and also set in `env.yaml` is a secret: its `env.yaml` value is not
exported to `env.sh` or listed. A secrets file that cannot be used is not read
as "no secrets": `env.sh` and the MCP servers keep what they had, `pull` warns,
`env list` and `mcp list` exit non-zero (`env list` then shows no variable
value, since any of them may be a secret), and `teamai doctor` fails a check
naming the file. A values file that can't be read fails
`Your team secret values can be read`. `teamai push` picks up a
change to any secrets file. See [Team secrets](designs/team-secrets.md).

A CLI such as `gh` or `glab` gets this directory's variables and secrets when it
runs under `teamai env exec`, which finds the scope the same way for every
worktree of a project:

```bash
teamai env exec -- gh pr create
teamai env exec -- glab mr list
```

The command inherits your environment, overlaid with the scope's `env.yaml`
variables and its secrets in the [resolution order](designs/team-secrets.md#resolution);
a declared secret with no value for this scope is removed from it. Put `--`
before the command: without it, teamai would read the command's flags as its
own, so it says so and exits 2. A missing secret prints the `teamai env set`
line on stderr and the command runs anyway. Everything teamai prints goes to
stderr, and the exit code is the command's. With no teamai config here, the
command runs with your environment and a notice. No value is written to disk.
See [Running a CLI with `env exec`](designs/team-secrets.md#running-a-cli-with-env-exec).

When the scope declares secrets, the session-start hook tells the agent which
keys exist, with their `description`, and to run the CLIs that need them through
`teamai env exec --`. Agents whose tool discards hook output get the same rule
from the teamai core skill. An agent never asks for a secret value: when one is
missing, it asks you to run `teamai env set KEY` in your own terminal. See
[Telling the agent](designs/team-secrets.md#telling-the-agent).

A variable that no longer reaches this directory is removed from `env.sh` on
the next pull, even one that reports `Already synced` because the team repo has
not moved. Until that pull runs, `teamai doctor` reports a variable that
`env.sh` still exports, so the previous project's secrets are not left live in
silence.

The shell profile keeps the user scope's teamai block alongside one project block: a pull in a project-scoped directory replaces the previous project's block and leaves the user scope's in place. The user block comes first, so a project value wins on a key both define. A machine that pulls in several project-scoped directories therefore ends up with the user scope's variables plus the last-pulled directory's in new shells. Each directory's own `env.sh` stays correct; the profile points only at the last project's.

On `pull`, when `injectShellProfile` is enabled (default), the env block goes into `~/.zshrc` if `$SHELL` is zsh, otherwise `~/.bashrc` — except on Windows: `$SHELL` is normally unset there, and Git Bash starts as a *login* shell that never reads `.bashrc`, so teamai instead prefers an existing `~/.bash_profile`, then `~/.bash_login`, then `~/.profile`, falling back to `~/.bashrc` only when none of them exist (a zsh installed via MSYS2/Cygwin, which does set `$SHELL`, still resolves to `.zshrc`). This matches Git for Windows' own fallback in `/etc/profile.d/bash_profile.sh`, whose guard is `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]` — it only synthesizes a `.bash_profile` that sources `.bashrc` in that same one case, which is why a stray `~/.profile` (even one that just sources something else, e.g. `~/.local/bin/env`) is enough to make `.bashrc` alone go unread. Override the target file with `sharing.env.shellProfilePath` in `teamai.yaml`.

Every pull re-runs this order to find the file the current environment actually reads, then follows every reference from it to one of the other four candidate filenames — transitively, through as many hops as it takes — looking for a candidate that already carries the block, rather than duplicating it. When no file along that chain carries this scope's block yet, the first one carrying another scope's block is used, so the user scope's block and a project's end up ordered in one file rather than split across two. A chain through a file outside that fixed set of five (e.g. a custom `~/.config/shell/profile` some setups source instead) is not followed. This is what keeps the Git-for-Windows bootstrap above from moving the target out from under it: that same guard condition means a first pull into `.bashrc` leaves the exact state that makes the next login shell auto-generate a `~/.bash_profile` sourcing it, and without following that forwarding relationship the next pull would prefer the newly-created file and inject a second block there, leaving the original — still working, just loaded further away — reported as a dead leftover. The same reasoning covers a plain `.profile` that flat-guards a source of `.bashrc` for interactive shells (`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`), two hops from whatever a login shell reads first.

Only two literal line shapes count as a real reference, though: a bare `source X` / `. X` on a line by itself, or the exact self-referential existence guard Git for Windows itself generates, `test -f X && . X` / `[ -f X ] && . X` (tested and sourced path the same file), also on a line by itself — in both cases `X` must be an unquoted `~/name` or an unquoted-or-double-quoted `$HOME/name` (never a quoted `~`, never a single-quoted `$HOME`: a shell does not expand either, so a reference that looks right there would source a literal, nonexistent path). Anything else — a trailing redirection or extra argument on the source itself, an `||` fallback, an unrelated `&&`-chained command, a condition this can't independently verify — is not recognized, and falls back to the order-based pick rather than being guessed at. This is a deliberately narrow, closed set of two forms rather than an attempt to parse arbitrary shell conditionals: matching everything a real shell script could do to make a line conditional (or to disguise one as inert text) needs an actual shell parser, and no fixed-size grammar ever finishes that job. Nothing inside an `if`, `for`/`while`/`until`, `case`, `select`, a function body, or a `(...)`/`{...}` group counts, however it's guarded — none of those are guaranteed to run (a subshell or brace group's body may always run, but its exports never reach the caller either way) — which also means the standard Debian/Ubuntu `.profile` template (the same source, but nested two `if`s deep, checking `$BASH_VERSION` on the way) is not recognized and falls back to the order-based pick. Nothing textually after an unconditional, top-level `return` or `exit` counts either, since control never reaches it. Anything this can't resolve one way or the other, and a block sitting in a candidate nothing in the chain actually reaches, is never preferred over the order-based pick — otherwise a stale block left by a pre-#682 install would outrank the correct file forever, silently reintroducing #682 on upgrade.

`doctor` (and the check `pull` runs automatically afterward) also flags a teamai env block left behind in a *different* candidate file — e.g. a block a pre-#682 install wrote to `.bashrc` before this file-selection logic changed — even if that block is broken and was never functional. `teamai uninstall` removes it.

### Docs

Place documentation in the team repo's `docs/` directory; after pushing, team members will automatically receive it on their next `pull`.

**Docs by namespace.** A top-level `docs/<ns>/` becomes a namespace once any role or project lists it under `resources.docs`. From then on it reaches only the members who have it active (their roles' and their directory's projects' namespaces); everyone else stops receiving it. A `docs/<dir>/` that no role or project lists stays shared, so existing subdirectories keep reaching everyone:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]     # docs/checkout/ only where checkout is active
```

- There is no override: each namespace is its own subtree, so a namespace file never replaces a root one.
- When a namespace stops being active for you, the next pull removes its local docs that still match the team copy byte for byte, or an earlier team version (the team edited it after you received it). A doc you edited is kept, and the pull prints a line naming it. A local file there that the team repo does not have is removed, as anywhere else in the docs mirror.
- `team-codebase` cannot be a docs namespace: `docs/team-codebase/` is the legacy codebase output. A manifest that declares it fails to load.
- `recall` and `teamai doctor` use the same filter: recall indexes only the docs you receive, and `Team docs delivered` does not expect a namespace you do not have.
- Legacy mode (no role and no `projects.yaml`) delivers all of `docs/`, as before.

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
```

`requires` is resolved from `PATH`. On Windows a name also matches a `PATHEXT` suffix (`uvx` matches `uvx.exe` / `uvx.cmd`).

A project or role scopes servers with `mcp/<ns>/mcp.yaml` (see
[Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)):
a server there reaches only members with that namespace active, and replaces the
root server of the same name. Scoping by namespace is what keeps the cost down: a
team with five projects and three servers each would otherwise give every member
fifteen server processes and fifteen tool lists in the context of every session.

`teamai remove mcp <name>` follows the same convention as `push`: it removes the
server from `mcp/mcp.yaml` when that file defines it, otherwise from the one
`mcp/<ns>/mcp.yaml` that does. `--role <ns>` or `--project <id>` picks a
namespace file instead, and is required only when several namespace files, and
not the root, define the name. While an MCP file does not parse, a bare name the
root file does not define removes nothing, because the broken file may define
it; fix the file or pass `--role` / `--project`. A flag that names the broken
file says so instead of reporting the name as not found.

Where each tool's servers land:

| Tool | User scope | Project scope |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json` |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/mcp.json` | `<project>/.mcp.json` |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| copilot | `$COPILOT_HOME/mcp-config.json` | `<project>/.github/mcp.json` |
| codex | `~/.codex/config.toml` | `<project>/.codex/config.toml` |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| qoder-cn | `~/.qoder-cn/settings.json` | `<project>/.qoder/settings.json` |
| kiro | `~/.kiro/settings/mcp.json` | `<project>/.kiro/settings/mcp.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |
| omp | `~/.omp/agent/mcp.json` | `<project>/.omp/mcp.json` |
| pi | `~/.pi/agent/mcp.json` | `<project>/.pi/mcp.json` |

Codex reads `<project>/.codex/config.toml` only in a trusted project. After writing team MCP servers, `teamai pull` trusts the main checkout automatically, unless `codexTrustEnabled: false` is set or the project was explicitly marked untrusted. If automatic trust is disabled or fails, add a `[projects."<main checkout real path>"]` table with `trust_level = "trusted"` to `~/.codex/config.toml`; trusting the main checkout covers every worktree of the repository. `teamai doctor` reports an untrusted project whose file holds team servers.


CodeBuddy Code's [MCP documentation](https://www.codebuddy.ai/docs/cli/mcp)
lists the project root's `.mcp.json` as its preferred project configuration.
This is separate from TeamAI's user-scope `~/.codebuddy/mcp.json` target.
Explicit `toolPaths.codebuddy.mcpProject` values in `teamai.yaml` still take
precedence. For an existing team that pins run
`teamai mcp remove` in the affected workspace before changing that value to
`.mcp.json`, then run `teamai mcp inject`. Review and preserve any personal
servers in either file; TeamAI does not migrate or delete the old file.
Claude Code also reads the root `.mcp.json`, so this file is shared by both tools.

TeamAI removes a bare Copilot entry beside `mcpServers` only when its ownership record proves a completed bare write and the entry still matches that write. Older records without placement evidence leave the bare entry alone, even if it matches the team definition. A bare ownership record does not authorize changes to a same-named member entry under `mcpServers`; update skips that collision and removal cleans only the owned bare copy. An unmarked record can claim a keyed entry only when its hash matches that entry and does not also match the bare entry. Completed keyed writes record `bare: false`; a failed placement-record write leaves ownership unproven. New HTTP local-agent installs check Git protection without changing it, persist provisional ownership, then add the exclusion and file record before writing a credential. A failed initial ownership write changes neither Git exclusions nor the MCP config.

An HTTP local-agent update keeps the existing JSON MCP ownership record until the config write succeeds. If saving the new record then fails, it restores the previous config. `uninstall_mcp` removes the entry before dropping its ownership record; a failed config write or an unreadable config keeps that record for a retry, and a failed manifest write restores the entry. A failed MCP reconcile restores each config it wrote before saving ownership, including a file shared by multiple tools. A restoration failure reports both errors and the affected files: repair the config and ownership record before retrying. Git protection remains while a credential is still present.

Copilot uses its native `mcpServers` schema: `stdio` becomes `type: "local"`, remote transports keep `http` or `sse`, and every managed entry gets the required `tools: ["*"]` allowlist. TeamAI honors `COPILOT_HOME`; project configuration uses Copilot CLI's documented `.github/mcp.json` repository location. See [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers). Codex supports `stdio` and `http`; `sse` is skipped. Qoder supports the Claude-compatible `mcpServers` format in its scope-specific `.qoder/settings.json`. Kiro supports the same `mcpServers` format in its dedicated, mcpServers-only `.kiro/settings/mcp.json` (see [Kiro's MCP configuration docs](https://kiro.dev/docs/mcp/configuration/)). OpenCode supports `stdio` (written as its `type:"local"` shape) and `http` (`type:"remote"`); `sse` is skipped, and its servers live under the `mcp` key of the shared `opencode.json`. Ownership is tracked in `~/.teamai/managed-mcp.json` — hand-added servers are left alone; name collisions skip unless `--force`.

**Secrets.** Write `${VAR}`, never a literal, in `mcp.yaml`. A key the team declares in `env/secrets.yaml` resolves from your value for this team (`teamai env set`), then your value for the machine (`teamai env set --global`), then your own environment, which leaves out values a teamai `env.sh` exported (see [Team secrets](designs/team-secrets.md#resolution)). Any other variable resolves from your value for this team (`teamai env set KEY`), then from the team env variables this directory receives (`env/env.yaml` and the active `env/<ns>/env.yaml`); the environment fills only a key the team sets nothing for, and no longer overrides a team variable (see [Team secrets](designs/team-secrets.md#variables)). An interactive `pull` and `teamai doctor` say when your export differs from the team's value and is ignored. Unresolved variables skip the server with a hint. A declared secret is different: when a pull can't find it, the entry an earlier pull wrote stays as it is, so it may hold a value that was since rotated, until a pull finds the new one (see [Team secrets](designs/team-secrets.md#a-missing-secret-keeps-the-mcp-entry)). An interactive `pull`, `teamai mcp list`, `teamai env list`, `teamai doctor` and `teamai env exec` name a declared secret with no value, the servers that use it and the command that sets it: `` github: GITHUB_TOKEN is not set. Run `teamai env set GITHUB_TOKEN` (<url>). ``

teamai **resolves every `${VAR}` to its value and writes it verbatim** into each tool's config, which is then written `0600`, an existing `0644` one included (a config without a resolved value keeps its mode; new files are created `0600`). It does not rely on any tool's own env-var expansion: that expansion is fragile — most decisively, IDEs launched from the GUI (Dock/Launchpad) never inherit your shell's exported variables, so a `${VAR}` placeholder expands to empty and the server 401s. Resolving to plaintext makes the token present no matter how the tool is started.

> ⚠️ **The resolved token lands on disk.** Project-scope MCP configs (`.mcp.json`, `.github/mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `opencode.json`) then contain the literal secret. Whenever such a file would hold a value teamai resolved and git would track it, teamai lists the path in the clone's `.git/info/exclude`, inside a `# [teamai:mcp-exclude:start]` block (the worktrees of a repo share it), before it writes the value. A config reached through a symlinked directory (say `.cursor/` linking to `config/`) is judged where the write lands: that path (`/config/mcp.json`) is the one listed, checked and reported, and a tracked one is named with both paths. A symlink at the file itself is replaced by the write, so there the file's own path counts. That covers a file this pull did not write: one written earlier for a tool since disabled, one at the built-in location of a tool the team has dropped from `toolPaths` or moved elsewhere (it counts while it holds any MCP server, since teamai's record for that tool describes another file or none; one another tool maps today, such as CodeBuddy's `.mcp.json`, which Claude maps, while it holds a server that tool did not write, as below), one written under a `toolPaths` mapping the team has since changed (each worktree records the files it wrote a resolved value to in `managed-mcp-files.json`, beside its `managed-mcp.json`; for one an older teamai wrote before it kept that record, the first pull reads each `mcpProject` path in the team repo's history of `teamai.yaml`, and the built-in ones teamai has since changed (CodeBuddy's `.codebuddy/mcp.json`), once, as far as the clone has it, inside the project only, skipping a path the same tool maps today; such a file counts while it holds any MCP server, since teamai's record for the tool describes only today's path (one another tool maps today, while it holds a server that tool did not write, as below), and `teamai doctor` checks the same files until that pull; one git tracks is not listed, since a line does nothing for it, but is recorded as tracked whatever it holds, judged as the others once git no longer tracks it (`git rm --cached`), and forgotten once it is gone from both the disk and git), or one still holding a server since removed from `mcp.yaml`. An entry a pull wrote with a resolved value counts while it is unchanged, even after the team makes its `${VAR}` a literal. While the worktree has no `managed-mcp.json` at all (lost, or before its first pull), a config git does not track counts while it holds a server no record claims, one of your own included: the pull notes those servers in `managed-mcp-files.json`, as when it rebuilds a lost record, and they keep its path until they leave the file; `teamai doctor` checks the same way. So does a config a pull writes a tool's first record for while `managed-mcp.json` holds none for that tool (lost, or teamai's first delivery to it). A path git cannot say it ignores is listed all the same once `git ls-files` shows the file untracked; when git cannot say that either, it counts as git failing. When it cannot — `.git/info` or the exclude file is not writable, another teamai command holds the exclude file past a short wait, git already tracks the file, a rule in your own git ignore files re-includes it (say `!/.mcp.json`; the warning names it), or git fails — it leaves that file as it was (an entry an earlier pull wrote stays), warns with the reason and the fix, and `teamai mcp list` and `teamai doctor` report the server as withheld from each tool a pull would write it to; make the file writable (or `git rm --cached` the tracked file, or remove the rule that re-includes it) and run `teamai pull` again. A tracked file is reported first, and listed nowhere. The committed `.gitignore` is left alone, a path git already ignores adds nothing, and a pull, `teamai mcp remove` and `teamai uninstall` remove a path from the block (the block with its last path) once that file is gone, holds no MCP server, or holds none of: a team server with a resolved value, an entry of teamai's that cleanup left, a server that was in the file when teamai rebuilt a lost `managed-mcp.json`, or the value (8+ characters) of a variable still set in the environment, with teamai's record of what it wrote there (`managed-mcp.json`) present before the command ran, readable, and holding an entry for that file's tool (for a file two tools map, such as Claude and CodeBuddy on `.mcp.json`: for each tool `managed-mcp-files.json` says wrote a resolved value there, or for each tool mapping it when it names none; an empty, unreadable or truncated record proves nothing, and neither does one written by a pull that rebuilt it or found no record for its tool in `managed-mcp.json`, while that pull could not note the file's other servers in `managed-mcp-files.json`, until a later pull notes them). A file written under a mapping since changed, one at the built-in location of a tool the team dropped or moved (unless another tool maps it today), or one in a linked worktree of a nested repository, needs to be gone or hold no MCP server. One written for a tool the team has since moved elsewhere (recorded, found in that history, or at the tool's built-in location), that another tool's mapping still reaches, also keeps its path while it holds a server the tools now mapping it did not write (by their `managed-mcp.json` record); as in any file under a changed mapping, a server of your own there keeps it too. `teamai uninstall` applies that to the file in every worktree of the repository; a pull and `teamai mcp remove` apply it only to the current worktree's file, and keep the path while the file in any other worktree still holds an MCP server: an entry that worktree's last pull wrote (say, a `${VAR}` the team has since made a literal) is judged only by a pull there. A path a pull listed and then wrote no value into (the file does not parse, or holds a server of your own under the team's name) comes out again at the end of that pull, and so does its record in `managed-mcp-files.json`. Otherwise, or for a file it cannot check (for example one that does not parse), the path stays, and `teamai uninstall` warns, naming the file and why: remove teamai's servers from it, then delete that line yourself (with its last line, the block's markers). `teamai doctor` reports such a file git would still commit or cannot answer for — for example one already tracked: `git rm --cached` it and rotate the token. A Copilot project config whose servers sit bare at the top level has those counted, and teamai's among them removed once the team drops them, after another tool writes `mcpServers` into the same file too. For an HTTP-backed team (`teamai init --http`) no pull writes a server: the local agent's `install_mcp` does, with the values themselves rather than `${VAR}` references, so a project-scope server carrying any header, env value or argument, a URL (a token can sit in its path), or a command line with arguments counts as holding a credential; only a bare stdio command doesn't. Its install lists the file first and records it in `managed-mcp-files.json`, and when it cannot (the same causes as above), writes nothing and reports the install as failed with the reason. A file an older local agent wrote a credential into without listing it is listed and recorded, judged as `teamai doctor` judges it below, by the local agent's next sync in that workspace (its hooks run one in each session) and by a `teamai pull` there; a dry run writes nothing. No command but `teamai uninstall` takes such a line out. `teamai doctor` checks those files by the local agent's records: one it noted as carrying a credential, or an older install's entry carrying one, and, with no record of the tool, a file `managed-mcp-files.json` lists while it holds any server; add a file it names to `.git/info/exclude` yourself, or `git rm --cached` it and rotate the token.

Claude Code may show project `.mcp.json` servers as pending approval until you accept them once in an interactive session.

```bash
teamai mcp list              # servers, the file each comes from, secret status, and where they are installed
teamai mcp inject            # apply now; --dry-run to preview, --force to override collisions
teamai mcp remove            # remove every teamai-managed server; --dry-run to preview
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
- Each search is a run, and its id follows the result count on the region's first line: `--- [teamai:recall:start] --- (2 results) run=<id>`. A search with no hits prints it at the end of its one line: `No matching learnings found for "<query>". run=<id>`. An active-scope doc the session opens after the run is upvoted, as [Recall adoption and upvotes](#recall-adoption-and-upvotes) describes. Inherited user hits remain read-only while the project is active
- In a project whose config exists but cannot be read, recall searches and records nothing, neither the user scope nor a lower-priority project config (such as a legacy `.teamai/config.yaml`) behind it: it prints ``Nothing was searched: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` and exits 1, with `--check` too, which prints no verdict. The recall subagent relays that line instead of reporting no knowledge. With no config at all, recall still says no learnings are available and exits 0
- When recall builds its index (none yet, or an older format) and a team manifest cannot be read, it still indexes the learnings, only the shared root when `manifest/projects.yaml` is the broken file, and says once what it left out, for example: ``Recall indexed learnings only: <cause>. Docs, rules and skills stay out of recall until the team manifest is fixed and `teamai pull` rebuilds the index; `teamai doctor` shows the problem.`` A skills collision with no earlier index to keep skills from is named the same way. If that smaller index cannot be written over an older one, recall searches nothing in that scope rather than the older index, which would return what the warning left out, and says so: ``Recall could not build the <scope> search index: <cause>. Recall skips the older index at <path>…``. Any other build failure is shown with its cause instead of "No learnings available"
- A lightweight relevance precheck is available via `teamai recall --check "<keywords>"`, which prints `RELEVANT score=<n> threshold=<n>` or `NOT_RELEVANT score=<n> threshold=<n>` without reading files or upvoting — the recall subagent uses it to skip retrieval on unrelated tasks. For a `RELEVANT` top hit it also reports `matched=`/`missing=` — the query terms that hit its title/tags and those that did not
- `RELEVANT` means a hit cleared the score threshold, i.e. reading files is worth the cost — it does not mean the knowledge base covers your subject. Use the `matched=`/`missing=` terms (and the `Matched:`/`Missing:` lines on full results) to make that judgement: a hit missing all your distinctive terms is topically adjacent, not an answer

### Recall adoption and upvotes

Recall counts every doc it returns (`recalled_count`). A returned doc is **adopted**, and upvoted once (`upvoted_count`), when the session that ran the recall opens it within 24 hours after the run. Adoption means opening the doc: when the `teamai-recall` subagent summarizes a doc and the main agent works from that summary alone, nothing is opened and no vote follows. Only the opt-in judge (`TEAMAI_UPVOTE_JUDGE=1`, see [Enabling / Disabling Recall](#enabling--disabling-recall)) can credit that use.

**The recall log.** Each run goes to the active scope's local recall log, `<data home>/dashboard/recall.jsonl`, which is owner-only and never pushed. The run holds the agent session from the environment and, for each returned doc, its id, scope and printed `File:` path; a search with no hits is recorded too. The PostToolUse hook adds the shell call that ran `teamai recall` and each read of a file under the team knowledge roots. The log never holds the query, the prompt, tool output or file content. `teamai pull` prunes it: lines older than 30 days go, then the oldest beyond 5,000, but never a read from the last 24 hours that has not voted yet, nor what it needs to vote. `--check`, `--dry-run` and `TEAMAI_RECALL_DISABLED=1` record nothing.

**Which session owns a run.** A run belongs to the session whose shell call ran `teamai recall` itself, so when one agent runs another (Claude running `codex exec`), the inner agent's session gets it; a call that only prints a recall's output does not count. With no such call, the run belongs to the session in the environment only when a single agent session was set there; otherwise it never votes.

**What counts as opening a doc.** The opened path must be the path the run printed.

- The agent's file-read tool (`Read`, `read`, `view`, `read_file`, `ReadFile`).
- One reader command, alone or at the head of a pipeline: `cat`, `bat`, `less`, `more`, `head`, `tail`, `nl`, `sed -n` printing lines, or PowerShell's `Get-Content`, `gc`, `type` and `cat` with a positional path, `-Path` or `-LiteralPath`; `gc` and `type` count only in the agent's PowerShell tool or when every path is a Windows path (a drive letter or a `\`), since in a POSIX shell `type` is a builtin that reads nothing. A command with `;`, `&&`, `||` or `&` is not a read. When the agent reports no status, as Codex's shell does, only a reader alone counts, and output that holds nothing but the command's own errors (`cat: x.md: Permission denied`) or the shell's (`bash: line 1: head: command not found`) is a failed read, and a file such an error names (`cat: x.md: …`) is not read, while the command's other files still are.
- A search whose output shows the file's lines: a line that starts with the file's path and `:<line>:` (or `:` alone, in `grep` and `rg` output without line numbers and in OpenCode's per-file header), or, when the file was the only thing searched, output with a line other than the search tool's no-match or summary line (`No files found`, `No matches found`, `Found N matches`) (`grep`, `rg`, `ag`, `ack` or `git grep`, under the same rules as a reader command, or a search tool such as `Grep` in content mode).
- Not a listing (`Glob`, `ls`, `find`, `rg --files`, `grep -l`, a search tool's file list), a count (`grep -c`, count mode), or a failed read.
- On Windows a path counts however it is written: either drive-letter case, `\` or `/`, or Git Bash's `/c/…` for `C:\…`.

**Subagents.** When the `teamai-recall` subagent ran the recall, its own reads never count; reads by the main agent or any other subagent in the session do. The subagent marks its runs with the internal `--caller teamai-recall` flag, and Claude Code, and OMP from 18.3.2, also name it in their hooks. Whether a later read by the main agent reaches the subagent's run depends on the agent: see the table below.

**When the vote lands.** The Stop hook joins runs and reads, and upvotes each adopted doc once per session; an agent that shows hook output prints `[teamai] Adopted team knowledge this session: <ids>`. A subagent that reads after the session's last Stop is credited at its SubagentStop (Claude Code, Codex, CodeBuddy and Qoder), which pushes nothing so the main agent never waits on git: the next Stop or pull pushes the vote. Copilot CLI's SessionEnd credits and pushes as Stop does, so a session whose last turn fired no Stop still votes, but it prints nothing. `teamai pull` also credits any read still pending, such as one no later hook fired for, or one whose Stop found the votes file busy. A session resumed the next day that opens the doc again adds no vote unless it recalls the doc again.

**Per agent.** *Direct recall*: the main agent runs `teamai recall`, then opens a doc. *Subagent path*: the `teamai-recall` subagent runs the recall, then the main agent, or another subagent, opens the doc.

| Agent | Direct recall | Subagent path |
|-------|---------------|---------------|
| Claude Code | Yes | Yes |
| Codex | Yes | Yes, from Codex 0.134, whose hooks name the subagent |
| CodeBuddy, WorkBuddy | Yes (unverified) | Yes, from CodeBuddy 2.103.1, whose hooks inside a subagent carry the main session (unverified on WorkBuddy) |
| Qoder | Yes | Yes (unverified) |
| Copilot CLI | Yes | No: the subagent has a session of its own, and no hook links it to its parent |
| Cursor | Yes | No: as for Copilot CLI |
| OpenCode | Yes | Yes: the `task` call links the subagent's session to its parent |
| OMP | Yes, settled only by the claim of its `bash` call | Yes: the subagent's session file sits under its parent's, whose session header links the two sessions (verified against OMP 18.4.8) |
| Pi | Yes | None: TeamAI deploys no subagent to Pi |
| ZCode | Yes | No: ZCode runs no hooks inside a subagent |
| OpenClaw, Hermes, Kiro, JoyCode | No: no PostToolUse hook | No |

*Unverified*: built and tested from the agent's documented or source-read hook payloads, not yet checked in a live session.

**Known limits.**

- **Cursor, Copilot CLI and ZCode subagents.** A recall run in a subagent never credits the main agent's reads: Cursor and Copilot CLI give the subagent its own session with no link to the parent, and ZCode runs no hooks in it. A recall the main agent runs itself does vote.
- **OMP.** The subagent path needs the main session's file on disk: when it has none (`--no-session`), the subagent is not linked to its parent and gives no adoption. OMP sets no session variable in its shell, so a run settles only through the claim of the `bash` call that ran it: when OMP moves a large output into an artifact, the `run=` line and the vote are lost, and an OMP started from a Claude Code shell records its run under the Claude session until that claim corrects it.
- **Searches not counted.** OMP's `grep` (a markdown tree) and Cursor's `Grep` add no evidence; opening the doc still counts. ZCode prints `Grep` lines relative to its working directory, so a ZCode search run from a directory inside the team repo is not counted.
- **No PostToolUse hook.** OpenClaw, Hermes, Kiro and JoyCode record their recalls but no reads, so these recalls never vote.
- **Older CLIs.** A member on an older TeamAI still votes from the session transcript, and that path keys a skill, a doc in a subdirectory or a wiki page by its file's basename (`SKILL`, `setup`) rather than the id recall prints (`retry`, `common/setup`), so those votes miss the doc. Top-level learnings and docs are unaffected, and upgrading ends it.

**In `teamai stats`.** When the current scope's recall log has runs, `teamai stats` adds a recall section after the skill usage, with the 10 sessions that recalled most recently, newest first:

```text
Recall (last 10 sessions):

  session   agent   runs  recalled  adopted
  3f2a9c1e  claude     3         3        1
  a41d07b2  codex      1         2        0
```

`session` is the first 8 characters of the agent session id; a subagent's own session (OpenCode's task tool) counts under the session that started it. `agent` comes from the session's newest run that names one: the agent whose hook claimed the run, else the one its environment named; it is `-` when no run names one. `runs` counts the runs that belong to the session, a search with no hits included; a run whose session is ambiguous and never confirmed is left out, and `--check` is no run. `recalled` counts the distinct docs those runs returned, and `adopted` the docs already upvoted from them: a read still waiting for the session's Stop is not counted yet. Without runs in the log the output is unchanged.

### Enabling / Disabling Recall

The Recall feature is controlled by a two-tier configuration — admins set the team default, and members can override it locally:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.recall.enabled` | `true` / `false` (default `false`) |
| User override | `~/.teamai/config.yaml` | `recallEnabled` | `true` / `false`, takes priority over the team default |
| Environment variable | shell | `TEAMAI_RECALL_DISABLED=1` | Force-disables all recall hooks (emergency kill switch) |
| Environment variable | shell | `TEAMAI_UPVOTE_JUDGE=1` | Opt-in: on a git-team session a background pass asks your local signed-in CLI whether the latest reply substantively used each recalled doc not yet upvoted for the session, and upvotes that subset. A doc already in the session's upvote ledger (the session opened it, or an earlier judge pass upvoted it) is never sent to the judge, so a doc is upvoted at most once per session; a doc the judge turned down is judged again on a later turn; an inherited user-scope doc is not upvoted while a project is active. Off by default; runs detached (no added latency) and uses your CLI subscription |

```bash
teamai recall enable     # Enable recall, deploy the subagent and rules
teamai recall disable    # Disable recall, remove the subagent and rules
teamai recall status     # View the current effective status (team default + user override)
```

Append `--dry-run` to `enable` or `disable` to preview the config and managed-artifact changes without writing them.

When disabled, `teamai pull` skips deploying the recall subagent and the TodoWrite reminder hook, and removes the recall block from the team instructions. Manually running `teamai recall <query>` to search is not affected by this switch.

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

While another teamai command holds the learnings or reports checkout's lock, `recall maintenance` and `recall promote` exit 1 without writing anything (`The learnings checkout is locked: …`). Run them again when that command finishes.

Maintenance and promote publish only the learnings they changed. A file in the learnings checkout that nobody committed stays out of their commit. When the publish cannot run or push (`Maintenance changes stay local for now: …`), the next `teamai pull` or `contribute` publishes the change, even with no learning queued. A learning edited by hand after that run is not published as part of it: the edit stays uncommitted, and a warning names the file. A file someone staged in the checkout stays staged across the publish; when origin changed it too and it can no longer be staged as it was, it keeps its content as an unstaged change, and a warning names it.

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

The markdown body after the frontmatter becomes the body content of the team culture guidance, injected as a whole into each AI tool's instruction target (see [Where the blocks go](#where-the-blocks-go)).

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
    ▼  Compile into an injection block
    │
    ▼  Write it to each installed AI tool's instruction target
       ├─ ~/.claude/CLAUDE.md                       (user scope)
       ├─ <project>/.claude/rules/teamai-context.md (project scope)
       └─ ...
```

The injected content sits between the `<!-- [teamai:culture:start] -->` and `<!-- [teamai:culture:end] -->` markers, is automatically updated on every `pull`, and does not affect any other content in the file.

A pull writes the culture, shared-instructions and recall blocks only to the files of AI tools that are installed, and leaves a file alone when its blocks are already current. Earlier releases wrote these blocks to files that tools now share or that hide other instructions (listed under [Where the blocks go](#where-the-blocks-go)); while no installed tool reads such a file, the next pull removes the teamai blocks from it and names the file in its output. A tool's current file is never cleaned on its own: `teamai uninstall --agent <tool>` removes those blocks. It deletes the file when nothing else is left, unless git tracks it. A block with a missing or repeated marker is left as it is, with a warning to fix it by hand. `teamai pull --dry-run` lists the files a pull would change without writing them. When recall is disabled, the pull removes the recall block.

#### Where the blocks go

Two members of the same project can have different roles, so their shared instructions (`claudemd/`) can differ. The project's root `AGENTS.md` holds the instructions the project writes for everyone, so teamai never writes these blocks into it, into `~/AGENTS.md` or `~/.agents/AGENTS.md`, or into a file another tool reads. Each tool gets them in a file of its own or through its session hook:

| Tool | User scope | Project scope |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `.claude/rules/teamai-context.md` |
| claude-internal, tclaude | `.claude-internal/CLAUDE.md`, `.tclaude/CLAUDE.md` in their homes (unchanged) | The same paths under the project (unchanged, unverified) |
| Codex, codex-internal, tcodex | `$CODEX_HOME/AGENTS.md` (and the variants' homes), beside the team rules | Added by the session-start and subagent-start hooks, beside the project's team rules; nothing on resume |
| Copilot CLI | `$COPILOT_HOME/copilot-instructions.md` (unchanged) | `.github/copilot-instructions.md` (unchanged) |
| Cursor | `~/.cursor/rules/teamai-context.mdc` (unverified) | `.cursor/rules/teamai-context.mdc` (unverified) |
| CodeBuddy | `~/.codebuddy/CODEBUDDY.md` | `.codebuddy/rules/teamai-context.md`, one copy shared with WorkBuddy (unverified) |
| WorkBuddy | `~/.workbuddy/rules/teamai-context.md` (unverified) | `.codebuddy/rules/teamai-context.md`, one copy shared with CodeBuddy (unverified) |
| OpenCode | `~/.config/opencode/teamai-context.md`, listed by absolute path in `instructions` of `~/.config/opencode/opencode.json` | `.opencode/teamai-context.md`, listed in `instructions` of `.opencode/opencode.json` |
| Oh My Pi | `~/.omp/agent/RULES.md` | Added to each turn's system prompt by teamai's OMP extension |
| Pi | `~/.pi/agent/AGENTS.md` | Added to each run's system prompt by teamai's Pi extension |
| Hermes | A block in `$HERMES_HOME/SOUL.md`, beside the team rules block (unverified) | A system prompt section from teamai's Hermes plugin (unverified) |

A team `toolPaths` entry without `rules` keeps its configured `claudemd` for Claude Code, Cursor, CodeBuddy and WorkBuddy, which have no rules directory to take a `teamai-context` file. An entry with only `claudemd` counts as installed when that file's directory exists, and always for a bare file such as `AGENTS.md`.

*Unverified*: built from the tool's documented or source-read loader, not yet checked in a live session. Claude Code, Oh My Pi, OpenCode and Pi (project scope) were checked in live sessions, from the project root and a subdirectory. A tool with the `teamai-recall` subagent gets a recall block that calls it; a tool without one (Pi, Hermes, OpenClaw) gets a recall block that tells the agent to run `teamai recall` directly. A file several tools share gets the subagent block only when every one of them has the subagent.

Claude Code loads `.claude/rules/teamai-context.md` from the project root and any subdirectory, and still reads the project's `AGENTS.md` or authored `CLAUDE.md` the way it chose to. Copilot CLI 1.0.89 and later also reads a project's `.claude/rules`, so with both tools installed Copilot can get the blocks twice.

Both `teamai-context.mdc` files carry `alwaysApply: true`, which Cursor's rule loader reads as always applied. Cursor CLI reads `~/.cursor/rules` when the session starts under your home directory; the Cursor IDE was not checked.

The CodeBuddy and WorkBuddy rule files carry `alwaysApply: true`, which CodeBuddy's rule parser reads as always applied. Uninstalling one of the two keeps the shared project copy while the other is still installed.

In a project, teamai installs the Hermes plugin `$HERMES_HOME/plugins/teamai-instructions/` and adds it to `plugins.enabled` in `$HERMES_HOME/config.yaml` (a name you list under `plugins.disabled` stays off). A plugin of that name teamai did not write is left alone, also on uninstall, and `teamai pull` and `teamai doctor` say so. According to Hermes' documentation it builds the section once for each new session from the session's directory and keeps it through compression and resume. A section holds at most 4,000 characters, and all plugin sections together at most 8,000. When this member's instructions for the project are longer, Hermes skips them and `teamai pull` says so: teamai does not cut them or write them to `AGENTS.md`. Outside a project the section is empty, and Hermes may log that it skipped an empty section.

OpenCode loads a file only when its config lists it in `instructions`. teamai adds that entry only when the target already matches the desired blocks or its update succeeds. A malformed target or a failed write does not activate stale blocks. A failed edit keeps an existing instructions entry, including when malformed recall markers prevent a recall toggle. TeamAI saves ownership before adding a new config entry; a failed state write prevents activation, and a failed config write can be retried. Entries you already listed remain yours. It keeps your other entries and keys; the root `opencode.json` and OpenCode's own `AGENTS.md` files are left alone. While `~/.config/opencode/AGENTS.md` does not exist, OpenCode reads `~/.claude/CLAUDE.md` instead; when Claude Code gets the user blocks there, OpenCode already has them, so teamai writes no second user copy for OpenCode and says so in the pull output. Blocks left there by a Claude Code you excluded count too, since OpenCode reads them all the same; the pull then warns that nothing keeps them current. A config file teamai cannot parse as JSON (for example one with comments) is left unchanged with a warning; add the entry by hand.

Oh My Pi reads `RULES.md` as an always-applied rule beside its single user context file. In project scope teamai's OMP extension asks `teamai` for the blocks when the session starts and adds them to each turn's system prompt, from the project root and any subdirectory. Without that extension (for example with hooks removed), an Oh My Pi project session gets no team blocks. Prompts the HTTP local agent delivers for a project reach Pi, Oh My Pi and Hermes the same way, through their extension or plugin, and the Codex family through its session-start and subagent-start hooks. Pi and Oh My Pi wait for foreground session-start dispatch, including HTTP prompt sync, before caching the project instructions for the first prompt. Codex reads its HTTP prompt cache after the same sync, before returning SessionStart context.

A pull from an earlier release may have left these blocks in a file listed below. A pull removes each block only after its replacement was resolved and delivered to every installed tool that wrote that file. An unreadable or invalid culture source keeps the old culture block even if shared instructions and recall sync successfully. Failed target writes, foreign files, missing extensions or disabled plugins keep the old blocks for a retry. Excluded tools' current and retired files stay unchanged and are excluded from doctor's stale-instruction check.

HTTP prompt commands verify the current destinations of all installed former writers, including delivery from previous commands, before removing the retired shared-instructions block. A destination holding an older prompt does not count as delivered. HTTP cleanup preserves culture and recall blocks, which those commands do not replace.

While a native project instruction file still contains a TeamAI block, the session hook skips that block, including a cached HTTP prompt, to avoid adding a second member selection. Other blocks still reach the hook. Delivery resumes after the retained block is cleaned. Codex respects `AGENTS.override.md` precedence, and Oh My Pi respects `.omp/AGENTS.md`. Doctor reports incomplete or repeated markers in retired files; repair those markers before retrying pull.

The pull names each file it changes:

- Claude Code, project scope: `.claude/CLAUDE.md`
- CodeBuddy, project scope: `.codebuddy/CODEBUDDY.md`
- WorkBuddy: `~/AGENTS.md` and the project `AGENTS.md`
- Hermes: `~/AGENTS.md`
- Oh My Pi: `~/.omp/agent/AGENTS.md` and `.omp/AGENTS.md`. Oh My Pi reads one context file per level, so these hid `~/.agents/AGENTS.md` and the project's `AGENTS.md`.
- Pi: the project `AGENTS.md`
- Codex family: the project `AGENTS.md`, when a team's `toolPaths` or an earlier build pointed Codex there
- Any tool whose file changed: the `claudemd` path the team's `toolPaths` sets for it, unless another tool's blocks go there now

`teamai doctor` checks that each installed tool can load these blocks: that each file holds the current blocks, that OpenCode's config lists its file, that the Pi or Oh My Pi extension and the Hermes plugin are installed and enabled, that the Hermes section fits its limit, and that no file an earlier release wrote still holds blocks.

If a requested block has incomplete or duplicated markers, the entire file stays unchanged, including its other managed blocks. Fix the named markers, then run `teamai pull` again.

A file named like a teamai target that teamai did not write is left alone and not listed in OpenCode's `instructions` (an entry you listed for it stays), and the pull warns about it. A team rule named `teamai-context` is not delivered, since it would land on that file; the pull names it, and removes a copy an earlier release delivered unless you changed it. teamai does not change `.gitignore`, `.git/info/exclude` or the git index. A team that wants to keep these files out of commits excludes them itself.

### Viewing the result

After pulling, you can view an AI tool's instruction file directly, for example Claude Code's user file:

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

Removing the final HTTP prompt is acknowledged as `failed` when its target cannot be updated. The cached prompt and manifest record remain available for a retry after repairing the markers or file permissions.

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

`--from-mr` publishes its learning the way `teamai contribute` does, on the `teamai-learnings` branch: under `learnings/<namespace>/` when exactly one active project declares a learnings namespace, otherwise at the shared `learnings/` root. If that fails, the learning stays queued on this machine and the next `teamai pull` publishes it; when a learnings checkout teamai refuses stopped it, no pull can until you deal with that checkout as the message says.

When the draft overlaps existing learnings, from the shared root or your active projects' namespaces, the command names them (`Possible duplicate: this learning overlaps N existing learning(s): <files>.`), with `--all` too. It is a notice only: nothing is marked or replaced. When `manifest/projects.yaml` cannot be read, the check compares the shared root only and says so.

AI-backed steps (`--deep-enrich`, knowledge enrichment) shell out to an AI coding CLI already installed on the machine instead of calling a model API directly. teamai probes `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` and uses the first one it finds. On macOS and Linux the probe runs through a login shell, so a CLI installed under `~/.nvm/` is found too. On Windows it uses the native `where`, which returns the npm shim (`%APPDATA%\npm\claude.cmd`) that Windows can actually launch — a Git Bash or WSL `bash` only reports MSYS paths such as `/c/Users/...`, which Windows cannot start.

For GitLab behind an API gateway, set `GITLAB_URL` and `GITLAB_API_PREFIX=api/gitlab` before running `teamai import --from-org https://gitlab.example.com/myorg`. Organization listing uses the configured prefix on every page; an unset or blank prefix defaults to `api/v4`.

The graph stores components, interfaces, configs, and cross-repo dependencies. `teamai recall` combines learnings with graph BM25 hits on a bounded, relevance-normalized score scale.

Dependency edges are extracted by two parallel tracks: a WASM tree-sitter **AST track** (TypeScript/JavaScript, Python, Go, Swift) that resolves imports, calls, and TS `implements` clauses to precise file-to-file edges (`code-ast`), and a regex **heuristic track** (all languages, `code-heuristic`) that also covers languages the AST track does not. AST results win on overlap. The AST parser needs no native toolchain; on load failure, extraction falls back to heuristics and records an `AST_UNAVAILABLE` gap. Set `TEAMAI_SKIP_AST=1` to force heuristic-only extraction.

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

Changes queued in `.teamai/pending-review.jsonl` can be inspected with `teamai review`. Preview a decision with `teamai review <id> --apply --dry-run`, `teamai review <id> --reject --dry-run`, or `teamai review --all-apply --max-risk medium --dry-run`. Apply previews validate the target and managed section just like a real apply, but leave both documents and pending items unchanged. Batch previews retain the same kind/risk filtering. Decision previews with `--json` include `dryRun: true`; `ok` means the operation passed validation, not that it was written. Remove `--dry-run` to perform the decision.

When extract finds components, it writes `teamwiki/evidence/code/<project>/_manifest.json` even if AI enrichment is skipped or produces nothing, so `--deep-enrich` can start.

Without `--project`, `<project>` is the directory's name. At the root of a checkout, the main one or a linked git worktree, it is the repo's name: the main checkout's real name (also when opened through a symlink), or a bare repo's (`repo/.bare` or `repo.git` → `repo`). Every checkout of a repo writes the same entry. `teamai import --dir` picks its slug the same way.

### Dashboard

```bash
teamai dashboard             # Start the web dashboard (default port 3721)
teamai dashboard --port 8080
```

The sidebar contains **Overview**, **Team Execution**, **Team Context** and **Team Improvement**. Overview summarizes the three modules. Execution shows this machine's sessions, filters by repository (every worktree of a repo is one entry) and AI tool, and opens complete session details. Context contains KB Health (including author contributions and never-recalled entries); Improvement contains local trends and the original promotion/archive/quality-update maintenance commands. Commands are displayed for use in your terminal; the dashboard does not execute them.

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
teamai session save                    # record the current agent session (else the most recent) locally
teamai session save --session-id <id>  # record a specific session
teamai session save --push             # also push a "valuable" session to the team repo
teamai session save --push --force     # push even a trivial session
teamai session save --push --include-prompt  # also include the (redacted) first-ask line
```

**Local (always):** appends to `~/.teamai/session-logs/<year-month>.md`. Idempotent per session (a session already recorded that month is skipped), and logs older than 90 days are pruned automatically. Each entry names the session's repo as `Project:`, the same for every worktree of the repo, and its working directory as `Directory:`.

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

`hooks list` prints the built-in set per tool, because the set is not universal: Copilot also gets `SessionEnd`, Claude Code, Codex, CodeBuddy and Qoder also get `SubagentStop`, the Codex family also gets `SubagentStart` (the project's team rules and instructions for a spawned subagent), OMP's extension covers four events without the `Skill` / `TodoWrite` matchers, OpenClaw maps only `SessionStart` + `UserPromptSubmit`, and Hermes only `SessionStart`. Tools the hook pipeline installs nothing for (e.g. JoyCode) are omitted, and so is Kiro — its `SessionStart` command is embedded as `hooks.agentSpawn` by the agent sync, so it exists only for the agents you actually synced.

The inject and remove commands only touch tools you actually have installed (i.e. whose `~/.<tool>/` root directory already exists). They never create root directories for tools listed in `toolPaths` but not installed. Existing Claude/Codex main-checkout hook files also count as installed targets when the HOME and current worktree tool roots are missing. Injection and pull update those team hooks and restore HOME built-ins; removal clears the managed main-checkout hooks without recreating HOME roots.

`hooks inject`, `init` and self-repo bootstrap still attempt to trust the written Codex hooks if Git-hook installation fails. Injection preserves the installation error and does not report overall success. Init reports the error and keeps exit code 1 while completing local setup, including HTTP initialization. Bootstrap records that error in the debug log and continues local setup.

In non-self project scope, `hooks remove` removes this checkout's gated team hooks from HOME and Claude/Codex team hooks from the main checkout. Other projects' gated team hooks stay in HOME; shared built-in hooks are removed.

On Windows, the built-in hook dispatch commands that shell out through bash (e.g. Claude, Codex, Cursor, Copilot CLI) reference Git Bash by absolute path — standard install locations first, then the `HKLM\SOFTWARE\GitForWindows` registry as fallback — so they never resolve to the WSL `bash.exe` launcher; if Git Bash cannot be found they degrade to bare `bash`.

Cursor also loads `~/.claude/settings.json`, and Copilot CLI loads a trusted project's `.claude/settings.json` (self mode writes hooks there; Copilot does not load `~/.claude/settings.json`). `hook-dispatch --tool claude` exits only when that other host's own teamai hooks are on disk: `~/.cursor/hooks.json` or `$CURSOR_PROJECT_DIR/.cursor/hooks.json` contains `--tool cursor`, or `$COPILOT_PROJECT_DIR/.github/hooks/teamai.json` contains `--tool copilot`. Team hook commands written for `claude` use the same check. A setup with only Claude keeps running inside Cursor, because there is no second copy. `COPILOT_CLI` is not a signal: Copilot sets it on every subprocess, including a Claude session started from its shell. Claude Code sets neither `CURSOR_VERSION` nor `COPILOT_PROJECT_DIR`. Run `teamai pull` or `teamai hooks inject` again so an already installed team hook picks up the guard.

> **Codex hook trust** — Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) runs a non-managed hook only once it is trusted, and skips an untrusted or changed one without a word; it reads a project's `.codex/` only when the project is trusted. So after every write of a Codex hooks file (`init`, every `pull` including the session-start one, `teamai hooks inject`) teamai trusts exactly the hooks it wrote, through `codex app-server` — the same call Codex's `/hooks` trust prompt makes. Your own hooks in the same file are left alone, even when their commands equal a team hook. Codex ownership records include the event, position and complete generated entry; trust selects that exact Codex key. If unrelated entries move it, teamai recovers ownership only when the complete definition matches uniquely. Legacy manifests recorded only event, matcher and command, so a unique match on those fields recovers ownership even with `timeout` or `additionalContextLimit`. For pre-#370 project Codex hooks, teamai imports ownership from the main checkout's `.teamai/managed-hooks.json` before reconciling the same file with the new manifest, including direct removal. Unrecorded or ambiguous legacy team-hook copies are preserved. In a project, teamai also trusts the main checkout when Codex has to read teamai's hooks or MCP servers from its `.codex/`; for a bare repository, teamai writes and trusts the current worktree instead. A project you marked untrusted in Codex stays so, and teamai says so. Trust written by a session-start pull applies from the next Codex session: the running one already loaded its hooks. A linked worktree reads the main checkout's `.codex/hooks.json` only once it has a `.codex/` directory. The post-checkout preparation creates that directory and runs pull before the first session for selected Codex tools. Hosts that skip checkout hooks must finish that preparation before starting Codex. If only SessionStart creates the directory, the team hooks load from the next Codex session; built-in hooks live in `~/.codex/hooks.json` and run from the first. To trust them yourself, set `codexTrustEnabled: false` in `config.yaml`. `init` and `hooks inject` print a reminder to trust them in `/hooks` or Settings → Hooks when `codex` is absent or its app-server fails. An interactive pull warns on app-server failure and stays quiet when `codex` is absent; silent pulls record the result in the debug log. `teamai doctor` asks Codex which teamai hooks it will not run and names them.

### Team Hooks Declaration

A team can declare custom hooks in the repo's `hooks/hooks.yaml`, and per namespace in `hooks/<ns>/hooks.yaml` (see [Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)); `teamai pull` automatically distributes them to supported hook adapters. `builtin:` is read from `hooks/hooks.yaml` only. Pi is currently limited to TeamAI's built-in lifecycle bridge: custom hooks and built-in overrides from this file are not applied to Pi.

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
| `roles` | Deprecated: use `hooks/<ns>/hooks.yaml`. Still filters by role id for one minor release, with a warning naming the target file |
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

`teamai pull` copies these into each Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`), flattened by file name, so two active namespaces must not define the same agent name (pull reports the collision and leaves agents as installed for that run; the other resource types still sync). An agent in an active namespace replaces a root-level agent of the same name, and the root one comes back once that namespace stops being active. Without a configured role or project every namespace syncs, so a root-level and a namespaced agent of one name collide too. `teamai pull` writes `<name>.toml` for Codex tools, `<name>.json` for Kiro, `<name>.agent.md` for Copilot, and `<name>.md` for every other tool. When a member changes role, agents of the namespaces that stopped being active are removed on the next pull, unless the deployed copy was edited locally, in which case it is kept with a warning. Without a configured role, every agent syncs. `teamai push` resolves the source using the same active role and project namespaces as pull. It writes edits to that source and skips ambiguous destinations with a warning; an agent with only inactive sources is also skipped. Skipped agents do not block other resources in the same push. A new agent is placed the way a new skill is: `--role <ns>` or `--project <id>` (that project's `agents` namespace) names the directory, and with neither flag it resolves from the primary role's `agents` namespaces. It only stays at the shared root — where every member receives it — when no namespace resolves, and push warns when that happens (see [Push local resources](#push-local-resources)). Cleanup checks each tool separately, respecting YAML `targets` and legacy format support. An active same-named agent protects a deployed file only when it targets that tool and output file. `teamai remove agents <name>` records a tombstone. A namespaced agent can be named as `<namespace>/<name>`; a bare name that only one namespace has resolves to it, and a bare name found in several places is refused, with the qualified names listed, rather than removed from all of them. The next pull on every other machine deletes `<name>.agent.md`, `<name>.md`, `<name>.toml` and `<name>.json` from each synced tool's agents directory. That cleanup also runs when the pull finds the team repo unchanged. Removing a namespaced agent tombstones `<namespace>/<name>` only, so the same name in another namespace is untouched; a member's flattened `<name>` copy is cleaned, and not pushed again, when it can be that agent's copy (the namespace is active for them, or their machine placed the agent) and their directory does not still receive an agent of that name from another active namespace. A member who never had that namespace keeps their own agent of the same name. The CLI's built-in `teamai-recall` profile is deployed alongside team agents but is not uploaded by `teamai push`.

A YAML agent carries tool-specific fields under `tool_extras.<tool>`, and each tool receives only its own key: `tool_extras.claude` reaches Claude alone, `tool_extras.qoder` reaches Qoder, and Qoder CN, ZCode and OMP read `tool_extras.qoder-cn`, `tool_extras.zcode` and `tool_extras.omp`. tclaude and tcodex also receive the fields of `tool_extras.claude` and `tool_extras.codex` that `tool_extras.tclaude` and `tool_extras.tcodex` do not set. `teamai push` writes an edit back to the key that tool reads; for tclaude and tcodex it writes only the values that differ from the base tool's, and skips, with the reason, an edit that removes a field the tool inherits, since only the base tool's key can drop it.

#### Model aliases

A YAML agent can name a kind of model instead of a model: `model: strong`, `model: fast`, or an alias the team defines. The team maps each alias per tool in an optional `models/aliases.yaml`, in the tool's own model value, with an optional reasoning effort:

```yaml
# models/aliases.yaml
aliases:
  strong:
    claude: [{ model: opus, effort: high }, { model: fable }]
    codex:  { model: gpt-6-sol, effort: high }
    opencode: anthropic/claude-opus-5-5
    cursor: "claude-opus-5[effort=high]"
  fast:
    claude: haiku
    codex:  { model: gpt-6-luna, effort: low }
  reviewer:
    claude: [{ model: opus, effort: max }]
```

- `strong` and `fast` are always aliases, and TeamAI ships no models for them. A team adds its own names, which start with a lowercase letter followed by lowercase letters, digits or hyphens. Any other `model`, such as `opus`, is written as is.
- A tool entry is one option or an ordered list of them; only the first is used for now. An option is a model string or `{ model, effort }`.
- Each tool receives the model in its own model field and the effort in its own effort field, and no other tool's keys:

  | Tool | Model | Effort field |
  |---|---|---|
  | Claude, claude-internal, tclaude | as written | `effort` |
  | Codex, codex-internal, tcodex | as written | `model_reasoning_effort`, only when the mapping sets one |
  | OpenCode | as written (`provider/model`) | `variant` |
  | CodeBuddy, Qoder, Qoder CN | as written | `effort` |
  | Cursor | as written, including the bracket form `claude-opus-5[effort=high]` | none; write the effort in the brackets |
  | Copilot | the first entry, as one model string | none |
  | Kiro, WorkBuddy, JoyCode, ZCode, OMP | as written | none |

- An `effort` mapped for a tool with no effort field is dropped: the tool receives the model alone, and pull warns once, naming the alias and the tool, when it delivers an agent that uses the alias to that tool.
- claude-internal and tclaude use the `claude` entry, codex-internal and tcodex the `codex` entry, and Qoder CN the `qoder` entry, unless the alias has a key of their own. No other tool inherits an entry: Qoder, ZCode, OMP and JoyCode never receive the `claude` model.
- A tool the alias does not map gets no `model` field, so it runs the agent on its default. Without `models/aliases.yaml`, `strong` and `fast` give no model field in any tool.
- `tool_extras.<tool>.model` pins that tool to a concrete model and skips the alias, its effort included. An effort field in `tool_extras.<tool>` without a model overrides only the alias's effort, and a tool switched to a model profile does not receive it.
- A `model` that is not a string is rejected when the agent is read. A legacy `agents/<name>.md` is copied as is, so pull warns when its `model` is an alias.
- A structural error fails the whole file: YAML that does not parse, a value of the wrong type, an alias name that breaks the naming rule, an option with `effort` and no `model`, `~`, or top-level keys without `aliases:` (such as a misspelled `alias:`; an empty file, one with only comments, and an empty `aliases:` define no aliases). Until it is fixed, pull warns, naming the file, and holds every agent with a `model` field (an unreadable file may define any name) in each tool without `tool_extras.<tool>.model`: deployed copies stay, new ones are not written, and the models pull recorded for them stay as they were. Push skips those agents and says why; everything else pushes. Once the file is fixed, an ordinary `teamai pull` delivers the held agents, including ones it never deployed and team changes to them that arrived meanwhile: a pull that holds an agent, on an unchanged team repo too, does not count the team revision as synced, so the next pull syncs in full. `teamai pull --dry-run` names the agents it would hold.
- Anything else this CLI does not know is dropped with a warning, and the rest of the file applies: a tool key that is not a tool teamai knows, an option field other than `model` and `effort` (the entry is used without it), and an alias named like a tool's own model alias (`opus`, `sonnet`, `haiku`, `fable`, `inherit`, `default`, `auto`, `lite`, a short best-effort list), which is ignored so that `model: opus` stays `opus`. A `gateways` key inside an alias is reserved for a later version and ignored without a warning. Pull prints each warning once, and only when it delivers an agent that uses that alias; a warning about one tool's entry, only when that tool reads the entry.
- Pull records the model and effort each agent copy received, so an ordinary `teamai pull` applies a change even when the team repo has not moved, such as the first pull after upgrading from a CLI that wrote `model: strong` as is. It rewrites only the agents whose model changed, a copy that is missing, and a copy an older CLI rendered differently that you have not changed since. A copy you edited is kept, and pull names it on each such pull with how to take the new model. When the alias an agent used is removed, pull warns that its `model` is now written as is, also where the alias gave that tool no model field.
- `default` in `models/aliases.yaml` is a model value like any other and is written as is, which is CodeBuddy's own value for its default model. `~` there is an error: leave the tool out to give it no model field.

##### Adopting aliases

Only a CLI that knows model aliases resolves them, so a team adopts them in two steps:

1. Everyone updates teamai to a version with model aliases. Nothing changes yet: an agent with a concrete model or none is written as before.
2. Then the team adds `models/aliases.yaml` and moves agents to `model: strong`, `model: fast` or its own aliases, in the team repo or by writing the alias name in a deployed copy and pushing.

An older CLI ignores `models/aliases.yaml` and writes `model: strong` into every tool as is, a model no tool knows. Its `teamai push` also reads a model changed in a deployed copy as an edit, so it can replace `model: strong` in the team's agent with a concrete model such as `opus`. TeamAI does not check versions, so updating first is the only protection. The first ordinary `teamai pull` after a member updates replaces a literal `model: strong` with what the alias resolves to.

##### Namespaced aliases

A role or project gives an alias its own meaning in `models/<ns>/aliases.yaml`, same shape, read where `<ns>` is active in `resources.models` of your roles or projects, as `models/<ns>/models.yaml` is. Legacy mode (no roles, no projects) reads `models/aliases.yaml` alone.

- A namespace alias replaces the root alias of the same name whole: a tool it does not map gets no `model` field, even when `models/aliases.yaml` maps that tool.
- The same alias in two active namespaces holds agents with a `model` field, as a structural error does, and pull names both files. Rename or remove it in one of them, or stop declaring one of the namespaces.
- A name that any aliases file in the team repo defines, root or namespace, active for you or not, is an alias. An agent whose alias only an inactive namespace defines gets no `model` field, rather than the name as written, and your local entry for that name still applies. Pull warns once per such alias when it delivers an agent that uses it, naming the files: activate the namespace if the alias should apply to you, or rename the alias if its name was meant as a concrete model, such as `gpt-5-codex`.
- For the same reason, a structural error in any aliases file of the team repo, including one in a namespace that is not active for you, holds agents with a `model` field, and pull names that file.
- Pull warnings and push drift name the file an entry comes from, such as `models/checkout/aliases.yaml`. `teamai doctor` notes an alias that agents you receive use when a namespace that is not active for you also defines it.

##### Local override

A member replaces a team entry on their own machine in `~/.teamai/models/aliases.yaml`, which has the same `aliases:` shape:

```yaml
# ~/.teamai/models/aliases.yaml
aliases:
  strong:
    codex: { model: gpt-6-astra, effort: xhigh }
  fast:
    codex: default          # Codex uses its own default for fast
```

- For each tool, the order is: `tool_extras.<tool>.model`, then your entry, then the team entry, then no model field. A tool switched to a model profile filters the result of your entry or the team entry, as described next. Your entry replaces the team's whole entry for that tool, effort included, so `codex: gpt-6-astra` gives Codex no effort even when the team maps one.
- `~` or `default` for a tool gives it no model field and no effort, whatever the team maps.
- A key is a reserved name (`strong`, `fast`) or an alias the team defines, and a value can be any model. You can map `strong` before your team has a `models/aliases.yaml`. A name that is neither has no effect, since the file serves every team on the machine.
- claude-internal and tclaude use your `claude` entry, codex-internal and tcodex your `codex` entry, and Qoder CN your `qoder` entry, unless you give them their own. Your `claude` entry wins over the team's `tclaude` entry.
- The file is one per machine: it applies in every scope (user and each project checkout) and to every team that uses the alias name.
- An ordinary `teamai pull` applies an edit to the file, even when the team repo has not moved.
- The file follows the same rules as the team file, `~` aside, with one difference: a structural error holds only the agents whose `model` is an alias, since this file can make no name an alias, and the warning names the file by its path. Agents with a concrete model are delivered and pushed as usual. An entry this CLI does not know is dropped with a warning.

##### Tools switched to a model profile

A tool you switched with `teamai models switch` sends its requests to the profile's gateway, which does not know your account's models. For an agent whose `model` is an alias, pull therefore writes only what the switch can route:

- Claude keeps a resolved `opus`, `sonnet` or `haiku`, from your entry or the team's, because the switch points each of these families at a gateway model. Any other model is dropped.
- Codex, OpenCode, CodeBuddy and WorkBuddy get no `model` field.
- No switched tool gets an effort, neither the alias's nor one set in `tool_extras.<tool>`, unless `tool_extras.<tool>` also pins a model.

No `model` field means the tool's native inheritance, not the profile's model: Codex, for example, uses `[agents].default_subagent_model` when your config sets one, otherwise the model of the session that starts the agent. `tool_extras.<tool>.model`, a concrete `model` such as `opus`, and your `~` or `default` are written as they are without a switch. The Claude and Codex variants (claude-internal, tclaude, codex-internal, tcodex) are never switched. A tool counts as switched only while its live settings path (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) is the one the switch recorded and those settings still hold what TeamAI wrote, the same checks `teamai models restore` makes. While TeamAI cannot read its switch records (`~/.teamai/models/managed.json`), pull warns and holds alias agents in the five tools `models switch` supports; while it cannot read one switched tool's settings, in that tool only. An ordinary `teamai pull` after `teamai models switch` or `teamai models restore` rewrites the affected agents.

##### Push

For an agent whose `model` is an alias, each tool's `model` and the effort field the alias writes belong to the alias, not to the copy:

- A copy with the model and effort the last pull wrote, or the ones a pull would write now, is unedited. So pushing before you pull a change to `models/aliases.yaml`, your override or a switch reports nothing, and push's warning about a kept copy whose deployed version changed ignores such a change.
- Push never replaces `model: strong` with a concrete model and never writes the alias's effort into `tool_extras`. A model or effort you changed by hand in a copy is drift: push names the copy and where the value comes from, leaves the change out, and says where to make it: your override file for an entry that comes from it, your override file or the team aliases file the alias comes from (`models/aliases.yaml` or `models/<ns>/aliases.yaml`) for a team entry or an unmapped tool, `teamai models restore --agent <tool>` for a switched tool. `teamai push --dry-run` reports it too. Your other edits to that agent, such as its instructions or other fields, still push.
- To move an agent to another alias, write the alias name in a deployed copy, such as `model: fast` in place of `opus`, or `model: strong` in an agent that set `model: opus`, and push: push proposes `model: <alias>`. In a tool whose `tool_extras.<tool>.model` pins the model, the copy does not adopt an alias; a changed value there is reported as drift on that pin. Two copies that name different aliases conflict, as any two different values do.
- A new agent that exists only in a tool's directory is pushed with the model it has there, which is never turned back into an alias.

##### Checking with doctor

`teamai doctor` answers "why does Codex run this model". For each agent whose `model` is an alias, it prints a note with one line per installed tool the agent targets: the model and effort the tool receives, and in brackets the step that decided it. Agents and tools that resolve alike share a line; agents with a concrete model or none are left out, since they are written as their spec says.

```text
models: how model: strong resolves for agents implementer, planner:
    claude: opus, effort high  [team: models/aliases.yaml]
    codex: gpt-6-astra, effort xhigh  [local: /home/me/.teamai/models/aliases.yaml]
    opencode: tool default  [default: models/aliases.yaml does not map opencode]
```

| Step | Meaning |
|---|---|
| `extras` | `tool_extras.<tool>.model` pins the model; the alias is skipped |
| `switched` | the tool is switched to a model profile: Claude keeps `opus`, `sonnet` or `haiku`, other tools get no model field and pick one natively |
| `local` | your entry in `~/.teamai/models/aliases.yaml`; `tool default (chosen in <path>)` is your `~` or `default` |
| `team` | the team entry, in the file named |
| `default` | no model field: the alias does not map the tool, or no active aliases file defines it |

- A Codex-family line with a model and no effort says so: the effort of the session that starts the agent carries over.
- When the last pull deployed something else, such as before you pull an edit to your override, the line names what is deployed; an ordinary `teamai pull` updates it, and `Agents delivered to <tool>` lists the agent as `model changed since the last pull` without failing.
- Every entry an aliases file sets that this CLI drops is a note too.
- `Agent model aliases can be resolved` fails while a structural error in any aliases file (active or not, your own included), one alias in two active namespaces, or a switched tool whose settings cannot be read holds agents. It names the reason, the file and the held agents, as pull's own warning does.

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
- **Hooks** are delivered as an OpenCode *plugin*, not a settings-file entry — OpenCode has no `hooks` array; it auto-loads JS/TS plugins from **both** `~/.config/opencode/plugin/` and `<project>/.opencode/plugin/`. A plugin present in both dirs is loaded twice and would dispatch every event twice, so teamai keeps exactly one copy: `teamai-hooks.ts` in the user dir, which covers every project. Any project-scope copy left by an earlier layout is deleted on the next sync. This matches the other tools, whose `settings.json` hooks also live in HOME and gate on the `cwd` handed to `hook-dispatch`. The plugin subscribes to OpenCode's own events and shelling out to the same `teamai hook-dispatch` entry point every other tool uses. The event mapping mirrors the Claude built-in set: `session.created` → session-start, `session.idle` → stop, `chat.message` → prompt-submit, `tool.execute.after` → post-tool-use. The plugin forwards the same STDIN payload other agents send (`cwd`, `session_id`, `tool_name`, `tool_input`, `prompt`, and on post-tool-use the tool's output and status), and maps OpenCode's lowercase tool ids (`skill`, `todowrite`) back to the PascalCase matchers the handler registry expects. OpenCode cannot inject a hook's stdout back into the session, so hooks run purely for their side effects (status report / sync / update). Note that OpenCode *awaits* its named hooks (`chat.message`, `tool.execute.after`), so those dispatches briefly wait on the `teamai` subprocess before the agent continues; the errors are always swallowed so a hook can never fail the session. Server-pushed agent hooks (`teamai-agent-<slug>.ts`) install into the same user plugin dir. Upvote **adoption** runs for OpenCode from the recall log, not a transcript: the plugin's `shell.env` hook sets `TEAMAI_AGENT_SESSION_ID` in the bash tool's environment, so a `teamai recall` run there joins the session its hooks carry, and a `task` call links the subagent's child session to its parent, so a doc the parent opens after a subagent's recall is upvoted. The opt-in LLM-judge needs a transcript, which `session.idle` does not carry, so it does not run for OpenCode, and the "adopted team knowledge" summary is never shown, as hook stdout is discarded.
- **MCP** servers live under the `mcp` key of the shared `opencode.json` (see the MCP section above).

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) is supported through its documented skills, instruction, and extension surfaces:

- **Scopes.** Project skills and TeamAI-managed rules are written to `.pi/skills/` and `.pi/rules/`. User-scope copies use `~/.pi/agent/skills/` and `~/.pi/agent/rules/`.
- **Instructions.** Pi reads the project's own `AGENTS.md` (or `CLAUDE.md`); TeamAI leaves it unchanged. User-scope team instructions go to `~/.pi/agent/AGENTS.md`. In a project, the TeamAI Pi extension asks `teamai` for the member's team instructions when the session starts and adds them to the system prompt of each run.
- **Hooks.** TeamAI generates one user-scoped `teamai-hooks.ts` under `~/.pi/agent/extensions/`. It maps `session_start` → session-start, `before_agent_start` → prompt-submit, and `agent_settled` → stop; `tool_execution_start` caches the tool's input, and `tool_execution_end` dispatches post-tool-use forwarding that cached input as `tool_input`, plus the result's text as `tool_response` and a `tool_status` from its error flag. Every event carries the Pi session id (`ctx.sessionManager.getSessionId()`), the same id Pi's bash tool exports as `PI_SESSION_ID`, so a `teamai recall` run there joins the session its hooks carry and upvote **adoption** runs for Pi. Pi loads both user and project extension roots, so TeamAI never creates a project copy — a second copy would double-dispatch every event, the same single-copy policy as the OMP adapter. An older TeamAI-managed project copy is removed during the next sync, and injection never overwrites a same-named file that lacks the TeamAI marker. Pi has no settings file for self mode to commit, so a fresh clone still needs one `teamai init`/`pull` on that machine before Pi hooks are active there. The explicit `teamai hooks remove` command and user-scope `teamai uninstall --agent pi` delete this shared extension. Project uninstall preserves it for other projects and removes any legacy project copy; files without the TeamAI marker are never removed. `teamai hooks list` always reports this global path. Pi profile overrides (`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported for hooks — same as the OMP adapter — and the default `~/.pi/agent/` layout is used. Model profiles are separate and do read `PI_CODING_AGENT_DIR`. The shared extension remains installed after project uninstall; instruction dispatch checks the project's tool exclusion before adding its instructions.
- **Team hooks boundary.** The Pi adapter installs only the built-in lifecycle bridge. Custom team hooks and built-in hook overrides declared in `hooks/hooks.yaml` are skipped with a warning. Full team-hook and per-project ownership semantics require a separate cross-adapter design and are deferred to a follow-up PR.
- **Server-pushed agent hooks.** HTTP-source hooks are installed as `teamai-agent-<slug>.ts` extensions in the same global extension directory. Unsupported lifecycle events are skipped with a warning.
- **MCP (Pi 0.99.0+).** Supports stdio and streamable HTTP; SSE is skipped. User configuration goes to `~/.pi/agent/mcp.json`, project configuration to `.pi/mcp.json`; Pi loads project configuration only after trusting the project. The native `codemode` default is retained, without forcing direct exposure; timeout values in `mcp.yaml` are converted from milliseconds to seconds. Local exposure/enabled changes to managed entries survive unchanged team definitions but are replaced when the team definition changes; doctor compares complete entries and reports these local differences. An extension taking over `/mcp` can disable built-in MCP; remove that extension to use the built-in support.
- **Subagents.** TeamAI custom subagent files are not supported.

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

Oh My Pi (OMP) is available as a built-in target. TeamAI deploys skills, rules, and subagents to OMP's native directories — `.omp/skills/`, `.omp/rules/`, and `.omp/agents/` at project scope, and `~/.omp/agent/skills/`, `~/.omp/agent/rules/`, and `~/.omp/agent/agents/` at user scope (user-scope resources live under the agent directory `~/.omp/agent/`, a different prefix from the project one, so TeamAI switches prefixes with the scope). Team instructions go to `~/.omp/agent/RULES.md` in user scope and, in project scope, into each turn's system prompt through the extension below (see [Where the blocks go](#where-the-blocks-go)), and MCP servers merge into `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json` (Claude `mcpServers` shape — see the MCP section above). Skills are one-level `<name>/SKILL.md` bundles and TeamAI fills in a `description` on sync, which OMP's native skill provider requires to discover a skill. These paths follow OMP's documented discovery layout (verified against OMP 18.2.5). Hooks ride OMP's extension runner: `teamai pull` writes a single generated extension to `~/.omp/agent/extensions/teamai-hooks.ts` (never a project copy — OMP auto-loads both roots and would double-dispatch every event), which forwards OMP's `session_start` / `session_stop` / `before_agent_start` / `tool_result` events to the same `teamai hook-dispatch` entry point every other agent uses, gated on the session `cwd`. In a project session it also asks for the member's team instructions at `session_start` and appends them to the system prompt in `before_agent_start`. Every event carries the OMP session id (`ctx.sessionManager.getSessionId()`; a subagent has its own), and `tool_result` also the tool's text output and a status from `isError`, so upvote **adoption** runs for OMP's main agent: OMP sets no session variable in its shell, so a recall joins the session of the `bash` call that ran it, and a `read` with a line selector (`x.md:50-200`, `x.md:raw`) counts as a read of the file. From OMP 18.3.2 a subagent's events also carry its `ctx.agent` id and name, so the `teamai-recall` subagent's own reads never count. A subagent's session file sits under its parent's, whose header names the parent session, so the extension links the two on the subagent's tool calls, and a doc the main agent opens after a subagent's recall is upvoted (verified against OMP 18.4.8). The `session_stop` handler returns nothing, so a dispatch can never force a session continuation, and there is no matcher-scoped post-tool-use pass because OMP's tool ids are lowercase (`bash`, `read`, …) and it has no `Skill` / `TodoWrite` tool. User-scope `teamai uninstall` removes the extension; project uninstall preserves it for other projects. A same-named file without the TeamAI marker is never overwritten or removed, as with Pi. OMP profiles (`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported; the default `~/.omp/agent/` layout is used.

### DeepSeek Harness

DeepSeek Harness (`dsh`) is supported for TeamAI skills and shared resources. DSH's official Claude-hook bridge is a profile plugin rather than a settings-file hook surface, so when a user-level `~/.dsh/` installation is present, `teamai init`, `teamai pull`, or `teamai hooks inject` writes a Claude-compatible hook config and a Cordis patch under `~/.teamai/dsh/`.

TeamAI prints the exact absolute patch path. Add that `--patch` flag to the command that starts your DSH profile, for example `dsh tui --patch "<printed-path>"`. This is a one-time launcher opt-in; `teamai hooks remove` and `teamai uninstall` remove the TeamAI patch while preserving other hook entries in the generated config.

### JoyCode

JoyCode is available as a built-in target. Skills, rules, and subagents are deployed to `.joycode/skills/`, `.joycode/rules/`, and `.joycode/agents/`. Rules use Cursor-compatible `.mdc` files, including the same derived frontmatter and body-only round-trip behavior described below. Subagents use Markdown with YAML frontmatter.

JoyCode rule cleanup is conservative: local `.mdc` and `.md` files absent from the team rule list are preserved unless an explicit team removal tombstone exists. This protects personal rules in the shared directory; an old team copy without a deletion record is retained rather than guessed to be stale.

For canonical YAML agents, push compares each local file with the corresponding tool rendering and merges only actual edits back into the original spec. Deployment `targets`, other tools' metadata, and fields absent from a tool's native format are preserved. Conflicting or unparseable edits are skipped rather than replacing the canonical agent.

**Hooks & Manual Sync**: JoyCode currently does not provide a lifecycle hooks mechanism or dedicated launcher/startup adapter (no `settings.json` hook array or `hooks.json` format). Consequently, opening JoyCode does not fire TeamAI's `SessionStart` event, and cannot trigger background `teamai pull`, telemetry reporting (`teamai track`), or auto-update checks. Users working with JoyCode must run `teamai pull` manually in the terminal to synchronize team resources, and `teamai push` to contribute changes. If JoyCode adds hooks or extension lifecycle events in future releases, a dedicated hook adapter can be connected.

### Cursor

Cursor subagents deploy to `.cursor/agents/*.md` with YAML frontmatter carrying `agent_id` (the team agent's name), `description`, `tools`, and the agent's `model` when it declares one, plus any `tool_extras.cursor` fields; `reverseFromCursor` reads the same fields back, so a `pull` → `push` round-trip keeps the model.

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

`teamai stats` shows the current scope's skill usage and session totals, and a recall section when that scope's recall log has runs (see [Recall adoption and upvotes](#recall-adoption-and-upvotes)).

`teamai doctor` exits with code 0 only when every check passes, and code 1 when any check fails. Before initialization, it reports the missing configuration without assuming a Git provider. The same checks run at the end of a manual `teamai pull`, minus the provider ones and minus any check that pull already reported in its own words on that run. A check marked informational — currently only `No stale env blocks left behind` — still counts toward `doctor`'s exit code, but a pull does not fold its failure into `Pull finished, but N check(s) failed`: a leftover file from an earlier install is cleanup, not a sign this pull broke anything, so it is still named but on its own, gentler line.

Besides the provider, clone, config and hook checks, `doctor` verifies what reached your machine. `<tool> is installed` fails when `enabledAgents` lists a tool that nothing would be delivered to, which is the case where a pull reports success and that tool receives nothing. It asks the same resolver the sync uses, so a tool that keeps its skills somewhere other than its tool root, as OpenClaw does with its workspace directory, is judged where the sync would actually write. It reports an installed tool as passing too, so `--json` carries one entry per enabled tool either way. The checks at the end of a pull cover the scope that pull resolved from the current directory; run `teamai doctor` in another scope to check that one. `Skills delivered to <tool>` compares the skills your role namespaces, tag subscriptions and exclusions resolve to against what is on disk for each installed tool: it reports a skill that was never delivered separately from one that arrived unreadable — `SKILL.md` missing, its frontmatter unparseable, or its `name` not matching the directory, which keeps the agent from ever discovering it. `Team docs delivered` compares the docs you receive (a docs namespace you do not have active is left out) against `sharing.docs.localDir`, which has one destination rather than one per tool; each expected document has to be a file that can be read, so a directory or a dangling link sitting on the name counts as missing. It also reports extra non-hidden local files as stale, including when the team bundle is empty. Hidden local files are preserved and do not fail this check, and neither does a local copy of a team doc in a namespace you do not have active: pull removes it when it is unchanged and names it when you edited it. `doctor` also prints notes, which are information rather than failed checks. Each note names a namespace skill, agent, rule, shared-instructions file, env variable, hook, MCP server or team model profile that replaces a root one here (`rules: "style" from rules/checkout/style.md replaces rules/style.md`). When a namespace contributes env variables, hooks, MCP servers or team model profiles, a note also counts where that type's entries come from (`env: 3 received here (2 root, 1 checkout)`). Without roles or projects, the notes name each file the team repo defines more than once instead, and each env variable, hook or MCP server name repeated in its root file.

`Rules delivered to <tool>` and `Agents delivered to <tool>` do the same for the other two per-tool resources, and both ask the handler where an item lands rather than deriving a path: a rule's filename and content change per tool (`.md` verbatim, `.mdc` with derived `globs`/`alwaysApply`, `.instructions.md` with `applyTo`), and an agent's destination comes from its render, with `targets:` deciding which tools are owed a copy at all. A delivered rule is compared with the bytes the handler renders for that tool, not merely read for the keys its tool needs: a `.mdc` whose `globs` no longer match the team rule's `paths:` applies to the wrong files while carrying a perfectly legal `alwaysApply`, and that reads here as `delivered from an older copy` — the same label as a body that drifted, because both landed successfully and are still wrong. An agent is compared with the bytes its render produces, so a copy left behind by an older spec — a plain pull skips a scope whose team repo has not changed, so it can sit there indefinitely — is reported as `delivered from an older spec` rather than passing as present. `Every team agent reaches a tool` names an agent that renders for no installed tool — usually a spec that does not parse, or a `targets:` list naming only tools you do not have. These two are `doctor`-only: they read every rule per tool and parse every agent, which would spend the budget the checks at the end of a pull run under.

Three tools do not read a rules directory, so a per-file check cannot speak for them and each gets one of its own. `Team rules are active in opencode` checks that `opencode.json` still lists the glob the pull owns under `instructions`: OpenCode does not auto-scan `.opencode/rules`, so without it every delivered `.md` is inert while the per-file check keeps passing. `Team rules are inlined in Hermes SOUL.md` compares the teamai-managed block of `SOUL.md` with what the team rules inline to, since Hermes reads standing instructions from that one file rather than from a directory — a deleted block, or one left on an older rule set, is a tool reading the wrong rules with nothing on disk to show for it. In user scope, `Team rules are inlined in Codex AGENTS.md` compares the team-rules block of the tool's `AGENTS.md` with what the team rules inline to, and fails when an `AGENTS.override.md` beside it shadows the file. In a project, `Project rules and instructions reach <tool> whole through its session hooks` fails when the teamai `SessionStart` or `SubagentStart` entry in that tool's `hooks.json` is missing or does not set `additionalContextLimit: 0`, without which Codex keeps only the start and end of a large set. Codex has no `Rules delivered to <tool>` check.

`MCP servers delivered to <tool>` compares each server the team's `mcp.yaml` resolves for that tool against the entry in the tool's own config, and names any the reconcile skipped with its reason. The comparison is the entry, not the name: reconciliation leaves an entry teamai does not own alone, so a server of your own under a team name holds the key while the team's definition never arrives, and a stale copy is just as undelivered. Both are reported as `not the team's definition`, and only `teamai pull --force` replaces an entry teamai did not write. An unresolved `${VAR}` is reported here with the variable's name, which is otherwise said once during a pull and never again. A declared secret with no value is not a failure: doctor prints it as a note (`notes` in `--json`) with the command that sets it, and the exit code stays as it would be without it; a note also says when an entry kept for it may hold an old value, and when a key is declared as a secret and also set in `env.yaml`. An `mcp.yaml` that does not parse is not a team without MCP: it is reported as `Team MCP servers can be read` with the parse error, since it injects nothing into any tool and every run after the first is silent about it. Team hooks and team model profiles that cannot be resolved (a file that does not parse, a name defined twice in one file, or one name in two active namespaces) fail `Team hooks can be resolved` and `Team model profiles can be resolved` with the reason pull logs once; `teamai status` points here when it counts them as 0. `Env variables injected in shell profile` no longer stops at finding the marker comment: it checks that `env/env.yaml` parses and declares its variables under the `variables:` key (a plain `KEY: value` mapping parses as none, while an explicit `variables: []` is a configuration with nothing to deliver and fails nothing), that each one reached `env.sh` with the value `env.yaml` declares, or your value for this team (one set with `--from-env` is not written there) — a key left over from an older value exports it to every shell and MCP server until the next pull, and the comparison reads `env.sh` back through the generator's own inverse, so a multiline value quoted across several lines is matched rather than called stale — and that this scope's injected block (the one sourcing its own `env.sh`, since a profile can also carry another scope's) would actually load it — an unquoted Windows path degrades to something a POSIX shell cannot read, so `source` never runs and nothing says so. `No stale env blocks left behind` is a separate check: which file `pull` prefers has changed over time (Windows Git Bash's login shell reads `.bash_profile`/`.bash_login`/`.profile`, never `.bashrc`), and a pull only ever adds a block, never migrates an old one away, so a dead block from an earlier install or platform change can sit in another candidate file indefinitely. It names every such file (checking `.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login` and `.profile`, current and legacy spellings alike) and points at `teamai uninstall` to remove them — separately from delivery, so a working env block never reads as broken just because an old one is still lying around.

`Codex trusts this project, so it loads its team MCP servers` is built in project scope while the project's `.codex/config.toml` holds a server this worktree's `managed-mcp.json` records for Codex: Codex loads that file only in a trusted project, and skips an untrusted one without saying so. It reads the `projects` table of the Codex user config (`~/.codex/config.toml`, or the one under `toolRoots.codex`) as Codex does, taking the first `projects."<dir>"` entry that sets a `trust_level` for the checkout, then for its main checkout, each by real path (`/private/tmp/...`, not `/tmp/...`). It fails, naming the file and its servers, until that entry sets `trust_level = "trusted"`, and a pull reports the failure in its closing checks too. If the check still fails after pull attempts automatic trust, change project trust in Codex or add the main-checkout entry yourself, which covers every worktree. doctor only reads that file.

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

`scope` is `null` before initialization. `packages` is present only when the team repo declares packages, and carries the rendered report lines. `notes` appears only when there is an advisory: the namespace notes described above (an item that replaces a root one, or without roles or projects a name defined more than once) and the Codex hook trust reminder when Codex cannot be asked (no `codex` on PATH, or its app-server failed).

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

Self-update only reinstalls a copy that npm manages. When teamai runs from a checkout outside `node_modules`, such as one linked with `npm link`, both auto-update and `teamai update` skip the install and print a warning, because `npm install -g` would replace the link with the published package. Pull and rebuild the checkout to update it.

On Windows, the update check, installation, and hook refresh run without opening console windows.

### Usage reporting

By default, `teamai pull` commits session/usage stats into the team repo.
Pull waits up to 5 seconds for the reporting batch, then continues its other
work while reporting finishes. A late successful push still updates the local
reported snapshots. Skill usage is recorded per scope, in the data directory of
the project teamai is set up for where the session ran (or the user scope), so
each target reports only its own; a directory without teamai records none.
Dashboard sessions stay in one machine-wide `~/.teamai/dashboard/events.jsonl`,
but each event records a key of its scope's data home (a hash, not the path),
so a scope reports only the sessions recorded in it: a user-scope pull no
longer reports a project's sessions, and a project reports its Copilot sessions
and sessions started under a symlinked path. A session is reported once, whole,
by the scope it started in, even if it later moves into another project: its
Stop carries the whole transcript's totals, so a second scope would count them
again. Events recorded by an earlier release carry no key: the scope their
directory resolves to now reports them (a nested clone under a project resolves
to its own project or the user scope, not the enclosing project); events with
no directory, or one removed since, are reported by no one. Each scope also
keeps its own snapshot of what it already reported, and a session under a
reused fallback ID (Copilot's PID-based ID when it sends none) counts as new,
whichever scope reported the earlier one, while a resumed session
(`claude --resume`) keeps its ID and stays one session, reported by the scope
that first reported it wherever it is resumed; the first
report after upgrading starts from the snapshot every scope used to share, so
nothing is reported twice. A
target removes its usage events only after it confirms success; failed pushes
preserve them, up to the newest 5,000 (see below). The affected sync locks remain
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

Pull keeps each scope's usage file to its newest 5,000 events, dropping the
oldest after the report step. For an http source or a `usageReport: false`
team, that file is the only record `teamai stats` has, so it stays bounded
without going empty; a reporting scope whose report does not complete while
it holds more than 5,000 drops its oldest unreported events the same way. The
cap runs only after a report has removed the events it sent. Hook appends, the
report's truncate and the cap take one lock beside the usage file, so a rewrite
does not lose an event recorded while it runs. A hook that cannot take the lock
within ~250 ms records its event in a `*.pending-<id>.jsonl` file next to it,
which the next lock holder appends to the usage file; a rewrite that cannot take
it within ~5 s leaves the file as it is. A pending file gets no wider mode than
the usage file (owner-only while there is none). An in-workspace
`.teamai/.gitignore` ignores the lock, a rewrite's temp copy and the pending
files; `pull` and `push` add those entries to an existing single-repo one, and
the usage file's first pending file or rewrite adds them to an existing
project-scope one.

**Removing a skill another project reported into your `stats/`.** Before skill
usage was kept per scope, whichever project pulled next reported every
project's skills, so `stats/<user>.yaml` on `teamai-reports` can count a skill
that belongs to an unrelated repo. Those events recorded no directory, so
teamai cannot attribute them and never rewrites the file. Remove the entry by
hand, from a clone of your own so teamai's `reports-wt/` checkout is untouched:

```bash
git clone --branch teamai-reports --single-branch <team-repo-url> teamai-reports
cd teamai-reports
# delete the skill's entry under `skills:` in stats/<user>.yaml
git commit -am "stats: remove <skill> reported from another project"
git push origin teamai-reports
```

The next report reads the branch first, so the entry does not come back.

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

Source clones and their pull timestamps are cached by a SHA-256 hash of the configured repository URL, shared across source aliases. Teams can use the same source name for different repositories without sharing a clone or its 24-hour pull TTL. Aliases using the same URL share one revision and TTL, preventing an older alias cache from overwriting a refreshed shared skill. Changing the URL uses that URL’s cache; older alias-scoped and name-only clones are left untouched and are not reused. Removing a source retains repository caches for other installations.

Source installation manifests are separate for each team checkout and destination (HOME, project, or worktree). `source remove` releases only the current installation; shared caches and other records remain. If another destination already removed the alias from shared `teamai.yaml`, run `source remove <name>` in the remaining destination to clean its own recorded paths without rewriting that configuration. If the shared alias was re-added for another repository, stale or unidentified installation records likewise authorize only local cleanup; the new subscription is preserved.

Pull checks physical destinations before copying. If a different or unidentified source repository owns an overlapping target, the skill is skipped with an ownership-record warning; remove that other installation first to replace it. The same repository can share and update a path. Existing copies survive a newly conflicting target, and a conflicted repository replacement leaves the previous installation intact. Successful replacements release old recorded destinations. Cleanup keeps files until their last source owner releases them, including symlinked or overlapping paths. Dry-run performs the same conflict checks without changing skills or installation manifests.

Source tags use the current installation. Push also excludes another installation's skills when they occupy the current physical target. On upgrade, unscoped legacy `installed.json` records cannot prove a destination, so they are preserved and never used to delete files. Their skill names are held back from push with a warning, which may include an unrelated same-named draft. Review and back up remaining old copies, and archive legacy tracking only after accounting for all affected destinations; then pull active sources to establish scoped records. Previously unpublished legacy skills may need manual cleanup; automatic migration is not claimed.

Moving or deleting a team checkout does not automatically abandon its deployed files. Remove sources from their original scope first when possible. New manifests record the consumer checkout and destination, and ownership warnings identify the record to review. Orphan records remain protective until manually reviewed; there is no automatic orphan cleanup. If tracking is unreadable, skill push stops with a warning rather than publishing potentially third-party files.

Git source add, browse/cache refresh, pull, and removal use the same machine-local lifecycle lock, re-reading state under it. A busy operation asks for a retry instead of bypassing another live owner; dry-run only checks lock state and reads existing caches, without cloning, pulling, or updating cache timestamps. Uncached previews report that skill contents cannot yet be inspected. Skill push is also withheld when a source transaction is active.

A successful source pull records only its current destinations and releases obsolete tool paths, including when the repository URL is unchanged. A valid source config with no `publicSkills`, an empty list, or no remaining published skill directories releases the previous installation. Files still owned by another installation remain protected; a missing or unreadable source config leaves the old installation untouched. Conflict-retained copies keep their previous records.

Public skill names and recorded skill identities must already be canonical (no normalization-changing segments, repeated separators, backslashes, or trailing slash), so alternate spellings cannot bypass team-skill priority. Canonical nested names also respect local-team and builtin skill directory ownership, including ancestor/descendant conflicts. When this protection leaves previous source files in place, pull/removal retains their scoped provenance and excludes their paths from push pending manual review; it does not silently adopt them as team content. Source removal preflights all foreign ownership records and deletion targets before editing shared configuration. Ownership records must contain safe relative skill names and non-empty relative descendant paths; root-equivalent, escaping, and absolute paths stop cleanup before configuration or files are changed.

All accepted source aliases, including `.git`, `node_modules`, and names ending in `.pyc`, participate in ownership, provenance, and push checks; resource-directory filters never hide their tracking.

If any skill in a scoped record lacks non-empty recorded destinations, pull and source removal keep the entire installation unchanged and require manual review, including for the same repository and during previews. Current tool paths cannot prove historical deployment locations, so they never authorize inferred cleanup, overwrites, or replacement claims. Review and back up the original source copies and unrelated local files before manually retiring the ambiguous record; changing tool paths or retrying `source remove` does not resolve missing history. Ambiguous scoped claims are quarantined across checkouts, so another team sharing HOME cannot publish the retained source bytes. This can temporarily hide unrelated same-named drafts until the record is reviewed; complete modern pins remain path-specific. Older records with non-empty concrete plain paths remain supported. An ambiguous claim in another scoped installation or an unscoped legacy record also blocks source writes and cleanup for equal, parent, or child logical names before any mutation. Its warning identifies the record to review. This conservative name guard may block otherwise separate destinations because their historical location is unknown; it never invents deletion authority. Sources with unrelated names and complete recorded foreign paths retain their normal behavior.

After ownership preflight, source pull restores Codex's verified duplicate reconciliation: an unowned configured copy is removed only when it matches both the shared copy and incoming source. Different local copies, other installations, existing tracked paths, planned destinations, and repository inputs remain protected; dry-run never reconciles files. A symbolic-link skill root is copied as concrete contents only when it resolves to a child directory inside the source repository. Outside, dangling, or looping root aliases stop before deployment; ordinary in-repository aliases and tool-destination symlinks remain supported. Previously installed skill-root links retain their record and referent for manual review; a physical pin alone does not authorize deleting the link target. This does not migrate nested file symlinks.

Push excludes modern pinned source records by actual physical path only: an unrelated same-named local skill in another agent remains a candidate. Name-only quarantine is reserved for legacy or scoped records without complete physical ownership; malformed or incomplete pin metadata still stops skill push.

New scoped records pin each deployed path to its original physical destination, recorded after the copy. Before copying, withdrawing, or removing an existing installation, TeamAI checks every recorded destination; a changed, dangling, unreadable, or otherwise unverifiable symlink stops the operation before installed files, YAML, or the manifest change. Restore the original destination and retry, or manually review the retained files and record. Other installations protect the original pinned location, not a symlink's new target. Old scoped records without physical pins can authorize only explicitly recorded plain paths; existing symlinked paths (including symlinked roots) require manual review rather than guessed historical ownership. Newly installed stable symlink paths remain supported.

Canonical nested public names such as `group/child` remain supported. Pull refuses an ambiguous parent/child directory transition (including another installation of the same repository), or two distinct skill identities targeting the same physical directory, before copying any skill or changing the installation record. The warning requires manual review: back up the retained files, use `source remove` in the affected installation(s), then pull the new publication. When a retained parent contains another source's child directory, its own provenance also remains until that child installation releases ownership; remove the child installation first, then retry removal of the parent. No automatic subtree migration is attempted. Disjoint destination moves and exact-path sharing by the same repository and skill remain supported.

Status and skill inspection identify nested source installations by their recorded physical paths, without assigning that provenance to unrelated same-named copies. If scoped provenance cannot be read, status/skill inspection warns that source labels are incomplete; a local-only label is not proof of local ownership.

Do not run source installation/removal and push concurrently. The source mutex serializes source mutations, but push does not retain it through its entire staging/publication transaction; full cross-command snapshot isolation remains a limitation.

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
| `teamai recall <query>` | Search the team knowledge base (BM25 + graph boost, normalized across sources) |
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
| `teamai projects` | Bind a working directory to one or more logical projects; admins add, update and remove projects |
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

`teamai pull` mirrors the non-hidden `docs/` files you receive (see [Docs by namespace](#docs)) into `sharing.docs.localDir`: documents deleted from the team repo are also deleted locally, even when the last document or the entire team directory is removed. Empty stale directories are removed; hidden files and directories are preserved. Use a dedicated docs destination, since local-only drafts are also removed. A destination that overlaps the team repo or contains the home/project root is rejected; if it is already the team's `docs/` directory, no copying or cleanup is needed. File/directory type changes at the same path are handled using staged replacements; failed replacements restore the conflicting local entries. If a directory to be replaced contains hidden local entries, move those entries first; the sync refuses to discard them. A failed copy stops cleanup. `teamai pull --dry-run` previews the sync without changing files; use `teamai pull --force` to clean residue from a revision already synced by an older CLI.

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
codexTrustEnabled: false       # optional; per-machine, stops teamai trusting its Codex hooks and project (see Hooks)
toolRoots:                     # optional; per-machine tool roots (see below)
  claude: ~/.claude-work
  codex: ~/.codex-alt
```

#### Relocated tool roots (`toolRoots`)

A tool that can be told to keep its configuration somewhere else — Claude Code through `CLAUDE_CONFIG_DIR`, Codex through `CODEX_HOME` — reads nothing that teamai writes to the team-wide default. `toolRoots` names the directory that tool actually uses, keyed by the same tool id as `toolPaths`, and every path teamai resolves for it (skills, rules, agents, `CLAUDE.md`, settings and hooks, the user-scope MCP config, and Codex's co-author setting in `config.toml`) moves there with it. Other tools are untouched, and so are project-scope paths: those hang off the project root, where a per-machine root has nothing to say. Hooks are the exception that makes this worth recording — the built-in hooks are injected into your home directory even in project scope, so they follow `toolRoots` in both, and teamai trusts Codex hooks in the `config.toml` under `toolRoots.codex`.

`teamai init` fills it in for you: whenever `CLAUDE_CONFIG_DIR` or `CODEX_HOME` is set, init records the directory it points at (`toolRoots.claude`, `toolRoots.codex`) and prints it. That includes `CLAUDE_CONFIG_DIR=~/.claude`, which is not the same as leaving the variable unset — Claude Code reads `.claude.json` from inside the configured directory, so teamai writes the MCP config to `~/.claude/.claude.json` rather than `~/.claude.json`. `init` is also the only command that reads these variables, because they live in one shell profile while teamai also runs from session hooks and other terminals; resolving it per run would make the sync target depend on who started the process. A re-init keeps a root that was recorded earlier, so running `init` from a shell without the variable does not send the sync back to the default. When a re-init does move the root, the hooks teamai injected into the previous root's settings file (`settings.json`, Codex's `hooks.json`) are removed so that the tool stops syncing into the new one; the skills, rules and instruction files written there are left in place and named in the output. A project-scope `init` that has no record of its own and no variable to read starts from the user-scope record, since the root is a fact about the machine and project hooks land in your home directory. To end a relocation, run `init` once with the variable set but blank (`CLAUDE_CONFIG_DIR= teamai init …`, `CODEX_HOME= teamai init …`): the record is cleared and the old root released the same way. Along with the hooks, the old root loses the teamai-managed MCP servers and, for Claude Code, any gateway credentials the local agent delivered there; they are active configuration, unlike the skills and rules.

A root has to be somewhere teamai can recognize the tool at: a directory in your home other than `~/.config` itself (`~/.claude-work`), or a `~/.config/<name>` directory (a leading `~/` is expanded). Those are the two shapes the "is this tool installed?" check can look for; anything deeper, or outside your home directory, is refused with a warning rather than silently half-applied.

Skill-use tracking reads the recorded roots as well, so a relocated tool's skills count as installed, and `import --from-claude` reads a relocated Claude Code's rules.

`toolRoots` currently applies to `claude` and `codex` only, and any other tool id is refused with a warning. A root is only honest for a tool whose every user-scope write goes through `toolPaths`; the other tools still write somewhere teamai resolves separately — OMP's extension directory, the Cursor co-author file, OpenCode's plugin directory — so moving their `toolPaths` entries would leave the rest behind. Copilot CLI has its own mechanism: set `COPILOT_HOME`.

If you set or change `CLAUDE_CONFIG_DIR` or `CODEX_HOME` after initializing, `teamai doctor` reports it: the `Claude Code root matches CLAUDE_CONFIG_DIR` and `Codex root matches CODEX_HOME` checks (each built only when this config syncs that tool) compare the variable against the root this config actually syncs to and tell you to re-run `teamai init` — or, for a value teamai cannot sync to, say why. With the variable unset, the check stays out of the report.

### Webhook notifications (`sharing.webhooks`)

Notify external endpoints when team events happen. Each endpoint declares a `url`, a `type` (`json`, `feishu`, or `wecom`), and the `events` it subscribes to; `secret`, `timeout` (default `5000` ms), and `retries` (default `3`) are optional.

**Events and when they fire:**

| Event | Fires when |
| --- | --- |
| `session-start` | An AI session starts |
| `session-stop` | An AI session ends (includes Copilot's `SessionEnd`) |
| `skill-use` | A skill is invoked |
| `push` | `teamai push` **actually completes a real push** — not on `--dry-run`, a cancelled selection, a no-change run, or a failed PR creation |
| `pull` | `teamai pull` completes a real (non-`--dry-run`) sync — not when it held an agent whose model it could not resolve |
| `*` | Wildcard — subscribe to every event above |

**Payload.** Only whitelisted, non-sensitive fields are sent: `skillName` for `skill-use`, `sessionId` for session events; `push`/`pull` carry the event and metadata only. Raw tool input and tool output are **never** forwarded, and the whole body is passed through teamai's secret redactor before it leaves the machine.

**Signature.** When `secret` is set, each request carries `X-TeamAI-Signature: sha256=<hmac>`, an HMAC-SHA256 computed over the exact request body — so a receiver can verify authenticity. `teamai webhook list` and `teamai webhook test` inspect and exercise configured endpoints; `teamai webhook test --dry-run` previews how many endpoints would receive a request without sending one.

---

## Model profiles

Model profiles point Claude Code, Codex, OpenCode, CodeBuddy, WorkBuddy, and Pi at a shared model gateway. Nothing changes an agent until you run `teamai models switch`; after that, `teamai pull` keeps the switched agents on the team's latest catalog.

There are two sources, both in the same format:

- `team:<id>` comes from the team repository's `models/models.yaml`, and from `models/<ns>/models.yaml` for your active namespaces (see [Team profiles by namespace](#team-profiles-by-namespace)). It holds URLs and model IDs, never a key.
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
| Pi | any | `~/.pi/agent/models.json`: one provider keyed by the profile ref, holding every model. `settings.json` is left alone, so you pick the default with `/model` |

The example above has no `openai-responses` group, so Codex is left alone; add that protocol once your gateway serves those models over the Responses API.

### Use a team profile

```bash
teamai models list                     # every profile: file it comes from, key source, gateway, models, agents, where it is active
teamai models list tokenhub            # just one profile
teamai models switch tokenhub          # asks for the key the first time
teamai models switch                   # lists the profiles and asks which one to use
```

Run `switch` with no profile and it lists every profile, team ones first, and switches the one you pick; answer `none` to cancel. It takes a single profile, so an answer naming several is asked again rather than silently narrowed. Without a terminal there is nothing to pick from, so the profile is required there.

`switch` updates every installed, compatible agent. Narrow it with `--agent claude` (repeatable), pick the default model with `--model deepseek-v4-flash`, or preview with `--dry-run`.

To avoid storing the key, reference an environment variable instead:

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

Codex, OpenCode, CodeBuddy, and WorkBuddy then read the variable themselves. Claude Code cannot, so `switch` writes the resolved key into `~/.claude/settings.json`. There is no `--api-key <value>` option, because arguments end up in shell history and process lists. Key files are written with mode `0600`.

When the team edits the catalog, `teamai pull` re-applies it to the agents you switched to it.

### Team profiles by namespace

A project or role can give a team profile its own version, for example to point
checkout members at the checkout gateway under the same `id`. Put it in
`models/<ns>/models.yaml` and declare the namespace under `resources.models`, the
same way as for env, hooks and MCP servers (see
[Env, hooks and MCP servers by namespace](#env-hooks-and-mcp-servers-by-namespace)):

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

- **Override.** While `checkout` is active, a profile in `models/checkout/models.yaml`
  replaces the root profile with the same `id`, whole. Agents switched to
  `team:<id>` follow it on the next pull; when the namespace deactivates they go
  back to the root profile. A profile that exists only in a namespace you left
  is not removed from your agents: pull says it `is no longer active in your
  namespaces`, and `teamai models restore` undoes it.
- **Your key stays with its gateway.** A team profile's API key is stored for the
  profile `id` and the origin (scheme, host and port) of its `base_url`. When an
  override moves a profile to another origin, pull leaves the agents on it alone
  and prints a line to run `teamai models switch team:<id>`, which asks for the
  key of the new gateway (or run `teamai models configure team:<id>` first). The
  key for the first gateway is kept, so leaving the namespace needs no new key.
  The same applies when the team moves the root profile to another origin. A key
  configured before this version is used for the root profile's origin only.
- **Conflicts stop models, not the pull.** The same `id` in two active namespaces,
  or an active file that does not parse, means no agent is updated this run; the
  warning names the file(s). `teamai push` refuses any invalid models file.
- `teamai models list` shows the file each team profile comes from and whether
  it overrides the root one; `teamai doctor` lists each override as a note.
- **Upgrade every member first.** teamai 0.25.0 and the 0.26.0 betas reject the
  `models` key in `resources:`.

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
teamai models remove local:my-gateway  # agents keep their settings; restore still works
```

A full user-scope `teamai uninstall` restores managed model settings first and stops, keeping the record, if one cannot be restored. Project-scope uninstall leaves these machine-wide settings alone.

---

## Uninstall

`teamai uninstall` intelligently cleans up all teamai-managed resources, **preserving anything you created yourself**.

A targeted project exclusion also requires confirmation or `--force`, even when there are no local files to remove. `--dry-run` and a declined confirmation leave the project config unchanged.

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
- The teamai blocks (culture, shared instructions, recall, and Codex's team rules) in each tool's instruction file, and the files an earlier release wrote them to (your own content is preserved; a `teamai-context` file teamai wrote is removed whole, and OpenCode's `instructions` entry for it goes too when teamai added it, even when your own text keeps the file or the file is gone; an entry you listed yourself stays)
- Team-synced skills, including OpenClaw workspace skills (your own skills are preserved)
- Team-synced rules, including the copies older releases left in `.codex/rules/`, also of rules the team has since removed. Cleanup follows the recorded `toolRoots` location and the publisher's local filenames. A copy there you edited is kept and named in a warning. A removed rule's copy is deleted only if it matches its recorded delivery hash; without that record, it is kept and named too. Codex's `*.rules` files are kept
- Team-synced custom agents and CLI built-in agents (your own agents are preserved)
- The env block in your shell profile — every candidate file (`.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`) carrying a block that sources this scope's own `env.sh` is cleaned, not only the one file `pull` would choose today; a block sourcing a different scope's `env.sh` is left alone
- In a project, teamai's git hook: the `hook.teamai-post-checkout` and `hook.teamai-post-merge` entries in the repository's git config, and the marked block in `.git/hooks/post-checkout` and `post-merge` (a script left with only its shebang, the one teamai created, is deleted). Other hooks are kept
- The `~/.teamai/` directory

### Uninstall a single tool (`--agent <tool>`)

`--agent <tool>` removes only that tool's teamai resources (hooks, team instruction blocks, skills, rules, team-synced custom agents, and built-in agents). The tool name is a key of `toolPaths` (e.g. `claude`, `codex`, `codebuddy`) and is matched case-insensitively. An unknown tool name aborts without deleting anything, lists the available tools, and exits with a non-zero status.

An instructions file several tools map is cleaned per block: a teamai block stays while a remaining tool on that file still writes it. The common case is `.codebuddy/rules/teamai-context.md`, which CodeBuddy and WorkBuddy share: `--agent workbuddy` keeps it while CodeBuddy is installed. A file an earlier release wrote the blocks to, such as the project `AGENTS.md`, is read by no tool now, so its teamai blocks go and your own text stays. A file teamai created goes with its last block; an instructions file you had before stays, even an empty one. A configured `claudemd` remains a member file even when its basename is `teamai-context.md`.

Shared resources (the env block, docs directory, and `~/.teamai/`) are removed **only when the target itself has teamai resources AND is the last tool still using teamai** — otherwise they are kept for the remaining tools. Targeting a tool with no local resources leaves shared resources in place, even if it is the only tool. Project uninstall still records the exclusion for Pi, Oh My Pi, Hermes and the Codex family, whose instruction channels are global.

An enabled, installed Pi, Oh My Pi, Hermes or project Codex keeps the project state in use through its global delivery channel, even without a project-local tool directory. Uninstalling another tool preserves that state so the remaining tool can still deliver this project's instructions.

If removing an OpenCode entry added by teamai fails, uninstall exits with an error and keeps the shared data directory and ownership record, even when OpenCode is the last tool. Repair the config or its permissions, then retry the same uninstall command.

Project uninstall keeps Pi's and Oh My Pi's global extensions, Hermes' global plugin and configuration, the Codex family's user-level hooks and server-pushed agent hooks, which the user scope, the HTTP agent or another project on this machine may use, and names them in its summary. When none uses them, run `teamai hooks remove` in the project before uninstalling: it removes them. Targeted project Codex uninstall keeps the project config to record its exclusion and removes only project-owned resources and legacy hook copies. A targeted uninstall excludes the tool in this project's config when that config survives. User-scope uninstall removes these global delivery channels.

The exclusion is durable: `uninstall --agent <tool>` drops the tool from `enabledAgents` and records it in `disabledAgents`, so a later `pull` (or another tool's session-start hook) will not resurrect its skills, rules, agents, team instruction blocks, or hooks. Retained global adapters also skip HTTP sync and cached HTTP prompt injection for that excluded tool. Running `init --agent <tool>` again clears the exclusion and re-enables sync for that tool.

The same `enabledAgents` whitelist (from `init --agent`) also gates CLI built-in skills/rules/agents and team instruction blocks: an already-installed tool outside the list is neither written to nor deleted from, even if its root directory already exists. `teamai remove` respects the same whitelist for agents, rules, and skills, `teamai push` reads no rules or agents from a tool outside it, and `teamai pull` / `teamai mcp inject` respect it for MCP servers. Editing `enabledAgents` without `init` still invalidates the last-pull skip cache for newly added tools.

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --scope user --role <role_id> --force
```

---

## FAQ

**Q: Can user scope and project scope coexist?**

Yes, but project scope remains isolated by default. When the current working directory contains a project-scope config, it is active and user scope is skipped. Initialize user scope first, then initialize the project with `--inherit-user-scope` (or set `inheritUserScope: true` in the project's local config) to compose safe resources and Recall results. Executable and control-plane configuration (`env`, MCP) remains project-only; hooks are the exception — a non-self project scope injects the built-in hooks into HOME so `hook-dispatch` can gate on `cwd` (see the Hooks section).

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --force
```

**Q: After `teamai init` in a project, there is no `.claude/` (or `.cursor/`, `.codebuddy/`) directory?**

That is expected for a built-in tool when `init` ran without `--agent` and without a terminal (no picker): it does not know which agent you will open. Run `teamai init <repo> --agent claude` (or `cursor`, `codebuddy`, …) to create that tool's root and fill it before init exits, or open the tool in the project: the SessionStart hook creates that tool's project root and then pulls. A bare `teamai pull` will not create missing agent roots. The exception is a custom agent defined only in `teamai.yaml`'s `toolPaths` (not one of the built-in tools) — `init --agent <id>` creates that agent's root itself, since nothing else ever would. This only works for git-backed init (default or `--self`): an HTTP init (`--http`) never clones a local `teamai.yaml`, so it has no custom paths to seed from and only ever creates roots for built-in tools that are already installed.

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
