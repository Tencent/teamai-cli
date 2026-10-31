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

#### Member settings

A member setting is read in this order. The first level that sets it wins:

1. An environment variable or flag, where the setting has one (`TEAMAI_AI_TOOL`, `TEAMAI_RECALL_DISABLED`, `--tools`, …).
2. The config of the scope the command runs in: `~/.teamai/projects/<slug>/config.yaml` for a workspace or self install, `~/.teamai/config.yaml` in user scope.
3. `~/.teamai/config.yaml`, for this machine. It needs no `repo` or `username`, so it works with no user-scope install.
4. The team's `teamai.yaml`, where the setting has a team key.
5. The default.

The member settings are `ai.tool`, `workflows.*`, `recallEnabled`, `contributeHintEnabled`, `mrHintEnabled`, `coAuthorEnabled`, `usageReportEnabled`, `codexTrustEnabled`, `modelAliases`, `sessions`, `scoring`, `autoCompactTokens` and `updatePolicy`. In `workflows.tools`, `workflows.allow` and `modelAliases`, each entry counts on its own. `scoring` from `~/.teamai/config.yaml` only makes session judging stricter than the team's ([Finished sessions](./scorers.md#finished-sessions)). `updatePolicy` and `autoCompactTokens` act on the whole machine, so one scope decides them: the user scope when there is one, else the scope that runs. Every other key belongs to one install and is never read from the machine. `doctor` names such a key in a `~/.teamai/config.yaml` that holds no install.

| You want | Write | In |
|---|---|---|
| Codex for one command | `TEAMAI_AI_TOOL=codex teamai import --dir .` | the shell |
| Codex for teamai's AI calls in every workspace | `ai: { tool: codex }` | `~/.teamai/config.yaml` |
| Claude in one workspace all the same | `ai: { tool: claude }` | that workspace's `~/.teamai/projects/<slug>/config.yaml` |
| Recall on for the whole team | `sharing: { recall: { enabled: true } }` | the team's `teamai.yaml` |
| No judging of the sessions you run by hand, in any workspace | `scoring: { sessions: { attended: off } }` | `~/.teamai/config.yaml` |

`teamai doctor` names the file of the workspace it runs in. The dashboard's [Member settings](./dashboard.md#member-settings) panel shows the same for the workspace you select.

**One machine default, one workspace that differs.** Ana runs teamai's AI calls and workflow steps on Codex, with recall on. A client's repository stays on Claude, without recall:

```yaml
# ~/.teamai/config.yaml: this machine, no install needed
ai: { tool: codex }
recallEnabled: true
workflows:
  tools: { default: codex }
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml: ~/work/client only
ai: { tool: claude }
recallEnabled: false
```

```console
$ cd ~/work/client && teamai doctor
ℹ Member settings:
  ai.tool: claude, from the workspace config /home/ana/.teamai/projects/<slug>/config.yaml (the machine says codex)
  workflows.tools.default: codex, from the machine config /home/ana/.teamai/config.yaml
  recallEnabled: false, from the workspace config /home/ana/.teamai/projects/<slug>/config.yaml (the machine says true, the team false)
$ cd ~/work/api && teamai import --dir .   # runs on codex, from the machine config
```

**One entry of a map.** A workspace that sets one `workflows.tools` entry keeps the machine's others:

```yaml
# ~/.teamai/config.yaml
workflows:
  tools: { default: codex, reviewer: claude }
```

```yaml
# ~/.teamai/projects/<slug>/config.yaml
workflows:
  tools: { implementer: claude }
```

In that workspace `implementer` and `reviewer` run on Claude, and every other agent on Codex.

**Share less from one laptop than the team asks.** The team publishes and judges every session. On her laptop Ana keeps the sessions she runs by hand off `teamai-reports`, judges none from the jobs it runs, and caps judging at two sessions a day in each workspace:

```yaml
# ~/.teamai/config.yaml
sessions:
  publish: { attended: off }
scoring:
  sessions: { unattended: off }
  daily_limit: 2
```

```console
$ cd ~/work/api && teamai doctor
ℹ Member settings:
  sessions.publish.attended: off, from the machine config /home/ana/.teamai/config.yaml (the team says auto)
ℹ Session judging: attended auto, set by scorers/scoring.yaml sessions; unattended off, set by ~/.teamai/config.yaml scoring.sessions.unattended; up to 2 sessions a day, set by ~/.teamai/config.yaml scoring.daily_limit.
```

A machine `scoring` never turns judging on or raises the limit: where the team says `off`, a machine `auto` changes nothing. A workspace's own `scoring` still wins, one mode at a time.

A value of the wrong type in `~/.teamai/config.yaml` is skipped with a warning, and the next level decides. `workflows.allow` is the exception: a bad value there, or a file that cannot be read or parsed, stops workflow commands until you fix it. A save never copies a machine value into a workspace's file; `recall enable` and `recall disable` write theirs.

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

A name teamai does not launch, or a tool not on PATH, fails the call and names the setting and file to change. So does a workspace config here that cannot be read. A re-init keeps `ai`. Workflow steps fall back to the same settings; see [Workflows](./workflow.md).

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

