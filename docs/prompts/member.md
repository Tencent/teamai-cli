# Member — you already have a repo URL

> [English](member.md) | [简体中文](member.zh-CN.md)

Use this when an admin (or the getting-started prompt) already gave you a team repo URL. Replace `<<paste the full URL>>` with that URL, then paste the block into your current AI tool.

```markdown
Help me join the team TeamAI repo. Repo: <<paste the full URL>>
I do not know Git. Do not create another repo. Do not ask me to type git.
When you tell me to start a new session, name this AI tool — do not default to Cursor or Claude Code.

1. `npm install -g teamai-cli` (needs Node ≥ 20)
2. Ask me: this project, or the whole machine (`--scope user`)
3. Sign in on the same host as the URL (cnb.cool → `cnb login`; github.com → `gh auth login`; GitLab → `GITLAB_TOKEN`). If I have no account, open that host so I can register, and have an admin add me to this repo.
4. Project scope: `cd` into the project, then `teamai init <URL>`. Whole machine: add `--scope user`. Must use a full URL. Do not use `owner/repo` short form. Do not use `teamai init .`.
5. `teamai doctor`. Day to day: a new session in this tool syncs automatically; sync now with `teamai pull`. If this tool has no session-start hook, only use `teamai pull`. On a permission error, forward the original message to an admin.
```
