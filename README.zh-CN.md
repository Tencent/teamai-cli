<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli" width="430">
</p>

# TeamAI — The team harness for AI agents

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

让每个 AI 编程助手都按同一套标准工作。

通过 Git 统一管理 skills、rules、docs，驾驭 20+ 种 AI 工具——一个人也能用，团队用更强。

**支持：** Claude Code、Codex、Cursor、CodeBuddy IDE，以及 Gemini CLI、Windsurf、Trae、Aider、Amp、OpenClaw 等 20+ 种 AI 编程工具（skills 同步）。

> 📖 **完整使用指南**：[docs/usage-guide.md](docs/usage-guide.md) — 涵盖从团队创建到日常使用的全流程。

> 📚 **Provider 说明**：[docs/providers.md](docs/providers.md) — GitHub / TGit 差异与认证配置。

如有问题或建议，欢迎提交 PR 或 Issue，一起共建这个项目。

## 安装

```bash
npm install -g teamai-cli
```

<details>
<summary>腾讯内部用户：通过 tnpm 安装 <code>@tencent/teamai-cli</code></summary>

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```

两个包的代码内容一致，`@tencent/teamai-cli` 只是公网 `teamai-cli` 的内网镜像。
</details>

## 快速开始

### 团队成员

```bash
# 用户级初始化（默认，资源安装到 ~/）
teamai init --repo yourteam/yourproject

# 项目级初始化（资源安装到项目目录下）
cd /path/to/my-project
teamai init --repo yourteam/yourproject --scope project

# 非交互模式（适合 CI/CD 或 AI agent 自动化）
teamai init --repo yourteam/yourproject --scope user --role hai_dev --force
```

### 管理员

先在 git 托管平台上创建好团队共享经验的仓库（默认 GitHub；TGit 也支持），并把所有团队成员加入到该仓库的 write 权限。

- **GitHub**：用 `gh repo create yourorg/yourproject --private` 创建，或在 UI 上建。然后用 Settings → Collaborators 把成员加进来，并把 master/main 设置为默认分支。
- **TGit（腾讯工蜂）**：在 [git.woa.com](https://git.woa.com/) 上创建，通过 user group 批量添加 master 权限。

CLI 会根据用户传入的 repo URL 自动选择 provider：

- `yourorg/yourrepo` 或 `https://github.com/yourorg/yourrepo` → GitHub
- `https://git.woa.com/yourteam/yourrepo` → TGit

## 命令

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化（OAuth 登录、关联仓库、注册成员、注入 hooks） |
| `teamai push` | 推送本地资源到独立分支并创建 MR |
| `teamai pull` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai status` | 查看本地 vs 团队仓库差异 |
| `teamai recall <query>` | 搜索团队知识库（BM25 + 图谱加权） |
| `teamai import --from-repo <url>` | 导入仓库代码知识图谱（`teamwiki/`） |
| `teamai import --from-org <org>` | 批量导入组织下所有仓库 |
| `teamai import --from-repo-list <yaml>` | 按白名单批量导入 |
| `teamai import --from-mr <url>` | 从已合并 MR 提取 learning |
| `teamai import --from-iwiki <id>` | 从 iWiki 导入文档为 learnings |
| `teamai codebase --lint` | 知识图谱健康度检查 |
| `teamai contribute` | 分享本次 session 经验到团队仓库 |
| `teamai members` | 列出团队成员 |
| `teamai roles` | 管理团队角色和命名空间 |
| `teamai remove <type> <name>` | 删除资源并创建 MR |
| `teamai digest` | 生成团队使用周报 |
| `teamai doctor` | 诊断配置问题 |
| `teamai uninstall` | 卸载所有 teamai 资源和 hooks |

全局选项：`--dry-run`、`--verbose`

<details>
<summary>更多命令（管理、CI、分析）</summary>

| 命令 | 说明 |
|------|------|
| `teamai list [type]` | 列出资源（skills\|rules\|docs\|env\|wiki） |
| `teamai skill [show <name>]` | 查看 skill 元数据和贡献者 |
| `teamai source` | 管理跨团队 skill 订阅 |
| `teamai tags` | 管理基于标签的资源过滤 |
| `teamai env` | 管理团队环境变量 |
| `teamai hooks` | 管理 AI 工具 hooks |
| `teamai cache --gc` | 回收 clone 缓存 |
| `teamai ci extract-mr --url <url>` | CI：从 MR 提取知识，发布评论，合并后写入团队仓库 |

</details>

## 工作原理

```
成员 A                               成员 B
  创建 skill / 写规则                   同上
    │                                     │
    ▼                                     ▼
  teamai push                        teamai push
    │                                     │
    ▼                                     ▼
  创建分支 + MR                       创建分支 + MR
    │                                     │
    └──────► 团队git仓库 ◄──────────────┘
                  │         ▲
                  │         │ reviewer 审批合并 MR
                  ▼
             SessionStart hook → teamai pull
             自动拉取到所有成员本地
