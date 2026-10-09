# Getting Started

> [English](getting-started.md) | [简体中文](zh-CN/getting-started.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Pick a path

Find your situation in the table and follow that path. Each path ends when its check command succeeds.

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

TGit users also need the `gf` CLI, and CNB users the `cnb` CLI. `teamai init` installs either automatically.

You can drive TeamAI from inside your AI tool, by talking to the `/teamai` skill (it runs the commands and asks you when it needs a choice), or by running `teamai` in a terminal. The paths below show both.

What the product is, and the words it uses, is in the [Product Overview](../product-overview.md#core-concepts).

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

**Done when** `teamai doctor` passes and the skill is on the team repo's default branch. Every AI tool on your machine pulls from that repo at session start.

For scopes, single-repo mode and layered org repos, continue with [Admin Setup](./admin-setup.md). For rules, env, MCP servers and hooks, continue with [Sharing Team Resources](./sharing.md).

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
3. Open your AI tool in that project.

**Done when** `teamai list` shows the team's skills and rules, and a new AI session can use them. Every session start pulls the latest, so there is nothing to sync by hand.

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
3. On any member's machine the next session start pulls it. `teamai list skills --source repo` shows it right away.

**Done when** the pull request is merged and `teamai list skills --source repo` shows the skill.

Roles, namespaces and the format of each resource type are in [Sharing Team Resources](./sharing.md).

### If something does not work

Run `teamai doctor`. It names the problem and the fix for most cases (missing hook, tool not detected, token not set). The rest are in [Uninstall & FAQ](./faq.md).

## Where to go next

| You want to… | Read |
| --- | --- |
| Understand the product and its terms | [Product Overview](../product-overview.md#core-concepts) |
| Choose where resources are installed, or how the team repo is laid out | [Admin Setup](./admin-setup.md) |
| Publish skills, rules, env, or MCP servers | [Sharing Team Resources](./sharing.md) |
| Use TeamAI after you have joined | [Member Guide](./member-guide.md) |
