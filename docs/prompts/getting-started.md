# Getting started — create the team repo

> [English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

Use this when you **do not** already have a team repo URL. Paste the block below into your current AI tool.

```markdown
Help me set up TeamAI. I do not know Git. You run the commands. Only ask me when a web login or a choice is required.
When you tell me to start a new session, name this AI tool — do not default to Cursor or Claude Code.
If the `git` binary is missing, install it quietly. Do not teach me Git.

1. Ask whether I have / have heard of GitHub, GitLab, or CNB (cnb.cool). If yes, use that one.
2. If none: probe https://github.com, https://gitlab.com, and https://cnb.cool in that order.
   Recommend only hosts that respond. If more than one works, list them and let me pick.
   If none work, stop and ask me to get an existing repo URL from an admin.
   Pick the host from account + reachability only. Do not recommend by region. Do not use intranet / TGit.
3. Open that host so I can register and sign in. Then tell me: the repo on the website is where team skills/rules live; this computer only holds a copy that teamai syncs; do not move business code into it.
4. Confirm Node.js ≥ 20, then `npm install -g teamai-cli`. Sign in on the chosen host:
   - GitHub: install `gh` first (https://cli.github.com/; macOS: `brew install gh`), then `gh auth login`
   - CNB: `npm install -g @cnbcool/cnb-cli`, then `cnb login` (or skip both and let `teamai init` install `cnb` and log in)
   - GitLab: create a Personal Access Token with `api` scope, then `export GITLAB_TOKEN=...`
5. Ask whether this is personal or a team (suggested repo name `TeamAi-<name>`), and whether to install for this project or the whole machine (`--scope user`). Then:
   `teamai init https://<host>/<org-or-user>/<repo>`
   If the repo does not exist, confirm creation when init asks. Must use a full HTTPS URL. Do not use `owner/repo` short form. Do not use `teamai init .`.
6. Run `teamai doctor` until it passes. Give me the repo web URL, and the member prompt below with that URL filled in so I can forward it.
   Remind me: resources show up after I start a new session in this AI tool; missing `.claude/` / `.cursor/` right after init is expected. If this tool has no session-start hook, run `teamai pull`.

Member prompt (fill in the URL, then forward the whole block):

Help me join the team TeamAI repo. Repo: <full HTTPS URL>
I do not know Git. Do not create another repo. Do not ask me to type git.
When you tell me to start a new session, name this AI tool — do not default to Cursor or Claude Code.
If the `git` binary is missing, install it quietly. Do not teach me Git.

1. `npm install -g teamai-cli` (needs Node.js ≥ 20)
2. Ask me: this project, or the whole machine (`--scope user`)
3. Sign in on the same host as the URL:
   - cnb.cool → if `cnb` is missing, `npm install -g @cnbcool/cnb-cli`, then `cnb login`
   - github.com → install `gh` first (https://cli.github.com/; macOS: `brew install gh`), then `gh auth login`
   - GitLab → create a Personal Access Token with `api` scope, then `export GITLAB_TOKEN=...`
   If I have no account, open that host so I can register, and have an admin add me to this repo.
4. Project scope: `cd` into the project, then `teamai init <full URL>`. Whole machine: add `--scope user`. Must use the full HTTPS URL. Do not use `owner/repo` short form. Do not use `teamai init .`.
5. `teamai doctor`. Day to day: a new session in this tool syncs automatically; sync now with `teamai pull`. If this tool has no session-start hook, only use `teamai pull`. On a permission error, forward the original message to an admin.
```
