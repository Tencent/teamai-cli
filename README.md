# TeamAI — 团队 AI 经验共享框架

团队 AI 经验共享框架。自动在团队成员之间同步 skills、rules、docs 等 AI 工具配置。

> 📖 **完整使用指南**：[docs/usage-guide.md](docs/usage-guide.md) — 涵盖从团队创建到日常使用的全流程。

## 如有问题或建议，欢迎提交 PR 或 Issue，一起共建这个项目
## 安装

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```

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

需要先在 git.woa.com 上创建好团队共享经验的仓库，并把所有团队的成员都加入到 master(可通过 user group 快捷添加)

## 命令

| 命令 | 说明 |
|------|------|
| `teamai init [--scope <user\|project>] [--role <id>] [--force]` | 初始化（自动安装 gf CLI、OAuth 登录、关联仓库、注册成员、配置 reviewers、注入 hooks） |
| `teamai push [--all] [--role <id>]` | 推送本地新资源到独立分支并创建 Merge Request；新 skill 交互式选择目标命名空间，可用 `--role` 覆盖 |
| `teamai pull [--silent]` | 拉取团队资源并注入到本地 AI 工具（支持双 scope 依次拉取） |
| `teamai status` | 查看本地 vs 团队仓库差异 |
| `teamai list [type]` | 列出资源（skills\|rules\|docs） |
| `teamai members` | 列出已注册的团队成员 |
| `teamai remove <type> <name>` | 从团队仓库和本地删除资源并创建 MR（skills\|rules） |
| `teamai roles` | 管理团队角色（`init`/`list`/`set`/`add`/`remove`/`update`） |
| `teamai contribute --file <path> [--scope <user\|project>]` | 将 AI 生成的经验文档推送到团队仓库 |
| `teamai recall <query>` | 搜索团队知识库，自动合并 user + project 双 scope 结果 |
| `teamai digest` | 生成团队 AI 使用周报（skill 排行、新增/更新 skill、session 摘要） |
| `teamai hooks` | 管理 AI 工具 hooks（list / inject / remove） |
| `teamai uninstall [--force]` | 卸载 teamai：移除 hooks、rules、skills、env、docs、~/.teamai/ |
| `teamai doctor` | 诊断配置问题 |

全局选项：
- `--dry-run` — 预览模式，不做实际变更
- `--verbose, -v` — 详细输出

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
- `teamai init` 会自动注入与各工具格式对齐的 hooks（含 `sessionStart`、`stop`、`postToolUse`、`userPromptSubmit` 等），会话中会执行 `teamai pull`、`teamai update`、追踪与仪表盘等（支持 Claude Code、Codex、Claude Code Internal、Cursor、CodeBuddy IDE）
- Skills 同步到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.claude-internal/skills/`、`~/.cursor/skills/`、`~/.codebuddy/skills/`
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

当一次 AI coding session 使用超过 50 次工具调用时，系统会智能评估 session 价值并提示分享：

```
AI coding session (持续工作中...)
    │
    ▼  PostToolUse hook 每次工具调用自动计数
    │
    ├─ < 50 次 → 静默计数（~1ms，不影响性能）
    │
    ▼  达到 50 次
    │
    ├─ 智能评分：工具多样性 + skill 使用 + 错误重试 + session 时长
    │  （从 dashboard events.jsonl 提取，一次性评估）
    │
    ├─ 分数不够 → 不打扰（只是重复调用同一个工具，没有总结价值）
    │
    ▼  分数达标
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

## 更新

```bash
npm update -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```
