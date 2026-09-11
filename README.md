<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

# TeamAI — Make Every Team AI Native

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamAI manages your team's skills, rules, MCP, and knowledge across Claude Code, Codex, CodeBuddy, WorkBuddy, OpenCode, Cursor, and other AI agents.

## Contributors

Thanks to everyone who has contributed to TeamAI!

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

Made with [contrib.rocks](https://contrib.rocks).

## Quick Start

### Install

```bash
npm install -g teamai-cli
```

> **Never used Git?** Paste an [onboarding prompt](docs/prompts/README.md) into your current AI tool and let it run the commands.

### Team admin / solo user

Create a shared-experience repo on your git host (GitHub, GitLab, GitCode, CNB, TGit, or a private Git service), **grant write access to team members**, then run `teamai init https://github.com/yourorg/yourrepo`.

> **No team repo yet?** Start from a template pre-loaded with production-ready skills, rules, and review agents. Browse the [teamai-hub](https://github.com/teamai-hub) org, click **Use this template**, then `teamai init` against your new repo.

### Team members

```bash
# Choose one, depending on where you want resources installed

# Project-scope init (default, resources installed under the project directory)
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo

# Or, user-scope init (resources installed under ~/)
teamai init https://github.com/yourorg/yourrepo --scope user
```

Once initialized, every AI session automatically pulls the latest skills / rules and other Harness updates published by admins — no manual sync needed.

> **Full usage guide:** [docs/usage-guide.md](docs/usage-guide.md) ([中文版](docs/usage-guide.zh-CN.md)) — covers everything from team creation to day-to-day use.

## Product architecture

**Team Execution × Team Context (beta) × Team Improvement (beta)**:

| Layer | Job | In this CLI today |
|-------|-----|-------------------|
| **Team Execution** | Make every agent work the team's way | `init` / `pull` / `push`, skills, rules, agents, hooks, MCP, env |
| **Team Context** (beta) | Make every agent understand the team | recall, learnings, codebase graph, teamwiki... |
| **Team Improvement** (beta) | Make every execution improve the team | friction-based share-learnings, sessions, digest, dashboard... |

## Overview

<table>
  <thead>
    <tr>
      <th rowspan="2">Agent</th>
      <th colspan="7">Team Execution</th>
      <th colspan="3">Team Context (beta)</th>
      <th colspan="3">Team Improvement (beta)</th>
    </tr>
    <tr>
      <th>skills</th><th>rules</th><th>docs</th><th>env</th><th>agents</th><th>hooks</th><th>mcp</th>
      <th>learnings</th><th>codebase</th><th>teamwiki</th>
      <th>usage</th><th>sessions</th><th>dashboard</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Claude Code</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Codex</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Cursor</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
  </tbody>
</table>

**Git providers** — GitHub · GitLab · GitCode · CNB · TGit · private Git service.

### Distribution Controls

Team-wide settings an admin configures once and delivers to every member on `teamai pull`:

| Capability | Command | What it does |
|------------|---------|--------------|
| **Projects** | `teamai projects` | Bind a working directory to one or more logical projects so it syncs that project's skills, knowledge, and isolated learnings. Orthogonal to roles. |
| **Roles** | `teamai roles` | Define role → namespace mappings so each member syncs only the skills for their role. |
| **Tags** | `teamai tags` | Tag skills / rules so members subscribe to just the tags they need. |
| **Sources** | `teamai source` | Subscribe to additional skill repos — other teams' public repos, or shared/public repos within your own org; subscribed skills sync automatically on pull. |

Learnings isolation: `learnings/` at the repo root is shared with everyone; `learnings/<project-id>/` is project-private. See the [usage guide](docs/usage-guide.md#multi-project-project-as-a-dimension-orthogonal-to-role).

## Team Execution

> One Team. One Harness. Every Agent.

TeamAI keeps skills, rules, docs, and hooks in a shared git repo and distributes them to every member's local AI tools through a "push → review & merge → pull" flow — with support for subscribing to other teams' or shared repos' Harness.

### How It Works

```
teamai push → create branch + MR → reviewer approves + merges
                                         ↓
              SessionStart hook → teamai pull → synced to local AI tools
```

### What Gets Shared

Each resource is delivered to every agent:

| Resource | In the team repo | Notes |
|----------|------------------|-------|
| **Skills** | `skills/<name>/SKILL.md` | |
| **Rules** | `rules/*.md` | |
| **Docs** | `docs/` | Foundational project docs; not all loaded by default (progressive disclosure) |
| **Agents** | `agents/<name>.yaml` | |
| **Culture** | `culture.md` | Team mission, values, and working principles — injected into each agent's CLAUDE.md / AGENTS.md so every session inherits them |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | Shared team-level environment variables and switches; do not put secrets here |
| **Hooks** | `hooks/hooks.yaml` | |
| **MCP** | `mcp/mcp.yaml` | |
| **Packages** | `teamai.yaml` | Currently npm packages and Claude Code plugins only |
| **Models** | — | Not implemented for every provider yet |

For file formats and full workflows, see the [Usage Guide](docs/usage-guide.md).

## Team Context (beta)

> Every agent understands how the team works.

Beyond distributing the Harness, TeamAI organizes accumulated team experience and code structure into a searchable knowledge base that the AI recalls automatically when needed.

### Automatic Experience Sharing

When a session ends, the Stop hook scores it by **friction** — signals that the session hit something worth remembering: you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (lots of tool calls, no friction) does not trigger; a session where you actually fought a problem does. If the score is high enough, the AI suggests:

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

The hint names the non-zero friction signals that triggered it and, when available, includes a redacted, single-line summary of the first task. The `/teamai-share-learnings` skill summarizes the session and pushes a learning document directly to the team repo. Each session is prompted at most once. Teams can switch the hint off with `sharing.contributeHint.enabled: false` in `teamai.yaml` (members: `contributeHintEnabled` in local config) while keeping the rest of the Stop hook.

### Team Knowledge Recall

Let the AI automatically search accumulated team knowledge before a task. This feature is **off by default** and must be enabled explicitly — teams can set `sharing.recall.enabled: true` in `teamai.yaml` as the default, and members can override locally:

```bash
teamai recall enable     # on: deploy the teamai-recall subagent + inject guidance rules
teamai recall disable    # off: remove the subagent and rules
teamai recall status     # show effective state (team default + user override)
```

**Search runs via a subagent**: once enabled, `teamai pull` deploys the built-in `teamai-recall` subagent into each AI tool's `agents/` directory. The AI invokes it before a task — the subagent extracts keywords, runs the search, reads the matched source files, and returns a structured summary of team knowledge. The subagent first runs a relevance precheck (`teamai recall --check`) and skips retrieval entirely when the task is unrelated to team knowledge. Under the hood it shells out to the `teamai recall` command, which you can also run manually:

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
Matched: conflict | Missing: port
```

### Codebase Knowledge Graph

`teamai import` parses source repos into a structured graph under `teamwiki/`, enabling structurally-aware retrieval:

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # batch import all repos
teamai codebase --extract /path/to/repo     # local extract into teamwiki/
teamai codebase --deep-enrich --project my-service --output /path/to/repo # generate deep knowledge docs
teamai codebase --reconcile --output /path/to/repo # map product docs to code pages
teamai codebase --lint --output /path/to/repo # check the locally extracted graph
```

The graph stores components, interfaces, configs, and cross-repo import edges. `teamai recall` uses it for graph-boosted re-ranking.
When a recall hit comes from a codebase page, the result includes a `Sources:` line listing the relevant source file paths — giving agents a direct starting point for code changes instead of re-exploring the repo.

Edges come from two tracks that run together, with AST results taking precedence on overlap:

- **AST track** (TypeScript/JavaScript, Python, Go): a WASM [tree-sitter](https://tree-sitter.github.io/) parser resolves `import`/`require`, call sites, and TS `implements` clauses to precise file-to-file `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` edges (tagged `code-ast`, with confidence weights).
- **Heuristic track** (all languages, including Java/Rust): regex-based extraction (tagged `code-heuristic`), which also covers languages the AST track does not.

The WASM parser is a pure-JavaScript dependency — no native toolchain is required. If it fails to load for any reason, extraction falls back to the heuristic track and records an `AST_UNAVAILABLE` gap. Set `TEAMAI_SKIP_AST=1` to force heuristic-only extraction.

## Team Improvement (beta)

> Every execution makes the entire team smarter.

### Maintenance

As skills and knowledge accumulate, prune what the team no longer uses. `teamai recall maintenance` archives low-confidence learnings and flags stale skills, rules, and docs for cleanup or updates:

```bash
teamai recall maintenance --prune --dry-run      # preview
teamai recall maintenance --prune --archive      # archive unused learnings
teamai recall maintenance --update-quality       # draft updates for stale skills / docs
```

Insight into how the team actually uses its AI tools, and a starting point for turning session friction into shared skills, rules, and knowledge:

| Capability | Command | What it shows |
|------------|---------|---------------|
| **Usage** | `teamai digest` | Weekly team digest — 7-day success, prompt, active-time, estimated cost, cache, and correction trends, plus lifetime totals. |
| **Sessions** | `teamai session save` | Privacy-scrubbed per-session summaries (tool sequence, prompt turns, interventions) that feed the digest's Session Highlights. |
| **Dashboard** | `teamai dashboard` | Web dashboard showing live sessions and local 7-day trends compared with the prior 7 days. |
| **KB Health** | `teamai dashboard` → KB Health | Built-in dashboard page reporting knowledge-base usage & health — coverage by type, top recalled entries, silent entries, recall trend, author contributions, and a maintenance console. |

## Commands

| Command | Description |
|---------|-------------|
| `teamai init` | Initialize: OAuth login, link repo, register member, inject hooks |
| `teamai pull` | Pull team resources and inject into local AI tools |
| `teamai push` | Push local resources to a branch and open a Merge Request |
| `teamai packages [install] [target]` | Install declared npm packages and Claude plugins; with a target, also update `teamai.yaml`. Bare `teamai packages` installs everything; `teamai packages install <target>` adds one |
| `teamai status` | Show local vs team repo diff and resource counts, including namespaced skills and nested docs |
| `teamai contribute` | Share session experience to team repo |
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
| `teamai skill exclude add/remove/list` | Manage skills excluded from local sync ([usage guide](docs/usage-guide.md#excluding-skills-you-dont-need)) |
| `teamai source` | Manage skill subscription sources (other teams or your org's shared repos) |
| `teamai remove <type> <name>` | Remove a resource and open MR |
| `teamai session save` | Record a privacy-scrubbed session summary to a monthly log (`--push` feeds `digest`) |
| `teamai digest` | Generate weekly team usage digest |
| `teamai doctor` | Diagnose configuration issues |
| `teamai uninstall` | Remove all teamai resources and hooks |

## License

[MIT](LICENSE)

## Contributing

PRs are welcome! Please read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first.
