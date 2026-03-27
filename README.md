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
| `teamai status` | 查看本地 vs 团队仓库差异 |
| `teamai list [type]` | 列出资源（skills\|rules\|docs） |
| `teamai members` | 列出已注册的团队成员 |
| `teamai remove <type> <name>` | 从团队仓库和本地删除资源并创建 MR（skills\|rules） |
| `teamai contribute --file <path>` | 将 AI 生成的经验文档推送到团队仓库 ai-docs/ |
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
- Docs 同步到 `~/.teamai/docs/`

## 经验自动分享

当一次 AI coding session 使用超过 100 次工具调用时，系统会智能评估 session 价值并提示分享：

```
AI coding session (持续工作中...)
    │
    ▼  PostToolUse hook 每次工具调用自动计数
    │
    ├─ < 100 次 → 静默计数（~1ms，不影响性能）
    │
    ▼  达到 100 次
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
    └─ teamai contribute --file <path> → 直接 push 到团队仓库 ai-docs/
```

- `/teamai-share-learnings` 是 CLI 内置 skill，随 `teamai pull/init` 自动部署到本地
- 每个 session 最多提示一次（去重），用户可以忽略
- 文档直接 push 到 master 的 `ai-docs/` 目录，团队成员下次 pull 时可见

## 更新

```bash
npm update -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```
