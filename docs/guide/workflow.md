# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and prompt steps, each after the steps it needs. A command with no workspace is read-only; [Workspaces](#workspaces) is how a step changes code on its own branch. [Advanced workflows](workflow-advanced.md) covers parallel steps, loops, `for_each`, what an end does to steps that still run, and the full expression language.

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    needs: [compile]
    command: npm test
    output:
      ok: boolean
  - id: review
    needs: []
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and exactly one action: `command`, `prompt`, `prompt_file`, or `workflow`. A step can omit the action when it has `end`, `approve`, or `choose`. `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

Local command steps read stdout and stderr as UTF-8. Non-ASCII JSON string values are preserved in stored outputs and when later steps read them.

A prompt step can set `model`: an alias from `models/aliases.yaml` or a model name, without spaces or templates. `defaults: { model: fast }` at the top of a file sets one for its prompt steps. A prompt step runs on the first of these that is set:

1. the step's `model`;
2. the model its agent's definition sets for the tool;
3. `defaults.model`;
4. the tool's default model.

A step's `model` replaces the agent's model and effort, and keeps its other settings. A model name that is not an alias runs at the tool's default effort. A workflow file that another runs uses its own `defaults.model`, else the one in effect for the step that runs it. An inline workflow uses the enclosing one. When the alias has no model for the step's tool, or the member's `~/.teamai/models/aliases.yaml` turns it off, the step fails with `model_unavailable` before the tool starts. On OpenCode 1, so does a step whose `model` is its agent's own model with no effort while the agent file sets `variant` and a `mode` other than `subagent`, since OpenCode 1 would apply that variant. OpenCode 2 does not take the model or variant from the agent file, and OpenCode 1 does not start a subagent with `opencode run --agent`, so the driver passes the definition's own model and variant on the command line. For an agent file with `mode: subagent`, which pull writes by default, OpenCode 1 gets the agent's instructions in the prompt, and the driver warns about the file settings that then do not apply. A lease carries `model` and `defaultModel` as written, and the driver resolves them.

A prompt or workflow step can list [scorers](scorers.md) that judge its succeeded passes:

```yaml
schemaVersion: v1alpha1
name: ship
description: Implement the change, then review it.
defaults:
  scorers: { batch: true }
steps:
  - id: implement
    prompt: Implement the change.
    scorers: [review-quality]
  - id: review
    needs: [implement]
    prompt: Review the change.
    scorers: { names: [review-quality], batch: false }
```

Every step after the first lists the steps it waits for in `needs`. `needs: []` starts another branch with no dependency. Each `next` leases the first step in the file whose needs are done. `--driver local` runs one step at a time unless `workflows.max_parallel` is above 1. A step is skipped when a step it needs failed, or when every step it needs was skipped. A skipped step never runs. A failure does not stop other branches. When nothing is left to run, the run ends `failed` if any step failed, otherwise `succeeded`. A missing `needs`, a `needs` id that is not a step, or a cycle makes the file invalid. A missing `needs` also leaves the workflow with nothing to run, even when an older version was valid.

A step can carry an `if` expression. When it is false, the step is skipped, and that does not fail the run. An expression reads `steps.<id>.outcome` (`success`, `failed`, or `skipped`) and `steps.<id>.outputs.<field>`, only for steps it needs, directly or through their needs. It has `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `!`, parentheses, and the literals `'text'`, numbers, `true`, `false`, `null`, and `[]`. A path can index an array, as in `steps.review.outputs.files[0]`. The functions `length`, `any`, `all`, and `filter` read arrays. A missing value reads as `null`. `false`, `null`, `0`, and `''` are false; everything else is true. `==` is strict and compares whole values: `'1' == 1` and `'Build' == 'build'` are false.

A step whose dependency failed still runs when its `if` reads every failed dependency. Use this to recover:

```yaml
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: gh issue edit 42 --add-label needs-human
```

