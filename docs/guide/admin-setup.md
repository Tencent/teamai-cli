# Admin Setup

> [English](admin-setup.md) | [简体中文](zh-CN/admin-setup.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Admin Initialization

> Only one admin needs to do this — other members can skip to [Member Onboarding](./member-guide.md#member-onboarding).

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

Members who only sync and never need the CLI to open merge requests can skip the token: see [plain Git with `--provider git`](./member-guide.md#member-onboarding).

**Already initialized with `provider: git`?** Set the variables above and change `provider` to `gitlab` in the team repo's `teamai.yaml`. Setting the environment variables alone does not change an existing provider selection. A failed `teamai push` may already have pushed the branch; if its diagnostic detects GitLab, it prints these recovery steps. See [provider configuration](providers.md#gitlab-provider-including-self-hosted).

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

~/.teamai/projects/<path-slug>-<hash>/  # this project's machine-data partition (slug derived from the project path)
├── config.yaml
├── state.json
├── team-repo/                           # clone of the team repo (knowledge on the default branch)
├── learnings-wt/                        # checkout of the `teamai-learnings` orphan branch
├── pending-learnings/                   # contributions not published yet
└── reports-wt/                          # checkout of the `teamai-reports` orphan branch
```

Independent git clones use the same split as single-repo mode: `members/` `sessions/` `votes/` `stats/` go to the `teamai-reports` orphan branch and `learnings/` goes to `teamai-learnings` (both checkouts sit **beside** the clone, not inside it). Knowledge (`skills/` `rules/` `docs/` `teamai.yaml`) stays on the default branch, reached by pull request. Report files and learnings already on `main` are left in place: `members/` keeps being read from the default-branch copy as a read-only inherited root (nothing copied or deleted; when the same file exists on both, the branch copy wins), other reports are ignored from then on, and learnings keep being read.

In both modes, commands that only read reports (`members`, `digest`, `projects members`, `stats`) never create or push the `teamai-reports` branch. `teamai pull` refreshes the reports checkout from `origin` before it rebuilds the search index (vote hotness) and skill recommendations. Report writers (session save `--push`, Stop-hook votes, member registration, auto-report) merge into origin's latest copy of the member's file first, so the same member reporting from two machines does not lose a session, vote, or stats entry.

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
every worktree: `hook.teamai-post-checkout`, `hook.teamai-post-merge` and
`hook.teamai-post-rewrite` (Git 2.54 or
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
After `git pull` (`post-merge`, or `post-rewrite` for a completed rebase, including
`pull.rebase=true`; on Git 2.32 and older, a fast-forward rebase with autostash runs
only `post-checkout`, which syncs the same way), the hook fetches the team repo, waiting at most 5 seconds,
and delivers its changes before `git pull` returns; past 5 seconds, and for sources,
learnings and reports, the same background pull takes over. In single-repo mode it
delivers the knowledge `git pull` just brought, with no network. A conflicting rebase
syncs only when completed; `git commit --amend` does not sync. The hook prints nothing and always exits 0, so a failed pull never
fails the git command. A failure inside it (the team repo fetch failed, or stopped at the
5-second cap and the background pull did not finish it; another teamai process held the
project's sync lock longer than the hook waits, 5 seconds after `git pull` (including
single-repo mode) and 60 seconds for a new worktree; incomplete resource, hook or MCP
delivery) is written to `~/.teamai/debug.log` and recorded: `teamai doctor`
names it with its fix, and each interactive `teamai pull` mentions it until one completes. The
background pull retries, and a hook or interactive pull clears the record only after all startup delivery
stages succeed. `teamai doctor`
also reports whether the hooks are installed and enabled. Git 2.54+ can disable a
named hook (`hook.teamai-<event>.enabled=false`); Git 2.55+ can also disable the
whole event (`hook.<event>.enabled=false`). Both settings can be global, local or per-worktree. Doctor checks the effective
Git setting and gives the reactivation command for its scope (a local override, or unsetting a worktree setting, which a local one cannot override); `teamai pull` preserves an explicit
disablement. After enabling it, run `teamai pull` to sync. It follows the scope rules below: no project config, or one
that cannot be read, means no sync; an unreadable config's reason is kept in
`~/.teamai/debug.log`. The command is one `sh` line that runs
`teamai hook-dispatch <event> --tool git` with Git's arguments, finding `teamai`
through `~/.teamai/bin` as the agent hooks do.

With Git older than 2.54 and no `core.hooksPath`, teamai instead adds a block between
`# >>> teamai git hook` and `# <<< teamai git hook <<<` markers to `.git/hooks/post-checkout`
along with `.git/hooks/post-merge` and `.git/hooks/post-rewrite`, right after the
shebang, creating the script when there is
none; the script's other lines are kept. The block runs the same command, silently, and
does not change the script's exit status. With `core.hooksPath` set (a hook manager), or
a hook script that is a symlink or not an executable shell script, teamai writes nothing, and `teamai doctor`
advises: upgrade Git to 2.54 or later; or, if the team agrees to commit it, run
`command -v teamai >/dev/null 2>&1 && teamai hook-dispatch <event> --tool git "$@" >/dev/null 2>&1 || true`
from the post-checkout, post-merge and post-rewrite hooks your manager defines (with the
corresponding event as `<event>`), wrapped in `sh -c '...'` when its config is not a shell script.
That line does nothing on a machine without teamai.
Existing hook contents and permissions are preserved. Reading or writing a hook can
fail: `init` and `hooks inject` propagate that error; a Git-started pull records it
and the next `teamai pull` retries.

Once Git is 2.54 or later, the next `teamai pull` installs the config hook and takes the
block out, so the hook does not run twice. `teamai pull --dry-run` says when it would
install or update the hook and writes nothing. `teamai uninstall` in the project removes
the `hook.teamai-post-checkout`, `hook.teamai-post-merge` and `hook.teamai-post-rewrite` entries and the marked
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

Every `init` flag is listed in [`commands.md`](../../skill-data/core/references/commands.md) and `teamai init --help`; `--project` is explained under [Multi-project](#multi-project-project-as-a-dimension-orthogonal-to-role) below.

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
- **`teamai contribute`** defaults to `learnings/<namespace>/` when the active
  projects resolve to exactly one learnings namespace, otherwise to the shared
  root. Pass `--namespace <ns>` to choose one of those active namespaces;
  `teamai projects list` shows the default destination and accepted namespaces.

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

# Admin: edit manifest/projects.yaml and open a PR
teamai projects add checkout --namespaces common,checkout --name "Checkout"  # The first add creates projects.yaml
teamai projects update checkout --add-namespaces payments --remove-namespaces common
teamai projects remove checkout
```

`--namespaces` sets the same namespaces on every project resource type
(`knowledge`, `skills`, `learnings`, `agents`); `update` adds or removes them on
each type's own list, so a hand-edited per-type layout survives. Neither touches
`env`, `hooks`, `mcp`, `models`, `docs` or `wiki`: declare those by hand (see
[Env, hooks and MCP servers by namespace](./sharing.md#env-hooks-and-mcp-servers-by-namespace)),
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
  localPath: ~/.teamai/projects/<path-slug>-<hash>/team-repo
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

- **`--agent <name...>`** — explicit list, repeatable or comma-separated: `--agent claude`, `--agent claude,codex`, `--agent claude --agent cursor`. The picker offers `claude`, `codex`, `cursor`, `copilot`, `pi`, `joycode`, `codebuddy` and `workbuddy`; `--agent` also accepts any other known agent id, such as `dsh` (DeepSeek Harness).
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

> **Heads-up on `env`.** In single-repo mode `.teamai/env/env.yaml` **is committed to main** (unlike standalone mode's per-machine env), so it travels to everyone who clones the repo. `env.yaml` stores plaintext key/value pairs — put only non-secret shared config there. Declare a secret without its value in `.teamai/env/secrets.yaml` (see [Team secrets](../designs/team-secrets.md)) and keep the value in your own untracked environment.

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
