# 诊断与维护

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

```bash
teamai doctor
teamai doctor --json
teamai stats
teamai update --check
teamai update
teamai digest
teamai remove skills <name>
teamai remove rules <name> --force
```

`doctor` 有一项没过就以状态码 1 退出。`stats` 在有 recall 记录时会多一节，见 [Recall 采纳与 upvote](./knowledge.md#recall-采纳与-upvote)。

对于已知 agent 搜索路径的工具，`doctor` 还会检查配置的 agents 目录是否在工具的读取范围内。仅成功写入自定义目录并不能通过此项检查；请修正团队仓库中的 `toolPaths.<tool>.agents`，然后重新 pull。

生成 hook 的检查会比较处理逻辑，并接受处理逻辑相同的另一份安装记录的启动路径。仅换一个 CLI 路径运行 `doctor` 不需要重装 hooks；记录的路径必须指向文件，运行时名称必须为 `node`、`nodejs` 或 `bun`。Node 名称可带数字版本后缀，例如 `node-22` 或 `nodejs-22`；也接受带 `.exe` 的名称。启动入口无效或处理逻辑发生变化时，仍需运行 `teamai hooks inject` 或 `teamai pull`。

如果工具的 skills 目录被普通文件占用，`pull` 会保留该文件、指出阻塞路径，并继续向其他工具分发。`doctor` 会将该目录检查标为失败，避免把跳过的投递误报为成功。移开该文件后，再运行 `teamai pull` 即可补齐缺失的技能。`uninstall` 会保留该文件，并继续清理该工具的其他托管资源。

即使在单仓库模式，ZCode CLI 也从 `~/.zcode/cli/config.json` 读取 hooks。`hooks inject` 会迁移旧项目文件中属于 teamai 的条目，保留个人设置，并限制团队 hooks 只在所属项目运行。`hooks list` 和 `doctor` 检查同一个 HOME 文件。

自动更新在会话结束时跑。团队可以关掉，成员可以改自己的策略。CLI 是整台机器共用的，所以有 user scope 时由它的配置和团队决定，否则由会话所在的 workspace 决定：

```yaml
# teamai.yaml
autoUpdate: false
```

```yaml
# ~/.teamai/config.yaml，否则 ~/.teamai/projects/<slug>/config.yaml
updatePolicy: skip    # auto / prompt / skip，优先于团队设置
```

对于 OpenClaw 的默认工作区，`doctor` 会根据实际 `openclaw.json` 的 `agents.defaults.bootstrapMaxChars` 和 `bootstrapTotalMaxChars` 检查整个 `AGENTS.md`，包括个人内容。两项默认分别为 20,000 和 60,000 字符。如果会截断或跳过，请缩短文件或检查上限；`pull` 不会截断你的指令。单独智能体的覆盖配置需要另行检查。

OpenCode hooks 使用 `teamai hooks inject` 或 `teamai pull` 记录的 Node 可执行文件和 TeamAI 入口，因此服务的 PATH 无需包含 `teamai`。移动或重新安装 Node 或 TeamAI 后，重新运行其中一个命令并重启 OpenCode。

`doctor` 会检查 Hermes 的整个 `SOUL.md`，包括个人内容。Hermes 的 `config.yaml` 中显式设置的 `context_file_max_chars` 是明确上限；未设置时，上限随模型变化，超过最低 20,000 字符会产生提示性警告。请缩短文件或检查上限；`pull` 不会截断你的指令。

在项目中，Hermes 通过 teamai 插件的提示段获得团队指令。所有插件的提示段共享 8,000 字符和 32 段的上限，Hermes 按段 id 顺序填充，放不下的段整段丢弃。其他插件添加哪些段只有运行后才知道，所以 `doctor` 读取 Hermes 在 `logs/agent.log` 中记录的最近一次结果。该日志不记录项目，所以段被丢弃时只给警告：

```text
  ⚠ Hermes's last logged session took teamai's instructions section
    → The Hermes session at 2026-11-01 10:22:03 got none of the team instructions: teamai.instructions exceeded the aggregate session budget (8000 chars) and was skipped. Plugin sections share 8,000 characters and 32 sections, filled in id order, and other plugins' sections sorting before teamai.instructions took them first. Disable a plugin you do not need (plugins.disabled in /home/ana/.hermes/config.yaml) or shorten its section, then start a new Hermes session. /home/ana/.hermes/logs/agent.log lists each section Hermes rendered and its size.
```

Pi 扩展会启动 `teamai pull` 或 `teamai hooks inject` 记录的 Node 可执行文件和 TeamAI 入口。移动或重新安装后，请重新运行其中一个命令并重启 Pi。

Pi 从 0.84.0（`@earendil-works/pi-coding-agent`）起先读 `AGENTS.override.md`，再读 `AGENTS.md`。保留 override 文件时，pull 把团队指令写进 override，更旧的 Pi 读不到：

```text
  ✖ Pi reads the AGENTS.override.md holding the team instructions
    → Pi 0.73.1 reads /home/ana/.pi/agent/AGENTS.md, not /home/ana/.pi/agent/AGENTS.override.md, so it never sees the team instructions: Pi reads AGENTS.override.md from 0.84.0. Upgrade Pi (`npm uninstall -g @mariozechner/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent`), or move your text from /home/ana/.pi/agent/AGENTS.override.md into AGENTS.md, delete the override, and run `teamai pull`.
```

Hermes hooks 和指令插件会启动 `teamai hooks inject` 或 `teamai pull` 记录的 Node 可执行文件与 TeamAI 入口。移动或重新安装后，请重新运行其中一个命令并重启 Hermes。

## 工具还没有信任这个项目

有些工具要等你信任项目后才读取项目里的文件，或者要等你批准后才启动项目的 MCP server。`pull` 照常写入文件；`doctor` 读取每个工具自己的结论：

- `⚠` 工具还没问过。你第一次在项目里打开它时它会问。`doctor` 仍然通过，所以今天不用的工具不会让你多做什么。
- `✖` 结论是否：你或某个设置拒绝了，或者 teamai 读不出结论。打开工具也不会改变，所以 `doctor` 报失败。

新 checkout 第一次 pull 之后，装了 Pi 和 Claude Code：

```text
$ teamai doctor
  ⚠ Pi trusts this project, so it loads its team skills
    → /home/ana/work/web-app/.pi/skills holds team skills (release-notes), but Pi loads a project's skills only in a trusted project, and /home/ana/.pi/agent/trust.json has no entry for /home/ana/work/web-app or a folder above it. Start `pi` in /home/ana/work/web-app and choose Trust, or add "/home/ana/work/web-app": true to /home/ana/.pi/agent/trust.json. Until then a headless run (`pi -p`) skips them.
  ⚠ Claude Code approves this project's team MCP servers
    → /home/ana/work/web-app/.mcp.json holds team MCP servers (issues), but Claude Code starts a project's .mcp.json servers in an interactive session only once you approve them, and issues waits for approval. ...
All checks passed!
```

在项目里打开某个工具时，回答它的提示：

```text
$ cd ~/work/web-app
$ pi          # 选 "Trust"
$ claude      # 信任文件夹，然后选 "Use this MCP server"
$ teamai doctor
  ✔ Pi trusts this project, so it loads its team skills
  ✔ Claude Code approves this project's team MCP servers
```

有人拒绝过一次的 server 会一直关闭，也不会再被询问，所以这一项报失败：

```text
  ✖ Claude Code approves this project's team MCP servers
    → /home/ana/work/web-app/.mcp.json holds team MCP servers (issues), but ... issues was rejected. Remove the rejected ones from disabledMcpjsonServers in /home/ana/work/web-app/.claude/settings.local.json; `claude mcp reset-project-choices` in /home/ana/work/web-app clears the local settings' choices.
```

只以无界面方式运行工具的机器（CI runner、跑 workflow 的机器）永远不会被询问，按修复提示加上那一项即可：

```bash
# Pi，信任 ~/work 下的所有 checkout（runner 上还没有 trust.json 时）
mkdir -p ~/.pi/agent && echo '{ "/home/ci/work": true }' > ~/.pi/agent/trust.json
```

| 工具 | 等待的内容 | 结论保存在 | 如何给出 |
|---|---|---|---|
| Claude Code | `.mcp.json` 里的 server（交互式会话） | `~/.claude/settings.json`、主 checkout 的 `.claude/settings*.json`，信任记录在 `~/.claude.json` | 信任文件夹，再批准 server |
| Claude Code | `disableAllHooks` 为 true 时的 teamai hooks | 依次为 `.claude/settings.local.json`、`.claude/settings.json`、`~/.claude/settings.json` | 删除 `disableAllHooks`，或设为 `false` |
| Codex | 项目 agents、`.codex/config.toml` | `~/.codex/config.toml` 的 `[projects."<主 checkout>"]` | Codex 询问时信任项目 |
| Copilot CLI | `.github/mcp.json`、`.github/hooks` | `~/.copilot/config.json` 的 `trustedFolders` | "Yes, and remember this folder" |
| Pi（0.79.0 起） | `.pi/skills`、`.pi/mcp.json` | `~/.pi/agent/trust.json` | "Trust" |
| Muse Code | `.agents/skills`、`.mcp.json`、`.muse/hooks.json` | `~/.config/muse/trust.json`，每个 worktree 一项 | "Trust and continue" |
| Qoder CLI | `.qoder/settings.json`（交互式会话） | `~/.qoder/settings.json` 的 `permissions.trustDirectories` 和 `mcp.*ProjectMcpServers` | 信任文件夹，再批准 server |
| CodeBuddy Code | `.mcp.json` 里的 server，`-p` 也一样 | `.codebuddy/settings.local.json` | "Use this MCP server" |
| Cursor CLI | `.cursor/mcp.json` 里的 server | `~/.cursor/projects/<project>/` | `cursor-agent mcp enable <name>` |

Oh My Pi 没有信任门槛。