The run still ends `failed` unless it reaches an end. An `if` that does not parse, reads a step it does not need, or reads a field missing from that step's `output` makes the file invalid. So does an `if` that is always false, and then the workflow has nothing to run, even when an older version was valid.

`teamai pull` and `teamai push` check each file, and check a step that runs another workflow against that workflow's runnable version. A `prompt_file` must be a regular, non-symlink file under `prompts/` in the team repo. Its text is cached with the validated workflow, so an existing run keeps that revision even if the source is later changed or deleted. A file that was valid before keeps that version in the local cache when a new revision is invalid, as long as that version still fits the workflows it runs. A field this version of teamai does not know is different: that workflow has nothing to run until teamai is updated.

`teamai review --branch <name>` checks that branch with the same rules. It exits 1 when any workflow file is invalid, or when a step's `model` or `defaults.model` is an alias the branch's `models/aliases.yaml` maps for no tool. It writes nothing and does not run the workflow. This file fails the check:

```yaml
schemaVersion: v1alpha1
name: deploy
description: Ship the release candidate.
steps:
  - id: release
    needs: [biuld]
    command: echo release
```

```text
teamai review --branch feature/deploy
[review] branch feature/deploy: 1 fail, 0 warn, 0 info
  ✖ [workflows] workflows/deploy.yaml:6: field "steps[0].needs": step "release" needs "biuld", which is not a step in this workflow
```

Gate that branch from CI with one step:

```yaml
- run: teamai review --branch feature/deploy
```

A workflow can declare named `ends`, each `succeeded` or `failed`, such as `ends: { dropped: succeeded, stuck: failed }`. A step with `end: <name>` finishes the workflow when it succeeds. A step with only `id`, `needs`, `if`, and `end` runs nothing: it ends the workflow as soon as its needs are done. When an end is reached, every step that has not run is skipped, and the run takes that end's outcome, even if another step failed. `done` then carries the end: `{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`. An `end` that is not in `ends`, an `end` without `ends`, a declared end that no step uses, or a step that needs a step that only ends the workflow makes the file invalid.

A workflow can declare `inputs` with the same shorthand as `output`, such as `inputs: { issue: number, title: string }`. Every input is required. Pass them as a JSON object: `teamai workflow start fix --driver local --inputs '{"issue":42,"title":"Crash"}'`. A missing, extra, or mistyped input returns `invalid_inputs` naming the field, and no run is created. An `if` can read `inputs.<name>`.

`{{ inputs.<name> }}` and `{{ steps.<id>.outputs.<field> }}` (or `.outcome`) fill in a `prompt`, the text of a `prompt_file`, and `env` values when the step starts. A template can also evaluate an expression as an `if` does, such as `{{ length(steps.review.outputs.files) }}`. Other `{{ ... }}` text, such as `${{ secrets.TOKEN }}`, stays as written. So does any `{{` right after a `$`, such as `${{ inputs.version }}` in a prompt about GitHub Actions. To put a value right after a `$`, add a space: `$ {{ inputs.price }}`. Strings appear as they are, numbers and booleans as text, objects and arrays as JSON, and `null` or a missing value as empty text. A template reads only what an `if` on that step could read.

A `command` is never filled in. Pass values to it through `env`, which only a command step can have:

```yaml
  - id: label
    needs: [plan]
    command: gh issue edit "$ISSUE" --title "$TITLE"
    env:
      ISSUE: "{{ inputs.issue }}"
      TITLE: "{{ steps.plan.outputs.title }}"
```

The command gets these variables on top of its usual environment, so a value such as `$(touch pwned)` stays plain text. Names must match `^[A-Za-z_][A-Za-z0-9_]*$`. A YAML number or boolean is passed as its text. A template inside `command`, `env` on a prompt step, or an `if` or template that reads an input the workflow does not declare makes the file invalid. A template that does not parse or reads something it may not read also leaves the workflow with nothing to run, even when an older version was valid. So does a `.` in a step id or a field name.

