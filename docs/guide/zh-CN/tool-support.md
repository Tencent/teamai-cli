# 工具支持

teamai 为每个工具把每类资源写到哪里，以及工具读取哪里，以 teamai 的工具描述（`src/tools.ts`）为准。

此文件由生成器生成，请勿手动编辑。修改描述后运行 `npx vitest run tool-support -u` 重新生成。

- 路径是工具读取的位置，后面是依据：`v` 真实运行过该工具，或在 teamai 的输出上运行过工具自己的加载器；`s` 工具源码；`d` 工具文档；`t` 仅 teamai 自身代码。
- `—` teamai 不写入：工具没有这个通道，或 teamai 不使用它。`?` 未知：teamai 不写入。`written; reads ?`：teamai 写入配置的路径，但工具从哪里读取未知。
- 主目录会随其后列出的变量移动，`~/<主目录>` 下的路径也跟着移动。

## 用户范围

| 工具 | 主目录 | 技能 | 规则 | 指令块 | Agents | Hooks | MCP | 会话 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `~/.claude/skills` d | `~/.claude/rules` v | `~/.claude/CLAUDE.md` v | `~/.claude/agents` v | `~/.claude/settings.json` v | `~/.claude.json` v | claude-code |
| Codex CLI | `~/.codex` | `~/.codex/skills` v<br>`~/.agents/skills` v | in the blocks file (Codex AGENTS.md) | `~/.codex/AGENTS.md` v | `~/.codex/agents` v | `~/.codex/hooks.json` v | `~/.codex/config.toml` v | codex |
| Codex CLI Internal | `~/.codex-internal` | written; reads ? | in the blocks file (Codex AGENTS.md) | written; reads ? | written; reads ? | `~/.codex-internal/hooks.json` t | ? | codex-internal |
| Claude Code Internal | `~/.claude-internal` | written; reads ? | written; reads ? | written; reads ? | written; reads ? | `~/.claude-internal/settings.json` t | ? | claude-internal |
| TClaude | `~/.tclaude` | written; reads ? | written; reads ? | written; reads ? | written; reads ? | `~/.tclaude/settings.json` t | written; reads ? | tclaude |
| TCodex | `~/.tcodex` | written; reads ? | in the blocks file (Codex AGENTS.md) | written; reads ? | written; reads ? | `~/.tcodex/hooks.json` t | ? | tcodex |
| Cursor | `~/.cursor` | written; reads ? | `~/.cursor/rules` v from a session under ~ | `~/.cursor/rules` v from a session under ~ | `~/.cursor/agents` s | `~/.cursor/hooks.json` s | `~/.cursor/mcp.json` s | cursor |
| Copilot | `~/.copilot` `$COPILOT_HOME` | `~/.copilot/skills` v | `~/.copilot/instructions` v | `~/.copilot/copilot-instructions.md` v | `~/.copilot/agents` s | `~/.copilot/hooks/teamai.json` s | `~/.copilot/mcp-config.json` v | — |
| JoyCode | `~/.joycode` | written; reads ? | in the blocks file (JoyCode rules.txt) | `~/.joycode/rules.txt` s | written; reads ? | — | — | ? |
| Qoder | `~/.qoder` | written; reads ? | `~/.qoder/rules` v | — | `~/.qoder/agents` s | `~/.qoder/settings.json` s | `~/.qoder/settings.json` s | — |
| Qoder CN | `~/.qoder-cn` | written; reads ? | `~/.qoder-cn/rules` v | — | `~/.qoder-cn/agents` s | `~/.qoder-cn/settings.json` s | `~/.qoder-cn/settings.json` s | — |
| Kiro | `~/.kiro` | written; reads ? | `~/.kiro/steering` d | — | `~/.kiro/agents` d | kiro-hooks d | `~/.kiro/settings/mcp.json` d | — |
| Trae | `~/.trae` | written; reads ? | written; reads ? | — | ? | ? | — | — |
| Trae CN | `~/.trae-cn` | written; reads ? | written; reads ? | — | ? | ? | — | — |
| ZCode | `~/.zcode` | written; reads ? | in the blocks file (ZCode AGENTS.md) | `~/.zcode/AGENTS.md` s | `~/.zcode/agents` s | `~/.zcode/cli/config.json` s | `~/.zcode/cli/config.json` s | — |
| Oh My Pi | `~/.omp` | `~/.omp/agent/skills` v | `~/.omp/agent/rules` v | `~/.omp/agent/RULES.md` v | `~/.omp/agent/agents` v | omp-extension v | `~/.omp/agent/mcp.json` v | — |
| Pi Coding Agent | `~/.pi/agent` `$PI_CODING_AGENT_DIR` | `~/.pi/agent/skills` v | in the blocks file (Pi AGENTS.md) | `~/.pi/agent/AGENTS.override.md` v<br>`~/.pi/agent/AGENTS.md` v | — | pi-extension v | `~/.pi/agent/mcp.json` v | — |
| CodeBuddy | `~/.codebuddy` `$CODEBUDDY_CONFIG_DIR` | `~/.codebuddy/skills` v | `~/.codebuddy/rules` v | `~/.codebuddy/CODEBUDDY.md` s | `~/.codebuddy/agents` s | `~/.codebuddy/settings.json` s | first of `~/.codebuddy/.mcp.json`, `~/.codebuddy/mcp.json`, `~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set) s | codebuddy |
| OpenClaw | `~/.openclaw` `$OPENCLAW_STATE_DIR` `~/.openclaw-$OPENCLAW_PROFILE` | written; reads ? | in the blocks file (OpenClaw workspace AGENTS.md) | written; reads ? | — | openclaw-hook v | — | — |
| Hermes | `~/.hermes` `$HERMES_HOME` `%LOCALAPPDATA%\hermes` | `~/.hermes/skills` s | in the blocks file (Hermes SOUL.md) | `~/.hermes/SOUL.md` s | — | hermes-plugin v | — | — |
| DeepSeek Harness | `~/.dsh` `$DSH_HOME` | `~/.dsh/skills` v | in the blocks file (DeepSeek Harness AGENTS.md) | `~/.dsh/AGENTS.md` s | — | dsh-hooks s | — | — |
| WorkBuddy | `~/.workbuddy` | written; reads ? | `~/.workbuddy/rules` t | `~/.workbuddy/rules` t | `~/.workbuddy/agents` t | `~/.workbuddy/settings.json` t | first of `~/.workbuddy/.mcp.json`, `~/.workbuddy/mcp.json`, `~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set) s | workbuddy |
| OpenCode | `~/.config/opencode` `$OPENCODE_CONFIG_DIR` `$XDG_CONFIG_HOME/opencode` | `~/.config/opencode/skills` v<br>`~/.claude/skills` v | `~/.config/opencode/rules` v | `~/.config/opencode/teamai-context.md` v | `~/.config/opencode/agents` v | opencode-plugin s | `~/.config/opencode/opencode.json` v | opencode |
| Muse Code | `~/.config/muse` `$XDG_CONFIG_HOME/muse` | `~/.config/muse/skills` v<br>`~/.agents/skills` v<br>`~/.claude/skills` v | in the blocks file (Muse Code AGENTS.md) | `~/.config/muse/AGENTS.md` v | `~/.config/muse/agents` s | `~/.config/muse/settings.json` v | `~/.config/muse/settings.json` s | — |

