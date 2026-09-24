---
name: teamai
description: >-
  Make every team AI native — TeamAI syncs a team's AI skills, rules, docs and env across AI coding
  tools. Use when the task operates on team-shared AI configuration or team knowledge: setting up a
  team repo, joining one, managing members, syncing with pull or push, or checking team status.
  Also use to build or query a codebase knowledge base for a large multi-repo project (architecture
  analysis, architecture reverse-engineering, code-to-knowledge, team-wiki-codebase, architecture wiki),
  and to share what a session taught you back to the team (share session learnings, contribute a
  learning, share what I learned with my team), including
  after a friction reminder. Triggers include "set up teamai", "join the team repo", "sync team
  skills", "team wiki", "share what I learned", and running /teamai. Talking about a team needs no
  skill; operating on what the team shares does.
allowed-tools: Bash(teamai skill:*), Bash(npx teamai-cli skill:*)
---

# teamai

Make every team AI native — one shared foundation for the skills, rules, docs and env a team works with.

Install: `npm i -g teamai-cli@latest` (Node.js >= 20). If `teamai skill get` is not recognised, the installed CLI predates it; upgrade the same way.

## Start here

This file is a discovery stub, not the usage guide. Load the workflow from the CLI before running anything, so the instructions match the installed version:

```bash
teamai skill get core             # daily work: routing, pull, push, status, doctor
teamai skill get core --full      # adds the full command reference and troubleshooting
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skill get`.

## Specialized workflows

```bash
teamai skill get setup            # day 0: create a team repo (admin) or join one (member), manage, uninstall
teamai skill get wiki             # large multi-repo codebase: architecture reverse-engineering and knowledge base
teamai skill get share            # turn what this session taught you into a team learning (needs recall on)
```

Publishing a skill, rule or doc the user already has is in `core`; it needs no recall.

A friction reminder at the end of a turn means `teamai skill get share`.

`teamai skill list` shows everything the installed version serves. `teamai skill path <name>` prints the directory holding a skill's scripts and templates.
