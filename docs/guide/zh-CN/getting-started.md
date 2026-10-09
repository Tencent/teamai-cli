# 快速开始

> [English](../getting-started.md) | [简体中文](getting-started.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 选一条路径

在表里找到你的情况，照那条路径做。检查命令通过，这条路径就走完了。

| 你是… | 去看 |
| --- | --- |
| 第一次给团队搭 TeamAI | [路径 A：搭建团队](#路径-a搭建团队) |
| 加入一个已经在用 TeamAI 的团队 | [路径 B：加入团队](#路径-b加入团队) |
| 已经装好了，想让团队用上你写的 skill 或 rule | [路径 C：分享给团队](#路径-c分享给团队) |

需要 Node.js ≥ 20 和 Git。CLI 装一次即可：

```bash
npm install -g teamai-cli
teamai --version
```

工蜂用户还需要 `gf` CLI，CNB 用户还需要 `cnb` CLI。`teamai init` 会自动安装它们。

你可以在 AI 工具里跟 `/teamai` skill 对话（它替你执行命令，需要你做选择时才问），也可以自己在终端里运行 `teamai`。下面每条路径两种都写了。

产品是什么、文档里的词是什么意思，见[产品概览](../../product-overview.zh-CN.md#核心概念)。

### 路径 A：搭建团队

一个人做这一步，其余人走路径 B。

1. 在 Git 托管平台上建一个空仓库（GitHub、GitLab、GitCode、CNB、工蜂或任意私有 Git），给团队成员写权限。建议命名 `<团队名>-teamai`。还没有仓库？到 [teamai-hub](https://github.com/teamai-hub) Fork 一个现成的。
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
3. 确认成功。
   ```bash
   teamai doctor      # 每一行都应通过
   teamai status      # 本地与团队仓库的差异：刚 init 完应为空
   ```
4. 发布第一个资源，让成员第一次 pull 就有东西。把一个 skill 放到 `~/.claude/skills/<名称>/SKILL.md`（或一条 rule 放到 `~/.claude/rules/<名称>.md`），运行 `teamai push`。它会在团队仓库上开一个 PR，合并它。
5. 把仓库地址发给团队。成员只需要这个地址。

**完成标准：** `teamai doctor` 通过，并且这个 skill 已经在团队仓库的默认分支上。你机器上的每个 AI 工具都会在会话启动时从它拉取。

作用域、单仓模式和组织仓叠加见[管理员初始化](./admin-setup.md)。rules、env、MCP server 和 hooks 见[共享团队资源](./sharing.md)。

### 路径 B：加入团队

你需要管理员给的团队仓库地址。

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
   如果想让团队资源在所有项目里都可用，而不只是这一个，加 `--scope user`。
2. 确认成功。
   ```bash
   teamai doctor
   teamai list        # 团队的 skills、rules、docs、env、agents、hooks 和 MCP server
   ```
3. 在这个项目里打开 AI 工具。

**完成标准：** `teamai list` 能列出团队的 skills 和 rules，新开的 AI 会话可以直接用。每次会话启动都会拉取最新内容，不用手动同步。

日常命令见[成员使用](./member-guide.md)。想让 Agent 能检索同事学到的东西，看[团队知识](./knowledge.md)。

### 路径 C：分享给团队

你写了一个 skill、rule、agent 或 MCP server，同事也应该有。

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
   `push` 会补全 `SKILL.md` 缺失的 frontmatter，推一个分支，并在团队仓库上开 PR。
2. 让它合并。团队仓库的评审人合并这个 PR。
3. 任何成员的机器下一次会话启动就会拉到；`teamai list skills --source repo` 马上就能看到。

**完成标准：** pull request 已合并，并且 `teamai list skills --source repo` 能看到这个 skill。

角色、namespace 和每种资源类型的格式见[共享团队资源](./sharing.md)。

### 出了问题

先跑 `teamai doctor`。大多数问题（钩子缺失、工具没识别到、token 没设置）它都会指出来并给出修法。剩下的见[卸载与常见问题](./faq.md)。

## 接下来看哪里

| 你想… | 去看 |
| --- | --- |
| 弄清产品本身和文档里的词 | [产品概览](../../product-overview.zh-CN.md#核心概念) |
| 选择资源装在哪里，或团队仓库怎么组织 | [管理员初始化](./admin-setup.md) |
| 发布 skills、rules、env 或 MCP server | [共享团队资源](./sharing.md) |
| 加入之后的日常用法 | [成员使用](./member-guide.md) |
