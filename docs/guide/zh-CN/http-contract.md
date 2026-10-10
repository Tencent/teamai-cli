# HTTP 契约

> [English](../http-contract.md) | [简体中文](http-contract.md)

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

使用 `teamai init --http <baseUrl>` 时，端点需要提供以下接口（`Authorization: Bearer <api-key>` 鉴权）：

| 端点 | 方法 | 用途 |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | session 启动：upsert agent + 已装 skill |
| `{baseUrl}/api/local-agent/sync` | POST | 上报状态 + 返回待执行的 skill 命令 |
| `{baseUrl}/api/local-agent/commands/ack` | POST | 回执单条命令（`{ id, status, error }`） |

`POST /api/local-agent/sync` 返回待执行命令：

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

删除最后一个 HTTP prompt 时，若目标无法更新，回执为 `failed`。缓存中的 prompt 和 manifest 记录均予以保留，修复标记或文件权限后可重试。

后端可下发 **`apply_model_config`** 任务，其 `cmd` 为 JSON。客户端同时兼容设计文档中的候选集结构和
旧版单模型结构：`{"models":[...]}` 按完整快照处理，直接模型对象按增量 upsert 处理。
`max_tokens` 可选（对应 CodeBuddy / WorkBuddy 的 `maxOutputTokens`）；缺省或 `0` 时默认 `4096`。Claude 不使用该字段。

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

候选集只会写入当前上报任务的 agent。CodeBuddy 使用用户级 `~/.codebuddy/models.json`（`{ "models": [...] }`）；
WorkBuddy 使用 `~/.workbuddy/models.json`；当前 `{ "models": [...] }` 和旧版顶层数组两种结构都支持，
已有文件保持原结构。CodeBuddy 或 WorkBuddy 的 workspace 级任务写入
`<workspace>/.codebuddy/models.json`，与产品内嵌模型加载器一致。该文件含 API key，因此无论 git exclude
设置如何都会被排除在 git 之外：写入前，teamai 先把它列入仓库 `.git/info/exclude` 的 `credentials` 块，
只有 git 确认忽略该文件后才写入 key（不在任何 git 仓库中的 workspace 直接写入 key，不写 exclude 行）。若 git 已跟踪该文件、
某个 `.gitignore` 规则重新包含了它、exclude 文件无法写入，或 git 无法确认，则不写入 key，任务失败并给出原因和修复方法（已跟踪的文件需
`git rm --cached`）。不含任何模型的任务会移除 teamai 的条目；由 teamai 创建的文件中不再剩下其他内容时删除该文件，然后删除对应的行。
不是 teamai 创建的文件、git 已跟踪的文件或符号链接会保留，对应的行也保留。
`teamai source remove-http` 移除 HTTP 源时会对每个 workspace 做同样的处理。仅当目标路径已存在于 reporter 的 workspace bindings 中时，
才接受 workspace 级下发。若同一模型 ID 已由用户配置，则保留用户条目。


Claude 侧会生成独立配置 `~/.claude/teamai-models.json`；仅当不存在冲突的用户 Anthropic 网关配置时，
才把网关环境变量写入默认 settings。冲突检测会**同时**检查 `~/.claude/settings.json` 的 `env` 和当前进程的
shell 环境变量（`export ANTHROPIC_*`），因此通过 shell 环境变量使用 Claude 的用户会保留自己的网关——
TeamAI 跳过写入，并把跳过的 key 记入 `~/.teamai/reporter/errors.jsonl`。受保护的 key 包括
`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`ANTHROPIC_CUSTOM_HEADERS`、
`ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}` 以及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`。


若某个 shell 值与 TeamAI 上次写入的值一致（Claude 会把 `settings.json` 的 `env` 回注到 hook 进程），
则识别为托管值而非用户冲突，因此后续同步仍可更新或删除托管网关。不支持的 agent 会回执失败，不会误写其他
agent 的配置。用户配置文件是符号链接时会保留链接。以上含凭证文件权限均为 `0600`。落盘成功后以
`type: "apply_model_config"` 回执；非法 payload 回执 `failed`。未来未知任务类型会静默跳过，以保持协议向后兼容。

反向的模型上报走已有的 `report` 接口：仅上报 TeamAI manifest 已记录、且磁盘上的模型 ID 和
provider 仍可识别的模型，用户级放在 `user_level.models`，workspace 级放在对应的
`workspaces[].models`。agent 正常补充元数据不会导致漏报；
模型落盘成功后会在同一次 sync 中立即补一次 report，无需等待下一次 session。用户自有模型不上报，
因为后台无法识别。服务端要求 `provider` 与 `model_id` 同时存在。与 skills/rules 一致，没有任何符合条件的
模型时该字段整体省略——因为存在的数组会被当作全量快照。CodeBuddy、WorkBuddy 和 Claude
（`~/.claude/settings.json` 里的 `ANTHROPIC_CUSTOM_MODEL_OPTION` 网关）有可发现的模型配置，
其余工具不上报。上报条目的 `source` 固定为 `enterprise`。


**`api_key` 不会被回传** —— ProxyToken 只留在本地磁盘。

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

HTTP 契约用于自建集成。普通用户只需使用[成员接入](./member-guide.md#成员接入)中的 `teamai init --http` 命令。
