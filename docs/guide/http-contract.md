# HTTP contract

> [English](http-contract.md) | [简体中文](zh-CN/http-contract.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

When using `teamai init --http <baseUrl>`, the endpoint must implement the following APIs (authenticated via `Authorization: Bearer <api-key>`):

| Endpoint | Method | Purpose |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | Session start: upsert agent + installed skills |
| `{baseUrl}/api/local-agent/sync` | POST | Report status + return pending skill commands |
| `{baseUrl}/api/local-agent/commands/ack` | POST | Acknowledge a single command (`{ id, status, error }`) |

`POST /api/local-agent/sync` returns pending commands:

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

Removing the final HTTP prompt is acknowledged as `failed` when its target cannot be updated. The cached prompt and manifest record remain available for a retry after repairing the markers or file permissions.

The backend may push an **`apply_model_config`** task whose `cmd` is JSON. Both
the documented candidate-set shape and the legacy single-model shape are accepted.
`{"models":[...]}` is a full snapshot; a direct model object is an incremental upsert.
`max_tokens` is optional (CodeBuddy / WorkBuddy `maxOutputTokens`); omitted or `0` defaults to `4096`. Claude does not use it.

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

The candidate set is applied only to the agent that reported the task. CodeBuddy uses
user-level `~/.codebuddy/models.json` (`{ "models": [...] }`). WorkBuddy uses
`~/.workbuddy/models.json`; both the current `{ "models": [...] }` shape and the legacy
top-level array are accepted, and an existing file keeps its shape. A workspace-scoped
CodeBuddy or WorkBuddy task uses `<workspace>/.codebuddy/models.json`, matching the
embedded model loader. That file holds the API key, so it is always kept out of git,
whatever the git exclude setting: before writing it, teamai lists it in the `credentials`
block of the repository's `.git/info/exclude` and writes the key only once git confirms
it ignores the file (a workspace outside any git repository gets the key with no line). If
git tracks the file, a rule in a `.gitignore` re-includes it, the exclude file cannot be
written, or git cannot confirm, the key is not written and the task fails with the reason
and the fix (for a tracked file, `git rm --cached` it). A task with no models removes
teamai's entries; when nothing else is left in a file teamai created, the file is deleted,
then its line. A file teamai did not create, one git tracks, or a link stays, and so does
its line. The same happens for every workspace when `teamai source remove-http` removes the
HTTP source. teamai no longer creates
`<workspace>/.codebuddy/.gitignore`, and deletes the one an earlier version created while it
holds only its two lines. Workspace delivery is accepted only for a path
already present in the reporter's workspace bindings. User-owned entries with the same
model ID are preserved. 

Claude
gets an explicit profile at `~/.claude/teamai-models.json`
and also receives the gateway environment in `~/.claude/settings.json` when it has no
conflicting user-owned Anthropic gateway configuration. The conflict check inspects
both `settings.json` `env` and the process's shell environment (`export ANTHROPIC_*`),
so a user who runs Claude via shell env keeps their own gateway — TeamAI skips the write
and logs the skipped keys to `~/.teamai/reporter/errors.jsonl`. Protected keys are
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}`, and
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. 

A shell value that matches what TeamAI
last wrote (Claude re-injects `settings.json` `env` into the hook process) is recognized
as managed, not a user conflict, so a managed gateway can still be updated or removed on
later syncs. Unsupported agents acknowledge
the task as failed instead of writing another agent's config. Symlinked user config
files remain symlinks. These files are mode `0600`. A successful write is acknowledged with
`type: "apply_model_config"`; malformed payloads are acknowledged as `failed`. Unknown
future task types are silently skipped for protocol compatibility.

The reverse direction is reported through the existing `report` call: models that
TeamAI recorded in its model manifest and can still identify by model ID and provider
on disk are sent as `user_level.models` or, for workspace-scoped deliveries, the
matching `workspaces[].models`. Normal agent-added metadata does not suppress
the report. A successful apply triggers this report immediately in the same sync run.
User-owned models are omitted because the backend cannot resolve them. The server
requires both `provider` and `model_id`. Like skills and rules, the field is omitted
entirely when nothing qualifies, because a present array is treated as a full
snapshot. 

CodeBuddy, WorkBuddy, and Claude (the `ANTHROPIC_CUSTOM_MODEL_OPTION`
gateway in `~/.claude/settings.json`) expose a discoverable model config; other tools
report nothing. Reported entries always use `source: "enterprise"`. **`api_key` is
never reported back** — the ProxyToken stays on disk.

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

The HTTP contract is intended for custom integrations. End users only need the `teamai init --http` command described in [Member Onboarding](./member-guide.md#member-onboarding).
