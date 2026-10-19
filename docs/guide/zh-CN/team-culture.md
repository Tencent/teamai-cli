# 团队文化

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

在团队仓库根目录放 `culture.md`。`teamai pull` 把它写进已安装的 AI 工具，标记之外的内容不动。

## 创建 culture.md

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  values:
    - Innovation
team:
  name: Platform Team
  mission: Enable developers to ship faster
---
```

`company.name` 和 `team.name` 必填。frontmatter 后面的正文会原样注入。

### 这些块写到哪里

不写进项目的 `AGENTS.md`。每个工具用自己的文件，或在会话开始时加进去：

| 工具 | 用户范围 | 工作区范围 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `.claude/rules/teamai-context.md` |
| Codex 系列 | `$CODEX_HOME/AGENTS.md` | session-start hook |
| Cursor | `~/.cursor/rules/teamai-context.mdc`；工作区不在主目录下时由 session-start hook 加入 | `.cursor/rules/teamai-context.mdc` |
| CodeBuddy、WorkBuddy | 各自的用户文件 | 共用 `.codebuddy/rules/teamai-context.md` |
| OpenCode | `~/.config/opencode/teamai-context.md` | `.opencode/teamai-context.md` |
| Pi、Oh My Pi | 各自的用户文件 | 扩展加进系统提示 |
| Hermes | `$HERMES_HOME/SOUL.md` | Hermes 插件 |
| ZCode | `~/.zcode/AGENTS.md` | 仅 `toolPaths` 里配置的 `claudemd` |
| DeepSeek Harness | `$DSH_HOME/AGENTS.md`（未设置时 `~/.dsh/AGENTS.md`） | 仅 `toolPaths` 里配置的 `claudemd` |
| JoyCode | `~/.joycode/rules.txt` | 仅 `toolPaths` 里配置的 `claudemd` |
| Muse Code | `~/.config/muse/AGENTS.md` | 仅 `toolPaths` 里配置的 `claudemd` |

## 查看效果

```bash
teamai pull
```

文件里会出现 `<!-- [teamai:culture:start] -->` 到 `<!-- [teamai:culture:end] -->` 这一段。
