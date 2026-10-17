# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and read-only prompt steps, each after the steps it needs. [Advanced workflows](workflow-advanced.md) covers parallel steps, loops, `for_each`, what an end does to steps that still run, and the full expression language.

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

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and exactly one of `command`, `prompt`, `prompt_file`, or `workflow`. `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

A prompt step can set `model`: an alias from `models/aliases.yaml` or a model name, without spaces or templates. `defaults: { model: fast }` at the top of a file sets one for its prompt steps. A prompt step runs on the first of these that is set:

1. the step's `model`;
2. the model its agent's definition sets for the tool;
3. `defaults.model`;
4. the tool's default model.

A step's `model` replaces the agent's model and effort, and keeps its other settings. A model name that is not an alias runs at the tool's default effort. A workflow file that another runs uses its own `defaults.model`, else the one in effect for the step that runs it. An inline workflow uses the enclosing one. When the alias has no model for the step's tool, or the member's `~/.teamai/models/aliases.yaml` turns it off, the step fails with `model_unavailable` before the tool starts. On OpenCode 1, so does a step whose `model` is its agent's own model with no effort while the agent file sets `variant` and a `mode` other than `subagent`, since OpenCode 1 would apply that variant. OpenCode 2 does not take the model or variant from the agent file, and OpenCode 1 does not start a subagent with `opencode run --agent`, so the driver passes the definition's own model and variant on the command line. For an agent file with `mode: subagent`, which pull writes by default, OpenCode 1 gets the agent's instructions in the prompt, and the driver warns about the file settings that then do not apply. A lease carries `model` and `defaultModel` as written, and the driver resolves them.

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

`--driver local` runs steps in the current directory, one at a time unless [`workflows.max_parallel`](workflow-advanced.md#run-local-commands-in-parallel) is above 1. Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. Prompt steps are read-only: if a tool changes the repository, the step fails and leaves those files in place for inspection. This includes changes to files inside an existing untracked directory; leaving that directory unchanged does not fail the step. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`. A payload field the CLI does not read, such as a misspelled `tokens` written as `tokenz` or a field from a newer protocol version, is accepted but reported back: the success envelope of `next` and `report` carries `ignored` with those names — top-level fields first, then `driver.<field>` names — names only and never values. The key is left out when nothing was ignored, and an error envelope stays as it is.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` exits with status 1. No workflow process keeps running.

## Run records

With [usage reporting](reporting.md) on, every run publishes a privacy-preserving record to the team's `teamai-reports` branch: once when it starts and once when it ends. With it off, nothing is published and the envelopes carry no `record`. Records live in `workflows/runs/<run id>.json`, keyed by run id, so a retried publication updates the same record instead of adding a copy.

A record carries only: the run id, workflow name, phase (`start` or `end`), driver kind, status, the end the run reached (when it reached one), the failure code of a run that failed without reaching an end, when it is a code teamai sets, such as `loop_exhausted` for a loop that ran out or `tool_unavailable` when the local driver cannot find the tool (never its message), start and end times, duration, per-step entries (step path such as `check.classify`, agent, tool, model, outcome, tokens — a mixed-agent run records each step's own fields; `tool` is kept only when it is one of the local driver's tools, and `model` is the name the driver reported, kept only when it is shaped like a model name), summary step counts (succeeded, failed, skipped, cancelled), the cumulative settled-attempt count, and the publishing username. Every entry has its `pass` number, and a step that a loop ran more than once has one entry per pass. An item of a `for_each` counts the times that item ran, so its `pass` can be lower than its step's when an earlier pass had fewer items. A cancelled step's entry has the outcome `cancelled`, and a skipped step's has none. The counts cover each step once, as the run ended. Steps of a sub-workflow that never started are not counted. Prompts, command text, input values, `env` values, outputs, diffs, secret values, local workspace paths, session ids, and hostnames have no field to land in — the record is built from an allowlist, not filtered from the run state.

The end record is published by the `next` that settles the run. A publication that fails — no remote, a busy reports lock, a rejected push — is queued in this scope's data directory and retried on the next `teamai pull`. The `start` and `next` envelopes then carry `record: pending` instead of `record: published`. The run itself is unaffected: a machine that dies after starting a run leaves it visible as started but not ended.

Run ids are `r` plus 16 hex digits. Runs created before this scheme used 8 hex digits and still resolve.

Workflow totals (runs, succeeded, failed, cumulative duration) are folded into `stats/<username>.yaml` on the reports branch at publication time and shown by `teamai digest`.