```

- `teamai push` 会创建独立分支（`teamai/push/<user>/<timestamp>`），推送后自动创建 Merge Request 并指派 reviewers
- `teamai init` 初始化时可配置默认 reviewers（记录在 `teamai.yaml` 的 `reviewers` 字段）
- `teamai init` 会自动注入与各工具格式对齐的 hooks（含 `SessionStart`、`Stop`、`PostToolUse`、`UserPromptSubmit` 等），会话中会执行 `teamai pull`、`teamai update`、追踪与仪表盘等（支持 Claude Code、Codex、Claude Code Internal、Codex Internal、Cursor、CodeBuddy IDE、OpenClaw、WorkBuddy）
- Skills 同步到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.codex-internal/skills/`、`~/.claude-internal/skills/`、`~/.cursor/skills/`、`~/.codebuddy/skills/`
- Rules 同步到各工具的 rules 目录，并通过标记注释合并到 `CLAUDE.md`（支持 claude、claude-internal、codebuddy）
- Knowledge 同步到 `~/.teamai/docs/`
- Learnings 同步到 `~/.teamai/learnings/`，并基于该目录构建 recall 索引（全团队共享，不按角色拆分）
- Culture 同步团队文化文件（`culture.md`），编译 frontmatter 和 body 后注入到各 AI 工具的 `CLAUDE.md`

## 角色化 Skills

当团队资源仓库启用角色化目录后，Skills 按角色 namespace 组织，CLI 在 `teamai init` 时要求选择 `primaryRole` 和可选的 `additionalRoles`，并写入本地 `config.yaml`。

远端仓库目录约定：

```text
manifest/roles.yaml        # 角色定义
skills/<namespace>/<skill>/   # 按 namespace 组织的 skills
rules/                     # 全局，不做角色拆分
```

- `teamai pull` 读取 `manifest/roles.yaml`，只同步 `primaryRole + additionalRoles` 对应 namespace 中的 skills（同时保留 tag 过滤的并集）。
- Skills 从 `skills/<namespace>/<skill-name>/` 拍平安装到本地 `<tool>/skills/<skill-name>/`，用户无感知 namespace 结构。
- 如果激活 namespace 中出现同名 skill，`pull` 会直接失败，避免隐式覆盖。
- 不在激活 namespace 中、也不在 tag 过滤结果中的 skills 会被自动清理。
- `rules/`、`docs/`、`learnings/` 仍然保持原有逻辑，不做角色拆分（learnings 全团队共享）。

配置示例：

```yaml
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

这会同步 `skills/common/`、`skills/hai/`、`skills/pm/` 三个 namespace 中的所有 skills。

## 角色化推送

角色化仓库下，推送新 skill 时 CLI 会自动检测可用的命名空间并提供交互式选择：

```bash
# 交互式选择命名空间（推荐）
teamai push
# 输出：
# Which namespace should new skills be pushed to?
#   1. common
#   2. hai
#   3. pm
# Choose namespace [1-3] (default: 1 = common):

# 显式指定目标 namespace
teamai push --role pm
```

- 有 `primaryRole` 时，从 `manifest/roles.yaml` 展开可用 namespace 列表
- 无 `primaryRole` 时，自动扫描团队仓库目录结构中的 namespace
- 单一命名空间时自动选中，无需交互
- `--role <id>` 可临时覆盖目标 namespace
- 修改已有 skill 时自动保持原 namespace，无需重新选择

推送时 CLI 会自动检查 `SKILL.md` 的 YAML frontmatter（`name`/`description`），缺失则自动补全，无需手动维护。

## 团队文化（Culture）

在团队仓库根目录创建 `culture.md`，用 YAML frontmatter 定义公司和团队信息，body 部分写团队文化指引：

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  values:
    - Innovation
    - Integrity
team:
  name: Platform
  mission: Enable developers
  goals:
    - Ship v2.0
    - Improve test coverage
---

## 编码准则

- 所有 PR 必须有至少一个 reviewer 审批
- 禁止直接 push master
- 测试覆盖率不低于 80%
```

`teamai pull` 时会自动将 culture.md 编译为结构化内容，注入到各 AI 工具的 `CLAUDE.md` 中（`<!-- [teamai:culture:start] -->` / `<!-- [teamai:culture:end] -->` 标记之间）。AI 编码助手在每次会话中都能感知团队文化。

## 跨团队 Skill 订阅

通过 `teamai source` 订阅其他团队的公共 skill 仓库，pull 时自动同步订阅源的 skills：

