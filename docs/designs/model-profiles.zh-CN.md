# 模型配置管理

## 目标与边界

团队发布一份网关目录，所有支持的 Agent（Claude Code、Codex、OpenCode、CodeBuddy、WorkBuddy）都能使用；个人也可以保留自己的网关配置。团队 Git 仓库不能变成密钥存储。

- 目录格式保持精简：`id`、`name`、`base_url`、`api_key: ${API_KEY}`（占位符）和 `model_groups`。不按 Agent 分节，Agent 是否支持由协议推出。
- 只有显式执行 `teamai models switch` 才会修改 Agent。此后，`teamai pull` 会把团队最新目录重新应用到已切换的 Agent；从未切换的 Agent 永远不会被修改。
- TeamAI 写入 Agent 文件的内容都能恢复，用户自己改过的字段绝不会被覆盖。

## 数据归属

| 数据 | 位置 | Git 跟踪 | 是否含密钥 |
| --- | --- | --- | --- |
| 团队配置 | `<团队仓库>/models/models.yaml`，以及每个 namespace 的 `models/<ns>/models.yaml` | 是 | 否 |
| 个人配置 | `~/.teamai/models/models.yaml` | 否 | 否 |
| 个人配置的 API key | `~/.teamai/models/values.json` | 否，权限 `0600` | 密钥或环境变量名 |
| 团队配置的 API key | `~/.teamai/models/teams/<仓库身份哈希>.json` | 否，权限 `0600` | 密钥或环境变量名 |
| ownership 与恢复状态 | `~/.teamai/models/managed.json` | 否，权限 `0600` | 可能包含原值和写入的密钥 |

