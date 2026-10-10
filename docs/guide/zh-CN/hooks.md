# Hooks

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

`teamai init` 自动注入的 Hooks：

| Hook 事件 | 操作 |
|-----------|------|
| `SessionStart` | 先为当前 Agent 创建项目根目录（project scope），再自动 pull + 上报会话启动 |
| `PostToolUse` | skill 追踪 + 知识贡献检测 + dashboard 上报 |
| `UserPromptSubmit` | slash 命令追踪 |
| `Stop` | CLI 更新检查 + 上报会话结束 |

```bash
teamai hooks list      # 查看生效的内置和团队 hooks
teamai hooks inject --dry-run # 预览，不修改工具设置或受管 hook 记录
teamai hooks inject    # 重新注入
teamai hooks remove    # 移除
```

`hooks list` 按工具分别列出内置 hooks，因为各工具的集合并不相同：Copilot 额外有 `SessionEnd`，Claude Code、Codex、CodeBuddy 和 Qoder 额外有 `SubagentStop`，Codex 系工具还额外有 `SubagentStart`（为其启动的子 agent 提供项目的团队 rule 和指令），OMP 扩展覆盖四个事件且没有 `Skill` / `TodoWrite` matcher，OpenClaw 只映射 `SessionStart` + `UserPromptSubmit`，Hermes 只有 `SessionStart`。hook 注入流程不会为其安装任何内置 hook 的工具（如 JoyCode）不会列出；Kiro 也不列出——它的 `SessionStart` 由 agent 同步以 `hooks.agentSpawn` 形式内嵌，只存在于你实际同步过的 agent 中。

inject 和 remove 只会操作你实际已安装的工具（即 `~/.<tool>/` 根目录已存在的工具）。对于 `toolPaths` 中已配置但未安装的工具，命令不会为其凭空创建根目录。HOME 和当前 worktree 的工具根目录缺失时，主 checkout 中现存的 Claude/Codex hook 文件也视为已安装的目标。inject 和 pull 会更新这些团队 hooks 并恢复 HOME 中的内置 hooks；remove 会清理主 checkout 中的托管 hooks，而不重建 HOME 根目录。

Git hook 安装失败时，`hooks inject`、`init` 和单仓库自动初始化仍会尝试信任已经写入的 Codex hooks。注入保留安装错误，不显示整体成功。init 报告错误，并在完成本地设置时保持退出码 1，HTTP 初始化也如此。自动初始化在 debug 日志中记录该错误，然后继续本地设置。

非-self 的 project scope 中，`hooks remove` 会移除 HOME 中当前 checkout 的门控团队 hooks，并释放其在主 checkout 中的 Claude/Codex 团队 hook 所有权。共享团队 hooks 保留到最后一个 checkout 移除它们。`uninstall --agent <tool>` 只释放该工具的所有权。排除某个工具的 checkout 不会保留该工具的共享 hook。对于已迁移的共享数据分区，uninstall 会移除整个仓库中所选工具的共享 hooks；完整卸载还会删除该分区。bare 仓库的 worktree 会独立移除各自的 Claude/Codex 团队 hook 文件。其他项目的门控团队 hooks 保留在 HOME；共享的内置 hooks 会被移除。

> **OpenClaw** — teamai 的 hook 是一个 workspace hook，位于 `<workspace>/hooks/teamai-status-report`。它在 `command:new`、`command:reset`、`session:auto-reset` 和 `gateway:startup` 时运行 `session-start`，在 `message:received` 时运行 `prompt-submit`，并以事件中的 workspace 作为 hook 的 `cwd`。OpenClaw 只有在 `openclaw.json` 启用了某个 workspace hook 的条目时才会加载它，因此 init、pull 和 `hooks inject` 会写入 `hooks.internal.entries.teamai-status-report.enabled: true`，`hooks remove` 和 uninstall 会将其移除。若 OpenClaw 正在加载它发现的所有 hook（`hooks.internal.enabled: true` 且没有具名条目），新增第一个条目会把发现模式变成白名单，从而停掉你的其他 hook，所以 teamai 不改动配置，只给出警告；

> 当你关闭了该 hook 或整个 internal hooks，或 `openclaw.json` 不是纯 JSON 时也同样处理。此时请自行运行 `openclaw hooks enable teamai-status-report`。服务端下发的 agent hook 位于 `<state dir>/hooks/<slug>`，并有自己的条目 `teamai-agent-<slug>`。workspace 与配置的查找方式与 OpenClaw 一致：`OPENCLAW_CONFIG_PATH`、`OPENCLAW_STATE_DIR` 或 `OPENCLAW_PROFILE`（`~/.openclaw-<profile>`），然后是 `agents.defaults.workspace`、`OPENCLAW_WORKSPACE_DIR` 或 `<state dir>/workspace`。条目缺失或被关闭时，`doctor` 的 `OpenClaw hook enabled` 检查会失败。

在 Windows 上，经由 bash 执行的内置 hook 派发命令（如 Claude、Codex、Cursor、Copilot CLI）会以绝对路径引用 Git Bash——先查标准安装位置，再回退到 `HKLM\SOFTWARE\GitForWindows` 注册表——从而避免解析到 WSL 的 `bash.exe`；若找不到 Git Bash，则退回裸 `bash`。

