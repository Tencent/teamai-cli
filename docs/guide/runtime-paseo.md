# Paseo runtime

> Part of [Workflows](workflow.md).

`teamai-runtime-paseo` runs each prompt step as an agent of a [Paseo](https://github.com/getpaseo/paseo) daemon, in a Paseo workspace on the directory teamai gives the step: your checkout for a read-only step, or a worktree, clone or team repo clone teamai prepares. You watch the agent and answer its permission prompts in the Paseo app. teamai still reads the result, commits, delivers, scores, and recovers the step.

It runs prompt steps only. Commands go to the next runtime in the definition, or to this machine. A prompt step with `setup` goes to the next runtime that runs it; `teamai-paseo` lists none, so there it fails `requirement_unmet`. A prompt step that needs `permissions: unattended` goes to the next runtime that can run it. A step with a `role` runs here with the role teamai delivered into its copy: the runtime only opens that copy in Paseo, and Paseo runs a project's worktree setup only in a worktree it creates itself, so nothing delivers your own resources there instead. It also judges a scored pass, best-effort: see [Judge a scored pass](#judge-a-scored-pass).

## Quick start

Paseo is a prerequisite: teamai ships none of its code. Install Paseo (0.14.0 or later) on the machine that runs the workflow, and start its daemon:

```sh
npm install -g @getpaseo/cli
paseo start
paseo status    # listen: 127.0.0.1:6767
```

The runtime loads Paseo's client from that install when it starts: it follows the `paseo` on `PATH` to its package, so the client always matches your daemon. When teamai runs with a `PATH` that has no `paseo`, point at the client yourself. For an install under its own prefix:

```sh
npm install -g --prefix ~/.paseo-cli @getpaseo/cli
export PASEO_CLIENT_PATH=~/.paseo-cli/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/client
```

With the Paseo desktop app instead, install its command-line tool from the app, which links `paseo` into `~/.local/bin`. The runtime finds it there even when teamai's `PATH` has no `~/.local/bin`. The app keeps its client inside its own archive, so the runtime unpacks the client once per app build into `~/.teamai/runtime-state/paseo-client`, checking each file against the SHA-256 the app records.

teamai ships a definition that sends prompt steps to the daemon on this machine and everything else to this machine. `--driver paseo` uses it:

```yaml
# drivers/teamai-paseo.yaml, shipped with teamai
schemaVersion: v1alpha1
name: teamai-paseo
description: Run each prompt step as an agent of the Paseo daemon on this machine, in a worktree teamai prepares, and every other step on this machine.
runtimes:
  - use: paseo
    options: { max_parallel: 4 }
```

It reaches the daemon your Paseo config names, as `paseo start` reads it: `daemon.listen` in `$PASEO_HOME/config.json` (`~/.paseo/config.json` by default), else `127.0.0.1:6767`. For a daemon at another address, or other options, add a definition of your own in the team repo or in `~/.teamai/drivers/`, as the examples below do.

A workflow needs nothing Paseo-specific:

```yaml
# workflows/paseo-review.yaml
schemaVersion: v1alpha1
name: paseo-review
description: Count the files, then ask a Claude agent in Paseo whether the README has a title.
steps:
  - id: count
    workspace: new
    command: node -e "process.stdout.write(JSON.stringify({files:require('fs').readdirSync('.').length}))"
    output:
      files: number
  - id: classify
    needs: [count]
    workspace: new
    tool: claude
    model: { name: claude-sonnet-5-5 }
    prompt: |
      Read README.md and say whether it starts with a Markdown title.
      Answer with the output {"has_title": true} or {"has_title": false}.
    output:
      has_title: boolean
```

```sh
teamai workflow start paseo-review --driver paseo
```

```text
ℹ Run r0769801107010602 started. If it stops before it ends, continue it here with: teamai workflow resume r0769801107010602, or hand it to another machine with: teamai workflow publish r0769801107010602
{"data":{"done":{"run":"r0769801107010602","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

`count` ran on this machine. `classify` ran in Paseo, in teamai's worktree:

```text
$ paseo inspect 9b38e203
Name      teamai classify · r0769801107010602
Provider  claude
Model     claude-sonnet-5-5
Mode      auto
Cwd       /repo/.teamai/workflow-worktrees/teamai-r0769801107010602-classify-p1-4e57d9b3cff1
```

Each agent carries the labels `teamai-run` and `teamai-step`, so you can list a run's agents:

```sh
paseo ls --all --label teamai-run=r0769801107010602
```

A run started from inside a Paseo agent (Paseo sets `PASEO_AGENT_ID` in each agent's shell) also labels each step and judge agent `teamai-parent=<agent>`, and a step's prompt starts with a line that links back to that agent:

```text
This agent runs step "classify" of teamai workflow run r0769801107010602, started from the Paseo agent paseo://h/srv_vL5abcnfKUWY/agent/1f78c282-039d-452f-9621-bb6677c76eec.
```

```sh
paseo ls --all --label teamai-parent=1f78c282-039d-452f-9621-bb6677c76eec
```

While the agent works, the run's details in the dashboard show it, with a link that opens it in Paseo:

```json
{ "label": "teamai classify · r7f54a1690b9ae0ce", "url": "paseo://h/srv_vL5abcnfKUWY/agent/5f95baae-9117-42b7-9e3d-47891dd3e84d", "fields": { "agent": "5f95baae-9117-42b7-9e3d-47891dd3e84d", "workspace": "wks_f55e98406bad64bd", "model": "claude/claude-sonnet-5-5" } }
```

The step's record has its output and Claude's session id:

```json
{ "id": "classify", "outcome": "success", "outputs": { "has_title": true }, "tool": "claude", "session": "35ab4949-21d9-40df-9444-652e96607b7b" }
```

## Judge a scored pass

A step with `scorers` is judged by the `teamai-score` workflow: its bookkeeping commands run on this machine, and its judge is a confined prompt, which reads one evidence directory and nothing else. Paseo answers it, so a definition with only `paseo` runs and judges a scored step on a machine where teamai launches no tool itself:

```yaml
# drivers/paseo-only.yaml
schemaVersion: v1alpha1
name: paseo-only
tool: claude
runtimes:
  - use: paseo
```

The step is judged by [`review-quality`](scorers.md), on every pass:

```yaml
# workflows/fix-add.yaml
schemaVersion: v1alpha1
name: fix-add
description: Fix add in math.js, and judge the change.
steps:
  - id: fix
    workspace: new
    prompt: |
      add in math.js returns a - b. Make it return a + b, and add math.test.js that checks add(2, 3) is 5 with node:test.
      Edit the files only, and run no command.
    scorers: { names: [review-quality], sampling: all }
    output:
      fixed: boolean
```

```text
$ command -v claude codex opencode
$ teamai workflow start fix-add --driver paseo-only
ℹ Run rd573bcff8eef4e10 started. If it stops before it ends, continue it here with: teamai workflow resume rd573bcff8eef4e10, or hand it to another machine with: teamai workflow publish rd573bcff8eef4e10
ℹ run:rd573bcff8eef4e10:fix:1: review-quality good (teamai-score run re02e01c9b0e36c69).
{"data":{"done":{"run":"rd573bcff8eef4e10","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

In this attended run, the fix agent asked before its two edits, answered with `paseo permit allow <agent> --all`. The judge asked for nothing: it only read the directory with `Read`.

Both agents ran in Paseo. The judge's cwd is the evidence directory teamai wrote:

```text
$ paseo ls --all
NAME                                       PROVIDER                STATUS  CWD
teamai score[0].judge · re02e01c9b0e36c69  claude/claude-opus-5-5  closed  ~/.teamai/projects/…/runs/re02e01c9b0e36c69/scratch/a47d92bbe
teamai fix · rd573bcff8eef4e10             claude/claude-opus-5-5  closed  /repo/.teamai/workflow-worktrees/teamai-rd573bcff8eef4e10-fix-p1-a04485788cc1
```

The judge step records what the runtime kept:

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The step asked for two things: change add in math.js from a - b to a + b, and add math.test.js that uses node:test to check add(2, 3) is 5… The diff does both…" } }, "confined": { "tool": "claude", "isolation": "best-effort", "access": "read" } }
```

The judge runs at `best-effort`, never `verified`:

| What | Enforced |
| --- | --- |
| A fresh agent whose cwd is the evidence directory, briefed to read only it | yes |
| No edit, and no command the tool's own rules do not allow: the judge's mode asks first, and any request for permission ends the judge, attended or not | yes |
| Its answer is its last message, parsed as JSON; it writes nothing | yes |
| No read outside the directory | no: nothing stops the agent reading a file elsewhere |
| No network | no |

A confined step whose `confined.json` asks for `verified` never goes to Paseo, whose offer is `best-effort`. The judge's place shows in the run's details as `Paseo confined prompt, best-effort` until its agent starts.

A Codex judge starts in `auto` with Codex's sandbox set to `read-only`, since every Codex mode Paseo lists writes without asking. Codex reads with shell commands, so its brief says to use read-only ones; its sandbox runs those without asking, and anything else asks and ends the judge. A definition whose `tool` is `codex` runs both the step and its judge on Codex:

```yaml
# drivers/paseo-codex.yaml
schemaVersion: v1alpha1
name: paseo-codex
tool: codex
runtimes:
  - use: paseo
```

Here a Codex judge labelled a Codex pass in the run that made it:

```text
$ teamai workflow start fix-add --driver paseo-codex
ℹ run:r0cec7811f0b8ad80:fix:1: review-quality good (teamai-score run r6f8bb28e533b1c3b).
$ paseo logs 94f534b --filter tools
[Shell] ls -la
[Shell] ls -la transcripts
[Shell] cat 'transcripts/fix#1.md'
[Shell] cat 'diff.patch'
[Shell] cat 'evidence.json'
```

```json
{ "id": "score[0].judge", "outcome": "success", "outputs": { "answer": { "label": "good", "reasoning": "The diff changes add to return a + b and adds a node:test assertion that add(2, 3) equals 5. The session shows no commands were run, as requested; the test was added but not executed." } }, "confined": { "tool": "codex", "isolation": "best-effort", "access": "read" } }
```

Scoring reads the step's session where the daemon's agent wrote it: in the tool home of the user the daemon runs as. For Claude, the runtime reads that home from Paseo (`configDirectory` in `claude auth status`, from Claude Code 2.1), so a daemon started with another `HOME` or `CLAUDE_CONFIG_DIR` still has its sessions archived and scored, as long as teamai can read that directory. This run's teamai had a `HOME` of its own, and the daemon ran Claude in the member's:

```text
$ teamai workflow start fix --driver paseo-only
✔ Archived 1 step session of r2fa599b2abbe0d09 to teamai-reports (scrubbed)
{"data":{"done":{"run":"r2fa599b2abbe0d09","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

With an older Claude, which does not report its home, or a daemon under another user, run the daemon as the member who runs teamai, on the same machine. Otherwise the pass stays unlabelled, and the score run's `evidence` step says why:

```text
evidence_missing: Pass 1 of step fix in run r080799f10648b1ed cannot be scored: no longer on this machine: claude-code session 346fd0be-1a5a-474b-aedf-24c305d5c1a6 of fix#1. Restore what is missing, or score another pass.
```

A Codex step's pass is scored the same way. Paseo reports no Codex home, so on a daemon on this machine the runtime looks for the step's session by its id in your `CODEX_HOME`, then in `.codex` of your account's home, then of `$HOME`, and names the home that holds it: teamai reads the session there, also when it runs with a `HOME` of its own. When teamai closes the attempt, Paseo archives the agent and Codex moves the session to `archived_sessions/`, where teamai still finds it. A daemon whose Codex writes under another root, or one on another machine, leaves the pass unlabelled unless the Codex root teamai recorded at `teamai init` holds it:

```text
evidence_missing: Pass 1 of step fix in run ra429df3ad473c7b3 cannot be scored: no longer on this machine: codex session 01a1a731-9053-7cf2-9884-68058745044a of fix#1. Restore what is missing, or score another pass.
```

An OpenCode step's pass is scored the same way. OpenCode keeps every session in one database under its data directory (`XDG_DATA_HOME`, `~/.local/share` by default), so on a daemon on this machine the runtime names the data directory that holds `opencode/opencode.db`: the one its Paseo provider's `env` sets, then your `XDG_DATA_HOME`, then `.local/share` of `$HOME`, then of your account's home. teamai reads the session there, also when it runs with a `HOME` of its own. On a daemon on another machine, teamai reads it in its own data directory.

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | the address `daemon.listen` names in `$PASEO_HOME/config.json`, else `ws://127.0.0.1:6767/ws` | The WebSocket address of the Paseo daemon: `ws://`, `wss://`, or `ws+unix://<socket path>:/ws` for a Unix socket. |
| `mode` | each tool's Paseo default, never one that never asks | The Paseo mode each tool's agents start in, such as `{ claude: plan }`. It must be one Paseo lists for that tool. Naming a mode that never asks is your opt-in to full access (see [Tools, models and modes](#tools-models-and-modes)). |
| `providers` | the custom provider that runs each team instance, else the one teamai adds | The Paseo provider id a tool or a team instance runs on, such as `{ acme-claude: claude-acme }` (see [Team tool instances](#team-tool-instances)). |

`max_parallel` is teamai's own key; see [Runtime options](workflow-advanced.md#runtime-options). Paseo has no cap of its own.

```yaml
# drivers/paseo-7070.yaml
schemaVersion: v1alpha1
name: paseo-7070
description: Run prompt steps as agents of the Paseo daemon on port 7070, and the rest here.
runtimes:
  - use: paseo
    options:
      url: ws://127.0.0.1:7070/ws
  - use: tools
```

## Tools, models and modes

Paseo calls a tool available once its binary is on the daemon's `PATH`, signed in or not. The runtime offers a tool only when Paseo shows it can run there. Otherwise, a step on that tool runs on the next runtime. A step's agent starts in the mode Paseo sets as the tool's default (`DEFAULT MODE` in `paseo provider ls`), never a bypass mode that never asks: when that default is one, the agent starts in the nearest mode before it in Paseo's list instead, and the run says so once at start:

```text
⚠ Step runtime "paseo": Paseo starts claude in mode bypassPermissions by default, which never asks before it acts; teamai starts its claude steps in mode auto, the nearest one before it in Paseo's list that asks.
```

The `mode` option picks the mode yourself, over Paseo's default. Naming a mode that never asks, such as Claude's `bypassPermissions` or Codex's `full-access`, is an explicit opt-in to full access, for example for a daemon that runs in a VM of its own. teamai then warns once at start, and records the isolation of those steps as `none`. A step with `permissions: unattended` still never runs on Paseo:

```yaml
# drivers/paseo-in-vm.yaml
schemaVersion: v1alpha1
name: paseo-in-vm
runtimes:
  - use: paseo
    options:
      mode: { claude: bypassPermissions }
  - use: tools
```

```text
$ teamai workflow start fix --driver paseo-in-vm
⚠ Runtime paseo of driver paseo-in-vm runs steps in full access on this machine, as drivers/paseo-in-vm.yaml in the team repo sets: they run without asking for permission, an unattended run approves the runtime's own full-access sign-in where it asks for one, and teamai cannot prove any isolation. Their isolation is recorded as none.
```

A tool whose default, or whose `mode`, Paseo does not list for it is not offered. A judge starts in a mode that asks before it edits or runs anything:

| Tool | Offered when | Step mode | Judge mode |
| --- | --- | --- | --- |
| `claude` | `claude auth status` on the daemon's host says `"loggedIn": true`: a login or an API key | Paseo's default: `auto` on Paseo 0.14.0 | `default` |
| `codex` | the daemon runs on this machine (`url` is a loopback address, such as `127.0.0.1` or `localhost`, or a Unix socket), and `codex login status` says `Logged in` | Paseo's default: `auto-review` on Paseo 0.14.0 | `auto`, with a `read-only` sandbox |
| `opencode` | Paseo lists a model for it: OpenCode reaches a model provider, its free models included. Not when Paseo runs it on OpenCode's own background server (Paseo 0.15 does when one runs on its host), which gives an agent no environment; stop that server with `opencode service stop`, then `paseo restart` | OpenCode's own default, `build`: Paseo sets none | `plan` |

Paseo does not report whether Codex is signed in, so the runtime runs `codex login status` itself, with your environment (`CODEX_HOME` or `~/.codex`). It runs the `codex` that `Resolved path` names in Paseo's diagnostic, which the daemon found on its own `PATH`, not one on teamai's. A daemon at any other address, such as one on another machine, is never offered Codex. The check cannot see the daemon's own environment, and a loopback address counts as this machine: start the daemon with the `CODEX_HOME` you use, and do not point `url` at a tunnel (`ssh -L`) to another machine.

The runtime starts even when the daemon can run none of them, so the run's command steps still go to the next runtime. A step on a tool that no runtime of the driver can run fails without starting an agent, and says what to do on the daemon's host:

```text
$ teamai workflow start fix-codex --driver paseo-only
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on codex, which the driver of this run cannot launch here: paseo: The Paseo daemon at ws://127.0.0.1:6767/ws cannot run codex: signed out; run `codex login` on the daemon's host. Or remove tool from the step.
```

To check a tool yourself, ask the daemon, or Codex. `Auth` and `Resolved path` are the lines that matter:

```text
$ paseo provider diagnostic claude | grep -A2 Auth
  Auth: {
  "loggedIn": true,
  "authMethod": "oauth_token",
$ paseo provider diagnostic codex | grep 'Resolved path'
  Resolved path: ~/.nvm/versions/node/v24.21.0/bin/codex
$ ~/.nvm/versions/node/v24.21.0/bin/codex login status
Logged in using ChatGPT
```

The step's `model` must be one the daemon offers, and its `effort` one that model has. With no `model`, the agent uses the daemon's default.

For OpenCode, that default can be one of OpenCode's free models, which need no sign-in. When OpenCode marks no default, the agent takes the first model the daemon lists:

```text
$ paseo provider models opencode
ID                                    MODEL
opencode/crouton-alpha-free           Crouton Alpha Free
opencode/pulse-alpha-free             Pulse Alpha Free
github-copilot/gpt-6.1-terra          GPT-6.1 Terra
…
github-copilot/claude-sonnet-5.5      Claude Sonnet 5.5
```

A step or judge with no `model` then sends its prompt, or the evidence it judges, to OpenCode's free provider. Pin the model to keep them with a provider you chose:

```yaml
# workflows/review-opencode.yaml
schemaVersion: v1alpha1
name: review-opencode
description: Review the branch on OpenCode, on a model the team chose.
steps:
  - id: review
    tool: opencode
    model: { name: github-copilot/claude-sonnet-5.5 }
    prompt: Review the change on this branch, and list what it gets wrong.
```

```markdown
<!-- scorers/review-quality.md -->
---
model: github-copilot/claude-sonnet-5.5
labels:
  - value: good
    score: 1
    description: The change does what the step asked, with tests.
  - value: bad
    score: 0
    description: The change does not do what the step asked.
passingScore: 1
---
Judge whether the change does what the step asked. Read the diff and the session.
```

A model the daemon lacks fails before any agent starts:

```text
✖ Step "classify" failed with model_unavailable: The Paseo daemon at ws://127.0.0.1:6767/ws has no claude model claude-opus-0-1. It offers: claude-opus-5-5, claude-opus-5, claude-fable-5-1, claude-fable-5, claude-opus-4-8[1m], claude-opus-4-8, claude-sonnet-5-5, claude-sonnet-5, claude-sonnet-5[1m], claude-opus-4-7[1m], claude-opus-4-7, claude-opus-4-6[1m], claude-opus-4-6, claude-sonnet-4-6[1m], claude-sonnet-4-6, claude-haiku-5-5, claude-haiku-4-5.
```

The agent gets the step's prompt. A step that continues an earlier step's session goes on in that step's agent when it can, as [Continue a step's conversation](#continue-a-steps-conversation) describes. On a daemon on this machine, a Claude or Codex step reports the tokens its session records, read where scoring reads that session. A step under a token budget runs here only when every tool the daemon offers reports them: not when it offers OpenCode, runs on another machine, runs Claude without naming its home, or keeps a tool's sessions in a folder teamai cannot read, as a daemon that runs as another user may. Then the step runs on the next runtime. A budgeted step whose tokens teamai still cannot read, as from a transcript over 50 MiB, fails `budget_unmeasured`, and the message says why and what to do.

## Team tool instances

A step on a team tool instance runs in Paseo on a Paseo custom provider of its own. When the daemon runs on this machine, teamai adds that provider at the first step that runs the instance, attended or not. The provider is named after the instance, extends the instance's tool, runs the instance's command from your `PATH`, and, when the instance has a home of its own, sets the tool's home variable to it, and the instance's own variable too when it names one. It stays for later runs, and the run says once how to remove it:

```text
⚠ Step runtime "paseo", operation op-2b7e91c4d0a3: teamai added the Paseo provider acme-claude to the daemon at ws://127.0.0.1:6767/ws for its acme-claude steps: it extends claude and runs /Users/ana/.local/bin/acme-claude, with CLAUDE_CONFIG_DIR=/Users/ana/.claude-acme. It stays for later runs; to remove it, choose Remove provider on acme-claude in the Paseo app's provider settings, or delete agents.providers.acme-claude from /Users/ana/.paseo/config.json, then run `paseo daemon reload`. Paseo cannot show its agents' logs once it is gone, so read them first.
```

`paseo daemon config get agents.providers --json` then shows the entry it added, beside every one the daemon held:

```json
{ "acme-claude": { "extends": "claude", "label": "acme-claude", "command": ["/Users/ana/.local/bin/acme-claude"], "env": { "CLAUDE_CONFIG_DIR": "/Users/ana/.claude-acme" } } }
```

An instance with only a home of its own, such as `claude-work` (`extends: claude`, `home: { dir: .claude-work, env: CLAUDE_CONFIG_DIR }`), gets a provider that runs Claude's own command in that home, so a second Claude account runs with no setup:

```json
{ "claude-work": { "extends": "claude", "label": "claude-work", "env": { "CLAUDE_CONFIG_DIR": "/Users/ana/.claude-work" } } }
```

A provider the daemon already holds is used instead: the one that extends the instance's tool and runs its command, by name or as an absolute path to it (on a daemon whose host runs Windows, such as `C:\Tools\acme-claude.exe`, which teamai tells from the path itself), or, for an instance with only a home, the one that runs the tool's own command with that home in its `env`, under the tool's variable and under the instance's own when it names one. Its steps and judges take that tool's modes, grants and sign-in check, and their sessions name the instance. The instance's sign-in and sessions are looked for in the home its provider's `env` sets, else in the instance's own home, and the run says once when that provider's home is not teamai's home for the instance. A signed-out instance names its own command, such as `CODEX_HOME=~/.codex-acme acme-codex login`, with `mkdir -p ~/.codex-acme && ` first when that Codex home does not exist yet, as Codex refuses one that does not.

When the instance cannot run on the provider teamai just added, for example because it is signed out, teamai removes that provider again, so a failed step leaves nothing in Paseo's config, and a later step adds it again. If the removal fails, the step's failure says so and the provider may stay, with the notice above.

teamai adds no provider on a daemon on another host, for a command not on your `PATH`, for an instance whose name is not a Paseo provider id (lowercase letters, digits and dashes), or when a provider of that name already runs something else. The instance is then not offered, and a step on it says what to do:

```text
✖ Step "fix" failed with tool_unavailable: Step "fix" runs on acme-claude, which the driver of this run cannot launch here: paseo: The Paseo daemon at ws://10.0.0.5:6767/ws cannot run acme-claude: no Paseo provider runs its command acme-claude, and teamai adds one only on a daemon on this machine; add one on the daemon's host that extends claude with command ["acme-claude"] (`paseo daemon config set agents.providers …`, then `paseo daemon reload`), or name one in the runtime's providers option. Or remove tool from the step.
```

When two providers run the instance, name the one to use with the `providers` option:

```yaml
# drivers/paseo-acme.yaml
schemaVersion: v1alpha1
name: paseo-acme
tool: acme-claude
runtimes:
  - use: paseo
    options:
      providers: { acme-claude: claude-acme }
  - use: tools
```

## Through a sandbox

A runtime entry `use: paseo` with `through: sandbox` runs each prompt step's tool in the attempt's sandbox, while its agent stays in the Paseo app. Only a sandbox that serves the attempt socket works: `sbx`, or `docker` on Docker Desktop or on this Linux machine, 26.0.0 or later (25.0.5, 23.0.11), with `node` in the image, which keep the tool from this machine's ports ([what a step reaches](runtime-sandbox.md#what-a-step-reaches-of-this-machine)). With any other, the open fails before any agent starts. Paseo runs the tool as teamai's wrapper, [`teamai-sandbox-<tool>`](runtime-sandbox.md#through-an-app-teamai-sandbox-tool), on a Paseo custom provider. When the daemon runs on this machine and holds no provider that runs the wrapper, teamai adds one at the first open, named after the wrapper, and the run says so once, as for a team instance:

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/paseo-sandboxed.yaml
schemaVersion: v1alpha1
name: paseo-sandboxed
runtimes:
  - use: paseo
    through: sandbox
    sandbox: containers
  - use: tools
```

```json
{ "teamai-sandbox-claude": { "extends": "claude", "label": "teamai-sandbox-claude", "command": ["/usr/local/bin/teamai-sandbox-claude"] } }
```

The step's agent is created with no prompt. teamai registers it on the attempt's socket, starts its tool, and sends the prompt only once the sandbox says that agent's wrapper connected. When the sandbox refuses the wrapper, or it does not connect within 30 s, teamai deletes the agent and the step fails `runtime_failed`, naming `isolation_unproven`, so the prompt never reaches a tool outside the sandbox. A runtime started again after a crash registers the agent again. The step's session is read in the attempt's tool home.

The wrapper finds the attempt under the `HOME` the daemon starts it with, so the daemon must run with the `HOME` teamai runs with, as it does when you start both. A daemon started with another `HOME` fails every step `runtime_failed`, naming `isolation_unproven`; set `HOME` to teamai's in the provider's `env`.

OpenCode does not run through a sandbox on Paseo: Paseo may serve several agents from one OpenCode server, so the sandbox cannot tell the step's agent from another.

## Credentials

Paseo keeps an agent's environment in plain text under its home, so this runtime takes no `credentials`, and teamai refuses a definition that gives it one:

```text
{"error":{"code":"bad_option","message":"Runtime \"paseo\" of driver definition ~/.teamai/drivers/paseo.yaml refused option \"credentials\": paseo does not offer can.env, so it cannot keep a credential to the processes it is for. Fix the option and start again."}}
```

Remove the entry, and give the tool what it needs on the daemon's host instead: sign in to it there, or set the variable in the environment the daemon starts with, then `paseo restart`. An agent gets the daemon's environment.

## Permissions

A Claude agent may write two things without asking: the directory of teamai's result file, where the step also leaves its evidence, and the run's scratch directory, which `$TEAMAI_RUN_DIR` names for the run's commands. The runtime allows `Edit(/<result directory>/**)` and `Edit(/<run directory>/**)`, in the mode Paseo starts it in. A Codex agent may write the same two places: its sandbox in `auto-review` writes the worktree, and the runtime adds the result file's directory and the run's scratch directory as writable roots:

```json
{ "provider": "codex", "modeId": "auto-review", "providerOptions": { "sandbox_workspace_write": { "writable_roots": ["~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch"] } } }
```

An OpenCode agent may write the same two places: the runtime allows them through OpenCode's `external_directory` permission, so it asks only before it touches anything else outside the worktree:

```json
{ "provider": "opencode", "providerOptions": { "permission": { "external_directory": { "~/.teamai/workflows/runs/ra429df3ad473c7b3/attempts/a21ff251b/out/*": "allow", "~/.teamai/workflows/runs/ra429df3ad473c7b3/scratch/*": "allow" } } } }
```

Of the step's environment, the agent gets only `TEAMAI_RUN_DIR`, and `TEAMAI_WORKFLOW_DIR` for a step of a workflow folder, so a prompt that names a file in either directory works as it does on this machine.

The agent writes the result file as the user its daemon runs as. When the user teamai runs as cannot read that file, the step fails and names it:

```text
✖ Step "review" failed with tool_failed: claude wrote the result file <result file>, which teamai cannot read because it has no permission to read it. Let the user teamai runs as read <result file>, then retry the step
```

Give the user teamai runs as read access to the file, then `teamai workflow retry <run> <step>`.

In an attended run, any other permission prompt waits for you in the Paseo app, or on the command line:

```sh
paseo permit ls
paseo permit allow 7c483fce --all
```

In an unattended run (`TEAMAI_MODE=unattended` or `CI`), nobody can answer, so the step fails and the agent stops. Here a prompt step `count` asked its agent to run `ls -1 | wc -l`:

```text
✖ Step "count" failed with tool_failed: The claude agent asked for permission (Bash) in Paseo mode auto, which asks before it runs what it does not allow, and an unattended run has nobody to answer. Run the workflow attended to answer it in the Paseo app, or run this step on a runtime that offers unattended.
```

An agent that stops on its tool's usage limit, or on a rate limit its model's API answered, stops the step with what the tool said, reset time included. The step does not fail: teamai launches nothing more on that tool until the limit resets, then runs the step again:

```text
⚠ Step "fix" stopped: The claude agent hit its usage limit in Paseo: You've hit your limit · resets 3pm (Europe/Madrid). teamai launches no more steps on claude until its limit resets, then runs the step again.
```

## Interactive steps

In an attended run, a step with `interactive: true` runs as a Paseo agent you work with in the Paseo app. Its prompt starts by telling the agent to work through the step with you, and to write teamai's result only once you say the step is done. The step waits while the agent sits idle between your turns, and ends once the result is written. An unattended run has nobody to work with, so the step goes to a runtime with HITL, as [HITL](workflow-advanced.md#hitl-human-in-the-loop) describes.

## Continue a step's conversation

A prompt step with `session.from` or `session: continue` goes on in the earlier step's Paseo agent. teamai sends the step as a new turn of that agent, so it keeps what it read and said, and the run records the session as resumed, with the tokens of that turn only. It does so when:

- the agent is still in Paseo, not archived, and its turn has ended, with no other step's turn running in it;
- the step works in the same Paseo workspace, such as a step with `workspace: continue` in the copy an enclosing step opened;
- the step runs the same provider, model, effort and Paseo mode;
- neither step runs through a sandbox.

When the step cannot go on in that agent, or the earlier step ran in no agent of this runtime, as when it ran on another driver or machine, teamai imports the session into a new agent instead, if the step does not run through a sandbox and Paseo lists that session in the step's worktree. The agent then runs as the step asks, and is told where the run's scratch directory and the workflow's folder are, since an imported agent gets no `TEAMAI_RUN_DIR` or `TEAMAI_WORKFLOW_DIR`.

Otherwise the step starts a new agent, and says why:

```text
⚠ Step runtime "paseo", operation op-6e0c41d2b7a9: teamai-runtime-paseo starts a new agent for step "fix" rather than continue the conversation of op-5781c58b81a1: agent 4ee42432-b44e-4cca-a6b2-c793f387d266 runs claude/claude-haiku-5-5, and this step runs claude/claude-opus-5-5.
```

An agent a later step may continue stays in Paseo until teamai closes the earlier step's place. Cancelling the later step, or closing its place, stops only its turn: the agent and the earlier step's work stay.

## Wake fleet members on other daemons

A [fleet](workflow-advanced.md#run-steps-on-other-members-machines-fleet) entry whose `wake` uses `paseo` starts a member when nobody takes an attempt it offered. The Paseo daemon starts the member's agent on another daemon you saved on it.

To set it up:

1. Save the other machine's daemon on this one: `paseo host add <host:port> --label gpu-box`. `paseo host ls` shows it `online` once this daemon reaches it.
2. On that machine, open a checkout of the repository in Paseo. teamai matches it by the repository its git `origin` names, so a checkout with no `origin` does not count. The machine needs teamai and the team set up, as any fleet member does.

teamai picks the first saved host that is online and has a workspace of the repository. The agent appears in that host's Paseo, in that workspace, titled after the run and the pool, such as `teamai: step review of run r70d31098c8884803, fleet pool gpu`, with the label `teamai-pool`. It runs on the default model of the first of Claude, Codex or OpenCode that host runs, in that provider's default mode. In that mode it may run `teamai workflow resume` without asking, and nothing else: teamai gives that agent alone Claude's rule `Bash(teamai workflow resume:*)` or the same OpenCode `bash` rule. Codex takes no rule for one command, and runs commands in its sandbox, with no network and no write to `~/.teamai`, so `teamai workflow resume` fails there. A Codex agent's first prompt therefore starts by telling it to run that command with escalated permissions, outside the sandbox, which Codex asks for: approve it in that host's Paseo. If that machine's Codex sets `approvals_reviewer = "auto_review"`, Codex's reviewer answers instead, and Paseo shows no request; set it to `"user"` in the project's `.codex/config.toml` there to see the request in Paseo. When the agent asks before a command, it waits in that host's Paseo until someone answers there. Its first prompt is teamai's command to take one attempt of the pool, and ends by telling it to end once that attempt is done. The run's details link the agent. Waking a member spends that machine's account.

teamai does not follow the agent once Paseo started it. To stop a woken member, open its agent in the Paseo app and stop it, or run `paseo stop <agent> --host <host:port>`. `teamai workflow cancel <run>` withdraws the attempt; a member that has not taken it yet finds nothing to claim and ends.

When no saved host has the repository, the attempt keeps waiting for a member, and the run says what each host lacked, in words such as:

```text
No Paseo host saved on this machine has a workspace of https://github.com/acme/acme-app.git (lost-box is offline; build-box has no workspace of it). Add the machine with `paseo host add <host:port>`, and open a checkout of the repository in Paseo there.
```

## Cancel, crash and restart

`teamai workflow cancel` stops the agent, and the step ends `cancelled`:

```sh
teamai workflow cancel r144a3913136e7b62
```

Paseo may answer the cancel before the agent's turn ends, so the cancel counts the agent stopped only once Paseo reports it no longer running. An agent that still runs 10 s after the cancel, or a cancel Paseo does not answer in that time, leaves the stop unconfirmed (`cancel_failed`) instead, and teamai keeps the attempt and the login:

```text
Paseo cancelled the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, but it still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

Once the agent can stop, run `teamai workflow cancel` again: the runtime tries the stop again, and closes the attempt's place.

A teamai killed while an agent works leaves the agent running. `resume` reconnects to the same agent; it does not start a second one:

```sh
kill -9 <teamai pid>
teamai workflow resume rffcaabe1e1852479 --driver paseo
```

A daemon that restarts mid-step closes its agents. While it is down the step waits for it; once it is back, the step fails, and its work stays in the worktree:

```text
✖ Step "classify" failed with runtime_failed: The step runtime could not run the prompt (daemon_restarted): The Paseo daemon at ws://127.0.0.1:6767/ws stopped while the claude agent worked, before it wrote a workflow result. Its work is kept in the worktree. Then run: teamai workflow retry r3ad62eacc3c191eb classify
```

```sh
teamai workflow retry r3ad62eacc3c191eb classify
teamai workflow resume r3ad62eacc3c191eb --driver paseo
```

When teamai closes the attempt, the runtime archives its Paseo workspace, which stops anything still running there. Paseo deletes only worktrees it created, so teamai's worktree and branch stay. If Paseo refuses, the run's details say the place was not closed, and why:

```text
Paseo did not archive workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79): <Paseo's error>. Its agents may still run; archive it in the Paseo app.
```

The place counts as closed only once Paseo reports each of the attempt's agents no longer running. One that still runs 10 s after the archive leaves it open:

```text
Paseo archived workspace teamai-rd280488c2f3eba5f-classify-p1-c2404617476e (wks_6fb33a5b94531f79), but agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f still ran 10 s later. It may still change the worktree; stop it in the Paseo app.
```

A create Paseo answered with an error, as a dropped connection does, may still start its agent. Until Paseo shows that agent, the attempt stays open. Once it appears, the next `teamai workflow cancel` stops it. teamai cannot tell a create Paseo refused, so if the agent never appears, check that nothing of the attempt runs in the worktree, then release the attempt. The runtime then forgets it, though its close still fails, so it no longer keeps another attempt from archiving the workspace they shared:

```text
Paseo does not show the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f yet, though its create was sent, so it may still start in the worktree. Once it appears, run teamai workflow cancel r3ad62eacc3c191eb again, which stops it. If it never appears in Paseo, the create was refused: check that nothing of the attempt runs in the worktree, then run teamai workflow cancel r3ad62eacc3c191eb --release a5c1e9d07.
```

Two attempts on one worktree share its Paseo workspace, which only the last of them to close archives. An attempt that closes first cancels its own agents instead, a failed step's included, and leaves the other attempt's running. An agent Paseo will not cancel keeps the attempt open, so teamai can close it again:

```text
Paseo did not cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f: Agent is busy. It may still run in the worktree; stop it in the Paseo app.
```

A workspace you already had open in Paseo on that directory, as your checkout may be when a read-only step runs there, is never archived: the attempt cancels its own agents instead, and your workspace stays open. The same holds when you open that directory in Paseo while the step runs, which gives you the attempt's workspace, and start an agent there.

An open whose question Paseo does not answer within 20 s, as when its daemon hangs, fails the step `runtime_failed`, naming `workspace_failed`, and the next open of that worktree goes on. Paseo may still open the workspace later; the failure says to archive it in the Paseo app then.

A runtime killed mid-step cannot archive; the step fails `runtime_lost`, and its workspace stays in Paseo until a later `teamai workflow cancel` closes the attempt, or you archive it (`paseo workspace archive <id>`).

`teamai workflow cancel` after a crash opens the runtime in recover mode. It checks no sign-in, so a tool signed out since does not keep it from stopping the agent, and it reaches the daemon only to cancel the agent and close the attempt. While the daemon is down, the cancel keeps the attempt and the login, and says why:

```text
No Paseo daemon answered at ws://127.0.0.1:6767/ws within 10 s. Start it with `paseo start`, or set the runtime's url option to the daemon's address. Until then teamai-runtime-paseo cannot cancel the claude agent 6f0d2c4e-8b1a-5c3f-9e7d-2a4b6c8d0e1f, which may still run in the worktree; cancel the run again.
```

Start the daemon, then run `teamai workflow cancel` again.

## Errors at start

| Code | When |
| --- | --- |
| `client_missing` | No Paseo client was found: no `paseo` on `PATH` or in `~/.local/bin`, or `PASEO_CLIENT_PATH` names no `@getpaseo/client` package. Install the Paseo CLI from the Paseo desktop app's settings or with `npm install -g @getpaseo/cli`, or set `PASEO_CLIENT_PATH`. Also when a file of the Paseo app's client does not match the SHA-256 the app records: reinstall the app. |
| `client_version` | The Paseo client found is older than 0.14.0. Update Paseo, or set `PASEO_CLIENT_PATH` to a newer `@getpaseo/client` package. |
| `daemon_unreachable` | No daemon answers at `url`. Start it with `paseo start`. |
| `daemon_version` | The daemon is older than 0.14.0. Update Paseo and restart it. |
| `paseo_config` | With no `url`, the daemon's address cannot be read from Paseo's config: `$PASEO_HOME/config.json` is not JSON, its `daemon` section is not what Paseo writes, or `daemon.listen` names a Windows named pipe. Fix the file, or set `url`. |
| `bad_option` | An option other than `url`, `mode` and `providers`, or a `mode` for a tool other than `claude`, `codex` and `opencode`. A `providers` entry for neither one of them nor a team instance teamai passed is named under `unavailable` instead, and the other tools still run. |
