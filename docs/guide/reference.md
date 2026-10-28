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
  autoCompact:
    tokens: 400000
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
autoCompactTokens: 0           # 0 opts out of the team's autoCompact
gitExcludeEnabled: true
contributeHintEnabled: false
usageReportEnabled: false
codexTrustEnabled: false
scoring:
  isolation: verified          # this scope's judges must be verified; the strictest of team, scorer and this wins
toolRoots:
  claude: ~/.claude-work
  codex: ~/.codex-alt
ai:
  tool: codex                  # the tool teamai's own AI calls run on; see AI tool below
```

The role, project and tag fields hold this directory's own selection. A workspace also delivers the selections of the repos set up inside it, read at each pull and never written here. See [Workspaces with repos inside](./distribution.md#workspaces-with-repos-inside).

#### AI tool (`ai.tool`)

teamai's own AI calls (enrich, codebase, import, promote, the votes judge) run on the first installed tool that teamai launches: Claude Code and its internal builds first, then Codex and its internal builds, then the other tools [Tool support](./tool-support.md) marks for AI calls. To use another, name a tool id such as `codex`. The first of these that is set wins:

1. `TEAMAI_AI_TOOL`, for one shell.
2. `ai.tool` in the config of the workspace or self install the command runs in, `~/.teamai/projects/<slug>/config.yaml`.
3. `ai.tool` in `~/.teamai/config.yaml`, for this machine. A command outside any install reads only this one.

`~/.teamai/config.yaml` can hold only this setting on a machine with no user-scope install:

```yaml
# ~/.teamai/config.yaml
ai:
  tool: codex
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml, beside the fields init wrote
ai:
  tool: opencode
```

A name teamai does not launch, or a tool not on PATH, fails the call and names the setting and file to change. A re-init keeps `ai`. Workflow steps fall back to the same settings; see [Workflows](./workflow.md).

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

Some tools move their home with a variable: `XDG_CONFIG_HOME` (OpenCode, Muse), `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `HERMES_DATA_DIR_SUFFIX`, `PI_CODING_AGENT_DIR` (Pi), `OMP_PROFILE`, `PI_PROFILE` and `PI_CONFIG_DIR` (Oh My Pi), `CODEBUDDY_CONFIG_DIR`, `COPILOT_HOME`, `DSH_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_HOME` and `OPENCLAW_PROFILE`. Hermes also moves to the profile its `active_profile` file names. teamai reads that file on every run, inside the recorded or moved Hermes home, and never records the profile, so `hermes profile use` takes effect at the next pull. Oh My Pi also reads `PI_CODING_AGENT_DIR`, but teamai keeps Oh My Pi's files out of it, because that directory is Pi's. `pull` and `teamai hooks remove` change only the active Hermes or Oh My Pi profile, since profiles run side by side. `teamai uninstall` removes teamai's Hermes hook script, instructions plugin, their `config.yaml` entries and approval, and SOUL.md block, and its Oh My Pi extension, from the default home, the recorded or moved home, and every profile under them. On Windows, Hermes lives in `%LOCALAPPDATA%\hermes`. A relative value of a tool's own variable resolves against the directory you run teamai from, as the tool resolves it; a relative `XDG_CONFIG_HOME` or `%LOCALAPPDATA%` is ignored. teamai syncs to the moved home. `teamai skill list`, `teamai skill show` and `teamai list skills --source local` read the skills there, and `teamai doctor` checks that the tool is installed there. With `XDG_CONFIG_HOME=/x`, OpenCode's skills, agents, rules at `/x/opencode/rules`, instruction blocks at `/x/opencode/teamai-context.md`, hook plugin, and the `opencode.json` that MCP and `teamai models switch` write go to `/x/opencode`. Muse's skills, agents, MCP config, model settings and hooks go to `/x/muse`, and its user rules and instruction blocks are `/x/muse/AGENTS.md`. With `PI_CODING_AGENT_DIR=/x`, Pi's skills, MCP config, `models.json` and extension go to `/x`, and its user rules and instruction blocks are `/x/AGENTS.md`. With `CODEBUDDY_CONFIG_DIR=/x`, CodeBuddy's skills, rules, agents, hooks, `CODEBUDDY.md` and MCP files go to `/x`, `.codebuddy.json` included. Earlier releases wrote the hooks of these four tools under the default home. `pull`, `teamai hooks remove` and `teamai uninstall` remove that copy: OpenCode 1.x also loads the plugins there, and a team hook left there could no longer be named for removal. [Tool support](tool-support.md) lists each tool's home, the variables that move it, and where teamai writes each resource.

The first `pull` that sees the variable records the home for the whole machine in `~/.teamai/tool-homes.json` when the directory exists, and never replaces a record. `teamai init` records it too and replaces an earlier record: for a tool's own variable (`HERMES_HOME`, `OPENCLAW_PROFILE`, ...) even before the directory exists, for `XDG_CONFIG_HOME` only once it does. Hermes' Windows default only fills a missing record. So run `init` from a shell your tools run in. After that, a pull from a shell without the variable still syncs there, in every scope. To move the home, run `teamai init` with the new value. To clear the record, run it with the variable set but blank. `teamai doctor` reports `<tool> home exists` when the recorded directory is gone, and `<tool> home matches <variable>` when the shell names another directory.

When a tool's skills directory, agents directory, rules directory, or instruction-block file moves, teamai's copies at the old place stay. Another shell, another project or another tool may still read that place, and teamai cannot tell. `places` records the agents directory, the rules directory, and the instruction-block file. The first pull that delivers them to the new place names the old one, and teamai no longer updates the copies there. Delete them once no tool reads that place.

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
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json` (CodeBuddy follows its recorded home) |
| Pi | any | `~/.pi/agent/models.json` |
| OMP | any | `~/.omp/agent/models.yml`, or the agent dir of `OMP_PROFILE` (or `PI_PROFILE`) and `PI_CONFIG_DIR` |
| Muse Code | `openai-responses` | `<Muse home>/settings.json` (recorded home, else `$XDG_CONFIG_HOME/muse` or `~/.config/muse`), and the key as `META_API_KEY` in `~/.teamai/models/env.sh`, which your shell profile loads |

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

## ZCode hook stdout budget

Doctor measures the serialized project-rules reply in UTF-8 bytes against `hooks.maxOutputBytes` in `~/.zcode/cli/config.json` (32768 by default). This is a lower bound: other session hints add bytes to the complete reply. ZCode truncates oversized stdout and silently drops a reply that no longer parses, even when its hook is registered. Shorten the rules or increase that positive integer limit enough for the complete reply, then start a new ZCode session. TeamAI does not change the limit or truncate rules.

## Kiro lifecycle hooks

Kiro CLI V3 loads `~/.kiro/hooks/teamai.json` for every agent, including the default agent. Pull and hook injection install its SessionStart hook without requiring a team agent. Before enabling it, they remove only TeamAI’s old agentSpawn command from existing Kiro agents, including member-edited copies, preserving personal hooks and agent fields. `hooks list` and `doctor` check it; hook removal and user uninstall remove it. Project uninstall preserves this shared user hook. A same-named personal file is kept and reported. Pull removes the old managed `agentSpawn` entry from rendered team agents while preserving custom hooks. Lifecycle integration requires V3; Kiro 2.x does not load this standalone hook.