A step can run another workflow from `workflows/` with `workflow: <name>` and pass that workflow's inputs with `with`:

```yaml
  - id: check
    needs: [plan]
    workflow: check-issue
    with:
      issue: "{{ inputs.issue }}"
      task: "{{ steps.plan.outputs.task }}"
```

Every string in `with`, at any depth, is a template. A string that is exactly one template keeps its JSON type, so `task` gets the object itself; any other string is text. When the step is ready, the values are checked against the child's `inputs`, and a mismatch fails the step with `invalid_inputs`. The child sees only its own inputs and steps. Its steps run in place of the step and are leased by their path, such as `check.classify`. The step takes the child's outcome. An `end` inside the child finishes only the child, and the parent reads it as `steps.<id>.end`. A child returns values with `outputs`, each a path to one of its steps, such as `outputs: { verdict: steps.classify.outputs.verdict }`, and the parent reads `steps.<id>.outputs.verdict`. A step that runs a workflow cannot have `output`, `agent`, `model`, or `env`.

A `prompt` or `prompt_file` step can have `with` too, so several workflows can share one prompt file. Its values follow the same rules, and the prompt reads them as `{{ with.<name> }}`, such as `Fix {{ with.task }}`. `{{ with.<name> }}` is valid only in the prompt of a step whose `with` has that name. A command step cannot have `with`; it uses `env`.

`workflow: <name>` is looked up by name in the validated cache that `teamai pull` writes, not in the files. `workflow start` takes every workflow the run uses from that cache and keeps them in the run, so a later pull does not change a run in progress. A child with no runnable version, or workflows that run each other in a cycle, stop `start` with an error that names them. `teamai pull` reports the same problems on the parent's step, along with `with` keys that do not match the child's `inputs` and a read of an output or end the child does not declare; such a read also leaves the parent with nothing to run.

A step can also write the workflow it runs in place, to treat a group of steps as one step:

```yaml
  - id: check
    needs: [plan]
    workflow:
      ends: { dropped: succeeded }
      outputs: { verdict: steps.classify.outputs.verdict }
      steps:
        - id: classify
          prompt: "Classify {{ inputs.title }} for {{ steps.plan.outputs.task }}."
          output: { verdict: fix | drop }
        - id: drop
          needs: [classify]
          if: steps.classify.outputs.verdict == 'drop'
          end: dropped
```

An inline workflow has `steps` and optional `ends` and `outputs`, which work as in a file. It has no `inputs` and its step has no `with`: its steps read the enclosing workflow's inputs and the steps the enclosing step needs, directly or through their needs. A step inside it with the same id as an outer step hides that step. Its steps are leased by path, such as `check.classify`, and an `end` inside it finishes only the inline workflow. An inline workflow can run a workflow file or contain another inline workflow.

Choose headless tools per machine in the local config:

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

An agent-specific entry wins over `default`. `claude`, `codex`, and `opencode` are supported. For CI, override this selection for one start with `--tools default=claude,implementer=codex`. A named agent is read from the file `teamai pull` already deployed for the selected tool, in that tool's directory for this scope.

```text
teamai workflow start build --driver local
```

