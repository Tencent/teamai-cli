# ClawPro HTTP 后端

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

---

ClawPro 为 `teamai init --http <baseUrl>` 实现下面三个接口。请求带 `Authorization: Bearer <api-key>`。

普通用户只用[成员接入](./member-guide.md#成员接入)里的 `teamai init --http`。

| 端点 | 方法 | 用途 |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | session 启动：登记 agent 和已装 skill |
| `{baseUrl}/api/local-agent/sync` | POST | 上报状态，返回待执行的命令 |
| `{baseUrl}/api/local-agent/commands/ack` | POST | 回执一条命令：`{ id, status, error }` |

`sync` 返回待执行命令：

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

下发模型用 `apply_model_config`。`cmd` 是 JSON 字符串，`{"models":[...]}` 整份替换。

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

已装模型通过 `report` 上报。没有可上报的模型时不要带 `models`。`api_key` 不回传。

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```
