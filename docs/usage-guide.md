# TeamAI CLI — 团队接入与使用指南

> **@tencent/teamai-cli** — 团队 AI 经验共享框架
>
> 帮助团队统一管理和共享 Skills、Rules、Docs、Env 等资源，自动同步到 Claude Code、CodeBuddy、Cursor 等 AI 编程工具中。

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
tnpm install -g @tencent/teamai-cli

# 验证
teamai --version
```

**前置依赖：** Node.js ≥ 18、Git、`gf` CLI（腾讯工蜂命令行工具）

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
tnpm install -g @tencent/teamai-cli
teamai init --repo <group>/TeamAi-<team>
# 完成！AI 工具已自动获得团队资源
```

**项目级团队：**

```bash
tnpm install -g @tencent/teamai-cli
cd /path/to/my-project
teamai init --repo <group>/TeamAi-<team> --scope project
```

**验证：**

```bash
teamai status       # 查看状态
teamai members      # 查看团队成员
teamai list         # 查看已同步的资源
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
teamai push --role pm  # 将本次 project skill 推送到 skills/pm/<skill-name>/
```

如果本地配置包含 `primaryRole`，`teamai push` 在推送 project skill 时默认写入 `skills/<primaryRole>/<skill-name>/`。使用 `--role <id>` 可临时覆盖目标 namespace；角色 id 必须存在于 `manifest/roles.yaml`。

### 查看状态

```bash
teamai status        # 当前 scope、同步时间、资源统计
```

---

## 共享团队资源

### Skills（技能）

```bash
# 创建 skill
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: 帮助团队部署服务的自动化技能
tags: [deploy, automation]
---

# Deploy Helper
当用户请求部署时，按以下步骤执行：
1. 检查当前分支是否为 master
2. 运行测试 `npm test`
3. 构建 `npm run build`
4. 部署 `./deploy.sh`
EOF

# 推送到团队
teamai push

# 推送到指定角色 namespace
teamai push --role pm
```

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

AI 通过 Hooks 追踪你的编码会话。当检测到高价值会话（工具调用多样、涉及 skill 使用、有错误修复），会自动提醒：

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

## 进阶功能

### Dashboard

```bash
teamai dashboard             # 启动 Web 面板（默认端口 3721）
teamai dashboard --port 8080
```

实时查看团队成员的 AI 编码会话状态。

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
```

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

## 常见问题 FAQ

**Q: User scope 和 Project scope 可以共存吗？**

可以。`pull` 会依次拉取两个 scope，`recall` 会合并搜索两个 scope 的知识库。两者互不冲突。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。

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
