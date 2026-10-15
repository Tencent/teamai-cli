# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and read-only prompt steps, each after the steps it needs.

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

Every step after the first lists the steps it waits for in `needs`. `needs: []` starts another branch with no dependency. One step runs at a time: the first step in the file whose needs are done. A step is skipped when a step it needs failed, or when every step it needs was skipped. A skipped step never runs. A failure does not stop other branches. When nothing is left to run, the run ends `failed` if any step failed, otherwise `succeeded`. A missing `needs`, a `needs` id that is not a step, or a cycle makes the file invalid. A missing `needs` also leaves the workflow with nothing to run, even when an older version was valid.

A step can carry an `if` expression. When it is false, the step is skipped, and that does not fail the run. An expression reads `steps.<id>.outcome` (`success`, `failed`, or `skipped`) and `steps.<id>.outputs.<field>`, only for steps it needs, directly or through their needs. It has `==`, `!=`, `&&`, `||`, `!`, parentheses, and the literals `'text'`, numbers, `true`, `false`, `null`, and `[]`. A missing value reads as `null`. `false`, `null`, `0`, and `''` are false; everything else is true. `==` is strict and compares whole values: `'1' == 1` and `'Build' == 'build'` are false.

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

`{{ inputs.<name> }}` and `{{ steps.<id>.outputs.<field> }}` (or `.outcome`) fill in a `prompt`, the text of a `prompt_file`, and `env` values when the step starts. Other `{{ ... }}` text, such as `${{ secrets.TOKEN }}`, stays as written. So does any `{{` right after a `$`, such as `${{ inputs.version }}` in a prompt about GitHub Actions. To put a value right after a `$`, add a space: `$ {{ inputs.price }}`. Strings appear as they are, numbers and booleans as text, objects and arrays as JSON, and `null` or a missing value as empty text. A template reads only what an `if` on that step could read.

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

Every string in `with`, at any depth, is a template. A string that is exactly one template keeps its JSON type, so `task` gets the object itself; any other string is text. When the step is ready, the values are checked against the child's `inputs`, and a mismatch fails the step with `invalid_inputs`. The child sees only its own inputs and steps. Its steps run in place of the step and are leased by their path, such as `check.classify`. The step takes the child's outcome. An `end` inside the child finishes only the child, and the parent reads it as `steps.<id>.end`. A child returns values with `outputs`, each a path to one of its steps, such as `outputs: { verdict: steps.classify.outputs.verdict }`, and the parent reads `steps.<id>.outputs.verdict`. A step that runs a workflow cannot have `output`, `agent`, or `env`.

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

`--driver local` runs one step at a time in the current directory. Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. Prompt steps are read-only: if a tool changes the repository, the step fails and leaves those files in place for inspection. This includes changes to files inside an existing untracked directory; leaving that directory unchanged does not fail the step. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` exits with status 1. No workflow process keeps running.
