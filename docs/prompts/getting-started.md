# Getting started — create the team repo

> [English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

Use this when you **do not** already have a team repo URL. Paste the block below into your current AI tool.

When it finishes, it should give you the repo URL plus a short member prompt. Forward those with [prompt B](member.md).

```markdown
Help me set up TeamAI. I do not know Git. You run the commands. Only ask me when a web login or a choice is required.
When you tell me to start a new session, name this AI tool — do not default to Cursor or Claude Code.

1. Ask whether I have / have heard of GitHub, GitLab, or CNB (cnb.cool). If yes, use that one.
2. If none: probe https://github.com, https://gitlab.com, and https://cnb.cool in that order.
   Recommend only hosts that respond. If more than one works, list them and let me pick.
   If none work, stop and ask me to get an existing repo URL from an admin.
   Pick the host from account + reachability only. Do not recommend by region. Do not use intranet / TGit.
3. Open that host so I can register and sign in. Then tell me: the repo on the website is where team skills/rules live; this computer only holds a copy that teamai syncs; do not move business code into it.
4. Confirm Node ≥ 20, `npm install -g teamai-cli`. Sign in on the chosen host: CNB → `cnb login` (`teamai init` installs `cnb` if it is missing); GitHub → `gh auth login` (`gh` must already be installed); GitLab → set `GITLAB_TOKEN`.
5. Ask whether this is personal or a team (suggested repo name `TeamAi-<name>`), and whether to install for this project or the whole machine (`--scope user`). Then:
   `teamai init https://<host>/<org>/<repo>`
   If the repo does not exist, confirm creation when init asks. Must use a full URL. Do not use `owner/repo` short form. Do not use `teamai init .`.
6. Run `teamai doctor`. Give me the repo web URL, and a short join prompt for teammates (a short version of prompt B).
   Remind me: resources show up after I start a new session in this AI tool; missing agent directories right after init are expected. If this tool has no session-start hook, run `teamai pull`.
```
