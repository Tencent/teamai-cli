<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli" width="430">
</p>

# TeamAI — The team harness for AI agents

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Make every AI coding agent work by the same harness.

Git-native management of skills, rules, and docs across 20+ AI tools — for you or your whole team.

**Supports:** Claude Code, Codex, Cursor, CodeBuddy IDE, as well as Gemini CLI, Windsurf, Trae, Aider, Amp, OpenClaw, and 20+ other AI coding tools (skills sync).

> 📖 **Full usage guide:** [docs/usage-guide.md](docs/usage-guide.md) — covers everything from team creation to day-to-day use.

> 📚 **Provider notes:** [docs/providers.md](docs/providers.md) — GitHub / TGit differences and auth setup.

Questions or suggestions are welcome — please open a PR or an Issue and help build this project together.

## Install

```bash
npm install -g teamai-cli
```

<details>
<summary>Tencent internal users: install <code>@tencent/teamai-cli</code> via tnpm</summary>

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```

The two packages share identical source code; `@tencent/teamai-cli` is just the internal mirror of the public `teamai-cli`.
</details>

## Quick Start

### Team members

```bash
# User-scope init (default, resources installed under ~/)
teamai init --repo yourteam/yourproject

# Project-scope init (resources installed under the project directory)
cd /path/to/my-project
teamai init --repo yourteam/yourproject --scope project

# Non-interactive mode (for CI/CD or AI-agent automation)
teamai init --repo yourteam/yourproject --scope user --role hai_dev --force
```

### Admins

First create the shared-experience repo on your git host (GitHub by default; TGit also supported) and grant write access to every team member.

- **GitHub:** create with `gh repo create yourorg/yourproject --private` or via the UI. Then use Settings → Collaborators to add members, and set `master`/`main` as the default branch.
- **TGit (Tencent Gongfeng):** create on [git.woa.com](https://git.woa.com/) and grant master permissions in bulk via user groups.

The CLI picks a provider automatically from the repo URL:

- `yourorg/yourrepo` or `https://github.com/yourorg/yourrepo` → GitHub
- `https://git.woa.com/yourteam/yourrepo` → TGit

## Commands

| Command | Description |
|---------|-------------|
| `teamai init [--scope <user\|project>] [--role <id>] [--force]` | Initialize (auto-installs gf CLI, OAuth login, links repo, registers member, configures reviewers, injects hooks) |
| `teamai push [--all] [--role <id>]` | Push local new resources to a dedicated branch and open a Merge Request; new skills prompt interactively for a target namespace (override with `--role`) |
| `teamai pull [--silent]` | Pull team resources and inject them into local AI tools (both scopes pulled sequentially) |
| `teamai status` | Show the diff between local and the team repo |
| `teamai list [type] [--source repo\|local\|all] [--agent <id>]` | List resources (skills\|rules\|docs\|env\|wiki). With `--source local` or `all`, scans skills directories of installed AI agents and tags each skill's origin (`[team]` / `[builtin]` / `[source:<name>]` / `[local-only]`) |
| `teamai skill [list\|show <name>]` | List all skills by default; `show <name>` prints the skill's origin, contributors, installed-agent list, and description summary |
| `teamai members` | List registered team members |
| `teamai remove <type> <name>` | Remove a resource from both the team repo and local, then open an MR (skills\|rules\|wiki) |
| `teamai roles` | Manage team roles (`init`/`list`/`set`/`add`/`remove`/`update`) |
| `teamai source` | Manage cross-team skill subscription sources (`add`/`remove`/`list`/`browse`) |
| `teamai contribute --file <path> [--scope <user\|project>]` | Push an AI-generated experience document to the team repo |
| `teamai recall <query>` | Search the team knowledge base, automatically merging user + project scope results |
| `teamai import --from-repo <url>` | Clone a remote repo and generate a per-repo summary under `docs/team-codebase/repos/<slug>.md`; AI recommends a business domain and persists the assignment to `.teamai/domains.yaml` |
| `teamai import --from-repo-list <yaml>` | Batch import a whitelist of repos with concurrency control, then aggregate the results into per-domain views |
| `teamai import --from-org <org> --bootstrap` | List every repo under an organization (GitHub or TGit), AI-cluster them into business domains, and run an interactive review before the first full sync |
| `teamai import --from-iwiki <id> [--iwiki-dual]` | Import iWiki documents as learnings; in dual mode also extract business-API / external-knowledge / glossary sections into `docs/team-codebase/external-knowledge.md` |
| `teamai cache --status \| --gc` | Inspect or garbage-collect the shallow-clone cache at `~/.teamai/cache/repos/` (LRU + size cap, default 5GB) |
| `teamai codebase --lint [--fix]` | Cross-file consistency lint over `docs/team-codebase` and `.teamai/`; reports anchor / orphan / source-invalid / sync-stale issues; `--fix` applies low-risk mechanical fixes |
| `teamai review [id] [--apply \| --reject \| --all-apply]` | Inspect and process pending codebase changes from `.teamai/pending-review.jsonl`; `--apply` patches in place via section anchors |
| `teamai domains drift [url] [--apply \| --lock \| --apply-all]` | Inspect and resolve domain-drift signals; `--apply` reassigns the repo to the recommended domain and refreshes the aggregate views |
| `teamai digest` | Generate a team AI usage weekly digest (skill leaderboard, new/updated skills, session summaries) |
| `teamai hooks` | Manage AI-tool hooks (`list` shows installation status; `inject`/`remove` update settings) |
| `teamai ci extract-mr --url <url> [--mode comment\|write\|both] [--individual-comments]` | CI pipeline integration: extract knowledge from MR/PR, post as comments, and write to team repo after merge. With `--individual-comments`, each suggestion is posted separately with reaction/reject support (GitHub 👎 / TGit ☝️) |
| `teamai uninstall [--force]` | Uninstall teamai: remove hooks, rules, skills, env, docs, and `~/.teamai/` |
| `teamai doctor` | Diagnose configuration problems |

