# Team Culture

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

Put `culture.md` at the root of the team repo. `teamai pull` writes it into each installed AI tool and leaves everything outside the markers alone.

## Creating culture.md

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

`company.name` and `team.name` are required. Markdown after the frontmatter is included as written.

### Where the blocks go

They are not written into the project's `AGENTS.md`. Each tool gets its own file, or the text is added when a session starts:

| Tool | User scope | Workspace scope |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `.claude/rules/teamai-context.md` |
| Codex family | `$CODEX_HOME/AGENTS.md` | session-start hook |
| Cursor | `~/.cursor/rules/teamai-context.mdc`; in a workspace outside the home directory, the session-start hook | `.cursor/rules/teamai-context.mdc` |
| CodeBuddy, WorkBuddy | each tool's user file | one shared `.codebuddy/rules/teamai-context.md` |
| OpenCode | `~/.config/opencode/teamai-context.md` | `.opencode/teamai-context.md` |
| Pi, Oh My Pi | each tool's user file | an extension adds them to the system prompt |
| Hermes | `$HERMES_HOME/SOUL.md` | the Hermes plugin |
| ZCode | `~/.zcode/AGENTS.md` | only a `claudemd` named in `toolPaths` |
| DeepSeek Harness | `$DSH_HOME/AGENTS.md` (`~/.dsh/AGENTS.md` when unset) | only a `claudemd` named in `toolPaths` |
| JoyCode | `~/.joycode/rules.txt` | only a `claudemd` named in `toolPaths` |
| Muse Code | `~/.config/muse/AGENTS.md` | only a `claudemd` named in `toolPaths` |

## Viewing the result

```bash
teamai pull
```

The file then contains a block from `<!-- [teamai:culture:start] -->` to `<!-- [teamai:culture:end] -->`.
