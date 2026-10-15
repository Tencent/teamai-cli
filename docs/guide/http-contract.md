# ClawPro HTTP backend

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

ClawPro implements these three endpoints for `teamai init --http <baseUrl>`. Send `Authorization: Bearer <api-key>`.

End users only need `teamai init --http`, described in [Member Onboarding](./member-guide.md#member-onboarding).

| Endpoint | Method | Purpose |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | Session start: register the agent and installed skills |
| `{baseUrl}/api/local-agent/sync` | POST | Report status and return commands to run |
| `{baseUrl}/api/local-agent/commands/ack` | POST | Acknowledge one command: `{ id, status, error }` |

`sync` returns the commands:

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

Push models with `apply_model_config`. `cmd` is a JSON string. `{"models":[...]}` replaces the whole set.

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

Installed models are reported through `report`. Omit `models` when there is nothing to report. `api_key` is not sent back.

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```
