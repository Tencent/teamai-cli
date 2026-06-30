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

### Read-only consumers (HTTP team repo, no git)

Some users or agents only need to *consume* a team's skills/rules — no git clone, no push. Onboard them over plain HTTP with just an API key:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- **Read-only:** `push` / `contribute` / `remove` are disabled for HTTP repos.
- The API key is stored `0600` (never written to config, never committed); `TEAMAI_API_TOKEN` is also honored.
- If the team-repo endpoint (`/repo`) is not live yet, init falls back to **reporting-only mode** — hooks and status reporting are wired immediately, and skills/rules begin syncing automatically once the endpoint is available.

#### Agent status reporting

Once initialized, supported agents (CodeBuddy / WorkBuddy) report their installed-skill state on session start and pull down server-managed skill install / update / uninstall commands, driven by the existing hook dispatch (`session-start` → report + sync, `prompt-submit` → sync). Failed deliveries are buffered to an offline queue and retried next time.

> **Privacy.** The install path and machine id are only hashed *locally* to derive a stable `local_agent_id` — neither is ever uploaded.

<details>
<summary><b>HTTP contract</b> (for backend implementers) — what the <code>--http</code> endpoint must serve</summary>

The value you pass to `--http <baseUrl>` is the base; every endpoint is relative to it and authenticated with `Authorization: Bearer <api-key>`.

| Endpoint | Method | Purpose | Path |
|----------|--------|---------|------|
| `{baseUrl}/repo` | GET | Team-repo snapshot (skills + rules/docs) | **fixed** |
| `{baseUrl}/api/local-agent/report` | POST | Session start: upsert agent + installed skills | default, configurable |
| `{baseUrl}/api/local-agent/sync` | POST | Report status + return pending skill commands | default, configurable |
| `{baseUrl}/api/local-agent/commands/ack` | POST | Ack one command (`{ id, status, error }`) | default, configurable |

`GET /repo` returns JSON (a 404 or non-JSON 200 ⇒ the client enters reporting-only mode):

```json
{
  "version": "<opaque cache key, e.g. a commit hash>",
  "files":   [{ "path": "rules/foo.md", "content": "..." }],
  "commands":[{ "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

- `files[]` are written verbatim into the local repo tree (path-traversal guarded); `commands[]` install/update/uninstall skills.
- A skill `download_url` is fetched **directly** — it carries its own signed auth in the query string, so no `Bearer` header is sent. It must resolve to a `.zip` whose root is either `<slug>/SKILL.md …` or a flat `SKILL.md …`.

**Fixed vs configurable.** The `/repo` path is fixed; the three reporter paths are defaults you can override. The JSON shapes above are the contract. Knobs (env vars):

| Variable | Effect |
|----------|--------|
| `TEAMAI_API_TOKEN` | API key (alternative to `--token`) |
| `TEAMAI_REPORT_ENDPOINT` | Reporter base URL (defaults to the `--http` URL) |
| `TEAMAI_REPORT_PATHS` | JSON `{ "report", "sync", "ack" }` to override the three reporter paths |
| `TEAMAI_REPORT_AGENTS` | Comma-separated agents that report (default `workbuddy,codebuddy`) |
| `TEAMAI_SKILL_DOWNLOAD_HOSTS` | Comma-separated host allowlist for skill `download_url` (empty = allow all) |

</details>

## Commands

| Command | Description |
|---------|-------------|
| `teamai init` | Initialize (OAuth login, link repo, register member, inject hooks) |
| `teamai push` | Push local resources to a branch and open a Merge Request |
| `teamai pull` | Pull team resources and inject into local AI tools |
| `teamai status` | Show local vs team repo diff |
| `teamai recall <query>` | Search the team knowledge base (BM25 + graph-boost) |
| `teamai import --from-repo <url>` | Import a repo's code knowledge graph (`teamwiki/`) |
| `teamai import --from-org <org>` | Batch import all repos under an organization |
| `teamai import --from-repo-list <yaml>` | Batch import repos from a whitelist |
| `teamai import --from-mr <url>` | Extract learning from a merged MR/PR |
| `teamai import --from-iwiki <id>` | Import iWiki documents as learnings |
| `teamai codebase --lint` | Knowledge graph health check |
| `teamai contribute` | Share session experience to team repo |
| `teamai members` | List team members |
| `teamai roles` | Manage team roles and namespaces |
| `teamai remove <type> <name>` | Remove a resource and open MR |
| `teamai digest` | Generate weekly team usage digest |
| `teamai doctor` | Diagnose configuration issues |
| `teamai uninstall` | Remove all teamai resources and hooks |

Global options: `--dry-run`, `--verbose`

Import options: `--incremental`, `--skip-enrich` (skip AI calls, only extract + graph)

<details>
<summary>More commands (management, CI, analytics)</summary>

| Command | Description |
|---------|-------------|
| `teamai list [type]` | List resources (skills\|rules\|docs\|env\|wiki) |
| `teamai skill [show <name>]` | Inspect skill metadata and contributors |
| `teamai source` | Manage cross-team skill subscriptions |
| `teamai tags` | Manage tag-based resource filtering |
| `teamai env` | Manage team environment variables |
| `teamai hooks` | Manage AI-tool hooks |
| `teamai cache --gc` | Garbage-collect clone cache |
| `teamai ci extract-mr --url <url>` | CI: extract knowledge from MR, post comments, write after merge |

</details>

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

### Codebase Knowledge Graph (teamwiki/)

`teamai codebase --extract` (or `teamai import --from-repo`) parses your source repos and writes a structured knowledge graph under `teamwiki/`:

```
teamwiki/
├── router.md               # Navigation hub — lists every imported repo
├── index.md                # Global index (auto-generated, with timestamp)
├── hot.md                  # Active working memory (reserved for Phase 4)
├── source-manifest.json    # Per-file hash manifest for incremental extraction
├── .indices/
│   └── graph-index.json    # Knowledge graph: nodes + edges (JSON)
├── evidence/
│   └── code/
│       └── <project>/      # One directory per imported repo
│           ├── index.md    # Project summary (fact count + page list)
│           ├── component.md  # Functions / classes / components
│           ├── interface.md  # Interface and type definitions
│           ├── config.md   # Config keys (env vars, TOML keys, etc.)
│           ├── error.md    # Error-handling patterns
│           └── relation-<dir>.md  # Import relationships grouped by top-level dir
└── gaps/
    └── detected.md         # Detected knowledge gaps (IMPL_MISSING, LOW_CONNECTIVITY, …)
