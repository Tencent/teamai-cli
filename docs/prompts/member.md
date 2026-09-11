# Member — you already have a repo URL

> [English](member.md) | [简体中文](member.zh-CN.md)

Use this when an admin (or the getting-started prompt) already gave you a team repo URL. Replace `<<paste the full HTTPS URL>>` with that URL, then paste the block into your current AI tool.

```markdown
Help me join the team TeamAI repo. Repo: <<paste the full HTTPS URL>>
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