```bash
# 添加订阅源
teamai source add https://git.woa.com/other-team/teamai-public.git --name other-team

# 查看已订阅的源
teamai source list

# 浏览订阅源的 skills
teamai source browse other-team

# 移除订阅（同时清理其 skills）
teamai source remove other-team
```

订阅源的 skills 在 `teamai pull` 时自动同步到本地，与团队自有 skills 共存。

## Scope（作用域）

TeamAI 支持两种 scope，可以共存：

| 维度 | User Scope（默认） | Project Scope |
|------|-------------------|---------------|
| **资源安装位置** | `~/` 下（如 `~/.claude/skills/`） | 项目目录下（如 `<project>/.claude/skills/`） |
| **配置文件** | `~/.teamai/config.yaml` | `<project>/.teamai/config.yaml` |
| **适用场景** | 通用团队规范、跨项目技能 | 项目特定的技能和规则 |
| **初始化** | `teamai init --repo <group>/<repo>` | `cd <project> && teamai init --repo <group>/<repo> --scope project` |

**双 scope 协同：**
- `teamai pull` 会依次拉取 user + project 两个 scope 的资源，互不冲突
- `teamai contribute --scope user/project` 可显式选择推送到哪个仓库
- `teamai recall` 自动合并两个 scope 的知识库，统一搜索排序，结果标注来源 `[user]`/`[project]`
- 远端 `teamai.yaml` 的 `scope` 字段锁定仓库类型，成员 init 时必须匹配

## 经验自动分享

当一次 AI coding session 结束时，系统会通过 Stop hook 智能评估 session 价值并提示分享：

```
AI coding session (持续工作中...)
    │
    ▼  PostToolUse hook 持续追踪工具调用和 skill 使用
    │
    ▼  会话结束（Stop hook 触发）
    │
    ├─ 智能评分：工具调用数量 + 工具多样性 + skill 使用 + 错误重试 + session 时长
    │  （从 dashboard events.jsonl 提取，一次性评估，满分 100）
    │
    ├─ 分数 < 35 → 不打扰（工具调用少或缺乏多样性，没有总结价值）
    │
    ▼  分数 ≥ 35
    │
    AI 提示："本次 session 内容丰富，建议运行 /teamai-share-learnings 分享经验"
    │
    ▼  用户同意
    │
    /teamai-share-learnings (AI sub-agent)
    ├─ AI 总结本次 session 的经验
    ├─ 生成 Markdown 文档
    └─ teamai contribute --file <path> → 直接 push 到团队仓库 learnings/
```

- `/teamai-share-learnings` 是 CLI 内置 skill，随 `teamai pull/init` 自动部署到本地
- 每个 session 最多提示一次（去重），用户可以忽略
- 文档直接 push 到 `learnings/` 目录，团队成员下次 pull 时可见

## 团队知识回忆

`teamai recall` 实现知识飞轮的"读出路径"——AI 可以自动搜索团队积累的经验文档：

```
contribute(写入) → pull(同步+索引) → recall(搜索) → upvote(投票) → 排序优化
```

```bash
$ teamai recall "fuse 端口"
[1/2] MR 审查发现 FUSE 端口冲突 Bug ★1 [user]
Author: jeffyxu | Score: 18.5 | Tags: troubleshooting, fuse, k8s

[2/2] FUSE 部署配置最佳实践 [project]
Author: alice | Score: 12.0 | Tags: fuse, deploy
```

- **双 scope 合并搜索**：自动合并 user 和 project scope 的知识库，结果标注来源
- Hybrid 中英文搜索（Intl.Segmenter + CJK bigrams）
- 搜索自动投票，好文档自然浮到顶部
- 投票按 scope 分别写入各自的 repo，归属正确

`teamai recall` 的输出会给每条命中前置 `[<type>]` 标签，方便调用方快速判断知识来源。共享检索索引覆盖四类内容：

| 类型 | 源路径 | 说明 |
|------|--------|------|
| `[learnings]` | `~/.teamai/learnings/*.md` | session 经验文档 |
| `[docs]` | 团队仓库 `docs/**/*.md` | 共享项目知识 |
| `[rules]` | 团队仓库 `rules/**/*.md` | 编码规则和约定 |
| `[skills]` | 团队仓库 `skills/<name>/SKILL.md` | 可复用 AI skill |

索引在每次 `teamai pull` 时自动重建。旧版索引（无 `version` 字段或缺少 `type`）会在首次使用时被自动检测并重建，对调用方透明

### 代码库知识图谱（teamwiki/）

`teamai codebase --extract`（或 `teamai import --from-repo`）解析源码仓库，将结构化知识图谱写入 `teamwiki/` 目录：

