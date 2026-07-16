<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli" width="430">
</p>

# TeamAI — The team harness for AI agents

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![Discord](https://img.shields.io/discord/1234567890?label=Discord&logo=discord)](https://discord.gg/gervEZm58g)

💬 **User Discussion:** [Discord](https://discord.gg/gervEZm58g) | 🛠 **Developer Chat:** [Discord](https://discord.gg/DeHHxPnfZF)

Make every AI coding agent work by the same harness.

Git-native management of skills, rules, and docs across 20+ AI tools — for you or your whole team.

**Supports:** Claude Code, Codex, Cursor, CodeBuddy IDE, as well as Gemini CLI, Windsurf, Trae, Aider, Amp, OpenClaw, and 20+ other AI coding tools (skills sync).

> 📖 **Full usage guide:** [docs/usage-guide.md](docs/usage-guide.md) — covers everything from team creation to day-to-day use.

> 📚 **Provider notes:** [docs/providers.md](docs/providers.md) — GitHub / TGit differences and auth setup.

## Install

```bash
npm install -g teamai-cli
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com  # Tencent internal
```

Prerequisites: Node.js 20+. To update: `npm update -g teamai-cli`

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

Create a shared-experience repo on your git host (GitHub or TGit), grant write access to team members, then have them run `teamai init --repo <org>/<repo>`.

The CLI picks a provider automatically from the repo URL:

- `yourorg/yourrepo` or `https://github.com/yourorg/yourrepo` → GitHub
- `https://git.woa.com/yourteam/yourrepo` → TGit

### Read-only consumers (HTTP mode)

For users who only consume skills/rules without git access:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- Read-only: `push` / `contribute` / `remove` are disabled for HTTP repos.
- API key stored `0600`; `TEAMAI_API_TOKEN` env var also honored.
- No git clone needed — skills/rules are delivered per-session over the report/sync/ack lifecycle.
- Supported agents report installed-skill state on session start and pull down server-managed install/update/uninstall commands automatically.

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
| `teamai source` | Manage cross-team skill subscriptions |
| `teamai remove <type> <name>` | Remove a resource and open MR |
| `teamai digest` | Generate weekly team usage digest |
| `teamai doctor` | Diagnose configuration issues |
| `teamai uninstall` | Remove all teamai resources and hooks |

Global options: `--dry-run`, `--verbose`

## How It Works

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

TeamAI stores skills, rules, docs, and learnings in a shared git repo. Members push changes via `teamai push`, which opens a Merge Request for review. Once merged, `teamai pull` (triggered automatically on session start via hooks) syncs the latest resources into every member's local AI tools.

Skills sync to `~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills/`, `~/.codebuddy/skills/`, etc.

## Role-scoped Skills

Skills are organized under role namespaces. During `teamai init`, you pick a `primaryRole` and optional `additionalRoles`. `teamai pull` only syncs skills matching your activated namespaces.

```yaml
# ~/.teamai/config.yaml
primaryRole: hai
additionalRoles:
  - pm
```

This syncs skills from `skills/common/`, `skills/hai/`, and `skills/pm/`.

When pushing, the CLI auto-detects available namespaces and prompts you to pick one (or use `teamai push --role pm` to specify directly).

## Team Knowledge Recall

`teamai recall` searches across accumulated team knowledge:

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
```

- Hybrid CJK + English search with BM25 + graph-boost ranking.
- Dual-scope (user + project) merged results, tagged with origin.
- Implicit upvoting: searches boost matched docs; good docs float up over time.

```bash
teamai recall enable     # enable recall + deploy subagent
teamai recall disable    # disable recall + remove subagent
teamai recall status     # show effective state
```

## Codebase Knowledge Graph

`teamai import` parses source repos into a structured graph under `teamwiki/`, enabling structurally-aware retrieval:

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --lint                      # health check
```

The graph stores components, interfaces, configs, and cross-repo import edges. `teamai recall` uses it for graph-boosted re-ranking.

## Automatic Experience Sharing

When a session ends, the Stop hook evaluates session value (tool diversity, skill usage, error handling, duration). If the score is high enough, the AI suggests:

```
建议运行 /teamai-share-learnings 总结本次 session 的经验并分享给团队。
```

The `/teamai-share-learnings` skill summarizes the session and pushes a learning document directly to the team repo. Each session is prompted at most once.

## Team Hooks

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

## Cross-team Skill Subscription

### Git source

Subscribe to other teams' public skill repos:

```bash
teamai source add https://github.com/other-team/teamai-public.git --name other-team
teamai source list
teamai source browse other-team    # browse available skills
teamai source remove other-team
```

Subscribed skills sync automatically on `teamai pull`.

### HTTP source

Attach an HTTP source alongside your existing git main repo — useful for server-managed skill delivery without changing the main repo:

```bash
teamai source add-http https://your-team-host/api --token <api-key>
teamai source list            # shows under "HTTP source"
teamai source remove-http     # detach and uninstall its resources
```

The HTTP source reports agent status and pulls down skill commands on each session via hook dispatch. Only one HTTP source is supported per installation.

## CI Integration

`teamai ci extract-mr` plugs into CI to extract learnings from every MR:

```bash
# Post suggestions as comments (on PR open/update)
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write approved items after merge
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo
```

Ready-to-use templates: `examples/ci/github-actions-mr-extract.yml` (GitHub Actions), `examples/ci/coding-ci-mr-extract.yaml` (Coding CI).

## License

[MIT](LICENSE)

## Contributing

PRs are welcome! Please read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first.
