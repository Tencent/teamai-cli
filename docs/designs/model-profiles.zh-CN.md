# 模型配置管理

## 目标与边界

团队发布一份网关目录，所有支持的 Agent（Claude Code、Codex、OpenCode、CodeBuddy、WorkBuddy）都能使用；个人也可以保留自己的网关配置。团队 Git 仓库不能变成密钥存储。

- 目录格式保持精简：`id`、`name`、`base_url`、`api_key: ${API_KEY}`（占位符）和 `model_groups`。不按 Agent 分节，Agent 是否支持由协议推出。
- 只有显式执行 `teamai models switch` 才会修改 Agent。此后，`teamai pull` 会把团队最新目录重新应用到已切换的 Agent；从未切换的 Agent 永远不会被修改。
- TeamAI 写入 Agent 文件的内容都能恢复，用户自己改过的字段绝不会被覆盖。

## 数据归属

| 数据 | 位置 | Git 跟踪 | 是否含密钥 |
| --- | --- | --- | --- |
| 团队配置 | `<团队仓库>/models/models.yaml` | 是 | 否 |
| 个人配置 | `~/.teamai/models/models.yaml` | 否 | 否 |
| 个人配置的 API key | `~/.teamai/models/values.json` | 否，权限 `0600` | 密钥或环境变量名 |
| 团队配置的 API key | `~/.teamai/models/teams/<团队名>-<哈希>.json` | 否，权限 `0600` | 密钥或环境变量名 |
| ownership 与恢复状态 | `~/.teamai/models/managed.json` | 否，权限 `0600` | 可能包含原值和写入的密钥 |

密钥要么保存在本地，要么引用环境变量，不接受命令行参数传入。`0600` 并非加密。团队密钥文件名由 `teamai.yaml` 中清理后的团队名和仓库身份哈希组成；每次切换 `team:` 配置时也会记录这个身份，`pull` 只会重新应用当前团队的配置。

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
