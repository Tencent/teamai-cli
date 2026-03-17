# TeamAI — 团队 AI 经验共享框架

团队 AI 经验共享框架。自动在团队成员之间同步 skills、rules、docs 等 AI 工具配置。
## 如有问题或建议，欢迎提交 PR 或 Issue，一起共建这个项目
## 安装

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```

## 快速开始

### 团队成员

```bash
# 初始化（关联团队仓库、注册成员、注入 hooks）
teamai init --repo yourteam/yourproject
```

### 管理员

需要先在 git.woa.com 上创建好团队共享经验的仓库，并把所有团队的成员都加入到 master(可通过 user group 快捷添加)

## 命令

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化（自动安装 gf CLI、OAuth 登录、关联仓库、注册成员、配置 reviewers、注入 hooks） |
| `teamai push [--all]` | 推送本地新资源到独立分支并创建 Merge Request |
| `teamai pull [--silent]` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai sync` | 双向同步（push + pull） |
| `teamai status` | 查看本地 vs 团队仓库差异 |
| `teamai list [type]` | 列出资源（skills\|rules\|docs） |
| `teamai members` | 列出已注册的团队成员 |
| `teamai remove <type> <name>` | 从团队仓库和本地删除资源并创建 MR（skills\|rules） |
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
             SessionStart hook → teamai pull --silent
             自动拉取到所有成员本地
```

- `teamai push` 会创建独立分支（`teamai/push/<user>/<timestamp>`），推送后自动创建 Merge Request 并指派 reviewers
- `teamai init` 初始化时可配置默认 reviewers（记录在 `teamai.yaml` 的 `reviewers` 字段）
- `teamai init` 会自动注入 SessionStart hook，每次启动 AI 工具会话时自动拉取团队最新内容（支持 Claude Code、Codex、Claude Code Internal、Cursor、CodeBuddy IDE）
- Skills 同步到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.claude-internal/skills/`、`~/.cursor/skills/`、`~/.codebuddy/skills/`
- Rules 同步到各工具的 rules 目录，并通过标记注释合并到 `CLAUDE.md`（支持 claude、claude-internal、codebuddy）
- Docs 同步到 `~/.teamai/docs/`

## 更新

```bash
npm update -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```
