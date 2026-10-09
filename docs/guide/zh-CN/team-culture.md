# 团队文化

> [English](../team-culture.md) | [简体中文](team-culture.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 团队文化

TeamAI 支持将团队文化注入到 AI 工具中，让 AI 编码助手在每次会话中都能感知你的团队文化、价值观和编码准则。

### 创建 culture.md

管理员在团队仓库根目录创建 `culture.md` 文件：

```markdown
---
company:
  name: Acme Corp
  mission: Build great things
  vision: A world where AI helps everyone
  values:
    - Innovation
    - Integrity
    - User First
team:
  name: Platform Team
  mission: Enable developers to ship faster
  goals:
    - Ship v2.0 by Q2
    - Improve test coverage to 90%
---

## 编码准则

- 所有 PR 必须有至少一个 reviewer 审批
- 禁止直接 push master
- 测试覆盖率不低于 80%

## 协作规范

- 使用 conventional commits 格式
- PR 描述必须包含 ## Summary 和 ## Test Plan
- 重大变更需要先写设计文档
```

### frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `company.name` | string (必填) | 公司名称 |
| `company.mission` | string | 公司使命 |
| `company.vision` | string | 公司愿景 |
| `company.values` | string[] | 公司核心价值观 |
| `team.name` | string (必填) | 团队名称 |
| `team.mission` | string | 团队使命 |
| `team.goals` | string[] | 团队目标 |

frontmatter 之后的 markdown body 部分会作为团队文化指引的正文内容，整体注入到各 AI 工具的指令目标文件（见[这些块写到哪里](#这些块写到哪里)）。

### 工作原理

```
团队仓库
├── culture.md          ← 管理员维护
├── skills/
├── rules/
└── ...

teamai pull
    │
    ▼  解析 culture.md
    │  ├─ frontmatter → 结构化公司/团队信息
    │  └─ body → 团队文化指引正文
    │
    ▼  编译为注入块
    │
    ▼  写入每个已安装 AI 工具的指令目标
       ├─ ~/.claude/CLAUDE.md                       （用户范围）
       ├─ <project>/.claude/rules/teamai-context.md （项目范围）
       └─ ...
```

注入的内容位于 `<!-- [teamai:culture:start] -->` 和 `<!-- [teamai:culture:end] -->` 标记之间，每次 pull 时自动更新，不会影响文件中的其他内容。

pull 只把团队文化、共享指令和 recall 块写入已安装 AI 工具的文件；块内容未变化时不改写文件。早期版本把这些块写进了如今由多个工具共用或会遮蔽其他指令的文件（见[这些块写到哪里](#这些块写到哪里)）；只要没有已安装的工具读取这类文件，下一次 pull 就会移除其中的 teamai 块，并在输出中列出该文件。工具当前的目标文件不会被单独清理：`teamai uninstall --agent <tool>` 会移除其中的块。文件中没有其他内容时一并删除该文件，但 git 跟踪的文件不会被删除。标记缺失或重复的块保持原样，并提示手动修复。`teamai pull --dry-run` 只列出将要修改的文件，不写入。recall 关闭时，pull 会移除 recall 块。

#### 这些块写到哪里

同一项目的两名成员可能角色不同，因此他们的共享指令（`claudemd/`）可能不同。项目根目录的 `AGENTS.md` 存放项目为所有人编写的指令，所以 teamai 不会把这些块写入它，也不会写入 `~/AGENTS.md`、`~/.agents/AGENTS.md` 或其他工具读取的文件。每个工具通过自己的文件或会话钩子获得这些块：

| 工具 | 用户范围 | 项目范围 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | `.claude/rules/teamai-context.md` |
| claude-internal、tclaude | 各自主目录下的 `.claude-internal/CLAUDE.md`、`.tclaude/CLAUDE.md`（未改变） | 项目下的相同路径（未改变，未验证） |
| Codex、codex-internal、tcodex | `$CODEX_HOME/AGENTS.md`（以及各变体的主目录），位于团队规则旁 | 由 session-start 和 subagent-start hook 加入，位于项目团队规则旁；恢复会话时不重复加入 |
| Copilot CLI | `$COPILOT_HOME/copilot-instructions.md`（未改变） | `.github/copilot-instructions.md`（未改变） |
| Cursor | `~/.cursor/rules/teamai-context.mdc`（未验证） | `.cursor/rules/teamai-context.mdc`（未验证） |
| CodeBuddy | `~/.codebuddy/CODEBUDDY.md` | `.codebuddy/rules/teamai-context.md`，与 WorkBuddy 共用一份（未验证） |
| WorkBuddy | `~/.workbuddy/rules/teamai-context.md`（未验证） | `.codebuddy/rules/teamai-context.md`，与 CodeBuddy 共用一份（未验证） |
| OpenCode | `~/.config/opencode/teamai-context.md`，以绝对路径列在 `~/.config/opencode/opencode.json` 的 `instructions` 中 | `.opencode/teamai-context.md`，列在 `.opencode/opencode.json` 的 `instructions` 中 |
| Oh My Pi | `~/.omp/agent/RULES.md` | 由 teamai 的 OMP 扩展加入每轮的系统提示 |
| Pi | `~/.pi/agent/AGENTS.md` | 由 teamai 的 Pi 扩展加入每次运行的系统提示 |
| OpenClaw | 工作区的 `AGENTS.md`，按其 hook 的方式查找（`agents.defaults.workspace`、`OPENCLAW_WORKSPACE_DIR` 或 `<state dir>/workspace`），与团队 rule 并列（未验证） | 无：它唯一的项目文件是共享的 `AGENTS.md` |
| Hermes | `$HERMES_HOME/SOUL.md` 中的一个块，位于团队规则块旁（未验证） | teamai 的 Hermes 插件提供的系统提示段落（未验证） |

团队 `toolPaths` 中没有 `rules` 的条目，Claude Code、Cursor、CodeBuddy 和 WorkBuddy 继续使用其配置的 `claudemd`，因为它们没有可放置 `teamai-context` 文件的 rules 目录。只有 `claudemd` 的条目在该文件所在目录存在时视为已安装；对 `AGENTS.md` 这类不在目录中的文件则始终视为已安装。

*未验证*：依据工具的文档或源码中的加载逻辑实现，尚未在实际会话中检查。Claude Code、Oh My Pi、OpenCode 和 Pi（项目范围）已在实际会话中从项目根目录和子目录检查过。有 `teamai-recall` subagent 的工具获得调用该 subagent 的 recall 块；没有的工具（Pi、Hermes、OpenClaw）获得提示 agent 直接运行 `teamai recall` 的 recall 块。多个工具共用的文件只有在每个工具都有该 subagent 时才获得 subagent 块。

Claude Code 会从项目根目录和任意子目录加载 `.claude/rules/teamai-context.md`，并照常读取项目的 `AGENTS.md` 或项目自己编写的 `CLAUDE.md`。Copilot CLI 1.0.89 及更高版本也会读取项目的 `.claude/rules`，因此同时安装这两个工具时，Copilot 可能会读到两份。

这两个 `teamai-context.mdc` 文件都带有 `alwaysApply: true`，Cursor 的规则加载器将其视为始终应用。Cursor CLI 仅在会话从主目录下启动时读取 `~/.cursor/rules`；Cursor IDE 未经验证。

CodeBuddy 和 WorkBuddy 的规则文件带有 `alwaysApply: true`，CodeBuddy 的规则解析器将其视为始终应用。卸载其中一个工具时，只要另一个仍已安装，项目中共用的那份文件就会保留。

在项目中，teamai 安装 Hermes 插件 `$HERMES_HOME/plugins/teamai-instructions/`，并把它加入 `$HERMES_HOME/config.yaml` 的 `plugins.enabled`（列在 `plugins.disabled` 中的名称保持关闭）。同名但并非 teamai 写入的插件保持不变，卸载时也一样，`teamai pull` 和 `teamai doctor` 会指出这一点。根据 Hermes 的文档，它在每个新会话开始时根据会话目录生成该段落，并在压缩和恢复后保留。一个段落最多 4,000 个字符，所有插件段落合计最多 8,000 个字符。当该成员在此项目的指令更长时，Hermes 会跳过它们，`teamai pull` 会给出提示：teamai 不会截断它们，也不会写入 `AGENTS.md`。在项目之外段落为空，Hermes 可能记录它跳过了一个空段落。

OpenCode 只加载配置中 `instructions` 列出的文件。仅当目标已包含所需的块或更新成功时，teamai 才添加该条目；标记不完整或写入失败时，不会激活旧块。编辑失败会保留已有的 instructions 条目，recall 标记不完整导致切换失败时也一样。TeamAI 在添加配置条目之前保存所有权；状态写入失败时不会激活条目，配置写入失败时可以重试。你已列出的条目仍属于你。teamai 只添加这一项，并保留你的其他条目和键；根目录的 `opencode.json` 以及 OpenCode 自己的 `AGENTS.md` 文件保持不变。当 `~/.config/opencode/AGENTS.md` 不存在时，OpenCode 会改为读取 `~/.claude/CLAUDE.md`；

若 Claude Code 的用户块已在那里，OpenCode V1 已经获得它们，因此 teamai 不会在 `instructions` 中再列一份用户副本，并在 pull 输出中说明。它仍会为 OpenCode V2 写入 `~/.config/opencode/teamai-context.md`，因为 V2 既不读取 `CLAUDE.md` 也不读取 `instructions`（见下文 OpenCode 一节）。被排除的 Claude Code 留在那里的块同样算数，因为 OpenCode 照样读取它们；此时 pull 会警告没有任何工具再更新它们。teamai 无法按 JSON 解析的配置文件（例如带注释的文件）保持不变并给出警告，请手动添加该条目。

Oh My Pi 把 `RULES.md` 作为始终应用的规则读取，与其唯一的用户上下文文件并存。在项目范围内，teamai 的 OMP 扩展在会话开始时向 `teamai` 获取这些块，并加入每轮的系统提示，无论会话从项目根目录还是子目录启动。没有该扩展时（例如移除了 hooks），Oh My Pi 的项目会话不会获得团队块。HTTP local agent 为项目下发的 prompt 也以同样方式，通过扩展或插件到达 Pi、Oh My Pi 和 Hermes，并通过 session-start 和 subagent-start hook 到达 Codex 系列。Pi 和 Oh My Pi 会等待前台 session-start 派发（包括 HTTP prompt 同步）完成，再为首个 prompt 缓存项目指令。

Codex 也会在该同步完成后读取 HTTP prompt 缓存，再返回 SessionStart 上下文。

早期版本的 pull 可能把这些块留在下列文件中。只有某个区块的替代内容已成功解析并投递给曾写入该文件的每个已安装工具后，pull 才移除该旧区块。文化源文件不可读或无效时，即使共享指令和 recall 已成功同步，旧文化区块仍会保留。目标写入失败、文件并非 teamai 所有、扩展缺失或插件被禁用时，旧块保留以便重试。被排除工具的当前和旧指令文件保持不变，并且不纳入 doctor 的旧指令检查。

HTTP prompt 命令会检查所有已安装的旧写入工具的当前目标，包括先前命令的投递结果，确认后才移除旧共享指令区块。目标仍含旧 prompt 时不算投递成功。HTTP 清理保留文化和 recall 区块，因为这些命令不替换它们。

当原生项目指令文件仍含 TeamAI 区块时，会话 hook 跳过该区块，包括缓存的 HTTP prompt，避免同时加入另一个成员的选择。其他区块仍通过 hook 投递，保留的区块清理后恢复投递。Codex 遵循 `AGENTS.override.md` 的优先级，Oh My Pi 遵循 `.omp/AGENTS.md` 的优先级。Doctor 会报告旧文件中不完整或重复的标记；修复标记后再运行 pull。

pull 会列出所修改的每个文件：

- Claude Code，项目范围：`.claude/CLAUDE.md`
- CodeBuddy，项目范围：`.codebuddy/CODEBUDDY.md`
- WorkBuddy：`~/AGENTS.md` 和项目 `AGENTS.md`
- Hermes：`~/AGENTS.md`
- Oh My Pi：`~/.omp/agent/AGENTS.md` 和 `.omp/AGENTS.md`。Oh My Pi 每一层只读取一个上下文文件，因此它们会遮蔽 `~/.agents/AGENTS.md` 和项目的 `AGENTS.md`。
- Pi：项目 `AGENTS.md`
- OpenClaw，项目 scope：OpenClaw 从不读取的 `.openclaw/workspace/AGENTS.md`
- Codex 系列：项目 `AGENTS.md`（当团队的 `toolPaths` 或早期构建把 Codex 指向那里时）
- 目标文件已改变的任一工具：团队 `toolPaths` 为它设置的 `claudemd` 路径，除非现在另一个工具的块写在那里

`teamai doctor` 会检查每个已安装工具能否加载这些块：每个文件是否包含当前的块，OpenCode 配置是否列出其文件（在 OpenCode V2 上改为检查 teamai 插件是否已安装），Pi 或 Oh My Pi 扩展和 Hermes 插件是否已安装并启用，Hermes 段落是否在限制内，以及早期版本写过的文件中是否仍残留块。

若请求更新的块存在不完整或重复的标记，整个文件保持不变，包括其他托管块。修复提示中的标记后，再运行 `teamai pull`。

与 teamai 目标同名但并非 teamai 写入的文件保持不变，也不会被列入 OpenCode 的 `instructions`（你自己为它列的条目保留不动），pull 会给出警告。名为 `teamai-context` 的团队 rule 不会被分发，因为它会落在该文件上；pull 会指出它，并删除早期版本分发的副本（除非你改过它）。teamai 不修改 `.gitignore`、`.git/info/exclude` 或 git 索引。若团队希望这些文件不进入提交，需要自行排除。

### 查看效果

pull 后可以直接查看 AI 工具的指令文件，例如 Claude Code 的用户文件：

```bash
teamai pull
cat ~/.claude/CLAUDE.md
```

你会看到类似这样的注入块：

```markdown
<!-- [teamai:culture:start] -->
<!-- DO NOT EDIT: This section is auto-managed by teamai -->

## Team Culture (teamai)

## Company: Acme Corp
**Mission:** Build great things
**Vision:** A world where AI helps everyone
**Values:** Innovation, Integrity, User First

## Team: Platform Team
**Mission:** Enable developers to ship faster
**Goals:**
- Ship v2.0 by Q2
- Improve test coverage to 90%

## 编码准则
- 所有 PR 必须有至少一个 reviewer 审批
...
<!-- [teamai:culture:end] -->
```
