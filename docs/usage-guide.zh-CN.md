# TeamAI CLI — 团队接入与使用指南

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — AI Agents 的团队协作层
>
> **让每个团队通过 AI 持续变得更聪明。** 统一工作方式（Team Execution）、共享团队 Context（Team Context），并把真实 Session 沉淀成团队能力（Team Improvement）。TeamAI 统一管理 Claude Code、Codex、GitHub Copilot CLI、CodeBuddy、WorkBuddy、OpenCode、Pi、Cursor 及其他受支持 Agent 的 Skills、Rules、Docs、Env、MCP 等资源。

---

## 目录

- [TeamAI 是什么](#teamai-是什么)
- [核心概念](#核心概念)
- [安装](#安装)
- [管理员初始化](#管理员初始化)
  - [项目级（Project Scope）](#项目级project-scope)
  - [用户级（User Scope）](#用户级user-scope)
  - [如何选择 Scope？](#如何选择-scope)
  - [单仓模式（业务仓即团队仓）](#单仓模式业务仓即团队仓)
  - [在项目仓库下叠加组织级仓库](#在项目仓库下叠加组织级仓库)
- [成员接入](#成员接入)
- [日常使用](#日常使用)
- [共享团队资源](#共享团队资源)
- [知识沉淀与检索](#知识沉淀与检索)
- [知识库健康报告](#知识库健康报告)
- [提交 Co-Author 署名](#提交-co-author-署名)
- [团队文化](#团队文化)
- [进阶功能](#进阶功能)
- [命令参考](#命令参考)
- [配置文件参考](#配置文件参考)
- [卸载](#卸载)
- [常见问题 FAQ](#常见问题-faq)

---

## TeamAI 是什么

Agent 作为个人工具已经很强，但学到的东西留在个人手里：昨天某位成员的 Agent 摸索出来的结论，今天到不了其他人的 Agent 面前。

TeamAI 的产品是一条闭环，而不是三个独立产品：

| 层 | 要解决的问题 | 在本 CLI 中怎么用 |
|----|--------------|-------------------|
| **Team Execution** | 让每个 Agent 按团队的方式工作 | `init` / `pull` / `push` 共享 Harness（skills、rules、agents、hooks、MCP、env） |
| **Team Context** | 让每个 Agent 理解整个团队 | recall、docs、learnings、代码知识图谱 |
| **Team Improvement** | 让每一次执行都成为团队能力的积累 | 基于摩擦信号的经验分享、sessions、digest |

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

---

## 管理员初始化

> 只需一位管理员完成，其他成员跳到[成员接入](#成员接入)。

在 GitHub、GitLab（gitlab.com 或自建实例）、GitCode（gitcode.com）、CNB（cnb.cool）、TGit，或任意私有/自建 Git 服务上创建一个空仓库（命名建议：`TeamAi-<团队名>`）。对于支持自动建仓的 provider，也可直接执行 `teamai init`，按提示创建尚不存在的仓库。

> **CNB 例外：** `cnb login` 令牌既不能建组织（`group-manage:rw`）也不能建仓库（`group-resource:rw`），`init` 会改为打印网页链接引导你创建后重新运行——组织不存在用 `https://cnb.cool/new/groups`，无权限建仓库用 `https://cnb.cool/new/repos`；如需 CLI 直接创建，请改用带这些权限的 `CNB_TOKEN` access token。

使用自建 GitLab 时，先配置实例地址和具有 `api` 权限的 Personal Access Token：

```bash
export GITLAB_URL=https://git.example.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx
teamai init https://git.example.com/yourgroup/yourrepo
```

对于未知 host，`init` 会匿名检查 GitLab 登录页，总超时为三秒。确认是 GitLab 后，会在认证、克隆或写入配置前停止，提示设置实例地址和 token 后重试。探测不发送 token，也不跟随重定向。无法确认时，初始化继续使用通用 `git` provider；它支持 Git 传输，但不能自动建仓或创建 PR/MR。实例若由 SSO 遮蔽、部署在子路径下，或无法被探测访问，请显式设置 `GITLAB_URL`。

**已经初始化为 `provider: git`？** 设置上述环境变量，并把团队仓库 `teamai.yaml` 中的 `provider` 改为 `gitlab`。仅设置环境变量不会改变已有 provider 选择。失败的 `teamai push` 可能已经推送了分支；若其诊断探测到 GitLab，会输出这些修复步骤。详见 [Provider 配置](providers.md#gitlab-provider含自托管)。

### 项目级（Project Scope，默认）

资源安装到项目目录下（`<project>/.claude/skills/` 等），适用于项目特定的技能和规则。

```bash
# project 是默认值，可省略 --scope
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# 等价别名：teamai init --repo https://github.com/yourorg/yourrepo
```

生成的目录结构：

```
/path/to/my-project/          # 你的业务仓库 —— 零 teamai 残留
├── .claude/skills/              # 项目级 skills（自动同步）
├── .claude/rules/               # 项目级 rules（自动同步）
└── src/

~/.teamai/projects/my-project-<hash>/   # 本项目的机器数据分区
├── config.yaml
├── state.json
├── team-repo/                           # 团队仓库克隆（知识资产在默认分支）
├── learnings-wt/                        # `teamai-learnings` 孤儿分支的检出
├── pending-learnings/                   # 尚未发布的贡献
└── reports-wt/                          # `teamai-reports` 孤儿分支的检出
```

独立 git clone 与单仓模式使用同一套拆分：`members/` `sessions/` `votes/` `stats/` 写到 `teamai-reports` 孤儿分支，`learnings/` 写到 `teamai-learnings`（两个检出目录都在 clone **旁边**，不嵌在 clone 里）。知识资产（`skills/` `rules/` `docs/` `teamai.yaml`）仍在默认分支，通过 PR 写入。默认分支上已有的上报文件与 learnings 都留在原地：`members/` 仍会从默认分支副本读取（只读继承根，不复制也不删除；同一文件两处都有时以分支副本为准），其余上报数据从此被忽略，learnings 仍会被读取。

两种模式下，只读取上报数据的命令（`members`、`digest`、`projects members`、`stats`、`viz`）都不会创建或推送 `teamai-reports` 分支。`teamai pull` 在重建检索索引（投票热度）和技能推荐之前，会先从 `origin` 刷新上报检出。写入上报（`session save --push`、Stop hook 投票、成员注册、自动上报）会先合并 `origin` 上该成员文件的最新副本，因此同一成员在两台机器上报时不会丢掉会话、投票或统计。

项目的机器数据（config、state、team-repo 克隆、搜索索引、MCP manifest、资源缓存）
存放在 `~/.teamai/projects/<slug>/` 下的按项目分区里，**不再**放进业务仓库，因此工作区
无 teamai 残留，且同一仓库的 `git worktree` 共享同一分区。各 Agent 的项目根目录
（`.claude/`、`.cursor/`、`.codebuddy/` 等）仍在工作区内、于 **SessionStart** 时按刚打开的
工具创建。例如，打开 Claude Code 时会创建 `.claude/`，再由 pull 写入。单独执行 `teamai pull`
仍会跳过项目里还不存在根目录的工具，因此不会给尚未在本项目打开过的 Agent 凭空建目录。

> **从旧版 teamai 升级？** 升级后首次执行 `teamai init` / `pull` / `push` 会自动把已有的
> `<repo>/.teamai/` 迁移进分区（复制 → 校验 → 原子切换），并把旧目录保留为
> `<repo>/.teamai.bak/`，待你确认一切正常后自行删除。只读命令与 `hook-dispatch` 路径
> 永不触发迁移；`teamai --dry-run pull` 可预演。**迁移后不支持降级**——旧版会把项目判定为
> 未初始化；`.teamai.bak/` 是人工回滚路径。

如果仓库启用了角色化 skills（存在 `manifest/roles.yaml`），`teamai init` 还会交互式要求你选择：

- `primaryRole`：默认 skill 同步和推送的目标 namespace
- `additionalRoles`：额外需要同步的 skill namespace

角色提示中可以输入一个或多个用逗号分隔的角色编号。第一个编号会保存为 `primaryRole`，后续编号会保存为 `additionalRoles`（例如 `1,3`）。

也可以通过 CLI 参数跳过交互，实现完全非交互式初始化（适合 CI/CD 或 AI agent）：

```bash
GITHUB_TOKEN=ghp_... teamai init https://github.com/yourorg/yourrepo --scope project --role hai_dev --force
```

没有终端时 `init` 不会等待任何人：所有提示取默认值，需要浏览器登录的 provider 会立即失败并指出应准备的凭据（GitHub 用 `GITHUB_TOKEN` / `GH_TOKEN`，CNB 用 `CNB_TOKEN`，GitLab 用 `GITLAB_TOKEN`，GitCode 用 `GITCODE_TOKEN`）。TGit 是例外：它没有可用于无人值守的 token——`TGIT_TOKEN` 仅用于 REST API，git.woa.com 的 git 端点不接受它，因此需要先在该机器的交互式终端执行一次 `gf auth login`，之后无人值守运行会复用它保存的凭据。`git` 本身会关闭自己的提问：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`（不弹 askpass 对话框）、`GCM_INTERACTIVE=never`，且仅在你自己没有设置该变量时才生效。`ssh` 不在其列：它的批处理选项只能经由 `GIT_SSH_COMMAND` 传入，而该变量会覆盖各仓库自己配置的 `core.sshCommand`，因此 ssh 远端仍可能询问私钥口令或未知主机，需要你自行关闭——在该仓库执行 `git config core.sshCommand 'ssh -o BatchMode=yes'`，或为本次运行导出 `GIT_SSH_COMMAND`。stdin 不是 TTY、或设置了 `CI` / `TEAMAI_NONINTERACTIVE` 时都视为非交互，因此分配了伪终端的 agent 沙箱也能声明自己是无人值守运行。

| 参数 | 说明 |
|------|------|
| `[repo]` / `--repo <url>` | 团队仓库地址（推荐位置参数；`--repo` 为永久别名） |
| `--scope <project\|user>` | 安装作用域，默认 `project`（机器数据在 `~/.teamai/projects/<slug>/`,资源落在 `<cwd>`）。需要装到 `~/` 时用 `user` |
| `--inherit-user-scope` | 仅 project scope：同时同步安全的 user 资源并检索 user 知识 |
| `--no-inherit-user-scope` | 关闭当前项目先前配置的 user scope 继承 |
| `--role <id>` | 直接指定 primaryRole，跳过角色交互选择 |
| `--project <ids>` | 从 `manifest/projects.yaml` 激活的逻辑项目（逗号分隔）。决定本目录同步哪些项目的资源与 learnings。传 `all` 可激活 manifest 声明的全部项目。详见下方 [多项目](#多项目project-作为与-role-正交的维度) |
| `--force` | 覆盖已有配置，跳过确认提示 |

#### 多项目：`project` 作为与 `role` 正交的维度

当一个团队仓库承载多个项目时，`project` 是与 `role` 平级的第二个分发维度，由
admin 在 `manifest/projects.yaml` 中声明。`role` 回答「我的职能是什么」，`project`
回答「这个目录属于哪个项目」。两者正交且相加 —— 成员得到的是其 role namespace
与激活 project namespace 的**并集**（两者之间没有覆盖关系）。

项目身份跟着工作目录走，与 `--role` 完全同一个模式：

```bash
cd ~/work/hai-inference && teamai init <team-repo> --project hai-inference
cd ~/work/billing       && teamai init <team-repo> --project billing
```

此后每个目录只同步自己项目的 skills/rules/CLAUDE.md 与 learnings。要点：

- **learnings 隔离。** 仓库 `learnings/` 根目录对全团队共享；项目私有经验放在
  `learnings/<project-id>/` 子目录下，只对该项目成员的 `teamai recall` 可见。
  未激活任何项目的目录只能看到共享的根目录。
- **不自动激活。** 与「唯一 role 会被自动选中」不同，唯一的 project 不会自动选中
  —— 成员可以不属于任何项目（仍能获得 `common` 与共享的 learnings 根）。
- **一次激活全部。** `--project all` 是保留值：展开为 manifest 声明的全部 id
  并落盘为快照，于是 monorepo 的接入文档只写一行，而不必维护一份「新增项目就会
  漂移」的清单。它是对全部项目（含项目私有 learnings）的显式选择，重跑 `init`
  即重新解析。id 恰好叫 `all` 的项目会被该展开覆盖，但无法用这个 flag 单独选中；
  `teamai projects set all` 走的是字面 id，仍能单独激活它。
- **向后兼容。** 没有 `manifest/projects.yaml` 的仓库行为与之前完全一致；现存扁平
  的 `learnings/*.md` 继续对所有人共享（零迁移）。
- **`teamai contribute`** 在恰好激活一个项目时，把经验落到该项目子目录，否则落到
  共享的根目录。

`manifest/projects.yaml` 示例：

```yaml
version: 1
projects:
  - id: hai-inference
    name: HAI Inference
    resources:
      knowledge: [hai-inference]
      skills:    [hai-inference]
      learnings: [hai-inference]
      agents:    [hai-inference]   # 可选
```

项目 id 与 `resources:` 下的每个 namespace 都会成为目录名
（`skills/<namespace>/`、`learnings/<namespace>/`、`agents/<namespace>/`），因此
都不能越出自己命名的目录。

**namespace** 必须是单个路径片段：不含 `/`、`\`、`:` 和控制字符，结尾不能是 `.`
或空格，也不能是 Windows 设备名（`CON`、`NUL`、`AUX`、`PRN`、`CONIN$`、`CONOUT$`、`COM1`–`COM9`、
`LPT1`–`LPT9`，含 Windows 同样识别为设备编号的上标形式，带不带扩展名都算）。Windows 会从每个路径片段删除结尾的句点与空格，
因此 `.. ` 最终变成 `..` 越出上级目录，`frontend.` 最终变成 `frontend` 落进另一个
namespace 的目录；该规则同时排除了 `.` 与 `..`。除此之外不受限制 —— 非 ASCII 名称、
名称中间含空格的目录、以及只是以设备名开头的名称（如 `console`）仍然合法。
同一资源类型下的两个 namespace 不能仅有大小写差异（如 `frontend` 与 `Frontend`，按 Unicode 大小写折叠 `σ` 与 `ς` 也算）：在
Windows 与 macOS 的默认文件系统上它们是同一个目录，限定到其中一个的 role 或 project
会读到另一个的资源。该校验跨越两个 manifest，因为 `roles.yaml` 与 `projects.yaml` 共用
同一套 `skills/`、`knowledge/`、`agents/` 目录。

**项目 id** 沿用它原有的、更严格的规则，因为它还会在命令行中输入并按逗号切分：
只允许字母、数字、`.`、`_` 和 `-`，且不能是 `.` 或 `..`。

违反任一规则的 manifest 会解析失败，错误信息会指出具体条目。

**命令**（低频的事后修正与查询，对标 `teamai roles …`）：

```bash
teamai projects list                 # 已定义的项目 + 本目录激活的项目
teamai projects set hai-inference    # 设置本目录激活的项目（覆盖语义；逗号分隔或重复；留空清除）
teamai projects members hai-inference # 查看某项目下注册了哪些成员
```

成员登记是 `init` 的**副作用**：执行 `teamai init --project <id>` 会把 `<id>`
追加进你的 `members/<user>.yaml` 名册（跨目录 append + 去重），于是团队侧可以回答
「谁在项目 X」。`teamai push --project <id>` 会按资源类型各自的维度（从 manifest
解析）把新资源推送到该项目对应的 namespace：skill 走 `resources.skills`，rule 走
`resources.knowledge`，agent 走 `resources.agents`。若该项目未为本次推送涉及的类型
声明 namespace，命令会报错并指明该类型，而不会退回共享根目录（那会发给所有人）。

本地配置示例：

```yaml
repo:
  localPath: ~/.teamai/projects/my-project-<hash>/team-repo
  remote: https://github.com/yourorg/yourrepo.git
username: alice
scope: project
projectRoot: /path/to/my-project   # 资源落地位置（当前 checkout）
inheritUserScope: true            # 可选，仅 project scope
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

### 用户级（User Scope）

资源安装到用户主目录（`~/.claude/skills/` 等），适用于通用团队规范、跨项目技能。

```bash
teamai init https://github.com/yourorg/yourrepo --scope user
```

生成的目录结构：

```
~/.teamai/
├── config.yaml          # 本地配置
├── team-repo/           # 团队仓库克隆（知识资产在默认分支）
│   ├── teamai.yaml      # 远端团队配置
│   ├── skills/ rules/ docs/ env/
│   ├── manifest/roles.yaml  # 角色定义（启用角色化 skills 时）
│   └── learnings/       # 迁到独立分支之前写下的 learnings
├── learnings-wt/        # `teamai-learnings` 检出（团队知识库）
├── pending-learnings/   # 尚未发布的贡献
├── reports-wt/          # `teamai-reports` 检出（`members/` `sessions/` `votes/` `stats/`）
~/.claude/skills/        # 团队 skills（自动同步）
~/.claude/rules/         # 团队 rules（自动同步）
```

### 如何选择 Scope？

| 维度 | Project Scope（默认） | User Scope |
|------|-------------------|---------------|
| **资源安装位置** | 项目目录下 | `~/` 下 |
| **适用场景** | 项目特定的技能和规则 | 通用团队规范、跨项目技能 |
| **能否共存** | ✅ 可以；project 保持当前 scope，并可选择继承安全的 user 资源 | ✅ 可以；仍是独立的用户主目录级安装 |

> **本机安装位置**仅由 `teamai init` 的 `--scope`（默认 `project`）决定。远端 `teamai.yaml` 中若仍有 `scope` 字段会被忽略。

### 单仓模式（业务仓即团队仓）

无需单独的团队仓库，可以让某个已有项目自己的 git 仓库直接充当团队仓。在项目内运行：

```bash
cd /path/to/my-project
teamai init .                        # 交互式：选择要启用哪些 AI 工具
teamai init . --agent claude,codex   # 非交互：启用 Claude Code + Codex
```

**选择启用哪些 AI 工具。** 单仓模式会在你的仓库里为每个工具创建一个目录（如 `.claude/`、`.codex/`）——建好 skills 目录、注入 teamai hooks，并把该工具的 settings 提交到 main，让队友 clone 后即可获得。由你决定启用哪些工具：

- **`--agent <name...>`** —— 显式列表，可重复或逗号分隔：`--agent claude`、`--agent claude,codex`、`--agent claude --agent cursor`。常用 id 包括 `claude`、`codex`、`cursor`、`joycode`、`codebuddy`、`workbuddy`、`dsh`（DeepSeek Harness）。
- **交互式（无 `--agent`、有终端）** —— teamai 弹出多选列表。第 1 项是 **Auto**，会列出你本机已安装的 AI 工具（`~/.claude`、`~/.codex`……）并作为回车默认项；其余各项是具体工具。Auto 与具体工具可以组合勾选。
- **非交互（无 `--agent`、无终端 —— CI、hook、clone 时自愈 bootstrap）** —— teamai 会按你本机 home 目录下已装的工具（`~/.claude`、`~/.codex`……）来建。若一个都没检测到，则什么都不建（你仍拿到知识，可稍后运行 `teamai init .` 再选工具）。

**数据如何在分支间拆分：**

| 数据 | 存放位置 | 如何写入 | 需要默认分支写权限吗？ |
|------|----------|----------|------------------------|
| 知识资产：`skills/` `rules/` `docs/` `env/` `agents/`、`teamai.yaml` | **main** 分支的 `.teamai/` | `teamai push` → PR | 不需要：推送分支并开 PR 即可 |
| `learnings/` | `teamai-learnings` **孤儿分支** | `teamai contribute` 直接推送 | 不需要 |
| 上报数据：`members/` `sessions/` `votes/` `stats/` | `teamai-reports` **孤儿分支** | `init`、`session save`、hook、pull 自动上报 | 不需要 |
| 本机私有：`config.yaml`、`state.json`、搜索索引、env 备份、MCP manifest | `~/.teamai/projects/<slug>/`（**分区**，在仓库之外） | 仅本地 | — |
| 可丢弃的 git worktree（`reports-wt/`、`learnings-wt/`、`knowledge-wt/`）与待发布队列（`pending-learnings/`） | `.teamai/`（已 gitignore；按需重建） | 仅本地 | — |

learnings 迁到独立分支之前团队已经写下的内容，原地留在默认分支上。不复制、不删除、
不迁移：该目录仍会被读取，所有既有 learning 依然能从 `teamai recall` 中找回。新的
learning 写入 `teamai-learnings`。

**默认分支受保护时所需的最小 Git 权限。**

成员需要：

- 推送 `teamai-reports` 与 `teamai-learnings`，并在这两个 ref 不存在时创建它们
- 推送 `teamai push` 创建的特性分支
- 向默认分支开 PR

成员不需要：

- 直接推送 `main` / `master`
- 绕过分支保护，或拥有管理员权限

打开分支保护后日常使用照常：`init` 注册成员、`pull` 同步、`contribute` 发布、
`push` 开 PR。`provider: git` 下 teamai 无法替你开 PR —— 它会推送分支并打印手动开 PR
的命令；`teamai contribute` 则完全不需要 PR。HTTP 后端不受影响：它通过 API 写入，
根本没有分支。

本机私有数据存放在仓库之外的按项目**分区**里，因此单仓模式的 `.teamai/` 只保留提交到
main 的团队知识 —— `git status` 保持干净。旧版单仓装升级后，下一次
`init`/`pull`/`push` 会自动把这些机器数据搬进分区（main 上的知识原封不动）。

**克隆即初始化。** 由于知识资产和 `.teamai/teamai.yaml` 里的 `mode: self` 标记都提交在 main 上，团队成员 clone 仓库后会被自动初始化：下一条 `teamai` 命令或 AI 会话会识别该标记，并（在其 git provider 已认证的前提下）自动写入本机配置、注入 hooks、在孤儿分支上注册成员 —— 无需手抄 repo/role 参数。若尚未认证，teamai 会提示其运行一次 `teamai init .`。

**安全性。** 单仓模式下 teamai 的每一次 git 写操作（知识 PR 和上报孤儿分支）都在 `.teamai/` 下的隔离 git worktree 中进行，绝不会 checkout、reset 或切换你的工作区和当前分支。隔离 worktree 里的提交会跳过本地 git hook（例如 husky / lint-staged）：从 `origin/<default>` 检出的干净工作区往往只有 hook 脚本、没有本地生成的 `husky.sh`，而且知识/上报文件本来就不该跑业务仓的 lint。你在业务仓里的普通 `git commit` 仍会走 hook。

**管理员在 `teamai init .` 之后的清单：**

1. `teamai init .` 已经帮你把 `.teamai/`（skills、rules、docs、空的 `learnings/`、`teamai.yaml`、`.gitignore`）以及每个所选工具的 settings（如 `.claude/settings.json`、`.codex/hooks.json`）提交到当前分支。贡献的内容不在其中：`teamai contribute` 会把它们推送到 `teamai-learnings` 分支。
2. 推送 main，供团队成员 clone。
3. 之后新增资源用 `teamai push` —— 它会（通过隔离 worktree）向你的仓库开 PR，而不是直接改动你的工作区。单仓模式下，你既可以在 AI 工具目录（如 `~/.claude/skills/`）里编写，**也可以**直接把资源放进仓库里的 `.teamai/`：
   - `.teamai/skills/` —— 团队 skills
   - `.teamai/rules/` —— 共享 rules
   - `.teamai/agents/` —— subagent 定义（`<name>.yaml`，或旧版 `<name>.md`）
   - `.teamai/env/env.yaml` —— 共享环境变量

   `teamai push` 会同时扫描这些目录和你的 AI 工具目录，只呈现真正的新增或修改（已提交的内容会被跳过）。如果你改了某个 agent 的扩展名（如 `helper.md` → `helper.yaml`），请手动删掉旧文件 —— `teamai push` 不会替你删除，同 stem 的两个文件会在 pull 时冲突。
4. **docs / hooks / mcp** 通过直接编辑对应文件来贡献 —— 它们不走 `teamai push`，用普通的 `git commit` + push 即可分发：
   - `.teamai/docs/` —— 团队文档
   - `.teamai/hooks/hooks.yaml` —— 团队 hooks
   - `.teamai/mcp/mcp.yaml` —— 共享 MCP servers

> **关于 `env` 的提醒。** 单仓模式下 `.teamai/env/env.yaml` **会被提交到 main**（不同于独立模式的每机本地 env），因此会随 clone 分发给所有人。`env.yaml` 存的是明文键值对 —— 只放非敏感的共享配置，真正的密钥请留在你自己未追踪的环境里。

> **限制。** 单仓模式把一套团队配置绑定到一个业务仓。如果需要一套团队知识库被多个业务仓共享，请改用独立团队仓（`teamai init <repo>`）。

### 在项目仓库下叠加组织级仓库

当一部分经验全组织通用、另一部分只属于具体项目时，可以使用两个 Team Repo。CLI 只安装一次，但两个 scope 各有独立的本地配置和仓库克隆：

```bash
# 每位开发者执行一次：组织通用 skills、rules、docs、agents 和 learnings
teamai init https://github.com/yourorg/engineering-practices --scope user

# 在 Java 项目中：项目资源保持当前 scope，recall 时优先
cd /path/to/java-service
teamai init https://github.com/yourorg/java-service-teamai --inherit-user-scope
```

启用继承后，`teamai pull` 会先把 user 的 `skills`、`rules`、`docs`、`agents`、共享指令/文化和检索索引刷新到用户主目录级位置，再刷新项目目录中的 project scope。user 的 `env`、hooks、MCP 定义、跨团队 sources、usage reporting 和远端仓库写入不会被继承。两个配置和两个 Git 仓库仍然分离；该功能组合的是安全读取路径，不会合并 Git 仓库或文件。同名的已安装资源仍分别位于 user/project 路径，由具体 AI 工具决定运行时优先级；Recall 则明确保证相同资源类型和文件名的 project 条目覆盖 user 条目。

---

## 成员接入

管理员将团队仓库地址分享给成员后：

**项目级团队（默认）：**

```bash
npm install -g teamai-cli
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# 完成！AI 工具已自动获得团队资源
```

**用户级团队：**

```bash
npm install -g teamai-cli
teamai init https://github.com/yourorg/yourrepo --scope user
```

**HTTP 模式（只读消费者）：**

无需 git 访问、仅消费 skills/rules 的用户或 agent：

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- 只读模式：`push` / `contribute` / `remove` 不可用。
- 无需 git clone——skills/rules 通过 report/sync/ack 生命周期按 session 下发。
- 支持的 agent 在 session 启动时自动上报已安装 skill 状态，并拉取服务端管理的安装/更新/卸载指令。
- API key 存储为 `0600` 权限，也可通过 `TEAMAI_API_TOKEN` 环境变量传入。

**验证：**

```bash
teamai status                       # 查看状态
teamai members                      # 查看团队成员
teamai list                         # 全部资源类型（skills|rules|docs|env|agents|hooks|mcp）+ 本地 skills
teamai list mcp                     # 只看团队 MCP servers
teamai list --source repo           # 只看团队仓库
teamai list --source local          # 各已安装 agent 下的 skills
teamai list --agent claude --verbose
teamai list env --reveal            # 明文显示 env（默认脱敏）

teamai skill                        # 先输出 teamai list skills --source all，再列出 CLI 内置 skill 目录
teamai skill show hai-deploy-test   # 看单个 skill 的来源 / 贡献者 / 安装位置 / 描述摘要

teamai skill list --json            # 当前 CLI 提供的内置 skill 清单（机器可读）
teamai skill get core               # 打印内置工作流：core | setup | wiki | share
teamai skill get wiki --full        # 同时附上该 skill 的 references 与 templates
teamai skill path wiki              # 打印打包目录，用于运行 skill 自带的脚本
```

#### 内置 skill 随 CLI 一起版本化

内置工作流（`core`、`setup`、`wiki`、`share`）随 npm 包一起发布，由已安装的 CLI 通过 `teamai skill get`
按需打印，因此 agent 读到的内容始终与正在运行的 CLI 版本一致——`npm i -g teamai-cli@latest` 本身就是更新，
无需 `teamai pull` 内容就是最新的。每个 agent 只收到一个文件：`~/.<tool>/skills/teamai/SKILL.md`（或该工具存放团队 skill 的位置：OpenClaw 的 workspace、`HERMES_HOME`），
一个指向这些命令的小型发现入口（stub）。旧版本会把整棵目录复制到每个 agent 下，两次 pull 之间内容会过时；
`teamai pull` 会清除这些残留，并把每个被删除的文件先复制到 `~/.teamai/removed-skills/` 下（每次 pull 一个目录；
`teamai uninstall` 会删除 `~/.teamai/`，这份备份也随之删除）。只删除内容与某个发布版本完全一致的文件：你改过的打包文件，
或你自己用旧名字写的 skill，都属于你，会保留。目录里若还有你自己的文件，
只删除其中的打包文件，保留该目录和你的文件，并在 pull 输出中点名。`share` 只在开启 recall 后才会提供（默认关闭；
团队在 `teamai.yaml` 设置 `sharing.recall.enabled: true`，或单台机器运行 `teamai recall enable`）：在此之前，
`teamai skill get share` 会拒绝并说明原因。
只读 HTTP 源上它同样会拒绝，因为 `teamai contribute` 无法写入；teamai 配置文件存在但无法加载时也会拒绝
（提示会说明失败原因；若是文件无法解析，还会指出是哪个文件、哪一行；若是校验失败，还会指出是哪个字段、为何不合法），因为此时无法确定 recall 与来源。旧名字仍然可用：
`teamai skill get team-wiki-codebase` 等价于 `wiki`。

---

## 日常使用

### 自动同步

`teamai init` 时已注入 Hooks 到你的 AI 工具中。**每次启动 AI 会话时会自动执行 `teamai pull`**，无需手动操作。在 project scope 下，该 SessionStart hook 会先为当前 Agent 创建项目根目录（例如用 Claude Code 打开仓库时创建 `<project>/.claude`），然后再 pull。

*(注：会话启动自动同步依赖工具的生命周期 Hooks 支持，如 [CC]、Codex、GitHub Copilot CLI、Cursor、CodeBuddy、WorkBuddy、Qoder、Kiro、OpenCode、Oh My Pi、Pi、Hermes、OpenClaw 等。Kiro 仅在交互式 CLI 会话激活由 TeamAI 渲染的自定义 agent 时触发该 Hook；其内存中的内置默认 agent 无法写入，非交互模式也不会触发 `agentSpawn`。对于暂无 teamai 可写入 Hooks 的工具（如 JoyCode、Gemini CLI 等），需手动执行 `teamai pull`。)*

如果需要立即同步，可以手动执行：

```bash
teamai pull              # 手动拉取
teamai pull --dry-run    # 试运行，不实际修改
```

手动执行 `teamai pull` 会在结束时运行 `teamai doctor` 的检查，并逐条打印失败项及其修复建议——包括它刚刚报告同步的 skill 是否真的落到每个启用工具的磁盘上、且可被读取。全部通过时不会有任何额外输出，退出码也不变。SessionStart hook 路径和 `--dry-run` 完全不运行检查，会话启动速度保持不变。托管平台相关的检查（`gh`/`gf` 认证）留给 `teamai doctor`：这次 pull 刚刚用过该平台。

> Project scope 默认与 user scope 隔离。当前工作目录包含 project scope 的 `.teamai/config.yaml` 时，`pull` 会处理该项目并跳过 user scope；仅当本地配置包含 `inheritUserScope: true` 时，才会先刷新安全的 user 资源通道。当前目录没有 project 配置时，`pull` 处理 user scope。project 模式下，user 的 `env`、MCP 定义、sources、reporting 和写入行为仍保持隔离。hooks 是唯一例外：project scope 的 hooks 会注入到你的 **HOME** 工具设置（`~/.claude/settings.json` 等），而非 `<projectRoot>`——因为内置 hooks 依据传给 `hook-dispatch` 的 `cwd` 门控，且 `~/.claude` 恒存在、能通过「已安装工具」门槛（详见 Hooks 章节）。在没有 teamai 配置的目录中（既没有 project 配置也没有 user scope），团队 hooks 不做任何事：不显示提醒，也不记录会话或 skill 使用；只运行机器级别的工作（CLI 更新检查、SessionStart 时的 pull、本地 agent，以及 pull 暂存的包提示）。对团队 hooks 和 skill 使用记录而言，存在但无法读取的 project 配置视为没有配置，而不会退回 user scope，也不会退回其后优先级更低的 project 配置（如旧的 `.teamai/config.yaml`）；SessionStart 时的 pull 仍自行解析其项目。self 单仓模式则把 hooks 保留在业务仓库里，随 clone 传播。

启用角色化 skills 后，`pull` 的 skills 同步来源会变成 `skills/<namespace>/` 中的内容，按 `primaryRole + additionalRoles` 展开对应的 namespace，拍平安装到本地各 AI 工具 skills 目录。`rules/`、`docs/` 仍然保持原有同步逻辑；`agents/<namespace>/` 按角色的 `agents` namespace 同步（见 [Agents 资源类型](#agents-资源类型)）。`learnings/` 根目录对所有人共享，而 `learnings/<project-id>/` 子目录只对本目录激活的项目同步（见 [多项目](#多项目project-作为与-role-正交的维度)）。

### 团队包

`teamai packages` 通过现有团队仓库统一声明和恢复 npm 包与 Claude Code 插件。TeamAI 调用原生 `npm` 和 `claude plugin` CLI，不自行分发包内容。

**管理员操作：**

传入 target 时，命令会完成安装，并将声明写入团队仓库的 `teamai.yaml`：

```bash
# npm 包（默认安装为项目依赖）
teamai packages install typescript

# 未带 scope 的 name@version 与 plugin@marketplace 有歧义，需显式指定 npm
teamai packages install typescript@5.9.2 --npm

# 从指定 registry 安装全局 npm CLI
teamai packages install eslint@latest --global \
  --registry https://registry.npmjs.org/

# Claude 插件
teamai packages install code-review@claude-plugins-official

# 通过现有评审流程分享更新后的 teamai.yaml
teamai push
```

npm target 支持 `name` 或 `name@version`。由于未带 scope 的 `name@value` 也可能表示 `plugin@marketplace`，当后缀不是已声明或已注册的 Claude marketplace 时需使用 `--npm`。带 scope 的 npm 名称（`@scope/name`）、无版本名称、`--global` 和 `--registry` 已能明确表示 npm，不会探测 Claude CLI。安装项目依赖时，当前目录必须包含 `package.json`；机器级 CLI 工具使用 `--global`。`--registry` 会随该包的声明保存，且必须是不包含凭据的 HTTP(S) URL。registry 认证信息应保存在 npm 配置或环境变量中。

Claude 插件 target 使用 `plugin@marketplace` 格式。`claude-plugins-official` 官方 marketplace 会自动解析；使用其他 marketplace 前，需先在 Claude Code 中注册，以便 TeamAI 获取并记录其来源。可使用 `--claude` 明确指定生态，并在 marketplace 不可用时获得针对性的错误。存在歧义的 target 会直接失败，不会运行任一包管理器。`--global` 和 `--registry` 仅适用于 npm target。

**成员操作：**

现有 SessionStart hook 会执行 `teamai pull`。当 `packages` 声明发生变化时，它只会提示成员检查 `teamai.yaml` 并主动安装，不会自动执行第三方包或插件代码。pull 继续在后台运行，避免网络延迟阻塞 IDE；如果声明在 SessionStart 输出窗口结束后才拉取完成，TeamAI 会把同一条提示安全地排队，并在本会话下一次 UserPromptSubmit 时投递。

```bash
teamai packages             # 安装团队声明的全部包和插件
teamai packages --dry-run   # 预览底层命令，不安装也不写文件
teamai doctor              # 检查运行环境、声明的包/marketplace/插件状态，以及磁盘上实际落地的资源；任一检查失败时退出码为 1
```

安装成功后，TeamAI 会在当前 scope 的 `.teamai` 目录下写入本地快照 `teamai.lock`。该文件记录已安装版本，以及供 SessionStart 提示比对的声明哈希，不会写入团队仓库。在 user scope 下，全局 npm 工具和 Claude 插件只需确认一次；项目 npm 依赖会按工作目录分别确认，避免在一个仓库安装后错误关闭另一个仓库的提示。

**声明格式：**

以下内容由 `teamai packages install <target>` 自动维护：

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
    - name: eslint
      version: latest
      global: true
      registry: https://registry.npmjs.org/
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

- `npm[].version` 默认为 `*`，`global` 默认为 `false`。
- `claude.marketplaces` 记录 marketplace 名称与仓库来源。
- Claude 插件必须使用 `plugin@marketplace` 格式，且对应 marketplace 必须已声明。
- `packages` 内未知或拼错的键会在 install 或 push 前被拒绝。
- 包声明对全团队生效，不受角色或项目筛选影响。

### 排除个人不需要的 Skill

如果团队共享的某个 skill 不适合你，可以只在本地将它排除，无需修改团队仓库，也不会影响其他成员：

```bash
teamai skill exclude add using-superpowers
teamai pull                    # 从本地 AI 工具中删除
teamai skill exclude list

teamai skill exclude remove using-superpowers
teamai pull                    # 重新同步
```

排除列表保存在当前 user 或 project scope 的 `config.yaml` 中：

```yaml
excludedSkills:
  - using-superpowers
```

排除规则在角色和标签过滤之后生效。执行 `teamai pull` 时，被排除的 skill 不会同步，并且会清理由之前 pull 安装的副本。`teamai doctor` 会把最终结果集与磁盘实际内容比对，并且不会要求被排除的 skill 存在。

### 推送本地资源

```bash
teamai push          # 扫描新增/修改的资源，创建 MR
teamai push --all    # 跳过确认，直接推送
teamai push --role pm  # 推送到 pm namespace（skills/pm/、rules/pm/、agents/pm/）
```

**命名空间选择（新资源）：** 推送新的 skill、rule 或 agent 时，CLI 会自动检测可用的命名空间并提供交互式选择：

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- 每种资源类型按各自维度解析：skill 用 `skills`，rule 用 `knowledge`，agent 用 `agents`。一次推送涉及多种类型时，每个维度各询问一次
- 有 `primaryRole` 时，从 manifest 展开可用 namespace 列表
- 无 `primaryRole` 时，skill 自动扫描团队仓库目录结构；新的 rule / agent 保留在共享根目录
- 单一命名空间时自动选中；也可用 `--role <id>` 显式指定
- 修改已有资源时自动保持原 namespace
- 每个资源的落点都会打印出来，例如 `[rules] my-rule → rules/pm/my-rule.md`
- 若 roles manifest 存在却无法给出答案，命令会报错停止，而不会退回共享根目录。未包含当前配置的角色时：请修复 `manifest/roles.yaml`、执行 `teamai roles set <role>`，或用 `--role <ns>` 显式指定。无法读取、无法解析或为空时，push 在扫描阶段即停止（exit 2），早于 `--role` 生效，因为扫描需要 manifest 才能判断哪些 namespace 属于你：请先修复 `manifest/roles.yaml`。团队仓库根本没有 `manifest/roles.yaml` 时，保持原有行为
- `teamai push --dry-run` 会做同样的落点解析，并在同样的无法解析情况下报错，不会把真实命令会拒绝的推送报为可行
- 当有多个 namespace 可接收新资源、且没有可供询问的终端（CI、hook、`TEAMAI_NONINTERACTIVE`）时，push 会以退出码 2 停止，列出这些 namespace，并要求使用 `--role <ns>`
- `--role`/`--project` 只放置新资源。对共享根目录 rule 或 agent 的修改仍留在共享根目录，push 会给出提示
- 已落点的资源在发布它的机器上仍可维护：PR 未合并期间，待评审 PR 记录会把作者对自己副本的修改带回该 PR；文件进入默认分支后，`state.json` 会记录 push 的落点，因此修改仍会写回同一个文件；即使 agent 落在本目录未激活的 namespace，也不会被当作“无活跃源”跳过
- `teamai remove rules <name>` 同时接受作者副本的简名和发布名 `<namespace>/<name>`：会打印实际解析到的名字，并同时删除带 namespace 的团队文件和作者在 rules 根目录的副本。若无法先刷新团队仓库，或本机的落点记录无法更新并保存，`remove` 会以退出码 1 停止且不删除任何内容，因为两者都可能把名字解析到错误的文件
- 本地 agent 被视为其来源团队 agent 的编辑：优先是活跃 namespace 或共享根目录中的 agent，其次是本机放置的 agent。只有两者都不存在时，才由 `--role`/`--project` 决定，此时该 agent 在该 namespace 中是新的；若该 namespace 已有同名 agent，则跳过该 agent 而不是覆盖它，与 rule 的处理一致。两个活跃的同名 agent 无论是否指定参数都视为有歧义并跳过。同名 agent 允许存在于多个 namespace，因此你未指定的非活跃 namespace 中的同名副本不会阻止你发布。本机放置的 agent 若在本机上次同步后被团队修改，会暂缓推送，直到你运行 `teamai pull`，因为 agents 没有推送前同步。单仓库模式下，`.teamai/` 中的根目录副本若与其落点文件的某个旧版本相同，也会暂缓推送：没有任何操作会刷新它，因此它是旧副本而不是编辑
- 新资源绝不会覆盖已存在的资源：若解析出的 namespace 下已有同名文件，命令会报错并指出该文件：请先 pull 并修改已有副本、重命名自己的资源，或用 `--role <ns>` 换一个 namespace
- 本目录未激活的 namespace 下的 agent 可通过落点记录继续编辑，`pull` 也会基于同一记录下发它，使本地副本与团队文件保持同步；若已激活的 namespace 中已有同名 agent，则以它为准
- 待评审 PR 中的资源默认沿用该 PR 的落点；但若本次 push 明确指定的 namespace 与记录的落点不同（共享根目录也算一种落点），则以命令行为准，原 PR 保持不动，并提示该冲突
- push 开始时若无法刷新团队仓库，`--project` 会报错停止，而不会按可能已过期的 `manifest/projects.yaml` 落点；未使用 `--role` 放置的任何新资源同样如此，因为其落点来自该克隆（`manifest/roles.yaml`、它的缺失，或仓库中已有的 namespace）。请先修复 pull 再重试，或用 `--role <ns>` 显式指定 namespace。若本机的落点记录无法更新并保存，`push` 也会停止且不推送任何内容
- 落点记录只在推送的文件进入默认分支后才写入，因此未合并即关闭的 PR 不会留下记录，无论其分支是否还在。团队删除该文件、或共享根目录出现同名文件时（此时你的根目录副本改为跟随该文件，`pull` 会提示），记录会被清除。`push`、`pull` 和 `remove` 都会在读取记录前先做这一步。`teamai remove` 本身不清除记录：删除要等其 PR 合并才进入默认分支，在此之前重试 `remove` 仍会把简名解析到带 namespace 的团队文件。若该文件进入默认分支时的内容与你推送的不同（例如评审者在 squash 合并前修改了 PR），则不会写入记录，push 会提示一次；此时运行 `teamai pull`，并把该文件当作现在的团队文件来编辑
- 你自己发布到某个 namespace 的 rule，其本地副本仍留在 rules 根目录。该 namespace 在本目录激活时，`pull` 会直接更新这个副本，而不会在 `rules/<namespace>/` 下再写一份；未激活时 `pull` 不会动它。只有当它对应的团队文件不存在时才会被清理

**更新已存在的 PR 而非重复创建：** 如果某个资源已在一个未合并的 PR 中等待评审，再次对它执行 `teamai push` 会就地更新那个已存在的 PR（通过 force-push 其分支），而不是新开一个重复的 PR。保持该资源被选中即更新其 PR；取消勾选则不动它。同一次运行中选中的其他无关资源会进入各自新开的 PR。一旦该 PR 合并（或其分支从远端删除），记录会被清除，下次 push 照常新开 PR。

**YAML Frontmatter 自动补全：** 推送时 CLI 自动检查合法的 mapping 形式 `SKILL.md` frontmatter，缺少 `name`/`description` 则自动补全。格式损坏或根节点为标量时会保留原文并告警，需要手动修复。

### 查看状态

```bash
teamai status        # 当前 scope、同步时间、资源统计
teamai status --all  # 列出 ~/.teamai/projects 下所有项目数据分区
```

`Team resources` 中的 `skills` 数量与 `teamai list skills --source repo` 的团队仓库列表一致，
包含平铺技能（`skills/<name>/SKILL.md`）和 namespace 下的技能
（`skills/<namespace>/<name>/SKILL.md`）。namespace 目录及技能包内部的子模块不单独计数。
例如，`skills/ai/` 下有 6 个技能，另有 `skills/officecli/`，总数为 7。

`docs` 递归统计 `docs/` 下的文件，排除隐藏文件和隐藏目录。全部放在子目录里的文档也会被
`pull` 发现并同步。此资源摘要不包含经验数量；经验在根目录全团队共享，或按启用的项目选择，
不按角色划分。

`--all` 会枚举每个项目的机器数据分区，并标注为 **active**（项目仍在磁盘上）、
**ORPHAN**（项目已移动/删除——该分区可安全 `rm -rf`）或 **unknown**（无 `anchor`
文件，无法确认是否孤儿——绝不建议删除）。ORPHAN 判定只依据 anchor，因此绝不会凭猜测
把分区标记为可删除。teamai 从不自动回收孤儿分区，因此这是你找出可手动删除分区的方式。

### 角色管理

角色（Roles）控制每个成员看到哪些 skills、namespace 化的 rules 与 agents。管理员通过 `manifest/roles.yaml` 定义角色，成员选择自己的角色后，pull 会同步对应 namespace 的 skills。启用标签订阅后，还可以额外同步其他 namespace 中显式匹配标签的 skills，但不会包含非活跃 namespace 中未打标签的 skills。

**管理员操作：**

```bash
# 初始化（交互式创建 manifest）
teamai roles init

# 添加角色
teamai roles add devops --namespaces common,infra -d "基础设施团队"

# 修改角色（增删 namespace、改描述）
teamai roles update hai --add-namespaces infra
teamai roles update hai --remove-namespaces legacy -d "新描述"

# 删除角色
teamai roles remove devops

# 预览变更
teamai roles add test --namespaces common,test --dry-run
```

`--namespaces` 列表会同时应用到 `knowledge`、`skills` 与 `agents`。以上命令会自动 push 分支并创建 MR，合并后对全团队生效。

**成员操作：**

```bash
# 查看可选角色
teamai roles list

# 选择自己的角色
teamai roles set hai
teamai roles set hai --add pm    # 主角色 hai + 额外角色 pm

# 同步新角色的资源
teamai pull
```

> **安全降级：** 如果管理员删除了某个角色，仍然配置了该角色的成员在 pull 时不会报错，而是回退到全量同步并输出警告，提示重新选择角色。

### 标签订阅

标签让成员订阅默认角色 namespace 之外的指定 skills 和 rules。

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
```

管理员可通过 `teamai tags add` 和 `teamai tags remove` 管理资源标签。修改订阅后运行 `teamai pull`，即使团队仓库没有变化也会执行全量同步，新匹配的资源会被安装，取消订阅的资源会被清理。该次 pull 结束时的检查会确认新匹配的 skill 已送达每个启用的工具。

---

## 共享团队资源

这是 Team Execution：Skills、Rules 等 Harness 定义一次，经 MR 评审后由 `teamai pull` 分发到每个 Agent。

### Skills（技能）

```bash
# 创建 skill
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

# 推送到团队（YAML frontmatter 会自动补全）
teamai push

# 推送到指定角色 namespace
teamai push --role pm
```

> **Frontmatter 自动补全：** 推送时 CLI 会检查 `SKILL.md` 的 YAML frontmatter（`name`/`description`），缺失则自动从目录名和内容中推导并补全。你也可以手动添加更精确的 frontmatter：
>
> ```yaml
> ---
> name: my-deploy-helper
> description: 帮助团队部署服务的自动化技能
> tags: [deploy, automation]
> ---
> ```
>
> YAML 格式损坏或 frontmatter 根节点不是 mapping 时，CLI 会保留原文并输出告警；请手动修复后再推送。

启用角色化 skills 后，push 的目标目录为：

- 默认：`skills/<primaryRole>/<skill-name>/`
- 显式覆盖：`skills/<role>/<skill-name>/`（通过 `--role`）

### Rules（规则）

```bash
# 创建 rule
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# 代码审查规范
- 所有函数必须有 JSDoc 注释
- 禁止使用 `any` 类型
- 测试覆盖率不低于 80%
EOF

# 推送
teamai push
```

> 管理员可在 `teamai.yaml` 中设置强制规则（`sharing.rules.enforced`），成员不可删除。

### Env（环境变量）

```bash
teamai env add API_ENDPOINT https://api.example.com --description "团队 API 地址"
teamai env list
teamai push
```

变量定义在团队仓库的 `env/env.yaml` 中。`teamai env add` 只写入前三个字段；`roles` 与 `projects` 需要手动编辑，与 hooks、MCP server 一致：

```yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: 团队 API 地址              # 可选
  - key: CHECKOUT_DB_URL
    value: https://checkout-db.internal
    projects: [checkout]                  # 可选；默认所有目录
  - key: DEPLOY_REGISTRY
    value: registry.internal
    roles: [devops]                       # 可选；默认所有成员
```

`roles` 与 `projects` 的规则与 MCP server、hooks 完全一致：省略时对所有人生效，`[]` 对使用了该维度的成员都不生效，成员未配置的那个维度不产生过滤，两者以 **AND** 组合。不再匹配的变量会在下一次 pull 时从 `env.sh` 中移除，即使这次 pull 因团队仓库未变化而提示 `Already synced` 也一样，因此切换角色、执行 `teamai projects set` 或升级 CLI 都会把它从成员的 shell 中撤掉，无需 `--force`。在那次 pull 之前，`teamai doctor` 会报告 `env.sh` 中仍在导出、但已不再下发的变量，前一个项目的密钥不会悄无声息地继续生效。对已存在的 key 执行 `teamai env add` 会保留它原有的 `roles:`/`projects:`。

`pull` 报告的是实际送达该成员的数量，与声明总数不同时会同时给出总数（`Synced 1 of 3 env variable(s)`），以便区分"被维度过滤掉"和"丢失"。

由于 shell 配置文件中只有一个 teamai 区块、只指向一个 `env.sh`，在多个项目级目录中都执行过 pull 的机器，新开的 shell 里会是最后一次 pull 的那个目录的变量。每个目录自己的 `env.sh` 仍然是正确的；只是 shell 配置文件只能指向其中一个。

`pull` 时，若启用了 `injectShellProfile`（默认启用），`$SHELL` 为 zsh 时环境变量块会写入 `~/.zshrc`，否则写入 `~/.bashrc`——但 Windows 上例外：`$SHELL` 通常未设置，而 Git Bash 以*登录 shell*方式启动，从不读取 `.bashrc`，因此 teamai 会优先选择已存在的 `~/.bash_profile`、其次 `~/.bash_login`、再次 `~/.profile`，只有三者都不存在时才回退到 `~/.bashrc`（通过 MSYS2/Cygwin 安装、会设置 `$SHELL` 的 zsh 仍会解析到 `.zshrc`）。这与 Git for Windows 自身在 `/etc/profile.d/bash_profile.sh` 中的回退逻辑一致，其判断条件是 `[ -e ~/.bashrc -a ! -e ~/.bash_profile -a ! -e ~/.bash_login -a ! -e ~/.profile ]`——只有在这一种情况下它才会生成一个会 source `.bashrc` 的 `.bash_profile`；这也是为什么哪怕一个只 source 了其他内容（例如 `~/.local/bin/env`）的 `~/.profile` 存在，也足以让 `.bashrc` 单独失效。可通过 `teamai.yaml` 中的 `sharing.env.shellProfilePath` 覆盖目标文件。

每次 pull 都会重新走一遍这个优先级判断，找到当前环境实际会读取的那个文件，然后沿着它对另外四个候选文件名的引用一路查下去——无论要经过多少跳——寻找一个已经带着代码块的候选文件，而不是重复注入。如果链条中间经过的是这五个候选文件名之外的文件（比如某些环境会改用 `~/.config/shell/profile` 这类自定义文件来 source），这条链就不会被继续跟踪。这正是为了不让 Git for Windows 自身的引导逻辑把目标文件从脚下换掉：上面那条 `/etc/profile.d/bash_profile.sh` 判断条件，在第一次 pull 写入 `.bashrc` 之后同样会成立，于是下一次 Git Bash 登录 shell 启动时就会自动生成一个 source 它的 `~/.bash_profile`；如果不沿着这条转发链去找，下一次 pull 就会转而偏好这个新出现的文件，在那里注入第二个代码块，而原来那个——依旧在正常工作，只是绕得更远了——则会被误报为失效的遗留代码块。同样的道理也适用于一个普通的 `.profile`：它用一条扁平的存在性守卫（`[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"`）为交互式 shell source `.bashrc`——这时登录 shell 最先读到的文件，离实际代码块有两跳之遥。

不过，只有两种字面写法才算真正的引用：单独一行的裸 `source X` / `. X`，或者单独一行、与 Git for Windows 自己生成的写法完全一致的自引用存在性守卫 `test -f X && . X` / `[ -f X ] && . X`（被测试路径与被 source 路径完全相同）——两种情况下 `X` 都必须是不加引号的 `~/name`，或不加引号/用双引号包裹的 `$HOME/name`（绝不是加了引号的 `~`，也绝不是用单引号包裹的 `$HOME`：shell 不会展开这两种写法，看起来对的引用实际会 source 一个不存在的字面路径）。除此之外的写法——source 本身带了重定向或额外参数、`||` 回退、不相关的 `&&` 连接命令、任何这段逻辑无法独立验证的条件——一律不识别，直接回退到按优先级选出的文件，而不是去猜。这是刻意收窄到两种固定写法的封闭集合，而不是尝试解析任意的 shell 条件：真要匹配一个真实 shell 脚本能用来让某一行变成有条件执行（或者把可执行内容伪装成惰性文本）的所有手法，需要一个真正的 shell 解析器，任何固定规模的规则集合都不可能穷尽这件事。嵌在 `if`、`for`/`while`/`until`、`case`、`select`、函数体，或者 `(...)`/`{...}` 分组里的内容一律不算数，不管外层条件写的是什么——这些结构要么不保证一定会执行，要么即使一定会执行（比如子 shell 或大括号分组），它导出的环境变量也传不到调用它的 shell 里，这也意味着 Debian/Ubuntu 标准模板里那种嵌套两层 `if`、沿途还检查 `$BASH_VERSION` 的写法无法被识别，会回退到按优先级选出的文件。位于无条件的顶层 `return` 或 `exit` 之后的内容同样不算数，因为控制流根本不会执行到那里。凡是这套逻辑判断不了的情况，以及当前这条链条根本没触及到的候选文件——哪怕它本身带着代码块——都绝不会因此被优先选中，否则 #682 之前旧版本留下的失效代码块就会永远压过正确的文件，等于在升级后又悄悄把 #682 引入回来。

`doctor`（以及 `pull` 结束后自动运行的检查）还会标记出遗留在*其他*候选文件中的 teamai 环境变量块——例如 #682 之前的旧版本写入 `.bashrc` 的代码块，即便该代码块本身已损坏、从未生效。`teamai uninstall` 会清理它。

### Docs（文档）

将文档放入团队仓库 `docs/` 目录，push 后团队成员 pull 时自动同步。

### MCP Server

在团队仓库的 `mcp/mcp.yaml` 中声明一次，`teamai pull` 时会按各工具的原生格式写入它们各自的 MCP 配置文件。不在 `enabledAgents` 中或列在 `disabledAgents` 中的工具会被跳过。

```yaml
servers:
  - name: gpu-analysis
    description: GPU 存量与价格查询
    transport: http                      # stdio | http | sse
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000

  - name: local-formatter
    transport: stdio
    command: npx
    args: ['-y', '@acme/formatter-mcp']
    env:
      FORMATTER_MODE: strict
    requires: [npx]                      # PATH 上找不到 npx 时跳过并提示
    tools: [claude, cursor]              # 可选；默认所有支持 MCP 的工具
    roles: [devops]                      # 可选；默认所有成员
    projects: [checkout]                 # 可选；默认所有目录
```

`requires` 从 `PATH` 解析。Windows 上还会匹配 `PATHEXT` 后缀（`uvx` 可匹配 `uvx.exe` / `uvx.cmd`）。

`roles` 填写 `manifest/roles.yaml` 中的角色 id。成员的任一角色（`primaryRole` 或 `additionalRoles`）被列出时才会安装该 server；`roles: []` 对任何人都不安装，与 `tools: []` 一致。未配置角色的成员会收到全部 server，与 skills、rules 的无过滤回退一致。成员切换角色后，不再匹配的 server 会在下一次 pull 时移除，手动添加的 server 不受影响。`roles.yaml` 中不存在的 id 每次 pull 只提示一次。不支持该字段的旧版 teamai 会忽略它并为所有人安装。

`projects` 填写 `manifest/projects.yaml` 中的项目 id，在另一个维度上遵循同一条规则：目录通过 `teamai projects set` 绑定的任一项目被列出时才会安装该 server；`projects: []` 对任何人都不安装；未绑定任何项目的目录会收到全部 server。`teamai projects set` 切换到其他项目后，不再匹配的 server 会在下一次 pull 时移除。`projects.yaml` 中不存在的 id 每次 pull 只提示一次；团队根本没有 `projects.yaml` 时同样会提示，因为此时无法校验任何 id。

空列表有一个需要注意的点，它对 `roles: []` 一直同样适用：“对任何人都不安装”指的是使用了该维度的成员。完全未配置该维度的成员不受过滤，仍会收到该条目。旧版角色因 `manifest/roles.yaml` 无法加载而未能解析时，不算“未配置”：在 manifest 修复之前，该成员收不到任何按角色限定的条目。如果需要它对所有人都不生效，请用 `tools: []` 或直接删掉该条目。

缺少 `projects.yaml` 并不会关掉这个 key。目录的活动项目来自它自己的 `config.yaml`，所以无论清单是否存在，绑定到 `billing` 的目录依然会过滤掉 `projects: [checkout]` 的 server。清单提供的是校验 id 的能力。

两个维度互相独立，并以 **AND** 组合：`roles: [frontend]` 与 `projects: [checkout]` 同时出现时，只分发给 checkout 上的 frontend 成员，而不是两者的并集。这与 `tools:` 和 `roles:` 现有的组合方式一致，也有意区别于角色与项目**资源命名空间**取并集的行为——后者回答的是"同步哪些目录"这个不同的问题。

这正是这两个 key 要控制的成本：一个有 5 个项目、每个项目 3 个 server 的团队，会让每位持有该角色的成员启动 15 个 server 进程，并在每次会话的上下文中携带 15 份工具列表。

各工具的落点：

| 工具 | 用户级 | 项目级 |
|---|---|---|
| claude | `~/.claude.json` | `<project>/.mcp.json` |
| cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| codebuddy | `~/.codebuddy/mcp.json` | `<project>/.mcp.json` |
| workbuddy | `~/.workbuddy/mcp.json` | `<project>/.workbuddy/mcp.json` |
| copilot | `$COPILOT_HOME/mcp-config.json` | `<project>/.github/mcp.json` |
| codex | `~/.codex/config.toml` | 不支持 |
| qoder | `~/.qoder/settings.json` | `<project>/.qoder/settings.json` |
| qoder-cn | `~/.qoder-cn/settings.json` | `<project>/.qoder/settings.json` |
| kiro | `~/.kiro/settings/mcp.json` | `<project>/.kiro/settings/mcp.json` |
| opencode | `~/.config/opencode/opencode.json` | `<project>/opencode.json` |
| omp | `~/.omp/agent/mcp.json` | `<project>/.omp/mcp.json` |


CodeBuddy Code 的 [MCP 文档](https://www.codebuddy.cn/docs/cli/mcp)
明确将项目根目录的 `.mcp.json` 列为首选项目配置。
该路径与 TeamAI 的用户级目标 `~/.codebuddy/mcp.json` 相互独立。
`teamai.yaml` 中显式设置的 `toolPaths.codebuddy.mcpProject` 仍然优先生效。
已有团队若固定使用 `.codebuddy/mcp.json`，请先在对应工作区执行
`teamai mcp remove`，再将该值改为 `.mcp.json`，最后运行
`teamai mcp inject`。请检查并保留两处文件中自行添加的服务；
TeamAI 不会迁移或删除旧文件。Claude Code 也读取根目录的 `.mcp.json`，
因此两个工具共享该文件。

Copilot 使用原生 `mcpServers` 结构：`stdio` 写成 `type: "local"`，远程传输保留 `http` 或 `sse`，每个 TeamAI 管理的条目都会带上必需的 `tools: ["*"]` 允许列表。TeamAI 遵循 `COPILOT_HOME`，项目配置使用 Copilot CLI 官方文档指定的 `.github/mcp.json` 仓库路径。详见 [GitHub Copilot CLI 添加 MCP Server](https://docs.github.com/zh/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)。Codex 支持 `stdio` 与 `http`，`sse` 会被跳过。Qoder 使用对应作用域 `.qoder/settings.json` 中与 Claude 兼容的 `mcpServers` 格式。Kiro 在专用的、只含 `mcpServers` 的 `.kiro/settings/mcp.json` 中使用同一格式（见 [Kiro MCP 配置文档](https://kiro.dev/docs/mcp/configuration/)）。OpenCode 支持 `stdio`（写成其 `type:"local"` 形态）与 `http`（`type:"remote"`），`sse` 会被跳过，其 server 位于共享 `opencode.json` 的 `mcp` 键下。归属记录在 `~/.teamai/managed-mcp.json`——手动添加的 server 不动；与手写同名则跳过，除非 `--force`。

**密钥**：在 `mcp.yaml` 里写 `${VAR}`，不要写明文。取值优先来自环境变量，其次是 `env/env.yaml` → `~/.teamai/env`。变量无法解析则跳过并提示。

teamai 会**把每个 `${VAR}` 解析成取值后原样写入**各工具的配置文件（新建文件权限为 `0600`）。它不依赖任何工具自身的环境变量展开——因为那种展开很脆弱：最典型的是，以 GUI 方式（Dock/Launchpad）启动的 IDE 不会继承你 shell 中 `export` 的变量，`${VAR}` 占位符会展开为空、导致服务端 401。解析成明文可以保证无论工具如何启动，token 都在。

> ⚠️ **解析后的 token 会落盘。** 项目级 MCP 配置（`.mcp.json`、`.github/mcp.json`、`.cursor/mcp.json`、`.codex/config.toml`、`opencode.json`）因此含有明文密钥——请把它们加入 `.gitignore`，切勿提交。

Claude Code 可能把来自仓库的 `.mcp.json` 标为待批准，需在交互式会话中确认一次。

```bash
teamai mcp list              # 查看 server、密钥状态、角色限制与安装位置
teamai mcp inject            # 立即注入；--dry-run 预览，--force 覆盖同名
teamai mcp remove            # 移除所有 teamai 管理的 server
```


---

## 知识沉淀与检索

这是 Team Context，也是 Team Improvement 的起点：先记下本次 Session 真正学到的东西，再让下一次 Agent 能检索到。

### 贡献知识

AI 通过 Hooks 追踪你的编码会话。当会话结束时（Stop hook），系统按**摩擦信号**评分——你是否打断/纠正了 AI、拒绝了工具调用，或 AI 反复重试出错的工具。又长又顺的会话（工具调用多但没摩擦）不会触发，真正踩过坑的会话才会。达标后会显示如下英文提醒：

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

提醒会列出实际触发它的非零摩擦信号；如果能取得首个任务，还会附上脱敏、单行化后的任务摘要，便于判断本次 session 是否值得分享。使用内置 `share` 工作流（`teamai skill get share`），AI 会自动总结本次 session 经验并贡献到团队知识库。每个 session 最多提示一次。

在 Codex 系列（`codex`、`codex-internal`、`tcodex`）中，Stop hook 会暂存贡献和知识引用提醒，在同一会话的下一次 UserPromptSubmit 交付，不会强制开启额外一轮。贡献提醒只交付一次；若下一次输入前已经贡献，则丢弃该提醒。

也可以手动指定文件：

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
```

#### 关闭提醒

如果团队通过自己的评审流程沉淀知识（例如个人复盘后提交普通 PR），可以只关闭这条提醒，Stop hook 的其余功能（更新检查、votes 同步、dashboard 上报）照常运行。配置方式与 recall 相同，分两层：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.contributeHint.enabled` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `contributeHintEnabled` | `true` / `false`，优先级高于团队默认 |
| 环境变量 | shell | `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` | 强制关闭提醒（紧急开关） |

只影响提醒本身：摩擦评分、`teamai contribute --file` 和手动调用 `/teamai` 不受影响。

未开启 recall 时（默认关闭；团队在 `teamai.yaml` 设置 `sharing.recall.enabled: true`，或单台机器运行 `teamai recall enable`）也不会显示这条提醒：提醒指向 `share` 工作流，而 recall 关闭时 `teamai skill get share` 会拒绝执行。只读 HTTP 源上，或 teamai 配置文件存在但无法加载时，这条提醒也从不出现，因为 `share` 同样会拒绝；在未配置 teamai 的目录中也不会出现，尽管 `teamai skill get share` 在那里仍会提供。

### 搜索知识

```bash
teamai recall "API 超时"
teamai recall "GPU 内存不足"
```

- 支持中英文混合搜索
- 当前工作目录包含 project scope 配置时搜索该项目；配置 `inheritUserScope: true` 后先搜索 project、再搜索 user，并标注 `[project]`/`[user]` 来源；否则搜索 user scope
- 资源类型和文件名都相同时由 project 条目优先；不同资源类型即使文件名相同也分别保留
- 当前 scope 中被查阅的知识自动 upvote；项目运行期间继承的 user 命中保持只读
- 提供轻量相关性预检 `teamai recall --check "<关键词>"`，输出 `RELEVANT score=<n> threshold=<n>` 或 `NOT_RELEVANT score=<n> threshold=<n>`，不读取文件、不 upvote —— recall subagent 用它在任务与团队知识无关时跳过检索。当 top 命中为 `RELEVANT` 时，还会输出 `matched=`/`missing=`，即命中/未命中其 title 与 tag 的查询词
- `RELEVANT` 表示分数越过阈值、值得花成本读文件，**不代表**知识库覆盖了你要找的主题。请用 `matched=`/`missing=`（以及完整结果里的 `Matched:`/`Missing:` 行）自行判断：若关键区分词全部落在 missing 里，那条只是主题相邻，并非答案

### 开启 / 关闭 Recall

Recall 功能通过两级配置控制——管理员设置团队默认值，成员可在本地覆盖：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.recall.enabled` | `true` / `false`（默认 `false`） |
| 用户覆盖 | `~/.teamai/config.yaml` | `recallEnabled` | `true` / `false`，优先级高于团队默认 |
| 环境变量 | shell | `TEAMAI_RECALL_DISABLED=1` | 强制禁用所有 recall hooks（应急开关） |

```bash
teamai recall enable     # 开启 recall，部署 subagent 和 rules
teamai recall disable    # 关闭 recall，移除 subagent 和 rules
teamai recall status     # 查看当前生效状态（团队默认 + 用户覆盖）
```

关闭后，`teamai pull` 将跳过部署 recall subagent、recall rules 注入块和 TodoWrite 提醒 hook。手动执行 `teamai recall <query>` 搜索不受此开关影响。

### 知识库维护

随着时间推移，部分 learnings 会积累低置信度（无人 upvote）或变得过时。`teamai recall maintenance` 可保持知识库健康：

| 选项 | 说明 |
|------|------|
| `--prune` | 查找低于置信度阈值的 learnings 并删除 |
| `--threshold <n>` | 剪枝用置信度阈值（默认 `0.15`） |
| `--archive` | 将剪枝条目移至 `archive/` 而非直接删除 |
| `--confidence-writeback` | 从投票历史重新计算置信度，并回写到 frontmatter |
| `--update-quality` | 找出高召回但低认可的 docs/rules/skills，生成 AI 更新草稿（`.draft.md` 文件） |
| `--dry-run` | 预览将要执行的操作，不做任何实际修改 |

```bash
# 预览过时条目，不做任何修改
teamai recall maintenance --prune --dry-run

# 归档低置信度 learnings（置信度 < 0.15）
teamai recall maintenance --prune --archive

# 按当前投票重新计算并回写置信度分数
teamai recall maintenance --confidence-writeback

# 查找过时条目并生成更新草稿
teamai recall maintenance --update-quality
```

运行 `--update-quality` 后，审查生成的 `.draft.md` 文件，将满意的文件重命名为 `.md` 即可应用更新。

### 晋升 Learnings

当 learning 达到成熟标准时，可将其晋升为正式团队知识（skill、rule 或 doc）。晋升判据：置信度 ≥ 0.90、≥ 5 次 upvote、≥ 2 个不同贡献者、存在时长 ≥ 14 天。

```bash
# 列出所有可晋升候选
teamai recall promote

# 晋升指定 learning（AI 将其改写为目标格式）
teamai recall promote <learningId>

# 晋升到指定类别
teamai recall promote <learningId> --category skills

# 预览操作，不写入文件
teamai recall promote <learningId> --dry-run
```

选项：

| 选项 | 说明 |
|------|------|
| `--category <cat>` | 目标类别：`skills` \| `rules` \| `docs` |
| `--dry-run` | 预览操作，不做任何实际修改 |

---

## 知识库健康报告

看板内置了一个 **KB Health**（知识库健康）报告页面，展示团队知识库的使用情况与健康状态，涵盖 `teamai recall` 投票、learnings、docs、rules 和 skills 采集到的所有数据。

```bash
# 启动看板后，进入 Team Context（知识库健康）或 Team Improvement（维护）
teamai dashboard

# 报告也可直接访问：
#   http://localhost:3721/kb-report
```

报告会聚合本地 `~/.teamai` 知识库（或已配置的团队仓库），打开页面即按需渲染，无需任何参数。

### 报告内容

| 区块 | 说明 |
|------|------|
| **概览卡片** | 总条目数、总召回次数、整体覆盖率%、贡献者数 |
| **各类型覆盖率** | skills、rules、docs、learnings 的召回覆盖率分类 |
| **高频召回排行** | 召回次数最多的条目排名列表 |
| **沉默条目** | 从未被召回的条目——待剪枝或重写的候选 |
| **最近召回月份** | 每条知识仅在最近一次召回的月份计数一次，不表示每月召回总次数 |
| **作者贡献** | 每位贡献者的条目数与召回占比 |
| **维护控制台** | 三个操作区：待晋升条目、建议归档条目、过时待更新条目，每条附可复制命令 |

### 典型工作流

```
打开看板 → Team Improvement
   ↓
查看维护控制台
   ↓
晋升成熟 learnings：
   teamai recall promote <learningId>
   ↓
归档低价值条目：
   teamai recall maintenance --prune --archive
   ↓
更新过时的 docs/rules/skills：
   teamai recall maintenance --update-quality
   （审查 .draft.md → 重命名为 .md）
   ↓
teamai push   # 将清理后的知识库分享给团队
```

---

## 提交 Co-Author 署名

AI 编码工具会在它生成的提交上打一个 `Co-Authored-By:` / attribution 尾注。希望保持干净历史的团队可以为全员关闭它，成员仍可在自己机器上覆盖。`teamai pull` 会把最终生效的意图写入每个已安装工具各自的配置文件。

该功能采用与 recall 相同的两级配置：

| 层级 | 配置文件 | 字段 | 说明 |
|------|----------|------|------|
| 团队默认 | `teamai.yaml` | `sharing.coAuthor.enabled` | `true` = 保留尾注 / `false` = 去除尾注。整块省略表示"无意见"（teamai 不做任何改动） |
| 用户覆盖 | `~/.teamai/config.yaml` | `coAuthorEnabled` | `true` / `false`，优先级高于团队默认 |

不同工具家族映射到不同的设置项：

| 工具家族 | 文件 | 写入的设置 | 作用域 | 可靠性 |
|------|------|------|------|------|
| Claude（`claude`、`codebuddy`、`workbuddy`） | `settings.json` | `attribution.commit` / `attribution.pr` 置为 `""` | 用户 **或** 项目（跟随当前 scope） | 确定生效 |
| Codex（`codex`） | `~/.codex/config.toml` | `commit_attribution = ""` | 仅用户 | 尽力而为 —— 仅当 `[features].codex_git_commit = true` 时生效，teamai 不会强制开启该开关 |
| Cursor | `~/.cursor/cli-config.json` | `attribution.attributeCommitsToAgent = false` | 仅用户 | 尽力而为 —— 存在[上游已知 bug](https://forum.cursor.com/t/local-executor-ignores-cli-config-attribution-opt-out-forcing-co-authored-by-trailer/167722)，local executor 可能忽略该设置 |

语义：

- **只写不删。** teamai 一旦写入某个值，之后团队撤下策略也不会改动该值 —— teamai 绝不还原它去除过的尾注。若要重新启用，请显式把意图设回 `true`（这会移除 teamai 的覆盖，从而恢复工具自身的默认行为）。
- **幂等。** teamai 在 `state.json` 的 `coAuthorManaged` 中记录每个文件上次写入的值，无变化时跳过写入。
- **只改动已安装的工具**，并保留各配置文件中已有的键与注释（键级别的精修，而非整文件重生成）。

`pull` 之后请重启 AI 工具会话使改动生效。

---

## 团队文化

TeamAI 支持将团队文化注入到 AI 工具中，让 AI 编码助手在每次会话中都能感知你的团队文化、价值观和编码准则。

### 创建 culture.md

管理员在团队仓库根目录创建 `culture.md` 文件：

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  vision: A world where AI helps everyone
  values:
    - Innovation
    - Integrity
    - User First
team:
  name: Platform Team
  mission: Enable developers to ship faster
  goals:
    - Ship v2.0 by Q2
    - Improve test coverage to 90%
---

## 编码准则

- 所有 PR 必须有至少一个 reviewer 审批
- 禁止直接 push master
- 测试覆盖率不低于 80%

## 协作规范

- 使用 conventional commits 格式
- PR 描述必须包含 ## Summary 和 ## Test Plan
- 重大变更需要先写设计文档
```

### frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `company.name` | string (必填) | 公司名称 |
| `company.mission` | string | 公司使命 |
| `company.vision` | string | 公司愿景 |
| `company.values` | string[] | 公司核心价值观 |
| `team.name` | string (必填) | 团队名称 |
| `team.mission` | string | 团队使命 |
| `team.goals` | string[] | 团队目标 |

frontmatter 之后的 markdown body 部分会作为团队文化指引的正文内容，整体注入到 CLAUDE.md 中。

### 工作原理

```
团队仓库
├── culture.md          ← 管理员维护
├── skills/
├── rules/
└── ...

teamai pull
    │
    ▼  解析 culture.md
    │  ├─ frontmatter → 结构化公司/团队信息
    │  └─ body → 团队文化指引正文
    │
    ▼  编译为 CLAUDE.md 注入块
    │
    ▼  注入到各 AI 工具的 CLAUDE.md
       ├─ ~/.claude/CLAUDE.md
       ├─ ~/.cursor/CLAUDE.md
       └─ ...
```

注入的内容位于 `<!-- [teamai:culture:start] -->` 和 `<!-- [teamai:culture:end] -->` 标记之间，每次 pull 时自动更新，不会影响文件中的其他内容。

### 查看效果

pull 后可以直接查看 AI 工具的 CLAUDE.md：

```bash
teamai pull
cat ~/.claude/CLAUDE.md
```

你会看到类似这样的注入块：

```markdown
<!-- [teamai:culture:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Culture (teamai)

## Company: Acme Corp
**Mission:** Build great things
**Vision:** A world where AI helps everyone
**Values:** Innovation, Integrity, User First

## Team: Platform Team
**Mission:** Enable developers to ship faster
**Goals:**
- Ship v2.0 by Q2
- Improve test coverage to 90%

## 编码准则
- 所有 PR 必须有至少一个 reviewer 审批
...
<!-- [teamai:culture:end] -->
```

---

## 进阶功能

### HTTP 契约（面向后端实现者）

使用 `teamai init --http <baseUrl>` 时，端点需要提供以下接口（`Authorization: Bearer <api-key>` 鉴权）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | session 启动：upsert agent + 已装 skill |
| `{baseUrl}/api/local-agent/sync` | POST | 上报状态 + 返回待执行的 skill 命令 |
| `{baseUrl}/api/local-agent/commands/ack` | POST | 回执单条命令（`{ id, status, error }`） |

`POST /api/local-agent/sync` 返回待执行命令：

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

后端可下发 **`apply_model_config`** 任务，其 `cmd` 为 JSON。客户端同时兼容设计文档中的候选集结构和
旧版单模型结构：`{"models":[...]}` 按完整快照处理，直接模型对象按增量 upsert 处理。
`max_tokens` 可选（对应 CodeBuddy / WorkBuddy 的 `maxOutputTokens`）；缺省或 `0` 时默认 `4096`。Claude 不使用该字段。

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

候选集只会写入当前上报任务的 agent。CodeBuddy 使用用户级 `~/.codebuddy/models.json`（`{ "models": [...] }`）；
WorkBuddy 使用 `~/.workbuddy/models.json`；当前 `{ "models": [...] }` 和旧版顶层数组两种结构都支持，
已有文件保持原结构。CodeBuddy 或 WorkBuddy 的 workspace 级任务写入
`<workspace>/.codebuddy/models.json`，与产品内嵌模型加载器一致；该含凭证文件会被加入
`<workspace>/.codebuddy/.gitignore`。仅当目标路径已存在于 reporter 的 workspace bindings 中时，
才接受 workspace 级下发。若同一模型 ID 已由用户配置，则保留用户条目。
Claude 侧会生成独立配置 `~/.claude/teamai-models.json`；仅当不存在冲突的用户 Anthropic 网关配置时，
才把网关环境变量写入默认 settings。冲突检测会**同时**检查 `~/.claude/settings.json` 的 `env` 和当前进程的
shell 环境变量（`export ANTHROPIC_*`），因此通过 shell 环境变量使用 Claude 的用户会保留自己的网关——
TeamAI 跳过写入，并把跳过的 key 记入 `~/.teamai/reporter/errors.jsonl`。受保护的 key 包括
`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`、
`ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}` 以及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`。
若某个 shell 值与 TeamAI 上次写入的值一致（Claude 会把 `settings.json` 的 `env` 回注到 hook 进程），
则识别为托管值而非用户冲突，因此后续同步仍可更新或删除托管网关。不支持的 agent 会回执失败，不会误写其他
agent 的配置。用户配置文件是符号链接时会保留链接。以上含凭证文件权限均为 `0600`。落盘成功后以
`type: "apply_model_config"` 回执；非法 payload 回执 `failed`。未来未知任务类型会静默跳过，以保持协议向后兼容。

反向的模型上报走已有的 `report` 接口：仅上报 TeamAI manifest 已记录、且磁盘上的模型 ID 和
provider 仍可识别的模型，用户级放在 `user_level.models`，workspace 级放在对应的
`workspaces[].models`。agent 正常补充元数据不会导致漏报；
模型落盘成功后会在同一次 sync 中立即补一次 report，无需等待下一次 session。用户自有模型不上报，
因为后台无法识别。服务端要求 `provider` 与 `model_id` 同时存在。与 skills/rules 一致，没有任何符合条件的
模型时该字段整体省略——因为存在的数组会被当作全量快照。CodeBuddy、WorkBuddy 和 Claude
（`~/.claude/settings.json` 里的 `ANTHROPIC_CUSTOM_MODEL_OPTION` 网关）有可发现的模型配置，
其余工具不上报。上报条目的 `source` 固定为 `enterprise`。
**`api_key` 不会被回传** —— ProxyToken 只留在本地磁盘。

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

HTTP 契约用于自建集成。普通用户只需使用[成员接入](#成员接入)中的 `teamai init --http` 命令。

### 代码知识图谱

`teamai import` 将源码仓库解析为结构化知识图谱（存储在团队仓库的 `teamwiki/` 目录下），实现结构感知的知识检索：

```bash
# 从本地目录提取
teamai import --dir /path/to/project

# 从远程仓库导入
teamai import --from-repo https://github.com/org/repo

# 批量导入组织下所有仓库
teamai import --from-org myorg

# 从白名单批量导入
teamai import --from-repo-list repos.yaml

# 从已合并的 MR/PR 提取经验
teamai import --from-mr https://github.com/org/repo/pull/123

# 增量模式（跳过未变更文件）
teamai import --from-repo https://github.com/org/repo --incremental

# 仅提取结构，跳过 AI 增强
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

如果核心知识图谱提取或写入失败，导入会报错，且不会将该提交标记为已同步。下次增量导入会重试该提交。

需要 AI 的步骤（`--deep-enrich`、知识增强）复用本机已安装的 AI 编码 CLI，而不是直接调用模型 API。teamai 按 `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` 的顺序探测，取第一个可用者。macOS / Linux 上探测经由 login shell，因此装在 `~/.nvm/` 下的 CLI 也能找到；Windows 上改用原生命令 `where`，拿到的是 Windows 真正能启动的 npm shim（`%APPDATA%\npm\claude.cmd`）——Git Bash 或 WSL 的 `bash` 只会返回 `/c/Users/...` 这类 MSYS 路径，Windows 无法启动。

对于 API 网关后的 GitLab，先设置 `GITLAB_URL` 和 `GITLAB_API_PREFIX=api/gitlab`，再运行 `teamai import --from-org https://gitlab.example.com/myorg`。组织仓库列表的每一页请求都会使用配置的前缀；未设置或为空时默认使用 `api/v4`。

图谱存储组件、接口、配置和跨仓库依赖关系。`teamai recall` 利用图谱进行 BM25 + graph-boost 增强排名。

依赖边由两条并行轨道提取：WASM tree-sitter **AST 轨**（TypeScript/JavaScript、Python、Go），将 import、调用、以及 TS `implements` 子句解析为精确的文件到文件边（`code-ast`）；以及正则 **启发式轨**（所有语言，`code-heuristic`），同时覆盖 AST 轨未支持的语言。重叠时 AST 结果优先。AST 解析器无需原生编译工具链；加载失败时提取会降级到启发式并记录一条 `AST_UNAVAILABLE` gap。设置 `TEAMAI_SKIP_AST=1` 可强制仅用启发式提取。

```bash
# 从本地仓库提取代码事实与图谱（写入 <repo>/teamwiki/）
teamai codebase --extract /path/to/repo --project my-service

# 增量刷新：复用首次提取的仓库路径和项目名
teamai codebase --extract /path/to/repo --project my-service --incremental

# 从已提取的 evidence 生成深度知识文档（--output 指向仓库根目录）
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# 将 teamwiki/product 和 teamwiki/docs 与提取的代码页面进行对账
teamai codebase --reconcile --output /path/to/repo

# 检查本地提取的图谱；--output 指向仓库根目录，而非 teamwiki/
teamai codebase --lint --output /path/to/repo
```

只要 extract 发现了组件，就会写入 `teamwiki/evidence/code/<project>/_manifest.json`（包括跳过 AI 增强或增强没有产出的情况），因此 `--deep-enrich` 可以接着跑。

### Dashboard

```bash
teamai dashboard             # 启动 Web 面板（默认端口 3721）
teamai dashboard --port 8080
```

侧栏包含 **Overview（总览）**、**Team Execution（团队执行）**、**Team Context（团队上下文）**、**Team Improvement（团队改进）**。总览汇总三模块；执行页展示本机会话，支持工作目录和 AI 工具筛选及完整详情；上下文页保留 KB Health（含作者贡献和从未召回条目）；改进页保留本机趋势及晋升、归档、质量更新维护命令。命令需在终端使用，页面不执行维护操作。

页头支持英文/简体中文及日间/夜间/跟随系统主题，浏览器存储可用时记住偏好。用户输入、AI 输出、知识标题和命令保持原文。独立 `/kb-report` 继续提供原有完整报告。

实时状态仅限**本机**，沿用事件流与 SSE，支持自动重连并轮询校准会话状态。最近结束会话仍按原有 30 秒保留窗口展示。知识报告显示本机/团队来源及报告生成时间，**不将其称为团队同步时间或跨成员实时状态**。刷新失败时明确提示，并保留上一次成功结果供参考。

#### 人工干预指标（Human Intervention）

每个会话行显示**人工干预次数**，悬停或打开详情可查看分类明细，三类信号各计一次：

| 类型 | 含义 | 数据来源 |
|------|------|----------|
| `interrupt` | 用户在 agent 执行中途按 ESC 打断 | transcript 中被中断的 turn |
| `toolReject` | 用户拒绝某个工具调用（permission deny） | transcript 中标记拒绝的 tool_result |
| `correction` | agent stop 后 60s 内用户追加含「不对 / 重来 / 错了 / wrong / redo / 違う / やり直し」等纠偏词（内置中、英、日，外加团队自定义词）的 prompt | stop → prompt_submit 事件模式 |

> 隐私：团队共享的干预统计仅含计数。本机 dashboard 事件流可保存经密钥脱敏且最长 200 个字符的输入摘要与 AI 输出用于详情展示；`~/.teamai/debug.log` 会记录相同的脱敏输入摘要。页面不会上传这些内容。

以空格分词的文字（英语、西班牙语等）中的纠偏词必须整词匹配，因此西班牙语 "segundo" 不会被算作 `undo`；中文、日文纠偏词仍按子串匹配。内置列表只覆盖中、英、日三种语言，其他语言的纠偏在团队于 `teamai.yaml` 添加自己的词之前不会被识别。团队词与内置列表合并，忽略大小写，遵循同样的匹配规则：

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, deshaz, "no era eso", "otra vez"]
```

匹配在 `UserPromptSubmit` hook 捕获 prompt 时完成，因此修改团队纠偏词后，下一次 `teamai pull` 之后的新 prompt 才会生效；之前记录的会话不会重新评估。

匹配时，prompt 和纠偏词都会转换为 Unicode NFC 形式。例如，`réessaye` 可以匹配 `re\u0301essaye`，其中 `\u0301` 是组合尖音符。重音符号仍有区别，因此 `reessaye` 不匹配。规范化仅用于匹配，不会改变 60 秒的纠偏时间窗口。纠偏检测在内存中使用原始 prompt，随后丢弃原文；本机仅保存经密钥脱敏且最长 200 个字符的摘要。

干预数据会随 `teamai pull` 自动聚合上报到团队 `stats/<user>.yaml`，并在 `teamai digest` 的「会话自主性」榜单中给出团队均值与人均干预率排行，可用于验证某个 skill / rule 上线后干预率是否下降。无 transcript 的工具（如 Cursor）会优雅降级，只统计 `correction`。

#### 对话量与 Token 用量

每个会话行还显示以下两列；详情保留经密钥脱敏的输入摘要、Markdown AI 输出、时间戳和最近工具：

| 列 | 含义 | 数据来源 |
|------|------|----------|
| 对话轮数 | 该会话里**人类对话的轮数**（发了几次 prompt） | `UserPromptSubmit` 事件数 |
| Token | 该会话累计 **token 用量**（鼠标悬停看 输入 / 输出 / 缓存读 / 缓存写 明细） | Claude Code `message.usage`、CodeBuddy `requests[].usage`，或 Codex 最新的会话级 `token_usage_record`；旧版 `event_msg.token_count` 按 rollout 文件各取最新快照后累加 |

> 隐私：团队共享的轮数和 Token 指标仅含计数。Dashboard 详情中的脱敏输入摘要和输出保留在本机。

这两项同样随 `teamai pull` 聚合到 `stats/<user>.yaml`（`prompts` 与 `tokens` 字段），并在 `teamai digest` 的「对话量与 Token 用量」板块给出团队对话总轮数、token 总量（分桶）与人均 token 用量排行。拿不到 transcript 的工具（如 Cursor）会优雅降级：仍统计对话轮数，token 显示为 0 / N/A。

#### 每日会话趋势与估算成本

Dashboard 和 digest 会比较最近 7 个 UTC 自然日与此前 7 天。Dashboard 费用卡片改为**有定价数据会话的平均已知估算费用**：先筛选首次 Stop 落在该窗口的会话，汇总这些会话已知的已定价请求费用，再除以其中至少有一个已定价请求的会话数。无定价数据的会话不进分母；已定价且费用为零的会话计入。卡片展示定价覆盖数。恢复执行的会话仍归属首次 Stop 日期，其他日期的已知请求费用也计入该会话。原有 `avgRequestCostMicros` 接口字段和 digest 按请求日期统计的口径不变。会话归属到首次 stop 事件所在日期，每个已定价请求则归属到请求自身的 UTC 日期；活跃时长只累计不超过 5 分钟的相邻事件间隔，避免终端空闲时间把数据放大。会话结束时没有错误、中断或纠偏才计为成功；被拒绝的工具调用仍作为独立干预信号统计。仅包含模型、token 数、估算成本和价格表版本的请求明细保存在本地 `~/.teamai/dashboard/requests.jsonl`，不包含提示词或回复内容；重复 Stop 不会重复写入，超过 90 天会自动清理。

成本是 API 等价估算值：对可识别的 Claude 模型，根据带版本的公开目录价，以及 transcript 中的输入、输出、缓存读取和缓存写入 token 分桶计算。由于 transcript 不提供缓存 TTL，缓存写入按 5 分钟费率估算。未知模型以及无法取得详细用量的工具不会进入估算成本，也不会进入成本覆盖率分母。该数据适合观察趋势，但不等同于账单或订阅席位费用。

每日聚合会在 `teamai pull` 时写入 `stats/<user>.yaml`；原有累计字段继续作为历史总量展示。恢复执行的会话会在原记录上更新，不会重复累计已完成会话。团队仓库只接收聚合计数和按微美元保存的估算总额；prompt 原文与逐请求记录保留在本机。

### Session Save（会话存档）

`teamai session save` 把 dashboard 已有的**单次会话事件流**（工具调用序列、prompt 轮次、干预记录）折叠成一份精简、脱敏的 markdown 摘要——不调用 LLM，也不新增采集路径。

```bash
teamai session save                    # 存档最近一次会话（本地）
teamai session save --session-id <id>  # 存档指定会话
teamai session save --push             # 把「有价值」的会话推送到团队仓库
teamai session save --push --force     # 即便是琐碎会话也推送
teamai session save --push --include-prompt  # 额外带上（脱敏后的）首个 prompt 行
```

**本地（始终执行）：** 追加到 `~/.teamai/session-logs/<年-月>.md`。按会话幂等（当月已记录的会话会跳过），且超过 90 天的日志会自动清理。

**团队（`--push`，需显式开启）：** 直接提交（不走 PR）到 `teamai-reports` 分支的 `sessions/<user>/<年-月>.md`——正是 `teamai digest` 读取的路径，于是该会话会出现在 **Session Highlights** 板块。默认只推送**有价值**的会话：出现摩擦（interrupt / tool-reject / correction）或工具使用充分（≥ 3 种不同工具）。琐碎会话除非加 `--force`，否则只留本地。对只读（HTTP 模式）的团队，`--push` 会优雅失败并保留本地日志。

> 隐私：推送到团队的内容默认**只含计数 + 工具名**。首个 prompt 行需通过 `--include-prompt` 显式开启，且即便开启也会经过与别处一致的密钥脱敏（`ghp_…` → `<REDACTED:…>`）。本地日志因为不出本机，会保留脱敏后的首个 prompt 行。

### Hooks

`teamai init` 自动注入的 Hooks：

| Hook 事件 | 操作 |
|-----------|------|
| `SessionStart` | 先为当前 Agent 创建项目根目录（project scope），再自动 pull + 上报会话启动 |
| `PostToolUse` | skill 追踪 + 知识贡献检测 + dashboard 上报 |
| `UserPromptSubmit` | slash 命令追踪 |
| `Stop` | CLI 更新检查 + 上报会话结束 |

```bash
teamai hooks list      # 查看生效的内置和团队 hooks
teamai hooks inject    # 重新注入
teamai hooks remove    # 移除
```

`hooks list` 按工具分别列出内置 hooks，因为各工具的集合并不相同：Copilot 额外有 `SessionEnd`，OMP 扩展覆盖四个事件且没有 `Skill` / `TodoWrite` matcher，OpenClaw 只映射 `SessionStart` + `UserPromptSubmit`，Hermes 只有 `SessionStart`。hook 注入流程不会为其安装任何内置 hook 的工具（如 JoyCode）不会列出；Kiro 也不列出——它的 `SessionStart` 由 agent 同步以 `hooks.agentSpawn` 形式内嵌，只存在于你实际同步过的 agent 中。

inject 和 remove 只会操作你实际已安装的工具（即 `~/.<tool>/` 根目录已存在的工具）。对于 `toolPaths` 中已配置但未安装的工具，命令不会为其凭空创建根目录。

在 Windows 上，经由 bash 执行的内置 hook 派发命令（如 Claude、Codex、Cursor、Copilot CLI）会以绝对路径引用 Git Bash——先查标准安装位置，再回退到 `HKLM\SOFTWARE\GitForWindows` 注册表——从而避免解析到 WSL 的 `bash.exe`；若找不到 Git Bash，则退回裸 `bash`。

> **Codex 信任门槛** — Codex（OpenAI / ChatGPT Codex 应用，工具 id 为 `codex`）对非托管 hooks 设有显式的用户信任机制。teamai 写入 `~/.codex/hooks.json` 后，对于新增或变更的 hook，Codex 可能会跳过执行，直到你在 `/hooks` 或 Settings → Hooks 中 review/trust。当检测到 Codex hooks 已安装时，`teamai hooks inject` 与 `teamai doctor` 会输出提示；teamai 从不修改 Codex 的 `[hooks.state]` 来自动信任 —— 信任操作交由你手动完成。

### 团队 Hooks 声明

团队可在仓库 `hooks/hooks.yaml` 中声明自定义 hooks，`teamai pull` 会自动分发到支持团队 Hooks 的适配器。Pi 目前仅支持 TeamAI 内置生命周期桥接；此文件中的自定义 Hooks 和内置 Hook 覆盖不会应用到 Pi。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]
    roles: [devops]                      # 可选；默认所有成员
    projects: [checkout]                 # 可选；默认所有目录

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 20 }
```

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，`^[a-z0-9-]+$` |
| `event` | Claude PascalCase 事件名（跨工具通用） |
| `matcher` | 可选，工具 matcher |
| `tools` | 可选，目标工具列表（默认 = 所有 hook 支持的工具） |
| `roles` | 可选，`manifest/roles.yaml` 中的角色 id 列表（默认 = 所有成员；`[]` = 无人）。在下方安全治理之前生效；切换角色后，原角色的 hooks 会在下一次 pull 时移除。旧版 teamai 会忽略该字段。 |
| `projects` | 可选，`manifest/projects.yaml` 中的项目 id 列表（默认 = 所有目录；`[]` = 无人）。匹配该目录通过 `teamai projects set` 绑定的项目；切换绑定后，原项目的 hooks 会在下一次 pull 时移除。与 `roles` 以 AND 组合。旧版 teamai 会忽略该字段。 |
| `builtin.disabled` | 禁用的内置 hook 列表 |
| `builtin.overrides` | 仅可覆盖内置 hook 的 `timeout` |

安全治理：
- `sharing.hooks.autoApply: false`（`teamai.yaml`）：pull 时仅提示，需手动 `teamai hooks inject` 确认
- `sharing.hooks.requireTeamScripts: true`：拒绝 command 不在 `~/.teamai/team-scripts/` 下的 hook
- `TEAMAI_HOOKS_DISABLED=1`：本地禁用所有团队 hooks（内置 hooks 不受影响）

### Agents 资源类型

团队仓库可在 `agents/` 目录下维护自定义 subagent 定义（每个 agent 一个 `*.yaml` 或旧格式 `*.md` 文件）。根目录文件对所有成员生效；一层子目录可按角色/项目划分 agents，规则与 `rules/<namespace>/` 相同：

```text
team-repo/
  agents/
    code-reviewer.md              # 团队自定义 subagent，所有人共享
    frontend/vr-reviewer.yaml     # 仅同步给 `agents:` 中列出 `frontend` 的角色/项目
    .removed                      # tombstone（由 teamai remove agents <name> 自动管理）
```

```yaml
# manifest/roles.yaml（manifest/projects.yaml 使用同一个 key）
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # 可选；省略 = 只同步根目录 agents
```

真正生效的 namespace（`knowledge`、`skills`、`agents`）都会成为目录名，因此必须是
单个路径片段：不含 `/`、`\`、`:` 和控制字符，结尾不能是 `.` 或空格，也不能是
Windows 设备名，且同一资源类型下的两个 namespace 不能仅有大小写差异；`manifest/roles.yaml`
与 `manifest/projects.yaml` 规则一致，且两者之间也做该校验。role 的
`learnings:` 仅为向后兼容而保留、运行时忽略（learnings 按 project 而非 role 划分
namespace），不会成为目录名，因此不做校验。

`teamai pull` 会将它们按文件名拍平复制到每个 Tier-1 工具的 `agents/` 目录（如 `~/.claude/agents/`），因此两个活跃 namespace 不能定义同名 agent（pull 会报告冲突并跳过该 scope）。`teamai pull` 为 Codex 系工具写入 `<name>.toml`，为 Kiro 写入 `<name>.json`，为 Copilot 写入 `<name>.agent.md`，其余工具写入 `<name>.md`。成员切换角色后，不再活跃的 namespace 中的 agents 会在下一次 pull 时被移除；若本地副本已被手动修改，则保留并给出警告。未配置角色时同步全部 agents。`teamai push` 使用与 pull 相同的活跃角色和项目 namespace 来确定源文件，并将修改写回该源文件；若存在多个候选目标，则跳过并给出警告。若源文件均不活跃，也会跳过。跳过的 agent 不会阻止同一次 push 中的其他资源。新 agent 与新 skill 一样需要确定落点：`--role <ns>` 或 `--project <id>`（该项目的 `agents` namespace）指定目录；两者都不给时，从主角色的 `agents` namespace 解析。只有在解析不出任何 namespace 时才留在共享根目录（此时全员都会收到），并且 push 会给出警告（见[推送本地资源](#推送本地资源)）。清理会逐个工具检查 YAML 的 `targets` 和旧格式支持；只有活跃的同名 agent 会写入该工具的同一输出文件时，才保留该文件。`teamai remove agents <name>` 会记录 tombstone。带 namespace 的 agent 可写作 `<namespace>/<name>`；只有一个 namespace 拥有的简名会解析到该 agent；若简名出现在多个位置，命令会列出完整名称并拒绝执行，而不是从所有位置删除。其他机器下一次 pull 时，会从每个同步中的工具的 agents 目录删除 `<name>.agent.md`、`<name>.md`、`<name>.toml` 和 `<name>.json`。即使该次 pull 发现团队仓库没有变化，也会执行清理。删除带 namespace 的 agent 只记录 `<namespace>/<name>` 的 tombstone，其他 namespace 中的同名 agent 不受影响；当该副本可能属于这个 agent（该 namespace 对成员活跃，或由其本机放置）且成员的目录没有从另一个活跃 namespace 收到同名 agent 时，其拍平后的 `<name>` 副本会被清理，也不会再被推送。从未启用该 namespace 的成员会保留自己的同名 agent。CLI 内置的 `teamai-recall` 配置与团队 agents 并列部署，但不会被 `teamai push` 上传。

### GitHub Copilot CLI

GitHub Copilot CLI 已支持其官方自定义指令、Rules、Skills、自定义 Agent、Hooks 和 MCP 配置面，以及 TeamAI Docs 和 Env 下发：

- **作用域。** 用户资源位于 `$COPILOT_HOME`（默认 `~/.copilot`）下，项目资源位于 `<project>/.github` 下。TeamAI 在检测以及所有用户级读写中都会遵循 `COPILOT_HOME`。
- **Skills。** `teamai pull` 将用户级 Skills 写入 `$COPILOT_HOME/skills/`，将项目级 Skills 写入 `.github/skills/`；任一作用域中的修改都可像其他 TeamAI Skills 一样被 `teamai push` 检测。
- **自定义指令。** TeamAI 将团队文化和共享指令注入用户级 `$COPILOT_HOME/copilot-instructions.md` 或项目级 `.github/copilot-instructions.md`。TeamAI 标记包围的区块会被幂等替换，标记之外的文字归用户所有。`teamai uninstall` 只移除 TeamAI 管理的区块。
- **Rules。** 团队 Rules 会转换为 `$COPILOT_HOME/instructions/` 或 `.github/instructions/` 下的原生 `*.instructions.md` 文件。TeamAI 从团队 Rule 的 `paths` 派生 Copilot 必需的 `applyTo` frontmatter；没有 `paths` 时使用 `**`。Push 时只有 Markdown 正文回流，团队拥有的 `paths` 元数据保持不变。未知的 Copilot instructions 文件属于用户，不会被上传或删除。
- **自定义 Agents。** 团队 Agents 会转换为 `$COPILOT_HOME/agents/` 或 `.github/agents/` 下的官方 `<name>.agent.md` 配置。TeamAI 将兼容的工具名映射为 Copilot 主别名，通过 `tool_extras.copilot` 保留 Copilot 专属 frontmatter，并且只删除与团队 Agent 或内置 recall 配置匹配的文件；用户自建配置保持不变。详见 [GitHub 自定义 Agent 配置](https://docs.github.com/zh/copilot/reference/custom-agents-configuration)。
- **Team Context recall。** 内置 `teamai-recall.agent.md` 只获得 `execute`、`read` 和 `search`。它调用现有的 `teamai recall` 流程，让 Copilot 检索 learnings、codebase 证据和 teamwiki 结果，而不会复制或创建第二套知识库。
- **Docs 和 Env。** 团队 Docs 同步到配置的本地文档目录（默认 `~/.teamai/docs`；project scope 使用项目内对应路径）。团队环境变量同步到该作用域由 TeamAI 管理的 `env.sh`；请从已 source 此文件的 shell 启动 Copilot。TeamAI 不会把环境变量值复制到 Copilot 配置中。
- **Hooks 与隐私遥测。** TeamAI 在 `$COPILOT_HOME/hooks/teamai.json` 或 `.github/hooks/teamai.json` 写入独立的 version-1 Hook 文件，使用 Copilot 与 VS Code 兼容的 PascalCase 事件（`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` 和 `SessionEnd`），从而保留 TeamAI 所需的 snake_case Hook 负载字段，并生成 `bash`、`powershell` 和后备 `command` 字段。会话 ID、Skill 使用、提示次数、生命周期状态和最终 Token 总数会进入本地 Dashboard；Copilot 提示原文、助手输出、Transcript 路径和请求元数据绝不会被保存。若最终 Token 计数不可用，会话仍会被记录，但不包含 Token 数据。对于恢复的会话，TeamAI 在 SessionStart 时保存不含路径的日志字节边界；只有此前的运行标记尚未关闭、且未被上次运行使用时，才会采纳该标记。关闭计数必须关联这个标记或边界之后写入的标记。若标记仅在 SessionStart 之后出现，而 SessionEnd 没有提供方时间戳，则无法确认它属于本次运行；会话仍会被记录，但不包含 Token 数据。文件会被幂等合并，且保留无关条目。TeamAI 从不修改 Copilot 的 `settings.json`。
- **MCP。** `teamai pull` 和 `teamai mcp inject` 使用 Copilot 原生结构，把本地与远程 Server 合并到 `$COPILOT_HOME/mcp-config.json` 或 `.github/mcp.json`。归属信息保存在 Copilot 文件之外，因此重复 pull 保持幂等，`mcp remove` 或卸载只会移除 TeamAI 管理的条目；手写 Server 与 `settings.json` 均保持不变。

团队 Hooks 仍以团队仓库中的 `hooks/hooks.yaml` 为来源：直接编辑该文件，再使用正常的 pull/push 流程。TeamAI 不会从 Copilot 配置文件反向导入任意原生 Hook 条目。

### OpenCode

[OpenCode](https://opencode.ai) 已作为一等工具支持。由于它的配置布局与 Claude 系不同，teamai 对以下几点做了特殊处理：

- **作用域。** OpenCode 的用户配置在 `~/.config/opencode/` 下，项目配置在 `<project>/.opencode/` 下——前缀与其他所有工具都不同。teamai 会按 `--scope` 写入正确的位置，且仅在该作用域确实安装了 OpenCode 时才碰它的文件（绝不会为未使用 OpenCode 的用户创建 `~/.config/opencode/`）。Hooks 是唯一的例外——始终写在用户级，原因见下。
- **Skills** 落在 `.opencode/skills/`（项目）或 `~/.config/opencode/skills/`（用户）。OpenCode 也原生读取 `.claude/skills`，但 teamai 仍会写 OpenCode 路径，好让只用 OpenCode 的用户也能拿到。
- **Subagents** 会被渲染成 OpenCode 自己的 `agents/*.md` 格式：frontmatter 带 `description` + `mode: subagent`（以及 `model` 和 `tool_extras.opencode` 中的字段，如 `temperature`）；agent 名取自文件名。OpenCode **不**读取 `.claude/agents`，因此这份原生副本是必需的。
- **Rules** 会被复制到 `.opencode/rules/`（或 `~/.config/opencode/rules/`），但 OpenCode 不会自动扫描 rules 目录——文件在被引用前是惰性的。因此 teamai 会往 `opencode.json` 的 `instructions` 数组里加一条 `rules/*.md` glob，并在团队最后一条 rule 消失时再把它移除，且只编辑这一个键、不动你自己的 `instructions` 条目。
- **Hooks** 以 OpenCode *plugin* 形式交付，而非配置文件条目——OpenCode 没有 `hooks` 数组，它会**同时**加载 `~/.config/opencode/plugin/` 和 `<project>/.opencode/plugin/` 下的 JS/TS 插件。两个目录都有插件时会被加载两次，每个事件也就派发两次，因此 teamai 只保留一份：写在用户目录的 `teamai-hooks.ts`，覆盖所有项目；早期布局残留的项目级副本会在下次同步时被删除。这与其他工具一致——它们的 `settings.json` hooks 同样放在 HOME，靠传给 `hook-dispatch` 的 `cwd` 做作用域判断。插件订阅 OpenCode 自己的事件，并 shell 到其他所有工具共用的 `teamai hook-dispatch` 入口。事件映射对齐 Claude 内置集合：`session.created` → session-start、`session.idle` → stop、`chat.message` → prompt-submit、`tool.execute.after` → post-tool-use。插件会转发与其他工具一致的 STDIN 负载（`cwd`、`tool_name`、`tool_input`、`prompt`），并把 OpenCode 的小写工具 id（`skill`、`todowrite`）映射回 handler 注册表期望的 PascalCase matcher。OpenCode 无法把 hook 的 stdout 回注到会话，因此 hooks 只为副作用运行（状态上报 / 同步 / 更新）。注意 OpenCode 会 **await** 它的具名 hook（`chat.message`、`tool.execute.after`），所以这两个事件的派发会短暂等待 `teamai` 子进程后 agent 才继续；错误始终被吞掉，hook 永远不会让会话失败。服务端下发的 agent hook（`teamai-agent-<slug>.ts`）同样装在这个用户级 plugin 目录下。
- **MCP** server 位于共享 `opencode.json` 的 `mcp` 键下（详见上文 MCP 章节）。

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 通过其公开的 Skills、指令文件和扩展机制接入：

- **作用域。** 项目级 Skills 和 TeamAI 管理的 Rules 写入 `.pi/skills/`、`.pi/rules/`；用户级副本写入 `~/.pi/agent/skills/`、`~/.pi/agent/rules/`。
- **指令文件。** 项目级使用 `AGENTS.md`，用户级使用 `~/.pi/agent/AGENTS.md`。Pi 也接受项目级 `CLAUDE.md`，但 TeamAI 将规范的 TeamAI 区块保留在 `AGENTS.md`。
- **Hooks。** TeamAI 只在用户级 `~/.pi/agent/extensions/` 生成一份 `teamai-hooks.ts`，把 `session_start` 映射为 session-start、`before_agent_start` 映射为 prompt-submit、`agent_settled` 映射为 stop；`tool_execution_start` 缓存工具输入，`tool_execution_end` 派发 post-tool-use 时把缓存的输入转发为 `tool_input`（不带单独的结果/输出字段，与 OMP 适配器的 post-tool-use payload 一致）。Pi 会同时加载用户级与项目级扩展目录，因此 TeamAI 不创建项目副本——第二份副本会导致每个事件被派发两次，这与 OMP 适配器的单副本策略一致。早期版本遗留且带 TeamAI 标记的项目副本会在下次同步时移除，注入逻辑也不会覆盖没有 TeamAI 标记的同名文件。Pi 没有可供 self mode 提交的设置文件，所以 fresh clone 仍需在该机器上手动跑一次 `teamai init`/`pull` 才能激活 Pi hooks。任何一次显式移除——`teamai hooks remove`，或者某个 scope 下的 `teamai uninstall --agent pi`——都会直接删除这份共享扩展，和 OMP 适配器的单文件删除语义完全一致：Pi 没有办法把一份共享文件限定在某一个项目里，所以不会假装"为其他项目保留"却让这份扩展继续对当前项目触发；没有 TeamAI 标记的同名文件不会被删除。`teamai hooks list` 始终显示这个全局路径。Pi 的 profile 覆盖项（`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）暂不支持，与 OMP 适配器一致，使用默认的 `~/.pi/agent/` 布局。由于这份扩展是机器级共享的单个文件而非按项目隔离，某个 scope 下的移除在多项目场景中并不持久：只要 Pi 在其他任意 scope 仍处于启用状态，下一次在那里执行 `teamai init`/`pull` 就会把它重新生成，而 hook 派发本身没有按项目排除的检查，因此刚被卸载的项目里 hooks 仍可能重新触发。这与 OMP 适配器早已上线的取舍完全一致。
- **团队 Hooks 边界。** Pi 适配器只安装内置生命周期桥接。`hooks/hooks.yaml` 声明的自定义团队 Hooks 和内置 Hook 覆盖会被跳过并给出警告。完整团队 Hooks 与逐项目归属语义需要单独的跨适配器设计，留待后续 PR。
- **服务端下发的 Agent Hooks。** HTTP source hooks 会以同一用户级扩展目录中的 `teamai-agent-<slug>.ts` 形式安装。不支持的生命周期事件会警告并跳过。
- **MCP 与 Subagents。** 本阶段没有为 Pi 接入 MCP 或 TeamAI 自定义 subagent 文件适配器。

### Qoder

Qoder 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.qoder/skills/`、`.qoder/rules/` 和 `.qoder/agents/`。Hooks 与 MCP Server 会合并进对应作用域的 `.qoder/settings.json`，并保留用户已有的其他设置；这些路径与 Qoder 的用户级和项目级配置约定一致。

Qoder CN 是独立发行的版本，其**用户级**目录为 `~/.qoder-cn` 而非 `~/.qoder`，因此它作为独立的内置目标 `qoder-cn` 支持，而不是并入 `qoder`。两者仅用户作用域不同：用户级的资源写入 `~/.qoder-cn/{skills,rules,agents}`，Hooks 与 MCP 写入 `~/.qoder-cn/settings.json`；项目作用域则沿用 Qoder 的 `<project>/.qoder/` 布局。两者读取相同的 Claude 兼容资源格式，因此下发内容一致，仅用户级根目录不同。同时安装两个版本时，TeamAI 会分别同步到各自的用户目录，无需再建软链接。

### Kiro

Kiro 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.kiro/skills/`、`.kiro/steering/` 和 `.kiro/agents/`，与 Kiro 官方文档定义的[工作区 Skills](https://kiro.dev/docs/skills/)、[Steering](https://kiro.dev/docs/steering/)和自定义 agents 布局一致。Subagents 渲染为 Kiro CLI 2.x 与 3.x 都支持的 JSON；每个文件都会保留 Kiro 私有字段和自定义 Hooks，并加入 TeamAI 管理的 `hooks.agentSpawn` 命令，在交互式 CLI 会话激活该自定义 agent 时派发 `session-start`。这一经验证的 CLI 2.x Hook 内嵌在 `.kiro/agents/*.json`，而不是写入 IDE 1.x / CLI 3.x 引入的独立 `.kiro/hooks/`；Kiro 内存中的内置默认 agent 无法修改，`--no-interactive` 也不会触发 `agentSpawn`。MCP Server 会合并进对应作用域的 `.kiro/settings/mcp.json`（见上文 MCP 章节）。

### ZCode

ZCode 已作为内置目标支持。Skills 下发到 `.zcode/skills/`（ZCode 同时会读取中央目录 `~/.agents/skills/`，该目录由 `agents` 条目覆盖），Subagents 以 Claude 风格 Markdown 下发到 `.zcode/agents/`。Hooks 会合并进共享的 `~/.zcode/cli/config.json`，并保留插件状态等无关键值。写入器为你处理了两个 ZCode 特有的细节：

- ZCode 的配置文件钩子**默认禁用**——TeamAI 会强制置 `hooks.enabled: true`，确保写入的条目真正生效。
- Windows 上，钩子条目通过隐藏的 **wscript VBS 启动器**执行（`wscript.exe <teamai-hook-dispatch.vbs> <分发命令尾段>`）：wscript 属 GUI 子系统，钩子运行绝不弹控制台黑框；启动器把 STDIN 暂存为临时文件再转发，保证 payload 完整到达 `hook-dispatch`。超时按事件放宽（会话启动 180 秒、stop / prompt 提交 60 秒、工具调用后 30 秒），避免会话启动时携带仓库拉取的分发被中途掐断。含多字节文本（如中文）的 payload 在启动器的 ANSI 代码页暂存环节可能降级——身份字段会被抢救，降级分发仍能正确关联到会话；卸载时会同时清除条目与脚本文件。
- POSIX 上条目就是普通的 `bash -lc <分发命令尾段>` argv 向量，不写入启动器；两个平台上，命令尾段都以 argv 末位元素原样存储——这正是托管条目识别与托管清单比对的依据。

以上路径已对照 ZCode 桌面端实测验证：设置页「新建子智能体」写入的就是 `~/.zcode/agents/*.md`，反向放入的文件也会出现在页面的已安装列表中。MCP Server 下发到 `~/.agents/mcp.json`（用户级，Claude 的 `mcpServers` 结构——正是 ZCode 自己的 MCP 设置页读取的文件）。项目级暂未接入：ZCode 的工作区 MCP 使用不同的键（`.zcode/config.json` 内的 `mcp.servers`），Claude 写入器无法生成该结构。ZCode 暂无用户级 Rules 目录约定，因此 Rules 不同步。

### Oh My Pi

Oh My Pi（OMP）已作为内置目标支持。TeamAI 将 Skills、Rules 和 Subagents 下发到 OMP 的原生目录——项目级为 `.omp/skills/`、`.omp/rules/` 和 `.omp/agents/`，用户级为 `~/.omp/agent/skills/`、`~/.omp/agent/rules/` 和 `~/.omp/agent/agents/`（用户级资源位于 agent 目录 `~/.omp/agent/` 下，与项目级前缀不同，TeamAI 会随作用域自动切换）。指令（`claudemd`）下发到对应的 `AGENTS.md`；MCP Server 合并进 `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json`（Claude `mcpServers` 结构，见上文 MCP 章节）。Skills 采用一层 `<name>/SKILL.md` 目录结构，TeamAI 在同步时补全 `description`——OMP 原生 skill 发现要求该字段。以上路径遵循 OMP 官方文档的发现布局（对照 OMP 18.2.5 验证）。Hooks 走 OMP 的 extension runner：`teamai pull` 会生成唯一的 extension 写入 `~/.omp/agent/extensions/teamai-hooks.ts`（绝不写项目副本——OMP 会同时加载两个根并导致每个事件双派发），它把 OMP 的 `session_start` / `session_stop` / `before_agent_start` / `tool_result` 事件转发给所有 agent 共用的 `teamai hook-dispatch` 入口，并按会话 `cwd` 做项目门控。`session_stop` 处理器不返回任何值，分发绝不会强制会话继续；由于 OMP 的工具名是小写（`bash`、`read` 等）且没有 `Skill` / `TodoWrite` 工具，post-tool-use 不做 matcher 定向分发。`teamai uninstall` 会移除该 extension。OMP 的 profile（`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）暂不支持，使用默认的 `~/.omp/agent/` 布局。

### DeepSeek Harness

DeepSeek Harness（`dsh`）支持 TeamAI Skills 和共享资源。DSH 官方的 Claude Hook Bridge 是通过 profile 插件加载的，并不是设置文件中的 Hooks；因此检测到用户级 `~/.dsh/` 安装后，`teamai init`、`teamai pull` 或 `teamai hooks inject` 会在 `~/.teamai/dsh/` 下生成兼容 Claude 的 Hook 配置和 Cordis patch。

TeamAI 会打印带绝对路径的 patch。将这个 `--patch` 参数加到启动 DSH profile 的命令中，例如 `dsh tui --patch "<打印出的路径>"`。这是一次性的启动器选择；`teamai hooks remove` 和 `teamai uninstall` 会移除 TeamAI patch，同时保留生成配置中的其他 Hook 条目。

### JoyCode

JoyCode 已作为内置目标支持。Skills、Rules 和 Subagents 分别下发到 `.joycode/skills/`、`.joycode/rules/` 和 `.joycode/agents/`。Rules 使用与 Cursor 兼容的 `.mdc` 格式，包括下文所述的派生 frontmatter 和仅正文往返同步；Subagents 使用带 YAML frontmatter 的 Markdown 文件。

JoyCode 规则清理采用保守策略：不在团队规则列表中的本地 `.mdc` 和 `.md` 文件会被保留，只有团队明确记录了删除标记（tombstone）才会清理。这能保护同一目录中的个人规则；缺少删除记录的旧团队副本也会保留，不会猜测其已过期。

对于以 YAML 保存的团队 Agent，push 会将本地文件与对应工具的渲染结果比较，只将真实编辑合并回原始配置。部署范围 `targets`、其他工具的元数据，以及本地格式未输出的字段都会保留。遇到冲突或无法解析的编辑时跳过回写，不会替换团队源文件。

**Hooks 与手动同步**：JoyCode 当前没有提供生命周期 Hooks 机制或专用启动适配器（无类似 `settings.json` hooks 数组或 `hooks.json` 的事件配置）。因此，打开或启动 JoyCode 不会触发 TeamAI 的 `SessionStart` 事件，无法进行后台自动拉取、使用指标上报（`teamai track`）或自动更新检测。JoyCode 用户需要通过在终端手动运行 `teamai pull` 来同步团队最新技能、规则与 Agent，通过 `teamai push` 贡献变更。若 JoyCode 后续版本提供了 Hooks 或插件生命周期机制，将通过专用适配器接入。

### Cursor

Cursor 的项目规则必须以 **`.mdc`** 文件形式放在 `.cursor/rules/` 下，且带 YAML frontmatter——放在那里的纯 `.md` 会被 Cursor 直接忽略。因此 teamai 向 Cursor 写规则时用 `<name>.mdc`（其他工具仍写纯 `.md`），并从团队规则派生 frontmatter：

- 带 `paths:` 列表的规则会转成 `globs: "<逗号拼接>"` + `alwaysApply: false`（上下文中有匹配文件时 Cursor 自动附加该规则）。值加引号是因为以 `*` 开头的 glob 不加引号时并非合法 YAML。
- 无 `paths` 的规则（团队强制规则）会转成 `alwaysApply: true`（每个 Cursor 会话都应用）。

两种格式之间只有 markdown 正文互通，各自的 frontmatter 归各自所有。`pull` 时 Cursor 的 frontmatter 由机器派生（正文原样拷贝，仅规范化首尾空行），因此 `pull` → `push` 往返不会被误判为内容变更。`push` 时，在 `.cursor/rules/*.mdc` 里改完正文再执行 `teamai push`，**只有正文**会回流上游——团队规则自己的 `paths:` frontmatter 会被保留，规则的作用域不会被悄悄丢掉。

有两类文件刻意**不会**从 Cursor 规则目录推送：

- 团队仓库中没有同名规则的 `.mdc`。`.cursor/rules/` 同时也是 Cursor 自带的 *New Cursor Rule* 命令写入个人规则的地方，teamai 不会把它们当作新的团队资源。
- CLI 内置规则——它们是被下发的（对 Cursor 同样写成 `.mdc`），而非同步而来。

从旧版本升级：旧布局写入的 `.cursor/rules/*.md` 是无效文件（Cursor 从未读取过它们），因此 `pull`、`remove`、`uninstall` 会连同 `.mdc` 一起删除。你自己放在那里的 `.md` 不受影响。

### 其他

```bash
teamai doctor          # 配置诊断
teamai doctor --json   # 同样的诊断结果，以 JSON 输出到 stdout（CI、hook、agent 可直接消费）
teamai stats           # skill 使用统计
teamai update --check  # 仅检查 CLI 更新，不安装
teamai update          # 检查并安装 CLI 更新
teamai digest          # 生成团队活动周报
teamai remove skills <name>   # 删除资源（需要确认）
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # 跳过确认，用于脚本和 CI
```

仅当所有检查通过时，`teamai doctor` 才以状态码 0 退出；任一检查失败时以状态码 1 退出。尚未初始化时，它只报告缺少配置，不会臆测 Git 托管平台。手动执行 `teamai pull` 结束时会运行同一批检查（不含托管平台相关的检查，也不含本次 pull 已经自行报告过的检查）。被标记为 informational 的检查——目前只有 `No stale env blocks left behind`——仍会计入 `doctor` 的退出码，但 pull 不会把它的失败并入 `Pull finished, but N check(s) failed`：早期安装留下的遗留文件属于清理事项，不代表这次 pull 弄坏了什么，因此依旧会被点名，只是单独用一行更轻的提示呈现。

除了托管平台、clone、配置和 hook 检查之外，`doctor` 还会验证落到本机上的内容。`<tool> is installed` 在 `enabledAgents` 列出了不会收到任何内容的工具时失败——这正是 pull 报告成功、而该工具什么都没收到的情况。它使用与同步相同的解析逻辑，因此像 OpenClaw 这样把 skills 放在 workspace 目录而非工具根目录的工具，会在同步真正写入的位置被判断。工具已安装时也会作为通过项报告，因此 `--json` 无论哪种情况都会为每个已启用工具给出一条记录。pull 结束时的检查只覆盖它从当前目录解析出的那个 scope；其他 scope 请在对应目录下运行 `teamai doctor`。`Skills delivered to <tool>` 会把角色命名空间、标签订阅与排除规则解析出的 skill 集合，与每个已安装工具磁盘上的内容比对：从未送达的 skill 与送达但不可读的 skill 会分别报告——后者指 `SKILL.md` 缺失、frontmatter 无法解析，或其 `name` 与目录名不一致，导致 agent 永远发现不了它。`Team docs delivered` 将 docs 包与 `sharing.docs.localDir` 比对（它只有一个目标目录，而非每个工具一个）；每个应有的文档都必须是可读取的文件，因此占用了该名字的目录或断链接也算缺失。

`Rules delivered to <tool>` 与 `Agents delivered to <tool>` 对另外两类按工具下发的资源做同样的事，并且都向 handler 询问落点，而不是自行拼路径：rule 的文件名和内容因工具而异（`.md` 原样、`.mdc` 带派生的 `globs`/`alwaysApply`、`.instructions.md` 带 `applyTo`），agent 的落点来自渲染结果，且由 `targets:` 决定哪些工具应当收到。已送达的 rule 会与 handler 为该工具渲染出的字节逐一比对，而不只是检查该工具所需的键是否存在：`globs` 与团队 rule 的 `paths:` 不再一致的 `.mdc`，即使 `alwaysApply` 取值合法，也会作用到错误的文件上；这里会报告为 `delivered from an older copy`——正文漂移的副本同样如此，因为两者都写入成功，却都是错的。agent 会与渲染结果逐字节比对：旧版 spec 留下的副本（普通 pull 会跳过团队仓库未变化的 scope，它可能一直留在那里）报告为 `delivered from an older spec`，而不是当作已送达。`Every team agent reaches a tool` 会指出在任何已安装工具上都无法渲染的 agent，通常是 spec 解析失败，或 `targets:` 只列了本机没有的工具。这两项仅在 `doctor` 中运行：它们会按工具读取每条 rule、解析每个 agent，放进 pull 结束时的检查会耗尽其时间预算。

有两个工具并不读取 rules 目录，按文件比对的检查无法代表它们，因此各自单列一项。`Team rules are active in opencode` 检查 `opencode.json` 的 `instructions` 中是否仍列着 teamai 所拥有的那条 glob：OpenCode 不会自动扫描 `.opencode/rules`，缺了它，已送达的每个 `.md` 都不会生效，而按文件比对的检查依旧通过。`Team rules are inlined in Hermes SOUL.md` 把 `SOUL.md` 中 teamai 管理的代码块与团队 rule 内联后的内容比对——Hermes 的常驻指令来自这一个文件而非某个目录，因此代码块被删除或停留在旧版规则集上，都意味着该工具读到的是错误的规则，而磁盘上看不出任何异常。

`MCP servers delivered to <tool>` 将团队 `mcp.yaml` 为该工具解析出的每个 server 与该工具自己配置文件中的条目逐一比对，并列出 reconcile 跳过的 server 及原因。比对的是条目内容而非名字：reconcile 不会覆盖不属于 teamai 的条目，因此你自己写的同名 server 会占住这个名字，团队的定义从未真正送达；过期的旧副本同样等于没送达。两者都报告为 `not the team's definition`，而覆盖非 teamai 写入的条目只有 `teamai pull --force` 能做到。未解析的 `${VAR}` 会在这里连同变量名一起报告——否则它只在 pull 时出现一次，之后再无提示。无法解析的 `mcp.yaml` 并不等于团队没有 MCP：它会作为 `Team MCP servers can be read` 连同解析错误一起报告，因为这种文件不会向任何工具注入内容，而且除第一次之外的每次运行都对此保持沉默。`Env variables injected in shell profile` 不再只查标记注释：它会检查 `env/env.yaml` 能否解析、以及是否在 `variables:` 键下声明了变量（写成普通的 `KEY: value` 映射等于没有声明；而显式写成 `variables: []` 属于没有内容要下发的配置，不会判为失败）、每个变量是否以 `env.yaml` 声明的值写进了 `env.sh`（残留的旧值会一直被导出到每个 shell 和 MCP server，直到下次 pull；比对时会用生成器自身的逆运算读回 `env.sh`，因此跨多行引用的多行值能够正确匹配，而不会被误判为过期），以及注入的代码块是否真的能加载它——未加引号的 Windows 路径在 POSIX shell 中会被转义破坏，`source` 从不执行，而且没有任何提示。`No stale env blocks left behind` 是独立的一项检查：pull 优先选用哪个文件会随时间变化（Windows 上 Git Bash 的登录 shell 读取的是 `.bash_profile`/`.bash_login`/`.profile`，从不读取 `.bashrc`），而 pull 只会新增代码块，从不迁移旧的，因此早期安装或平台变化留下的失效代码块可能一直留在另一个候选文件里。它会列出每一个这样的文件（检查 `.zshrc`、`.bashrc`、`.bash_profile`、`.bash_login` 和 `.profile`，新旧写法都算），并指向 `teamai uninstall` 来清除它们——这与投递检查分开进行，因此不会因为还留着一个旧副本，就让一个正常工作的 env 代码块被判成故障。

`Contributed learnings are published` 会在 `teamai contribute` 写下、但尚未推送成功的笔记仍在队列中时失败。当本次 pull 已经说过时，手动 `teamai pull` 结束时不会再重复它：pull 会尝试发布队列并自行报告结果，还会带上导致失败的推送错误——这是该检查本身给不出的信息。如果 pull 因为团队仓库刷新失败而根本没走到那一步，该检查会照常打印。

`--json` 把同一份报告作为单个对象打印到 stdout，并将所有日志改走 stderr，因此 `teamai doctor --json 2>/dev/null` 可以整体解析；退出码不变。每个检查都会带上人类模式下显示的修复建议：

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

尚未初始化时 `scope` 为 `null`。仅当团队仓库声明了 packages 时才会出现 `packages` 字段，内容是已渲染的报告行；`notes` 只在有额外提示时出现 —— 目前是 Codex 信任门槛提醒。

自动更新在 Stop hook 中执行，可通过两层控制：

| 层级 | 文件 | 字段 | 值 |
|------|------|------|------|
| 团队默认 | `teamai.yaml` | `autoUpdate` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

用户级 `updatePolicy` 始终优先于团队级 `autoUpdate`。

在 Windows 上，更新检查、安装和 hooks 刷新均不会弹出命令行窗口。

### 使用统计上报

Pull 对整批统计上报最多等待 5 秒，之后继续其他工作，上报任务仍会完成。
超时后推送成功，仍会更新本地已上报快照。skill 使用按 scope 记录：写入会话所在
目录对应的已配置 teamai 项目的数据目录（或 user scope），因此每个目标只上报
自己的使用；未配置 teamai 的目录不记录。目标确认成功后才清理自己的使用事件，
推送失败会保留事件。上报完成前继续持有相关同步锁，
避免另一次 Pull 与尚未完成的上报竞争。

这仍是尽力上报，不提供崩溃恢复保证：远端推送成功与本地确认之间如果进程
被终止，统计仍可能重复；也不提供多仓库部分成功时的持久化逐目标去重。
5 秒限制只结束等待，不取消 Git，也不强制仍有子进程运行的 CLI 退出。

默认情况下，`teamai pull` 会把会话/使用统计提交进团队仓。从只读远端拉取（或
不想要统计提交）的团队可在 `teamai.yaml` 中关闭：

```yaml
usageReport: false
```

### Git 子模块

若团队以 git submodule 形式分发 skill，在 `teamai.yaml` 中开启 `submodules: true`：

```yaml
submodules: true
```

每次 pull 时 teamai 会执行 `git submodule update --init`，按团队仓钉住的版本
填充子模块（仅 git 仓后端生效；取完整子模块历史——浅取无法检出较旧的 pin）。
默认关闭。若更新失败，pull 会记录警告并保留旧的同步版本号，下次 pull 会重新
完整同步并自动重试（不会被"版本未变化"的快速路径跳过）。注意：子模块拉取
依赖环境现有的 git 凭据——若宿主机采用按命令注入 token 的认证方式（而非配置
credential helper），私有子模块将无法通过认证。

### Pull 后脚本

团队常常需要部署 teamai 内建面之外的内容（客户端可选模型、本机安装、PATH
shim 等）。在 `teamai.yaml` 中声明 `scripts.postPull`，teamai 会在一次 pull
完全结束后，为**拥有本机部署权的那个团队仓**运行该 Node 入口——项目 scope
激活时是项目仓，否则是用户仓（继承来的用户仓只带资源与知识，不带部署）：

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

路径相对团队仓根目录；解析到仓外（含经 symlink）会被拒绝。会话启动路径上，
脚本作为 pull 进程的子进程运行，并在固定预算内
被等待（导出 `TEAMAI_POSTPULL_TIMEOUT_SEC`，脚本可据此为重步骤自限）；预算
到期时脚本被留在后台继续跑而不是被杀，下次 pull 自会对账。交互式
`teamai pull` 则以 fire-and-forget 方式把脚本拉起进终端。路径非法、文件缺失
或拉起失败只会是 `~/.teamai/debug.log` 里的一行（`postPull: launched /
exited / timed out`），绝不会让 pull 失败。

### CI 集成

`teamai ci extract-mr` 接入 CI 流水线，从每个 MR/PR 自动提取知识：

```bash
# 评论模式：以评论形式发布建议（在 PR 打开/更新时运行）
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# 写入模式：合并后将审批通过的建议写入知识库
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

工作流程：

1. MR 打开/更新 → CI 触发 `--mode comment`，提取知识建议并发布为 MR 评论
2. Reviewer 审查评论，对不需要的建议添加拒绝标记（GitHub 👎 / TGit ☝️）
3. MR 合并 → CI 触发 `--mode write`，将未被拒绝的建议写入团队知识仓库

如果审核状态 API 返回非 2xx 响应，write 模式会按 fail-closed 处理：任务失败退出，且不会向团队知识仓库写入文件、提交或 push。

评论模式在无法列出已有 marker 评论时也会按 fail-closed 处理，避免临时的 Provider 错误创建重复评论。

开箱即用模板：

- `examples/ci/github-actions-mr-extract.yml`（GitHub Actions）
- `examples/ci/coding-ci-mr-extract.yaml`（Coding CI / TGit）

### 跨团队 Skill 订阅

`teamai source` 让你订阅其他团队的公共 skill 仓库，pull 时自动获取最新 skills：

```bash
# 添加订阅源
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# 查看订阅列表
teamai source list

# 浏览订阅源的 skills
teamai source browse other-team

# 移除订阅（同时清理其 skills）
teamai source remove other-team
```

订阅源的 skills 在 `teamai pull` 时自动同步到本地，与团队自有 skills 共存。`teamai source add`/`remove` 会立即更新当前 scope 的团队仓，因此改动尚未提交时，本机的 `list`、`browse` 和 `pull` 也会使用它。订阅配置存储在该仓库 `teamai.yaml` 的 `sources` 字段中。运行 `teamai push` 会开一个包含配置改动的 PR；合入后，每位成员的 `teamai pull` 都会自动获取到新的订阅源。

源仓只会共享它在自己 `teamai.yaml` 的 `publicSkills` 列表里显式声明的 skill。如果对方仓库没有 `teamai.yaml`，或没有声明 `publicSkills`，`teamai source add` 仍会成功，但会警告该源将同步 **0 个 skill**——需要对方团队先发布 `publicSkills` 列表，才会有内容流转过来。

#### HTTP 源

除了 git 订阅源，还可以在已有 git 主仓的基础上附加一个 HTTP 源——适用于服务端管理的 skill 下发：

```bash
# 附加 HTTP 源（git 主仓不受影响）
teamai source add-http https://your-team-host/api --token <api-key>

# 查看（在 "HTTP source" 下显示）
teamai source list

# 解绑并卸载其资源
teamai source remove-http
```

HTTP 源通过 hook dispatch 在每次 session 中上报状态并拉取 skill 指令。每个安装仅支持一个 HTTP 源。若主仓本身已是 HTTP 模式（`init --http`），则 `add-http` 不可用（主仓已占用 HTTP 配置）。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化：OAuth 登录、关联仓库、注册成员、注入 hooks |
| `teamai pull` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai push` | 推送本地资源到分支并创建合并请求 |
| `teamai packages [install] [target]` | 安装团队 npm 包和 Claude 插件。裸 `teamai packages` 安装全部；`teamai packages install <target>` 添加单个并更新声明 |
| `teamai status` | 显示本地与团队仓库的差异及资源数量，包含 namespace 下的技能和子目录中的文档 |
| `teamai contribute` | 将 session 经验分享到团队仓库的 `teamai-learnings` 分支 |
| `teamai recall <query>` | 搜索团队知识库（BM25 + 图谱增强） |
| `teamai recall enable/disable/status` | 开关或查看 recall 状态 |
| `teamai recall promote [learningId]` | 将高置信度 learning 晋升为正式知识（skills/rules/docs） |
| `teamai recall maintenance` | 维护知识库健康：清理低置信度 learnings、回写置信度、标记过时条目 |
| `teamai import` | 导入知识（`--dir`、`--from-repo`、`--from-org`、`--from-repo-list`、`--from-mr`） |
| `teamai codebase --extract [path]` | 提取代码事实并在 `teamwiki/` 下构建本地图谱 |
| `teamai codebase --deep-enrich` | 从已提取的 evidence 生成深度知识文档 |
| `teamai codebase --reconcile` | 将产品文档与提取的代码知识进行对账 |
| `teamai codebase --lint` | 知识图谱健康检查 |
| `teamai ci extract-mr --url <url>` | CI：从 MR 提取知识、发评论、合并后写入 |
| `teamai members` | 查看团队成员 |
| `teamai projects` | 将工作目录绑定到一个或多个逻辑项目 |
| `teamai roles` | 管理团队角色和命名空间 |
| `teamai tags` | 管理基于标签的 skill/rule 过滤 |
| `teamai skill exclude add/remove/list` | 管理不参与本地同步的 skills（[使用指南](#排除个人不需要的-skill)） |
| `teamai source` | 管理 skill 订阅源（其他团队或本团队公共仓库） |
| `teamai remove <type> <name>` | 删除资源并创建 MR |
| `teamai session save` | 将脱敏后的 session 摘要记录到月度日志（`--push` 可喂给 `digest`） |
| `teamai digest` | 生成团队周报 |
| `teamai doctor` | 诊断配置问题（`--json` 输出 JSON，供 CI、hook 与 agent 消费）|
| `teamai uninstall` | 移除所有 teamai 资源和 hooks |

---

## 配置文件参考

### teamai.yaml（远端团队配置）

```yaml
team: my-team
description: 团队 AI 资源仓库
repo: https://github.com/yourorg/yourrepo.git
provider: github
# scope: 若存在则忽略——本机安装位置由 `teamai init --scope` 决定

reviewers:
  - reviewer1

packages:
  npm:
    - name: typescript
      version: "*"

sharing:
  rules:
    enforced: [code-review-guide]
  recall:
    enabled: false             # 可选；成员可在本地覆盖
  docs:
    localDir: ./.teamai/docs
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false             # 可选，为全团队去除 AI 工具提交尾注
  contributeHint:
    enabled: true              # 可选，false = 高摩擦 session 结束后不再提示 /teamai
  intervention:
    correctionKeywords: []     # 可选，额外的纠偏词，与内置中/英/日列表合并
  webhooks:                    # 可选，在团队事件发生时通知外部端点（见"Webhook 通知"）
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # 可取：session-start、session-stop、skill-use、push、pull，或 "*" 表示全部
        secret: my-signing-key # 可选，设置后启用 X-TeamAI-Signature 头
        timeout: 5000          # 可选，单次请求超时（毫秒，默认 5000）
        retries: 3             # 可选，失败重试次数（默认 3）
```

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/yourorg/yourrepo.git
username: your-name
updatePolicy: auto
scope: project                 # project（init 默认）或 user
projectRoot: /path/to/project  # 仅 project scope
inheritUserScope: true         # 可选，仅 project scope，默认 false
coAuthorEnabled: true          # 可选，每机器的 co-author 覆盖
contributeHintEnabled: false   # 可选，每机器覆盖 sharing.contributeHint.enabled
toolRoots:                     # 可选，每机器的工具根目录（见下）
  claude: ~/.claude-work
```

#### 迁移后的工具根目录（`toolRoots`）

有的工具可以把自己的配置放到别处——Claude Code 就通过 `CLAUDE_CONFIG_DIR` 这样做——此时 teamai 按团队默认位置写入的内容它一概读不到。`toolRoots` 用与 `toolPaths` 相同的工具 id 指明该工具实际使用的目录，teamai 为它解析的所有路径（skills、rules、agents、`CLAUDE.md`、settings，以及用户级 MCP 配置）都会一并迁过去。其他工具不受影响，project scope 的路径也不受影响：那些路径挂在项目根目录下，每机器的根目录对它们没有意义。hook 是个例外，也正是值得记录 `toolRoots` 的原因——即使在 project scope，hook 也注入到 home 目录，因此两种 scope 下都跟随 `toolRoots`。

`teamai init` 会自动写入：只要设置了 `CLAUDE_CONFIG_DIR`，init 就记录它指向的目录并打印出来。`CLAUDE_CONFIG_DIR=~/.claude` 也算——它与不设置该变量并不等价：设置之后 Claude Code 从配置目录内部读取 `.claude.json`，因此 teamai 写的是 `~/.claude/.claude.json` 而不是 `~/.claude.json`。读取这个变量的命令也只有 `init`——它只存在于某一份 shell 配置里，而 teamai 还会从 session hook 和别的终端里运行，每次运行都去读它，同步目标就会取决于是谁启动了进程。重新执行 `init` 会保留之前记录的根目录，所以在没有该变量的 shell 里再跑一次 init，同步目标不会被悄悄改回默认位置。如果重新执行 `init` 确实换了根目录，teamai 会把此前注入到旧根目录 `settings.json` 里的 hook 移除，以免那个 Claude 继续往新目录同步；写在旧目录里的 skills、rules 和 `CLAUDE.md` 片段会原样保留，并在输出中指明位置。project scope 的 `init` 若自身没有记录、也读不到该变量，则沿用 user scope 的记录：根目录是这台机器的事实，而 project scope 的 hook 也注入到 home 目录。要结束迁移，把该变量设为空再执行一次 `init`（`CLAUDE_CONFIG_DIR= teamai init …`）：记录会被清除，旧根目录按同样方式释放。除 hook 之外，旧根目录里 teamai 管理的 MCP server 和本地 agent 下发的网关凭据也会一并移除——它们是生效中的配置，不同于 skills 和 rules。

根目录必须是 teamai 能够识别该工具的位置：home 目录下的一层目录（`~/.claude-work`，但 `~/.config` 本身除外），或者一个 `~/.config/<名称>` 目录（开头的 `~/` 会被展开）。这两种形态正是「该工具是否已安装」这项检查能够查找的范围；更深的层级、或 home 目录之外的路径都会被拒绝并给出警告，而不是只生效一半。

`import --from-claude` 和 skill 使用统计同样读取记录的根目录：迁移后的 Claude Code 的 rules 可以导入，其 skills 也算作已安装。

`toolRoots` 目前只对 `claude` 生效，其他工具 id 都会被拒绝并给出警告。只有当一个工具在用户级的所有写入都经过 `toolPaths` 时，为它指定根目录才是可靠的；其余工具都还有 teamai 另行解析的写入位置——OMP 的扩展目录、Codex 与 Cursor 的 co-author 文件、OpenCode 的插件目录——只迁移它们的 `toolPaths` 会把其余部分留在原处。Copilot CLI 有自己的机制：设置 `COPILOT_HOME`。

如果你在初始化之后才设置或修改 `CLAUDE_CONFIG_DIR`，`teamai doctor` 会报出来：`Claude Code root matches CLAUDE_CONFIG_DIR` 这项检查（仅在当前配置会同步 Claude Code 时出现）会比对该变量与当前配置实际同步到的根目录，并提示重新执行 `teamai init`；若该值是 teamai 无法同步到的目录，则说明原因。未设置该变量时，这项检查不会出现在报告里。

### Webhook 通知（`sharing.webhooks`）

在团队事件发生时通知外部端点。每个 endpoint 声明 `url`、`type`（`json`、`feishu` 或 `wecom`）以及订阅的 `events`；`secret`、`timeout`（默认 `5000` 毫秒）、`retries`（默认 `3`）均为可选。

**事件及触发时机：**

| 事件 | 触发时机 |
| --- | --- |
| `session-start` | AI session 开始 |
| `session-stop` | AI session 结束（含 Copilot 的 `SessionEnd`） |
| `skill-use` | 调用某个 skill |
| `push` | `teamai push` **真正完成一次推送**——`--dry-run`、取消选择、无变更、或 PR 创建失败都不触发 |
| `pull` | `teamai pull` 完成一次真实（非 `--dry-run`）同步 |
| `*` | 通配符——订阅以上全部事件 |

**载荷。** 仅发送白名单内的非敏感字段：`skill-use` 发送 `skillName`，session 事件发送 `sessionId`；`push`/`pull` 只带事件与元数据。原始工具入参与工具输出**绝不**外发，且整个请求体在离开本机前会经过 teamai 的密钥脱敏处理。

**签名。** 设置 `secret` 后，每个请求都会带上 `X-TeamAI-Signature: sha256=<hmac>`——对**实际发送的请求体**计算的 HMAC-SHA256，供接收端校验真实性。`teamai webhook list` 与 `teamai webhook test` 可查看和测试已配置的端点。

---

## 模型配置

模型配置让 Claude Code、Codex、OpenCode、CodeBuddy 和 WorkBuddy 使用同一个模型网关。只有执行 `teamai models switch` 才会修改 Agent 配置；切换之后，`teamai pull` 会让已切换的 Agent 跟随团队目录的最新内容。

配置有两个来源，格式完全相同：

- `team:<id>` 来自团队仓库的 `models/models.yaml`，只包含 URL 和模型 ID，不包含密钥。
- `local:<id>` 是 `~/.teamai/models/models.yaml` 中的个人配置，只在本机可见。

ID 唯一时可直接写 `<id>`；团队和个人配置同名时，需写成 `team:<id>` 或 `local:<id>`。

### 团队目录

在团队仓库中创建 `models/models.yaml`：

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}          # 占位符；每位成员在本地配置真实密钥
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3               # 第一个模型是默认模型
          - deepseek-v4-flash
```

- `base_url` 是网关根地址。`anthropic` 协议直接使用该地址，OpenAI 协议在后面加 `/v1`，与 [TokenHub](https://cloud.tencent.com/document/product/1823/130078) 一致。
- `protocols` 声明该组模型支持的协议：`anthropic`、`openai-chat-completions`、`openai-responses`。协议支持不同的模型放在不同分组，每个模型 ID 只出现一次。
- `api_key` 必须写成 `${API_KEY}`。未知字段、重复模型 ID，以及带凭证、查询参数或片段的 URL 都会被拒绝；`teamai push` 会拦截无效目录。

哪些 Agent 可以使用由协议决定：

| Agent | 需要的协议 | `switch` 写入的内容 |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json`：`env` 中的网关地址和密钥；全部模型进入 `/model` 选择器；`opus`/`sonnet`/`haiku` 映射到网关中名称匹配的模型，否则映射到默认模型 |
| Codex | `openai-responses` | `~/.codex/config.toml`：默认模型和 `[model_providers.teamai]` 块 |
| OpenCode | 任意 | `opencode.json`：每种协议一个 provider，包含全部模型 |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json`：每个模型一个条目 |

上例没有 `openai-responses` 分组，因此不会修改 Codex；确认网关的 Responses 接口支持这些模型后，再加上该协议即可。

### 使用团队配置

```bash
teamai models list                     # 全部配置：密钥来源、网关、模型、Agent 及生效位置
teamai models list tokenhub            # 只看一个配置
teamai models switch tokenhub          # 首次使用时提示输入密钥
```

`switch` 会更新所有已安装且兼容的 Agent。可以用 `--agent claude`（可重复）缩小范围，用 `--model deepseek-v4-flash` 指定默认模型，用 `--dry-run` 预览。

如果不想保存密钥，可以改为引用环境变量：

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

Codex、OpenCode、CodeBuddy 和 WorkBuddy 会自行读取该变量。Claude Code 不支持，所以 `switch` 会把解析后的密钥写入 `~/.claude/settings.json`。命令刻意不提供 `--api-key <值>`，因为命令参数会进入 shell 历史和进程列表。密钥文件权限为 `0600`。

团队修改目录后，`teamai pull` 会把新内容重新应用到已切换到该配置的 Agent。

### 个人配置

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

省略参数时会交互输入。用 `configure` 修改个人配置：`--name`、`--base-url`、`--model`（追加模型）和 `--protocol`（让模型额外支持某协议；配合 `--model` 可只作用于这些模型）。也可以直接编辑 `~/.teamai/models/models.yaml`。个人配置的 ID 不能与团队配置重名。

### 恢复

```bash
teamai models restore                  # 所有被 TeamAI 切换过的 Agent
teamai models restore --agent codex
```

TeamAI 只修改自己管理的字段和条目，并记录首次切换前的值，`restore` 会还原这些值。如果你自己改了受管字段（例如 Claude `env` 中的网关地址），之后的切换、pull 和恢复都会跳过该 Agent。在 Claude 中用 `/model` 选择其他模型不算接管。Codex 的 `~/.codex/auth.json` 永远不会被修改。

Claude 注意事项：`settings.json` 启用了 Bedrock、Vertex 或 Foundry 时，`switch` 会拒绝切换。当前 shell 导出的 `ANTHROPIC_*` 与 TeamAI 写入的值不一致时会给出警告，因为从该 shell 启动的会话仍会使用这些值。

其他命令：

```bash
teamai models remove local:my-gateway  # Agent 保留当前配置，restore 仍然可用
```

用户级完整 `teamai uninstall` 会先恢复受管的模型配置；如有无法恢复的配置，会停止卸载并保留恢复记录。项目级卸载不改动这些机器级配置。

---

## 卸载

`teamai uninstall` 会智能清理所有 teamai 管理的资源，**保留用户自建内容**。

```bash
# 预览将要移除的每个受管路径（不做实际变更）
teamai uninstall --dry-run

# 交互式确认卸载
teamai uninstall

# 跳过确认直接卸载（适合脚本/CI）
teamai uninstall --force

# 只卸载某一个工具的资源（与 init --agent 对称）
teamai uninstall --agent claude
```

移除内容：
- 如果 ownership 仍有效，先恢复 TeamAI 管理的模型配置
- AI 工具 settings 中的 teamai hooks
- CLAUDE.md 中的 teamai rules 块（保留用户自写内容）
- 团队同步的 skills，包括 OpenClaw workspace skills（保留用户自建 skills）
- 团队同步的 rules
- 团队同步的自定义 agents 和 CLI 内置 agents（保留用户自建 agents）
- Shell profile 中的 env 块——会清理每一个候选文件（`.zshrc`、`.bashrc`、`.bash_profile`、`.bash_login`、`.profile`）中、代码块指向本作用域自身 `env.sh` 的那些，而不仅仅是当前 `pull` 会选中的那一个；指向其他作用域 `env.sh` 的代码块不受影响
- `~/.teamai/` 目录

### 只卸载单个工具（`--agent <tool>`）

`--agent <tool>` 只移除该工具的 teamai 资源（hooks、CLAUDE.md 块、skills、rules、团队同步的自定义 agents、内置 agents）。工具名即 `toolPaths` 的键（如 `claude`、`codex`、`codebuddy`），匹配大小写不敏感。传入未知工具名会直接报错并列出可用工具、不执行任何删除，并以非零状态码退出。

跨工具共享资源（shell profile env 块、docs 目录、`~/.teamai/`）**仅当该工具自身存在 teamai 资源、且它是最后一个仍在使用 teamai 的工具时**才一并移除，否则会为其余工具保留。（因此，定向卸载一个自身没有任何 teamai 资源的工具是 no-op，即便它恰好是唯一的工具，也不会删除共享资源。）

该排除是持久的：`uninstall --agent <tool>` 会把该工具从 `enabledAgents` 移除并记入 `disabledAgents`，因此之后的 `pull`（或其他工具的 session-start hook）不会再把它的 skills、rules、agents、CLAUDE.md 块或 hooks 重新装回。重新执行 `init --agent <tool>` 会清除该排除、恢复对该工具的同步。

同一套 `enabledAgents` 白名单（来自 `init --agent`）也约束 CLI 内置 skills/rules/agents 以及 CLAUDE.md 类注入：即使工具根目录已经存在，白名单外的已安装工具也不会被写入或删除。`teamai remove` 对 agents、rules 和 skills 同样遵守该白名单，`teamai push` 也不会从白名单外的工具读取 rules 和 agents，`teamai pull` / `teamai mcp inject` 对 MCP servers 也遵守该白名单。不经过 `init` 直接把工具加进 `enabledAgents` 时，last-pull 跳过缓存会对新加入的工具失效。

卸载后如需重新加入：

```bash
teamai init --repo https://github.com/yourorg/yourrepo --scope user --role <role_id> --force
teamai pull
```

---

## 常见问题 FAQ

**Q: User scope 和 Project scope 可以共存吗？**

可以，但 project scope 默认保持隔离。当前工作目录包含 project scope 配置时，该项目生效并跳过 user scope。先初始化 user scope，再使用 `--inherit-user-scope` 初始化项目（或在项目本地配置中设置 `inheritUserScope: true`），即可组合安全资源和 Recall 结果；可执行配置和控制面配置（`env`、MCP）仍只使用 project scope；hooks 例外——非-self 的 project scope 会把 hooks 注入到 HOME，以便 `hook-dispatch` 依据 `cwd` 门控（详见 Hooks 章节）。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。也可用 `--force` 跳过确认：

```bash
teamai init --repo https://github.com/yourorg/yourrepo --force
```

**Q: 在项目里执行 `teamai init` 后没有 `.claude/`（或 `.cursor/`、`.codebuddy/`）目录？**

这是预期行为。`init` 不知道你会打开哪个 Agent。在项目中打开 Claude Code / Cursor / CodeBuddy：SessionStart hook 会创建该工具的项目根目录并随后 pull。单独执行 `teamai pull` 不会为缺失的 Agent 根目录建目录。

**Q: Hooks 没有自动触发？**

```bash
teamai doctor        # 诊断
teamai hooks inject  # 重新注入
```

**Q: push 提示 "no new resources detected"？**

`push` 只检测新增或修改的资源。没有变更时无需推送。

**Q: 如何删除已推送的资源？**

```bash
teamai remove skills <name>
teamai remove rules <name>
```

---

> **仓库**：https://github.com/Tencent/teamai-cli
> **问题反馈**：https://github.com/Tencent/teamai-cli/issues

仪表盘支持切换已安装的项目范围和用户范围，同一项目的 worktree 归为一个项目。全部工作区显示全部本机会话及启动时知识库范围。健康报告已整合进团队上下文和团队改进。新安装范围后重启仪表盘以发现新范围。
