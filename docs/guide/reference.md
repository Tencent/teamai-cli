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
# language: en                # optional. en is English only. Omit it, or set zh, and the recall rule, TodoWrite hint, and merged-MR hint stay bilingual. zh shows the friction reminder in Chinese
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

workflows:
  retention: 14d              # how long doctor --fix leaves what a settled run left: a duration such as 14d, or never
  driver: local                # the driver for the runs that teamai score, benchmark run and the other commands that start a workflow, score --drain and a session start begin: local, none, or a driver's name

```

### config.yaml (local config)

```yaml
repo:
  localPath: /path/to/.teamai/team-repo
  remote: https://github.com/your-org/your-repo.git
username: your-name
updatePolicy: auto             # auto, prompt, or skip
updateOtherInstallations: true # also update other registered npm-global copies; default false
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

The member settings are `ai.tool`, `workflows.*`, `recallEnabled`, `contributeHintEnabled`, `mrHintEnabled`, `coAuthorEnabled`, `usageReportEnabled`, `codexTrustEnabled`, `modelAliases`, `sessions`, `scoring`, `autoCompactTokens`, `updatePolicy` and `updateOtherInstallations`. In `workflows.tools`, `workflows.allow` and `modelAliases`, each entry counts on its own. `scoring` from `~/.teamai/config.yaml` only makes session judging stricter than the team's ([Finished sessions](./scorers.md#finished-sessions)). `updatePolicy`, `updateOtherInstallations` and `autoCompactTokens` act on the whole machine, so one scope decides them: the user scope when there is one, else the scope that runs. Every other key belongs to one install and is never read from the machine. `doctor` names such a key in a `~/.teamai/config.yaml` that holds no install.