`--driver local` runs a step with no `workspace` in the current checkout, unless an enclosing step opened a workspace. A command there is read-only: if it exits 0 and changed repository files, their permissions, a symlink target, the destination of a staged rename, a file inside a dirty submodule, the index, or HEAD, the step fails and leaves that change in place. This includes a change inside an existing untracked directory; leaving that directory unchanged does not fail the step. A step with `workspace: new` changes files on its own branch. See [Workspaces](#workspaces). Steps that share the current checkout run one at a time. Steps in different worktrees run together up to [`workflows.max_parallel`](workflow-advanced.md#run-local-commands-in-parallel). Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`. `changes` whose `branch` or `base` differs from the lease returns `invalid_report`, and the step stays leased. A read-only step in a workspace reports `read` (`branch`, `base`, and the `commit` it read) in place of `changes`. `changes` from it, a success without `read`, `read` from any other step, or `read` that differs from the lease returns `invalid_report` too. `used` (`{"skills":["review-notes"]}`) names the team skills the pass loaded, for its [scorer labels](scorers.md#any-driver). A value that is not a skill name is dropped, and a `used` of another shape returns `invalid_report`. A payload field the CLI does not read, such as a misspelled `tokens` written as `tokenz` or a field from a newer protocol version, is accepted but reported back: the success envelope of `next`, `report`, and `respond --json` carries `ignored` with those names — top-level fields first, then `driver.<field>` names — names only and never values. The key is left out when nothing was ignored, and an error envelope stays as it is.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` or `cancelled` exits with status 1. No workflow process keeps running.

Use `workflow respond <run> <step> <choice>` for a waiting HITL request, `workflow retry <run> <step>` for a failed or stuck step, `workflow cancel <run> [step]` to stop work, `workflow resume <run>` to continue locally, and `workflow publish <run>` to let another machine continue it ([Continue a run on another machine](#continue-a-run-on-another-machine)). `next` answers `lease`, `hitl`, `wait`, or `done`. See [HITL](workflow-advanced.md#hitl-human-in-the-loop) and [Retry, cancel, and resume](workflow-advanced.md#retry-cancel-and-resume).

## Workspaces

A command with no `workspace` is read-only. Outside a workspace it runs in the current checkout. If it exits 0 and changed repository files, their permissions, a symlink target, the destination of a staged rename, a file inside a dirty submodule, the index, or HEAD, the step fails with `read_only_dirty` and leaves that change in place. A headless prompt with no `workspace` is read-only in the same way, unless an enclosing workflow or `for_each` opens a workspace. An interactive prompt keeps the person's edits, unless that prompt sets `workspace: read-only`. Submodule changes count even when `submodule.<name>.ignore` or `diff.ignoreSubmodules` hides them from `git status`: a read-only step that makes one fails, and a step that writes commits the submodule's new commit.

Inside a workspace an enclosing step opened, a read-only step runs in that workspace, so a test sees the change it follows. It reads the branch its `needs` changed, or the enclosing branch when they changed none. When they changed more than one branch, it fails with `workspace_base`: add a step that merges them, and need that step. It runs one at a time with the workspace's other steps, on the same base agent files, and only a driver that declares `continue` and owns that workspace takes it. It commits nothing. Afterwards the driver puts the workspace back as the step found it: if the step changed it or left its branch, what it changed is kept on `refs/teamai/kept/<attempt>`, and the submodule commits it made under `refs/teamai/kept-modules/<attempt>/`. The worktree and the submodules the step changed are then reset to the commit it read and its untracked files are removed, and an exit 0 still fails with `read_only_dirty`. Ignored files stay in place. A submodule the step changed that has uncommitted or untracked files cannot be kept, so then nothing is reset. When the workspace is not put back, the step fails with `workspace_base`. The workspace is marked when the step starts, so later steps there fail, even after the driver was killed during the step, until you put it back on its branch at that commit as the step found it and run `teamai workflow retry <run> <step>`. If the workspace already had changes when the step started, also delete the marker file the failure names. The pass records `read`: the branch, the base, and the commit it read. The workspace is a fresh worktree without ignored files such as `node_modules`, so a test installs what it needs, for example `npm ci && npm test`, unless the team's [`postDeploy`](distribution.md#team-scripts) does.

`workspace: new` runs the step in its own git worktree, on a branch named for this run, step, and pass. The step commits what it changed. A step that leaves that branch, for example with `git switch`, fails with `workspace_base`: nothing is committed or pushed, and the worktree stays as the step left it. The current checkout is not switched, reset, or cleaned. A later step that lists it in `needs` starts from the first of those branches and merges the rest, in `needs` order. A merge conflict stops there. A command fails with `merge_conflict`, and the message names the branch and the files. A prompt is told which files still conflict and which branches were not merged.

`workspace: continue` stays on the branch an enclosing `workflow` step opened with `new`. A prompt with no `workspace` continues that copy. A `for_each` with `workspace: new` gives each item its own branch, so items do not share a worktree. `steps.<id>.branches` lists those branches, and each `results` entry has `branch` when the item has one. An item with `after` starts from the branches it waits for. A top-level `workspace: continue`, with no enclosing `new`, fails the step with `workspace_base`.

The step sees the agent files from the commit the run started at: `AGENTS.md`, `CLAUDE.md`, `.agents`, `.githooks`, every tool's project directory such as `.claude` or `.tclaude`, the project MCP files `.mcp.json` and `opencode.json`, and Copilot's agent paths under `.github`. A hook an earlier step committed does not run in a later step. The team's skills, rules, agents and MCP are then delivered into the worktree, as they are for any new worktree of this checkout. Those delivered files are not part of the step's commit. A file the step itself edits is committed.

When the checkout has an `origin` and the step made commits, the driver pushes that branch, also when the step failed. A later attempt that adds no commit still pushes when this branch has commits `origin` does not have. That includes a first push that never landed, and an origin that has no branches yet. A failed push fails a step that succeeded with `push_failed` and keeps the worktree. A step that failed keeps its own failure, and its message adds that the push failed. With no `origin`, or when `origin` already has that commit, the run still succeeds and reports the branch.

`session: continue` resumes this step's previous pass with the same tool. `session: { from: <step> }` resumes a step this one needs. A different tool resumes a copy of the session. OpenCode gets the copy but always starts fresh, because it has no flag to resume a session. A step resumes a session as the last step that continued it left it, whichever tool or machine that step ran on. A step that started a new session, such as an OpenCode step, does not change what later steps resume.

A command that starts its own sandbox, such as `docker`, stays read-only. What it writes does not become a branch a later step can merge.

```yaml
schemaVersion: v1alpha1
name: change
description: Change two files on their own branches, then join them.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('joined.txt', 'J')"
```

## Continue a run on another machine

A run lives in the TeamAI data directory of the machine that started it. To continue it somewhere else, publish it, then resume it on the other machine. Use this when your tool runs out of tokens in the middle of a run, when you hand a run to a teammate, or when a CI run failed and you want to finish it on your own machine.

```text
teamai workflow publish <run>     # on the machine that has the run
teamai workflow resume <run>      # on the other machine, in a checkout of the same repository
```

`publish` writes the run's state to the team's `teamai-reports` branch and makes this install the run's owner. Stop the driver first, so no step is in flight. A step still leased when you publish runs again on the other machine. A Ctrl-C leaves what the in-flight step wrote in that step's worktree on this machine, and another machine can still claim the run. If you take the run back here while it is still running, the claim makes this install the owner, but `resume` refuses with `branch_diverged` and names the worktree. Move those changes elsewhere or remove them, then run `resume` again. On a machine that does not have the run, `resume` takes it from `teamai-reports`, makes that install the owner, and drives it with the local driver.

Only the owner continues a published run. On another install that has the run, `resume` and `publish` answer `not_owner` with the owner's user name and install id. Two installs of one member show the same user name, and the install id tells them apart. To take the run over, run `teamai workflow resume <run> --claim`. The claim replaces this machine's copy of the run and releases the leases other machines held. The previous owner can then no longer publish or resume the run, unless it claims it back.

When a published run ends, teamai publishes how it ended, without `--sessions`. A member who then takes the run over runs none of its steps again.

`publish` writes the run's state with [usage reporting](reporting.md) on or off: it is the state another machine needs to continue the run, not a usage report. A run you never publish stays on this machine. While usage reporting is on, only its [run records](#run-records) reach `teamai-reports`.

A step with `session: continue` or `session.from` starts a new agent session on the other machine, unless you publish with `--sessions`. When a run goes back and forth, every machine that continued a session publishes with `--sessions` before the next claim, so the next step gets every turn. [Publish and claim](workflow-advanced.md#publish-and-claim) covers what the published state carries, every error and its next step, and publishing from CI.

## Run records

With [usage reporting](reporting.md) on, every run publishes a privacy-preserving record to the team's `teamai-reports` branch: once when it starts and once when it ends. With it off, nothing is published and the envelopes carry no `record`. Records live in `workflows/runs/<run id>.json`, keyed by run id, so a retried publication updates the same record instead of adding a copy.

A record carries only: the run id, workflow name, `sourceHash`, optional `teamRevision`, phase (`start` or `end`), driver kind, status, the end the run reached (when it reached one), the failure code of a run that failed without reaching an end, when it is a code teamai sets, such as `loop_exhausted` for a loop that ran out or `tool_unavailable` when the local driver cannot find the tool (never its message), start and end times, duration, per-step entries (step path such as `check.classify`, agent, tool, model, outcome, tokens — a mixed-agent run records each step's own fields; `tool` is kept only when it is one of the local driver's tools, and `model` is the name the driver reported, kept only when it is shaped like a model name), summary step counts (succeeded, failed, skipped, cancelled), the cumulative settled-attempt count, and the publishing username. `sourceHash` identifies the exact workflow and prompt bytes that ran. `teamRevision` is present only when one remote-reachable team commit stores those exact bytes for the parent and every child workflow; local or unpushed edits and mixed cached revisions leave it out. Every entry has its `pass` number, and a step that a loop ran more than once has one entry per pass. An item of a `for_each` counts the times that item ran, so its `pass` can be lower than its step's when an earlier pass had fewer items. A cancelled step's entry has the outcome `cancelled`, and a skipped step's has none. The counts cover each step once, as the run ended. Steps of a sub-workflow that never started are not counted. Prompts, command text, input values, `env` values, outputs, diffs, secret values, local workspace paths, session ids, and hostnames have no field to land in — the record is built from an allowlist, not filtered from the run state.

An entry's `agent` is what that pass ran as, as observed. It holds the step's `agent:` definition and how the tool got it (`main` when the tool reads its own agent file, `prompt` when the instructions are prepended), the tool and its version, the model and effort the launch asked for and the model the tool reported, the team commit the checkout last pulled and whether a delivered file was edited since, the project commit, the TeamAI version, and the driver kind. A value nobody observed is left out. `fingerprint` hashes the definition, tool, model, effort and team commit, so two passes with the same fingerprint ran with the same recorded parts. It is left out when the model or the team commit is unknown, or a delivered file was edited. A pass nothing observed, and a record from an older TeamAI, carry only the definition's name. While a step runs, the tool it starts, and any session that tool starts in the same checkout, skips the session-start pull when the checkout's last pull delivered completely to that tool, so the step keeps the team commit it records.

The operation that settles the run queues its end record under the run lock and publishes it after releasing that lock. Retry updates the same record path when the run ends again. Answer entries publish choice, channel, and agent only; notes, answer timestamps, and answer driver identities stay local. A publication that fails — no remote, a busy reports lock, a rejected push — is queued in this scope's data directory and retried on the next `teamai pull`. The `start` and `next` envelopes then carry `record: pending` instead of `record: published`. The run itself is unaffected: a machine that dies after starting a run leaves it visible as started but not ended.

Run ids are `r` plus 16 hex digits. Runs created before this scheme used 8 hex digits and still resolve.

Workflow totals (runs, succeeded, failed, cumulative duration) are folded into `stats/<username>.yaml` on the reports branch at publication time and shown by `teamai digest`.
