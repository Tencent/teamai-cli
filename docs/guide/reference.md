# Reference

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Command Reference

The full list is in [`skill-data/core/references/commands.md`](../../skill-data/core/references/commands.md), or run `teamai --help` and `teamai <command> --help`.

---

## Configuration Reference

### teamai.yaml (remote team config)

```yaml
team: my-team
description: Team AI resource repo
repo: https://github.com/your-org/your-repo.git
provider: github
# language: en                # optional. en is English only. Omit it, or set zh, and the recall rule, TodoWrite hint, and merged-MR hint stay bilingual
# scope: ignored if present. teamai init --scope sets the local install

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
    enabled: false
  docs:
    localDir: ./.teamai/docs   # default ~/.teamai/docs
  env:
    injectShellProfile: true
  coAuthor:
    enabled: false
  gitExclude:
    enabled: true              # init writes true for a new team
  contributeHint:
    enabled: true
  intervention:
    correctionKeywords: []
  webhooks:
    enabled: true
    endpoints:
      - url: https://example.com/hook
        type: json             # json | feishu | wecom
        events: ["*"]          # session-start, session-stop, skill-use, push, pull, or *
        secret: my-signing-key
        timeout: 5000
        retries: 3
```

### config.yaml (local config)

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto             # auto, prompt, or skip
scope: project                 # project (default from init) or user
projectRoot: /path/to/project
inheritUserScope: true
coAuthorEnabled: true
gitExcludeEnabled: true
contributeHintEnabled: false
usageReportEnabled: false
codexTrustEnabled: false
toolRoots:
  claude: ~/.claude-work
  codex: ~/.codex-alt
```

#### Relocated tool roots (`toolRoots`)

When Claude Code uses `CLAUDE_CONFIG_DIR`, or Codex uses `CODEX_HOME`, `init` records that directory. Only `claude` and `codex` are accepted.

```bash
CLAUDE_CONFIG_DIR=~/.claude-work teamai init
CLAUDE_CONFIG_DIR= teamai init    # clear the record
CODEX_HOME= teamai init
```

The directory has to sit in your home or under `~/.config/`. Copilot uses its own `COPILOT_HOME`.

### Webhook notifications (`sharing.webhooks`)

| Event | Fires when |
| --- | --- |
| `session-start` | A session starts |
| `session-stop` | A session ends |
| `skill-use` | A skill is invoked |
| `push` | `teamai push` actually pushes |
| `pull` | `teamai pull` actually syncs |
| `*` | Every event above |

Tool arguments and output are not sent. A `secret` adds `X-TeamAI-Signature`.

```bash
teamai webhook list
teamai webhook test
teamai webhook test --dry-run
```

---

## Model profiles

`teamai models switch` is what changes an agent. After that, `pull` keeps switched agents on the team's catalog.

`team:<id>` comes from `models/models.yaml`, and from `models/<ns>/models.yaml` for an active namespace. It has no key. `local:<id>` is `~/.teamai/models/models.yaml`. Write the prefix when the two share an id.

### Team catalog

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

`api_key` must be `${API_KEY}`. `base_url` must not end in `/v1`. The first model is the default.

| Agent | Protocol | `switch` writes |
| --- | --- | --- |
| Claude Code | `anthropic` | `~/.claude/settings.json` |
| Codex | `openai-responses` | `~/.codex/config.toml` |
| OpenCode | any | `opencode.json` |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json` |
| Pi | any | `~/.pi/agent/models.json` |
| OMP | any | `~/.omp/agent/models.yml` |

The example has no `openai-responses` group, so Codex is left alone.

### Use a team profile

```bash
teamai models list
teamai models switch tokenhub
teamai models switch --agent claude --model deepseek-v4-flash
teamai models switch --dry-run
```

With no name, it lists every profile and asks. Put the key in an environment variable, not in the command:

```bash
teamai models configure tokenhub --from-env TOKENHUB_API_KEY
printf '%s' "$TOKENHUB_API_KEY" | teamai models configure tokenhub --api-key-stdin
```

### Team profiles by namespace

`models/<ns>/models.yaml` replaces the root profile with the same `id`. Declare it the same way as env. See [Env, hooks and MCP servers by namespace](./sharing.md#env-hooks-and-mcp-servers-by-namespace).

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      models: [checkout]
```

When the gateway address changes, run `teamai models switch team:<id>` again. Two namespaces with the same id means models are not updated this time.

### Personal profiles

```bash
teamai models add my-gateway --name "My gateway" \
  --protocol anthropic,openai-chat-completions \
  --base-url https://gateway.example.com \
  --model glm-5.3,deepseek-v4-flash \
  --from-env MY_GATEWAY_KEY
teamai models switch my-gateway
```

A personal id cannot reuse a team profile's id.

### Switching back

```bash
teamai models restore
teamai models restore --agent codex
teamai models remove local:my-gateway
```

`restore` puts back only the fields TeamAI changed. An agent you edited yourself is skipped by later switches and restores.
