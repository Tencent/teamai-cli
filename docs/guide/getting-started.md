# Getting Started

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

| What you are doing | Section |
| --- | --- |
| Creating the team repo | [Set up a team](#set-up-a-team) |
| Joining a repo that already exists | [Join a team](#join-a-team) |
| Share a skill, rule, or other AI asset you wrote with the team | [Share with the team](#share-with-the-team) |

### Set up a team

1. Create an empty repository on GitHub, GitLab, GitCode, CNB, TGit, or a private Git host. `<team-name>-teamai` is a clear name. Give teammates permission to push branches, and leave the default branch protected. No repo yet? Fork one from [teamai-hub](https://github.com/teamai-hub).
2. Initialize in the project where you use your AI tool.

   In your AI tool:
   ```text
   Install the teamai skill: https://github.com/Tencent/teamai-cli/tree/main/skills/teamai , load the teamai skill, then set up TeamAI for my team from scratch.
   ```
   Or in a terminal:
   ```bash
   cd /path/to/my-workspace
   teamai init https://github.com/your-org/your-repo
   ```
   `init` detects the Git host, signs you in if needed, registers you as a member, installs a session-start hook in the AI tools it finds, and pulls.
3. Check it.
   ```bash
   teamai doctor      # every line should pass
   teamai status      # empty right after init
   ```
4. Publish one file so the first pull is not empty. Put a skill in `~/.claude/skills/<name>/SKILL.md` (or a rule in `~/.claude/rules/<name>.md`) and run `teamai push`. Merge the pull request it opens.
5. Send the repo URL to the team.

More management features are in [Distribution mechanism](./distribution.md).

### Join a team

You need the repo URL.

1. Initialize in the project where you use your AI tool.

   In your AI tool:
   ```text
   /teamai Help me join my team's TeamAI, repo URL is https://github.com/your-org/your-repo
   ```
   Or in a terminal:
   ```bash
   cd /path/to/my-workspace
   teamai init https://github.com/your-org/your-repo
   ```
   Add `--scope user` to install into your home directory. Every project on this machine then sees the files. Without that flag, files install into this project.

   Inside a Git repository, init uses the repository root even when run from a subdirectory. If that root already has a workspace config, run init at the root to change it; a plain subfolder cannot hold a separate config, even with `--force`. A nested repository or linked worktree has its own workspace root.
2. Check it.
   ```bash
   teamai doctor
   teamai list        # the team's skills, rules, docs, env, agents, hooks and MCP servers
   ```
3. Open your AI tool in that project.

Day-to-day commands are in the [Member Guide](./member-guide.md). Searching what teammates learned is in [Team Context](./knowledge.md).

### Share with the team

You have a skill, rule, agent, or MCP server that teammates should have.

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
   `push` fills in missing `SKILL.md` frontmatter, pushes a branch, and opens a pull request on the team repo.
2. A reviewer on the team repo merges the pull request.
3. The next session on a teammate's machine pulls it. `teamai list skills --source repo` shows it before that session.

The pull request is merged, and `teamai list skills --source repo` shows the skill.

Roles and namespaces are in [Distribution mechanism](./distribution.md). The format of each asset is in [Core Harness](./sharing.md).

### If a command fails

Run `teamai doctor`. It names a missing hook, a tool it did not detect, or a token that is not set, and prints a fix. Other cases are in [Uninstall & FAQ](./faq.md).

## Where to go next

| Next | Read |
| --- | --- |
| Talk with `/teamai` | [teamai skill](./skill.md) |
| More management features | [Distribution mechanism](./distribution.md) |
| How to write skills, rules, and the rest | [Core Harness](./sharing.md) |
| After you have joined | [Member Guide](./member-guide.md) |
