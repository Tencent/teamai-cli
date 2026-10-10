# 参考

> [English](../reference.md) | [简体中文](reference.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

## 命令参考

完整的命令与 flag 列表由 CLI 自身生成：见 [`skill-data/core/references/commands.md`](../../../skill-data/core/references/commands.md)，或运行 `teamai --help` 和 `teamai <command> --help`。

---

## 配置文件参考

### teamai.yaml（远端团队配置）

```yaml
team: my-team
description: 团队 AI 资源仓库
repo: https://github.com/your-org/your-repo.git
provider: github
# scope: 若存在则忽略——本机安装位置由 `teamai init --scope` 决定

reviewers:
  - reviewer1

packages:
  npm:
    - name: typescript
      version: "*"

sharing:
  rules:
    enforced: [code-review-guide]
  recall:
    enabled: false             # 可选；成员可在本地覆盖
  docs:
    localDir: ./.teamai/docs   # 默认 ~/.teamai/docs；project scope 下 ~/ 前缀解析为项目根目录
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false             # 可选，为全团队去除 AI 工具提交尾注
  gitExclude:
    enabled: true              # 可选，让分发的文件不进入 git（init 为新团队写入 true）
  contributeHint:
    enabled: true              # 可选，false = 高摩擦 session 结束后不再提示 /teamai
  intervention:
    correctionKeywords: []     # 可选，额外的纠偏词，与内置中/英/日列表合并
  webhooks:                    # 可选，在团队事件发生时通知外部端点（见"Webhook 通知"）
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # 可取：session-start、session-stop、skill-use、push、pull，或 "*" 表示全部
        secret: my-signing-key # 可选，设置后启用 X-TeamAI-Signature 头
        timeout: 5000          # 可选，单次请求超时（毫秒，默认 5000）
        retries: 3             # 可选，失败重试次数（默认 3）
```

`teamai pull` 将你收到的 `docs/` 非隐藏文件（见[按 namespace 分发 docs](./sharing.md#docs文档)）镜像同步到 `sharing.docs.localDir`：团队库删除的文档，本地也会一并删除，包括删除最后一篇文档或整个团队文档目录的情况。被删除文档路径上的本地文件，只有与团队仓库历史中该文档的某个版本相同时才会删除；

其他文件会保留，并由 pull 指出（`Kept <path>: the team removed docs/<file>, but this copy matches no team version of it. Delete it when you no longer need it.`）。你在团队曾有文档的位置放置的目录会整体保留，并以同样方式指出。你在镜像中团队从未有过的路径上放置的链接也会保留，并被指出（`Kept <path>: it is a link of yours, and the team does not have docs/<file>. Delete it when you no longer need it.`）。若 `sharing.docs.localDir` 本身是链接，它属于你：

pull 不会通过它写入任何文档，也不会删除它指向的任何内容，并会指出它（`Kept <path>: it is a link of yours, so teamai delivers no docs through it. ...`）；`teamai doctor` 的 `Team docs delivered` 会以这一行失败；

`teamai uninstall` 会保留它及其指向的内容。团队仓库的历史无法读取时（团队克隆不是 git 仓库，或 git 出错），不会删除任何本地文件，因为无法证明它属于 teamai。过期的空目录也会删除，隐藏文件和隐藏目录会保留。团队仓库历史中从未出现过的路径上你自己的文件会保留，既不改动也不提示。镜像不记录它写入的内容，因此团队文档路径上的文件，只有与团队仓库历史中该文档的某个版本相同时才算 teamai 的；其他文件属于你：pull 会保留它，并用上文的 `Kept <path>: it is not teamai's ...` 一行指出，`teamai doctor` 会在 `Team docs delivered` 中列出它；

你将它改名或删除并运行 `teamai pull` 后，团队版本才会写到该路径。目标目录若与团队仓库重叠，或包含主目录／项目根目录，会被拒绝同步；若目标本身就是团队的 `docs/`，则无需复制或清理。同名路径的文件／目录类型变化会先准备替换内容，且只替换团队历史能证明属于 teamai 的条目：团队现在是目录、本地是文件的位置，或团队现在是文件、本地是目录且其中每个文件都是团队版本的位置。其他这类条目属于你，会像上文的文件一样保留并被指出；链接也是如此，除非团队在该位置有相同的链接；

pull 从不跟随链接。替换失败时恢复冲突的本地条目。若待替换目录含本地隐藏条目，需先移走这些条目；同步不会丢弃它们。复制失败时不会继续清理。`teamai pull --dry-run` 只预览同步，不修改文件；对于旧版 CLI 已同步过的版本，可用 `teamai pull --force` 清理历史残留。

### config.yaml（本地配置）

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto
scope: project                 # project（init 默认）或 user
projectRoot: /path/to/project  # 仅 project scope
inheritUserScope: true         # 可选，仅 project scope，默认 false
coAuthorEnabled: true          # 可选，每机器的 co-author 覆盖
gitExcludeEnabled: true        # 可选，每机器对 sharing.gitExclude.enabled 的覆盖
contributeHintEnabled: false   # 可选，每机器覆盖 sharing.contributeHint.enabled
codexTrustEnabled: false       # 可选，每机器，停止 teamai 信任它写入的 Codex hooks 与项目（见 Hooks）
toolRoots:                     # 可选，每机器的工具根目录（见下）
  claude: ~/.claude-work
  codex: ~/.codex-alt
```

#### 迁移后的工具根目录（`toolRoots`）

有的工具可以把自己的配置放到别处——Claude Code 通过 `CLAUDE_CONFIG_DIR`、Codex 通过 `CODEX_HOME` 这样做——此时 teamai 按团队默认位置写入的内容它一概读不到。`toolRoots` 用与 `toolPaths` 相同的工具 id 指明该工具实际使用的目录，teamai 为它解析的所有路径（skills、rules、agents、`CLAUDE.md`、settings 与 hook、用户级 MCP 配置，以及 Codex 写在 `config.toml` 里的 co-author 设置）都会一并迁过去。其他工具不受影响，project scope 的路径也不受影响：

那些路径挂在项目根目录下，每机器的根目录对它们没有意义。hook 是个例外，也正是值得记录 `toolRoots` 的原因——即使在 project scope，内置 hook 也注入到 home 目录，因此两种 scope 下都跟随 `toolRoots`，teamai 也在 `toolRoots.codex` 下的 `config.toml` 中信任 Codex hooks。

`teamai init` 会自动写入：只要设置了 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`，init 就记录它指向的目录（`toolRoots.claude`、`toolRoots.codex`）并打印出来。`CLAUDE_CONFIG_DIR=~/.claude` 也算——它与不设置该变量并不等价：设置之后 Claude Code 从配置目录内部读取 `.claude.json`，因此 teamai 写的是 `~/.claude/.claude.json` 而不是 `~/.claude.json`。读取这些变量的命令也只有 `init`

——它们只存在于某一份 shell 配置里，而 teamai 还会从 session hook 和别的终端里运行，每次运行都去读它，同步目标就会取决于是谁启动了进程。重新执行 `init` 会保留之前记录的根目录，所以在没有该变量的 shell 里再跑一次 init，同步目标不会被悄悄改回默认位置。如果重新执行 `init` 确实换了根目录，teamai 会把此前注入到旧根目录设置文件（`settings.json`，Codex 为 `hooks.json`）里的 hook 移除，以免那个工具继续往新目录同步；写在旧目录里的 skills、rules 和指令文件会原样保留，并在输出中指明位置。project scope 的 `init` 若自身没有记录、也读不到该变量，则沿用 user scope 的记录：

根目录是这台机器的事实，而 project scope 的 hook 也注入到 home 目录。要结束迁移，把该变量设为空再执行一次 `init`（`CLAUDE_CONFIG_DIR= teamai init …`、`CODEX_HOME= teamai init …`）：记录会被清除，旧根目录按同样方式释放。除 hook 之外，旧根目录里 teamai 管理的 MCP server，以及（Claude Code 的）本地 agent 下发的网关凭据也会一并移除——它们是生效中的配置，不同于 skills 和 rules。

根目录必须是 teamai 能够识别该工具的位置：home 目录下的一层目录（`~/.claude-work`，但 `~/.config` 本身除外），或者 `.config/` 下的目录——`~/.config/<名称>`，或更深的层级（`~/.config/cloak/profiles/work/claude`，即 cloak 这类「按目录切换 profile」的工具产生的布局）。开头的 `~/` 会被展开。`.config/` 下的深层根目录之所以可用，是因为「该工具是否已安装」这项检查读的是配置里记录的根目录本身，而不是路径上的某个前缀，而 `.config/` 是一个足够窄、能在其中定位到它的命名空间；不在 `.config` 之下的深层根目录、以及 home 目录之外的任何路径，都会被拒绝并给出警告，而不是只生效一半。

skill 使用统计同样读取记录的根目录，迁移后的工具的 skills 也算作已安装；`import --from-claude` 读取迁移后的 Claude Code 的 rules。

`toolRoots` 目前只对 `claude` 和 `codex` 生效，其他工具 id 都会被拒绝并给出警告。只有当一个工具在用户级的所有写入都经过 `toolPaths` 时，为它指定根目录才是可靠的；其余工具都还有 teamai 另行解析的写入位置——OMP 的扩展目录、Cursor 的 co-author 文件、OpenCode 的插件目录——只迁移它们的 `toolPaths` 会把其余部分留在原处。Copilot CLI 有自己的机制：设置 `COPILOT_HOME`。

如果你在初始化之后才设置或修改 `CLAUDE_CONFIG_DIR` 或 `CODEX_HOME`，`teamai doctor` 会报出来：`Claude Code root matches CLAUDE_CONFIG_DIR` 与 `Codex root matches CODEX_HOME` 这两项检查（各自仅在当前配置会同步对应工具时出现）会比对该变量与当前配置实际同步到的根目录，并提示重新执行 `teamai init`；若该值是 teamai 无法同步到的目录，则说明原因。未设置该变量时，对应检查不会出现在报告里。

### Webhook 通知（`sharing.webhooks`）

在团队事件发生时通知外部端点。每个 endpoint 声明 `url`、`type`（`json`、`feishu` 或 `wecom`）以及订阅的 `events`；`secret`、`timeout`（默认 `5000` 毫秒）、`retries`（默认 `3`）均为可选。

**事件及触发时机：**

| 事件 | 触发时机 |
| --- | --- |
| `session-start` | AI session 开始 |
| `session-stop` | AI session 结束（含 Copilot 的 `SessionEnd`） |
| `skill-use` | 调用某个 skill |
| `push` | `teamai push` **真正完成一次推送**——`--dry-run`、取消选择、无变更、或 PR 创建失败都不触发 |
| `pull` | `teamai pull` 完成一次真实（非 `--dry-run`）同步——暂停了无法解析模型的 agent 时不触发 |
| `*` | 通配符——订阅以上全部事件 |

**载荷。** 仅发送白名单内的非敏感字段：`skill-use` 发送 `skillName`，session 事件发送 `sessionId`；`push`/`pull` 只带事件与元数据。原始工具入参与工具输出**绝不**外发，且整个请求体在离开本机前会经过 teamai 的密钥脱敏处理。

**签名。** 设置 `secret` 后，每个请求都会带上 `X-TeamAI-Signature: sha256=<hmac>`——对**实际发送的请求体**计算的 HMAC-SHA256，供接收端校验真实性。`teamai webhook list` 与 `teamai webhook test` 可查看和测试已配置的端点；`teamai webhook test --dry-run` 只预览将发送到多少个端点，不发送请求。

---

## 模型配置

模型配置让 Claude Code、Codex、OpenCode、CodeBuddy、WorkBuddy、Pi 和 OMP 使用同一个模型网关。只有执行 `teamai models switch` 才会修改 Agent 配置；切换之后，`teamai pull` 会让已切换的 Agent 跟随团队目录的最新内容。

配置有两个来源，格式完全相同：

- `team:<id>` 来自团队仓库的 `models/models.yaml`，以及你当前生效 namespace 的 `models/<ns>/models.yaml`（见[团队配置按 namespace 划分](#团队配置按-namespace-划分)），只包含 URL 和模型 ID，不包含密钥。
- `local:<id>` 是 `~/.teamai/models/models.yaml` 中的个人配置，只在本机可见。

ID 唯一时可直接写 `<id>`；团队和个人配置同名时，需写成 `team:<id>` 或 `local:<id>`。

### 团队目录

在团队仓库中创建 `models/models.yaml`：

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}          # 占位符；每位成员在本地配置真实密钥
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3               # 第一个模型是默认模型
          - deepseek-v4-flash
```

- `base_url` 是网关根地址。`anthropic` 协议直接使用该地址，OpenAI 协议在后面加 `/v1`，与 [TokenHub](https://cloud.tencent.com/document/product/1823/130078) 一致。
- `protocols` 声明该组模型支持的协议：`anthropic`、`openai-chat-completions`、`openai-responses`。协议支持不同的模型放在不同分组，每个模型 ID 只出现一次。
- `api_key` 必须写成 `${API_KEY}`。未知字段、重复模型 ID，以及带凭证、查询参数或片段的 URL 都会被拒绝；`teamai push` 会拦截无效目录。

哪些 Agent 可以使用由协议决定：

| Agent | 需要的协议 | `switch` 写入的内容 |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json`：`env` 中的网关地址和密钥；全部模型进入 `/model` 选择器；`opus`/`sonnet`/`haiku` 映射到网关中名称匹配的模型，否则映射到默认模型 |
| Codex | `openai-responses` | `~/.codex/config.toml`：默认模型和 `[model_providers.teamai]` 块 |
| OpenCode | 任意 | `opencode.json`：每种协议一个 provider，包含全部模型 |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json`：每个模型一个条目 |
| Pi | 任意 | `~/.pi/agent/models.json`：一个以 profile 引用为键的 provider，包含全部模型。不改动 `settings.json`，默认模型由你用 `/model` 选择 |
| OMP | 任意 | `~/.omp/agent/models.yml`：一个以 profile 引用为键的 provider，包含全部模型——与 Pi 结构相同，只是 YAML |

上例没有 `openai-responses` 分组，因此不会修改 Codex；确认网关的 Responses 接口支持这些模型后，再加上该协议即可。

### 使用团队配置

```bash
teamai models list                     # 全部配置：来源文件、密钥来源、网关、模型、Agent 及生效位置
teamai models list tokenhub            # 只看一个配置
teamai models switch tokenhub          # 首次使用时提示输入密钥
teamai models switch                   # 列出全部配置，询问使用哪一个
```

`switch` 不带配置名时会列出全部配置（团队配置在前），并切换到你所选的那个；输入 `none` 可取消。它一次只接受一个配置，因此填了多个会重新询问，而不会静默取第一个。没有终端时无处可选，因此此时必须给出配置名。

`switch` 会更新所有已安装且兼容的 Agent。可以用 `--agent claude`（可重复）缩小范围，用 `--model deepseek-v4-flash` 指定默认模型，用 `--dry-run` 预览。

如果不想保存密钥，可以改为引用环境变量：

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

Codex、OpenCode、CodeBuddy 和 WorkBuddy 会自行读取该变量。Claude Code 不支持，所以 `switch` 会把解析后的密钥写入 `~/.claude/settings.json`。命令刻意不提供 `--api-key <值>`，因为命令参数会进入 shell 历史和进程列表。密钥文件权限为 `0600`。

团队修改目录后，`teamai pull` 会把新内容重新应用到已切换到该配置的 Agent。

### 团队配置按 namespace 划分

项目或角色可以为某个团队配置提供自己的版本，例如让 checkout 成员在同一个 `id` 下使用 checkout 网关。把它放在 `models/<ns>/models.yaml`，并在 `resources.models` 中声明该 namespace，方式与 env、hooks 和 MCP server 相同（见 [Env、hooks 与 MCP server 按 namespace 划分](./sharing.md#envhooks-与-mcp-server-按-namespace-划分)）：

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

- **覆盖。** `checkout` 生效期间，`models/checkout/models.yaml` 中的配置整体替换根目录中 `id` 相同的配置。已切换到 `team:<id>` 的 Agent 在下次 pull 时跟随它；namespace 失效后回到根配置。只存在于你已离开的 namespace 中的配置不会从 Agent 中移除：pull 会提示它 `is no longer active in your namespaces`，可用 `teamai models restore` 撤销。
- **密钥只用于它所属的网关。** 团队配置的 API 密钥按配置 `id` 和 `base_url` 的 origin（协议、主机和端口）保存。覆盖把配置指向另一个 origin 时，pull 不会修改使用它的 Agent，并提示运行 `teamai models switch team:<id>`，该命令会询问新网关的密钥（也可以先运行 `teamai models configure team:<id>`）。原网关的密钥会保留，因此离开 namespace 时无需重新输入。团队把根配置改到另一个 origin 时同样如此。本版本之前配置的密钥只用于根配置的 origin。
- **冲突只停止 models，不影响整个 pull。** 两个生效 namespace 中出现同一个 `id`，或某个生效文件无法解析时，本次不会更新任何 Agent，警告会指出相关文件。`teamai push` 会拒绝任何无效的 models 文件。
- `teamai models list` 显示每个团队配置来自哪个文件、是否覆盖根配置；`teamai doctor` 把每个覆盖列为提示。
- **先让所有成员升级。** teamai 0.25.0 和 0.26.0 beta 版会拒绝 `resources:` 中的 `models` 键。

### 个人配置

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

省略参数时会交互输入。用 `configure` 修改个人配置：`--name`、`--base-url`、`--model`（追加模型）和 `--protocol`（让模型额外支持某协议；配合 `--model` 可只作用于这些模型）。也可以直接编辑 `~/.teamai/models/models.yaml`。个人配置的 ID 不能与团队配置重名。

### 恢复

```bash
teamai models restore                  # 所有被 TeamAI 切换过的 Agent
teamai models restore --agent codex
```

TeamAI 只修改自己管理的字段和条目，并记录首次切换前的值，`restore` 会还原这些值。如果你自己改了受管字段（例如 Claude `env` 中的网关地址），之后的切换、pull 和恢复都会跳过该 Agent。在 Claude 中用 `/model` 选择其他模型不算接管。Codex 的 `~/.codex/auth.json` 永远不会被修改。

Claude 注意事项：`settings.json` 启用了 Bedrock、Vertex 或 Foundry 时，`switch` 会拒绝切换。当前 shell 导出的 `ANTHROPIC_*` 与 TeamAI 写入的值不一致时会给出警告，因为从该 shell 启动的会话仍会使用这些值。

其他命令：

```bash
teamai models remove local:my-gateway  # Agent 保留当前配置，restore 仍然可用
```

用户级完整 `teamai uninstall` 会先恢复受管的模型配置；如有无法恢复的配置，会停止卸载并保留恢复记录。项目级卸载不改动这些机器级配置。
