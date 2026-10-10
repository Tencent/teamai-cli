# 诊断与维护

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

`teamai update --dry-run` 只检查是否有新版 CLI，不安装、不刷新 hooks、不获取更新锁，也不保存 TeamAI 的版本检查状态。与 `--check` 同时使用时也保持只读。

```bash
teamai doctor          # 配置诊断
teamai doctor --json   # 同样的诊断结果，以 JSON 输出到 stdout（CI、hook、agent 可直接消费）
teamai stats           # skill 使用统计
teamai update --check  # 仅检查 CLI 更新，不安装
teamai update          # 检查并安装 CLI 更新
teamai digest          # 生成团队活动周报
teamai remove skills <name>   # 删除资源（需要确认）
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # 跳过确认，用于脚本和 CI
```

`teamai stats` 显示当前 scope 的 skill 使用情况与会话统计；当该 scope 的 recall 日志中有 run 时，还会显示一个 recall 小节（见 [Recall 采纳与 upvote](./knowledge.md#recall-采纳与-upvote)）。普通的 `teamai stats` 在内存中解析旧版角色，不保存 config，也不打印 dry-run 迁移提示。`teamai stats --dry-run` 保留迁移预览提示且不写入任何内容：它按现状读取 reports checkout，不刷新也不创建，并会说明这一点。当 session owners 文件缺失时，预览在内存中使用同一份推断的归属与已上报额度。

仅当所有检查通过时，`teamai doctor` 才以状态码 0 退出；任一检查失败时以状态码 1 退出。尚未初始化时，它只报告缺少配置，不会臆测 Git 托管平台。手动执行 `teamai pull` 结束时会运行同一批检查（不含托管平台相关的检查，也不含本次 pull 已经自行报告过的检查）。被标记为 informational 的检查——目前只有 `No stale env blocks left behind`——仍会计入 `doctor` 的退出码，但 pull 不会把它的失败并入 `Pull finished, but N check(s) failed`，依旧会被点名，只是单独用一行更轻的提示呈现。

除了托管平台、clone、配置和 hook 检查之外，`doctor` 还会验证落到本机上的内容。`<tool> is installed` 在 `enabledAgents` 列出了不会收到任何内容的工具时失败——这正是 pull 报告成功、而该工具什么都没收到的情况。它使用与同步相同的解析逻辑，因此像 OpenClaw 这样把 skills 放在 workspace 目录而非工具根目录的工具，会在同步真正写入的位置被判断。工具已安装时也会作为通过项报告，因此 `--json` 无论哪种情况都会为每个已启用工具给出一条记录。pull 结束时的检查只覆盖它从当前目录解析出的那个 scope；

其他 scope 请在对应目录下运行 `teamai doctor`。`Skills delivered to <tool>` 会把角色命名空间、标签订阅与排除规则解析出的 skill 集合，与每个已安装工具磁盘上的内容比对：从未送达的 skill 与送达但不可读的 skill 会分别报告——后者指 `SKILL.md` 缺失、frontmatter 无法解析，或其 `name` 与目录名不一致，导致 agent 永远发现不了它。团队 skill 路径上属于你自己的 skill 目录会以 `not teamai's (kept by pull)` 列出，并附上 pull 对它的那一行说明；

团队文档路径上属于你自己的文档也会由 `Team docs delivered` 这样列出。`Team docs delivered` 将你应收到的文档（不含未激活的 docs namespace）与 `sharing.docs.localDir` 比对（它只有一个目标目录，而非每个工具一个）；每个应有的文档都必须是可读取的文件，因此占用了该名字的目录或断链接也算缺失。它还会将本地多余的非隐藏文件报告为过期文档，即使团队文档已经删空也会检查；本地隐藏文件会保留，不会使检查失败，未激活 namespace 中团队文档的本地副本也不会：

pull 会删除未修改的副本，并点名你修改过的副本。`doctor` 还会输出提示，它们只是信息，不是失败的检查。每条提示指出一个在本机替换了根目录条目的 namespace skill、agent、rule、共享指令文件、env 变量、hook、MCP server 或团队模型配置（`rules: "style" from rules/checkout/style.md replaces rules/style.md`）。当某个 namespace 提供了 env 变量、hook、MCP server 或团队模型配置时，还会有一条提示按来源统计该类型的条目（`env: 3 received here (2 root, 1 checkout)`）。未配置角色或项目时，提示改为列出团队仓库中重复定义的每个文件，以及在根文件中重复出现的每个 env 变量、hook 或 MCP server 名称。

对于 Oh My Pi 和 Kiro，即使所有收到的 rule 都发生平铺名称冲突、无法写入任何文件，`doctor` 也会报告冲突。在团队仓库中重命名其中一条 rule，然后运行 `teamai pull`。

`Rules delivered to <tool>` 与 `Agents delivered to <tool>` 对另外两类按工具下发的资源做同样的事，并且都向 handler 询问落点，而不是自行拼路径：

rule 的文件名和内容因工具而异（`.md` 原样、`.mdc` 带派生的 `globs`/`alwaysApply`（JoyCode 的不加引号）、`.instructions.md` 带 `applyTo`、Kiro 平铺的 `.md` 带 `inclusion`/`fileMatchPattern`、Qoder 的 `.md` 带 `trigger`/`glob`、Trae 的 `.md` 带 `globs`/`alwaysApply`、Oh My Pi 平铺的 `.md` 带 `alwaysApply` 或 `globs`/`description`、CodeBuddy 的 `.md` 带 `alwaysApply`/`paths`；共用一份副本的工具，例如项目中的 CodeBuddy 与 WorkBuddy，只有一项同时点名两者的检查），agent 的落点来自渲染结果，且由 `targets:` 决定哪些工具应当收到。已送达的 rule 会与 handler 为该工具渲染出的字节逐一比对，而不只是检查该工具所需的键是否存在：

`globs` 与团队 rule 的 `paths:` 不再一致的 `.mdc`，即使 `alwaysApply` 取值合法，也会作用到错误的文件上；这里会报告为 `delivered from an older copy`——正文漂移的副本同样如此，因为两者都写入成功，却都是错的。agent 会与渲染结果逐字节比对，不一致时报告为 `delivered from an older spec`，而不是当作已送达。`Every team agent reaches a tool` 会指出在任何已安装工具上都无法渲染的 agent，通常是 spec 解析失败，或 `targets:` 只列了本机没有的工具。这两项仅在 `doctor` 中运行：它们会按工具读取每条 rule、解析每个 agent，放进 pull 结束时的检查会耗尽其时间预算。

删除最后一条团队 rule 后，`doctor` 仍会报告清理失败留下的 teamai 所拥有的 OpenCode glob 或内联区块。运行 `teamai pull` 可移除它们。

有几个工具并不读取 rules 目录，按文件比对的检查无法代表它们，因此各自单列一项。`Team rules are active in opencode` 检查 `opencode.json`（项目中为 `.opencode/opencode.json`）的 `instructions` 中是否列着 teamai 所拥有的每条 glob，且没有过时的条目：OpenCode 不会自动扫描 `.opencode/rules`，缺了它，已送达的每个 `.md` 都不会生效，而按文件比对的检查依旧通过。在忽略 `instructions` 的 OpenCode V2 上，它改为检查把规则加入提示词的 teamai 插件是否已安装且为最新。user scope 下，`Team rules are inlined in Hermes SOUL.md` 把 `SOUL.md` 中 teamai 管理的代码块与团队 rule 内联后的内容比对

——Hermes 的常驻指令来自这一个文件而非某个目录，因此代码块被删除时，该工具读到的是错误的规则，而磁盘上看不出任何异常。user scope 下，`Team rules are inlined in <file>`（`Codex AGENTS.md`、`ZCode AGENTS.md`、`DeepSeek Harness AGENTS.md`、`OpenClaw workspace AGENTS.md`、`Pi AGENTS.md`、`JoyCode rules.txt`）把该工具所读文件中的 team-rules 区块与团队 rule 内联后的内容比对；对 Codex，旁边有 `AGENTS.override.md` 遮蔽该文件时也会失败。在项目中，当该工具 `hooks.json` 中的 teamai `SessionStart` 或 `SubagentStart` 条目缺失或没有设置 `additionalContextLimit: 0` 时，`Project rules and instructions reach <tool> whole through its session hooks` 会失败：

没有它，Codex 对较大的内容只保留开头和结尾。在项目中，当 `~/.zcode/cli/config.json` 没有 teamai 的 `SessionStart` 条目或没有设置 `hooks.enabled: true` 时，`Project rules reach zcode through its SessionStart hook` 会失败；当 `~/.teamai/dsh/` 下的 patch 或 hook 配置缺失时，`Project rules reach dsh through its session-start hook` 会失败，doctor 无法看到 dsh 是否带 `--patch` 运行。对 Pi，teamai 的 Pi 扩展缺失或过期时，`pi adds the team instructions and rules to its prompt` 会失败。Codex、ZCode、DeepSeek Harness 和 Pi 没有 `Rules delivered to <tool>` 检查。

`MCP servers delivered to <tool>` 将团队 `mcp.yaml` 为该工具解析出的每个 server 与该工具自己配置文件中的条目逐一比对，并列出 reconcile 跳过的 server 及原因。比对的是条目内容而非名字：reconcile 不会覆盖不属于 teamai 的条目，因此你自己写的同名 server 会占住这个名字，团队的定义从未真正送达；

过期的旧副本同样等于没送达。两者都报告为 `not the team's definition`。teamai 没有记录的条目，若与 teamai 按团队仓库当前或任一历史版本为该 server 写入的内容相同，就算作 teamai 的，下次 pull 会更新它。团队已不再定义的 server 名下没有记录的条目，若与 teamai 按团队仓库某个历史版本为该 server 写入的内容相同，则属于 teamai，pull 和 `uninstall` 会将其移除；其他条目保持原样。其他条目属于你：pull 保留并指出它，`doctor` 列出它，团队的 server 不会写入该文件。要接收团队版本，请重命名或删除它后运行 `teamai pull`，或用 `teamai mcp inject --force` 替换；

`teamai pull --force` 不会替换。未解析的 `${VAR}` 会在这里连同变量名一起报告——否则它只在 pull 时出现一次，之后再无提示。没有值的已声明密钥不算失败：doctor 把它作为备注打印（`--json` 中的 `notes`），并附上设置它的命令，退出码与没有它时相同；备注还会说明为它保留的条目可能含有旧值，以及某个 key 既声明为密钥、又在 `env.yaml` 中设置的情况。无法解析的 `mcp.yaml` 并不等于团队没有 MCP：

它会作为 `Team MCP servers can be read` 连同解析错误一起报告，因为这种文件不会向任何工具注入内容，而且除第一次之外的每次运行都对此保持沉默。无法解析的团队 hooks 与团队模型配置（文件无法解析、同一文件内重复的名字，或两个活动 namespace 中的同名条目）会让 `Team hooks can be resolved` 与 `Team model profiles can be resolved` 失败，并给出 pull 只记录一次的原因；`teamai status` 把它们计为 0 时会指向这里。`Env variables injected in shell profile` 不再只查标记注释：

它会检查 `env/env.yaml` 能否解析、以及是否在 `variables:` 键下声明了变量（写成普通的 `KEY: value` 映射等于没有声明；而显式写成 `variables: []` 属于没有内容要下发的配置，不会判为失败）、

每个变量是否以 `env.yaml` 声明的值（或你为该团队设置的值；用 `--from-env` 设置的不会写入）写进了 `env.sh`（残留的旧值会一直被导出到每个 shell 和 MCP server，直到下次 pull；比对时会用生成器自身的逆运算读回 `env.sh`，因此跨多行引用的多行值能够正确匹配，而不会被误判为过期），以及本作用域注入的代码块（即 source 本作用域 `env.sh` 的那一块，因为同一个 profile 里还可能有其他作用域的代码块）是否真的能加载它

——未加引号的 Windows 路径在 POSIX shell 中会被转义破坏，`source` 从不执行，而且没有任何提示。`No stale env blocks left behind` 是独立的一项检查：pull 优先选用哪个文件会随时间变化（Windows 上 Git Bash 的登录 shell 读取的是 `.bash_profile`/`.bash_login`/`.profile`，从不读取 `.bashrc`），而 pull 只会新增代码块，从不迁移旧的，因此平台变化留下的失效代码块可能一直留在另一个候选文件里。它会列出每一个这样的文件（检查 `.zshrc`、`.bashrc`、`.bash_profile`、`.bash_login` 和 `.profile`，新旧写法都算），并指向 `teamai uninstall` 来清除它们——这与投递检查分开进行，因此不会因为还留着一个旧副本，就让一个正常工作的 env 代码块被判成故障。

`Codex trusts this project, so it loads its team MCP servers` 在 project scope 下、项目的 `.codex/config.toml` 含有本 worktree 的 `managed-mcp.json` 为 Codex 记录的 server 时生成：Codex 只在受信任的项目中加载该文件，对未受信任的项目则静默跳过。它按 Codex 的方式读取 Codex 用户配置（`~/.codex/config.toml`，或 `toolRoots.codex` 下的那份）中的 `projects` 表：先取当前 checkout 的、设置了 `trust_level` 的 `projects."<dir>"` 条目，再取其主 checkout 的，均按真实路径（`/private/tmp/...` 而非 `/tmp/...`）。在该条目设置 `trust_level = "trusted"` 之前，它会失败，并指出文件及其中的 server；

pull 结束时的检查也会报告这一失败。pull 尝试自动信任后，如果该检查仍失败，请在 Codex 中修改项目信任，或自行为主 checkout 加上该条目，这样即覆盖所有 worktree。doctor 只读取该文件。

`Contributed learnings are published` 会在 `teamai contribute` 写下、但尚未推送成功的笔记仍在队列中时失败。当本次 pull 已经说过时，手动 `teamai pull` 结束时不会再重复它：pull 会尝试发布队列并自行报告结果，还会带上导致失败的推送错误——这是该检查本身给不出的信息。如果 pull 因为团队仓库刷新失败而根本没走到那一步，该检查会照常打印。

`--json` 把同一份报告作为单个对象打印到 stdout，并将所有日志改走 stderr，因此 `teamai doctor --json 2>/dev/null` 可以整体解析；退出码不变。每个检查都会带上人类模式下显示的修复建议：

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

尚未初始化时 `scope` 为 `null`。仅当团队仓库声明了 packages 时才会出现 `packages` 字段，内容是已渲染的报告行；`notes` 只在有额外提示时出现：上文所述的 namespace 提示（替换了根目录条目的条目，或未配置角色或项目时重复定义的名字），以及无法查询 Codex 时（PATH 中没有 `codex`，或其 app-server 失败）的 Codex hook 信任提醒。

自动更新在 Stop hook 中执行，可通过两层控制：

| 层级 | 文件 | 字段 | 值 |
|------|------|------|------|
| 团队默认 | `teamai.yaml` | `autoUpdate` | `true`（默认）/ `false` |
| 用户覆盖 | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

用户级 `updatePolicy` 始终优先于团队级 `autoUpdate`。

自更新只会重装由 npm 管理的副本。当 teamai 从 `node_modules` 之外的检出目录运行（例如通过 `npm link` 链接）时，自动更新和 `teamai update` 都会跳过安装并打印警告，因为 `npm install -g` 会用已发布的包替换该链接。要更新它，请在该检出目录中拉取最新代码并重新构建。

在 Windows 上，更新检查、安装和 hooks 刷新均不会弹出命令行窗口。