## 项目范围

路径相对于项目根目录。`cwd only`：只有在根目录启动的会话才会读取。Hooks 一列是 self 模式写入的位置；`user hooks` 表示沿用用户范围的 hooks。

| 工具 | 技能 | 规则 | 指令块 | Agents | Hooks | MCP |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | written; reads ? | `.claude/rules` v | `.claude/rules` v | `.claude/agents` v | `.claude/settings.json` v<br>`.claude/settings.local.json` v | `.mcp.json` v |
| Codex CLI | written; reads ? | session hook v | session hook v | `.codex/agents` v | `.codex/hooks.json` v | `.codex/config.toml` v |
| Codex CLI Internal | written; reads ? | session hook t | session hook t | written; reads ? | written; reads ? | ? |
| Claude Code Internal | written; reads ? | written; reads ? | written; reads ? | written; reads ? | written; reads ? | ? |
| TClaude | written; reads ? | written; reads ? | written; reads ? | written; reads ? | written; reads ? | `.mcp.json` t |
| TCodex | written; reads ? | session hook t | session hook t | written; reads ? | written; reads ? | ? |
| Cursor | written; reads ? | `.cursor/rules` v | `.cursor/rules` v | `.cursor/agents` v | `.cursor/hooks.json` s | `.cursor/mcp.json` s |
| Copilot | `.github/skills` v | `.github/instructions` v | `.github/copilot-instructions.md` v<br>`.github/instructions` v | `.github/agents` s | `.github/hooks/teamai.json` s | `.github/mcp.json` v |
| JoyCode | written; reads ? | `.joycode/rules` v | — | written; reads ? | — | — |
| Qoder | written; reads ? | `.qoder/rules` v | — | `.qoder/agents` s | `.qoder/settings.json` s cwd only | `.qoder/settings.json` s |
| Qoder CN | written; reads ? | `.qoder/rules` v | — | `.qoder/agents` t | `.qoder/settings.json` s cwd only | `.qoder/settings.json` t |
| Kiro | written; reads ? | `.kiro/steering` d | — | `.kiro/agents` d | user hooks | `.kiro/settings/mcp.json` d |
| Trae | written; reads ? | `.trae/rules` t | — | ? | ? | `.trae/mcp.json` d |
| Trae CN | written; reads ? | `.trae/rules` t | — | ? | ? | `.trae/mcp.json` d |
| ZCode | written; reads ? | session hook s | session hook s | `.zcode/agents` s cwd only | user hooks | `.zcode/config.json` s |
| Oh My Pi | written; reads ? | `.omp/rules` v cwd only | extension v | `.omp/agents` v | user hooks | `.omp/mcp.json` v cwd only |
| Pi Coding Agent | `.pi/skills` v cwd only | extension v | extension v | — | user hooks | `.pi/mcp.json` v cwd only |
| CodeBuddy | written; reads ? | `.codebuddy/rules` s cwd only | `.codebuddy/rules` s cwd only | `.codebuddy/agents` s cwd only | `.codebuddy/settings.json` s cwd only | first of `.mcp.json`, `mcp.json` s cwd only |
| OpenClaw | written; reads ? | — | — | — | user hooks | — |
| Hermes | `~/.hermes/skills` s | — | plugin s | — | user hooks | — |
| DeepSeek Harness | written; reads ? | session hook s | session hook s | — | user hooks | — |
| WorkBuddy | written; reads ? | written; reads ? | written; reads ? | `.workbuddy/agents` t cwd only | written; reads ? | first of `.mcp.json`, `mcp.json` s cwd only |
| OpenCode | `.opencode/skills` v<br>`.claude/skills` v | `.opencode/rules` v | `.opencode/teamai-context.md` v | `.opencode/agents` v | user hooks | `opencode.json` v<br>`.opencode/teamai-mcp.json` v |
| Muse Code | `.agents/skills` v | session hook v | session hook v | written; reads ? | `.muse/hooks.json` v | `.mcp.json` s |

