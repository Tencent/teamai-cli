# TeamAI CLI — Team Onboarding & Usage Guide

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — a shared AI experience framework for teams
>
> Helps teams centrally manage and share Skills, Rules, Docs, and Env resources, automatically syncing them to AI coding tools like Claude Code, CodeBuddy, Cursor, Codex, Gemini CLI, and Windsurf.

---

## Table of Contents

- [Core Concepts](#core-concepts)
- [Installation](#installation)
- [Admin Initialization](#admin-initialization)
  - [User Scope](#user-scope)
  - [Project Scope](#project-scope)
  - [How to Choose a Scope?](#how-to-choose-a-scope)
- [Member Onboarding](#member-onboarding)
- [Day-to-Day Use](#day-to-day-use)
- [Sharing Team Resources](#sharing-team-resources)
- [Knowledge Capture & Retrieval](#knowledge-capture--retrieval)
- [Team Culture](#team-culture)
- [Advanced Features](#advanced-features)
- [Configuration Reference](#configuration-reference)
- [Uninstall](#uninstall)
- [FAQ](#faq)

---

## Core Concepts

| Concept | Description |
|------|------|
| **Team Repo** | A Git repository that centrally stores a team's shared Skills / Rules / Docs / Env resources |
| **Scope** | Where resources are installed: `user` (home directory, default) or `project` (project directory) |
| **Skills** | Custom skills the AI can invoke (a directory containing a `SKILL.md`) |
| **Rules** | Markdown-formatted team conventions, automatically merged into AI tool configs |
| **Docs** | Shared team documentation for the AI to reference |
| **Env** | Shared team environment variables, automatically injected into the shell |

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

**Prerequisites:** Node.js ≥ 18, Git (TGit users also need the `gf` CLI, and CNB users the `cnb` CLI — `teamai init` installs either automatically)

---

## Admin Initialization

> Only one admin needs to do this — other members can skip to [Member Onboarding](#member-onboarding).

Create an empty repository on GitHub, TGit (Tencent's internal Git host), or CNB (cnb.cool) (suggested naming: `TeamAi-<team-name>`), or simply run `teamai init` — if the repo doesn't exist yet, you'll be prompted to create it automatically.

### User Scope

Resources are installed into your home directory (`~/.claude/skills/`, etc.), suited for general team conventions and cross-project skills.

```bash
# --scope user is the default and can be omitted
teamai init --repo <group>/TeamAi-<team>
```

Resulting directory structure:

```
~/.teamai/
├── config.yaml          # Local config
├── team-repo/            # Clone of the team repo
│   ├── teamai.yaml      # Remote team config (scope: user)
│   ├── skills/ rules/ docs/ env/ members/
│   ├── manifest/roles.yaml  # Role definitions (when role-based skills are enabled)
│   └── learnings/       # Team knowledge base
~/.claude/skills/        # Team skills (auto-synced)
~/.claude/rules/         # Team rules (auto-synced)
```

If the repo has role-based skills enabled (i.e. `manifest/roles.yaml` exists), `teamai init` will also interactively ask you to choose:

- `primaryRole`: the target namespace for skill sync and push by default
- `additionalRoles`: additional skill namespaces to sync

You can also skip the interactive prompts via CLI flags for a fully non-interactive init (suitable for CI/CD or AI agents):

```bash
teamai init --repo <group>/TeamAi-<team> --scope user --role hai_dev --force
```

| Flag | Description |
|------|------|
| `--repo <url>` | Team repo URL (required) |
| `--scope <user\|project>` | Scope, defaults to `user` |
| `--role <id>` | Directly specify the primary role, skipping the interactive role prompt |
| `--force` | Overwrite existing config, skipping confirmation prompts |

Example local config:

```yaml
repo:
  localPath: ~/.teamai/team-repo
  remote: https://github.com/group/repo.git
username: alice
scope: user
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

### Project Scope

Resources are installed under the project directory (`<project>/.claude/skills/`, etc.), suited for project-specific skills and rules.

```bash
cd /path/to/my-project
teamai init --repo <group>/TeamAi-<team> --scope project
```

Resulting directory structure:

```
/path/to/my-project/
├── .teamai/                     # Project-level config (with an auto-generated .gitignore)
│   ├── config.yaml
│   └── team-repo/
├── .claude/skills/              # Project-level skills (auto-synced)
├── .claude/rules/               # Project-level rules (auto-synced)
└── src/
```

### How to Choose a Scope?

| Dimension | User Scope (default) | Project Scope |
|------|-------------------|---------------|
| **Install location** | Under `~/` | Under the project directory |
| **Best for** | General team conventions, cross-project skills | Project-specific skills and rules |
| **Can coexist** | ✅ Yes, both scopes can be active at once | ✅ Yes, both scopes can be active at once |

> **Scope lock-in:** When an admin runs `init` for the first time, the scope is written into the remote `teamai.yaml`. All subsequent member `init` runs must use the same scope.

---

## Member Onboarding

Once the admin shares the team repo URL with members:

**User-scoped teams:**

```bash
npm install -g teamai-cli
teamai init --repo <group>/TeamAi-<team>
# Done! AI tools now automatically have access to team resources
```

**Project-scoped teams:**

```bash
npm install -g teamai-cli
cd /path/to/my-project
teamai init --repo <group>/TeamAi-<team> --scope project
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
teamai list                         # View team repo + skills installed by each AI agent (default --source all)
teamai list --source repo           # Only view team repo contents (legacy behavior)
teamai list --source local          # Only view skills under each installed agent, labeled by source
teamai list --agent claude --verbose  # Only view skills installed by Claude Code, with descriptions

teamai skill                        # List all skills (equivalent to teamai list skills --source all)
teamai skill show hai-deploy-test   # View a single skill's source / contributor / install locations / description summary
```

---

## Day-to-Day Use

### Auto-sync

`teamai init` already injected Hooks into your AI tools. **`teamai pull` runs automatically every time you start an AI session** — no manual action needed.

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

> If you have both a user scope and a project scope, `pull` will pull resources for both scopes in sequence, without conflicts.

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/`, `docs/`, and `learnings/` keep their original global sync behavior.

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
- A single namespace is auto-selected; `--silent` mode uses the default
- Modifying an existing skill automatically keeps its original namespace

**Automatic YAML frontmatter completion:** When pushing, the CLI automatically checks `SKILL.md` and fills in `name`/`description` if missing — no manual upkeep required.

### Check status

```bash
teamai status        # Current scope, last sync time, resource stats
```

### Role management

Roles control which skills each member sees. Admins define roles via `manifest/roles.yaml`; once a member selects their role, `pull` only syncs skills from the matching namespace.

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

---

## Sharing Team Resources

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

---

## Knowledge Capture & Retrieval

### Contributing knowledge

The AI tracks your coding sessions via Hooks. When a session ends (the Stop hook), the system scores it by **friction** — whether you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (many tool calls, no friction) won't trigger; only a session where you actually hit a problem does. If it qualifies, the AI automatically reminds you:

```
Recommend running /teamai-share-learnings to share your learnings
```

Using the built-in `/teamai-share-learnings` skill, the AI will automatically summarize the session's learnings and contribute them to the team knowledge base. Each session is prompted at most once.

You can also specify a file manually:

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
```

### Searching knowledge

```bash
teamai recall "API timeout"
teamai recall "GPU out of memory"
```

- Supports mixed-language search
- Automatically merges the knowledge bases of both user + project scope, labeling results `[user]`/`[project]` by source
- Consulted knowledge is automatically upvoted, surfacing high-quality docs to the top

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

Configurable environment variables:

| Variable | Purpose |
|------|------|
| `TEAMAI_API_TOKEN` | API key (alternative to `--token`) |
| `TEAMAI_REPORT_ENDPOINT` | Reporter base URL (defaults to the `--http` address) |
| `TEAMAI_REPORT_PATHS` | JSON `{ "report", "sync", "ack" }`, overrides the three paths |
| `TEAMAI_REPORT_AGENTS` | Comma-separated list of agents that report (default `workbuddy,codebuddy`) |
| `TEAMAI_SKILL_DOWNLOAD_HOSTS` | Allowlist of hosts for skill `download_url` (empty = allow all) |

> **Privacy:** The install path and machine id are only hashed locally to derive `local_agent_id` — they are never reported.

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

# Import docs from iWiki
teamai import --from-iwiki 12345

# Incremental mode (skip unchanged files)
teamai import --from-repo https://github.com/org/repo --incremental

# Extract structure only, skip AI enrichment
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

The graph stores components, interfaces, configs, and cross-repo dependencies. `teamai recall` uses the graph for BM25 + graph-boosted ranking.

```bash
# Graph health check
teamai codebase --lint
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
| `correction` | Within 60s after the agent stops, the user submits a follow-up prompt containing a correction keyword ("not right" / "redo" / "wrong" / etc.) | The stop → prompt_submit event pattern |

> Privacy: only counts are tracked — no prompt or transcript text is ever stored.

Intervention data is automatically aggregated and reported to the team's `stats/<user>.yaml` during `teamai pull`, and shown in the "Session Autonomy" leaderboard of `teamai digest`, with team averages and per-person intervention rate rankings — useful for verifying whether a skill/rule reduces intervention rates after rollout. Tools without a transcript (e.g. Cursor) degrade gracefully, tracking only `correction`.

#### Conversation Volume & Token Usage

Each session card also shows two badges:

| Badge | Meaning | Data source |
|------|------|----------|
| `💬 N` | The **number of human conversation turns** in the session (how many prompts were sent) | Count of `UserPromptSubmit` events |
| `⛁ X` | The session's cumulative **token usage** (hover to see input / output / cache read / cache write breakdown) | Claude Code transcript's `message.usage` (deduplicated by `message.id` to avoid double counting) |

> Privacy: only turn counts and token counts are tracked — no prompt or transcript text is ever stored.

These two metrics are likewise aggregated into `stats/<user>.yaml` (as `prompts` and `tokens` fields) during `teamai pull`, and shown in the "Conversation Volume & Token Usage" section of `teamai digest`, with team-wide totals, bucketed token totals, and per-person token usage rankings. Tools without transcript access (e.g. Cursor) degrade gracefully: turn counts are still tracked, while tokens show as 0 / N/A.

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
| `SessionStart` | Auto pull + report session start |
| `PostToolUse` | Skill tracking + knowledge contribution detection + dashboard reporting |
| `UserPromptSubmit` | Slash command tracking |
| `Stop` | CLI update check + report session end |

```bash
teamai hooks inject    # Re-inject
teamai hooks remove    # Remove
```

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

### Miscellaneous

```bash
teamai doctor          # Config diagnostics
teamai stats           # Skill usage stats
teamai update          # CLI update
teamai remove skills <name>   # Remove a resource
teamai remove rules <name>
teamai remove wiki <name>
```

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

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

A subscription source's skills are automatically synced locally on `teamai pull`, coexisting with the team's own skills. Configuration is stored in the `sources` field of the local `config.yaml`.

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
scope: user                              # user or project
description: Team AI resource repo
repo: https://github.com/group/repo.git
provider: github

reviewers:
  - reviewer1

sharing:
  rules:
    enforced: [code-review-guide]
  docs:
    localDir: ~/.teamai/docs
  env:
    injectShellProfile: true
```

### config.yaml (local config)

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/group/repo.git
username: your-name
updatePolicy: auto
scope: user                    # or project
projectRoot: /path/to/project  # project scope only
```

---

## Uninstall

`teamai uninstall` intelligently cleans up all teamai-managed resources, **preserving anything you created yourself**.

```bash
# Preview what will be removed (no actual changes)
teamai uninstall --dry-run

# Interactive confirmation
teamai uninstall

# Skip confirmation and uninstall directly (for scripts/CI)
teamai uninstall --force
```

What gets removed:
- teamai hooks in AI tool settings
- The teamai rules block in CLAUDE.md (your own content is preserved)
- Team-synced skills (your own skills are preserved)
- Team-synced rules
- The env block in your shell profile
- The `~/.teamai/` directory

To rejoin after uninstalling:

```bash
teamai init --repo <group>/TeamAi-<team> --scope user --role <role_id> --force
teamai pull
```

---

## FAQ

**Q: Can user scope and project scope coexist?**

Yes. `pull` pulls both scopes in sequence, and `recall` merges search results across both scopes' knowledge bases. They don't conflict with each other.

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo <group>/<repo> --force
```

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
