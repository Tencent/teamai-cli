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
| Qoder | `~/.qoder` | written; reads ? | `~/.qoder/rules` v | `~/.qoder/rules` s | `~/.qoder/agents` s | `~/.qoder/settings.json` s | `~/.qoder/settings.json` s | — |
| Qoder CN | `~/.qoder-cn` | written; reads ? | `~/.qoder-cn/rules` v | `~/.qoder-cn/rules` t | `~/.qoder-cn/agents` s | `~/.qoder-cn/settings.json` s | `~/.qoder-cn/settings.json` s | — |
| Kiro | `~/.kiro` | written; reads ? | `~/.kiro/steering` d | `~/.kiro/steering` d | `~/.kiro/agents` d | kiro-hooks d | `~/.kiro/settings/mcp.json` d | — |
| Trae | `~/.trae` | written; reads ? | written; reads ? | `~/.trae/user_rules` d | ? | ? | — | — |
| Trae CN | `~/.trae-cn` | written; reads ? | written; reads ? | `~/.trae-cn/user_rules` d | `~/.trae-cn/agents` d | ? | — | — |
| ZCode | `~/.zcode` | written; reads ? | in the blocks file (ZCode AGENTS.md) | `~/.zcode/AGENTS.md` s | `~/.zcode/agents` s | `~/.zcode/cli/config.json` s | `~/.zcode/cli/config.json` s | — |
| Oh My Pi | `~/.omp/agent` `~/$PI_CONFIG_DIR/agent` `~/$PI_CONFIG_DIR/profiles/$OMP_PROFILE/agent` (or `$PI_PROFILE`) | `~/.omp/agent/skills` v | `~/.omp/agent/rules` v | `~/.omp/agent/RULES.md` v | `~/.omp/agent/agents` v | omp-extension v | `~/.omp/agent/mcp.json` v | — |
| Pi Coding Agent | `~/.pi/agent` `$PI_CODING_AGENT_DIR` | `~/.pi/agent/skills` v | in the blocks file (Pi AGENTS.md) | `~/.pi/agent/AGENTS.override.md` v<br>`~/.pi/agent/AGENTS.md` v | — | pi-extension v | `~/.pi/agent/mcp.json` v | — |
| CodeBuddy | `~/.codebuddy` `$CODEBUDDY_CONFIG_DIR` | `~/.codebuddy/skills` v | `~/.codebuddy/rules` v | `~/.codebuddy/CODEBUDDY.md` s | `~/.codebuddy/agents` s | `~/.codebuddy/settings.json` s | first of `~/.codebuddy/.mcp.json`, `~/.codebuddy/mcp.json`, `~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set) s | codebuddy |
| OpenClaw | `~/.openclaw` `$OPENCLAW_STATE_DIR` `$OPENCLAW_HOME/.openclaw[-$OPENCLAW_PROFILE]` | written; reads ? | in the blocks file (OpenClaw workspace AGENTS.md) | written; reads ? | — | openclaw-hook v | — | — |
| Hermes | `~/.hermes` `$HERMES_HOME` `~/.hermes$HERMES_DATA_DIR_SUFFIX` `%LOCALAPPDATA%\hermes$HERMES_DATA_DIR_SUFFIX` `<home>/profiles/<active_profile>` | `~/.hermes/skills` s | in the blocks file (Hermes SOUL.md) | `~/.hermes/SOUL.md` s | — | hermes-plugin v | — | — |
| DeepSeek Harness | `~/.dsh` `$DSH_HOME` | `~/.dsh/skills` v | in the blocks file (DeepSeek Harness AGENTS.md) | `~/.dsh/AGENTS.md` s | — | dsh-hooks s | — | — |
| WorkBuddy | `~/.workbuddy` | written; reads ? | `~/.workbuddy/rules` t | `~/.workbuddy/rules` t | `~/.workbuddy/agents` t | `~/.workbuddy/settings.json` t | first of `~/.workbuddy/.mcp.json`, `~/.workbuddy/mcp.json`, `~/.codebuddy.json` (in `$CODEBUDDY_CONFIG_DIR` when set) s | workbuddy |
| OpenCode | `~/.config/opencode` `$OPENCODE_CONFIG_DIR` `$XDG_CONFIG_HOME/opencode` | `~/.config/opencode/skills` v<br>`~/.claude/skills` v | `~/.config/opencode/rules` v | `~/.config/opencode/teamai-context.md` v | `~/.config/opencode/agents` v | opencode-plugin s | `~/.config/opencode/opencode.json` v | opencode |
| Muse Code | `~/.config/muse` `$XDG_CONFIG_HOME/muse` | `~/.config/muse/skills` v<br>`~/.agents/skills` v<br>`~/.claude/skills` v | in the blocks file (Muse Code AGENTS.md) | `~/.config/muse/AGENTS.md` v | `~/.config/muse/agents` s | `~/.config/muse/settings.json` v | `~/.config/muse/settings.json` s | — |
| Antigravity | `~/.gemini/config` | `~/.gemini/config/skills` v<br>`~/.agents/skills` v | `~/.gemini/config/rules` v | `~/.gemini/config/rules` v | `~/.gemini/config/agents` v | agy-hooks v | `~/.gemini/config/mcp_config.json` v | agy |

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
| Qoder | written; reads ? | `.qoder/rules` v | `.qoder/rules` s | `.qoder/agents` s | `.qoder/settings.json` s cwd only | `.qoder/settings.json` s |
| Qoder CN | written; reads ? | `.qoder/rules` v | `.qoder/rules` t | `.qoder/agents` t | `.qoder/settings.json` s cwd only | `.qoder/settings.json` t |
| Kiro | written; reads ? | `.kiro/steering` d | `.kiro/steering` d | `.kiro/agents` d | user hooks | `.kiro/settings/mcp.json` d |
| Trae | written; reads ? | `.trae/rules` t | `.trae/rules` d | `.trae/agents` s cwd only | ? | `.trae/mcp.json` d |
| Trae CN | written; reads ? | `.trae/rules` t | `.trae/rules` d | `.trae/agents` s cwd only | ? | `.trae/mcp.json` d |
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
| Antigravity | `.agents/skills` v | `.agents/rules` v | `.agents/rules` v | `.agents/agents` v | user hooks | `.agents/plugins/teamai/mcp_config.json` v |

## 运行时与 teamai 自身的 AI

用户范围，取自 #1221 的矩阵；之后合入的修复标为 `t` 并附注。`✓` 可用。`◐` 默认可用，但某个条件会让它失效，而 doctor 仍报告已送达。`✗` 默认配置下不可用。`+` 工具支持，teamai 尚未实现。`—` 工具没有此功能。`?` 未知。标记后的字母是依据，含义同上。

| 工具 | 环境变量 | Recall | 统计 | AI 后端 | 投票评审 | HTTP agent hooks |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | ✓t | ✓v | ✓v | ✓v | ✓v | ✓v |
| Codex CLI | ✓t | ✓v | ✓t<sup>1</sup> | ✓v | ✓t<sup>2</sup> | ✓t<sup>3</sup> |
| Codex CLI Internal | ? | ? | ? | ✓t | ? | ? |
| Claude Code Internal | ? | ? | ? | ✓t | ? | ? |
| TClaude | ? | ? | ? | ✓t | ? | ? |
| TCodex | ? | ? | ? | ✓t | ? | ? |
| Cursor | ? | ✗v<sup>4</sup> | ✓v<sup>5</sup> | ✓d | +s | +t<sup>6</sup> |
| Copilot | ? | ✓v | ✓t<sup>1</sup> | ✓d | ? | —t |
| JoyCode | ? | ◐s | ? | ? | ? | ? |
| Qoder | ? | ◐s | ✓s | ✓d | ? | ✓s |
| Qoder CN | ? | ◐s | ✓s | ? | ? | ✓t<sup>7</sup> |
| Kiro | ? | ◐d | ? | ✓d | ? | ✓d<sup>8</sup> |
| Trae | ? | ? | ? | ? | ? | ? |
| Trae CN | ? | ? | ? | ? | ? | ? |
| ZCode | ✓t | ✓s | ✓s | +s | ✓t<sup>2</sup> | +t<sup>9</sup> |
| Oh My Pi | ✓s | ✓v | ✓t<sup>1</sup> | ✓d | ? | ✓s<sup>10</sup> |
| Pi Coding Agent | ✓s | ✓v | ✓t<sup>1</sup> | ✓s | ? | ✓s<sup>11</sup> |
| CodeBuddy | ? | ✓s | ✓v | ✓d | +v | ✓s |
| OpenClaw | ◐d | ✓s | +s | ✓d | —t | ✓s<sup>12</sup> |
| Hermes | ◐s | ✓v | +s | ✓s | —t | ✓s<sup>13</sup> |
| DeepSeek Harness | ✗s | ✓s | ✓t<sup>1</sup> | +s | ? | —t |
| WorkBuddy | ? | ✓t | ? | ✓t | ? | ? |
| OpenCode | ? | ✓v | ✓t<sup>1</sup> | ✓v | ? | ✓v<sup>14</sup> |
| Muse Code | ✓t | ✓t | ✓v | ✓v | ✓t<sup>2</sup> | ✓t<sup>15</sup> |
| Antigravity | ✓v<sup>16</sup> | ✓v | ✓v | ✓v | ✗v<sup>17</sup> | ✓t<sup>18</sup> |

注：

1. A1 (#1245) records its skill loads; not rerun
2. #1374 judges the reply in its Stop payload; not rerun
3. #1224 runs the Codex trust pass; not rerun
4. Cursor IDE: ✓v
5. Cursor IDE: ✓t
6. teamai refuses agent hooks in the Cursor hook format
7. #1224 writes ~/.qoder-cn/settings.json; not rerun
8. runs from teamai's team-hook bridge, which can block a tool call; Kiro's hook docs
9. refused until teamai writes the hooks.events shape (#1224)
10. runs from teamai's team-hook bridge, which can block a tool call; OMP's extension source
11. runs from teamai's team-hook bridge, which can block a tool call; Pi's extension source
12. runs from teamai's team-hook bridge, which can block a tool call; OpenClaw's plugin source
13. runs from teamai's team-hook bridge, which can block a tool call; Hermes's shell-hook source
14. runs from teamai's team-hook bridge, which can block a tool call; OpenCode 1.18.23 ran a team hook through it
15. #1224 writes them to settings.json; not rerun
16. agy 1.4.8 run_command inherits the environment agy starts in
17. agy 1.4.8 PostToolUse carries no tool output, so a teamai recall run never reaches the recall log
18. runs from teamai's team-hook bridge, which can block a tool call; the dispatcher hands it a Claude payload
