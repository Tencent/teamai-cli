<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli" width="430">
</p>

# TeamAI — The team harness for AI agents

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![User Chat](https://img.shields.io/badge/User_Chat-Discord-5865F2?logo=discord&logoColor=white)](https://discord.gg/gervEZm58g)
[![Developer Chat](https://img.shields.io/badge/Developer_Chat-Discord-5865F2?logo=discord&logoColor=white)](https://discord.gg/DeHHxPnfZF)

Make every AI coding agent work by the same harness.

Git-native management of skills, rules, and docs across Claude Code / Codex / CodeBuddy / WorkBuddy and more.

For you or your whole team.

## Quick Start

### Install

```bash
npm install -g teamai-cli
```

### Team admin / solo user

Create a shared-experience repo on your git host (GitHub or TGit), **grant write access to team members**, then have them run `teamai init --repo https://github.com/yourorg/yourrepo`.

> Solo use needs no separate repo setup: `teamai init` checks the target repo and creates it automatically if it doesn't exist.

### Team members

```bash
# User-scope init (default, resources installed under ~/)
teamai init --repo https://github.com/yourorg/yourrepo

# Project-scope init (resources installed under the project directory)
cd /path/to/my-project
teamai init --repo https://github.com/yourorg/yourrepo --scope project
```

Once initialized, every AI session automatically pulls the latest skills / rules and other Harness updates published by admins — no manual sync needed.

> **Full usage guide:** [docs/usage-guide.md](docs/usage-guide.md) ([中文版](docs/usage-guide.zh-CN.md)) — covers everything from team creation to day-to-day use.

## Harness Management & Distribution

TeamAI keeps skills, rules, docs, and hooks in a shared git repo and distributes them to every member's local AI tools through a "push → review & merge → pull" flow — with support for subscribing to other teams' Harness.

### How It Works

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

Members push changes via `teamai push`, which opens a Merge Request for review. Once merged, `teamai pull` (triggered automatically on session start via the SessionStart hook) syncs the latest resources locally. Skills sync to `~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, `~/.codebuddy/skills/`, etc.

### Team Hooks

Declare custom hooks in `hooks/hooks.yaml` and `teamai pull` delivers them to every AI tool:

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before commit
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    tools: [claude, cursor]
```

```bash
teamai hooks list      # list effective hooks
teamai hooks inject    # force-reconcile into all tools
teamai hooks remove    # remove all teamai-managed hooks
```

### Cross-team Skill Subscription

Subscribe to other teams' public skill repos:

```bash
teamai source add https://github.com/other-team/teamai-public.git --name other-team
teamai source list
teamai source browse other-team    # browse available skills
teamai source remove other-team
```

Subscribed skills sync automatically on `teamai pull`.

## Knowledge Base

Beyond distributing the Harness, TeamAI organizes accumulated team experience and code structure into a searchable knowledge base that the AI recalls automatically when needed.

### Automatic Experience Sharing

When a session ends, the Stop hook scores it by **friction** — signals that the session hit something worth remembering: you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (lots of tool calls, no friction) does not trigger; a session where you actually fought a problem does. If the score is high enough, the AI suggests:

```
建议运行 /teamai-share-learnings 总结本次 session 的经验并分享给团队。
```

The `/teamai-share-learnings` skill summarizes the session and pushes a learning document directly to the team repo. Each session is prompted at most once.

### Team Knowledge Recall

Let the AI automatically search accumulated team knowledge before a task. This feature is **off by default** and must be enabled explicitly — teams can set `sharing.recall.enabled: true` in `teamai.yaml` as the default, and members can override locally:

```bash
teamai recall enable     # on: deploy the teamai-recall subagent + inject guidance rules
teamai recall disable    # off: remove the subagent and rules
teamai recall status     # show effective state (team default + user override)
```

**Search runs via a subagent**: once enabled, `teamai pull` deploys the built-in `teamai-recall` subagent into each AI tool's `agents/` directory. The AI invokes it before a task — the subagent extracts keywords, runs the search, reads the matched source files, and returns a structured summary of team knowledge. Under the hood it shells out to the `teamai recall` command, which you can also run manually:

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
```

**Coverage spans two parts:**

- **Shared search index** (`search-index.json`): four categories — learnings (session experience), docs (team docs), rules (coding rules), and skills (each `SKILL.md`) — sourced from the corresponding team-repo directories, (re)built on `teamai pull` / `teamai contribute`.
- **Codebase knowledge graph** (`teamwiki/`): produced by `teamai import`, queried live at search time.

Ranking uses BM25 + graph-boost, merges dual-scope (user + project) results tagged with origin, and implicitly upvotes matched docs so good content floats up over time.

### Codebase Knowledge Graph

`teamai import` parses source repos into a structured graph under `teamwiki/`, enabling structurally-aware retrieval:

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --lint                      # health check
```

The graph stores components, interfaces, configs, and cross-repo import edges. `teamai recall` uses it for graph-boosted re-ranking.

## Commands

| Command | Description |
|---------|-------------|
| `teamai init` | Initialize: OAuth login, link repo, register member, inject hooks |
| `teamai pull` | Pull team resources and inject into local AI tools |
| `teamai push` | Push local resources to a branch and open a Merge Request |
| `teamai status` | Show local vs team repo diff |
| `teamai contribute` | Share session experience to team repo |
| `teamai recall <query>` | Search the team knowledge base (BM25 + graph-boost) |
| `teamai recall enable/disable/status` | Toggle or check recall state |
| `teamai import` | Import knowledge (`--dir`, `--from-repo`, `--from-org`, `--from-repo-list`, `--from-mr`, `--from-iwiki`) |
| `teamai codebase --lint` | Knowledge graph health check |
| `teamai ci extract-mr --url <url>` | CI: extract knowledge from MR, post comments, write after merge |
| `teamai members` | List team members |
| `teamai roles` | Manage team roles and namespaces |
| `teamai skill exclude add/remove/list` | Manage skills excluded from local sync ([usage guide](docs/usage-guide.md#excluding-skills-you-dont-need)) |
| `teamai source` | Manage cross-team skill subscriptions |
| `teamai remove <type> <name>` | Remove a resource and open MR |
| `teamai session save` | Record a privacy-scrubbed session summary to a monthly log (`--push` feeds `digest`) |
| `teamai digest` | Generate weekly team usage digest |
| `teamai doctor` | Diagnose configuration issues |
| `teamai uninstall` | Remove all teamai resources and hooks |

Global options: `--dry-run`, `--verbose`

## License

[MIT](LICENSE)

## Contributing

PRs are welcome! Please read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first.