## 运行时与 teamai 自身的 AI

用户范围，取自 #1221 的矩阵；之后合入的修复标为 `t` 并附注。`✓` 可用。`◐` 默认可用，但某个条件会让它失效，而 doctor 仍报告已送达。`✗` 默认配置下不可用。`+` 工具支持，teamai 尚未实现。`—` 工具没有此功能。`?` 未知。标记后的字母是依据，含义同上。

| 工具 | 环境变量 | 工作流 | Recall | 统计 | AI 后端 | 投票评审 | HTTP agent hooks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | ✓t | ✓v | ✓v | ✓v | ✓v | ✓v | ✓v |
| Codex CLI | ✓t | ✓t | ✓v | ✓t<sup>1</sup> | ✓v | ✓t<sup>2</sup> | ✓t<sup>3</sup> |
| Codex CLI Internal | ? | ? | ? | ? | ✓t | ? | ? |
| Claude Code Internal | ? | ? | ? | ? | ✓t | ? | ? |
| TClaude | ? | ? | ? | ? | ✓t | ? | ? |
| TCodex | ? | ? | ? | ? | ✓t | ? | ? |
| Cursor | ? | +s<sup>4</sup> | ✗v<sup>5</sup> | ✓v<sup>6</sup> | +s | +s | +t<sup>7</sup> |
| Copilot | ? | +s | ✓v | ✓t<sup>1</sup> | +s | ? | —t |
| JoyCode | ? | ? | ◐s | ? | ? | ? | ? |
| Qoder | ? | ? | ◐s | ✓s | ? | ? | ✓s |
| Qoder CN | ? | ? | ◐s | ✓s | ? | ? | ✓t<sup>8</sup> |
| Kiro | ? | ? | ◐d | ? | ? | ? | ? |
| Trae | ? | ? | ? | ? | ? | ? | ? |
| Trae CN | ? | ? | ? | ? | ? | ? | ? |
| ZCode | ✓t | +s | ✓s | ✓s | +s | ✓t<sup>2</sup> | +t<sup>9</sup> |
| Oh My Pi | ✓s | +s | ✓v | ✓t<sup>1</sup> | +s | ? | —t |
| Pi Coding Agent | ✓s | +v | ✓v | ✓t<sup>1</sup> | +v | ? | ? |
| CodeBuddy | ? | +t | ✓s | ✓v | ? | +v | ✓s |
| OpenClaw | ◐d | +d | ✓s | +s | ✓t<sup>10</sup> | —t | ◐s |
| Hermes | ◐s | +s | ✓v | +s | +s | —t | ✓t<sup>11</sup> |
| DeepSeek Harness | ✗s | +s | ✓s | ✓t<sup>1</sup> | +s | ? | —t |
| WorkBuddy | ? | ? | ✓t | ? | ? | ? | ? |
| OpenCode | ? | ✓t | ✓v | ✓t<sup>1</sup> | +v | ? | ◐t |
| Muse Code | ✓t | +v | ✓t | ✓v | +v | ✓t<sup>2</sup> | ✓t<sup>12</sup> |

注：

1. A1 (#1245) records its skill loads; not rerun
2. #1374 judges the reply in its Stop payload; not rerun
3. #1224 runs the Codex trust pass; not rerun
4. Cursor IDE: —
5. Cursor IDE: ✓v
6. Cursor IDE: ✓t
7. teamai refuses agent hooks in the Cursor hook format
8. #1224 writes ~/.qoder-cn/settings.json; not rerun
9. refused until teamai writes the hooks.events shape (#1224)
10. runs `openclaw agent --message`; each call leaves a session behind (#1308)
11. #1224 maps the events to Hermes's; not rerun
12. #1224 writes them to settings.json; not rerun
