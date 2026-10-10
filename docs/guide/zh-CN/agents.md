# Agents

> [English](../agents.md) | [简体中文](agents.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## Agents 资源类型

团队仓库可在 `agents/` 目录下维护自定义 subagent 定义（每个 agent 一个 `*.yaml` 或旧格式 `*.md` 文件）。根目录文件对所有成员生效；一层子目录可按角色/项目划分 agents，规则与 `rules/<namespace>/` 相同：

```text
team-repo/
  agents/
    code-reviewer.md              # 团队自定义 subagent，所有人共享
    frontend/vr-reviewer.yaml     # 仅同步给 `agents:` 中列出 `frontend` 的角色/项目
    .removed                      # tombstone（由 teamai remove agents <name> 自动管理）
```

```yaml
# manifest/roles.yaml（manifest/projects.yaml 使用同一个 key）
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # 可选；省略 = 只同步根目录 agents
```

真正生效的 namespace（`knowledge`、`skills`、`agents`）都会成为目录名，因此必须是
单个路径片段：不含 `/`、`\`、`:` 和控制字符，结尾不能是 `.` 或空格，也不能是
Windows 设备名，且同一资源类型下的两个 namespace 不能仅有大小写差异；`manifest/roles.yaml`
与 `manifest/projects.yaml` 规则一致，且两者之间也做该校验。role 的
`learnings:` 仅为向后兼容而保留、运行时忽略（learnings 按 project 而非 role 划分
namespace），不会成为目录名，因此不做校验。

`teamai pull` 会将它们按文件名拍平复制到每个 Tier-1 工具的 `agents/` 目录（如 `~/.claude/agents/`），因此两个活跃 namespace 不能定义同名 agent（pull 会报告冲突，本次运行保持已安装的 agents 不变；其他资源类型照常同步）。活跃 namespace 中的 agent 会替换根目录的同名 agent，该 namespace 不再活跃后根目录 agent 会恢复。未配置角色或项目时所有 namespace 都会同步，因此根目录与 namespace 中的同名 agent 同样会冲突。`teamai pull` 为 Codex 系工具写入 `<name>.toml`，为 Kiro 写入 `<name>.json`，为 Copilot 写入 `<name>.agent.md`，其余工具写入 `<name>.md`。成员切换角色后，不再活跃的 namespace 中的 agents 会在下一次 pull 时被移除；

若本地副本已被手动修改，则保留并给出警告。未配置角色时同步全部 agents。`teamai push` 使用与 pull 相同的活跃角色和项目 namespace 来确定源文件，并将修改写回该源文件；若存在多个候选目标，则跳过并给出警告。若源文件均不活跃，也会跳过。跳过的 agent 不会阻止同一次 push 中的其他资源。新 agent 与新 skill 一样需要确定落点：`--role <ns>` 或 `--project <id>`（该项目的 `agents` namespace）指定目录；

两者都不给时，从主角色的 `agents` namespace 解析。只有在解析不出任何 namespace 时才留在共享根目录（此时全员都会收到），并且 push 会给出警告（见[推送本地资源](./member-guide.md#推送本地资源)）。清理会逐个工具检查 YAML 的 `targets` 和旧格式支持；只有活跃的同名 agent 会写入该工具的同一输出文件时，才保留该文件。`teamai remove agents <name>` 会记录 tombstone。带 namespace 的 agent 可写作 `<namespace>/<name>`；只有一个 namespace 拥有的简名会解析到该 agent；

若简名出现在多个位置，命令会列出完整名称并拒绝执行，而不是从所有位置删除。其他机器下一次 pull 时，会从每个同步中的工具的 agents 目录删除 `<name>.agent.md`、`<name>.md`、`<name>.toml` 和 `<name>.json`。即使该次 pull 发现团队仓库没有变化，也会执行清理。删除带 namespace 的 agent 只记录 `<namespace>/<name>` 的 tombstone，其他 namespace 中的同名 agent 不受影响；

当该副本可能属于这个 agent（该 namespace 对成员活跃，或由其本机放置）且成员的目录没有从另一个活跃 namespace 收到同名 agent 时，其拍平后的 `<name>` 副本会被清理，也不会再被推送。从未启用该 namespace 的成员会保留自己的同名 agent。CLI 内置的 `teamai-recall` 配置与团队 agents 并列部署，但不会被 `teamai push` 上传。

YAML agent 可以在 `tool_extras.<tool>` 下携带工具专属字段，每个工具只接收自己的键：`tool_extras.claude` 只到达 Claude，`tool_extras.qoder` 到达 Qoder，Qoder CN、ZCode 和 OMP 分别读取 `tool_extras.qoder-cn`、`tool_extras.zcode` 和 `tool_extras.omp`。tclaude 和 tcodex 还会收到 `tool_extras.claude` 和 `tool_extras.codex` 中、`tool_extras.tclaude` 和 `tool_extras.tcodex` 未设置的字段。`teamai push` 把修改写回该工具读取的键；对 tclaude 和 tcodex 只写入与基础工具不同的值，若修改删除了继承来的字段，则跳过并说明原因，因为只有基础工具的键才能删除它。

### 模型别名

YAML agent 可以写一类模型而不是具体模型：`model: strong`、`model: fast`，或团队自定义的别名。团队在可选的 `models/aliases.yaml` 中按工具映射每个别名，使用该工具自己的模型值，并可附带推理强度（effort）：

```yaml
# models/aliases.yaml
aliases:
  strong:
    claude: [{ model: opus, effort: high }, { model: fable }]
    codex:  { model: gpt-6-sol, effort: high }
    opencode: anthropic/claude-opus-5-5
    cursor: "claude-opus-5[effort=high]"
  fast:
    claude: haiku
    codex:  { model: gpt-6-luna, effort: low }
  reviewer:
    claude: [{ model: opus, effort: max }]
```

- `strong` 和 `fast` 始终是别名，TeamAI 不为它们内置任何模型。团队可以添加自己的名称：以小写字母开头，后跟小写字母、数字或连字符。其他任何 `model`（如 `opus`）按原样写入。
- 每个工具的条目是一个选项或有序列表；目前只使用第一个。选项是模型字符串或 `{ model, effort }`。
- 每个工具在自己的模型字段接收模型、在自己的推理强度字段接收推理强度，不会收到其他工具的键：

  | 工具 | 模型 | 推理强度字段 |
  |---|---|---|
  | Claude、claude-internal、tclaude | 按原样写入 | `effort` |
  | Codex、codex-internal、tcodex | 按原样写入 | `model_reasoning_effort`，仅在映射设置了它时写入 |
  | OpenCode | 按原样写入（`provider/model`） | `variant` |
  | CodeBuddy、Qoder、Qoder CN | 按原样写入 | `effort` |
  | Cursor | 按原样写入，包括方括号形式 `claude-opus-5[effort=high]` | 无；把推理强度写在方括号中 |
  | Copilot | 第一个条目，作为单个模型字符串 | 无 |
  | Kiro、WorkBuddy、JoyCode、ZCode、OMP | 按原样写入 | 无 |

- 为没有推理强度字段的工具映射的 `effort` 会被丢弃：该工具只收到模型；pull 把使用该别名的 agent 交付给该工具时会警告一次，并指明别名和工具。
- claude-internal 和 tclaude 使用 `claude` 条目，codex-internal 和 tcodex 使用 `codex` 条目，Qoder CN 使用 `qoder` 条目，除非该别名有它们自己的键。其他工具不继承任何条目：Qoder、ZCode、OMP 和 JoyCode 永远不会收到 `claude` 的模型。
- 别名未映射的工具不会得到 `model` 字段，因此使用其默认模型运行该 agent。没有 `models/aliases.yaml` 时，`strong` 和 `fast` 在所有工具中都不产生 model 字段。
- `tool_extras.<tool>.model` 把该工具固定到具体模型并跳过别名，包括别名的推理强度。`tool_extras.<tool>` 中只有推理强度字段而没有 model 时，只覆盖别名的推理强度，且已切换到模型配置档的工具不会收到它。
- 读取 agent 时会拒绝非字符串的 `model`。旧格式 `agents/<name>.md` 按原样复制，因此当其 `model` 是别名时 pull 会给出警告。
- 结构性错误会让整个文件失效：无法解析的 YAML、类型错误的值、不符合命名规则的别名、有 `effort` 却没有 `model` 的选项、`~`，或有顶层键却没有 `aliases:`（例如拼错的 `alias:`；空文件、只有注释的文件和空的 `aliases:` 不定义任何别名）。修复之前，pull 会警告并指明该文件，并在每个没有 `tool_extras.<tool>.model` 的工具中暂停所有带 `model` 字段的 agent（无法读取的文件可能定义任何名称）：已部署的副本保留，不写入新副本，pull 为它们记录的模型也保持不变。push 会跳过这些 agent 并说明原因，其他内容照常 push。文件修复后，普通的 `teamai pull` 就会交付被暂停的 agent，包括从未部署过的，以及其间团队对它们的修改：

  暂停了 agent 的 pull（团队仓库未变化时也一样）不会把团队版本记为已同步，因此下一次 pull 会完整同步。`teamai pull --dry-run` 会列出它将暂停的 agent。
- 其他当前 CLI 不认识的内容会被丢弃并给出警告，文件其余部分照常生效：不是 teamai 已知工具的工具键；`model` 和 `effort` 之外的选项字段（该条目去掉该字段后照常使用）；以及与工具自带模型别名同名的别名（`opus`、`sonnet`、`haiku`、`fable`、`inherit`、`default`、`auto`、`lite`，这是一个尽力而为的简短列表），该别名会被忽略，因此 `model: opus` 仍是 `opus`。别名中的 `gateways` 键保留给后续版本，会被忽略且不给出警告。pull 对每条警告只打印一次，并且只在交付使用该别名的 agent 时打印；关于某个工具条目的警告，只在该工具读取该条目时打印。
- pull 会记录每个 agent 副本收到的模型和推理强度，因此即使团队仓库没有变化，普通的 `teamai pull` 也会应用变化，例如从把 `model: strong` 按原样写入的旧版 CLI 升级后的第一次 pull。它只重写模型发生变化的 agent、缺失的副本，以及旧版 CLI 渲染方式不同、而你之后没有改过的副本。你修改过的副本会被保留，每次这样的 pull 都会指出它，并说明如何换用新模型。agent 使用的别名被删除时，pull 会警告其 `model` 现在按原样写入，该别名原本没有给该工具写 model 字段时也会警告。
- `models/aliases.yaml` 中的 `default` 和其他模型值一样按原样写入，它是 CodeBuddy 表示其默认模型的原生值。在该文件中写 `~` 是错误：要让某个工具不产生 model 字段，不写该工具即可。

#### 引入别名

只有支持模型别名的 CLI 才会解析别名，因此团队分两步引入：

1. 所有人先把 teamai 升级到支持模型别名的版本。此时什么都不会变：`model` 为具体模型或未设置的 agent 照旧写入。
2. 之后团队再添加 `models/aliases.yaml`，并把 agent 改为 `model: strong`、`model: fast` 或团队自己的别名，可以直接在团队仓库中修改，也可以在已部署的副本中写入别名名称后 push。

旧版 CLI 会忽略 `models/aliases.yaml`，把 `model: strong` 按原样写入每个工具，而没有工具认识这个模型。旧版 CLI 的 `teamai push` 还会把已部署副本中改动的模型当作编辑，因此可能把团队 agent 中的 `model: strong` 替换成 `opus` 这样的具体模型。TeamAI 不检查版本，所以先升级是唯一的保护。成员升级后的第一次普通 `teamai pull` 会把按原样写入的 `model: strong` 替换为别名解析出的值。

#### 按 namespace 的别名

角色或项目可以在 `models/<ns>/aliases.yaml` 中为别名赋予自己的含义，格式相同；与 `models/<ns>/models.yaml` 一样，只有 `<ns>` 在你的角色或项目的 `resources.models` 中生效时才读取。旧模式（未配置角色和项目）只读取 `models/aliases.yaml`。

- namespace 中的别名整体替换根文件中的同名别名：它未映射的工具不会得到 `model` 字段，即使 `models/aliases.yaml` 映射了该工具。
- 两个生效 namespace 定义同一个别名时，与结构性错误一样暂停带 `model` 字段的 agent，pull 会指出这两个文件。在其中一个文件里重命名或删除它，或不再声明其中一个 namespace。
- 团队仓库中任一别名文件（根文件或 namespace 文件，无论对你是否生效）定义的名称都是别名。只由未生效 namespace 定义别名的 agent 不会得到 `model` 字段，而不是按原样写入名称；你对该名称的本地条目仍然生效。pull 交付使用这种别名的 agent 时，每个别名警告一次并指出这些文件：如果该别名应当对你生效，请启用该 namespace；如果这个名称原本指的是具体模型（例如 `gpt-5-codex`），请重命名该别名。
- 同理，团队仓库中任一别名文件出现结构性错误（包括对你未生效的 namespace 中的文件）都会暂停带 `model` 字段的 agent，pull 会指出该文件。
- pull 的警告和 push 的偏差提示会指出条目所在的文件，例如 `models/checkout/aliases.yaml`。当你收到的 agent 使用的别名也由对你未生效的 namespace 定义时，`teamai doctor` 会给出提示。

#### 本地覆盖

成员可以在自己机器上的 `~/.teamai/models/aliases.yaml` 中替换团队条目，格式同样是 `aliases:`：

```yaml
# ~/.teamai/models/aliases.yaml
aliases:
  strong:
    codex: { model: gpt-6-astra, effort: xhigh }
  fast:
    codex: default          # fast 在 Codex 中使用 Codex 自己的默认模型
```

- 每个工具的顺序是：`tool_extras.<tool>.model`，然后是你的条目，然后是团队条目，最后是不写 model 字段。已切换到模型配置档的工具会过滤你的条目或团队条目给出的结果，见下文。你的条目会整体替换该工具的团队条目，包括推理强度，因此即使团队映射了推理强度，`codex: gpt-6-astra` 也不会给 Codex 写推理强度。
- 某个工具写 `~` 或 `default` 时，无论团队如何映射，它都不会得到 model 字段和推理强度。
- 键可以是保留名称（`strong`、`fast`）或团队定义的别名，值可以是任意模型。团队还没有 `models/aliases.yaml` 时，你也可以映射 `strong`。两者都不是的名称不起作用，因为该文件服务于这台机器上的所有团队。
- claude-internal 和 tclaude 使用你的 `claude` 条目，codex-internal 和 tcodex 使用你的 `codex` 条目，Qoder CN 使用你的 `qoder` 条目，除非你为它们单独写了条目。你的 `claude` 条目优先于团队的 `tclaude` 条目。
- 该文件每台机器一份：它适用于所有作用域（user 和每个项目检出），也适用于使用该别名名称的每个团队。
- 修改该文件后，普通的 `teamai pull` 即会应用，即使团队仓库没有变化。
- 除 `~` 外，该文件遵循与团队文件相同的规则，只有一处不同：结构性错误只暂停 `model` 为别名的 agent，因为该文件不能把任何名称变成别名，警告按路径指明该文件。`model` 为具体模型的 agent 照常交付和 push。当前 CLI 不认识的条目会被丢弃并给出警告。

#### 已切换到模型配置档的工具

用 `teamai models switch` 切换过的工具会把请求发往配置档的网关，而网关不认识你账号下的模型。因此，对 `model` 为别名的 agent，pull 只写入切换能够路由的值：

- Claude 保留解析出的 `opus`、`sonnet` 或 `haiku`（来自你的条目或团队条目），因为切换会把这几个系列分别指向网关模型。其他模型会被丢弃。
- Codex、OpenCode、CodeBuddy 和 WorkBuddy 不会得到 `model` 字段。
- 已切换的工具都不会得到推理强度，无论来自别名还是 `tool_extras.<tool>`，除非 `tool_extras.<tool>` 同时固定了模型。

不写 `model` 字段意味着使用工具自身的继承规则，而不是配置档的模型：例如 Codex 会在你的配置设置了 `[agents].default_subagent_model` 时使用它，否则使用启动该 agent 的会话的模型。`tool_extras.<tool>.model`、`opus` 这类具体 `model`，以及你的 `~` 或 `default`，都与未切换时一样写入。Claude 和 Codex 的变体（claude-internal、tclaude、codex-internal、tcodex）从不视为已切换。只有当工具当前的配置路径（`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 等）与切换时记录的一致，且这些配置仍是 TeamAI 写入的内容时，该工具才算已切换，这与 `teamai models restore` 所做的检查相同。TeamAI 无法读取切换记录（`~/.teamai/models/managed.json`）时，pull 会警告并在 `models switch` 支持的五个工具中暂停别名 agent；

无法读取某个已切换工具的配置时，只在该工具中暂停。执行 `teamai models switch` 或 `teamai models restore` 后，普通的 `teamai pull` 就会重写受影响的 agent。

#### Push

对 `model` 为别名的 agent，各工具中的 `model` 以及别名写入的推理强度字段归别名所有，而不归副本所有：

- 副本中的模型和推理强度与上次 pull 写入的一致，或与现在 pull 会写入的一致，就视为未修改。因此在 pull `models/aliases.yaml`、你的覆盖文件或切换带来的变化之前先 push，也不会报告任何内容；push 对“保留的副本其部署版本已变化”的警告也会忽略这类变化。
- push 从不把 `model: strong` 替换为具体模型，也从不把别名的推理强度写进 `tool_extras`。你在副本里手动修改的模型或推理强度属于偏差（drift）：push 会指出该副本及该值的来源，不提交这项修改，并说明应在哪里修改：来自你覆盖文件的条目，改你的覆盖文件；团队条目或未映射的工具，改你的覆盖文件或该别名所在的团队别名文件（`models/aliases.yaml` 或 `models/<ns>/aliases.yaml`）；已切换的工具，运行 `teamai models restore --agent <tool>`。`teamai push --dry-run` 同样会报告。你对该 agent 的其他修改（例如 instructions 或其他字段）照常 push。
- 要让 agent 改用另一个别名，在已部署的副本中写入别名名称（例如用 `model: fast` 替换 `opus`，或在原本设置 `model: opus` 的 agent 中写 `model: strong`），然后 push：push 会提议 `model: <alias>`。若某个工具的模型由 `tool_extras.<tool>.model` 固定，该工具的副本不会采用别名；在那里改动的值会作为该固定值的偏移报告。两个副本写了不同的别名时会冲突，与其他任何两个不同的值一样。
- 只存在于某个工具目录中的新 agent 按其中的模型原样 push，不会被反推回别名。

#### 用 doctor 查看

`teamai doctor` 回答“为什么 Codex 用的是这个模型”。对每个 `model` 为别名的 agent，它输出一条说明（note），为该 agent 面向的每个已安装工具列一行：该工具收到的模型和推理强度，方括号里是决定它的步骤。解析结果相同的 agent 和工具合并为一行；`model` 为具体模型或未设置的 agent 不列出，因为它们按 spec 原样写入。

```text
models: how model: strong resolves for agents implementer, planner:
    claude: opus, effort high  [team: models/aliases.yaml]
    codex: gpt-6-astra, effort xhigh  [local: /home/me/.teamai/models/aliases.yaml]
    opencode: tool default  [default: models/aliases.yaml does not map opencode]
```

| 步骤 | 含义 |
|---|---|
| `extras` | `tool_extras.<tool>.model` 固定了模型，跳过别名 |
| `switched` | 该工具已切换到模型配置档：Claude 保留 `opus`、`sonnet` 或 `haiku`，其他工具不写 model 字段，由工具自行选择 |
| `local` | 你在 `~/.teamai/models/aliases.yaml` 中的条目；`tool default (chosen in <path>)` 表示你写了 `~` 或 `default` |
| `team` | 团队条目，来自所列文件 |
| `default` | 不写 model 字段：别名未映射该工具，或没有生效的别名文件定义它 |

- Codex 系工具有模型但没有推理强度时，该行会注明：沿用启动该 agent 的会话的推理强度。
- 上次 pull 部署的内容不同时（例如你修改了覆盖文件但还没 pull），该行会写出已部署的内容；普通的 `teamai pull` 即可更新，`Agents delivered to <tool>` 会把该 agent 列为 `model changed since the last pull`，但检查不会因此失败。
- 别名文件中被本 CLI 丢弃的每个条目也会作为说明列出。
- 任一别名文件（无论是否生效，包括你自己的）存在结构错误、同一别名出现在两个生效的 namespace 中，或已切换工具的设置无法读取而导致 agent 被暂缓时，`Agent model aliases can be resolved` 检查失败，并给出原因、文件和被暂缓的 agent，与 pull 自己的警告一致。

## GitHub Copilot CLI

GitHub Copilot CLI 已支持其官方自定义指令、Rules、Skills、自定义 Agent、Hooks 和 MCP 配置面，以及 TeamAI Docs 和 Env 下发：

- **作用域。** 用户资源位于 `$COPILOT_HOME`（默认 `~/.copilot`）下，项目资源位于 `<project>/.github` 下。TeamAI 在检测以及所有用户级读写中都会遵循 `COPILOT_HOME`。
- **Skills。** `teamai pull` 将用户级 Skills 写入 `$COPILOT_HOME/skills/`，将项目级 Skills 写入 `.github/skills/`；任一作用域中的修改都可像其他 TeamAI Skills 一样被 `teamai push` 检测。
- **自定义指令。** TeamAI 将团队文化和共享指令注入用户级 `$COPILOT_HOME/copilot-instructions.md` 或项目级 `.github/copilot-instructions.md`。TeamAI 标记包围的区块会被幂等替换，标记之外的文字归用户所有。`teamai uninstall` 只移除 TeamAI 管理的区块。开启 `sharing.gitExclude` 时，项目级区块改为写入 `.github/instructions/teamai-context.instructions.md`，`.github/copilot-instructions.md` 保持为团队的文件（见[这些块写到哪里](./team-culture.md#这些块写到哪里)）。
- **Rules。** 团队 Rules 会转换为 `$COPILOT_HOME/instructions/` 或 `.github/instructions/` 下的原生 `*.instructions.md` 文件。TeamAI 从团队 Rule 的 `paths` 派生 Copilot 必需的 `applyTo` frontmatter；没有 `paths` 时使用 `**`。Push 时只有 Markdown 正文回流，团队拥有的 `paths` 元数据保持不变。未知的 Copilot instructions 文件属于用户，不会被上传或删除。Copilot CLI 1.0.89 及更高版本也会读取项目的 `.claude/rules`，因此启用 Claude 时，每条项目 rule 会送达 Copilot 两次；teamai 仍会写入两份副本，对每个也读取其他工具文件的工具都是如此。
- **自定义 Agents。** 团队 Agents 会转换为 `$COPILOT_HOME/agents/` 或 `.github/agents/` 下的官方 `<name>.agent.md` 配置。TeamAI 将兼容的工具名映射为 Copilot 主别名，通过 `tool_extras.copilot` 保留 Copilot 专属 frontmatter，并且只删除与团队 Agent 或内置 recall 配置匹配的文件；用户自建配置保持不变。详见 [GitHub 自定义 Agent 配置](https://docs.github.com/zh/copilot/reference/custom-agents-configuration)。
- **Team Context recall。** 内置 `teamai-recall.agent.md` 只获得 `execute`、`read` 和 `search`。它调用现有的 `teamai recall` 流程，让 Copilot 检索 learnings、codebase 证据和 teamwiki 结果，而不会复制或创建第二套知识库。
- **Docs 和 Env。** 团队 Docs 同步到配置的本地文档目录（默认 `~/.teamai/docs`；project scope 使用项目内对应路径）。团队环境变量同步到该作用域由 TeamAI 管理的 `env.sh`；请从已 source 此文件的 shell 启动 Copilot。TeamAI 不会把环境变量值复制到 Copilot 配置中。
- **Hooks 与隐私遥测。** TeamAI 在 `$COPILOT_HOME/hooks/teamai.json` 或 `.github/hooks/teamai.json` 写入独立的 version-1 Hook 文件，使用 Copilot 与 VS Code 兼容的 PascalCase 事件（`SessionStart`、`UserPromptSubmit`、`PostToolUse`、`Stop` 和 `SessionEnd`），从而保留 TeamAI 所需的 snake_case Hook 负载字段，并生成 `bash`、`powershell` 和后备 `command` 字段。会话 ID、Skill 使用、提示次数、生命周期状态和最终 Token 总数会进入本地 Dashboard；Copilot 提示原文、助手输出、Transcript 路径和请求元数据绝不会被保存。若最终 Token 计数不可用，会话仍会被记录，但不包含 Token 数据。对于恢复的会话，TeamAI 在 SessionStart 时保存不含路径的日志字节边界；

  只有此前的运行标记尚未关闭、且未被上次运行使用时，才会采纳该标记。关闭计数必须关联这个标记或边界之后写入的标记。若标记仅在 SessionStart 之后出现，而 SessionEnd 没有提供方时间戳，则无法确认它属于本次运行；会话仍会被记录，但不包含 Token 数据。文件会被幂等合并，且保留无关条目。TeamAI 从不修改 Copilot 的 `settings.json`。
- **MCP。** `teamai pull` 和 `teamai mcp inject` 使用 Copilot 原生结构，把本地与远程 Server 合并到 `$COPILOT_HOME/mcp-config.json` 或 `.github/mcp.json`。归属信息保存在 Copilot 文件之外，因此重复 pull 保持幂等，`mcp remove` 或卸载只会移除 TeamAI 管理的条目；手写 Server 与 `settings.json` 均保持不变。

团队 Hooks 仍以团队仓库中的 `hooks/hooks.yaml` 为来源：直接编辑该文件，再使用正常的 pull/push 流程。TeamAI 不会从 Copilot 配置文件反向导入任意原生 Hook 条目。

## OpenCode

[OpenCode](https://opencode.ai) 已作为一等工具支持。由于它的配置布局与 Claude 系不同，teamai 对以下几点做了特殊处理：

- **作用域。** OpenCode 的用户配置在 `~/.config/opencode/` 下，项目配置在 `<project>/.opencode/` 下——前缀与其他所有工具都不同。teamai 会按 `--scope` 写入正确的位置，且仅在该作用域确实安装了 OpenCode 时才碰它的文件（绝不会为未使用 OpenCode 的用户创建 `~/.config/opencode/`）。Hooks 是唯一的例外——始终写在用户级，原因见下。
- **Skills** 落在 `.opencode/skills/`（项目）或 `~/.config/opencode/skills/`（用户）。OpenCode 也原生读取 `.claude/skills`，但 teamai 仍会写 OpenCode 路径，好让只用 OpenCode 的用户也能拿到。
- **Subagents** 会被渲染成 OpenCode 自己的 `agents/*.md` 格式：frontmatter 带 `description` + `mode: subagent`（以及 `model` 和 `tool_extras.opencode` 中的字段，如 `temperature`）；agent 名取自文件名。OpenCode **不**读取 `.claude/agents`，因此这份原生副本是必需的。
- **Rules** 会被复制到 `.opencode/rules/`（或 `~/.config/opencode/rules/`），但 OpenCode 不会自动扫描 rules 目录——文件在被引用前是惰性的。因此 teamai 会往 `opencode.json` 的 `instructions` 数组里加入 glob，并在团队最后一条 rule 消失时再把它们移除，且只编辑这一个键、不动你自己的 `instructions` 条目。在项目中是 `.opencode/opencode.json` 里的 `.opencode/rules/**/*.md`，与团队 instructions 条目并列；

  OpenCode 会从会话的工作目录及其直到 worktree 的每一级父目录对相对条目做 glob，因此在项目任意位置都能加载 namespace 下的 rule。pull 会移除旧版本写入根目录 `opencode.json` 的 `.opencode/rules/*.md`（它加载不到任何 namespace 下的 rule），且不动该文件的其他键。user scope 下是绝对路径 `~/.config/opencode/rules/*.md`，外加 rule 所落入的每个 namespace 目录各一条（`~/.config/opencode/rules/<ns>/*.md`）：OpenCode 从会话的工作目录解析相对条目，对绝对条目只对文件名做 glob，因此 `**` 永远不会匹配。pull 会替换旧版本写入的相对 `rules/*.md`（它加载的是项目的 `rules/`），并在某个团队 namespace 的 rule 不再送达你时移除它的 glob；

  你为自己的目录添加的 glob 会保留。OpenCode 会忽略 `paths:`：它加载的每条 rule 都对所有文件生效。`uninstall` 会移除这些 glob，并删除除此之外已无其他内容的 `.opencode/opencode.json`。
- **Hooks** 以 OpenCode *plugin* 形式交付，而非配置文件条目——OpenCode 没有 `hooks` 数组，它会**同时**加载 `~/.config/opencode/plugin/` 和 `<project>/.opencode/plugin/` 下的 JS/TS 插件。两个目录都有插件时会被加载两次，每个事件也就派发两次，因此 teamai 只保留一份：写在用户目录的 `teamai-hooks.ts`，覆盖所有项目；早期布局残留的项目级副本会在下次同步时被删除。这与其他工具一致——它们的 `settings.json` hooks 同样放在 HOME，靠传给 `hook-dispatch` 的 `cwd` 做作用域判断。插件订阅 OpenCode 自己的事件，并 shell 到其他所有工具共用的 `teamai hook-dispatch` 入口。事件映射对齐 Claude 内置集合：

  `session.created` → session-start、`session.idle` → stop、`chat.message` → prompt-submit、`tool.execute.after` → post-tool-use。插件会转发与其他工具一致的 STDIN 负载（`cwd`、`session_id`、`tool_name`、`tool_input`、`prompt`，post-tool-use 时还有工具输出和状态），并把 OpenCode 的小写工具 id（`skill`、`todowrite`）映射回 handler 注册表期望的 PascalCase matcher。OpenCode 无法把 hook 的 stdout 回注到会话，因此 hooks 只为副作用运行（状态上报 / 同步 / 更新）。注意 OpenCode 会 **await** 它的具名 hook（`chat.message`、`tool.execute.after`），所以这两个事件的派发会短暂等待 `teamai` 子进程后 agent 才继续；

  错误始终被吞掉，hook 永远不会让会话失败。服务端下发的 agent hook（`teamai-agent-<slug>.ts`）同样装在这个用户级 plugin 目录下。upvote **采纳（adoption）**在 OpenCode 上基于 recall 日志运行，不依赖 transcript：插件的 `shell.env` hook 会在 bash 工具的环境中设置 `TEAMAI_AGENT_SESSION_ID`，因此在其中运行的 `teamai recall` 会归入其 hooks 携带的同一会话；`task` 调用会把子代理的子会话关联到父会话，因此子代理 recall 之后父会话打开的文档会被 upvote。可选的 LLM-judge 需要 transcript，而 `session.idle` 不携带，所以它在 OpenCode 上不运行；hook 的 stdout 会被丢弃，因此"本次会话采纳的团队知识"摘要也不会显示。

  内置 hooks 和服务端下发的 hooks 均支持 OpenCode **1.18.23** 和 **V2**（已对照 2.0.23 验证）。每个插件默认导出一个定义：V1 调用 `server`，V2 调用 `setup`。上述命名 hook 与 `shell.env` 对应 V1；V2 将 `session.prompt` 和 `tool.execute.after` 映射为相同分发，将 `shell` / `subagent` 规范为 `bash` / `task`，并使用宿主原生的 `OPENCODE_SESSION_ID` 为 shell 中的 recall 归属会话。生命周期订阅限定在插件的目录内，卸载时取消。升级 TeamAI 后运行 `teamai hooks inject` 或 `teamai pull`，然后重启 OpenCode，替换报 “Plugin must export a default definition” 的旧插件。
- **V2 上的规则与指令。** OpenCode V2 会解析 `instructions`，但不加载其中任何文件，因此上述 rule glob 和团队 instructions 条目只对 V1 生效。在 V2 上由同一个 `teamai-hooks.ts` 插件自行添加：它的 `setup` 注册会话 `context` hook，并在压缩时添加相同文本；

  在任何目录下都读取 `~/.config/opencode/teamai-context.md` 和 `~/.config/opencode/rules/**/*.md`，再从会话目录向上找到最近一个包含 `teamai-context.md` 或 `rules/` 的 `.opencode/`，添加其中的 `teamai-context.md` 和全部 `.opencode/rules/**/*.md`，按路径排序。插件在每次请求时读取这些文件，不调用 `teamai`。V1 通过 `instructions` 的交付保持不变。由于由插件承载，`teamai hooks remove` 也会让 V2 会话失去团队规则和指令。`teamai doctor` 运行 `opencode --version`（缺失或无法解析时视为 V1）；在 V2 上，`Team rules are active in opencode` 和 `opencode adds the team instructions to its prompt` 检查插件是否按当前 teamai 写入的内容安装，而不是检查 `instructions`。
- **MCP** server 位于共享 `opencode.json` 的 `mcp` 键下（详见 [MCP Server](./sharing.md#mcp-server)）。
- **开启 git exclude 选项时的 OpenCode V2。** 当 `sharing.gitExclude` 开启（见[让分发的文件不进入 git](./member-guide.md#让分发的文件不进入-git)）、`opencode --version` 报告 V2（每条命令只询问一次；缺失或无法读取按 V1 处理），且 pull 已按当前 teamai 的写法安装好 teamai 插件时，teamai 不会向项目的 opencode.json 文件写入任何内容。pull 把团队 MCP server 写入 `.opencode/teamai-mcp.json`：这个文件只属于 teamai，列在 git exclude 块中；若它将含有解析出的值，只有在 git exclude 块已包含它之后才会写入。插件在 OpenCode 打开项目时读取它（沿用同样的向上查找最近 `.opencode/` 的逻辑，现在只含该文件的 `.opencode/` 也会命中），并只为该项目加入这些 server。随后 pull 从根目录的 `opencode.json` 移除 teamai 的 MCP server，从 `.opencode/opencode.json` 移除 teamai 的 `instructions` 条目（包括升级前写入的），并删除因此变空的文件。只有在 git 未跟踪该文件时才会这样做，并保留其中你自己的 server、条目和键：团队提交的文件会保持原样，`teamai doctor` 会在 `No OpenCode V1 entries are left in shared config files` 下指出它。V2 会忽略这些 `instructions`，并再次加载这些 server；等项目中没有人再使用 V1 时，请自行删除 teamai 的条目。pull 会先重写旧版 teamai 留下的插件再做判断，因此迁移在同一次 pull 中完成。没有最新插件时（无法写入、工具因没有 shell 被跳过，或在 `teamai hooks remove` 之后、下一次 pull 重新安装之前），pull 会保留 V1 条目，因为那时 V2 只能从它们获得内容，`teamai doctor` 会在插件缺失的检查旁说明这一点。回到 V1 或关闭该选项后，下一次 pull 会重新写入 V1 条目并删除 `.opencode/teamai-mcp.json`。当前 teamai 的插件与之前的版本不同，因此在下一次 `teamai pull` 或 `teamai hooks inject` 之前，`teamai doctor` 在 V2 上会报告插件过期；插件在 OpenCode 打开项目时读取 server：pull 改变它们后请重启 OpenCode。

## Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 通过其公开的 Skills、指令文件和扩展机制接入：

- **作用域。** 项目级 Skills 写入 `.pi/skills/`，用户级 Skills 写入 `~/.pi/agent/skills/`。Pi 不读取 rules 目录，因此 teamai 不为它写 rule 文件：user scope 的团队 rule 是 `~/.pi/agent/AGENTS.md` 中的一个区块，在项目中则由 TeamAI 的 Pi 扩展把项目的团队 rule 加入每次运行的系统提示，二者都不按路径限定作用范围。pull 会删除旧版本留在 `.pi/rules/` 和 `~/.pi/agent/rules/` 中未修改的副本，并点名你改过的副本。
- **指令文件。** Pi 读取项目自己的 `AGENTS.md`（或 `CLAUDE.md`），TeamAI 不修改它。用户范围的团队指令写入 `~/.pi/agent/AGENTS.md`。在项目中，TeamAI 的 Pi 扩展在会话开始时向 `teamai` 获取成员的团队指令和项目的团队 rule，并加入每次运行的系统提示；Pi 每次运行都会重建该提示，因此它们不会累积。
- **Hooks。** TeamAI 只在用户级 `~/.pi/agent/extensions/` 生成一份 `teamai-hooks.ts`，把 `session_start` 映射为 session-start、`before_agent_start` 映射为 prompt-submit、`agent_settled` 映射为 stop；`tool_execution_start` 缓存工具输入，`tool_execution_end` 派发 post-tool-use 时把缓存的输入转发为 `tool_input`，并附上结果文本 `tool_response` 和根据错误标志得出的 `tool_status`。每个事件都携带 Pi 会话 id（`ctx.sessionManager.getSessionId()`），与 Pi 的 bash 工具导出的 `PI_SESSION_ID` 相同，因此在其中运行的 `teamai recall` 会归入其 hooks 携带的同一会话，upvote **采纳（adoption）**在 Pi 上同样生效。Pi 会同时加载用户级与项目级扩展目录，因此 TeamAI 不创建项目副本

  ——第二份副本会导致每个事件被派发两次，这与 OMP 适配器的单副本策略一致。早期版本遗留且带 TeamAI 标记的项目副本会在下次同步时移除，注入逻辑也不会覆盖没有 TeamAI 标记的同名文件。Pi 没有可供 self mode 提交的设置文件，所以 fresh clone 仍需在该机器上手动跑一次 `teamai init`/`pull` 才能激活 Pi hooks。显式执行 `teamai hooks remove` 或用户级 `teamai uninstall --agent pi` 会删除这份共享扩展。项目级卸载为其他项目保留它，并移除旧的项目副本；

  没有 TeamAI 标记的同名文件不会被删除。`teamai hooks list` 始终显示这个全局路径。Pi 的 profile 覆盖项（`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）在 hooks 中暂不支持，与 OMP 适配器一致，使用默认的 `~/.pi/agent/` 布局。模型配置是另一回事，会读取 `PI_CODING_AGENT_DIR`。项目级卸载后共享扩展仍已安装；指令派发会先检查此项目对该工具的排除设置。
- **团队 Hooks 边界。** Pi 适配器只安装内置生命周期桥接。`hooks/hooks.yaml` 声明的自定义团队 Hooks 和内置 Hook 覆盖会被跳过并给出警告。完整团队 Hooks 与逐项目归属语义需要单独的跨适配器设计，留待后续 PR。
- **服务端下发的 Agent Hooks。** HTTP source hooks 会以同一用户级扩展目录中的 `teamai-agent-<slug>.ts` 形式安装。不支持的生命周期事件会警告并跳过。
- **MCP（Pi 0.99.0+）。** 支持 stdio 和 streamable HTTP；SSE 会跳过。用户级写入 `~/.pi/agent/mcp.json`，项目级写入 `.pi/mcp.json`；项目配置需要 Pi 信任项目后才加载。保留原生 `codemode` 默认值，不强制 direct；`mcp.yaml` 的 timeout 从毫秒转换成秒。受管条目的本地 exposure/启用状态在团队定义不变时保留，团队定义更新时会被替换；doctor 按完整条目比较，会报告这些本地差异。接管 `/mcp` 的扩展可能禁用内置 MCP；使用内置支持需移除此类扩展。
- **Subagents。** 暂不支持 TeamAI 自定义 subagent 文件。

## Qoder

Qoder 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.qoder/skills/`、`.qoder/rules/` 和 `.qoder/agents/`。Hooks 与 MCP Server 会合并进对应作用域的 `.qoder/settings.json`，并保留用户已有的其他设置；这些路径与 Qoder 的用户级和项目级配置约定一致。

Rules 按 Qoder Desktop 写入的形式生成，Qoder CLI 也读取这种形式：带 `paths:` 的规则写成 `trigger: glob` 加一行不带引号、以逗号分隔的 `glob:`，由于该行会按每个逗号切分，`{a,b}` 形式的选择会展开为多个 glob；没有 `paths` 的规则写成 `trigger: always_on`。Qoder 未公开这种 frontmatter 的 schema，该形式取自 `alibaba/tron-one-agent` 中 Desktop 生成的规则文件。

Qoder CN 是独立发行的版本，其**用户级**目录为 `~/.qoder-cn` 而非 `~/.qoder`，因此它作为独立的内置目标 `qoder-cn` 支持，而不是并入 `qoder`。两者仅用户作用域不同：用户级的资源写入 `~/.qoder-cn/{skills,rules,agents}`，Hooks 与 MCP 写入 `~/.qoder-cn/settings.json`；项目作用域则沿用 Qoder 的 `<project>/.qoder/` 布局。两者读取相同的 Claude 兼容资源格式，因此下发内容一致，仅用户级根目录不同。同时安装两个版本时，TeamAI 会分别同步到各自的用户目录，无需再建软链接。在项目中 Qoder 与 Qoder CN 都读取 `.qoder/rules/`，因此两者共用其中的一份副本：卸载其中一个时，只要另一个仍已安装，副本就会保留；`doctor` 也只检查一次，即 `Rules delivered to qoder, qoder-cn`。每个版本仅以自己的 HOME 根目录（`~/.qoder` / `~/.qoder-cn`）或显式 `--agent` 指定来判定为已安装，与 Trae 两个版本一致——项目中共用的 `.qoder/` 不代表任何一个版本在运行。

## Kiro

Kiro 已作为内置目标支持。TeamAI 会将 Skills、Rules 和 Subagents 分别下发到 `.kiro/skills/`、`.kiro/steering/` 和 `.kiro/agents/`，与 Kiro 官方文档定义的[工作区 Skills](https://kiro.dev/docs/skills/)、[Steering](https://kiro.dev/docs/steering/)和自定义 agents 布局一致。Subagents 渲染为 Kiro CLI 2.x 与 3.x 都支持的 JSON；每个文件都会保留 Kiro 私有字段和自定义 Hooks，并加入 TeamAI 管理的 `hooks.agentSpawn` 命令，在交互式 CLI 会话激活该自定义 agent 时派发 `session-start`。这一经验证的 CLI 2.x Hook 内嵌在 `.kiro/agents/*.json`，而不是写入 IDE 1.x / CLI 3.x 引入的独立 `.kiro/hooks/`；

Kiro 内存中的内置默认 agent 无法修改，`--no-interactive` 也不会触发 `agentSpawn`。MCP Server 会合并进对应作用域的 `.kiro/settings/mcp.json`（见 [MCP Server](./sharing.md#mcp-server)）。

Rules 以带 Kiro inclusion frontmatter 的 steering 文件写入 `.kiro/steering/` 与 `~/.kiro/steering/`：带 `paths:` 的规则写成 `inclusion: fileMatch`，并把其 glob 列表写入 `fileMatchPattern`；没有 `paths` 的规则写成 `inclusion: always`。Kiro 只读取 steering 目录的顶层（[kirodotdev/Kiro#10448](https://github.com/kirodotdev/Kiro/issues/10448)），因此与 [Oh My Pi](#oh-my-pi) 一样，namespace 下的规则会平铺写入：`rules/fe/style.md` 写成 `fe.style.md`，`push` 会把对该文件的修改写回 `rules/fe/style.md`。push 要求该平铺副本有下发记录；同名的个人文件既不会在 push 前被刷新，也不会被当作团队规则的修改。若你收到的另一条规则也对应同一个平铺文件名，该规则不会写入；

与团队规则平铺文件名相同的你自己的文件永远不会被覆盖或删除。旧版写入的嵌套副本 `<ns>/<name>.md` 会在平铺副本写入后删除；你修改过的副本会保留并给出提示，因为 Kiro 不会读取它。Kiro 自己的 `product.md` 不是团队规则，`pull` 会留下它。Kiro CLI 无论 `inclusion` 取值都会加载全部 steering 文件（[kirodotdev/Kiro#7950](https://github.com/kirodotdev/Kiro/issues/7950)），因此在 CLI 中限定路径的规则也会始终生效。Kiro IDE 曾忽略 `~/.kiro/steering` 中的 `fileMatch`（[kirodotdev/Kiro#9176](https://github.com/kirodotdev/Kiro/issues/9176)，Kiro 0.12）；维护者称此后已修复，该 issue 未经复测即关闭。


## Trae

Trae 与 Trae CN 已作为内置目标支持。TeamAI 会将 Skills 下发到 `.trae/skills/`，Rules 下发到 `.trae/rules/`，与 [Trae 官方文档](https://docs.trae.cn/ide/rules)定义的布局一致。CN 版仅用户目录不同（`~/.trae-cn` 而非 `~/.trae`，同 Qoder CN）：项目中两个版本共用同一份 `.trae/`；用户级 pull 时，国际版写入 `~/.trae/skills/` 与 `~/.trae/user_rules/`，CN 版写入 `~/.trae-cn/skills/` 与 `~/.trae-cn/user_rules/`——注意 Trae 的用户规则目录名为 `user_rules` 而不是 `rules`。Trae 没有基于设置文件的 Hooks 表面，也没有 subagents 目录，这两类资源不做同步，需像 JoyCode 一样手动执行 `teamai pull`。MCP Server 合并进项目的 `.trae/mcp.json`，使用 Claude 的 `mcpServers` 结构（见 [MCP Server](./sharing.md#mcp-server)）；两个版本的 target 在同一条共享归属记录下映射这同一个文件，任一版本的 pull 都能更新和清理它，用 `tools:` 限定到某一版本的服务器只要任一版本仍在使用就会保留。Trae 把用户级 MCP 保留在自身用户数据目录（随平台而异），因此不写用户级文件。

每个版本仅以自己的 HOME 根目录（`~/.trae` / `~/.trae-cn`）或显式 `--agent` 指定来判定为已安装——项目中共用的 `.trae/` 不代表任何一个版本在运行（同 WorkBuddy 以 `.workbuddy/` 计数），因此任何一版都不会成为保留或重新同步另一版文件的“幻影兄弟”。项目中两个版本读取同一份 `.trae/skills/` 与 `.trae/rules/`，因此各只有一份副本：卸载其中一个时，只要另一个仍已安装，两份副本都会保留。

Rules 是带 Trae frontmatter 的 `.md` 文件：带 `paths:` 的规则写成不加引号的 `globs: a, b`——Trae 的解析器按原样读取该行并按逗号拆分——外加 `alwaysApply: false`；没有 `paths` 的规则写成 `alwaysApply: true`。Trae 最多读取三层目录深的规则，因此 namespace 下的规则保持 `fe/style.md` 的目录形态。`push` 时只有 Markdown 正文回流；rules 目录中没有对应团队规则的文件属于你自己：`pull` 不会删除它，`push` 也不会把它当作新的团队规则提交。

## CodeBuddy 与 WorkBuddy

WorkBuddy 运行的是 CodeBuddy 的引擎，因此两者都按 CodeBuddy 的格式得到 rules：带 `paths:` 的规则写成 `alwaysApply: false`，并把 `paths:` 写成 YAML 块列表，每项一个带引号的 glob；没有 `paths` 的规则写成 `alwaysApply: true`。CodeBuddy 的 frontmatter 解析器按行读取而非按 YAML 解析，原样副本中的行内写法 `paths: ["a", "b"]` 会让它得到带方括号的 glob。在项目中两个工具都读取 `.codebuddy/rules/`，因此该目录为两者只保存每条规则的一份副本：排除或卸载其中一个工具时，只要另一个仍已安装，这些副本就会保留；

`doctor` 也只检查该目录一次，即 `Rules delivered to codebuddy, workbuddy`。只有存在 `.workbuddy/` 时 WorkBuddy 才视为已安装。在有 `.workbuddy/` 但没有 `.codebuddy/` 的项目中，共用副本会创建 `.codebuddy/`，于是 CodeBuddy 在该项目中也会被视为已安装，并同样得到 skills、agents 和 hooks；如果你不用 CodeBuddy，`teamai uninstall --agent codebuddy` 会移除它们并让它保持排除，共用的 rules 仍为 WorkBuddy 保留。user scope 下 CodeBuddy 读取 `~/.codebuddy/rules/`，WorkBuddy 读取 `~/.workbuddy/rules/`。

> 升级说明：旧版本把 WorkBuddy 的项目 rules 写到 `.workbuddy/rules/`，而 WorkBuddy 从不读取该目录。下一次 `pull` 会删除其中仍是 teamai 投递内容的副本（目录清空后一并删除），并把 rules 写到 `.codebuddy/rules/`，即使团队仓库没有变化也是如此；你改过的副本会保留并点名。WorkBuddy 的一次性迁移把 `~/.codebuddy/rules/` 复制到了 `~/.workbuddy/rules/`（会留下 `~/.workbuddy/.migrated-from-codebuddy`），其中也包括团队规则的副本。复制过来的团队规则若仍是 teamai 投递的内容（该规则的某种渲染结果，或 teamai 记录的在 `~/.codebuddy/rules/` 下同名文件写入的字节），在 WorkBuddy 仍得到该规则时会改写为 CodeBuddy 格式，否则删除；改过的副本会保留并点名，你自己的规则保持不变。

## ZCode

ZCode 已作为内置目标支持。Skills 下发到 `.zcode/skills/`（ZCode 同时会读取中央目录 `~/.agents/skills/`，该目录由 `agents` 条目覆盖），Subagents 以 Claude 风格 Markdown 下发到 `.zcode/agents/`。Hooks 会合并进共享的 `~/.zcode/cli/config.json`，并保留插件状态等无关键值。写入器为你处理了两个 ZCode 特有的细节：

- ZCode 的配置文件钩子**默认禁用**——TeamAI 会强制置 `hooks.enabled: true`，确保写入的条目真正生效。
- Windows 上，钩子条目通过隐藏的 **wscript VBS 启动器**执行（`wscript.exe <teamai-hook-dispatch.vbs> <分发命令尾段>`）：wscript 属 GUI 子系统，钩子运行绝不弹控制台黑框；启动器把 STDIN 暂存为临时文件再转发，保证 payload 完整到达 `hook-dispatch`。超时按事件放宽（会话启动 180 秒、stop / prompt 提交 60 秒、工具调用后 30 秒），避免会话启动时携带仓库拉取的分发被中途掐断。含多字节文本（如中文）的 payload 在启动器的 ANSI 代码页暂存环节可能降级——身份字段会被抢救，降级分发仍能正确关联到会话；卸载时会同时清除条目与脚本文件。
- POSIX 上条目就是普通的 `bash -lc <分发命令尾段>` argv 向量，不写入启动器；两个平台上，命令尾段都以 argv 末位元素原样存储——这正是托管条目识别与托管清单比对的依据。

以上路径已对照 ZCode 桌面端实测验证：设置页「新建子智能体」写入的就是 `~/.zcode/agents/*.md`，反向放入的文件也会出现在页面的已安装列表中。MCP Server 下发到 `~/.agents/mcp.json`（用户级，Claude 的 `mcpServers` 结构——正是 ZCode 自己的 MCP 设置页读取的文件）。项目级暂未接入：ZCode 的工作区 MCP 使用不同的键（`.zcode/config.json` 内的 `mcp.servers`），Claude 写入器无法生成该结构。ZCode 不读取 rules 目录：

user scope 下团队 rule 是 `~/.zcode/AGENTS.md` 中的一个区块，ZCode 把它作为用户上下文读取，不按路径限定作用范围。在项目中，teamai 写在 `~/.zcode/cli/config.json` 中的 `SessionStart` hook 会把项目的团队 rule 加入每个新会话（ZCode 不运行项目级 hook）。ZCode 压缩会话时会丢弃这段文本，rule 要到下一个会话才回来。

## Oh My Pi

Oh My Pi（OMP）已作为内置目标支持。TeamAI 将 Skills、Rules 和 Subagents 下发到 OMP 的原生目录——项目级为 `.omp/skills/`、`.omp/rules/` 和 `.omp/agents/`，用户级为 `~/.omp/agent/skills/`、`~/.omp/agent/rules/` 和 `~/.omp/agent/agents/`（用户级资源位于 agent 目录 `~/.omp/agent/` 下，与项目级前缀不同，TeamAI 会随作用域自动切换）。团队指令在用户范围写入 `~/.omp/agent/RULES.md`，在项目范围由下文的 extension 加入每轮的系统提示（见[这些块写到哪里](./team-culture.md#这些块写到哪里)）；MCP Server 合并进 `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json`（Claude `mcpServers` 结构，见上文 MCP 章节）。Skills 采用一层 `<name>/SKILL.md` 目录结构，TeamAI 在同步时补全 `description`

——OMP 原生 skill 发现要求该字段。以上路径遵循 OMP 官方文档的发现布局（对照 OMP 18.2.5 验证）。Hooks 走 OMP 的 extension runner：

`teamai pull` 会生成唯一的 extension 写入 `~/.omp/agent/extensions/teamai-hooks.ts`（绝不写项目副本——OMP 会同时加载两个根并导致每个事件双派发），它把 OMP 的 `session_start` / `session_stop` / `before_agent_start` / `tool_result` 事件转发给所有 agent 共用的 `teamai hook-dispatch` 入口，并按会话 `cwd` 做项目门控。在项目会话中，它还会在 `session_start` 时获取成员的团队指令，并在 `before_agent_start` 中追加到系统提示。每个事件都携带 OMP 会话 id（`ctx.sessionManager.getSessionId()`；subagent 有自己的会话），`tool_result` 还带上工具的文本输出和根据 `isError` 得出的状态，因此 upvote **采纳（adoption）**在 OMP 主 agent 上生效：OMP 不在其 shell 中设置会话变量，所以 recall 归入运行它的那次 `bash` 调用所在的会话；

带行选择器的 `read`（`x.md:50-200`、`x.md:raw`）计为对该文件的读取。从 OMP 18.3.2 起，subagent 的事件还会携带其 `ctx.agent` 的 id 和名称，因此 `teamai-recall` subagent 自身的读取从不计入。subagent 的会话文件位于父会话文件之下，父会话文件的头部写明父会话 id，因此 extension 会在 subagent 的工具调用中关联这两个会话，主 agent 在 subagent recall 之后打开的文档会被 upvote（对照 OMP 18.4.8 验证）。`session_stop` 处理器不返回任何值，分发绝不会强制会话继续；由于 OMP 的工具名是小写（`bash`、`read` 等）且没有 `Skill` / `TodoWrite` 工具，post-tool-use 不做 matcher 定向分发。用户级 `teamai uninstall` 会移除该 extension；

项目级卸载为其他项目保留它。与 Pi 一样，不带 TeamAI 标记的同名文件绝不会被覆盖或删除。OMP 的 profile（`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`，会迁移 agent 目录）暂不支持，使用默认的 `~/.omp/agent/` 布局。

Rules 以 OMP 自己的 frontmatter 写入 `.omp/rules/` 与 `~/.omp/agent/rules/`：没有 `paths:` 的规则写成 `alwaysApply: true`，其正文进入每次的提示；带 `paths:` 的规则写成 `globs`（即其 glob 列表）加一个 `description`（正文的第一个 Markdown 标题，没有标题时为 `Team rule for files matching <globs>`），OMP 会在提示的 rulebook 中以 `name (globs): description` 列出它，并在工作匹配时读取。两者都没有的规则会被 OMP 丢弃，teamai 以前原样复制的每条规则正是如此。OMP 只读取 rules 目录的顶层，因此 namespace 下的规则会平铺写入：`rules/fe/style.md` 写成 `fe.style.md`，`push` 会把对该文件的修改写回 `rules/fe/style.md`。push 要求该平铺副本有下发记录；

同名的个人文件既不会在 push 前被刷新，也不会被当作团队规则的修改。若你收到的另一条规则也对应同一个平铺文件名，该规则不会写入：根目录规则（例如 `rules/fe.style.md`）保留该文件，两条 namespace 规则则都不写入；`pull` 会指出这些规则，`doctor` 会报告失败。与团队规则平铺文件名相同的你自己的文件不会被覆盖或删除：只有与下发记录中的内容一致，或与渲染结果完全一致，才能证明它是 teamai 写入的。下发后你修改过的平铺副本，`remove` 和 `uninstall` 会保留并点名。旧的嵌套副本 `<ns>/<name>.md` 在平铺副本写入后删除，无论是否有下发记录（记录，或与团队规则原文一致，即可证明未被修改）；你修改过的副本会保留并给出提示，因为 OMP 不会读取它：

如需保留修改，请把它复制到平铺文件中。OMP 只在会话启动的目录读取 `.omp/rules/`，因此项目规则只到达从项目根目录启动的会话，从子目录启动的会话收不到。OMP 还会把项目中的 Cursor rules（`.cursor/rules/*.mdc`，仅顶层）和 Copilot instructions（`.github/instructions/**/*.instructions.md`）当作 rule 加载，并按名称每条只保留一份，优先使用它自己的 `.omp/rules` 副本（据 OMP 18.2.1 的加载器核实）。因此启用 Cursor 或 Copilot 时，根目录团队规则只送达 OMP 一次；但启用 Copilot 时，namespace 下的规则会送达两次：一次是 `.omp/rules` 中的 `fe.style`，一次是 `.github/instructions/fe/` 中的 `style`。只有你启用该来源时，OMP 才会读取 `~/.cursor/rules`。

## DeepSeek Harness

DeepSeek Harness（`dsh`）支持 TeamAI Skills 和共享资源。DSH 官方的 Claude Hook Bridge 是通过 profile 插件加载的，并不是设置文件中的 Hooks；因此当 dsh 的主目录（`$DSH_HOME`，未设置时为 `~/.dsh/`）存在时，`teamai init`、`teamai pull` 或 `teamai hooks inject` 会在 `~/.teamai/dsh/` 下生成兼容 Claude 的 Hook 配置和 Cordis patch。

dsh 不读取 rules 目录。user scope 下团队 rule 是 `$DSH_HOME/AGENTS.md`（未设置 `DSH_HOME` 时为 `~/.dsh/AGENTS.md`）中的一个区块，dsh 会把它放进第一次请求，不按路径限定作用范围。与 Hook 一样，只有该主目录存在时 teamai 才写入它。Skills 仍写入 `~/.dsh/skills/`，且只在 `~/.dsh/` 存在时写入，与 `DSH_HOME` 无关。在项目中，dsh 带上下面的 patch 运行后，teamai 的 session-start hook 会加入项目的团队 rule。dsh 以分离方式运行该 hook，第一次请求可能错过它们，压缩会话时也会丢弃它们。

TeamAI 会打印带绝对路径的 patch。将这个 `--patch` 参数加到启动 DSH profile 的命令中，例如 `dsh tui --patch "<打印出的路径>"`。这是一次性的启动器选择；`teamai hooks remove` 和 `teamai uninstall` 会移除 TeamAI patch，同时保留生成配置中的其他 Hook 条目。

## JoyCode

JoyCode 已作为内置目标支持。Skills、Rules 和 Subagents 分别下发到 `.joycode/skills/`、`.joycode/rules/` 和 `.joycode/agents/`。Subagents 使用带 YAML frontmatter 的 Markdown 文件。

Rules 是采用 JoyCode 自有渲染的 `.mdc` 文件。JoyCode 逐行读取 frontmatter，而不是按 YAML 解析：它会保留 Cursor 渲染给 `globs` 加的引号，并按每个逗号拆分取值，因此 Cursor 形式的带 `paths:` 的 rule 从未生效。带 `paths:` 的 rule 写成不加引号、逗号分隔的 `globs:`，每个 `{a,b}` 选择项都展开为单独的 glob，并加上 `alwaysApply: false`；不带 `paths` 的 rule 写成 `alwaysApply: true`。旧版 teamai 以 Cursor 形式写入的副本，若仍是 teamai 所下发的内容，会在下一次 `pull` 时重写；你改过的副本会保留并被点名；

只要其 `globs` 仍带引号，`pull` 会指出它不作用于任何文件，并说明如何修正。`doctor` 将项目 `.joycode/rules/` 中的每份副本与该渲染比对。

user scope 下 JoyCode 不读取 rules 目录：团队 rule 是 `~/.joycode/rules.txt` 中的一个区块，不按路径限定作用范围。pull 会删除旧版本留在 `~/.joycode/rules/` 中未修改的 `.mdc` 副本，并点名你改过的副本。

JoyCode 规则清理采用保守策略：不在团队规则列表中的本地 `.mdc` 和 `.md` 文件会被保留，只有团队明确记录了删除标记（tombstone）才会清理。这能保护同一目录中的个人规则；缺少删除记录的旧团队副本也会保留，不会猜测其已过期。

对于以 YAML 保存的团队 Agent，push 会将本地文件与对应工具的渲染结果比较，只将真实编辑合并回原始配置。部署范围 `targets`、其他工具的元数据，以及本地格式未输出的字段都会保留。遇到冲突或无法解析的编辑时跳过回写，不会替换团队源文件。

**Hooks 与手动同步**：JoyCode 当前没有提供生命周期 Hooks 机制或专用启动适配器（无类似 `settings.json` hooks 数组或 `hooks.json` 的事件配置）。因此，打开或启动 JoyCode 不会触发 TeamAI 的 `SessionStart` 事件，无法进行后台自动拉取、使用指标上报或自动更新检测。JoyCode 用户需要通过在终端手动运行 `teamai pull` 来同步团队最新技能、规则与 Agent，通过 `teamai push` 贡献变更。若 JoyCode 后续版本提供了 Hooks 或插件生命周期机制，将通过专用适配器接入。

## Cursor

Cursor 的子代理部署到 `.cursor/agents/*.md`，YAML frontmatter 携带 `agent_id`（团队代理名）、`description`、`tools`，以及团队代理声明了的 `model`，外加所有 `tool_extras.cursor` 字段；`reverseFromCursor` 按同样字段读回，因此 `pull` → `push` 往返不会丢 model。

Cursor 的项目规则必须以 **`.mdc`** 文件形式放在 `.cursor/rules/` 下，且带 YAML frontmatter——放在那里的纯 `.md` 会被 Cursor 直接忽略。因此 teamai 向 Cursor 写规则时用 `<name>.mdc`（JoyCode、Copilot、Kiro、Qoder、Qoder CN、Trae、Trae CN、CodeBuddy、WorkBuddy 与 Oh My Pi 各有自己的格式，见各自小节；其他工具写纯 `.md`），并从团队规则派生 frontmatter：

- 带 `paths:` 列表的规则会转成 `globs: "<逗号拼接>"` + `alwaysApply: false`（上下文中有匹配文件时 Cursor 自动附加该规则）。值加引号是因为以 `*` 开头的 glob 不加引号时并非合法 YAML。
- 无 `paths` 的规则（团队强制规则）会转成 `alwaysApply: true`（每个 Cursor 会话都应用）。

两种格式之间只有 markdown 正文互通，各自的 frontmatter 归各自所有。`pull` 时 Cursor 的 frontmatter 由机器派生（正文原样拷贝，仅规范化首尾空行），因此 `pull` → `push` 往返不会被误判为内容变更。`push` 时，在 `.cursor/rules/*.mdc` 里改完正文再执行 `teamai push`，**只有正文**会回流上游——团队规则自己的 `paths:` frontmatter 会被保留，规则的作用域不会被悄悄丢掉。

有两类文件刻意**不会**从 Cursor 规则目录推送：

- 团队仓库中没有同名规则的 `.mdc`。`.cursor/rules/` 同时也是 Cursor 自带的 *New Cursor Rule* 命令写入个人规则的地方，teamai 不会把它们当作新的团队资源。
- CLI 内置规则——它们是被下发的（对 Cursor 同样写成 `.mdc`），而非同步而来。

从旧版本升级：旧布局写入的 `.cursor/rules/*.md` 是无效文件（Cursor 从未读取过它们），因此 `pull`、`remove`、`uninstall` 会连同 `.mdc` 一起删除。你自己放在那里的 `.md` 不受影响。
