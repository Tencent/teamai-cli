<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli" width="430">
</p>

# TeamAI — The team harness for AI agents

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[![Discord](https://img.shields.io/discord/1234567890?label=Discord&logo=discord)](https://discord.gg/gervEZm58g)

💬 **用户讨论：** [Discord](https://discord.gg/gervEZm58g) | 🛠 **开发者交流：** [Discord](https://discord.gg/DeHHxPnfZF)

让每个 AI 编程助手都按同一套标准工作。

通过 Git 统一管理 skills、rules、docs，驾驭 20+ 种 AI 工具——一个人也能用，团队用更强。

**支持：** Claude Code、Codex、Cursor、CodeBuddy IDE，以及 Gemini CLI、Windsurf、Trae、Aider、Amp、OpenClaw 等 20+ 种 AI 编程工具（skills 同步）。

> 📖 **完整使用指南**：[docs/usage-guide.md](docs/usage-guide.md) — 涵盖从团队创建到日常使用的全流程。

> 📚 **Provider 说明**：[docs/providers.md](docs/providers.md) — GitHub / TGit 差异与认证配置。

## 安装

```bash
npm install -g teamai-cli
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com  # 腾讯内部
```

前置要求：Node.js 20+。更新：`npm update -g teamai-cli`

## 快速开始

### 团队成员

```bash
# 用户级初始化（默认，资源安装到 ~/ 下）
teamai init --repo yourteam/yourproject

# 项目级初始化（资源安装到项目目录下）
cd /path/to/my-project
teamai init --repo yourteam/yourproject --scope project

# 非交互模式（适用于 CI/CD 或 AI 自动化场景）
teamai init --repo yourteam/yourproject --scope user --role hai_dev --force
```

### 管理员

在 Git 托管平台（GitHub 或 TGit）创建共享经验仓库，授予团队成员写权限，然后让他们运行 `teamai init --repo <org>/<repo>`。

CLI 自动根据仓库 URL 选择 provider：

- `yourorg/yourrepo` 或 `https://github.com/yourorg/yourrepo` → GitHub
- `https://git.woa.com/yourteam/yourrepo` → TGit

### 只读消费者（HTTP 模式）

仅消费 skills/rules、无需 git 访问的用户：

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- 只读模式：`push` / `contribute` / `remove` 不可用。
- 无需 git clone——skills/rules 通过 report/sync/ack 生命周期按 session 下发。
- 支持的 agent 在 session 启动时自动上报已安装 skill 状态，并拉取服务端管理的安装/更新/卸载指令。

## 命令一览

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化：OAuth 登录、关联仓库、注册成员、注入 hooks |
| `teamai pull` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai push` | 推送本地资源到分支并创建合并请求 |
| `teamai status` | 显示本地与团队仓库的差异 |
| `teamai contribute` | 将 session 经验分享到团队仓库 |
| `teamai recall <query>` | 搜索团队知识库（BM25 + 图谱增强） |
| `teamai recall enable/disable/status` | 开关或查看 recall 状态 |
| `teamai import` | 导入知识（`--dir`、`--from-repo`、`--from-org`、`--from-repo-list`、`--from-mr`、`--from-iwiki`） |
| `teamai codebase --lint` | 知识图谱健康检查 |
| `teamai ci extract-mr --url <url>` | CI：从 MR 提取知识、发评论、合并后写入 |
| `teamai members` | 查看团队成员 |
| `teamai roles` | 管理团队角色和命名空间 |
| `teamai source` | 管理跨团队 skill 订阅 |
| `teamai remove <type> <name>` | 删除资源并创建 MR |
| `teamai digest` | 生成团队周报 |
| `teamai doctor` | 诊断配置问题 |
| `teamai uninstall` | 移除所有 teamai 资源和 hooks |

全局选项：`--dry-run`、`--verbose`

## 工作原理

```
teamai push → 创建分支 + MR → reviewer 审批合并
                                    ↓
           SessionStart hook → teamai pull → 同步到本地 AI 工具
```

TeamAI 将 skills、rules、docs 和 learnings 存储在共享 Git 仓库中。成员通过 `teamai push` 提交变更并创建合并请求供审核。合并后，`teamai pull`（通过 hooks 在 session 启动时自动触发）将最新资源同步到每位成员的本地 AI 工具。

Skills 同步到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.cursor/skills/`、`~/.codebuddy/skills/` 等目录。

## 角色化 Skills

Skills 按角色命名空间组织。`teamai init` 时选择 `primaryRole` 和可选的 `additionalRoles`，`teamai pull` 仅同步匹配的命名空间。

```yaml
# ~/.teamai/config.yaml
primaryRole: hai
additionalRoles:
  - pm
```

以上配置会同步 `skills/common/`、`skills/hai/`、`skills/pm/` 下的所有 skills。

推送时，CLI 自动检测可用命名空间并提示选择（或使用 `teamai push --role pm` 直接指定）。

## 团队知识检索

`teamai recall` 搜索团队积累的知识：

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
```

- 中英文混合搜索，BM25 + 图谱增强排名。
- 双 scope（用户 + 项目）合并结果，标注来源。
- 隐式投票：搜索自动提升匹配文档权重，优质文档自然上浮。

```bash
teamai recall enable     # 启用 recall + 部署 subagent
teamai recall disable    # 禁用 recall + 移除 subagent
teamai recall status     # 查看生效状态
```

## 代码知识图谱

`teamai import` 将源码仓库解析为 `teamwiki/` 下的结构化图谱，实现结构感知的检索：

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # 批量导入所有仓库
teamai codebase --lint                      # 健康检查
```

图谱存储组件、接口、配置和跨仓库依赖边。`teamai recall` 利用图谱进行增强排名。

## 自动经验沉淀

Session 结束时，Stop hook 对 session 价值评分（工具多样性、skill 使用、错误处理、时长）。达标后 AI 会建议：

```
建议运行 /teamai-share-learnings 总结本次 session 的经验并分享给团队。
```

`/teamai-share-learnings` skill 自动总结 session 经验并推送到团队仓库。每个 session 最多提示一次。

## 团队 Hooks

在 `hooks/hooks.yaml` 中声明自定义 hooks，`teamai pull` 自动分发到所有 AI 工具：

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    tools: [claude, cursor]
```

```bash
teamai hooks list      # 查看生效的 hooks
teamai hooks inject    # 强制重新注入到所有工具
teamai hooks remove    # 移除所有 teamai 管理的 hooks
```

## 跨团队 Skill 订阅

### Git 源

订阅其他团队的公开 skill 仓库：

```bash
teamai source add https://github.com/other-team/teamai-public.git --name other-team
teamai source list
teamai source browse other-team    # 浏览可用 skills
teamai source remove other-team
```

订阅的 skills 在 `teamai pull` 时自动同步。

### HTTP 源

在已有 git 主仓的基础上附加 HTTP 源——适用于服务端管理的 skill 下发，无需修改主仓：

```bash
teamai source add-http https://your-team-host/api --token <api-key>
teamai source list            # 在 "HTTP source" 下显示
teamai source remove-http     # 解绑并卸载其资源
```

HTTP 源通过 hook dispatch 在每次 session 中上报状态并拉取 skill 指令。每个安装仅支持一个 HTTP 源。

## CI 集成

`teamai ci extract-mr` 接入 CI，从每个 MR 自动提取知识：

```bash
# 以评论形式发布建议（PR 打开/更新时）
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# 合并后写入知识库
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo
```

开箱即用模板：`examples/ci/github-actions-mr-extract.yml`（GitHub Actions）、`examples/ci/coding-ci-mr-extract.yaml`（Coding CI）。

## 许可证

[MIT](LICENSE)

## 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。
