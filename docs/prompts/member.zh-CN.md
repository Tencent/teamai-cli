# 成员 — 已经有仓库 URL

> [English](member.md) | [简体中文](member.zh-CN.md)

管理员（或建库提示词）已经给了团队仓库 URL 时用这一份。把 `<<粘贴完整 URL>>` 换成那个地址，再把整段粘贴给**当前这个** AI 工具。

```markdown
帮我接入团队 TeamAI。仓库：<<粘贴完整 URL>>
我不会 Git，不要另建仓库，不要让我敲 git。
重开会话时用当前这个 AI 工具的名字，不要默认 Cursor / Claude Code。
如果本机没有 git 命令，先安静装好，不要教我 Git。

1. `npm install -g teamai-cli`（需 Node.js ≥ 20）
2. 问我：当前项目用，还是整机（`--scope user`）
3. 按 URL 登录同一平台：
   - cnb.cool → 若没有 `cnb`，先 `npm install -g @cnbcool/cnb-cli`，再 `cnb login`
   - github.com → 先安装 `gh`（https://cli.github.com/；macOS：`brew install gh`），再 `gh auth login`
   - GitLab → 创建带 `api` 权限的 Personal Access Token，然后 `export GITLAB_TOKEN=...`
   没账号就去该站注册，让管理员把我加进这个仓库。
4. 项目级：`cd` 到项目后 `teamai init <完整 URL>`；整机加 `--scope user`。必须用完整 HTTPS URL，不要用 `owner/repo` 短地址，不要 `teamai init .`。
5. `teamai doctor`。日常：当前工具新开会话会自动同步；立刻同步用 `teamai pull`。没有会话启动 hook 就只用 `teamai pull`。权限报错把原话转给管理员。
```
