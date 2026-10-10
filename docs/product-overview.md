# TeamAI Product Overview

Setup and daily use are in the [Usage Guide](usage-guide.md).

A conclusion from yesterday stays on one machine until someone puts it in the team repo. TeamAI copies skills, rules, docs, env, and hooks from that repo into each person's AI tools, and can write session learnings back. Share the harness first. Context and improvement are still beta.

---

## Product architecture

**Team Execution × Team Context (beta) × Team Improvement (beta)**:

| Layer | Job | In this CLI today |
|-------|-----|-------------------|
| **Team Execution** | The same skills, rules, and hooks on every machine | `init` / `pull` / `push`, skills, rules, agents, hooks, MCP, env |
| **Team Context** (beta) | Agents can search what the team has learned | recall, learnings, codebase graph, teamwiki... |
| **Team Improvement** (beta) | Sessions can be written back as shared learnings | friction-based share-learnings, sessions, digest... |

## Core concepts

| Concept | Description |
|------|------|
| **Team Repo** | A Git repository that centrally stores the team's harness and knowledge (Skills / Rules / Docs / Env / Packages, plus learnings and wiki) |
| **Scope** | Where resources are installed: `project` (current project, default) or `user` (home directory) |
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

## Overview

See the [agent capability matrix](../README.md#product-overview) in the README for what each agent supports.

**Git providers** — GitHub · GitLab · GitCode · CNB · TGit · private Git service.

### Distribution Controls

Settings in the team repo. `teamai pull` delivers them:

| Capability | Command | What it does |
|------------|---------|--------------|
| **Projects** | `teamai projects` | Bind a working directory to one or more logical projects so it syncs that project's skills, knowledge, and isolated learnings. Orthogonal to roles. |
| **Roles** | `teamai roles` | Define role → namespace mappings so each member syncs only the skills for their role. |
| **Tags** | `teamai tags` | Tag skills / rules so members subscribe to just the tags they need. |
| **Sources** | `teamai source` | Subscribe to additional skill repos — other teams' public repos, or shared/public repos within your own org; subscribed skills sync automatically on pull. |

Learnings isolation: `learnings/` at the repo root is shared with everyone; `learnings/<project-id>/` is project-private. See [Projects](guide/admin-setup.md#roles-and-projects).

## Team Execution

TeamAI keeps skills, rules, docs, and hooks in a shared git repo and installs them into each person's AI tools: push, review, merge, pull. A repo can also subscribe to another team's harness.

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
| **Docs** | `docs/`, `docs/<namespace>/` | Foundational project docs; not all loaded by default (progressive disclosure). A `docs/<dir>/` that no role or project declares stays shared |
| **Agents** | `agents/<name>.yaml`, `agents/<namespace>/<name>.yaml` | |
| **Culture** | `culture.md` | Team mission, values, and working principles — delivered to each agent's own instruction file or session hook, never the project's shared AGENTS.md, so every session inherits them |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/env.yaml`, `env/<namespace>/env.yaml` | Shared team-level environment variables and switches; do not put secret values here: declare a secret without its value in `env/secrets.yaml` |
| **Hooks** | `hooks/hooks.yaml`, `hooks/<namespace>/hooks.yaml` | |
| **MCP** | `mcp/mcp.yaml`, `mcp/<namespace>/mcp.yaml` | |
| **Packages** | `teamai.yaml` | Currently npm packages and Claude Code plugins only |
| **Models** | `models/models.yaml`, `models/<namespace>/models.yaml` | Team model profiles for Claude Code, Codex, OpenCode, CodeBuddy, WorkBuddy, Pi and OMP; an agent changes only after `teamai models switch` |

Skills, rules, CLAUDE.md, agents, env, hooks, MCP, models and docs can also live under a `<namespace>/` subdirectory, which ships only to the roles and projects that list it in `resources:` (rules and CLAUDE.md under `knowledge:`). A namespace item replaces the root item of the same name; a docs namespace replaces nothing. With roles or projects set, root skills reach a member only through a tag subscription.

The Team Context knowledge base below is scoped the same way: a `teamwiki/evidence/code/<slug>/` codebase reaches only the roles and projects that list it under `resources.wiki`, and an undeclared slug stays shared — see [Wiki by namespace](guide/codebase-graph.md#codebase-knowledge-graph).

For file formats and full workflows, see the [Usage Guide](usage-guide.md).

## Team Context (beta)

> Every agent understands how the team works.

Beyond distributing the Harness, TeamAI organizes accumulated team experience and code structure into a searchable knowledge base that the AI recalls automatically when needed.

### Automatic Experience Sharing

When a session ends, the Stop hook scores it by **friction** — signals that the session hit something worth remembering: you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (lots of tool calls, no friction) does not trigger; a session where you actually fought a problem does. If the score is high enough, the AI suggests:

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

The hint names the non-zero friction signals that triggered it and, when available, includes a redacted, single-line summary of the first task. The `share` workflow (`teamai skill get share`) summarizes the session and pushes a learning document directly to the team repo. Each session is prompted at most once. Teams can switch the hint off with `sharing.contributeHint.enabled: false` in `teamai.yaml` (members: `contributeHintEnabled` in local config) while keeping the rest of the Stop hook. The hint also needs recall to be on (it is off by default), because the workflow it points at is served only then. 

For the same reason it never appears on a read-only HTTP source or while a teamai config exists but cannot be loaded, and it never appears in a directory where teamai is not set up.

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

Extract writes `teamwiki/evidence/code/<project>/_manifest.json` even when AI enrichment is skipped or produces nothing, so `--deep-enrich` can start.

The graph stores components, interfaces, configs, and cross-repo import edges. `teamai recall` ranks graph-boosted hits with learnings on a shared relevance scale.
When a recall hit comes from a codebase page, the result includes a `Sources:` line listing the relevant source file paths — giving agents a direct starting point for code changes instead of re-exploring the repo.

Edges come from two tracks that run together, with AST results taking precedence on overlap:

- **AST track** (TypeScript/JavaScript, Python, Go, Swift): a WASM [tree-sitter](https://tree-sitter.github.io/) parser resolves `import`/`require`, call sites, and TS `implements` clauses to precise file-to-file `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` edges (tagged `code-ast`, with confidence weights).
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
| **KB Health** | `teamai dashboard` → Team Context / Team Improvement | Coverage by type, top-recalled and silent entries, last-recall month distribution, author contributions, and maintenance; the full `/kb-report` remains available. |