Some tools move their home with a variable: `XDG_CONFIG_HOME` (OpenCode, Muse), `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `HERMES_DATA_DIR_SUFFIX`, `PI_CODING_AGENT_DIR` (Pi), `OMP_PROFILE`, `PI_PROFILE` and `PI_CONFIG_DIR` (Oh My Pi), `CODEBUDDY_CONFIG_DIR`, `COPILOT_HOME`, `DSH_HOME`, `JOYCODE_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_HOME` and `OPENCLAW_PROFILE`. Hermes also moves to the profile its `active_profile` file names. teamai reads that file on every run, inside the recorded or moved Hermes home, and never records the profile, so `hermes profile use` takes effect at the next pull. Oh My Pi also reads `PI_CODING_AGENT_DIR`, but teamai keeps Oh My Pi's files out of it, because that directory is Pi's. `pull` and `teamai hooks remove` change only the active Hermes or Oh My Pi profile, since profiles run side by side. `teamai uninstall` removes teamai's Hermes hook script, instructions plugin, their `config.yaml` entries and approval, and SOUL.md block, and its Oh My Pi extension, from the default home, the recorded or moved home, and every profile under them. On Windows, Hermes lives in `%LOCALAPPDATA%\hermes`. A relative value of a tool's own variable resolves against the directory you run teamai from, as the tool resolves it; a relative `XDG_CONFIG_HOME` or `%LOCALAPPDATA%` is ignored. teamai syncs to the moved home. `teamai skill list`, `teamai skill show` and `teamai list skills --source local` read the skills there, and `teamai doctor` checks that the tool is installed there. With `XDG_CONFIG_HOME=/x`, OpenCode's skills, agents, rules at `/x/opencode/rules`, instruction blocks at `/x/opencode/teamai-context.md`, hook plugin, and the `opencode.json` that MCP and `teamai models switch` write go to `/x/opencode`. Muse's skills, agents, MCP config, model settings and hooks go to `/x/muse`, and its user rules and instruction blocks are `/x/muse/AGENTS.md`. With `PI_CODING_AGENT_DIR=/x`, Pi's skills, MCP config, `models.json` and extension go to `/x`, and its user rules and instruction blocks are `/x/AGENTS.md`. With `CODEBUDDY_CONFIG_DIR=/x`, CodeBuddy's skills, rules, agents, hooks, `CODEBUDDY.md` and MCP files go to `/x`, `.codebuddy.json` included. Earlier releases wrote the hooks of these four tools under the default home. `pull`, `teamai hooks remove` and `teamai uninstall` remove that copy: OpenCode 1.x also loads the plugins there, and a team hook left there could no longer be named for removal. [Tool support](tool-support.md) lists each tool's home, the variables that move it, and where teamai writes each resource.

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
| OpenCode | any but `gemini` | `opencode.json` |
| CodeBuddy / WorkBuddy | `openai-chat-completions` | `models.json` (CodeBuddy follows its recorded home) |
| Pi | any but `gemini` | `~/.pi/agent/models.json` |
| OMP | any but `gemini` | `~/.omp/agent/models.yml`, or the agent dir of `OMP_PROFILE` (or `PI_PROFILE`) and `PI_CONFIG_DIR` |
| Muse Code | `openai-responses` | `<Muse home>/settings.json` (recorded home, else `$XDG_CONFIG_HOME/muse` or `~/.config/muse`), and the key as `META_API_KEY` in `~/.teamai/models/env.sh`, which your shell profile loads |
| Antigravity CLI | `gemini` | `modelProvider: "gemini"` in `~/.gemini/antigravity-cli/settings.json`, and an `agy` shell function in `~/.teamai/models/agy-env.sh`, which your shell profile loads, that sets `GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL` for agy alone |

The example has no `openai-responses` group, so Codex and Muse Code are left alone, and no `gemini` group, so Antigravity CLI is too.

A gateway that serves the Gemini API reaches Antigravity CLI:

```yaml
profiles:
  - id: gemini-gw
    name: Team Gemini gateway
    base_url: https://llm-gw.example.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [gemini]
        models:
          - gemini-3.8-flash
```

After `teamai models switch gemini-gw --agent agy`, agy sends `POST https://llm-gw.example.com/v1beta/models/gemini-3.8-flash:streamGenerateContent` with the key. The model stays the one picked in agy (`/model`): agy sends its own catalog's Gemini ids, so the gateway must serve them.

Gemini CLI reads the same two variables, so teamai never exports them. It defines a function that sets them only for agy, and a key you export yourself does not replace it:

```bash
# ~/.teamai/models/agy-env.sh
unalias agy 2>/dev/null || true
agy() { GEMINI_API_KEY="${API_KEY}" GOOGLE_GEMINI_BASE_URL='https://llm-gw.example.com' command agy "$@"; }
```

```bash
export GEMINI_API_KEY=my-own-key   # in ~/.zshrc, for Gemini CLI
agy                                # still uses the team key and the gateway
gemini                             # still uses my-own-key and Google
```

teamai's own agy runs (AI calls, local workflow steps, the scorer judge) read the key and gateway from that file.

A script does not inherit a shell function, so `bash deploy.sh` that calls `agy` runs it without the gateway. Source the file first: `. ~/.teamai/models/agy-env.sh`.

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

Kiro CLI V3 loads `~/.kiro/hooks/teamai.json` for every agent, including the default agent. Pull and hook injection install its SessionStart hook without requiring a team agent. Before enabling it, they remove only TeamAI’s old agentSpawn command from existing Kiro agents, including member-edited copies, preserving personal hooks and agent fields. `hooks list` and `doctor` check it; hook removal and user uninstall remove it. Project uninstall preserves this shared user hook. A same-named personal file is kept and reported. Pull removes the old managed `agentSpawn` entry from rendered team agents while preserving custom hooks. Lifecycle integration requires V3; Kiro 2.x does not load this standalone hook. When the team has hooks for Kiro, pull also writes `~/.kiro/hooks/teamai-team.json`, one entry per event that runs them through teamai; hook removal and uninstall remove it too.
