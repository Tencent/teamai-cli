# 快速开始

> [English](../getting-started.md) | [简体中文](getting-started.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 十分钟跑通团队

在表里找到你的情况，照那条路径做。

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

你可以在 AI 工具里跟 `/teamai` skill 对话（它替你执行命令，需要你做选择时才问），也可以自己在终端里运行 `teamai`。下面每条路径两种都写了。

### 路径 A：搭建团队

一个人做这一步，其余人走路径 B。

1. 在 Git 托管平台上建一个空仓库（GitHub、GitLab、GitCode、CNB、工蜂或任意私有 Git），给团队成员写权限。建议命名 `TeamAi-<团队名>`。还没有仓库？到 [teamai-hub](https://github.com/teamai-hub) Fork 一个现成的。
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

到这里你有了一个 `main` 上带着一个 skill 的团队仓库，你机器上的每个 AI 工具都会在会话启动时从它拉取。作用域、单仓模式和组织仓叠加见[管理员初始化](../admin-setup.md)；rules、env、MCP server 和 hooks 见[共享团队资源](../sharing.md)。

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
3. 打开你的 AI 工具。团队的 skills 和 rules 已经在里面，之后每次会话启动都会拉最新版，不用手动同步。

日常命令见[成员使用](../member-guide.md)。想让 Agent 能检索同事学到的东西，看[团队知识](../knowledge.md)。

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

角色、namespace 和每种资源类型的格式见[共享团队资源](../sharing.md)。

### 出了问题

先跑 `teamai doctor`。大多数问题（钩子缺失、工具没识别到、token 没设置）它都会指出来并给出修法。剩下的见[卸载与常见问题](../faq.md)。

---

## TeamAI 是什么

Agent 作为个人工具已经很强，但学到的东西留在个人手里：昨天某位成员的 Agent 摸索出来的结论，今天到不了其他人的 Agent 面前。

TeamAI 的产品是一条闭环，而不是三个独立产品：

| 层 | 要解决的问题 | 在本 CLI 中怎么用 |
|----|--------------|-------------------|
| **Team Execution** | 让每个 Agent 按团队的方式工作 | `init` / `pull` / `push` 共享 Harness（skills、rules、agents、hooks、MCP、env） |
| **Team Context** (beta) | 让每个 Agent 理解整个团队 | recall、learnings、代码知识图谱、teamwiki |
| **Team Improvement** (beta) | 让每一次执行都成为团队能力的积累 | 基于摩擦信号的经验分享、sessions、digest、dashboard |

**Execute → Understand → Learn → Self-Improve。** 从 Harness 分发起步；Context 与 Improvement 随团队真实使用 Agent 而加深。

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **Team Repo** | 一个 Git 仓库，集中存放团队 Harness 与知识（Skills / Rules / Docs / Env / Packages，以及 learnings、wiki） |
| **Scope** | 资源安装位置：`project`（当前项目，默认）或 `user`（用户主目录）|
| **Team Execution** | 一份共享 Harness，分发到每位成员的 Agent |
| **Team Context** | 可检索的团队知识，避免 Agent 每次 Session 从零理解团队 |
| **Team Improvement** | 把 Session 摩擦与用量信号转化为新的 Skill、Rule 和知识 |
| **Skills** | AI 可调用的自定义技能（目录形式，含 `SKILL.md`） |
| **Rules** | Markdown 格式的团队规范，自动合并到 AI 工具配置中 |
| **Docs** | 团队共享文档，供 AI 参考 |
| **Env** | 团队共享环境变量，自动注入 shell |
| **Packages** | 全团队统一的 npm 包和 Claude Code 插件，通过 `teamai packages` 主动安装 |

```
┌───────────────┐    teamai push (MR)    ┌───────────────────┐
│  你的本地资源   │ ──────────────────────→ │   Team Repo (Git) │
│ skills/rules  │                         │ skills/rules/docs │
└───────────────┘ ←────────────────────── └───────────────────┘
                     teamai pull (自动)
                           │
                           ▼
                  ┌──────────────────┐
                  │  AI 工具自动获取   │
                  │ Claude / CodeBuddy│
                  │ Cursor / Codex   │
                  └──────────────────┘
```

---

## 安装

```bash
npm install -g teamai-cli

# 验证
teamai --version
```

**前置依赖：** Node.js ≥ 20、Git（TGit 用户还需 `gf` CLI、CNB 用户还需 `cnb` CLI，`teamai init` 时都会自动安装）
