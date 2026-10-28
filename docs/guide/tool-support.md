# Tool support

Where teamai writes each resource for each tool, and what the tool reads, as teamai's tool descriptor (`src/tools.ts`) records it.

Generated: do not edit by hand. Regenerate with `npx vitest run tool-support -u` after changing the descriptor.

- A path is the place the tool reads, then the evidence for it: `v` a real tool run, or the tool's own loader run on teamai's output; `s` the tool's source; `d` its docs; `t` teamai's code only.
- `—` teamai writes nothing there: the tool has no such channel, or teamai does not use it. `?` unknown: teamai writes nothing there. `written; reads ?`: teamai writes the configured path, and where the tool reads is unknown.
- A home moves with the variable after it. A path under `~/<home>` follows the move.

## User scope

| Tool | Home | Skills | Rules | Instruction blocks | Agents | Hooks | MCP | Sessions |
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
| Trae CN | `~/.trae-cn` | written; reads ? | written; reads ? | — | `~/.trae-cn/agents` d | ? | — | — |
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

## Project scope

Paths are relative to the project root. `cwd only`: the tool reads it only from a session started at the root. Hooks are the ones self mode writes; `user hooks` means it keeps the user-scope ones.

| Tool | Skills | Rules | Instruction blocks | Agents | Hooks | MCP |
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
| Trae | written; reads ? | `.trae/rules` t | — | `.trae/agents` s cwd only | ? | `.trae/mcp.json` d |
| Trae CN | written; reads ? | `.trae/rules` t | — | `.trae/agents` s cwd only | ? | `.trae/mcp.json` d |
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

## Run time and teamai's own AI

User scope, from #1221's matrix; a fix merged since is marked `t`, with a note. `✓` works. `◐` works by default, and a condition breaks it while doctor still reports it delivered. `✗` broken in the default setup. `+` the tool supports it and teamai does not build it. `—` the tool has no such feature. `?` unknown. The letter after the mark is the evidence, as above.

| Tool | Env | Workflows (local driver) | Recall | Stats | AI backend | Votes judge | Session judge | HTTP agent hooks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Code | ✓t | ✓v | ✓v | ✓v | ✓v | ✓v | ✓t<sup>1</sup> | ✓v |
| Codex CLI | ✓t | ✓t | ✓v | ✓t<sup>2</sup> | ✓v | ✓t<sup>3</sup> | ✓t<sup>1</sup> | ✓t<sup>4</sup> |
| Codex CLI Internal | ? | ✓t | ? | ? | ✓t | ? | ? | ? |
| Claude Code Internal | ? | ✓t | ? | ? | ✓t | ? | ? | ? |
| TClaude | ? | ✓t | ? | ? | ✓t | ? | ? | ? |
| TCodex | ? | ✓t | ? | ? | ✓t | ? | ? | ? |
| Cursor | ? | +s<sup>5</sup> | ✗v<sup>6</sup> | ✓v<sup>7</sup> | ✓d | +s | ✓t<sup>1</sup> | +t<sup>8</sup> |
| Copilot | ? | +s | ✓v | ✓t<sup>2</sup> | ✓d | ? | ✓t<sup>1</sup> | —t |
| JoyCode | ? | ? | ◐s | ? | ? | ? | ? | ? |
| Qoder | ? | ? | ◐s | ✓s | ✓d | ? | ✓s<sup>9</sup> | ✓s |
| Qoder CN | ? | ? | ◐s | ✓s | ? | ? | ✓s<sup>9</sup> | ✓t<sup>10</sup> |
| Kiro | ? | ? | ◐d | ? | ✓d | ? | ✓d<sup>11</sup> | ? |
| Trae | ? | ? | ? | ? | ? | ? | ✓s<sup>12</sup> | ? |
| Trae CN | ? | ? | ? | ? | ? | ? | ✓s<sup>12</sup> | ? |
| ZCode | ✓t | +s | ✓s | ✓s | +s | ✓t<sup>3</sup> | ✓d<sup>13</sup> | +t<sup>14</sup> |
| Oh My Pi | ✓s | +s | ✓v | ✓t<sup>2</sup> | ✓d | ? | ✓s<sup>15</sup> | —t |
| Pi Coding Agent | ✓s | +v | ✓v | ✓t<sup>2</sup> | ✓s | ? | ◐s<sup>16</sup> | ? |
| CodeBuddy | ? | ✓d | ✓s | ✓v | ✓d | +v | ✓t<sup>1</sup> | ✓s |
| OpenClaw | ◐d | +d | ✓s | +s | ✓d | —t | ◐s<sup>17</sup> | ◐s |
| Hermes | ◐s | +s | ✓v | +s | ✓s | —t | ✓s<sup>18</sup> | ✓t<sup>19</sup> |
| DeepSeek Harness | ✗s | +s | ✓s | ✓t<sup>2</sup> | +s | ? | ◐s<sup>20</sup> | —t |
| WorkBuddy | ? | ✓t | ✓t | ? | ✓t | ? | ✓t<sup>21</sup> | ? |
| OpenCode | ? | ✓t | ✓v | ✓t<sup>2</sup> | ✓v | ? | ✓t<sup>1</sup> | ◐t |
| Muse Code | ✓t | +v | ✓t | ✓v | ✓v | ✓t<sup>3</sup> | ✓t<sup>1</sup> | ✓t<sup>22</sup> |

Notes:

1. #1386 the session judges its skill-driven run; not rerun
2. A1 (#1245) records its skill loads; not rerun
3. #1374 judges the reply in its Stop payload; not rerun
4. #1224 runs the Codex trust pass; not rerun
5. Cursor IDE: —
6. Cursor IDE: ✓v
7. Cursor IDE: ✓t
8. teamai refuses agent hooks in the Cursor hook format
9. Claude Code-style subagents, transcripts under <id>/subagents/ (qodercli 1.1.78); not run
10. #1224 writes ~/.qoder-cn/settings.json; not rerun
11. a subagent works in its own context window, without the conversation; not run
12. the Task tool starts a fresh subagent; no session variable, so the session names its tool with --tools; not run
13. the built-in general-purpose subagent works in its own context; not run
14. refused until teamai writes the hooks.events shape (#1224)
15. the task tool starts each child as a new agent session (omp 18.12.6); not run
16. bare Pi starts no subagent, so its session answers h4 and does not judge; the subagent example extension adds one (since 0.24.0); not run
17. sessions_spawn with isolated context, in the coding and messaging tool profiles; a tool policy can remove it; not run
18. delegate_task starts a child agent with a fresh conversation; not run
19. #1224 maps the events to Hermes's; not rerun
20. the subagent tool with the fresh spawn backend, not fork; the minimal preset leaves it out; not run
21. CodeBuddy's engine, whose session judges its skill-driven run; not run
22. #1224 writes them to settings.json; not rerun