Global options:
- `--dry-run` — preview mode, no real changes
- `--verbose, -v` — verbose output

## How It Works

```
Member A                             Member B
  create skill / write rules           same
    │                                     │
    ▼                                     ▼
  teamai push                        teamai push
    │                                     │
    ▼                                     ▼
  create branch + MR                 create branch + MR
    │                                     │
    └──────► team git repo ◄─────────────┘
                  │         ▲
                  │         │ reviewer approves + merges MR
                  ▼
             SessionStart hook → teamai pull
             auto-synced to every member's local
```

- `teamai push` creates a dedicated branch (`teamai/push/<user>/<timestamp>`), pushes it, then opens a Merge Request and assigns reviewers automatically.
- `teamai init` lets you configure default reviewers (stored in the `reviewers` field of `teamai.yaml`).
- `teamai init` injects hooks tailored to each tool's format (`SessionStart`, `Stop`, `PostToolUse`, `UserPromptSubmit`, etc.). During sessions the hooks run `teamai pull`, `teamai update`, tracking, dashboard updates, and so on (supports Claude Code, Codex, Claude Code Internal, Codex Internal, Cursor, CodeBuddy IDE, OpenClaw, WorkBuddy).
- Skills sync to `~/.claude/skills/`, `~/.codex/skills/`, `~/.codex-internal/skills/`, `~/.claude-internal/skills/`, `~/.cursor/skills/`, `~/.codebuddy/skills/`.
- Rules sync to each tool's rules directory and are merged into `CLAUDE.md` via marker comments (supported for claude, claude-internal, codebuddy).
- Knowledge syncs to `~/.teamai/docs/`.
- Learnings sync to `~/.teamai/learnings/` and back the recall index (shared team-wide, not partitioned by role).
- Culture syncs the team culture file (`culture.md`): its frontmatter and body are compiled and injected into every AI tool's `CLAUDE.md`.

## Role-scoped Skills

When the team resource repo enables role-scoped directories, skills are organized under role namespaces. During `teamai init`, the CLI asks you to pick a `primaryRole` and optional `additionalRoles` and writes them to your local `config.yaml`.

Remote repo layout convention:

```text
manifest/roles.yaml            # role definitions
skills/<namespace>/<skill>/    # skills organized by namespace
rules/                         # global, not role-scoped
```

- `teamai pull` reads `manifest/roles.yaml` and only syncs skills under `primaryRole + additionalRoles` namespaces (unioned with tag-filter results).
- Skills install flat from `skills/<namespace>/<skill-name>/` into `<tool>/skills/<skill-name>/` — the namespace layout is invisible to users.
- If two activated namespaces contain a skill with the same name, `pull` fails outright to prevent silent overrides.
- Skills outside both activated namespaces and tag-filter results are cleaned up automatically.
- `rules/`, `docs/`, `learnings/` keep their original behavior and are not role-scoped (learnings are shared team-wide).

