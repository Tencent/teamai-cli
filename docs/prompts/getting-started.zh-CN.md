# 建库 — 还没有团队仓库

> [English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

还没有团队仓库 URL 时用这一份。把下面整段粘贴给**当前这个** AI 工具。

结束后应交出仓库网页地址，以及给同事的接入话（提示词 B 的短版）。转发明细见[成员提示词](member.zh-CN.md)。

```markdown
帮我接入 TeamAI。我不会 Git，你代跑命令；只在要网页登录或二选一时问我。
重开会话时用当前这个 AI 工具的名字，不要默认 Cursor / Claude Code。

1. 问我有没有 / 听过：GitHub、GitLab、CNB（cnb.cool）。有就用那个。
2. 都没有：依次测 https://github.com、https://gitlab.com、https://cnb.cool。
   只推荐能通的；多个都能通时列出来让我选一个。
   三个都不通就停，让我找管理员要现成仓库地址。
   选平台只看账号和站点能不能通，不要按地区推荐。不要用内网 / 工蜂。
3. 打开该平台注册并登录。然后告诉我：网页上的这个仓库就是团队技能/规则的存放处；电脑上只是副本，由 teamai 同步；业务代码不用搬进去。
4. 确认 Node ≥ 20，`npm install -g teamai-cli`。按平台登录：CNB → `cnb login`（没有 `cnb` 时交给 `teamai init` 安装）；GitHub → `gh auth login`（需已安装 `gh`）；GitLab → 设 `GITLAB_TOKEN`。
5. 问我个人用还是团队用（仓库名建议 `TeamAi-<名字>`），以及当前项目用还是整机用（`--scope user`）。然后：
   `teamai init https://<平台>/<组织>/<仓库名>`
   没有仓库就按 init 提示创建。必须用完整 URL，不要用 `owner/repo` 短地址，不要 `teamai init .`。
6. 跑通 `teamai doctor`。把仓库网页地址给我，并生成一段给同事的接入话（用提示词 B 的短版）。
   提醒：在当前这个 AI 工具里新开一轮会话后资源才会出现；init 当时看不到对应目录是正常的。没有会话启动 hook 就执行 `teamai pull`。
```
