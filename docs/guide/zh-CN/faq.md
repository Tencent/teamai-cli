# 卸载与常见问题

> [English](../faq.md) | [简体中文](faq.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 卸载

`teamai uninstall` 会智能清理所有 teamai 管理的资源，**保留用户自建内容**。

即使没有本地文件需要删除，排除项目中的指定工具也需要确认或 `--force`。`--dry-run` 或拒绝确认不会修改项目配置。

```bash
# 预览将要移除的每个受管路径（不做实际变更）
teamai uninstall --dry-run

# 交互式确认卸载
teamai uninstall

# 跳过确认直接卸载（适合脚本/CI）
teamai uninstall --force

# 只卸载某一个工具的资源（与 init --agent 对称）
teamai uninstall --agent claude
```

移除内容：
- 如果 ownership 仍有效，先恢复 TeamAI 管理的模型配置
- AI 工具 settings 中的 teamai hooks。无法解析的 settings 文件会原样保留并被指出；记录其中 hooks 的 teamai 数据目录也会一并保留，卸载会报告未完成（退出码 1），并排除该工具，使留下的 hooks 不会把任何内容同步回来；修好该文件后再次运行 `teamai uninstall` 即可移除它们。`teamai source remove-http` 也会保留未移除的 agent hook 记录，禁用 HTTP 源，并以退出码 1 结束。
- 用户级卸载时的 HTTP 源（`init --http`），移除方式与 `teamai source remove-http` 相同：卸载会等待正在运行的 HTTP 同步或插件协调结束，最多 30 秒；若无法获得该锁，则以退出码 1 结束，不移除任何内容
- 各工具指令文件中的 teamai 块（文化、共享指令、recall），以及早期版本写过这些块的文件（保留用户自写内容；teamai 写入的 `teamai-context` 文件整体删除，若 OpenCode 中对应的 `instructions` 条目由 teamai 添加，则一并移除，即使你自写的内容让该文件保留下来，或该文件已不存在；你自己列入的条目予以保留）
- 没有自身 rules 格式的工具在用户作用域读取的文件中的团队规则块（`~/.codex/AGENTS.md`、`~/.zcode/AGENTS.md`、`$DSH_HOME/AGENTS.md`、OpenClaw workspace 的 `AGENTS.md`、`~/.pi/agent/AGENTS.md`、`~/.joycode/rules.txt`）；该文件若是 teamai 只为这个块创建的，则整个删除
- 团队同步的 skills，包括 OpenClaw workspace skills（保留用户自建 skills）。两个版本在项目中共用的 skills 目录——Trae 与 Trae CN 的 `.trae/skills/`、Qoder 与 Qoder CN 的 `.qoder/skills/`——只要另一个版本仍已安装就会保留
- 团队同步的 rules，包括旧版本留在 `.codex/rules/`、项目的 `.workbuddy/rules/` 与 `.pi/rules/`、`.openclaw/rules/`、`~/.pi/agent/rules/` 和 `~/.joycode/rules/` 中的副本，团队此后已删除的 rule 的副本也包括在内。项目 `.codebuddy/rules/` 中的副本，只要 CodeBuddy 与 WorkBuddy 中的另一个仍已安装就会保留。清理使用记录的 `toolRoots` 位置和发布者本地的文件名。其中你改过的副本会保留，并在警告中点名。已删除 rule 的副本只有与记录的投递哈希一致时才会删除；没有该记录时也会保留并点名。Codex 的 `*.rules` 文件保留
- 团队同步的自定义 agents 和 CLI 内置 agents（保留用户自建 agents）
- Shell profile 中的 env 块——会清理每一个候选文件（`.zshrc`、`.bashrc`、`.bash_profile`、`.bash_login`、`.profile`）中、代码块指向本作用域自身 `env.sh` 的那些，而不仅仅是当前 `pull` 会选中的那一个；指向其他作用域 `env.sh` 的代码块不受影响
- 项目中 teamai 的 git hook：仓库 git 配置中的 `hook.teamai-post-checkout`、`hook.teamai-post-merge` 与 `hook.teamai-post-rewrite` 条目，以及 `.git/hooks/post-checkout`、`post-merge` 与 `post-rewrite` 中带标记的代码块（移除后只剩 shebang 的脚本是 teamai 创建的，会被删除）。其他 hook 保留
- 项目中 teamai 的 git exclude 块，在删除它们所隐藏的文件之后移除：项目 `.git/info/exclude` 中的 `delivered` 块、其他仓库中的 `delivered/<id>` 块（作为嵌套克隆或 submodule 的工具目录、纳入 git 的工具主目录）、HTTP 本地 agent 为该项目写的行（agent 仍为你的其他工作区服务；user scope 的卸载会移除它在其记录的每个 exclude 文件中的 `local-agent` 块，包括其他仓库的），以及这些文件中 teamai 的其他所有块，因此你之后在这些路径上新建的文件对 git 可见。你自己的行保留，与其他项目共用的仓库中属于那个项目的块也保留。teamai 无法证明不含解析值的 MCP 配置所对应的行会保留并给出警告（见 [MCP Server](./sharing.md#mcp-server)），判断时会检查仓库的每个 checkout；`credentials` 行在该仓库任一 checkout 中其指向的模型文件仍含 API key 时同样保留。卸载未完成时，仍在磁盘上的文件的行全部保留，留待重试时移除。只读的 exclude 文件（或被另一个 teamai 命令占用超过短暂等待时间的文件）保持原样，警告中会列出需要手动删除的行；此时记录该文件的 teamai 数据目录也会保留，卸载报告未完成（退出码 1），文件可写后再次运行即可移除该块。所属仓库已不存在的 exclude 文件会跳过
- 每个 checkout 的 `.teamai/.ignore` 中 teamai 的文档搜索白名单块，文件中没有其他内容时连同文件一起删除（见[让分发的文件不进入 git](./member-guide.md#让分发的文件不进入-git)）。
- docs 目录（`sharing.docs.localDir`）中的团队文档：与团队仓库历史中该文档某个版本相同的文件或链接。其余内容会保留并被指出（`Kept <path>: it is not teamai's ... so uninstall left it.`）：被删除文档路径上或团队从未有过的路径上的文件、你自己的目录或链接。包含它们的目录也会保留，在 `~/.teamai/` 中也是如此。团队仓库历史无法读取时，整个 docs 目录都会保留
- `~/.teamai/` 目录。user scope 的卸载会保留本机上仍在使用 teamai 的每个项目的数据（`~/.teamai/projects/` 下含 `config.yaml` 的目录），以及这些项目读取的共享文件：`managed-hooks.json`、`codex-team-hooks.json`、这些团队的 secrets（其中某个团队声明了 secrets 时，还包括本机的 `secrets/machine.json`）和它们的 source 安装记录。卸载会列出这些项目；在每个项目中运行 `teamai uninstall` 即可移除，最后一个移除后，在所有项目之外运行 `teamai uninstall` 会删除剩余内容。卸载找不到任何配置时（在所有项目之外运行，且没有 user scope 配置，例如只用 `init --http` 设置过的机器），会移除该目录和 HTTP 源，并在此之前从其记录中提到的每个 exclude 文件里移除 teamai 的 git exclude 行；它留在磁盘上的文件，其行会保留并被指出；还会移除本地 agent 记录在 Claude 和 CodeBuddy local scope（`~/.claude.json`、`.codebuddy.json`）中的 MCP server，只移除仍与 teamai 写入时相同的：你改动过的副本会保留并被指出，你自己的 server 也保留。若存放 teamai server 的文件无法读取或写入（例如无法解析），该目录连同这些记录一并保留，卸载报告未完成（退出码 1）并指出该文件；修好文件后再次运行即可

git 跟踪的 skill、rule 或 agent 副本绝不会被删除：uninstall 会指出它，并附上将其从仓库移除的 `git rm -r <path>`，摘要中把它列在 `Kept (tracked)` 下。

uninstall 只删除它所在 checkout 中的副本。其他 worktree 中的副本保留在磁盘上，块移除后 git 会在那里显示它们。`--dry-run` 在 `Git exclude blocks (teamai's):` 下列出将要移除的块，每个所有者和文件一行。与 pull 一样，uninstall 运行期间持有项目的同步锁，因此后台 pull 无法把块写回；若另一个 pull 或 push 在短暂等待后仍持有该锁，uninstall 不做任何改动并以状态 1 退出：待其结束后再运行一次。

### 只卸载单个工具（`--agent <tool>`）

`--agent <tool>` 只移除该工具的 teamai 资源（hooks、团队指令块、skills、rules、团队同步的自定义 agents、内置 agents）。工具名即 `toolPaths` 的键（如 `claude`、`codex`、`codebuddy`），匹配大小写不敏感。传入未知工具名会直接报错并列出可用工具、不执行任何删除，并以非零状态码退出。

多个工具共同映射的指令文件按区块清理：只要该文件上仍有剩余工具会写入某个 teamai 区块，该区块就保留。最常见的是 CodeBuddy 与 WorkBuddy 共用的 `.codebuddy/rules/teamai-context.md`：只要 CodeBuddy 仍已安装，`--agent workbuddy` 就会保留它。同样的保留逻辑也适用于两个版本共用的 skills 目录（`.trae/skills/`、`.qoder/skills/`）与 rule 副本（`.trae/rules/`、`.qoder/rules/`）：只要姊妹版本仍已安装就保留。当一对版本同时安装时，删除计划可能因此为空——所有资源都共用且保留——此时卸载仍会记录排除，与上面的全局通道工具一致。早期版本写过这些块的文件（例如项目 `AGENTS.md`）现在没有任何工具读取，因此其中的 teamai 区块会被移除，你自己的内容保留。teamai 创建的文件随最后一个区块一起删除；你原有的指令文件（即使是空文件）会保留。配置的 `claudemd` 即使名为 `teamai-context.md`，也仍是成员文件。

在项目中，该工具的行会离开 `delivered` git exclude 块：uninstall 从每个 checkout 的列表中移除该工具目录下的路径（每个 `toolPaths` 条目的顶层目录，Codex 还包括 `.agents/skills`），然后更新这些块。仍在使用的其他工具读取的路径保留其行（例如 WorkBuddy 的 `.codebuddy/rules`）；卸载未完成时，仍在磁盘上的路径也保留其行。该工具在其他 worktree 中的副本保留在磁盘上，对 git 可见。

跨工具共享资源（shell profile env 块、docs 目录、`~/.teamai/`）**仅当该工具自身存在 teamai 资源、且它是最后一个仍在使用 teamai 的工具时**才一并移除，否则会为其余工具保留。没有本地资源的工具即使是唯一的工具，定向卸载也会保留共享资源。Pi、Oh My Pi、Hermes、OpenCode 和 Codex 系列的指令通道位于全局，因此项目级卸载仍会记录对它们的排除设置。

已启用且已安装的 Pi、Oh My Pi、Hermes 或项目级 Codex 通过全局投递通道继续使用项目状态，即使项目中没有该工具的本地目录。卸载其他工具时会保留此状态，以便剩余工具继续投递该项目的指令。

若删除 teamai 添加的 OpenCode 条目失败，卸载以错误状态退出，并保留共享数据目录和所有权记录，即使 OpenCode 是最后一个工具。修复配置或权限后，重试同一卸载命令。

在没有项目配置的工作区中，在该工作区运行 `teamai uninstall --force`，即可移除其 `.teamai/managed-local-mcp.json` 中记录的 local scope MCP server。无论有没有 user scope 配置，卸载都会读取该工作区的记录。若工具配置无法读取或写入，记录会保留，命令会指出文件并以退出码 1 结束。修好该文件后，在同一个工作区重复运行命令。它不会扫描其他没有项目配置的工作区。

项目级卸载会保留并指出你在 teamai 写入后改动过的已记录 MCP server，无论它位于 `.mcp.json` 还是工具的 local scope。你自己的 server 也会保留。

项目级卸载保留 Pi 和 Oh My Pi 的全局扩展、Hermes 的全局插件和配置、OpenCode 的用户级插件（它也为 V2 提供规则和指令）、Codex 系列的用户级 hooks 以及服务端下发的 agent hooks，因为本机的用户级安装、HTTP agent 或其他项目可能仍在使用它们，并在摘要中列出。若没有其他安装使用它们，请在卸载前于该项目中运行 `teamai hooks remove`，它会移除这些内容。定向项目级 Codex 卸载保留项目配置以记录排除设置，仅清理项目拥有的资源和旧 hook 副本。单工具卸载在项目配置仍保留时，将该工具加入此项目的排除列表。用户级卸载才移除这些全局投递通道。

该排除是持久的：`uninstall --agent <tool>` 会把该工具从 `enabledAgents` 移除并记入 `disabledAgents`，因此之后的 `pull`（或其他工具的 session-start hook）不会再把它的 skills、rules、agents、团队指令块或 hooks 重新装回。保留的全局适配器也会跳过被排除工具的 HTTP 同步、缓存 HTTP prompt 注入以及 session-start 时的 pull。重新执行 `init --agent <tool>` 会清除该排除、恢复对该工具的同步。

同一套 `enabledAgents` 白名单（来自 `init --agent`）也约束 CLI 内置 skills/rules/agents 以及团队指令块：即使工具根目录已经存在，白名单外的已安装工具也不会被写入或删除。`teamai remove` 对 agents、rules 和 skills 同样遵守该白名单，`teamai push` 也不会从白名单外的工具读取 rules 和 agents，`teamai pull` / `teamai mcp inject` 对 MCP servers 也遵守该白名单。不经过 `init` 直接把工具加进 `enabledAgents` 时，last-pull 跳过缓存会对新加入的工具失效。

卸载后如需重新加入：

```bash
teamai init --repo https://github.com/your-org/your-repo --scope user --role <role_id> --force
```

---

## 常见问题 FAQ

**Q: User scope 和 Project scope 可以共存吗？**

可以，但 project scope 默认保持隔离。当前工作目录包含 project scope 配置时，该项目生效并跳过 user scope。先初始化 user scope，再使用 `--inherit-user-scope` 初始化项目（或在项目本地配置中设置 `inheritUserScope: true`），即可组合安全资源和 Recall 结果；可执行配置和控制面配置（`env`、MCP）仍只使用 project scope；hooks 例外——非-self 的 project scope 会把内置 hooks 注入到 HOME，以便 `hook-dispatch` 依据 `cwd` 门控（详见 Hooks 章节）。

**Q: `teamai init` 提示已初始化？**

交互模式下会提示是否覆盖，输入 `y` 即可。也可用 `--force` 跳过确认：

```bash
teamai init --repo https://github.com/your-org/your-repo --force
```

**Q: 在项目里执行 `teamai init` 后没有 `.claude/`（或 `.cursor/`、`.codebuddy/`）目录？**

对内置工具而言，`init` 未带 `--agent` 且没有终端（不弹选择器）时这是预期行为：它不知道你会打开哪个 Agent。执行 `teamai init <repo> --agent claude`（或 `cursor`、`codebuddy` 等）会在 init 结束前创建该工具的根目录并填充；或者在项目中打开该工具：SessionStart hook 会创建该工具的项目根目录并随后 pull。单独执行 `teamai pull` 不会为缺失的 Agent 根目录建目录。例外是仅在 `teamai.yaml` 的 `toolPaths` 中定义的自定义 Agent（不属于内置工具）

——`init --agent <id>` 会自行创建该 Agent 的根目录，因为没有其他流程会为它创建。这仅在 git 模式的 init（默认或 `--self`）下生效：HTTP init（`--http`）不会在本地克隆 `teamai.yaml`，因此没有自定义路径可供创建，只会为已安装的内置工具创建根目录。

**Q: Hooks 没有自动触发？**

```bash
teamai doctor        # 诊断
teamai hooks inject --dry-run # 先预览
teamai hooks inject  # 重新注入
```

**Q: push 提示 "no new resources detected"？**

`push` 只检测新增或修改的资源。没有变更时无需推送。

**Q: 如何删除已推送的资源？**

```bash
teamai remove skills <name>
teamai remove rules <name>
```

---

> **仓库**：https://github.com/Tencent/teamai-cli
> **问题反馈**：https://github.com/Tencent/teamai-cli/issues