Example config:

```yaml
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

This syncs every skill from `skills/common/`, `skills/hai/`, and `skills/pm/`.

## Role-scoped Pushing

In a role-scoped repo, when you push a new skill the CLI auto-detects available namespaces and prompts:

```bash
# Interactive namespace selection (recommended)
teamai push
# Output:
# Which namespace should new skills be pushed to?
#   1. common
#   2. hai
#   3. pm
# Choose namespace [1-3] (default: 1 = common):

# Explicit target namespace
teamai push --role pm
```

- With a `primaryRole`, the list expands from `manifest/roles.yaml`.
- Without a `primaryRole`, namespaces are discovered by scanning the team repo's directory structure.
- When only one namespace exists, it's selected automatically — no prompt.
- `--role <id>` temporarily overrides the target namespace.
- Modifying an existing skill keeps its original namespace — no reselection needed.

On push, the CLI checks `SKILL.md`'s YAML frontmatter (`name`/`description`) and auto-fills anything missing, so you don't have to maintain it by hand.

## Team Culture

Create `culture.md` at the root of the team repo. Use YAML frontmatter for company/team info and the body for cultural guidelines:

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  values:
    - Innovation
    - Integrity
team:
  name: Platform
  mission: Enable developers
  goals:
    - Ship v2.0
    - Improve test coverage
---

## Coding Guidelines

- Every PR needs at least one reviewer approval
- Direct pushes to master are forbidden
- Test coverage must stay above 80%
```

`teamai pull` compiles `culture.md` into structured content and injects it into every AI tool's `CLAUDE.md` (between `<!-- [teamai:culture:start] -->` and `<!-- [teamai:culture:end] -->`). AI coding assistants pick up the team culture on every session.

## Cross-team Skill Subscription

Use `teamai source` to subscribe to other teams' public skill repos. Their skills sync automatically on `pull`:

```bash
# Add a subscription source
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# List subscribed sources
teamai source list

# Browse skills from a source
teamai source browse other-team

# Remove a subscription (and clean up its skills)
teamai source remove other-team
```

Subscribed skills sync to your local machine on `teamai pull` and coexist with your own team's skills.

## Scope

TeamAI supports two scopes that can coexist:

| Dimension | User Scope (default) | Project Scope |
|-----------|---------------------|---------------|
| **Install location** | under `~/` (e.g. `~/.claude/skills/`) | under the project (e.g. `<project>/.claude/skills/`) |
| **Config file** | `~/.teamai/config.yaml` | `<project>/.teamai/config.yaml` |
| **Use case** | general team norms, cross-project skills | project-specific skills and rules |
| **Init** | `teamai init --repo <group>/<repo>` | `cd <project> && teamai init --repo <group>/<repo> --scope project` |

**Dual-scope cooperation:**
- `teamai pull` pulls user and project scopes sequentially; they don't conflict.
- `teamai contribute --scope user/project` lets you pick which repo to push to.
- `teamai recall` merges knowledge bases from both scopes into a single ranking and tags each result with its origin `[user]` / `[project]`.
- The `scope` field in the remote `teamai.yaml` locks the repo's type; member init must match.

## Automatic Experience Sharing

When an AI coding session ends, the Stop hook evaluates session value and prompts you to share:

```
AI coding session (ongoing...)
    │
    ▼  PostToolUse hook continuously tracks tool calls and skill usage
    │
    ▼  session ends (Stop hook fires)
    │
    ├─ Smart scoring: tool-call count + tool diversity + skill usage + error retries + session duration
    │  (extracted from dashboard events.jsonl, one-shot, out of 100)
    │
    ├─ Score < 35 → stay silent (too few or too uniform calls, not worth summarizing)
    │
    ▼  Score ≥ 35
    │
    AI: "This session was productive — consider running /teamai-share-learnings to share."
    │
    ▼  user accepts
    │
    /teamai-share-learnings (AI sub-agent)
    ├─ AI summarizes the session's lessons
    ├─ Generates a Markdown document
    └─ teamai contribute --file <path> → pushes directly to the team repo's learnings/
```

- `/teamai-share-learnings` is a built-in CLI skill, deployed locally by `teamai pull/init`.
- Each session is prompted at most once (de-duplicated); you can always ignore it.
- The document lands directly in `learnings/` and is visible to teammates on their next `pull`.

