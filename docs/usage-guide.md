# TeamAI CLI — Team Onboarding & Usage Guide

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — the team collaboration layer for AI agents
>
> **Make every team continuously smarter with AI.** Define how agents work (Team Execution), give them team knowledge (Team Context), and turn real sessions into shared capability (Team Improvement). TeamAI manages Skills, Rules, Docs, Env, MCP, and more across Claude Code, Codex, GitHub Copilot CLI, CodeBuddy, WorkBuddy, OpenCode, Pi, Cursor, and other supported agents.

New to TeamAI? Start with [Getting Started](guide/getting-started.md). Pick the path for setting up a team, joining one, or sharing a skill.

---

## Contents

- [Getting Started](guide/getting-started.md) — three paths: set up a team, join one, or share a skill
- [Admin Setup](guide/admin-setup.md) — Five copy-paste setups: scope, single-repo, org plus project, roles and projects
- [Git Providers](guide/providers.md) — GitHub, GitLab, GitCode, CNB, TGit and generic Git: detection and authentication
- [Member Guide](guide/member-guide.md) — Joining a team, day-to-day use, commit co-author attribution, keeping delivered files out of git
- [Sharing Team Resources](guide/sharing.md) — Publishing skills, rules, docs, env, agents, hooks and MCP servers
- [Team Knowledge](guide/knowledge.md) — Knowledge capture, recall, and the knowledge base health report
- [Team Culture](guide/team-culture.md) — Company and team culture injected into every agent
- [Codebase Knowledge Graph](guide/codebase-graph.md) — Import a repository into the team knowledge graph
- [Dashboard](guide/dashboard.md) — Local dashboard and session save
- [Hooks](guide/hooks.md) — Built-in hooks and team hook declarations
- [Agents](guide/agents.md) — Agent definitions, model aliases, and per-tool delivery
- [Cross-team subscriptions](guide/subscriptions.md) — Subscribe to another team's skills, including an HTTP source
- [CI integration](guide/ci.md) — Extract knowledge from merge requests in CI
- [Team repo checkout](guide/team-repo.md) — Git submodules and scripts that run after pull
- [Usage reporting](guide/reporting.md) — What session and usage stats are written back
- [Diagnostics and maintenance](guide/diagnostics.md) — `doctor`, stats, updates, and related commands
- [HTTP contract](guide/http-contract.md) — APIs a custom backend implements for `init --http`
- [Reference](guide/reference.md) — Command reference, configuration reference, model profiles
- [Windows](guide/windows.md) — Getting agent hooks to fire on Windows
- [Uninstall & FAQ](guide/faq.md) — Removing TeamAI and frequently asked questions

For the complete list of commands and flags, run `teamai --help` and `teamai <command> --help`.