Cursor 也会加载 `~/.claude/settings.json`。Copilot CLI 会加载受信任项目里的 `.claude/settings.json`（self mode 把 hook 写在项目里；Copilot 不加载 `~/.claude/settings.json`）。只有另一边的 teamai hook 已经在磁盘上时，`hook-dispatch --tool claude` 才会退出：`~/.cursor/hooks.json` 或 `$CURSOR_PROJECT_DIR/.cursor/hooks.json` 含有 `--tool cursor`，或 `$COPILOT_PROJECT_DIR/.github/hooks/teamai.json` 含有 `--tool copilot`。写给 `claude` 的团队 hook 命令用同一判断。只启用了 Claude 时，Cursor 里这份 hook 照常运行，因为没有第二份可以接替。`COPILOT_CLI` 不能当信号：

Copilot 会给每个子进程设置它，包括从它的 shell 里启动的 Claude。Claude Code 不会设置 `CURSOR_VERSION` 或 `COPILOT_PROJECT_DIR`。已经装好的团队 hook 需要再跑一次 `teamai pull` 或 `teamai hooks inject`，才会带上这个判断。

> **Codex hook 信任** — Codex（OpenAI / ChatGPT Codex 应用，工具 id 为 `codex`）只运行已信任的非托管 hook，未信任或已变更的 hook 会被静默跳过；且只有项目被信任时才读取其 `.codex/`。因此每次写入 Codex hooks 文件后（`init`、每次 `pull`（含 SessionStart 触发的 pull）、`teamai hooks inject`），teamai 都会通过 `codex app-server` 信任它写入的那些 hook——与 Codex `/hooks` 信任提示调用的是同一接口。同一文件里你自己的 hook 不受影响，即使命令与团队 hook 相同；

> 只有与 teamai 写入的整条条目完全相同的条目才算 teamai 的（见下文）。Codex 所有权记录包含事件、位置和完整生成条目，信任操作只选择对应的 Codex key。其他条目移动它的位置时，仅在完整定义唯一匹配时恢复所有权。旧 manifest 只记录事件、matcher 和命令，因此这些字段唯一匹配时，即使 hook 包含 `timeout` 或 `additionalContextLimit`，也可恢复所有权。没有任何记录认领、且与 teamai 为恰好一个团队 hook（按团队仓库当前或任一历史版本的定义）写入的条目完全相同的条目，算作 teamai 的：

> manifest 丢失后不会再为每个团队 hook 多写一份（`.claude/settings.local.json` 中带标记的条目同理）。其他没有记录的条目会保留；与多个团队 hook 相同的条目，或与任何团队 hook 都不同的带标记 Claude 条目，pull 还会指出，`teamai doctor` 也会列出。在项目中，当 Codex 需要从主 checkout 的 `.codex/` 读取 teamai 的 hooks 或 MCP servers 时，teamai 也会信任该主 checkout；bare 仓库则在当前 worktree 写入并信任。你在 Codex 中标记为不信任的项目保持不变，teamai 会提示。SessionStart 触发的 pull 写入的信任从下一个 Codex 会话起生效：

> 当前会话已加载了它的 hooks。linked worktree 只有在存在 `.codex/` 目录时才读取主 checkout 的 `.codex/hooks.json`。post-checkout 准备步骤会为所选的 Codex 工具创建该目录，并在第一个会话之前完成 pull。跳过 checkout hooks 的宿主必须在启动 Codex 前完成准备。如果仅由 SessionStart 创建该目录，团队 hooks 从下一个 Codex 会话起加载；内置 hooks 位于 `~/.codex/hooks.json`，从第一个会话起就运行。若要自行信任，在 `config.yaml` 中设置 `codexTrustEnabled: false`。PATH 中没有 `codex` 或 app-server 失败时，`init` 和 `hooks inject` 会提示你在 `/hooks` 或 Settings → Hooks 中信任。交互式 pull 仅在 app-server 失败时警告，缺少 `codex` 时保持静默；

> silent pull 将结果记录在 debug 日志中。`teamai doctor` 会向 Codex 查询哪些 teamai hooks 不会运行并逐一列出。在 `~/.codex/hooks.json` 中运行项目团队 hooks 的条目（见[让分发的文件不进入 git](./member-guide.md#让分发的文件不进入-git)）也以同样方式信任。

## 团队 Hooks 声明

团队可在仓库 `hooks/hooks.yaml` 中声明自定义 hooks，按 namespace 划分的写在 `hooks/<ns>/hooks.yaml`（见 [Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)），`teamai pull` 会自动分发到支持团队 Hooks 的适配器。`builtin:` 只从 `hooks/hooks.yaml` 读取。Pi 目前仅支持 TeamAI 内置生命周期桥接；此文件中的自定义 Hooks 和内置 Hook 覆盖不会应用到 Pi。

```yaml
hooks:
  - id: block-secret
    description: 提交前扫描密钥
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 20 }
```

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，`^[a-z0-9-]+$` |
| `event` | Claude PascalCase 事件名（跨工具通用） |
| `matcher` | 可选，工具 matcher |
| `tools` | 可选，目标工具列表（默认 = 所有 hook 支持的工具） |
| `roles` | 已弃用：请改用 `hooks/<ns>/hooks.yaml`。在一个次版本内仍按角色 id 过滤，并警告给出目标文件 |
| `builtin.disabled` | 禁用的内置 hook 列表 |
| `builtin.overrides` | 仅可覆盖内置 hook 的 `timeout` |

安全治理：
- `sharing.hooks.autoApply: false`（`teamai.yaml`）：pull 时仅提示，需手动 `teamai hooks inject` 确认
- `sharing.hooks.requireTeamScripts: true`：拒绝 command 不在 `~/.teamai/team-scripts/` 下的 hook
- `TEAMAI_HOOKS_DISABLED=1`：本地禁用所有团队 hooks（内置 hooks 不受影响）
