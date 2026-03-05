# teamai — Team AI DevKit

团队 AI 经验共享框架。自动在团队成员之间同步 skills、rules、docs、hooks 等 AI 工具配置。

## 安装

```bash
npm install -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com
```

<details>
<summary>从源码安装</summary>

```bash
git clone https://git.woa.com/teamai/teamai-cli.git ~/.teamai/teamai-cli \
  && cd ~/.teamai/teamai-cli && npm install && npm run build && npm link
```

</details>

## 前置条件

设置 TGit Personal Access Token（需要 `api` 权限）：

```bash
# 获取 token: https://git.woa.com/profile/account
# bash 用户
echo 'export TGIT_TOKEN=your_token_here' >> ~/.bashrc && source ~/.bashrc
# zsh 用户 (macOS 默认)
echo 'export TGIT_TOKEN=your_token_here' >> ~/.zshrc && source ~/.zshrc
```

## 快速开始

```bash
# 1. 初始化（关联团队仓库、注册成员、注入 hooks）
teamai init --repo yourteam/yourproject

# 2. 拉取团队资源
teamai pull

# 3. 推送本地新 skills 到团队
teamai push

# 4. 查看状态
teamai status
```

## 命令

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化（TGit 认证、关联仓库、注册成员、注入 hooks） |
| `teamai push [--all]` | 推送本地新资源到团队仓库 |
| `teamai pull [--silent]` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai sync` | 双向同步（push + pull） |
| `teamai status` | 查看本地 vs 团队仓库差异 |
| `teamai list [type]` | 列出资源（skills\|rules\|hooks\|docs\|instincts） |
| `teamai members` | 列出已注册的团队成员 |
| `teamai remove <type> <name>` | 从团队仓库和本地删除资源（skills\|rules） |
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
    └──────► TGit 团队仓库 ◄──────────────┘
                  │
                  ▼ SessionStart hook → teamai pull --silent
             自动拉取到所有成员本地
```

- `teamai init` 会自动注入 SessionStart hook，每次启动 AI 工具会话时自动拉取团队最新内容
- Skills 同步到 `~/.claude/skills/`、`~/.codex/skills/`、`~/.claude-internal/skills/`、`~/.cursor/skills-cursor/`
- Rules 同步到各工具的 rules 目录，并通过标记注释合并到 `CLAUDE.md`（支持 claude、claude-internal）
- Docs 同步到 `~/.teamai/docs/`

## 更新

```bash
# tnpm 安装的用户
npm update -g @tencent/teamai-cli --registry=http://r.tnpm.oa.com

# 源码安装的用户
cd ~/.teamai/teamai-cli && git pull && npm install && npm run build
```
