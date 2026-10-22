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
scope: workspace               # workspace (default from init) or user; project is read as workspace
projectRoot: /path/to/my-workspace
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

The role, project and tag fields hold this directory's own selection. A workspace also delivers the selections of the repos set up inside it, read at each pull and never written here. See [Workspaces with repos inside](./distribution.md#workspaces-with-repos-inside).

#### Relocated tool roots (`toolRoots`)

When Claude Code uses `CLAUDE_CONFIG_DIR`, Codex uses `CODEX_HOME`, or Cursor CLI uses `CURSOR_DATA_DIR` / `CURSOR_CONFIG_DIR`, `init` records those directories. The accepted keys are `claude`, `codex`, `cursor-data` and `cursor-config`.

```bash
CLAUDE_CONFIG_DIR=~/.claude-work teamai init
CLAUDE_CONFIG_DIR= teamai init    # clear the record
CODEX_HOME= teamai init
CURSOR_DATA_DIR=~/.cursor-data teamai init
CURSOR_CONFIG_DIR=~/.cursor-config teamai init
```

The directory has to sit in your home or under `~/.config/`. Copilot uses its own `COPILOT_HOME`.

Cursor CLI moves two directories: `CURSOR_DATA_DIR` holds the transcripts, `CURSOR_CONFIG_DIR` the `cli-config.json` the co-author setting goes into. Its user `mcp.json`, `rules/` and `commands/` stay in `~/.cursor` whatever the two variables say, so those keep their default paths. With `CURSOR_CONFIG_DIR` unset the config root is `$XDG_CONFIG_HOME/cursor` when that variable is set, `~/.cursor` otherwise.

#### Recorded tool homes (`~/.teamai/tool-homes.json`)

Some tools move their home with a variable: `XDG_CONFIG_HOME` (OpenCode, Muse), `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `PI_CODING_AGENT_DIR`, `COPILOT_HOME`, `DSH_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_PROFILE`. On Windows, Hermes lives in `%LOCALAPPDATA%\hermes`. A relative value of a tool's own variable resolves against the directory you run teamai from, as the tool resolves it; a relative `XDG_CONFIG_HOME` or `%LOCALAPPDATA%` is ignored. teamai syncs to the moved home. For OpenCode, Muse and Pi only part of it follows so far. With `XDG_CONFIG_HOME=/x`, OpenCode's skills and the `opencode.json` that `teamai models switch` writes go to `/x/opencode`, and Muse's skills to `/x/muse/skills`, while their other files stay under `~/.config/opencode` and `~/.config/muse`. With `PI_CODING_AGENT_DIR=/x`, Pi's skills and `models.json` go to `/x`, while its extension, MCP and `AGENTS.md` stay under `~/.pi/agent`. `teamai doctor` notes it.

The first `pull` that sees the variable records the home for the whole machine in `~/.teamai/tool-homes.json` when the directory exists, and never replaces a record. `teamai init` records it too and replaces an earlier record: for a tool's own variable (`HERMES_HOME`, `OPENCLAW_PROFILE`, ...) even before the directory exists, for `XDG_CONFIG_HOME` only once it does. Hermes' Windows default only fills a missing record. So run `init` from a shell your tools run in. After that, a pull from a shell without the variable still syncs there, in every scope. To move the home, run `teamai init` with the new value. To clear the record, run it with the variable set but blank. `teamai doctor` reports `<tool> home exists` when the recorded directory is gone, and `<tool> home matches <variable>` when the shell names another directory.

When a tool's skills directory moves, teamai's copies in the old one stay. Another shell, another project or another tool may still read that directory, and teamai cannot tell. The first pull that delivers the skills to the new directory names the old one, and teamai no longer updates the copies there. Delete them once no tool reads that directory.

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
| Muse Code | `openai-responses` | `~/.config/muse/settings.json`, and the key as `META_API_KEY` in `~/.teamai/models/env.sh`, which your shell profile loads |

The example has no `openai-responses` group, so Codex and Muse Code are left alone.

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