```

**graph-index.json** stores the extracted graph. A real example: 11 HAI team repos → **2 218 nodes, 852 edges**.

| Field | Description |
|-------|-------------|
| `nodes[].kind` | `component` (function/class) or `config` (config key) |
| `edges[].relation` | `imports` — cross-file and cross-repo dependency |

Cross-repo edges are detected automatically by PascalCase label matching.

`teamai recall` uses this graph for **BM25 + graph-boost** retrieval: keyword hits are re-ranked by graph proximity, so you get structurally relevant results, not just textual matches.

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

### `hooks` resource type (team-declared hooks)

Beyond the built-in operational hooks the CLI injects, a team can declare its **own** hooks once in the repo and have `teamai pull` adapt and deliver them to every AI tool (Claude Code, CodeBuddy, Cursor, …). Declare them in `hooks/hooks.yaml`:

```yaml
hooks:
  - id: block-secret            # unique, ^[a-z0-9-]+$ — used for the marker + manifest
    description: 提交前扫描密钥     # written into the hook description
    event: PreToolUse           # Claude PascalCase event name (the cross-tool lingua franca)
    matcher: Bash               # optional tool matcher
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15                 # optional, seconds
    tools: [claude, cursor]     # optional; default = all hook-capable tools

# Optional: tune the CLI's own built-in hooks (whitelisted fields only)
builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]   # drop a built-in hook
  overrides:
    Hook dispatch stop: { timeout: 20 }               # only `timeout` may be overridden
```

- `teamai pull` reconciles built-in (A) + team (B) hooks into each tool on every session start (it bypasses the "already synced" fast-path, so new/changed hooks self-heal automatically).
- Team hooks are isolated from built-in hooks by a `[teamai:hook:<id>]` marker and tracked in `~/.teamai/managed-hooks.json`, so removing one from `hooks.yaml` cleanly removes it from every tool on the next pull — built-in hooks are never disturbed.
- Disk format is unchanged and byte-identical for built-in hooks, so upgrading the CLI is a zero-diff, zero-regression operation for already-installed machines.

Audit, force-apply, or strip the effective hooks:

```bash
teamai hooks list      # list effective built-in (A) + team (B) hooks
teamai hooks inject    # force-reconcile A + B into all tools
teamai hooks remove    # remove all teamai-managed hooks (A + B)
```

> **Security.** Team hooks are arbitrary shell commands that run automatically on session events — treat the repo's write access as an execution surface (governed by MR review, same as `env.yaml`). Guards:
> - Commands are printed for transparency when applied (unless `--silent`).
> - `sharing.hooks.autoApply: false` (in `teamai.yaml`) holds team hooks during `pull` and only hints — the user must run `teamai hooks inject` to consent.
> - `sharing.hooks.requireTeamScripts: true` rejects any team hook whose command is not under `~/.teamai/team-scripts/`.
> - Set `TEAMAI_HOOKS_DISABLED=1` to veto all team hooks locally (built-in hooks still apply).

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
