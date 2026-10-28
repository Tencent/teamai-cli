# TeamAI Product Overview

Setup and daily use are in the [Usage Guide](usage-guide.md).

TeamAI keeps a team's skills, rules, agents, learnings, models, MCP, and other AI assets in a git repo, and syncs them into each person's AI tools.

---

## Three layers

| Layer | What it does | Read |
|-------|--------------|------|
| **Team Execution** | The same skills, rules, and hooks on every machine | [Core Harness](guide/sharing.md), [Distribution mechanism](guide/distribution.md), [Workflows](guide/workflow.md) |
| **Team Context** (beta) | Agents can search what the team learned and how the code is built | [Team Context](guide/knowledge.md) |
| **Team Improvement** (beta) | Sessions feed lessons back to the team, and you see how the team uses AI | [Dashboard](guide/dashboard.md), [Usage reporting](guide/reporting.md), [Scorers](guide/scorers.md) |

What each agent supports is in the README's [Product Overview](../README.md#product-overview). Git hosts: GitHub, GitLab, GitCode, CNB, TGit, and any private Git service.

## How it flows

```
teamai push → branch + PR → review and merge
                                  ↓
SessionStart hook → teamai pull → each AI tool
```

## What is in the team repo

| Asset | Location |
|-------|----------|
| Skills | `skills/<name>/SKILL.md` |
| Rules | `rules/*.md` |
| Shared instructions | `claudemd/*.md` |
| Agents | `agents/<name>.yaml` |
| Team culture | `culture.md` |
| Env | `env/env.yaml` |
| Hooks | `hooks/hooks.yaml` |
| MCP | `mcp/mcp.yaml` |
| Models | `models/models.yaml` |
| Packages | `packages` in `teamai.yaml` |
| Docs | `docs/` |
| Learnings | `learnings/` |
| Codebase knowledge graph | `teamwiki/` |

An asset under a `<namespace>/` subdirectory goes only to the roles and projects that declare it. See [Distribution mechanism](guide/distribution.md).

## Team Context (beta)

```bash
teamai recall enable                                  # off by default
teamai recall "port conflict"
teamai import --from-repo https://github.com/org/repo # codebase knowledge graph
```

With recall on, an agent searches the team's lessons before a task. When a session has repeated corrections or retries, its end suggests sharing the lesson with the team.

## Team Improvement (beta)

```bash
teamai digest                                     # weekly team digest
teamai session save                               # save a redacted session summary
teamai session migrate                            # move a full transcript between AI tools; archive, search, and restore team sessions
teamai dashboard                                  # local dashboard
teamai recall maintenance --prune --dry-run       # find lessons nobody uses
```