## Team Knowledge Recall

`teamai recall` implements the "read" side of the knowledge flywheel — the AI can search across accumulated team experience docs:

```
contribute (write) → pull (sync + index) → recall (search) → upvote (vote) → better ranking
```

```bash
$ teamai recall "fuse port"
[1/2] MR review caught a FUSE port-conflict bug ★1 [user]
Author: jeffyxu | Score: 18.5 | Tags: troubleshooting, fuse, k8s

[2/2] FUSE deployment configuration best practices [project]
Author: alice | Score: 12.0 | Tags: fuse, deploy
```

- **Dual-scope merged search:** automatically merges user and project scope knowledge bases, each result tagged with its origin.
- Hybrid CJK + English search (Intl.Segmenter + CJK bigrams).
- Searches implicitly upvote matched docs; good docs naturally float up over time.
- Votes are written to each scope's own repo, so attribution stays correct.

`teamai recall` results carry a `[<type>]` tag so callers can quickly tell which knowledge bucket a hit came from. The shared search index covers four categories:

| Type | Source | Notes |
|------|--------|-------|
| `[learnings]` | `~/.teamai/learnings/*.md` | session experience documents |
| `[docs]` | team repo `docs/**/*.md` | shared project knowledge |
| `[rules]` | team repo `rules/**/*.md` | coding rules and conventions |
| `[skills]` | team repo `skills/<name>/SKILL.md` | reusable AI skills |

The index is rebuilt automatically on every `teamai pull`. Indexes built by older versions (no `version` field or missing `type`) are detected and rebuilt transparently on first use.

### TodoWrite reminder hook

`teamai pull` registers a PostToolUse hook on the `TodoWrite` tool. The first time a session writes a TODO list, the hook injects a one-time reminder asking the agent to invoke `teamai-recall` if it has not already done so. Per-session deduplication uses `~/.teamai/sessions/<sid>-todowrite-hint.json` (24 h TTL).

To disable the reminder globally, set:

```bash
export TEAMAI_RECALL_DISABLED=1
```

The same env var also disables the auto-recall hook.

### `agents` resource type

The team repo can ship custom subagent definitions under a flat `agents/` directory (one `*.md` file per agent). They follow the same push / pull / remove semantics as `rules`:

```text
team-repo/
  agents/
    code-reviewer.md      # team-authored subagent
    .removed              # tombstone (auto-managed by `teamai remove agents <name>`)
```

`teamai pull` copies them into every Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`). The CLI built-in `teamai-recall.md` is deployed alongside team agents and is **excluded** from `teamai push` (it is CLI-managed, not team-managed).

## Update

```bash
teamai update              # auto-detect and upgrade to latest
npm update -g teamai-cli   # or trigger an npm upgrade manually
```

`teamai update` picks the registry based on the installed package name:

- `teamai-cli` → public npm (`https://registry.npmjs.org`)
- `@tencent/teamai-cli` → internal tnpm (`http://r.tnpm.oa.com`)

To override the registry manually, set `TEAMAI_NPM_REGISTRY=<url>`.

### Auto-update Control

Auto-update runs on the Stop hook at the end of a session. It can be controlled at two layers:

| Layer | File | Field | Allowed values |
|-------|------|-------|----------------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always wins over the team-level `autoUpdate`.

## CI Integration

TeamAI can integrate into your CI pipeline to automatically extract knowledge from every MR/PR:

```
MR opened/updated → CI extracts learning + codebase suggestions → posts as comments
    → Reviewer rejects unwanted suggestions (GitHub 👎 / TGit ☝️)
    → MR merged → CI writes approved items to team knowledge repo
```

### Quick Start

```bash
# Comment mode: post suggestions to MR (run on PR open/update)
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write mode: write approved items to knowledge repo (run after merge)
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

### CI Templates

Ready-to-use templates in `examples/ci/`:

| File | Platform |
|------|----------|
| `github-actions-mr-extract.yml` | GitHub Actions |
| `coding-ci-mr-extract.yaml` | Coding CI (TGit + ZhiYan QCI) |

### Reject Interaction

| Platform | How to reject | Default |
|----------|--------------|---------|
| GitHub | Add 👎 reaction to the suggestion comment | Write all |
| TGit | Add ☝️ emoji to the suggestion note | Write all |

## License

[MIT](LICENSE)

## Contributing

PRs are welcome! Please read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first.
