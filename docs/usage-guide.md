# TeamAI CLI — 团队接入与使用指南

> **@tencent/teamai-cli** — 团队 AI 经验共享框架
>
> 帮助团队统一管理和共享 Skills、Rules、Docs、Env 等资源，自动同步到 Claude Code、CodeBuddy、Cursor、Codex、Gemini CLI、Windsurf 等 AI 编程工具中。

---

## 目录

- [核心概念](#核心概念)
- [安装](#安装)
- [管理员初始化](#管理员初始化)
  - [用户级（User Scope）](#用户级user-scope)
  - [项目级（Project Scope）](#项目级project-scope)
  - [如何选择 Scope？](#如何选择-scope)
- [成员接入](#成员接入)
- [日常使用](#日常使用)
- [共享团队资源](#共享团队资源)
- [知识沉淀与检索](#知识沉淀与检索)
- [团队文化](#团队文化culture)
- [进阶功能](#进阶功能)
- [配置文件参考](#配置文件参考)
- [常见问题 FAQ](#常见问题-faq)

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **Team Repo** | 一个 Git 仓库，集中存放团队共享的 Skills / Rules / Docs / Env 资源 |
| **Scope** | 资源安装位置：`user`（用户主目录，默认）或 `project`（项目目录）|
| **Skills** | AI 可调用的自定义技能（目录形式，含 `SKILL.md`） |
| **Rules** | Markdown 格式的团队规范，自动合并到 AI 工具配置中 |
| **Docs** | 团队共享文档，供 AI 参考 |
| **Env** | 团队共享环境变量，自动注入 shell |

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
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com

# 验证
teamai --version
```

**前置依赖：** Node.js ≥ 18、Git（`gf` CLI 仅 TGit 用户需要，`teamai init` 时会自动安装）

---

## 管理员初始化

> 只需一位管理员完成，其他成员跳到[成员接入](#成员接入)。

在 TGit（腾讯工蜂）上创建一个空仓库（命名建议：`TeamAi-<团队名>`），或者直接执行 `teamai init`，不存在时会提示自动创建。

### 用户级（User Scope）

资源安装到用户主目录（`~/.claude/skills/` 等），适用于通用团队规范、跨项目技能。

```bash
# --scope user 是默认值，可省略
teamai init --repo <group>/TeamAi-<team>
```

生成的目录结构：

```
~/.teamai/
├── config.yaml          # 本地配置
├── team-repo/           # 团队仓库克隆
│   ├── teamai.yaml      # 远端团队配置（scope: user）
│   ├── skills/ rules/ docs/ env/ members/
│   ├── manifest/roles.yaml  # 角色定义（启用角色化 skills 时）
│   └── learnings/       # 团队知识库
~/.claude/skills/        # 团队 skills（自动同步）
~/.claude/rules/         # 团队 rules（自动同步）
```

如果仓库启用了角色化 skills（存在 `manifest/roles.yaml`），`teamai init` 还会交互式要求你选择：

- `primaryRole`：默认 skill 同步和推送的目标 namespace
- `additionalRoles`：额外需要同步的 skill namespace

也可以通过 CLI 参数跳过交互，实现完全非交互式初始化（适合 CI/CD 或 AI agent）：

```bash
teamai init --repo <group>/TeamAi-<team> --scope user --role hai_dev --force
```

| 参数 | 说明 |
|------|------|
| `--repo <url>` | 团队仓库地址（必填） |
| `--scope <user\|project>` | 作用域，默认 `user` |
| `--role <id>` | 直接指定 primaryRole，跳过角色交互选择 |
| `--force` | 覆盖已有配置，跳过确认提示 |

本地配置示例：

```yaml
repo:
  localPath: ~/.teamai/team-repo
  remote: https://git.woa.com/group/repo.git
username: alice
scope: user
primaryRole: hai
additionalRoles:
  - pm
resourceProfileVersion: 1
```

### 项目级（Project Scope）

资源安装到项目目录下（`<project>/.claude/skills/` 等），适用于项目特定的技能和规则。

```bash
cd /path/to/my-project
teamai init --repo <group>/TeamAi-<team> --scope project
```

生成的目录结构：

```
/path/to/my-project/
├── .teamai/                     # 项目级配置（含自动生成的 .gitignore）
│   ├── config.yaml
│   └── team-repo/
├── .claude/skills/              # 项目级 skills（自动同步）
├── .claude/rules/               # 项目级 rules（自动同步）
└── src/
```

### 如何选择 Scope？

| 维度 | User Scope（默认） | Project Scope |
|------|-------------------|---------------|
| **资源安装位置** | `~/` 下 | 项目目录下 |
| **适用场景** | 通用团队规范、跨项目技能 | 项目特定的技能和规则 |
| **能否共存** | ✅ 可以同时拥有两个 scope | ✅ 可以同时拥有两个 scope |

> **Scope 锁定：** 管理员首次 init 时 scope 写入远端 `teamai.yaml`，后续成员 init 必须使用相同 scope。

---

## 成员接入

管理员将团队仓库地址分享给成员后：

**用户级团队：**

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
teamai init --repo <group>/TeamAi-<team>
# 完成！AI 工具已自动获得团队资源
```

**项目级团队：**

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
cd /path/to/my-project
teamai init --repo <group>/TeamAi-<team> --scope project
```

**验证：**

```bash
teamai status                       # 查看状态
teamai members                      # 查看团队成员
teamai list                         # 查看团队仓库 + 各 AI agent 已安装的 skills（默认 --source all）
teamai list --source repo           # 只看团队仓库内容（旧行为）
teamai list --source local          # 只看每个已安装 agent 下的 skills，按来源标注
teamai list --agent claude --verbose  # 只看 Claude Code 安装的 skills，含描述

teamai skill                        # 列出所有 skill（等价于 teamai list skills --source all）
teamai skill show hai-deploy-test   # 看单个 skill 的来源 / 贡献者 / 安装位置 / 描述摘要
```

---

## 日常使用

### 自动同步

`teamai init` 时已注入 Hooks 到你的 AI 工具中。**每次启动 AI 会话时会自动执行 `teamai pull`**，无需手动操作。

如果需要立即同步，可以手动执行：

```bash
teamai pull              # 手动拉取
teamai pull --dry-run    # 试运行，不实际修改
```

> 如果你同时有 user 和 project scope，`pull` 会依次拉取两个 scope 的资源，互不冲突。

启用角色化 skills 后，`pull` 的 skills 同步来源会变成 `skills/<namespace>/` 中的内容，按 `primaryRole + additionalRoles` 展开对应的 namespace，拍平安装到本地各 AI 工具 skills 目录。`rules/`、`docs/`、`learnings/` 仍然保持原有全局同步逻辑。

### 推送本地资源

```bash
teamai push          # 扫描新增/修改的资源，创建 MR
teamai push --all    # 跳过确认，直接推送
teamai push --role pm  # 将本次 skill 推送到 skills/pm/<skill-name>/
```

**命名空间选择（新 skill）：** 推送新 skill 时，CLI 会自动检测可用的命名空间并提供交互式选择：

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- 有 `primaryRole` 时，从 manifest 展开可用 namespace 列表
- 无 `primaryRole` 时，自动扫描团队仓库目录结构
- 单一命名空间时自动选中；`--silent` 模式使用默认值
- 修改已有 skill 时自动保持原 namespace

**YAML Frontmatter 自动补全：** 推送时 CLI 自动检查 `SKILL.md`，缺少 `name`/`description` 则自动补全，无需手动维护。

### 查看状态

```bash
teamai status        # 当前 scope、同步时间、资源统计
```

### 角色管理

角色（Roles）控制每个成员看到哪些 skills。管理员通过 `manifest/roles.yaml` 定义角色，成员选择自己的角色后，pull 只同步对应 namespace 的 skills。

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

以上命令会自动 push 分支并创建 MR，合并后对全团队生效。

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

---

## 共享团队资源

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

### Docs（文档）

将文档放入团队仓库 `docs/` 目录，push 后团队成员 pull 时自动同步。

---

## 知识沉淀与检索

### 贡献知识

AI 通过 Hooks 追踪你的编码会话。当会话结束时（Stop hook），系统会对本次会话进行智能评分（工具调用多样性、skill 使用、错误修复等），达标后会自动提醒：

```
建议运行 /teamai-share-learnings 分享经验
```

使用内置 skill `/teamai-share-learnings`，AI 会自动总结本次 session 经验并贡献到团队知识库。每个 session 最多提示一次。

也可以手动指定文件：

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
```

### 搜索知识

```bash
teamai recall "API 超时"
teamai recall "GPU 内存不足"
```

- 支持中英文混合搜索
- 自动合并 user + project 双 scope 的知识库，结果标注 `[user]`/`[project]` 来源
- 被查阅的知识自动 upvote，好文档浮到顶部

---

## 团队文化（Culture）

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

### Dashboard

```bash
teamai dashboard             # 启动 Web 面板（默认端口 3721）
teamai dashboard --port 8080
```

实时查看团队成员的 AI 编码会话状态。

#### 人工干预指标（Human Intervention）

每个会话卡片会显示一个 `⚠ N` 徽标，统计该对话中用户的**人工干预次数**——干预越少，说明 agent 一次把事做对的能力越强。鼠标悬停可看分类明细，三类信号各计一次：

| 类型 | 含义 | 数据来源 |
|------|------|----------|
| `interrupt` | 用户在 agent 执行中途按 ESC 打断 | transcript 中被中断的 turn |
| `toolReject` | 用户拒绝某个工具调用（permission deny） | transcript 中标记拒绝的 tool_result |
| `correction` | agent stop 后 60s 内用户追加含「不对 / 重来 / 错了 / wrong / redo」等纠偏词的 prompt | stop → prompt_submit 事件模式 |

> 隐私：只统计**次数**，不落地任何 prompt 或 transcript 原文。

干预数据会随 `teamai pull` 自动聚合上报到团队 `stats/<user>.yaml`，并在 `teamai digest` 的「会话自主性」榜单中给出团队均值与人均干预率排行，可用于验证某个 skill / rule 上线后干预率是否下降。无 transcript 的工具（如 Cursor）会优雅降级，只统计 `correction`。

#### 对话量与 Token 用量

每个会话卡片还会显示两个徽标：

| 徽标 | 含义 | 数据来源 |
|------|------|----------|
| `💬 N` | 该会话里**人类对话的轮数**（发了几次 prompt） | `UserPromptSubmit` 事件数 |
| `⛁ X` | 该会话累计 **token 用量**（鼠标悬停看 输入 / 输出 / 缓存读 / 缓存写 明细） | Claude Code transcript 的 `message.usage`（按 `message.id` 去重，避免重复计数） |

> 隐私：只统计**轮数与 token 数量**，不落地任何 prompt 或 transcript 原文。

这两项同样随 `teamai pull` 聚合到 `stats/<user>.yaml`（`prompts` 与 `tokens` 字段），并在 `teamai digest` 的「对话量与 Token 用量」板块给出团队对话总轮数、token 总量（分桶）与人均 token 用量排行。拿不到 transcript 的工具（如 Cursor）会优雅降级：仍统计对话轮数，token 显示为 0 / N/A。

### Hooks

`teamai init` 自动注入的 Hooks：

| Hook 事件 | 操作 |
|-----------|------|
| `SessionStart` | 自动 pull + 上报会话启动 |
| `PostToolUse` | skill 追踪 + 知识贡献检测 + dashboard 上报 |
| `UserPromptSubmit` | slash 命令追踪 |
| `Stop` | CLI 更新检查 + 上报会话结束 |

```bash
teamai hooks inject    # 重新注入
teamai hooks remove    # 移除
```

### 其他

```bash
teamai doctor          # 配置诊断
teamai stats           # skill 使用统计
teamai update          # CLI 更新
teamai remove skills <name>   # 删除资源
teamai remove rules <name>
teamai remove wiki <name>
```

### 跨团队 Skill 订阅

`teamai source` 让你订阅其他团队的公共 skill 仓库，pull 时自动获取最新 skills：

```bash
# 添加订阅源
teamai source add https://git.woa.com/other-team/teamai-public.git --name other-team

# 查看订阅列表
teamai source list

# 浏览订阅源的 skills
teamai source browse other-team

# 移除订阅（同时清理其 skills）
teamai source remove other-team
```

订阅源的 skills 在 `teamai pull` 时自动同步到本地，与团队自有 skills 共存。配置存储在本地 `config.yaml` 的 `sources` 字段中。

---

## 配置文件参考

### teamai.yaml（远端团队配置）

```yaml
team: my-team
scope: user                              # user 或 project
description: 团队 AI 资源仓库
repo: https://git.woa.com/group/repo.git
provider: tgit

reviewers:
  - reviewer1

sharing:
  rules:
    enforced: [code-review-guide]
  docs:
    localDir: ~/.teamai/docs
  env:
    injectShellProfile: true
```

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://git.woa.com/group/repo.git
username: your-name
updatePolicy: auto
scope: user                    # 或 project
projectRoot: /path/to/project  # 仅 project scope
```

---

## 卸载

`teamai uninstall` 会智能清理所有 teamai 管理的资源，**保留用户自建内容**。

```bash
# 预览将要移除的内容（不做实际变更）
teamai uninstall --dry-run

# 交互式确认卸载
teamai uninstall

# 跳过确认直接卸载（适合脚本/CI）
teamai uninstall --force
```

移除内容：
- AI 工具 settings 中的 teamai hooks
- CLAUDE.md 中的 teamai rules 块（保留用户自写内容）
- 团队同步的 skills（保留用户自建 skills）
- 团队同步的 rules
- Shell profile 中的 env 块
- `~/.teamai/` 目录

卸载后如需重新加入：

```bash
teamai init --repo <group>/TeamAi-<team> --scope user --role <role_id> --force
teamai pull
```

---

## 常见问题 FAQ

**Q: User scope 和 Project scope 可以共存吗？**

可以。`pull` 会依次拉取两个 scope，`recall` 会合并搜索两个 scope 的知识库。两者互不冲突。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。也可用 `--force` 跳过确认：

```bash
teamai init --repo <group>/<repo> --force
```

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

> **仓库**: https://git.woa.com/teamai/teamai-cli
> **问题反馈**: 提交 Issue 到仓库
