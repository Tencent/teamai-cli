# Getting Started

> [English](getting-started.md) | [简体中文](zh-CN/getting-started.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Ten minutes to a working team

Find your situation in the table and follow that path.

| You are… | Go to |
| --- | --- |
| Setting up TeamAI for your team for the first time | [Path A — set up a team](#path-a--set-up-a-team) |
| Joining a team that already uses TeamAI | [Path B — join a team](#path-b--join-a-team) |
| Already set up, and want the team to get a skill or rule you wrote | [Path C — share something](#path-c--share-something) |

You need Node.js ≥ 20 and Git. Install the CLI once:

```bash
npm install -g teamai-cli
teamai --version
```

You can drive TeamAI from inside your AI tool, by talking to the `/teamai` skill (it runs the commands and asks you when it needs a choice), or by running `teamai` in a terminal. The paths below show both.

### Path A — set up a team

One person does this; everyone else follows Path B.

1. Create an empty repository on your Git host (GitHub, GitLab, GitCode, CNB, TGit or any private Git) and give your teammates write access. Suggested name: `<team-name>-teamai`. No repo yet? Fork a ready-made one from [teamai-hub](https://github.com/teamai-hub).
2. Initialize in the project where you use your AI tool.

   In your AI tool:
   ```text
   Install the teamai skill: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , load the teamai skill, then set up TeamAI for my team from scratch.
   ```
   Or in a terminal:
   ```bash
   cd /path/to/my-project
   teamai init https://github.com/your-org/your-repo
   ```
   `init` detects the Git provider, signs you in if needed, registers you as a member, installs a session-start hook into the AI tools it finds, and ends with a pull.
3. Check that it worked.
   ```bash
   teamai doctor      # every line should pass
   teamai status      # local vs team repo: nothing pending right after init
   ```
4. Publish a first resource so members receive something on their first pull. Put a skill in `~/.claude/skills/<name>/SKILL.md` (or a rule in `~/.claude/rules/<name>.md`) and run `teamai push`. It opens a pull request on the team repo; merge it.
5. Send the repo URL to your team. That URL is all a member needs.

You now have a team repo with one skill on `main`, and every AI tool on your machine pulls from it at session start. For scopes, single-repo mode and layered org repos, continue with [Admin Setup](./admin-setup.md); for rules, env, MCP servers and hooks, with [Sharing Team Resources](./sharing.md).

### Path B — join a team

You need the team repo URL from your admin.

1. Initialize in the project where you use your AI tool.

   In your AI tool:
   ```text
   /teamai Help me join my team's TeamAI, repo URL is https://github.com/your-org/your-repo
   ```
   Or in a terminal:
   ```bash
   cd /path/to/my-project
   teamai init https://github.com/your-org/your-repo
   ```
   Add `--scope user` if you want the team's resources in every project rather than this one.
2. Check that it worked.
   ```bash
   teamai doctor
   teamai list        # the team's skills, rules, docs, env, agents, hooks and MCP servers
   ```
3. Open your AI tool. The team's skills and rules are already there, and every session start pulls the latest, so there is nothing to sync by hand.

Day-to-day commands are in the [Member Guide](./member-guide.md). [Team Knowledge](./knowledge.md) explains how to let your agent search what teammates have learned.

### Path C — share something

You wrote a skill, rule, agent or MCP server that teammates should have.

1. Push it.

   In your AI tool:
   ```text
   /teamai Share my <name> skill with the team
   ```
   Or in a terminal:
   ```bash
   teamai push                       # pick from what it finds under your AI tools
   teamai push --skill ~/.claude/skills/<name>
   ```
   `push` fills in missing `SKILL.md` frontmatter, pushes a branch and opens a pull request on the team repo.
2. Get it merged. Whoever reviews on the team repo merges the PR.
3. On any member's machine the next session start pulls it; `teamai list skills --source repo` shows it right away.

Roles, namespaces and the format of each resource type are in [Sharing Team Resources](./sharing.md).

### If something does not work

Run `teamai doctor`. It names the problem and the fix for most cases (missing hook, tool not detected, token not set). The rest are in [Uninstall & FAQ](./faq.md).

---

## What TeamAI is

Agents are strong as personal tools, but their learning stays personal: what one member's agent worked out yesterday does not reach anyone else's agent today.

TeamAI's product is one loop, not three separate products:

| Layer | Job | What you do in this CLI |
|-------|-----|-------------------------|
| **Team Execution** | Make every agent work the team's way | `init` / `pull` / `push` the shared harness (skills, rules, agents, hooks, MCP, env) |
| **Team Context** (beta) | Make every agent understand the team | recall, learnings, codebase graph, teamwiki |
| **Team Improvement** (beta) | Make every execution improve the team | friction-based share-learnings, sessions, digest, dashboard |

**Execute → Understand → Learn → Self-Improve.** Start with harness distribution; context and improvement grow as the team actually runs agents.

---

## Core Concepts

| Concept | Description |
|------|------|
| **Team Repo** | A Git repository that centrally stores the team's harness and knowledge (Skills / Rules / Docs / Env / Packages, plus learnings and wiki) |
| **Scope** | Where resources are installed: `project` (current project, default) or `user` (home directory) |
| **Team Execution** | One shared harness, distributed to every member's agents |
| **Team Context** | Searchable team knowledge so agents do not start from zero each session |
| **Team Improvement** | Session friction and usage signals that become new skills, rules, and knowledge |
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

---

## Installation

```bash
npm install -g teamai-cli

# Verify
teamai --version
```

**Prerequisites:** Node.js ≥ 20, Git (TGit users also need the `gf` CLI, and CNB users the `cnb` CLI — `teamai init` installs either automatically)
