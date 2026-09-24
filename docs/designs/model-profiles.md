# Model profile management

## Goals and boundaries

Model profiles let a team publish one gateway catalog that every supported agent (Claude Code, Codex, OpenCode, CodeBuddy, WorkBuddy) can use, and let an individual keep personal gateways, without turning the team Git repository into a secret store.

- The catalog format stays small: `id`, `name`, `base_url`, `api_key: ${API_KEY}` (a placeholder), and `model_groups`. There are no per-agent sections; agent support follows from protocols.
- Agents change only after an explicit `teamai models switch`. From then on `teamai pull` re-applies the team's latest catalog to the agents switched to it. Agents never switched are never touched.
- Everything TeamAI writes into an agent file can be restored, and a field the user changes is never overwritten.

## Data ownership

| Data | Location | Git-tracked | Contains secrets |
| --- | --- | --- | --- |
| Team profiles | `<team repo>/models/models.yaml` | Yes | No |
| Personal profiles | `~/.teamai/models/models.yaml` | No | No |
| Personal API keys | `~/.teamai/models/values.json` | No, mode `0600` | Key or env-var name |
| Team-profile API keys | `~/.teamai/models/teams/<team-name>-<hash>.json` | No, mode `0600` | Key or env-var name |
| Ownership and restore state | `~/.teamai/models/managed.json` | No, mode `0600` | May hold previous and written keys |

A key is either stored or referenced as an environment variable; it is never accepted as a command-line argument. `0600` is not encryption. The team-key file name combines the sanitized `teamai.yaml` team name with a hash of the repository identity, and the same identity is recorded with each `team:` switch so `pull` only re-applies the current team's profiles.

## Catalog and protocols

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

Protocols are `anthropic`, `openai-responses`, and `openai-chat-completions`, declared per group and never inferred. Anthropic uses the root URL, the OpenAI protocols `<root>/v1`, and Buddy entries the full `<root>/v1/chat/completions`. `base_url` may not end in `/v1` or carry credentials, a query, or a fragment; unknown fields and duplicate model IDs are rejected. A gateway whose protocols live under unrelated paths cannot be expressed yet; that would be an optional per-protocol URL override, added when a team needs it.

The first model in the catalog is the default. `switch --model <id>` chooses another one; the choice is remembered for later re-applies. `configure --protocol/--model` edits keep the first model first.

Team and personal profiles live in the `team:` and `local:` namespaces. An unqualified ID works only when unique, and `models add` refuses an ID the team already uses.

## Agent writes

| Agent | Protocol | Managed fields |
| --- | --- | --- |
| Claude Code | `anthropic` | In `settings.json.env`: base URL, auth token, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, gateway discovery off; cleared while managed: `ANTHROPIC_API_KEY`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_MODEL`, server-delivered `ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}`. Top level: `model` and a `modelPicker` listing every model |
| Codex | `openai-responses` | Top-level `model`, `model_provider`, and `[model_providers.teamai]`; `auth.json` is never touched |
| OpenCode | any | Top-level `model` and providers `teamai-anthropic`, `teamai-chat`, `teamai-responses`; a model served over several protocols is registered once, preferring Chat Completions |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | One `models.json` entry per model; a non-empty `availableModels` gets the managed IDs |

Claude family aliases point at the first gateway model whose ID contains `opus`, `sonnet`, or `haiku`, else the default, so background work and subagents never request a model the gateway lacks. Keys referenced by environment variable are written as `env_key` (Codex), `{env:VAR}` (OpenCode), and `${VAR}` (CodeBuddy/WorkBuddy); Claude has no such syntax and receives the resolved key.

Codex is edited line by line to keep comments and formatting. The result is parsed and compared with the intended values before writing; an unusual layout the edit cannot handle fails without touching the file.

## Ownership and restore

Before the first switch TeamAI records the managed fields' values. When a later switch drops a Buddy model from the catalog, its original entry is put back at once and TeamAI stops tracking that ID, so a user entry that reuses it is never touched by restore. Each later switch, pull re-apply, or restore first compares the current fields with what TeamAI last wrote; if they differ, the user or another tool took over and TeamAI skips that agent. Claude's top-level `model` is excluded from that comparison because `/model` writes the user's pick there: a re-apply keeps the pick while the catalog still offers it, and restore keeps a model TeamAI never offered.

Claude is refused while `settings.json` enables Bedrock, Vertex, or Foundry. Shell `ANTHROPIC_*` values that differ from what TeamAI writes produce a warning, not a refusal: host apps such as the Claude Code desktop app set them for their own sessions.

Writes are ordered to survive interruption: a pending record is saved, the agent file is replaced atomically, and the pending mark is cleared. The next command settles an interrupted operation only when the managed fields match either side; otherwise the agent is skipped. A write that fails removes its pending record. The record pins the agent's config path (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG` are honored), so a later path change never redirects a restore. A lock serializes model operations; `pull` confirms under that lock that an agent still uses the profile it decided to re-apply.

While a profile is active on an agent, the local-agent server model delivery pauses for it. A full user-scope uninstall restores model settings before removing MCP servers and stops, keeping the record, if any agent cannot be restored; project-scope uninstall leaves these machine-wide settings alone.