| You want | Write | In |
|---|---|---|
| Codex for one command | `TEAMAI_AI_TOOL=codex teamai import --dir .` | the shell |
| Codex for teamai's AI calls in every workspace | `ai: { tool: codex }` | `~/.teamai/config.yaml` |
| Claude in one workspace all the same | `ai: { tool: claude }` | that workspace's `~/.teamai/projects/<slug>/config.yaml` |
| Recall on for the whole team | `sharing: { recall: { enabled: true } }` | the team's `teamai.yaml` |
| No judging of the sessions you run by hand, in any workspace | `scoring: { sessions: { attended: off } }` | `~/.teamai/config.yaml` |
| Keep what workflow runs leave for a week on this machine ([The branches a run leaves](./workflow.md#the-branches-a-run-leaves)) | `workflows: { retention: 7d }` | `~/.teamai/config.yaml` |
| Leave the runs `teamai score`, `teamai benchmark run` and the other commands that start a workflow, `teamai score --drain` and a session start begin to driver `acme-sandbox`, which this machine does not run: each run waits for it. `workflow start` and `resume` do not read it | `workflows: { driver: acme-sandbox }` | the team's `teamai.yaml` |

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

teamai's own AI calls (enrich, codebase, import, promote) run on the first installed tool that teamai launches: Claude Code and its internal builds first, then Codex and its internal builds, then the other tools [Tool support](./tool-support.md) marks for AI calls. To use another, name a tool id such as `codex`. The first of these that is set wins:

1. `TEAMAI_AI_TOOL`, for one shell.
2. `ai.tool` in the config of the workspace or self install the command runs in, `~/.teamai/projects/<slug>/config.yaml`.
3. `ai.tool` in `~/.teamai/config.yaml`, for this machine. A command outside any install reads only this one.

`teamai init --agent <tool>` sets `ai.tool` in the install's config to the first tool it names that teamai launches, unless that config or `~/.teamai/config.yaml` already names one.

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

teamai syncs to the directory when it sits in your home or under `~/.config/`. A directory outside your home is recorded too, but only for the tool's sessions: teamai reads the sessions there and keeps syncing the tool's other files to its default root, and `init` and `teamai doctor` say so. When the config already records a root in your home for the tool, `init` keeps it and says how to switch. Copilot uses its own `COPILOT_HOME`. A workflow step on Claude Code or Codex starts it with its variable set to the directory teamai syncs to, even from a shell without that variable or one that names another directory. While the recorded directory is gone, pull skips the tool, a workflow step does not start it, and `teamai doctor` reports `Claude Code root exists` or `Codex root exists`.

Cursor CLI moves two directories: `CURSOR_DATA_DIR` holds the transcripts, `CURSOR_CONFIG_DIR` the `cli-config.json` the co-author setting goes into. Its user `mcp.json`, `rules/` and `commands/` stay in `~/.cursor` whatever the two variables say, so those keep their default paths. With `CURSOR_CONFIG_DIR` unset the config root is `$XDG_CONFIG_HOME/cursor` when that variable is set, `~/.cursor` otherwise.

#### Recorded tool homes (`~/.teamai/tool-homes.json`)

Some tools move their home with a variable: `XDG_CONFIG_HOME` (OpenCode, Muse), `OPENCODE_CONFIG_DIR`, `HERMES_HOME`, `HERMES_DATA_DIR_SUFFIX`, `PI_CODING_AGENT_DIR` (Pi), `OMP_PROFILE`, `PI_PROFILE` and `PI_CONFIG_DIR` (Oh My Pi), `CODEBUDDY_CONFIG_DIR`, `COPILOT_HOME`, `DSH_HOME`, `JOYCODE_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_HOME` and `OPENCLAW_PROFILE`. Hermes also moves to the profile its `active_profile` file names. teamai reads that file on every run, inside the recorded or moved Hermes home, and never records the profile, so `hermes profile use` takes effect at the next pull. Oh My Pi also reads `PI_CODING_AGENT_DIR`, but teamai keeps Oh My Pi's files out of it, because that directory is Pi's. `pull` and `teamai hooks remove` change only the active Hermes or Oh My Pi profile, since profiles run side by side. `teamai uninstall` removes teamai's Hermes hook script, instructions plugin, their `config.yaml` entries and approval, and SOUL.md block, and its Oh My Pi extension, from the default home, the recorded or moved home, and every profile under them. On Windows, Hermes lives in `%LOCALAPPDATA%\hermes`. A relative value of a tool's own variable resolves against the directory you run teamai from, as the tool resolves it; a relative `XDG_CONFIG_HOME` or `%LOCALAPPDATA%` is ignored. teamai syncs to the moved home. `teamai skill list`, `teamai skill show` and `teamai list skills --source local` read the skills there, and `teamai doctor` checks that the tool is installed there. With `XDG_CONFIG_HOME=/x`, OpenCode's skills, agents, rules at `/x/opencode/rules`, instruction blocks at `/x/opencode/teamai-context.md`, hook plugin, and the `opencode.json` that MCP and `teamai models switch` write go to `/x/opencode`. Muse's skills, agents, MCP config, model settings and hooks go to `/x/muse`, and its user rules and instruction blocks are `/x/muse/AGENTS.md`. With `PI_CODING_AGENT_DIR=/x`, Pi's skills, MCP config, `models.json` and extension go to `/x`, and its user rules and instruction blocks are `/x/AGENTS.md`. With `CODEBUDDY_CONFIG_DIR=/x`, CodeBuddy's skills, rules, agents, hooks, `CODEBUDDY.md` and MCP files go to `/x`, `.codebuddy.json` included. Earlier releases wrote the hooks of these four tools under the default home. `pull`, `teamai hooks remove` and `teamai uninstall` remove that copy: OpenCode 1.x also loads the plugins there, and a team hook left there could no longer be named for removal. [Tool support](tool-support.md) lists each tool's home, the variables that move it, and where teamai writes each resource.

The first `pull` that sees the variable records the home for the whole machine in `~/.teamai/tool-homes.json` when the directory exists, and never replaces a record. `teamai init` records it too and replaces an earlier record: for a tool's own variable (`HERMES_HOME`, `OPENCLAW_PROFILE`, ...) even before the directory exists, for `XDG_CONFIG_HOME` only once it does. Hermes' Windows default only fills a missing record. So run `init` from a shell your tools run in. After that, a pull from a shell without the variable still syncs there, in every scope, and a workflow step on one of the tools [Tool support](tool-support.md#workflow-steps-at-a-moved-home) lists starts it with its variable set to that home. To move the home, run `teamai init` with the new value. To clear the record, run it with the variable set but blank. `teamai doctor` reports `<tool> home exists` when the recorded directory is gone, and `<tool> home matches <variable>` when the shell names another directory.

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

### Team tools (`tools/`)

A team on an internal build or a fork of a supported tool adds it as an instance of the shipped tool, with no release. An instance sets another command, home and paths. It keeps the tool's launch flags and session, token, hook and MCP formats. An instance extends Claude Code (`claude`) or Codex (`codex`); teamai refuses one that extends any other tool, naming the file, until it supports that tool ([tool support](./tool-support.md#tool-instances)). An instance with a home of its own keeps sessions of its own; one that keeps the tool's home writes that tool's sessions and receives its files where that tool does, in the root `init` recorded for it (`toolRoots`) too.

```yaml
# tools/acme-claude.yaml in the team repo
schemaVersion: v1alpha1
name: acme-claude                  # the file's name
extends: claude                    # the shipped tool it is an instance of
command: acme-claude               # the name of an executable on PATH, never a path
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
# paths: { skills: .acme-claude/skills }   # optional; without it, claude's paths under .acme-claude/, in a project too because it sets command
```

A member enables it like any tool:

```bash
teamai init --agent claude,acme-claude
teamai pull                                        # skills, rules, hooks and MCP go to .acme-claude/
teamai workflow start review --tools default=acme-claude
teamai score --session <id> --source acme-claude --scorer review-quality
```

The step runs `acme-claude`, and its session is read from `$ACME_CLAUDE_CONFIG_DIR/projects/`, else `~/.acme-claude/projects/`, and a user-scope pull writes to that same home. teamai records a home an instance's `env` moves as it records a tool's own variable ([recorded tool homes](#recorded-tool-homes-teamaitool-homesjson)), so a pull or `uninstall` from a shell without the variable still uses it, and teamai starts the instance's command with the variable set to that home. When `init` moves or clears that record, it removes teamai's hooks from the previous home and names the skills, rules and MCP servers it leaves there. It is recorded, resumed and scored as `acme-claude`'s, never as Claude's. In a project, Claude Code and Codex read the team hooks from the main checkout in every linked worktree, but an instance keeps them in its own home for each checkout a pull ran in, so run `teamai pull` once in a linked worktree before you use the instance's team hooks there.

teamai ignores your value of `env` when it is `XDG_CONFIG_HOME` or `XDG_DATA_HOME`. That value belongs to every tool that reads it, so the instance's home is then `~/<dir>`.

**Accepting the command.** An instance that sets `command` runs a program a teammate named. Its first run asks in a terminal:

```text
Tool "acme-claude" comes from the team repo (…/tools/acme-claude.yaml, content 3f9a1c0e7b2d), which you have not accepted on this machine. It runs acme-claude as you, with your files, in place of claude. Review the file before you accept it.
Run it? [y/N]
```

The line you type answers this question alone. An approval or choice that waits at the same terminal is asked again once you answer. `teamai workflow cancel` ends the question unanswered, and the command does not run. Ctrl-C stops the run without answering, and `teamai workflow resume` asks again.

An unattended run (`TEAMAI_MODE=unattended`, CI, no terminal) refuses it with `tool_not_accepted` until someone accepts it once in a terminal. A Codex instance's command is also what trusts its hooks, so `teamai pull` in a terminal asks the same question when it needs the command for that; an unattended pull, or an answer of no, leaves those hooks untrusted and says so. The answer is kept in `~/.teamai/trust/tools.json` for that file's content: a commit that leaves the file as it is asks nothing, and an edit asks again. An instance with only `home` or `paths` runs the shipped command and needs no acceptance. An instance with `home` and no `command` moves only its user home: in a project it gets the paths of the tool it extends, `.claude/` or `.codex/`, where the shipped command reads them, and when that tool is enabled too both read one copy, which `teamai uninstall --agent` of either leaves for the other. An instance with `command` gets those paths under its home in a project too, since its own build may read its own folder there. `paths` replaces both. With a `home`, the command runs with the tool's home variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) set to that home, so it reads what teamai delivers there, unless the instance has a `command` and its `paths` put files outside that home. One with no `command` whose user-scope `paths` leave its home is refused, since the shipped command would read none of those files: leave `home` out, or point those `paths` inside it; `env` names a variable of the instance's own, which teamai sets to the same home, and teamai refuses that tool's home variable there. teamai also refuses an instance whose home is another tool's, a shipped tool's or another instance's, whether `home.dir` names it or the instance's variable or `toolRoots` makes it resolve there, since two tools on one home write over each other's files, and one whose variable names your home directory itself. To end either refusal, point the variable at a directory of its own and re-run `teamai init`, which takes the refused instance in `--agent` and replaces the record; a pull keeps the home it recorded. teamai reads, exports and imports an instance's sessions with its command too once it is accepted, and with the shipped command until then.

**Adjusting a shipped tool.** An instance named like a shipped tool adjusts it. Its `paths` replace that tool's paths whole, as a `toolPaths` entry does, and win over one. It sets only `paths`: teamai refuses one that sets `command` or `home`, which belong to an instance with a name of its own, such as `name: acme-codex` with `extends: codex`. Only Claude Code and Codex are adjusted this way; for any other tool teamai refuses `tools/<tool>.yaml`, and a `toolPaths.<tool>` entry in `teamai.yaml` moves its paths instead:

```yaml
# tools/claude.yaml
schemaVersion: v1alpha1
name: claude
extends: claude
paths: { skills: .claude/team-skills, rules: .claude/rules }
```

`teamai doctor` names each key such `paths` drop: ``paths in tools/claude.yaml replaces claude's default entry whole and drops keys the default provides: `settings` (.claude/settings.json — hook reconciliation silently skips the tool), …``.

**Your own build.** `~/.teamai/tools/<name>.yaml` holds your own instances. teamai reads that directory and never writes it. One there replaces the team's of the same name for you, needs no acceptance, and is ignored by `workflow resume --next`, which runs a teammate's run on the team's tools.

Its `command` is a bare name on PATH too. To run a build you compiled, put its directory on PATH and name the executable:

```yaml
# ~/.teamai/tools/acme-claude.yaml
schemaVersion: v1alpha1
name: acme-claude
extends: claude
command: acme-claude-dev           # found in ~/src/acme-claude/bin; ~/src/acme-claude/bin/acme-claude-dev is refused
home: { dir: .acme-claude, env: ACME_CLAUDE_CONFIG_DIR }
```

```bash
export PATH="$HOME/src/acme-claude/bin:$PATH"     # in ~/.zshrc or ~/.bashrc
teamai workflow start review --tools default=acme-claude
```

**Where instances come from.** `tools/<name>.yaml`, or a folder `tools/<name>/` holding `TOOL.yaml` with the same content, whose acceptance moving the file there keeps; and `tools/<namespace>/<name>.yaml` for each namespace your roles or projects activate for workflows, which replaces the root one. Two active namespaces that define one name, or two team repos of one scope that define it differently, are a conflict: teamai uses neither and says so. A workspace's instance replaces the user scope's of the same name, as its driver definitions do. A file is refused, naming the problem, when it sets anything but `command`, `home` and `paths`, or when `command` is a path such as `./scripts/acme-claude`, or holds `:`, `*` or `?`: the program at a path can change without the file changing, so acceptance would not cover it. teamai looks `command` up in the PATH directories alone, on Windows too, not in the checkout, so a file of that name in the checkout does not run in its place unless the member's PATH holds `.` or an empty entry.

```text
Tool instance …/tools/acme-claude.yaml is not valid: it sets sessions, and an instance sets only command, home and paths. …
Tool instance …/tools/acme-claude.yaml is not valid: command: command is the name of one executable on PATH, with no path, spaces or arguments, such as acme-claude. …
Tool instance …/tools/acme-kiro.yaml is not valid: extends: an instance extends claude or codex; teamai does not support an instance of kiro or any other tool yet. …
```

An instance gets teamai's own agents, such as `teamai-recall`, and the team's `agents/` in the format of the tool it extends, with that tool's model aliases and `tool_extras`, and `teamai push` takes an edit to its copy. In a project, an instance with no `command` reads that tool's agent files, which are rendered as that tool's, after its `teamai models switch` too. An agent whose `targets` names that tool reaches its instances too; name the instance to reach it alone. The [tool support](./tool-support.md) page lists the tools an instance extends, never the instances themselves.

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
