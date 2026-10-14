# Workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A workflow is a YAML file at `workflows/<name>.yaml` in the team repo. It runs command and read-only prompt steps in order.

```yaml
schemaVersion: v1alpha1
name: build
description: Compile the project, then run its tests.
steps:
  - id: compile
    command: npm run build
  - id: test
    command: npm test
    output:
      ok: boolean
  - id: review
    prompt_file: prompts/review.md
    agent: reviewer
```

`schemaVersion` must be `v1alpha1`. `name` must match the file name. `description` is required. Each step has a unique `id` and at most one action: `command`, `prompt`, `prompt_file`, or `workflow` (or a pure `end` step). `agent` is optional on prompt steps. `output` uses the existing shorthand: `string`, `number`, `boolean`, a literal union, an object, or an array with one item type. TeamAI validates successful command stdout or a prompt tool's `output` against it.

### Dependencies and Conditions

Use `needs` to declare dependencies as a directed acyclic graph (DAG). When steps do not declare `needs`, they run sequentially.

```yaml
steps:
  - id: build
    command: npm run build
  - id: test
    needs: [build]
    command: npm test
  - id: notify_failure
    needs: [test]
    if: steps.test.outcome == 'failed'
    command: node notify.js
```

- **Join rule**: a step with multiple dependencies is skipped only when every dependency was skipped.
- **Conditions (`if`)**: expressions evaluate boolean logic, comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), and access `inputs.*` or settled step results `steps.<id>.outcome`, `steps.<id>.outputs.*`, and `steps.<id>.end`. JavaScript `eval` is not used.
- **Recovery branches**: when a dependency fails, downstream steps are skipped unless their `if` condition explicitly reads the failed step.

### Inputs and Command Environment

Inputs are declared at the workflow root. Command steps receive inputs only through explicit `env:` mappings. Command strings are never template-expanded, preventing shell injection when values contain characters like `$(...)`.

```yaml
inputs:
  target:
    type: string
steps:
  - id: deploy
    command: ./deploy.sh
    env:
      DEPLOY_TARGET: "{{ inputs.target }}"
```

### Sub-workflows and Composition

A step can run another workflow by name (file sub-workflow) or define an inline sub-workflow.

```yaml
steps:
  - id: sub
    workflow: build
    with:
      target: prod
  - id: inline_step
    workflow:
      steps:
        - id: nested
          command: echo "running nested step"
      outputs:
        status: steps.nested.outcome
```

File sub-workflows isolate their inputs to only what is passed in `with:`. Inline workflows can read values from their enclosing scope.

### Outputs and Named Ends

Declare `outputs` to export settled values from a workflow. Declare `ends` to define named terminal outcomes (`succeeded` or `failed`) that settle the workflow early and expose their outcome to parent steps as `steps.<id>.end`.

```yaml
ends:
  rejected: failed
  approved: succeeded
steps:
  - id: check
    command: node check.js
    end: approved
outputs:
  decision: steps.check.end
```

`teamai pull` and `teamai push` check each file on its own. A `prompt_file` must be a regular, non-symlink file under `prompts/` in the team repo. Its text is cached with the validated workflow, so an existing run keeps that revision even if the source is later changed or deleted. A file that was valid before keeps that version in the local cache when a new revision is invalid. A field this version of teamai does not know is different: that workflow has nothing to run until teamai is updated.

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

`--driver local` runs one step at a time in the current directory. Each attempt uses `result.json` under the scope's TeamAI data directory, outside the checkout. Prompt steps are read-only: if a tool changes the repository, the step fails and leaves those files in place for inspection. The driver calls the same `next` and `report` operations shown below:

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` is `success`, `failed`, or `released`. `released` puts the step back to pending. It does not use up a retry. A report for an attempt that was already settled returns `repeated_report`, even when the revision is old. The run keeps recent settled attempts for that check. An older attempt uses the other checks: an old revision returns `stale_revision`, and a current revision that is not the leased attempt returns `wrong_attempt`. Another driver returns `wrong_driver`.

The run is stored in this scope's TeamAI data directory. The command exits when it finishes. A local run that ends `failed` exits with status 1. No workflow process keeps running.
