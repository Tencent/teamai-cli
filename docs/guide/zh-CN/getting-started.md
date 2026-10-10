# 快速开始

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

| 要做的事 | 章节 |
| --- | --- |
| 建团队仓库 | [搭建团队](#搭建团队) |
| 加入已有仓库 | [加入团队](#加入团队) |
| 把写好的 skill 或 rule 等 AI 资产分享给团队 | [分享给团队](#分享给团队) |

### 搭建团队

1. 在 GitHub、GitLab、GitCode、CNB、工蜂或私有 Git 上建一个空仓库。名字用 `<团队名>-teamai` 比较好认。给同事分支写权限，主干保持保护。还没有仓库？到 [teamai-hub](https://github.com/teamai-hub) Fork 一个。
2. 在你使用 AI 工具的项目里初始化。

   在 AI 工具里：
   ```text
   安装 teamai skill：https://github.com/Tencent/teamai-cli/tree/main/skills/teamai ，加载 teamai skill，然后从零为我的团队搭建 TeamAI。
   ```
   或在终端里：
   ```bash
   cd /path/to/my-project
   teamai init https://github.com/your-org/your-repo
   ```
   `init` 会识别 Git 平台、需要时让你登录、把你登记为成员、给找到的 AI 工具装上会话启动钩子，最后做一次 pull。
3. 检查一下。
   ```bash
   teamai doctor      # 每一行都应通过
   teamai status      # 刚 init 完应为空
   ```
4. 先发一个文件，免得第一次 pull 是空的。把 skill 放到 `~/.claude/skills/<名称>/SKILL.md`（或把 rule 放到 `~/.claude/rules/<名称>.md`），运行 `teamai push`。合并它开出的 pull request。
5. 把仓库地址发给同事。

更多管理功能请参考[配置示例](./admin-setup.md)。

### 加入团队

需要仓库地址。

1. 在你使用 AI 工具的项目里初始化。

   在 AI 工具里：
   ```text
   /teamai 帮我加入团队的 TeamAI，仓库地址是 https://github.com/your-org/your-repo
   ```
   或在终端里：
   ```bash
   cd /path/to/my-project
   teamai init https://github.com/your-org/your-repo
   ```
   加上 `--scope user` 会装到用户主目录，这台机器上的每个项目都能看见。不加的话，文件只进当前项目。
2. 检查一下。
   ```bash
   teamai doctor
   teamai list        # 团队的 skills、rules、docs、env、agents、hooks 和 MCP server
   ```
3. 在这个项目里打开 AI 工具。

日常命令见[成员使用](./member-guide.md)。检索同事记下的经验，看[团队知识](./knowledge.md)。

### 分享给团队

你本地有一个 skill、rule、agent 或 MCP server，同事也要用。

1. 推上去。

   在 AI 工具里：
   ```text
   /teamai 把我的 <名称> skill 分享给团队
   ```
   或在终端里：
   ```bash
   teamai push                       # 从它在你的 AI 工具里找到的资源中挑选
   teamai push --skill ~/.claude/skills/<名称>
   ```
   `push` 会补全 `SKILL.md` 缺失的 frontmatter，推一个分支，并在团队仓库上开 pull request。
2. 团队仓库的评审人合并这个 pull request。
3. 同事机器上下一次会话会拉到。在那之前，`teamai list skills --source repo` 已经能看到。

pull request 已合并，并且 `teamai list skills --source repo` 能看到这个 skill。

角色、namespace 和每种资源的格式见[共享团队资源](./sharing.md)。

### 命令失败了

跑 `teamai doctor`。钩子缺失、工具没识别到、token 没设置，它会点名并给出修法。其他情况见[卸载与常见问题](./faq.md)。

## 接下来

| 接下来 | 去看 |
| --- | --- |
| 更多管理功能 | [配置示例](./admin-setup.md) |
| 加入之后怎么用 | [成员使用](./member-guide.md) |