```
teamwiki/
├── router.md               # 导航枢纽，列出所有已导入仓库
├── index.md                # 全局索引（自动生成，含时间戳）
├── hot.md                  # 活跃工作记忆（Phase 4 hot/cold 预留）
├── source-manifest.json    # 源文件哈希清单（增量提取用）
├── .indices/
│   └── graph-index.json    # 知识图谱：nodes + edges（JSON 格式）
├── evidence/
│   └── code/
│       └── <project>/      # 每个导入的仓库一个目录
│           ├── index.md    # 项目摘要（facts 总数 + 页面列表）
│           ├── component.md  # 函数 / 类 / 组件
│           ├── interface.md  # 接口和类型定义
│           ├── config.md   # 配置项（环境变量、TOML key 等）
│           ├── error.md    # 错误处理模式
│           └── relation-<dir>.md  # 按顶级目录分组的 import 依赖关系
└── gaps/
    └── detected.md         # 知识缺口检测结果（IMPL_MISSING / LOW_CONNECTIVITY / …）
```

**graph-index.json** 存储提取出的知识图谱。真实数据参考：HAI 团队 11 个仓库 → **2 218 个节点，852 条边**。

| 字段 | 说明 |
|------|------|
| `nodes[].kind` | `component`（函数/类）或 `config`（配置项） |
| `edges[].relation` | `imports` —— 跨文件或跨仓库依赖关系 |

跨仓 edge 通过 PascalCase 标签匹配自动检测，无需手动配置。

`teamai recall` 利用此图谱进行 **BM25 + graph-boost** 检索：关键词命中后按图结构邻近度重排序，结果兼具文本相关性和结构相关性。

### TodoWrite 提醒 hook

`teamai pull` 会在 `TodoWrite` 工具上注册一个 PostToolUse hook。当 session 第一次写 TODO 列表时，hook 会注入一次性提醒，要求 agent 在尚未调用 `teamai-recall` 时先调用一次。session 级去重通过 `~/.teamai/sessions/<sid>-todowrite-hint.json` 实现（TTL 24 小时）

如果要全局关闭该提醒，请设置：

```bash
export TEAMAI_RECALL_DISABLED=1
```

该环境变量同时也会关闭 auto-recall hook

### `agents` 资源类型

团队仓库可以在扁平的 `agents/` 目录下放置自定义 subagent 定义（每个 agent 一个 `*.md`），push / pull / remove 语义与 `rules` 保持一致：

```text
team-repo/
  agents/
    code-reviewer.md      # 团队作者编写的 subagent
    .removed              # tombstone（由 `teamai remove agents <name>` 自动管理）
```

`teamai pull` 会把它们复制到每个 Tier-1 工具的 `agents/` 目录（例如 `~/.claude/agents/`）。CLI 内置的 `teamai-recall.md` 会与团队 agents 一起部署，并在 `teamai push` 时被自动排除（由 CLI 管理，不归团队仓库）

## 更新

```bash
teamai update        # 自动检测并升级到最新版
npm update -g teamai-cli   # 或手动触发 npm 升级
```

`teamai update` 会根据当前安装的包名自动选择 registry：

- `teamai-cli` → 公网 npm (`https://registry.npmjs.org`)
- `@tencent/teamai-cli` → 内网 tnpm (`http://r.tnpm.oa.com`)

如需手动覆盖 registry，可以设置环境变量 `TEAMAI_NPM_REGISTRY=<url>`。

### 自动更新控制

自动更新通过 Stop hook 在会话结束时执行，可在两个层级控制：

| 配置层级 | 文件 | 字段 | 可选值 |
|---------|------|------|-------|
| 团队默认 | `teamai.yaml` | `autoUpdate` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

用户级 `updatePolicy` 始终优先于团队级 `autoUpdate`。

## CI 集成

TeamAI 可以集成到 CI 流水线中，从每次 MR/PR 自动提取知识：

```
MR 创建/更新 → CI 提取 learning + codebase 建议 → 以评论形式发布
    → Reviewer 拒绝不需要的建议（GitHub 👎 / TGit ☝️）
    → MR 合并 → CI 将已通过的条目写入团队知识仓库
```

### 快速开始

```bash
# Comment 模式：将建议发布到 MR（在 PR 打开/更新时运行）
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write 模式：将已通过的条目写入知识仓库（在合并后运行）
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

### CI 模板

`examples/ci/` 目录下提供了开箱即用的模板：

| 文件 | 平台 |
|------|------|
| `github-actions-mr-extract.yml` | GitHub Actions |
| `coding-ci-mr-extract.yaml` | Coding CI（TGit + 智研 QCI） |

### 拒绝交互

| 平台 | 拒绝方式 | 默认行为 |
|------|---------|---------|
| GitHub | 对建议评论添加 👎 reaction | 全部写入 |
| TGit | 对建议 note 添加 ☝️ emoji | 全部写入 |

## 许可证

[MIT](LICENSE)

## 贡献

欢迎 PR！请先阅读 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。