密钥要么保存在本地，要么引用环境变量，不接受命令行参数传入。`0600` 并非加密。团队密钥文件名只是仓库身份的哈希，`teamai.yaml` 中的团队名不参与其中，因此重命名团队不会导致密钥失效。当完全不存在仓库身份（可用的 remote、URL 或 `repo:` claim 都没有）时，文件名改为哈希团队 slug 与路径的组合——此时没有任何仓库形态的信息可以依赖，靠 slug 区分共享同一检出路径、名字不同的团队；旧版本遗留的 `<团队名>-<哈希>.json` 会在纯哈希文件尚不存在时被原位读取，不做任何改名，下一次保存才会写入纯哈希文件名。在 provider 可确定的 digest（URL 或 URL 形态的 `repo:` claim/remote）下写出的遗留文件，identity 自带主机，直接按 digest 读取；在 **provider 不明确** 的 digest（形如 `owner/repo` 的 `repo:` claim、provider 相对的 remote、裸 alias，或没有仓库身份）下写出的遗留文件既不指向唯一仓库——旧命名从未编码 provider，两个 provider 的同名团队会哈希出同一个文件，slug 无法在 provider 之间证明归属。这类文件绝不按静默规则读取：CLI 会展示一次，由用户显式确认采用这个确切的 `<团队名>-<哈希>` identity 后才读取，随后下一次保存会把密钥迁移到 provider 限定的纯哈希文件名下。非交互与 `--dry-run` 运行一律不采用：只报告该文件并保持不读。provider 不明确 identity 下的 switch 记录同样绝不采用——旧命名从未编码 provider，任何 slug（即使与本 checkout 完全相同的 slug）都无法证明归属：GitHub 与 GitCode 上都叫 `Alpha`、裸 claim 同为 `acme/widgets` 的两支团队会共享完全相同的 `alpha-<digest>` 形式。绝不把任何机器级记录当作归属证明，因为同一机器上被各 checkout 共享的记录对别的团队同样成立；只有对遗留 values 文件的显式采用才能重新确立本团队的存在，其已切换的 agent 随后通过下一次 `models switch` 以 provider 限定的 identity 重新记录。provider 可确切的 switch 记录仍按 digest 直接匹配。每次切换 `team:` 配置时也会记录这个身份，`pull` 只会重新应用当前团队的配置。文件内每个密钥保存在 `team:<id>@<origin>` 下，见 [Namespace 与密钥绑定](#namespace-与密钥绑定)。

## 目录与协议

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models: [glm-5.3, deepseek-v4-flash]
```

协议包括 `anthropic`、`openai-responses` 和 `openai-chat-completions`，按分组显式声明，不会推断。Anthropic 使用根地址，OpenAI 协议使用 `<root>/v1`，Buddy 条目使用完整的 `<root>/v1/chat/completions`。`base_url` 不能以 `/v1` 结尾，不能包含凭证、查询参数或片段；未知字段和重复的模型 ID 会被拒绝。各协议路径不符合上述规则的网关暂时无法表达；有团队需要时，再增加一个可选的按协议覆盖 URL 的字段。

目录中的第一个模型是默认模型。`switch --model <id>` 可以另选默认模型，之后重新应用时会沿用这个选择。用 `configure --protocol/--model` 编辑时，第一个模型的位置保持不变。

团队配置和个人配置分别使用 `team:` 与 `local:` 命名空间。不带前缀的 ID 只在唯一时可用；团队已使用的 ID，`models add` 会拒绝。

## Namespace 与密钥绑定

团队配置遵循所有资源类型共用的 namespace 规则（#707）：`models/models.yaml` 对所有人共享，`models/<ns>/models.yaml` 只在成员的角色或项目的 `resources.models` 中激活了 `<ns>` 时读取。namespace 中的配置整体替换根目录中 `id` 相同的配置。两个生效 namespace 出现同一个 `id`，或某个生效文件无法解析时，本次 pull 不更新模型，所有 Agent 保持原样；同一文件中重复的 `id` 本身就是解析错误。旧模式（未配置角色和项目）只读取根文件。

覆盖可以把配置指向另一个网关，因此团队密钥绑定到配置 `id` 和 `base_url` 的 origin（协议、主机、端口），保存在 `team:<id>@<origin>` 下。密钥只会与同一 origin 的网关一起写入 Agent：

- 只有当前 origin 存有密钥时，`pull` 才会重新应用配置。如果该 `id` 只存有其他 origin 的密钥，`pull` 不修改 Agent，并提示运行 `teamai models switch team:<id>`，由它询问新网关的密钥。根配置被改到另一个主机时同样如此。
- 同一个 `id` 可以同时保存多个 origin 的密钥，因此离开 namespace 后 Agent 会用已保存的密钥回到根配置，无需再次输入。
- 此规则之前保存在 `team:<id>` 下的密钥，会在第一次读取它的 pull 或 `models` 命令中绑定一次：绑定到 TeamAI 最近为切换到该配置的 Agent 写入的 origin（若其中包含根配置当前的 origin，则绑定到该 origin）；若没有 Agent 切换到该配置，则绑定到根配置当前的 origin。之后它不会跟随根配置迁移到新的主机，因此在 beta 与升级之间被迁移的根配置不会收到它。若该 `id` 没有根配置，密钥保持未绑定状态且不会被使用。
- 只存在于成员已离开的 namespace 中的配置不会被撤销：Agent 保留设置，`pull` 提示该配置 `is no longer active in your namespaces`；可用 `teamai models restore` 撤销。

## Agent 写入

| Agent | 协议 | 受管字段 |
| --- | --- | --- |
| Claude Code | `anthropic` | `settings.json.env` 中：网关地址、auth token、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`，并关闭网关发现；受管期间清除 `ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`、`ANTHROPIC_MODEL` 和服务端下发的 `ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}`。顶层：`model` 和列出全部模型的 `modelPicker` |
| Codex | `openai-responses` | 顶层 `model`、`model_provider` 和 `[model_providers.teamai]`；从不修改 `auth.json` |
| OpenCode | 任意 | 顶层 `model`，以及 `teamai-anthropic`、`teamai-chat`、`teamai-responses` 三个 provider；支持多种协议的模型只注册一次，优先 Chat Completions |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | 每个模型一个 `models.json` 条目；`availableModels` 不为空时加入受管 ID |

Claude 的三个模型家族别名分别指向 ID 中含 `opus`、`sonnet`、`haiku` 的第一个网关模型，找不到则指向默认模型，保证后台任务和 subagent 不会请求网关上不存在的模型。通过环境变量引用的密钥分别写成 `env_key`（Codex）、`{env:VAR}`（OpenCode）和 `${VAR}`（CodeBuddy/WorkBuddy）；Claude 没有这种语法，只能写入解析后的密钥。

Codex 按行编辑，以保留注释和格式。写入前会解析结果并与预期值比对；遇到无法处理的特殊写法时直接失败，不修改文件。

## Ownership 与恢复

首次切换前，TeamAI 会记录受管字段的原值。之后某次切换若从目录中去掉了某个 Buddy 模型，会立即放回它的原条目，并不再跟踪该 ID，用户之后用同名 ID 建的条目不会被恢复操作动到。之后每次切换、pull 重新应用或恢复，都会先比较当前字段与 TeamAI 上次写入的值；两者不一致，说明用户或其他工具已经接管，TeamAI 会跳过该 Agent。Claude 顶层的 `model` 不参与比较，因为 `/model` 会把用户的选择写到这里：重新应用时，只要目录中仍有该模型就保留用户的选择；恢复时，若当前模型不是 TeamAI 提供的，也保持不变。

`settings.json` 启用了 Bedrock、Vertex 或 Foundry 时拒绝切换 Claude。Shell 中与 TeamAI 写入值不一致的 `ANTHROPIC_*` 只给出警告、不拒绝，因为 Claude Code 桌面端等宿主应用会为自己的会话设置这些变量。

写入顺序保证中断后可以收敛：先保存待完成记录，再原子替换 Agent 文件，最后清除待完成标记。下次执行命令时，只有受管字段与写入前或写入后的状态之一一致，才会自动收敛；否则跳过该 Agent。写入失败会删除对应的待完成记录。记录中固定了 Agent 的配置路径（支持 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_CONFIG_HOME`、`OPENCODE_CONFIG`），之后路径变化也不会让恢复写到别处。所有模型操作通过一把锁串行执行；`pull` 会在持锁后再次确认 Agent 仍在使用它要重新应用的配置。

某个 Agent 使用 TeamAI 模型配置期间，local-agent 服务端模型下发会对该 Agent 暂停。用户级完整卸载会在清理 MCP 前先恢复模型配置，若有 Agent 无法恢复就停止卸载并保留记录；项目级卸载不改动这些机器级配置。
