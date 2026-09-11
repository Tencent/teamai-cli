# 建库 — 还没有团队仓库

> [English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

还没有团队仓库 URL 时用这一份。把下面整段粘贴给**当前这个** AI 工具。

```markdown
帮我接入 TeamAI。我不会 Git，你代跑命令；只在要网页登录或二选一时问我。
重开会话时用当前这个 AI 工具的名字，不要默认 Cursor / Claude Code。
如果本机没有 git 命令，先安静装好，不要教我 Git。

1. 问我有没有 / 听过：GitHub、GitLab、CNB（cnb.cool）。有就用那个。
2. 都没有：依次探测 https://github.com、https://gitlab.com、https://cnb.cool。
   只推荐能通的；多个都能通时列出来让我选一个。
   三个都不通就停，让我找管理员要现成仓库地址。
   选平台只看账号和站点能不能打开，不要按地区推荐。不要用内网 / 工蜂。
3. 打开该平台注册并登录。然后告诉我：网页上的这个仓库就是团队技能/规则的存放处；电脑上只是副本，由 teamai 同步；业务代码不用搬进去。
4. 确认 Node.js ≥ 20，然后 `npm install -g teamai-cli`。按平台登录：
   - GitHub：先安装 `gh`（https://cli.github.com/，macOS 可用 `brew install gh`），再 `gh auth login`
   - CNB：先 `npm install -g @cnbcool/cnb-cli`，再 `cnb login`（也可以直接 `teamai init`，它会安装 `cnb` 并登录）
   - GitLab：创建带 `api` 权限的 Personal Access Token，然后 `export GITLAB_TOKEN=...`
5. 问我个人用还是团队用（仓库名建议 `TeamAi-<名字>`），以及当前项目用还是整机用（整机加 `--scope user`）。然后：
   `teamai init https://<平台>/<组织或用户名>/<仓库名>`
   没有仓库就按 init 提示创建。必须用完整 HTTPS URL，不要用 `owner/repo` 短地址，也不要用 `teamai init .`。
6. 跑通 `teamai doctor`。把仓库网页地址给我，并把下面「成员接入」提示词里的 URL 填好后整段交给我转发同事。
   提醒：在当前这个 AI 工具里新开一轮会话后资源才会出现；init 当时看不到 `.claude/` / `.cursor/` 等目录是正常的。没有会话启动 hook 的工具请执行 `teamai pull`。

成员接入提示词（填好 URL 后整段转发）：

帮我接入团队 TeamAI。仓库：<填入完整 HTTPS URL>
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
