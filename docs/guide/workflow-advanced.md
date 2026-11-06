# Advanced workflows

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

Each section below builds on [Workflows](workflow.md) and stands on its own.

## Run ready steps in parallel

A driver can hold several leases at once. In each `next` call it lists, in `running`, the attempts of its open leases that it still runs. `next` then leases the next ready step instead of handing an open lease back.

```yaml
schemaVersion: v1alpha1
name: checks
description: Lint and test at the same time, then build.
steps:
  - id: lint
    command: npm run lint
  - id: test
    needs: []
    command: npm test
  - id: build
    needs: [lint, test]
    command: npm run build
```

Each call below sends `"driver":{"kind":"script","machine":"host","workspace":"/work"}` and the fields shown:

| `next` fields besides `driver` | Answer |
| --- | --- |
| none | `{"data":{"lease":{"run":"ra780d018","step":"lint","attempt":"af143e3a7","revision":1,"pass":1,"command":"npm run lint"},"cancelled":[]}}` |
| `"running":["af143e3a7"]` | `{"data":{"lease":{"run":"ra780d018","step":"test","attempt":"a0ce8107f","revision":1,"pass":1,"command":"npm test"},"cancelled":[]}}` |
| `"running":["af143e3a7","a0ce8107f"]` | `{"data":{"wait":{"reason":"lint is leased"},"cancelled":[]}}` |

Each call to `next` does this, in order:

1. It settles the run. If the run has ended, it answers `done`.
2. It hands back an open lease of this driver that `running` leaves out. A restarted driver sends `"running":[]` and gets its open leases back, one per call.
3. It leases the first ready step in file order. The steps of a sub-workflow take the place of the step that runs it. A step that needs a workspace mode `driver.can.workspace` does not list, something else `driver.can` does not declare (see [Requirements and limits](#requirements-and-limits)), or a workspace another driver opened, is held back, and the next ready step is leased.
4. When every ready step is leased, it answers `wait`, and `reason` names the first open lease. When every ready step is held back, `reason` names each one, separated by `; `, and `held` lists them as `{ step, reason, missing }`. `missing` names what the driver lacks, such as `hitl` or `workspace.new`, and is empty when another driver holds the workspace.

A driver that sends no `running` gets its open lease back on every call, so it runs one step at a time.

`"canTakeLease":false` issues no new lease but still returns a waiting HITL request to a driver that declares `driver.can.hitl`. The answer is `done`, an open lease that `running` leaves out, `hitl`, or `wait`. When nothing is leased or waiting at a HITL request, the `wait` reason is `canTakeLease is false`. Use it to learn about an end while the driver has no room for another step. That `wait` does not mean that nothing is left to run, so call `next` again once the driver has room. Step 2 can still hand back an open lease that the driver has no room for, so keep a queue of the leases the driver has not started.

List those in `queued` too, such as one waiting for a busy checkout. The step's own timeout of each then counts from this call, so waiting does not use it up, and the answer's `deadlines` gives each its new deadline, for example `"deadlines":{"a0ce8107f":"2026-05-01T10:12:00.000Z"}`. The clock restarts only on a call that lists the attempt, so keep calling `next` while it waits, and send the same `queued` with each `report` and each `respond --json`, since either can time out a lease whose clock has not restarted lately.

Every `data` answer of `next` has `cancelled`. It lists the attempts in `running` that are no longer open leases of this driver. Stop those processes. An `error` answer has no `cancelled`.

A wrong `running`, `queued` or `canTakeLease` returns `invalid_json` with `running must be an array of attempt ids`, `queued must be an array of attempt ids` or `canTakeLease must be a boolean`. While one driver holds a lease, another driver gets `wait`, and `reason` names that lease.

`report` checks each report against the revision of its own lease, not the run's latest revision. Above, `next` handed out both leases at revision 1. A report for `test` with `"revision":1` moves the run to revision 2. A report for `lint` with `"revision":1` is still accepted and moves it to 3. A report with another revision for an open lease returns `stale_revision`:

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

### Run local commands in parallel

`--driver local` runs up to `workflows.max_parallel` command steps at once. Set it in `~/.teamai/config.yaml`, or in a workspace's own `config.yaml`. It defaults to 1, and no flag sets it.

```yaml
workflows:
  max_parallel: 4
  auto_approve: false
```

A prompt in the current checkout waits until that checkout is free, and nothing else in that checkout starts until the prompt finishes. The read-only check compares that checkout before and after the prompt. A prompt with `workspace: new` runs in its own worktree, so it can overlap steps in other worktrees, up to `max_parallel`. Commands with no `workspace` share the checkout and run one at a time with anything else there.

With `max_parallel` above 1:

- Commands with no `workspace` share the checkout and run one at a time. A later one sees files an earlier one left there. Commands with `workspace: new` use separate worktrees and can run together.
- Each command runs without a terminal, so it cannot read input from you.
- On Ctrl-C, or on a SIGTERM, SIGQUIT, or SIGHUP, teamai stops every command, waits for them to exit, and exits with that signal.

With 1, the driver runs one step at a time, and a command runs in your terminal, where Ctrl-C reaches it. A SIGTERM or SIGHUP sent to teamai alone stops the command, waits for it, and exits with that signal.

With `max_parallel` unset, the driver still runs one step at a time, except the items of a `for_each` that declares `max_parallel`: they run side by side, up to that number. No other step starts while they run, and a `for_each` with no `max_parallel` runs its items one at a time. A run that has such a `for_each` runs as with `max_parallel` above 1: commands get no terminal, and Ctrl-C stops them all. Answers and command items with no `workspace` share the checkout and run one at a time, even when the fan-out allows more parallel items. Give an answer `workspace: new` to run the items side by side.

```yaml
schemaVersion: v1alpha1
name: summarize-modules
description: Summarize each module, two at a time, then print the summaries.
inputs:
  modules: [string]
steps:
  - id: summary
    for_each: { items: inputs.modules, max_parallel: 2 }
    answer: "Summarize the module {{ item }} in one line."
    output: { text: string }
    workspace: new
  - id: report
    needs: [summary]
    command: 'echo "$SUMMARIES" >&2'
    env: { SUMMARIES: "{{ steps.summary.results }}" }
```

```text
$ teamai workflow start summarize-modules --driver local --inputs '{"modules":["api","cli","web"]}'
ℹ Run rb7a66009e227f202 started. If it stops before it ends, continue it with: teamai workflow resume rb7a66009e227f202
{"data":{"done":{"run":"rb7a66009e227f202","outcome":"succeeded","progress":[{"step":"report","lines":["[{\"item\":\"api\",\"outcome\":\"success\",\"outputs\":{\"text\":\"HTTP routes and handlers.\"}},{\"item\":\"cli\",\"outcome\":\"success\",\"outputs\":{\"text\":\"Command parsing and output.\"}},{\"item\":\"web\",\"outcome\":\"success\",\"outputs\":{\"text\":\"The dashboard pages.\"}}]"]}],"record":"published"},"cancelled":[]}}
```

Each answer reads a worktree of its own, so the tool answers `api` and `cli` at the same time, then `web`; `report` starts once all three are done. Other drivers already run ready steps side by side, so this applies to the local driver only.

When an end cancels a running command, the driver sends SIGTERM to it and the processes it started, then SIGKILL 5 seconds later if any still run. A stopping command keeps its slot until its processes exit.

## An end cancels the steps still open

When a workflow reaches an end, its steps that have not settled stop. A pending step is skipped. A leased step, and a step whose workflow is running, become `cancelled`. The same applies to the steps of its sub-workflows. An end inside a sub-workflow stops only that sub-workflow, and the parent goes on.

```yaml
schemaVersion: v1alpha1
name: fail-fast
description: Lint and test at the same time, and stop at the first failure.
ends: { broken: failed }
steps:
  - id: lint
    command: npm run lint
  - id: test
    needs: []
    command: npm test
  - id: stop
    needs: [lint]
    if: steps.lint.outcome == 'failed'
    end: broken
```

A driver runs `lint` and `test` together. `lint` fails, so `stop` reaches `broken`. The next `next` that lists `test` in `running` answers:

```text
{"data":{"done":{"run":"r2c7f2c70","outcome":"failed","end":"broken"},"cancelled":["acc763f50"]}}
```

`report` does not record a report for a cancelled attempt. It returns `lease_cancelled`, whatever driver sends it:

```text
{"error":{"code":"lease_cancelled","message":"Attempt acc763f50 was cancelled; its report is not recorded"}}
```

`steps.<id>.outcome` reads `cancelled` for a cancelled step. Nothing in a workflow runs after its end, so only the workflow's `outputs` can read it. Here the parent learns that `lint` failed before the tests finished:

```yaml
schemaVersion: v1alpha1
name: gate
description: Report which check stopped a gate.
steps:
  - id: checks
    workflow:
      ends: { broken: failed }
      outputs: { test: steps.test.outcome }
      steps:
        - id: lint
          command: npm run lint
        - id: test
          needs: []
          command: npm test
        - id: stop
          needs: [lint]
          if: steps.lint.outcome == 'failed'
          end: broken
  - id: notify
    needs: [checks]
    if: steps.checks.outputs.test == 'cancelled'
    command: echo "lint failed before the tests finished"
```

## Run a step once per item

`for_each` runs a step once per item of a list. It takes an expression that gives the list, or a map with that expression in `items` and a limit in `max_parallel`. Each item runs as an instance of its own, named by the step id and the item's index from 0: `build[0]`, `build[1]`, and so on.

```yaml
schemaVersion: v1alpha1
name: fan-build
description: Build each package, two at a time, then explain the failures.
inputs:
  packages: [{ id: string, dir: string }]
steps:
  - id: build
    for_each: { items: inputs.packages, max_parallel: 2 }
    command: npm run build --prefix "$PACKAGE_DIR"
    env:
      PACKAGE_DIR: "{{ item.dir }}"
  - id: explain
    needs: [build]
    if: any(steps.build.results, .outcome == 'failed')
    prompt: "Explain each failed build in these results: {{ steps.build.results }}"
```

`build` reads `inputs.packages` once, when it becomes ready. If the value is not a list, the step fails with `invalid_items`. If the list is empty, the step succeeds at once, and its results are `[]`.

Each instance reads its item as `item` in `prompt`, `env`, and `with`, and in every step of the inline workflow it runs. A `with` value that is only `{{ item }}` keeps the item's JSON type. A `command` is not templated, so pass the item through `env`. The step's own `if` and `for_each` are evaluated once, before any item runs, so they cannot read the step's items. Outside a `for_each`, `{{ item }}` stays as written, and pull rejects any other read of `item`, such as in an `if` or in `{{ filter(inputs.xs, . == item) }}`.

A driver gets each item as an ordinary lease whose `step` is `build[0]`, `build[1]`, and so on. A driver that lists its open leases in `running` gets the next item while the others run. `max_parallel` limits how many items are leased or running at once. At the limit, `next` hands out no other item until one of them settles.

`max_parallel` can also be a template that reads one number input, so whoever starts the run picks the limit. Pull rejects a template that reads anything else, such as a step's outputs or `item`, or that adds text around the `{{ … }}`.

```yaml
schemaVersion: v1alpha1
name: describe-modules
description: Describe each module, as many at once as the member asks for.
inputs:
  modules: [string]
  concurrency: number
steps:
  - id: describe
    for_each: { items: inputs.modules, max_parallel: "{{ inputs.concurrency }}" }
    command: 'echo "described $MODULE" >&2'
    env: { MODULE: "{{ item }}" }
```

```text
$ teamai workflow start describe-modules --driver local --inputs '{"modules":["api","cli"],"concurrency":2}'
ℹ Run r3112e07f9a6d93ad started. If it stops before it ends, continue it with: teamai workflow resume r3112e07f9a6d93ad
{"data":{"done":{"run":"r3112e07f9a6d93ad","outcome":"succeeded","progress":[{"step":"describe[0]","lines":["described api"]},{"step":"describe[1]","lines":["described cli"]}],"record":"published"},"cancelled":[]}}
```

With `"concurrency":0`, or any value that is not a whole number from 1, the start is refused before the run exists:

```text
{"error":{"code":"invalid_inputs","message":"Step \"describe\" for_each.max_parallel {{ inputs.concurrency }} renders 0, which is not a whole number from 1. Pass a whole number from 1 for the input it reads."}}
```

A failed item does not stop the other items. The step settles when every item has settled, and it fails if any item failed. `output` checks the outputs of each item.

`steps.<id>.results` lists how each item went, in item order. Each entry has `item`, `outcome`, and `outputs` when the item has outputs:

```json
[{"item":{"id":"core","dir":"packages/core"},"outcome":"success"},{"item":{"id":"cli","dir":"packages/cli"},"outcome":"failed"}]
```

When an item ran in a workspace, its entry also has `branch`. `steps.<id>.branches` lists those branches in the same order. When an item of a step with `deliver: pr` delivered a pull request, its entry also has `pr`, as `{ url }`.

A step with `for_each` has no outputs of its own, and a step without `for_each` has no results. Pull rejects a read of either, including in workflow outputs and earlier passes. To read one item, index the results, as in `steps.build.results[1].outcome`.

To retry failed items, use `for_each: "filter(steps.build.results, .outcome == 'failed')"` and `if: steps.build.outcome == 'failed'` on a step with `needs: [build]`. The `if` reads the failed dependency, so the retry step can run. Each retry item wraps the original value in `item.item`.

An item that is an object can carry a string `id` and an `after` list of the ids of other items. The item starts only after each of them succeeded. It is skipped when one of them failed, was skipped, or was cancelled.

```yaml
schemaVersion: v1alpha1
name: fan-publish
description: Pack and check each package after the packages it depends on.
inputs:
  packages: [{ id: string, dir: string }]
steps:
  - id: publish
    for_each: inputs.packages
    workflow:
      steps:
        - id: pack
          command: npm pack "$PACKAGE_DIR"
          env:
            PACKAGE_DIR: "{{ item.dir }}"
        - id: verify
          needs: [pack]
          prompt: "Check that the tarball of {{ item.id }} holds only files from {{ item.dir }}."
```

```text
teamai workflow start fan-publish --inputs '{"packages":[{"id":"core","dir":"packages/core"},{"id":"cli","dir":"packages/cli","after":["core"]}]}'
```

`publish[1]` starts after `publish[0]` succeeded. The steps of each item's workflow have ids such as `publish[0].pack` and `publish[1].verify`.

An `after` id that no item has, two items with the same id, or an `after` that is not a list of ids fails the step with `invalid_items` before any item runs. Items that wait for each other in a cycle fail it with `item_cycle`, and the message names the cycle:

```text
step "publish" has items that run after each other in a cycle: core -> cli -> core
```

Pull rejects `for_each` together with `loop`, `end`, or `break`. To run the work of an item again, put the loop in the workflow the item runs.

## Let a step fail without failing its workflow

`continue_on_failure: true` lets a step fail, time out, or be cancelled without failing the workflow it is in. The step still reads `failed` or `cancelled`, and its dependents follow the usual rules: a step that needs it runs only when its `if` reads it. On a `for_each` step, a failed item fails the step and not the run, and a step that times out or is cancelled keeps the `results` of the items that settled. A step that runs a workflow can have it too. A `finally` step cannot.

```yaml
schemaVersion: v1alpha1
name: review-packages
description: Review each package on the model it names; a review that fails does not fail the run.
inputs:
  packages: [{ dir: string, model: string }]
outputs:
  reviews: steps.review.results
steps:
  - id: review
    for_each: inputs.packages
    continue_on_failure: true
    prompt: "List the problems in the changes under {{ item.dir }}."
    model: "{{ item.model }}"
    output:
      problems: [string]
  - id: summarize
    needs: [review]
    if: length(filter(steps.review.results, .outcome == 'success')) > 0
    prompt: "Summarize these reviews for the pull request: {{ steps.review.results }}"
```

```text
teamai workflow start review-packages --inputs '{"packages":[{"dir":"packages/core","model":"strong"},{"dir":"packages/cli","model":""}]}'
```

`review[0]` runs on the model alias `strong`, and `review[1]` on the tool's default, since its model renders empty. When one review fails, `summarize` still runs on the other, and the run succeeds with every entry in `reviews`.

### Fall back on some failures only

`steps.<id>.failure` reads why a step failed: its `code` and its `message`. It is `null` for a step that did not fail. A fallback step reads it to cover the failures it is meant for and leave the others failing:

```yaml
schemaVersion: v1alpha1
name: summarize-or-keep
description: Summarize the notes, and keep them as written when the tool fails for any reason but a tool the member names that cannot run.
inputs: { notes: string }
ends: { unconfigured-tool: failed }
steps:
  - id: summary
    answer: "Summarize these notes in five lines: {{ inputs.notes }}"
    output: { text: string }
    timeout: 60s
    continue_on_failure: true
  - id: keep
    needs: [summary]
    if: steps.summary.outcome == 'failed' && steps.summary.failure.code != 'tool_unconfigured'
    command: 'echo "Kept the notes as written: $WHY" >&2'
    env: { WHY: "{{ steps.summary.failure.message }}" }
  - id: stop
    needs: [summary]
    if: steps.summary.failure.code == 'tool_unconfigured'
    end: unconfigured-tool
```

When the tool times out or exits with an error, `keep` runs and the run succeeds. When `TEAMAI_AI_TOOL` or `ai.tool` names a tool that cannot run, `stop` ends the run `failed`, so the member sees the setting to fix. `continue_on_failure` alone would let the run succeed with nothing done. `failure` reads only the step's current pass. A template that a lease renders, such as `model` or a confined directory, and a `writes` template cannot read it, as they cannot read `outcome`.

A command step that exits 65 (`EX_DATAERR`) fails `input_rejected`: it rejected the input it was given. teamai offers no retry for it, since the same input fails the same way. Any other non-zero status fails `command_failed`, whose message names the status and starts with the command's stderr:

```yaml fragment
  - id: test
    command: npm test
    continue_on_failure: true
  - id: report
    needs: [test]
    if: steps.test.failure.code == 'command_failed'
    command: 'echo "Tests failed: $WHY" >&2'
    env: { WHY: "{{ steps.test.failure.message }}" }
```

When `npm test` exits 1 and prints `2 tests failed`, `report` prints `Tests failed: command exited with status 1: 2 tests failed`.

## The end reached first wins

Reports can reach two ends before the driver calls `next` again. `next` then applies the end that was reached first, whatever order the steps have in the file.

- A step that a driver reports reaches its end at the revision of that report.
- A step with only `id`, `needs`, `if`, and `end` reaches its end when the last step it needs or reads settled.
- On a tie, the step declared first wins.

```yaml
schemaVersion: v1alpha1
name: race
description: Try two fixes at once and keep the first that works.
ends: { patched: succeeded, rewritten: succeeded }
steps:
  - id: patch
    command: ./scripts/patch.sh
    end: patched
  - id: rewrite
    needs: []
    command: ./scripts/rewrite.sh
    end: rewritten
```

If `rewrite` reports success and then `patch` reports success, the next `next` answers `{"data":{"done":{"run":"ra0ca39d4","outcome":"succeeded","end":"rewritten"},"cancelled":[]}}`. The time at which the driver calls `next` does not change the winner. A report after the winning end returns `lease_cancelled`, even if `next` has not run yet. It does not advance the revision, change workflow outputs, or start another loop pass. Skips and failures that need no driver take the revision that caused them, so they can reach an earlier end too.

## Loop back to an earlier step

A step with `loop` runs again after it succeeds, together with the steps before it up to `back_to`. Those steps are the loop's range: `back_to`, the step that has the loop, and every step between them. A step is between them when it needs `back_to` and the looping step needs it, directly or through their needs.

```yaml
schemaVersion: v1alpha1
name: loop-review-and-fix
description: Review the branch and fix what the review finds, up to three times.
outputs:
  reviews: steps.review.passes
steps:
  - id: review
    prompt: Review the changes on this branch.
    output:
      verdict: pass | fix
      findings: [string]
  - id: fix
    needs: [review]
    if: steps.review.outputs.verdict == 'fix'
    command: ./scripts/fix.sh
    env:
      FINDINGS: "{{ steps.review.outputs.findings }}"
    loop: { back_to: review, max_iterations: 3 }
```

`loop` has these fields:

- `back_to` is the first step of the range. It is the looping step itself or a step it needs, directly or through its needs.
- `max_iterations` is the most times the looping step runs, a whole number from 1.
- `while` is optional. It is an expression, evaluated each time the looping step succeeds.

When the looping step succeeds and `while` is false, the loop ends. Otherwise the range runs again from `back_to`. The loop also ends when the looping step is skipped or fails. Above, `fix` is skipped once a review passes, so the loop ends and the run succeeds.

`max_iterations` limits the looping step:

- With `while`, the step fails `loop_exhausted` when `while` is still true after its last run.
- Without `while`, the range runs once more, and the step fails `loop_exhausted` when its `if` lets it run past the limit. Above, a fourth review runs after the third fix. If it passes, `fix` is skipped and the run succeeds. Otherwise `fix` fails `loop_exhausted`.

A `loop_exhausted` step keeps the outputs of its last run.

A step outside the range that needs or reads a step inside it waits until the loop ends. It is not skipped or run before. Here `done` needs only `e2e`, and it still waits for the `fix` loop:

```yaml
schemaVersion: v1alpha1
name: loop-implement-task
description: Implement a task, then fix it until the end-to-end tests pass, up to three times.
ends: { done: succeeded, stuck: failed }
steps:
  - id: implement
    command: ./scripts/implement.sh
  - id: e2e
    needs: [implement]
    command: npm run test:e2e
  - id: fix
    needs: [e2e]
    if: steps.e2e.outcome == 'failed'
    command: ./scripts/fix-e2e.sh
    loop: { back_to: e2e, max_iterations: 3 }
  - id: done
    needs: [e2e]
    if: steps.e2e.outcome == 'success'
    end: done
  - id: give-up
    needs: [fix]
    if: steps.fix.outcome == 'failed'
    end: stuck
```

With `--driver local`, when `e2e` passes after one fix, the run ends:

```text
{"data":{"done":{"run":"re4b12bbc","outcome":"succeeded","end":"done"},"cancelled":[]}}
```

When `e2e` still fails after three fixes, `fix` fails `loop_exhausted` instead of running a fourth time, and `give-up` reaches `stuck`:

```text
{"data":{"done":{"run":"r3319969c","outcome":"failed","end":"stuck"},"cancelled":[]}}
```

A loop inside a copy keeps every commit it made there, even when its last pass is skipped. Each item below implements a task and fixes it on the item's branch. `open-pr` starts from both items with their fixes:

```yaml
schemaVersion: v1alpha1
name: loop-fix-each-task
description: Implement each task on its own branch, fix it until its tests pass, then join the tasks.
inputs:
  tasks: [{ id: string, title: string, after: [string] }]
steps:
  - id: tasks
    for_each:
      items: inputs.tasks
    workspace: new
    workflow:
      steps:
        - id: implement
          prompt: "Implement {{ item.title }}."
        - id: test
          needs: [implement]
          command: npm test
        - id: fix
          needs: [test]
          if: steps.test.outcome == 'failed'
          prompt: Make npm test pass.
          loop: { back_to: test, max_iterations: 3 }
  - id: open-pr
    needs: [tasks]
    workspace: new
    deliver: pr
    command: npm run build
```

```sh
teamai workflow start loop-fix-each-task --driver local --inputs '{"tasks":[{"id":"api","title":"the /orders endpoint","after":[]},{"id":"ui","title":"the orders page","after":["api"]}]}'
```

When the first test of `api` fails, the run goes like this:

```text
tasks[0].implement   teamai/<run>/tasks-0/p1   writes 1a2b3c4
tasks[0].test        reads 1a2b3c4             fails
tasks[0].fix         teamai/<run>/tasks-0/p1   writes 5d6e7f8
tasks[0].test        reads 5d6e7f8             passes, so fix is skipped and the loop ends
tasks[1].implement   teamai/<run>/tasks-1/p1   starts from 5d6e7f8, the fixed api
open-pr              teamai/<run>/open-pr/p1   starts from 5d6e7f8 and merges tasks-1
```

`implement` and `fix` set no `workspace`, so they continue the item's branch, and `test` reads that same branch.

### Read every pass

Each run of a step is a pass, numbered from 1. A lease carries its `pass`. In a run of `loop-implement-task`, the second lease of `e2e` is:

```text
{"data":{"lease":{"run":"rd50c3422","step":"e2e","attempt":"a54df2231","revision":4,"pass":2,"command":"npm run test:e2e"},"cancelled":[]}}
```

`steps.<id>.outcome`, `steps.<id>.end`, and `steps.<id>.outputs` read the latest pass. `steps.<id>.passes` lists every pass of the step, the current one included once it has settled. Each element has `pass` and `outcome`, and `outputs`, `end` and `pr` when that pass has them. A pass of a `for_each` step has `results` instead of `outputs`, including in a previous-pass read. In `loop-review-and-fix`, the workflow output `reviews` returns every review.

A step can read a later step of its own range, one that needs it directly or through its needs. That read gets the later step's previous pass, `null` on pass 1, and does not wait for it. In that read, `passes` lists only the earlier passes. Here `plan` reads the note of the last decision:

```yaml
schemaVersion: v1alpha1
name: loop-plan-change
description: Plan a change, and plan again while the review asks for a revision.
inputs: { issue: number }
ends: { planned: succeeded, dropped: succeeded }
steps:
  - id: plan
    prompt: "Plan a fix for issue #{{ inputs.issue }}. Address this note on the last plan, if there is one: {{ steps.decide.outputs.note }}"
    output:
      summary: string
  - id: decide
    needs: [plan]
    prompt: "Decide whether to build, revise, or drop this plan: {{ steps.plan.outputs.summary }}"
    output:
      verdict: build | revise | drop
      note: string
    loop: { back_to: plan, while: "steps.decide.outputs.verdict == 'revise'", max_iterations: 3 }
  - id: build
    needs: [decide]
    if: steps.decide.outputs.verdict == 'build'
    end: planned
  - id: drop
    needs: [decide]
    if: steps.decide.outputs.verdict == 'drop'
    end: dropped
```

On pass 1, `{{ steps.decide.outputs.note }}` is empty text. On pass 2, it is the note that `decide` returned on pass 1.

### Loops that pull rejects

`teamai pull` rejects a step loop when:

- `back_to` is not the looping step or a step it needs, directly or through its needs
- the looping step also has `end`
- its range shares a step with the range of another loop in the same workflow
- its workflow has a `loop` of its own
- a step in its range has `break`
- loops wait for each other in a cycle, through the steps that need or read a step inside a loop

Then the file has nothing to run, even when an older version was valid. Loops nest only through a sub-workflow, in a file or inline. For example, a second loop on `e2e` in `loop-implement-task` shares `e2e` with the `fix` loop:

```yaml
  - id: e2e
    needs: [implement]
    command: npm run test:e2e
    loop: { back_to: implement, max_iterations: 2 }
```

`teamai pull` reports:

```text
⚠ [workflows] workflows/loop-implement-task.yaml:16: field "steps[2].loop": step "fix" loop runs "e2e" again, which the loop of step "e2e" also runs; loops in one workflow share no step, so put the inner one in a sub-workflow
⚠ [workflows] workflows/loop-implement-task.yaml has no runnable version
```

## Run a whole workflow again, and stop it with `break`

A workflow with `loop` runs all of its steps again, round after round. Its `loop` has `max_iterations`, the most rounds, and an optional `while`. It has no `back_to`. An inline workflow can have `loop` too.

```yaml
schemaVersion: v1alpha1
name: loop-wait-for-ci
description: Check CI every minute until it passes or fails, for at most 30 minutes.
ends: { red: failed }
loop: { max_iterations: 30 }
steps:
  - id: check
    command: ./scripts/ci-state.sh
    output:
      state: pending | passed | failed
    break: steps.check.outputs.state == 'passed'
  - id: red
    needs: [check]
    if: steps.check.outputs.state == 'failed'
    end: red
  - id: wait
    needs: [check]
    if: steps.check.outputs.state == 'pending'
    command: sleep 60
```

A step with `break` evaluates it when the step succeeds. When it is true, the step's workflow ends as success, and its loop stops. Like an end, it skips the steps that have not run and cancels the open leases. A `break` and an end compete by the order of [The end reached first wins](#the-end-reached-first-wins). A `break` works in a workflow without `loop` too.

Each round runs until it reaches an end or a `break`, or has nothing left to run:

- An end stops the loop, and the workflow takes that end's outcome. Above, `red` stops it as `failed`.
- A `break` stops the loop as success. Above, `wait` is skipped in that round.
- Otherwise teamai evaluates `while`. When it is false, the workflow ends with the outcome and outputs of that round. When it is true, or there is no `while`, every step runs again in the next round.
- After `max_iterations` rounds, the workflow fails `loop_exhausted` instead of running another round.

A failed step alone does not stop the loop. The next round runs, and the workflow ends with the outcome of its last round. To retry a flaky step, write `loop: { while: "steps.e2e.outcome == 'failed'", max_iterations: 3 }`.

A workflow loop without `while` succeeds only through an end or a `break`. Running out of rounds fails it with `loop_exhausted`.

Each round is a new pass of every step, so `steps.<id>.passes` lists the earlier rounds. A `while` reads only the inputs and the steps of its own workflow.

Three runs of `loop-wait-for-ci` with `--driver local` end like this:

| CI states | Answer |
| --- | --- |
| `pending`, `pending`, `passed` | `{"data":{"done":{"run":"re0ac0c1e","outcome":"succeeded"},"cancelled":[]}}` |
| `pending`, `failed` | `{"data":{"done":{"run":"r7d3d9b06","outcome":"failed","end":"red"},"cancelled":[]}}` |
| `pending` 30 times | `{"data":{"done":{"run":"r7ac9a988","outcome":"failed","failure":{"code":"loop_exhausted","message":"Loop of workflow \"loop-wait-for-ci\" is exhausted: it ran 30 rounds, its max_iterations"}},"cancelled":[]}}` |

`done` carries `failure` when a run fails for a reason that no end names, such as a top-level `loop_exhausted`. A step that runs a looping workflow fails `loop_exhausted` the same way, and keeps the outputs of the last round.

A workflow with `loop` cannot contain a step with `loop`. Put one of the two loops in a sub-workflow.

## Finally steps

```yaml
schemaVersion: v1alpha1
name: nightly-e2e
description: Run the end-to-end suite, then always summarize it.
timeout: 1h
steps:
  - id: e2e
    command: npm run e2e
finally:
  - id: summary
    command: node scripts/e2e-summary.js
    output: { text: string }
outputs: { summary: steps.summary.outputs.text }
```

`finally` steps run once the run's steps have ended, however they ended: succeeded, failed, timed out or cancelled. They are commands, read-only, with no workspace of their own, and carry only `id`, `needs`, `if`, `command`, `env`, `output` and `timeout`. The run stays `running` while they run, for at most 10 minutes, then ends with the outcome its steps reached: a failed `finally` step never changes it. `done.finally` lists each one that failed or was cancelled, with its failure. `workflow cancel` during them ends them and the run. A workflow with `finally` runs only as a run of its own, never as another workflow's step.

`done.outputs` holds the workflow's top-level `outputs`, resolved after `finally`, so they may read `finally` steps. An output whose step failed is left out.

```text
teamai workflow start nightly-e2e --driver local --timeout 30m
```

`--timeout` bounds the run to the shorter of it and the file's `timeout`, with `--driver local` or `--driver skill`. Past it, the run fails `timeout`, and its `finally` steps still run.

## Give an input a default

```yaml
schemaVersion: v1alpha1
name: check-package
description: Lint a package, and test it unless told not to.
inputs: { package: string, test: boolean, reporters: [string] }
defaults:
  inputs: { test: true, reporters: [] }
steps:
  - id: lint
    command: 'echo "lint $PACKAGE" >&2'
    env: { PACKAGE: "{{ inputs.package }}" }
  - id: test
    needs: [lint]
    if: inputs.test
    command: 'echo "test $PACKAGE, reporters $REPORTERS" >&2'
    env: { PACKAGE: "{{ inputs.package }}", REPORTERS: "{{ inputs.reporters }}" }
```

```text
$ teamai workflow start check-package --driver local --inputs '{"package":"api"}'
{"data":{"done":{"run":"rfe89fff7a148ec61","outcome":"succeeded","progress":[{"step":"lint","lines":["lint api"]},{"step":"test","lines":["test api, reporters []"]}]},"cancelled":[]}}
```

A start with only `{"test":false}` leaves out `package`, which has no default, so no run starts:

```text
{"error":{"code":"invalid_inputs","message":"inputs.package is missing"}}
```

`defaults.inputs` gives an input the value a start, or a step's `with`, uses when it leaves that input out. Each value must fit the type the input declares, and name an input the file declares; pull rejects the file otherwise. An input with no default is still required. The run records the value it used, so `steps.<id>.inputs` and the dashboard show the default.

A workflow other teams run can take a new input this way without breaking them: a step that runs it keeps its `with` as it is.

```yaml
schemaVersion: v1alpha1
name: release-web
description: Check the web package, then publish it.
steps:
  - id: check
    workflow: check-package
    with: { package: web }          # test: true, reporters: []
  - id: publish
    needs: [check]
    command: npm publish -w web
```

## Run a workflow a step printed

```yaml
schemaVersion: v1alpha1
name: shard-tests
description: Plan one test job per changed package, then run them.
steps:
  - id: plan
    command: node scripts/plan-shards.js
    output: { definition: workflow, notes: json }
  - id: shards
    needs: [plan]
    workflow: { from: plan }
```

`plan` prints its outputs as JSON, a workflow included:

```text
{"definition":{"definition":{"schemaVersion":"v1alpha1","name":"shards","description":"One job per package.","steps":[{"id":"api","command":"npm test -w api"},{"id":"web","command":"npm test -w web"}]}},"notes":{"packages":2}}
```

| Output type | Holds |
| --- | --- |
| `workflow` | A bundle: `definition`, the workflow to run, and optionally `workflows`, the named workflows it runs, `scorers`, generated scorer pins, and `teamRevision`, the team commit whose scorers it uses. |
| `json` | Any JSON value. Expressions cannot read into it; top-level `outputs` can pass it whole. |

`workflow: { from: <step> }` runs the bundle of a step it `needs`. When that step reports, teamai checks the bundle as `workflow start` checks a file, pins it, and keeps it for the run. A bundle it cannot take, one that holds a secret value, a `from` step, a `prompt_file` step or `finally` steps, fails the producing step `invalid_output` with the reason. The producing step runs once, outside any loop or `for_each`. A run with a `from` step is [isolated](#isolated-runs).

## Ask the member's AI tool for an answer

`answer` is a prompt the member's AI tool answers in one call, in the checkout read-only, with no session and no agent. A step that only needs text or a decision from a model uses it:

```yaml
schemaVersion: v1alpha1
name: classify-learning
description: Ask which kind of team knowledge a learning is.
inputs: { learning: string }
steps:
  - id: category
    answer: "Is this learning a skill, a rule or a doc? Give the category and one sentence why. {{ inputs.learning }}"
    output: { category: skill | rule | doc, reason: string }
    timeout: 60s
outputs: { category: steps.category.outputs.category }
```

```text
$ teamai workflow start classify-learning --driver local --inputs '{"learning":"Retry 429 responses with backoff."}'
{"data":{"done":{"run":"r3f9a1c2b","outcome":"succeeded","outputs":{"category":"rule"}},"cancelled":[]}}
```

- `output` is required. `{ text: string }` takes the reply as text. Any other output names the JSON the reply holds, and the local driver asks the tool for it.
- The step names no tool: the driver that runs it answers it. The skill driver gives it to a child agent of the session, and a driver of your own answers it with its own model. The local driver launches the tool teamai's own AI calls use: `TEAMAI_AI_TOOL`, then the project's `ai.tool`, then the machine's, then the first installed tool teamai launches. Pull rejects `tool`, `agent`, `model` and `session` on the step, and any `workspace` but `new`.
- The launch is marked as teamai's own, so the member's hooks do not capture it.
- It reserves the checkout until it finishes, so answers and commands using that checkout run one at a time, even
  across `for_each` items. A change to the checkout fails the answer `read_only_dirty`.
- With `workspace: new` it answers in a worktree of its own at the commit the run started from, so the items of a
  `for_each` run side by side, up to its `max_parallel`. That worktree lacks your uncommitted changes and the files a pull delivers to your tools. A change to it
  fails the answer `read_only_dirty`. teamai removes the worktree once the answer succeeds, and its branch once the run does.
- In a directory that is no git repository, nothing can check an answer, so on the local driver answers there do
  not wait for each other, with or without `workspace: new`.
- A prompt has no default timeout. Give the step one.
- It fails `tool_unavailable` when no tool is installed, `tool_unconfigured` when the tool the member names cannot run, `tool_failed` when the call fails, and `invalid_output` when the reply holds no JSON.

Another driver gets an answer step as a prompt lease with `answer: true` and no separate workspace, or with
`workspace: new` a read-only `workspace` contract on a branch of its own. It prepares the lease, answers in `cwd`, and
reports the outputs; preparation reserves and snapshots the checkout, or that worktree, as for other read-only steps.

## Let a command write in the checkout

A command with no `workspace` runs read-only: a change it leaves in the checkout fails it `read_only_dirty`. `writes` lists the paths, relative to the checkout, where a change is kept instead:

```yaml
schemaVersion: v1alpha1
name: refresh-api-docs
description: Regenerate the API reference of one area beside the code.
inputs: { area: string }
steps:
  - id: generate
    command: npm run docs:api -- --out "docs/api/$AREA"
    env: { AREA: "{{ inputs.area }}" }
    writes: ["docs/api/{{ inputs.area }}/"]
```

A file the command writes under `docs/api/<area>/` stays in the checkout, and the step succeeds. So does a commit it adds on the branch the checkout is on, when every path the commit changes is under `writes`, as when it publishes what it wrote. A change anywhere else still fails it `read_only_dirty`, and so does any other move of HEAD: a switch, a detach, a reset.

A command that writes into a directory the caller names, which may be outside the checkout, lists the input:

```yaml
schemaVersion: v1alpha1
name: render-site
description: Render the site into the directory the caller names.
inputs: { out: string }
steps:
  - id: render
    command: npm run site:build -- --out "$OUT"
    env: { OUT: "{{ inputs.out }}" }
    writes: ["{{ inputs.out }}"]
```

`teamai workflow start render-site --inputs '{"out":"/home/alice/site"}'` renders an absolute path. Inside the checkout, a change under it is kept as under a relative path. Outside the checkout, the command writes there freely: nothing it writes there can dirty the checkout.

- Only a command step takes `writes`.
- Pull rejects an absolute path written in the file, a path that leaves the checkout, and a template that reads anything but `inputs`. A template that renders a relative path leaving the checkout, or nothing, fails the step `invalid_template` before it runs.

## Clone workspaces

```yaml
  - id: try-fix
    workspace:
      clone:
        commit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
        team: { treatment: none }
    prompt: Fix the failing test.
```

A step with `workspace: { clone: { commit, repo?, team } }` runs in a fresh clone of `commit` outside the checkout: its own git data, no remotes, hooks off. `team` names the team assets installed for it, under a home of its own: `{ treatment: none }`, or `{ revision, selection, treatment }` with `treatment` `pulled`, a ref, or `{ without: [<path>, ...] }`, and `recall: true` to deploy the team's recall, which a clone otherwise leaves off — a key [benchmarks](benchmarks.md#arms-that-run-with-recall) set on an arm, and a workflow step that measures recall may set too. `selection` holds `primaryRole`, `additionalRoles`, `projects`, `subscribedTags` and `excludedSkills` as your config names them, and `enabledAgents`, the tools the assets install for: by default the tool of the step that opens the clone, else your enabled agents. While `manifest/members.yaml` exists at `revision`, it decides your roles in the clone as it does in your checkout: a `primaryRole` or `additionalRoles` other than the ones it assigns you fails the clone with `clone_prepare_failed`. Leave them out; to run the step with a role's knowledge, also set `role` on it. teamai makes the clone offline, from the run's checkout or the commit cache; `repo` only names the cache, never a URL. A workflow step that opens a clone owns it for every `continue` step under it. Nothing in a clone is pushed or delivered. [Benchmarks](benchmarks.md) write these steps for you.

### Run a step as a team role

A prompt step with `workspace: new` runs with its `role` in a worktree of its own. A `workflow` step that opens a copy with `role` runs every step continuing that copy with it, commands included. A code review that writes its findings beside the change, then checks them:

```yaml
schemaVersion: v1alpha1
name: review-change
description: Make a change as a reviewer, review it in the same copy, and test it there.
steps:
  - id: change
    role: review
    workspace: new
    workflow:
      steps:
        - id: build
          workspace: continue
          prompt: Make the change the issue asks for.
        - id: review
          needs: [build]
          workspace: continue
          prompt: Review the change and write what must be fixed in REVIEW.md.
        - id: test
          needs: [review]
          workspace: continue
          command: npm test
```

`teamai workflow start review-change --driver local` runs `build`, `review` and `test` with `review`. Before each step teamai records the role the copy runs with in `checkout-roles.json` in your data directory, and the copy's own pull delivers for it. The copy gets the role's skills, rules, agents, docs, wiki and learnings, with your projects; your tags and skill exclusions do not filter it. It keeps your hooks, MCP servers, env and models. A `teamai pull` or a hook run in the copy keeps the role, the session the step launches there runs no pull of its own, and `teamai recall` there reads an index of the copy's own. Your checkout and your config do not change, and the step's commit holds none of what the pull delivered. Your recall still answers with your roles' knowledge: the copy's pull may move the team repo your index was built from, so it drops that index, and your next `teamai recall` rebuilds it.

`role` goes on a prompt step that opens or continues a copy, on a `workflow` step for the steps inside it, or in `defaults`; [Run a step as a team role](workflow.md#run-a-step-as-a-team-role) has the precedence. Pull refuses, as `bad_role`, a `role` on a command step, on a prompt step that runs in no copy, on a step continuing a copy with a role other than the copy's, and a `role` or `defaults.role` no step in a copy takes. A step fails `role_unavailable`, and says why, when no project install of teamai governs the checkout, when `manifest/roles.yaml` is missing, cannot be read or does not declare the role, when the step's tool would take its knowledge from outside the copy, or when the copy's pull did not deliver for the role, for example because another pull held the team's lock. Retry the step once the cause is fixed. The copy's pull gives the role's knowledge to no other place outside the copy, for any tool you enable: a tool such as Hermes, which takes skills from your home, gets none of the role's. Only a driver that declares [`can.role`](#requirements-and-limits) and asks `next --prepare` takes the step, so that teamai delivers the role. The run records `agent.team.selection.stepRole` from what teamai delivered, never from what a driver reports.

A `for_each` step can run each item with its own role: `role: "{{ item.role }}"`. A review that sends the UI change to the frontend reviewers and the API change to the code reviewers:

```yaml
schemaVersion: v1alpha1
name: review-parts
description: Review each part of the change as the role that knows it.
inputs:
  parts: [{ path: string, role: string }]
steps:
  - id: review
    for_each: inputs.parts
    role: "{{ item.role }}"
    workspace: new
    prompt: Review the change to {{ item.path }} and write what must be fixed in REVIEW.md.
```

```sh
teamai workflow start review-parts --driver local --inputs '{"parts":[{"path":"web/","role":"frontend"},{"path":"api/","role":"review"}]}'
```

`review[0]` runs in a copy of its own with what `frontend` delivers, and `review[1]` in another with what `review` delivers. Each item's step in the run file records the role it ran with:

```json
{ "id": "review[0]", "status": "succeeded", "agent": { "team": { "selection": { "stepRole": "frontend", … } }, … } }
{ "id": "review[1]", "status": "succeeded", "agent": { "team": { "selection": { "stepRole": "review", … } }, … } }
```

A role template reads only the item, and only where an item is bound. Pull checks it as a template; each item's lease checks what it gives. An item whose template gives no string, such as a number or a missing `role`, fails `role_unavailable` before its tool launches, and so does a role that `manifest/roles.yaml` does not declare. A step that continues the item's copy with another role fails `role_unavailable` at its lease, and a step that resumes a session, `session.from` or a `session: continue` a loop brings back, across two roles fails `bad_session`.

### Run a clone as a team role

A clone step can run with a role from `manifest/roles.yaml` other than yours, such as a review step that should know what reviewers know:

```yaml
  - id: review
    role: review
    workspace:
      clone:
        commit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
        team: { revision: 9b1d4e7a2c5f8b0d3e6a9c2f5b8d1e4a7c0f3b6d, selection: { additionalRoles: [], projects: [], excludedSkills: [] }, treatment: pulled }
    workflow:
      steps:
        - id: look
          workspace: continue
          tool: claude
          prompt: Review the change and list what must be fixed.
```

Start it as any workflow, `teamai workflow start review`. Every step that continues the clone runs with its role. The clone's install gets the knowledge of `review` and of your projects: skills, rules, agents, docs, wiki and learnings. It keeps what you may run: your roles' hooks, MCP servers, env and models, and the workflows, prompts, scorers and benchmarks you can find. A `teamai pull` or a hook run inside the clone keeps the role, and your own config and checkout are not changed.

The run records it: each step in the clone has `agent.team.selection.stepRole: review` beside your `primaryRole`, and the scorer results group such a step under `review`. In a clone, `role` goes on the step whose workspace is `{ clone: … }`, and that clone must install a team. Pull refuses a role on a step that continues the clone other than the clone's, as `bad_role`. The clone's role is checked against `manifest/roles.yaml` at the clone's team revision, not the one you pulled, so a clone pinned before a role was renamed can still run with the old name. When that revision does not declare the role, or the role cannot be delivered into the clone, the step fails `role_unavailable` and says why. For example, `sharing.docs.localDir` may put the docs outside the clone, where every checkout reads them. The step's commit holds only its own edits, and none of what the install delivered. Only a driver that declares [`can.role`](#requirements-and-limits) takes the step, such as `local`. The skill driver of a coding session does not: describe asks you to start such a workflow with `--driver local`, and a step it is offered anyway waits with `wait.held[].missing` naming `role`. teamai before 0.29.0 drops a workflow with a step `role` or `defaults.role`, and `teamai review --branch` warns about it.

### Isolated runs

A run is isolated when one of its steps opens a clone or runs `workflow: { from }`. It runs only on the machine that started it: `workflow publish` and `--claim` refuse it with `isolated_run`, and `workflow retry` refuses it and names the command that starts a new run. Its record carries `isolated: true`, still reaches `teamai-reports` with usage reporting on, and counts in no workflow total.

### Private workflows

`private: true` keeps what a workflow's steps do on the machine that runs them, also when the workflow runs as another's step. It applies to the workflow's own steps and to the steps of the workflows they run, never to the step that runs it or to anything around that step.

```yaml
schemaVersion: v1alpha1
name: triage-notes
description: Read the incident notes here, and return only a severity.
private: true
inputs:
  notes: string
outputs:
  severity: steps.read.outputs.severity
steps:
  - id: read
    prompt: "Read the incident notes in {{ inputs.notes }} and rate the incident's severity."
    output:
      severity: low | high
      reasoning: string
```

```yaml
schemaVersion: v1alpha1
name: incident
description: Rate an incident from its private notes, then open an issue.
inputs:
  notes: string
steps:
  - id: rate
    workflow: triage-notes
    with:
      notes: "{{ inputs.notes }}"
  - id: open
    needs: [rate]
    command: gh issue create --title "Incident" --label "severity:$SEVERITY" --body "See the incident channel."
    env:
      SEVERITY: "{{ steps.rate.outputs.severity }}"
```

The session of a private step is never archived to `teamai-reports`, and a published run carries none of its outputs: `rate` publishes the `severity` that `triage-notes` declares, and `reasoning` stays here. While a private step is open, `workflow publish` and `--claim` refuse the run with `private_open`; once it settled, both work. A run started from a private workflow publishes no run record, so it counts in no workflow total and stays off the Workflow Runs page. It runs only on the machine that started it: `workflow publish` and `--claim` refuse it with `isolated_run`.

## Expression reference

An `if` is an expression. The rules for which steps it can read, and for what counts as true, are in [Workflows](workflow.md).

```yaml
schemaVersion: v1alpha1
name: review-files
description: Review the changed files, then fix the ones with findings.
steps:
  - id: review
    prompt: List each changed file and how many findings it has.
    output:
      files: [{ path: string, findings: number }]
  - id: fix
    needs: [review]
    if: any(steps.review.outputs.files, .findings > 0)
    prompt: "Fix the findings in {{ steps.review.outputs.files[0].path }} first."
  - id: label
    needs: [review]
    if: length(filter(steps.review.outputs.files, .findings >= 10)) > 2
    command: gh pr edit --add-label large-change
```

### Values

| Value | Example |
| --- | --- |
| An input | `inputs.issue`, `inputs.issue.labels` |
| A step's outcome, end, or output | `steps.check.outcome`, `steps.check.end`, `steps.review.outputs.files` |
| Why a step failed, or `null` | `steps.summary.failure.code`, `steps.summary.failure.message`. See [Fall back on some failures only](#fall-back-on-some-failures-only). |
| Every pass of a step | `steps.review.passes`, `steps.review.passes[0].outputs.verdict`. See [Read every pass](#read-every-pass). |
| The results of a `for_each` step | `steps.build.results`, `steps.build.results[0].outcome`, `steps.build.branches` |
| The pull request a step with `deliver: pr` delivered, or `null` | `steps.fix.pr`, `steps.fix.pr.url`, `steps.build.results[0].pr.url`. See [Deliver a PR](workflow.md#deliver-a-pr). |
| The item of a `for_each` instance | `item`, `item.dir` |
| The id of the run, the same in every workflow it runs | `run.id` |
| A string | `'failed'`. Use single quotes. Write a quote inside a string twice: `'it''s'`. |
| A number | `3`, `-1`, `1.5`. Write a digit before the decimal point: `0.5`, not `.5`. |
| A boolean or null | `true`, `false`, `null` |
| An empty array | `[]`. It is the only array literal. |

A missing value reads as `null`. A step that has not settled reads as `null` too.

### Indexes

`[n]` reads element `n` of an array, counting from 0: `steps.review.outputs.files[0].path`, `inputs.tags[1]`, or `steps.grid.outputs.rows[1][0]`. An index past the end, or an index into a value that is not an array, reads `null`.

An index is a whole number from 0. `[-1]`, `[01]`, and `[inputs.n]` do not parse. An index reads an array inside `inputs`, `outputs`, `passes`, `results`, `branches`, or `item`. It cannot follow a step id, `outcome`, or `end`, so `steps.build[2].outcome` does not parse.

### Operators and precedence

From the loosest binding to the tightest:

| Operators | Result |
| --- | --- |
| `\|\|` | `true` when either side is true |
| `&&` | `true` when both sides are true |
| `!` | `true` when its operand is false |
| `==`, `!=` | whether both sides are the same value, compared strictly |
| `<`, `<=`, `>`, `>=` | the comparison of two numbers |
| a value, a function call, or `( … )` | the value |

`!` binds looser than `==`. `!steps.check.outcome == 'success'` means `!(steps.check.outcome == 'success')`.

`==`, `!=`, and the comparisons do not chain. `1 < 2 < 3` and `1 == 1 == true` do not parse. Add parentheses, as in `(1 == 1) == true`.

A comparison is true only when both sides are numbers. With any other value, such as a string or `null`, it is false.

### Functions

| Call | Result |
| --- | --- |
| `length(list)` | the number of elements |
| `any(list, predicate)` | `true` when the predicate is true for at least one element. `false` for an empty list. |
| `all(list, predicate)` | `true` when the predicate is true for every element. `true` for an empty list. |
| `filter(list, predicate)` | an array of the elements for which the predicate is true |

When `list` is not an array at run time, each function returns `null`.

A predicate reads the current element with a path that starts with `.`, as in jq:

- `.` is the element itself.
- `.findings` is a field of the element.
- `.files[0]` and `.[0]` read by index.

Inside a nested call, `.` is the element of the innermost call. A predicate can also read `inputs` and `steps`. A path that starts with `.` does not parse outside a predicate.

Any other function name does not parse: `"contains" is not a function; the functions are length, any, all and filter`. A call with the wrong number of arguments does not parse either: `any is called as any(list, predicate)`.

### Type checks at pull

`teamai pull` checks the types in each `if`. It knows the type of a literal, of each operator and function result, and of every path the workflow declares in `inputs` or `output`. Each of these makes the file invalid:

- A comparison with a side that is not a number. Such a side is a string, a boolean, `null`, a condition, an `any`, `all`, or `filter` call, or a path whose declared type is not `number`.
- A `list` argument that is not an array. Such an argument is a literal other than `[]`, a condition, a `length`, `any`, or `all` call, or a path whose declared type is not an array.
- A predicate that reads a field the declared item type does not have.

For example, if `review` above also declared `title: string`, this `fix` step would make the file invalid:

```yaml
  - id: fix
    needs: [review]
    if: steps.review.outputs.title > 3 || any(steps.review.outputs.files, .finding > 0) || all(steps.review.outputs.title, .done)
    prompt: Fix the findings.
```

`teamai pull` reports:

```text
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if compares steps.review.outputs.title with >, but it is not a number
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if reads .finding, which is not in an item of steps.review.outputs.files
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if passes steps.review.outputs.title to all as its list, but it is not an array
```

The outputs of a step that runs a workflow have no declared type, so pull does not check them. At run time, a comparison with a value that is not a number is false, and a function whose `list` is not an array returns `null`.

### Templates

A template reads one path, indexes included, such as `{{ steps.review.outputs.files[0].path }}` or `{{ with.refs[1] }}`. It also evaluates an expression as an `if` does, such as `{{ length(steps.build.results) }}` or `{{ steps.build.outcome == 'failed' }}`, when the expression starts with a path, after any `!` or `(`, or calls `length`, `any`, `all` or `filter` on one. An expression does not read `with`. A `with` value that is only one expression keeps its JSON type. `teamai pull` checks the expression as it checks an `if`, and says what to fix when it has a mistake in it, a misspelled function on a step such as `{{ lenght(steps.build.results) }}` included. Other text, such as `{{ filter(items) }}` in a Vue sample, stays as written.

To put a count or a filtered list into a prompt, evaluate it in the template:

```yaml
schemaVersion: v1alpha1
name: fan-build-failures
description: Build each package, then look for what the failed builds share.
inputs:
  packages: [{ id: string, dir: string }]
steps:
  - id: build
    for_each: inputs.packages
    command: npm run build --prefix "$PACKAGE_DIR"
    env:
      PACKAGE_DIR: "{{ item.dir }}"
  - id: explain
    needs: [build]
    if: steps.build.outcome == 'failed'
    prompt: "{{ length(filter(steps.build.results, .outcome == 'failed')) }} packages failed to build: {{ filter(steps.build.results, .outcome == 'failed') }}. Find what they share."
```

Pass the whole list, as `explain` does in `fan-build`, when the prompt needs every entry.


## Requirements and limits

A step says what it needs in `requires`. `defaults.requires` in a workflow file applies to each step in it. A step's own keys replace those, and `env` lists add up. The workflow file can also set `setup`, `timeout`, and `budget`, and a prompt step can set `max_turns`, `on_limit` and `permissions`.

```yaml
schemaVersion: v1alpha1
name: release
description: Build the package, then review it.
timeout: 1h
budget: { tokens: 200000 }
setup:
  command: npm ci
  requires: { env: [NPM_TOKEN] }
defaults:
  requires: { network: false }
steps:
  - id: build
    workspace: new
    timeout: 10m
    requires: { env: [SIGNING_KEY] }
    command: npm run build
  - id: review
    needs: [build]
    prompt: Review the build.
    max_turns: 5
```

| Key | What it does | A driver that cannot do it |
|---|---|---|
| `requires.env` | Gives the step these [team env](sharing.md#env-environment-variables) keys. Every other team env key, and every key another step of the run requires, is kept from it. Only key names enter the run. A key with no value on this machine fails the step `missing_env` before it runs, and the message names what gives it one: see [A required key with no value here](#a-required-key-with-no-value-here). A step `env:` entry that names a team secret or a required key fails `env_conflict`. | The step waits. |
| `requires.network` | `false` asks that the step get no network. | The step runs, and its `unenforced` lists `network`. The local driver cannot deny the network. |
| `requires.isolation` | `none`, `worktree`, or `sandbox`. A step with a workspace has at least `worktree`. | The step runs, and its `unenforced` lists `isolation`. |
| `requires.strict` | `true` makes `isolation` and `network` at this level a floor: every step under it gets at least them, whatever an inner level asks. A strict `isolation: sandbox` also keeps `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `CI_JOB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS` and `SSH_ASKPASS` from every process of the step, and pull refuses a step under it whose `requires.env` names one. With `--driver local`, a start the local driver could never run is refused `requirement_unmet`. | The step waits. A strict sandbox also needs `can.env: true`. |
| `setup` | The driver runs `command` in each workspace it creates, before the step. Setup gets its `requires.env` keys; a step gets them only if it requires them too. Setup fails the step without running it, and the workspace is removed, when it exits non-zero (`setup_failed`), changes a file git would commit (`setup_dirty`), or leaves the value of one of its keys in a file it wrote, ignored files included (`setup_secret`). The step's `timeout` bounds setup. | Steps with a workspace wait. |
| `timeout` | `500ms`, `30s`, `10m`, `2h`, or `1d`, on a step or the workflow file. A step past it is stopped and ends with outcome `timeout`. On a workflow step, it stops every step inside. On the workflow file, the run ends `failed` with `timeout`. A retry starts the timeout again. | Not a capability. Every driver gets `expiresAt` on the lease. |
| `budget` | `{ tokens: N }` on the workflow file, a workflow step, or a prompt step with `on_limit: end_turn`. Input and output tokens of every step under it count from when it starts: the run's from its start, a workflow step's from each time it starts, such as a loop's next pass. A retry starts the budget again. Once they pass `N`, its open steps stop and it fails `budget_exceeded`. | A headless prompt under a budget waits. Its success report without tokens fails `budget_unmeasured`. An interactive prompt runs, since a person drives it; when its report has no tokens, its `unenforced` lists `budget`. |
| `max_turns` | Caps the agent turns of a prompt step. The local driver passes it to headless Claude only. | The step runs, and its `unenforced` lists `max_turns`. |
| `permissions` | `unattended` on a prompt step: its tool edits files and runs commands without asking. Only under a strict `isolation: sandbox`, set on the step, a step around it, `defaults`, or the step that runs its workflow: a start without one is refused `unattended_unsandboxed`, and a [workflow a step printed](#run-a-workflow-a-step-printed) without one fails that step `invalid_output`. See [Unattended prompts](#unattended-prompts). | The step waits. A run whose only driver lacks `can.unattended` fails it `tool_unavailable`. |
| `on_limit` | `end_turn` on a prompt step with `timeout`, `max_turns` or `budget`: reaching one, counted from the tool's launch, ends the agent's turn instead of failing the step. The step succeeds with `limit` set and keeps its work, so the steps after it still run. On a workflow step with `timeout` or `budget`, those are what its prompts may spend together, one turn at a time: once spent, its pending steps are skipped. `fail`, the default, fails the step at the limit. A step handed back keeps the deadline of its first lease. | Without `can.end_turn`, the step runs under `fail`, and its `unenforced` lists `on_limit`. |

`unenforced` is on the lease, the step, and the run record. Each `interactive: true` step also needs a driver with HITL, as [HITL](#hitl-human-in-the-loop) describes.

A member can set what any driver may use on their machine, beside `max_parallel` in `~/.teamai/config.yaml` or a workspace's own `config.yaml`:

```yaml
workflows:
  max_parallel: 4
  sandbox: true
  allow:
    network: false
    env: [NPM_TOKEN]
```

- `allow.network: false` holds each step that requires `network: true`. `allow.env` holds each step whose `requires.env`, or whose setup's, names a key it does not list. `wait.held[].missing` names `policy.network` or `policy.env`. A bad `allow` in `~/.teamai/config.yaml` stops workflow commands until it is fixed, so a typo never lifts a restriction.
- `sandbox: true` says this host contains what it runs, such as a CI VM or a container, so the local driver declares `sandbox` isolation. A step with [`permissions: unattended`](#unattended-prompts) then runs its tool without asking, in whatever workspace the step uses, your own checkout included. `teamai workflow start` and `resume` take `--sandbox` to declare it for one process.
- `max_parallel` also caps how many leases of one run every driver on this machine holds at once.

`allow.network` filters declared step requests. Setup declares only environment keys in v1 and receives no network restriction from that setting. To guarantee that setup and steps cannot reach the network, use a driver and host that enforce it for every process.

The value of each key declared in `env/secrets.yaml`, including one this machine takes from the environment as a CI job does, and of each environment variable whose name looks like a secret, is masked as `<REDACTED:KEY>` in the run file, the run records, every `teamai workflow` output, and the `result.json` the local and skill drivers keep for each attempt. `start` refuses inputs that hold one with `invalid_inputs`, naming the key and never the value. To mask a value whose name does not look secret, such as `DATABASE_URL`, declare its key in `env/secrets.yaml`.

A driver other than `local` declares what it can do in `driver.can` on each `next`:

| `driver.can` key | The driver |
|---|---|
| `hitl` | Lets a person answer HITL requests and work in interactive steps. |
| `workspace` | Takes leases in these workspace modes: `read-only`, `new`, `continue`, `clone`, `team` (a step in [the team workspace](workflow.md#the-team-workspace), such as `teamai-score`'s `publish`). A clone step is leased only through [`next --prepare`](#clone-workspaces-in-your-own-driver). |
| `env` | `true`: resolves `lease.envScope.provide` itself, removes `lease.envScope.withhold`, and keeps the values from what runs the step. `"commands"`: does that for command steps and setup only, so a prompt step with `requires.env` waits. A driver whose agent runs the step leaves it out, or sends `"commands"` when it starts the commands itself. teamai before 0.28.0 answers `"commands"` with `invalid_json`. |
| `setup` | Runs `lease.setup.command`, with `lease.setup.envScope`, in each workspace it creates and in one whose setup never finished, and fails the step with the codes above. Every lease with a workspace carries `setup` when the workflow declares it. |
| `tokens` | Reports the tokens of every successful headless prompt step. |
| `max_turns` | Passes `lease.maxTurns` to the tools it can cap, and reports `"unenforced":["max_turns"]` for the others. |
| `network` | Can deny a step the network. |
| `isolation` | Keeps every step at this level: `none`, `worktree`, or `sandbox`. |
| `tools` | Launches a prompt step that names its `tool` on these tools, such as `["claude"]`. Without it, no such step. |
| `end_turn` | Ends a prompt's turn at `lease.limits` and reports the `limit` it stopped at, with `durationMs`. |
| `unattended` | Launches a prompt leased with `permissions: "unattended"` in its tool's own mode for editing and running commands without asking, and fails the step rather than launch a tool that has none. |
| `role` | Takes a step that [runs as a team role](#run-a-step-as-a-team-role), leased with `role` through `--prepare`, and runs it in the clone or worktree copy teamai delivered that role into. |
| `confined` | Takes [prompt steps confined to a directory](workflow.md#a-prompt-confined-to-a-directory): a list of offers, each `{ "level", "access", "tools" }`, the tools it launches confined at `level` (`verified` or `best-effort`) with `access` (`read` or `full`), in the order it tries them. See [Confined steps in your own driver](#confined-steps-in-your-own-driver). |

An omitted key means the driver cannot. Isolation is best effort, unless `strict: true` makes it a floor. `next` lists any other key in `ignored`. The skill driver of a [coding session](workflow.md#run-from-a-coding-session) declares `hitl`, every `workspace` mode, `env: "commands"`, and `setup`. It never declares `tokens`, `max_turns`, `network`, `unattended`, or `role`, and its `isolation` is `none`: a coding session never bypasses its person's permissions. It declares `confined` only while it judges the run: the session's tool at `verified` when this machine has its confined judge, else that tool at `best-effort`, for a fresh subagent.

### Unattended prompts

A tool started headless asks before it edits a file or runs a command, and with no one there to answer, the step does nothing. `permissions: unattended` lets the prompt's tool go ahead, so give it only where the machine is one you can throw away:

```yaml
schemaVersion: v1alpha1
name: unattended-fix
description: Fix a failing test on a disposable machine.
steps:
  - id: work
    prompt: Fix the failing test.
    permissions: unattended
    requires: { isolation: sandbox, strict: true }
```

The local driver then launches the tool in its own mode for that:

| Tool | Launched with |
|---|---|
| Claude Code, and the tools on its flags | `--permission-mode bypassPermissions` |
| CodeBuddy, WorkBuddy | `--permission-mode bypassPermissions` |
| Codex CLI, and the tools on its flags | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `--auto`, which still keeps what a permission rule denies |
| agy | `--dangerously-skip-permissions` |

A tool teamai knows no such mode of fails the step `tool_unavailable`, and is never launched without it. The `Unattended prompts` column of [Tool support](tool-support.md) says which tools have one, and on what evidence. The lease carries `permissions: "unattended"`, so a driver of your own sees it; only one with `can.unattended` takes the step.

### A required key with no value here

The `sign` step needs a signing key that nobody on the team has declared yet:

```yaml
schemaVersion: v1alpha1
name: sign-release
description: Build the release, then sign it.
steps:
  - id: build
    command: npm run build
  - id: sign
    needs: [build]
    requires: { env: [SIGNING_KEY] }
    command: npm run sign
```

On a machine without `SIGNING_KEY`, `sign` fails before it runs:

```text
$ teamai workflow start sign-release --driver local
ℹ Run r55b0e3a6017968bf started. If it stops before it ends, continue it with: teamai workflow resume r55b0e3a6017968bf
{"data":{"done":{"run":"r55b0e3a6017968bf","outcome":"failed","record":"published"},"cancelled":[]}}
✖ Step "sign" failed with missing_env: Step "sign" requires env SIGNING_KEY, which has no value on this machine. Set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY, then retry the step.
ℹ Retry it with teamai workflow retry r55b0e3a6017968bf sign, then continue the run with teamai workflow resume r55b0e3a6017968bf
```

Declare it, set your own value, and finish the run. `build` does not run again:

```text
$ teamai env add SIGNING_KEY --secret -d "Release signing key"
✔ Up to date
✔ Declared secret: SIGNING_KEY
ℹ Run `teamai push` to sync to team repo.
$ teamai env set SIGNING_KEY
Value for SIGNING_KEY:
✔ Set SIGNING_KEY for this team (~/.teamai/secrets/teams/<team>.json).
$ teamai workflow retry r55b0e3a6017968bf sign
{"data":{"retried":{"step":"sign","pass":2},"reopened":true,"run":{"id":"r55b0e3a6017968bf","status":"running","revision":3},"resume":"teamai workflow resume r55b0e3a6017968bf"}}
$ teamai workflow resume r55b0e3a6017968bf
{"data":{"done":{"run":"r55b0e3a6017968bf","outcome":"succeeded","record":"published"},"cancelled":[]}}
```

The run here does not wait for `teamai push`. Push so teammates get the declaration, and with it the shorter advice below.

| Situation | What the failed step says | What to run |
|---|---|---|
| The team declares the key, and you have not set it on this machine | `Run teamai env set SIGNING_KEY, or set it in the environment, then retry the step.` | `teamai env set SIGNING_KEY`, then retry and resume |
| The value lives in a password manager, and should not be stored by teamai | either message | retry, then `SIGNING_KEY="$(op read op://release/signing-key/password)" teamai workflow resume <run>` |
| A CI job takes the run | either message, in the job log | export the key in the job's `env`, as [the CI job](workflow.md#take-offered-runs-from-ci) does |
| A step needs two keys, and the team declares only one | one clause per key, joined with `;`, such as `Run teamai env set NPM_TOKEN, or set it in the environment; set SIGNING_KEY in the environment, or declare it …` | each key's own fix |

## HITL (human in the loop)

HITL covers `approve`, `choose`, and `interactive` steps where a person takes part.

`approve: <message>` asks before an action. `yes` runs it; `no` skips it. An action-less approve also works. `choose: { message, options, default? }` records a choice without running an action. Options are unique, non-empty strings without whitespace. A choose step cannot carry an action or `required`. Neither HITL request can carry `for_each`; put it on a step the fan-out needs. Messages use the same templates and readiness rules as prompts.

```yaml
schemaVersion: v1alpha1
name: hitl-build
description: Choose a path and approve the work.
steps:
  - id: decide
    choose:
      message: Build or stop?
      options: [build, stop]
      default: build
  - id: build
    needs: [decide]
    if: steps.decide.choice == 'build'
    approve: Build it?
    command: npm run build
  - id: pair
    needs: [build]
    if: steps.build.outcome == 'failed'
    interactive: true
    prompt: Fix the build with me.
```

Later steps read `steps.decide.choice` and `steps.decide.note`, also through `passes[n]`. A new pass asks again. An approve HITL request on an end-only step must receive `yes` before that end is reached.

For an approval that must come directly from a person, use `approve: { message: Publish?, required: true }`. Required approvals never use automatic answers. `respond` records the answer time, channel, choice, and optional note. With `--json`, its channel is `driver`. Without `--json`, TTY stdin records `tty`; otherwise it records `cli`. An answer is recorded `agent: true` when it records `cli`, or when the process that sent it runs inside an agent session (an agent's session variable such as `CLAUDE_CODE_SESSION_ID` is set); otherwise `agent: false`. Inside a workflow attempt (`TEAMAI_WORKFLOW_ATTEMPT` is set), `respond` records nothing and answers `nested_workflow`. A required approval rejects `agent: true` answers with `agent_in_path`, which names the command for the person to run in their own terminal. A TTY and these variables are evidence, not protection against someone who can create a PTY or unset a variable. An answer from the [dashboard](dashboard.md#workflow-runs) records channel `dashboard`, with `agent: false` unless `teamai dashboard` runs inside an agent session.

```sh
teamai workflow respond <run> decide build --note "Ready" --pass 1
teamai workflow resume <run>
```

`--pass` rejects an answer for a HITL request replaced by a later pass. A second answer in the same pass is `repeated_response`.

Drivers other than `local` use the same HITL contract. Send `driver.can.hitl` on every `next` request, including busy polls. Set it to `true` when a person can answer HITL requests and work in interactive steps. When no lease is ready, `next` returns `hitl` with `run`, `step`, `pass`, `kind`, rendered `message`, `options`, optional `default`, and `required`, plus a `respond` command template. Show `hitl.message` and `hitl.respond` to that person, who runs `teamai workflow respond` with `<option>` replaced by a choice. The template quotes fan-out step paths such as `'items[0].ask'`; keep those quotes. The `cli` channel can answer optional HITL requests only. A driver with its own UI can submit a person's answer, including a required approval, with `respond --json '{"driver":{"kind":"ide","machine":"host","workspace":"/work"}}'`; this records channel `driver`, `agent: false`, and the driver identity locally. Sent from inside an agent session, it records `agent: true`, so a required approval refuses it. The driver declares that a person answered in its UI and must never send an answer its agent chose; like the TTY convention, this is a declaration, not protection.

A ready lease wins over a HITL request. While a tool runs, poll `next` with its attempt id in `running` and `canTakeLease: false`, show any HITL request, and stop tools whose attempt ids appear in `cancelled`. Only a driver with HITL may take `interactive` leases; an interactive step waits for one.

Without that capability, a `next` request that can take a lease applies this table. Busy polls leave waiting HITL requests unanswered and return `wait` when the driver has no HITL capability.

| HITL request | `auto_approve: true` | Default (`false`) |
|---|---|---|
| Optional approve | `yes`, channel `auto_approve` | `no`, channel `no_hitl`; skip |
| Required approve | Fail `hitl_required` | Fail `hitl_required` |
| Choose with default | Take default, channel `auto_approve` | Fail `hitl_required` |
| Choose without default | Fail `hitl_required` | Fail `hitl_required` |

The local driver with nobody at its terminal does not fail a required approval or a choice it cannot answer: the step waits, and the driver [hands the run to a person](workflow.md#when-a-run-reaches-a-person) on `teamai-reports`. It fails `hitl_required` only when the run cannot be offered, and the message says why. Other drivers without HITL apply the table as it is.

Every decision without HITL and `hitl_required` failure logs a warning to stderr. Set `workflows.auto_approve` beside `workflows.max_parallel` in local config, or pass `--auto-approve` to `start --driver local` or `resume` for that run: the run remembers it on this install, and `resume --no-auto-approve` turns it off. JSON `next` from a driver without HITL cannot set this override. A driver with HITL ignores `workflows.auto_approve`: it sends `autoApprove: true` on `next` when the person chose auto-approve for the run, and the local driver in a terminal does so with `--auto-approve`. Optional approvals and choices with a default are then answered as in the `auto_approve: true` column; required approvals and choices without a default still come back as `hitl`. The local driver declares HITL only in an attended run (see [Attended and unattended runs](workflow.md#attended-and-unattended-runs)) whose stdin and stderr are TTYs. It asks on stderr, accepts a choice followed by an optional note, and keeps polling while the question is open. An answer from elsewhere or a cancellation closes that question. Questions wait while an interactive tool owns the terminal.

`interactive: true` needs `prompt` or `prompt_file`. The step waits for a driver with HITL. Without a terminal, `--driver local` [hands the run to a person](workflow.md#when-a-run-reaches-a-person), who continues it with `resume <run> --claim` from a terminal. The local driver opens the tool here in the workspace with inherited stdio and the prompt as its first message. Repository edits by the person are kept, and the step succeeds. An interactive step that sets `workspace: read-only` is checked like a command: a checkout change fails `read_only_dirty` and the edits stay. Inside a workspace an enclosing step opened, they are kept on `refs/teamai/kept/<attempt>` and removed from the workspace. An interactive step in its own workspace can still change that workspace. Headless prompts remain read-only. Terminal Ctrl-C and Ctrl-\ go to the interactive tool; SIGTERM and SIGHUP stop it and the driver. A result file is optional when the interactive tool exits successfully without outputs. The driver polls every two seconds during prompts and stops a cancelled tool.

### Ask about each item

A choose step cannot carry `for_each`, but the inline workflow a `for_each` runs can hold one, so a person answers once per item. Each result carries the item as `item` and the answer as `outputs.choice` and `outputs.note`:

```yaml
schemaVersion: v1alpha1
name: triage-findings
description: Ask about each finding of a scan, then file the ones a person kept.
inputs:
  findings: [{ id: string, title: string, severity: string }]
steps:
  - id: review
    for_each: "filter(inputs.findings, .severity != 'info')"
    workflow:
      outputs: { choice: steps.ask.choice, note: steps.ask.note }
      steps:
        - id: ask
          choose:
            message: |-
              {{ item.title }} ({{ item.severity }}, {{ item.id }})
              file opens an issue; rename opens it with your note as its title; skip leaves it out.
            options: [file, rename, skip]
  - id: file
    needs: [review]
    command: node scripts/file-findings.js "$REVIEWED"
    env: { REVIEWED: "{{ steps.review.results }}" }
```

The local driver asks the items one after another. Without a person to answer, the run waits or fails as the table above says for a choice without a default. `teamai import --from-tools` reviews the files it found this way, in `teamai-import-learnings`.

## Retry, cancel, and resume

```sh
teamai workflow retry <run> <step>
teamai workflow cancel <run> [step]
teamai workflow resume <run>
```

A run started with `--driver local` remembers its `--tools`, `--auto-approve` and `--sandbox` on this install, so every `resume` the CLI prints works as printed:

```console
$ teamai workflow start loop-plan-change --driver local --tools default=claude --auto-approve --sandbox --inputs '{"issue":42}'
ℹ Run redf22a69e4ae6652 started. If it stops before it ends, continue it with: teamai workflow resume redf22a69e4ae6652
^C                                                   # or the terminal closed, or claude ran out of tokens

$ teamai workflow resume redf22a69e4ae6652           # claude, --auto-approve and --sandbox, as started
$ teamai workflow retry redf22a69e4ae6652 decide     # its JSON ends with "resume":"teamai workflow resume redf22a69e4ae6652"
$ teamai workflow resume redf22a69e4ae6652 --tools default=codex     # every prompt step on codex from now on
$ teamai workflow resume redf22a69e4ae6652 --no-auto-approve         # from now on, optional approvals are not answered yes
```

A flag on `resume` replaces what the run remembers, a `--tools` name at a time, and the run remembers the result for the next `resume`:

| Flag | `resume` on this install | A claim on another machine |
|---|---|---|
| `--tools default=claude` | keeps it; `--tools <name>=<tool>` replaces that name | starts without it; the listing says `pass --tools default=<tool>` |
| `--auto-approve` | keeps it; `--no-auto-approve` turns it off | starts without it |
| `--sandbox` | keeps it | starts without it; the listing and `busy` name `--sandbox`, and `--next` skips the run |

`retry` accepts a leased, failed, or cancelled step, a refused approve with an answer, or an answered choose. Retry a HITL request to change its answer; its old answer stays in pass history. It frees an old lease and starts a new pass at a new revision. The local driver stops a command it was running and starts the new pass only after that command has exited. It resets the steps that depend on or read that step, including loop waits and item `after` dependencies. When it reopens a run that ended, whose `$TEAMAI_RUN_DIR` is gone, a `workspace: { confined }` step among them also resets the steps it `needs`, and the steps those need, which write its directory, and a step among them that reads, in a template and not only in `if`, another step's output holding a path inside that directory also resets that step. When that step is in a workflow around the retried step's, the `workflow` step that holds the retried step runs again after it. `workflow retry` prints every other step it runs again. A HITL request among them that waits, or was answered and has not run, is asked again at a new pass. It reopens settled enclosing workflows, items, fan-out steps, and the run. A step whose pull request delivery failed keeps its pass, and only its delivery runs again. If the reopened run is still running, the result includes a `resume` command. Run it to continue locally, or let your driver poll `next`. Unanswered skips in each affected container are re-derived; manual cancellations outside it stay cancelled. An independent standing end or break prevents retry.

History stays in `passes` and the archive, so `length(steps.x.passes)` counts failed attempts too. Retrying a loop owner resets its iteration count. Retrying another step in its range keeps the owner's count. Retry keeps the top-level workflow's round count, so retry in its exhausted final round can fail `loop_exhausted` again.

A single-step `cancel` stops pending, waiting, leased, running, or delivering work. Its open descendants stop too. Cancelled steps count as stopped, so dependents skip unless an `if` reads their outcome for recovery. The run normally fails. A whole-run cancel ends immediately with run outcome `cancelled`, without starting another loop round. Cancel does not bump the revision. A late report returns `lease_cancelled`; `next.cancelled` tells drivers which tools to stop.

`resume` drives the run locally after a retry, response, Ctrl-C, or closed terminal. `workflow start --driver local` prints the run id on stderr when the run starts, with the `resume` command that continues it. It uses this machine's open local lease workspace first, then the workspace of the latest driver that called `next` when that driver was local on this machine, then the current directory. Resuming after a retry from a subdirectory therefore keeps the original local workspace. Only one local driver can drive a run at a time. A second resume returns `driver_running` with the owning process id; stop that driver or wait. Locks from dead processes are reclaimed automatically. A settled run returns `done`. When a local run fails, `start`, `resume` and `resume --next` print on stderr why each step failed and its `retry` and `resume` commands, as in [A required key with no value here](#a-required-key-with-no-value-here). When a limit of the whole run, its `timeout` or `budget`, stopped it, they print why the run failed instead, with the `retry` of each step the limit stopped. Failed and cancelled local runs exit 1; successful control commands exit 0 even when their answer describes a failed or cancelled run.

## Publish and claim

```sh
teamai workflow publish <run> [--sessions]
teamai workflow resume <run> [--claim]
teamai workflow resume [--next]
```

[Continue a run on another machine](workflow.md#continue-a-run-on-another-machine) shows the common case. This section covers the rules.

The first `publish` makes this install the run's owner. The owner is an install id, kept in `workflows/owner.json` under the TeamAI data directory, plus the member's TeamAI username, the one the run records carry. Two installs of one member show the same user name, and the id tells them apart. `publish` prints one envelope:

```json
{"data":{"run":"<run>","publication":"published","stateRevision":1,"offered":true,"inFlight":[{"step":"fix","attempt":"<attempt>","driverKind":"local"}]}}
```

`offered` is true while the run is running: see [Offer a run to a runner](#offer-a-run-to-a-runner).

`inFlight` lists the leases still open. A claim releases them, so those steps run again. Publishing a run that has not changed since its last publish answers `"publication":"unchanged"` with the same `stateRevision`, and writes nothing. Each publish that changes the run adds the whole state to the history of `teamai-reports`, so publish when you hand a run over, not after every step. Only the owner can publish the run. On another install, `publish` answers `not_owner` and changes nothing.

When a published run ends, through `next` or through `workflow respond`, `retry`, or `cancel`, teamai publishes how it ended, as `workflow publish` does. When that is refused, the `done` envelope of `next`, or the `data` of the command, carries `notPublished`, a refusal from the table below. `not_owner` means another install claimed the run, so its state and its run record stay as that install has them. For any other refusal, take its next step. The next `next` or `workflow resume` of the run also publishes the end again.

`resume` decides from what this machine has:

- A run this machine has and never published continues locally. `resume` does not read `teamai-reports`.
- A run whose first publish never reached `teamai-reports` continues locally too. `resume` reads `teamai-reports` to check, and answers `reports_unreachable` when it cannot.
- A run this machine does not have is claimed from `teamai-reports`, then driven.
- A published run continues only while this install owns it. Otherwise `resume` answers `not_owner` with `owner` (`id`, `user`) and `ownedAt`.
- A claim of a run that ended runs none of its steps again. The claiming install owns the run, so `workflow retry` there runs again only the step it names, the steps that depend on it, and the steps a `workspace: { confined }` step among them needs, with the steps those need.
- `--claim` takes a published run over from its owner. It replaces this machine's copy of the run. While a local driver of the run is running on this machine, it answers `driver_running` and claims nothing.

Run `resume` in a checkout of the run's business repository. A claim of a run that is still running checks with `git ls-remote` that the run's branches are on that checkout's `origin` at the commits the run recorded. It never fetches into the checkout. A run that has ended needs none of its branches, so a claim takes it even after a merge deleted them, and `resume` reports how it ended. If a retry reopens it, the next `resume` fetches the branches it needs. When this machine's workflow cache differs from the workflows the run ran, the claim reads them at the run's team commit, fetching that commit when the team repo lacks it, and prints `[team commit <commit>] Synced N workflows` on stderr. Your cache and your team repo checkout stay as they are.

The published state is `workflows/runs/<run>/state.json` on `teamai-reports`. It carries what the run needs to continue: status, inputs, each step's outcome, outputs, passes and HITL answers with their notes, the base, the commit of each workspace, and the tool and id of each session copy a step continued. The workflows themselves travel only as `sourceHash`, `definitionHash`, and `teamRevision`. It leaves out step and pass `message`, the driver identity of each lease and answer (a lease keeps its driver kind), workspace owners, and the business checkout path. Every failure message becomes `The details stay on the machine that ran this step.`, and the failure `code` stays. A commit appears only as a full id (40 or 64 hex digits). `publish` checks every value and key against TeamAI's secret patterns, this process's environment secrets, and the value of each secret the team declares in [`env/secrets.yaml`](sharing.md#env-environment-variables), whatever its name, and refuses the first match with `secret_detected`. A declared value shorter than 8 characters matches only as a whole word, and one shorter than 4 is not checked: `publish` warns and names it. The refusal names the step, the field, and the kind of secret, never the value. It refuses an absolute path of this machine the same way, with `local_path_detected`: a Windows drive or share path, a `~/` path, a `file://` URL, or a `/` path whose first directory exists at this machine's root, such as `/Users/alice/data.csv`. A URL, a relative path such as `src/main.ts`, and a route such as `/api/v1` pass. Such a run cannot be handed over. Continue it on this machine, or start it again with paths relative to the repository.

`--sessions` also puts the latest copy of each agent session the unsettled steps will continue (`session: continue` or `session.from`) in the team session archive on `teamai-reports`, scrubbed as `teamai session push --scrub` scrubs them. That includes a step a loop is about to run again and the steps of a workflow step that has not started. It never includes a settled step's session or an earlier pass's. The envelope then lists them in `sessions` as `{"tool","id"}`, an empty list when there are none. A session this machine cannot read is left out: its chain archives the newest one it can read, and `skipped` lists the newer ones it left out. A chain with none readable refuses the publish. The sessions are archived before the state is written, so a publish refused after that leaves them archived, and an unchanged publish still archives them. On the machine that continues the run, the local driver resumes a step's session in this order:

1. The session on this machine. The step's tool resumes it by id when it is the session's tool, and gets a copy of it otherwise.
2. A copy of the archived session. The copy is written once, and a later restore reuses it with the turns added to it. The driver reads the archive on `teamai-reports` as the claim synced it. A session an older teamai archived on the default branch is read as the team repo's origin has it, fetched once per driver run, so you do not run `teamai pull` first, and your team repo clone stays as it is. When that fetch fails, it reads your clone and says it may be older than origin.
3. When the session is a copy another step made, and neither of those has it, the same two ways for the session that copy continued, and so on back to the first. The step then misses the turns of the copies it could not get.
4. A new session, with a warning on stderr that starts `⚠ Step "<id>" starts a new <tool> session:` and says why each of those failed.

The step's tool needs its session store on that machine, such as `~/.claude/projects` for Claude Code, as `teamai session restore` does. OpenCode gets the archived session, but its step still starts a new session, because OpenCode has no flag to resume one.

A lease's `session` lists in `earlier` the sessions it continued, newest first, for a driver that cannot get the session itself. A driver other than `local` that continued the lease's `session`, or one in `earlier`, by its id or in a copy, puts the one it continued in its report as `resumed` (`{"tool","id"}`), next to the `session` it ran. It leaves `resumed` out when it started a new session. Without `resumed`, later steps resume the lease's session, not the copy. A `resumed` without a tool and an id, on a step that resumes no session, or naming a session the lease did not offer (neither its `session` nor one in `earlier`), answers `invalid_report`.

Every refusal is one JSON envelope with `error.code`, `error.message`, and the extra fields listed below. The command exits 1.

| Code | What happened | Next step |
|---|---|---|
| `not_owner` | Another install owns the run. Carries `owner` and `ownedAt`. | Ask the owner, or take it over with `resume <run> --claim`. |
| `state_moved` | The run changed while this machine prepared its claim or its publish: on `teamai-reports` for a claim, on this machine for a publish. Nothing was claimed or published. | Claim again, or publish again. |
| `state_conflict` | `teamai-reports` holds a later state than this machine last saw. | Run `resume <run>` to take the published state. |
| `run_not_published` | Nobody published the run. | Publish it from the machine that has it. |
| `run_not_found` | This machine has no run with that id. | Check the id. |
| `run_unreadable` | The run file on this machine cannot be read. | Check the run file in the TeamAI data directory. |
| `run_mismatch` | A run here has the same id but started at another time. Carries `localCreatedAt` and `remoteCreatedAt`. | Neither run is changed. They are different runs. |
| `invalid_run` | The id is not `r` followed by 8 or 16 hex digits. | Check the id. |
| `unsupported_repo` | The team repo is an `http` repo, which has no `teamai-reports`. | Continue the run on the machine that has it. |
| `busy` | Another teamai process is writing `teamai-reports` or the run, or another open attempt holds the place `next --prepare` would prepare. | Try again; for a held place, once that attempt reports. |
| `reports_unreachable` | `teamai-reports` could not be read from the team repo's origin. | Check the connection, then try again. |
| `reports_failed` | The write to `teamai-reports` failed. | Try again. |
| `records_pending` | The run's records did not reach `teamai-reports`: git's push error, a busy writer, or a record queued while the publish ran. | Try again. |
| `definition_mismatch` | The claim cannot get the workflows the run ran. May carry `teamRevision`. | Follow the message: run `teamai pull` after the other machine pushed its workflows, fetch the team commit, or use the same teamai version on both machines. |
| `snapshot_unsupported` | The state has a field, named in `field`, that the snapshot format cannot carry or this teamai cannot read. | On a claim, update teamai, then try again. On a publish, fix the driver that wrote the value, such as a commit that is not a full id. |
| `secret_detected` | A value looks like a secret. Carries `step` (when in a step), `field`, and `label`. | Continue the run on this machine. |
| `local_path_detected` | A value holds an absolute path of this machine. Carries `step` (when in a step) and `field`. | Continue the run on this machine, or start it again with paths relative to the repository. |
| `sessions_not_archived` | No session of a chain the steps continue can be read here (or its tool is not one teamai reads), the archive was busy, or the commit or push failed. | Publish again, or publish without `--sessions` so those steps start new sessions. |
| `origin_unavailable` | The business repository's origin could not be read or updated. | Run the command in the run's business checkout, with access to its origin. |
| `commit_missing` | A recorded branch is not on origin, is behind the recorded commit on a publish, or the base cannot be pinned because this checkout lacks it. Carries `branch` and `commit`. | Push the branch from the machine that has the commit. On a publish, the message gives the `git -C <checkout> push origin <commit>:refs/heads/<branch>` to run. Or publish from the checkout the run started in. |
| `branch_diverged` | A branch on origin holds work the run does not know about. Carries `branch`, `expected`, and `actual`. | On a publish, have the driver that pushed it report it, or move the branch on origin back to the recorded commit. On a claim, the member the message names can publish the run again; moving the branch back discards the commits past the recorded one. |

After a claim, `resume` can also answer `branch_diverged` when a local branch cannot be brought to the commit the run recorded. The message names the workspace and what to do. See [Workspaces in your own driver](#workspaces-in-your-own-driver).

### Offer a run to a runner

[Hand a run to a runner](workflow.md#hand-a-run-to-a-runner) shows the common case. A publish of a running run writes `repository` and `offered` into the header of the published state, `workflows/runs/<run>/state.json`:

```text
{"snapshot":1,"run":"r482011be75fd0ad9","owner":{"id":"4c514375-352d-44ad-83f9-9f7a06a25e3f","user":"alice"},"ownedAt":"2026-10-28T00:26:39.443Z",
 "repository":"github.com/acme/web-app","offered":{"at":"2026-10-28T00:26:39.443Z"},"stateRevision":1,"write":"4f071543-…", …the run's state}
```

`repository` is the business repository, read from the checkout's `origin` as `host/owner/repo`. It stays through later claims. `offered` stays until a claim: every claim drops it in the same write that changes the owner. A run that ended is not offered, and neither is one published from a directory with no `origin`, since `--next` takes runs by repository. A run published by a teamai without offers carries neither field, and `--next` never takes it.

`teamai workflow resume --next` fetches `teamai-reports` as `teamai pull` does, then tries the offered runs oldest offer first. It skips a run this install published, a run of another `repository` than this checkout's `origin`, a run its caller may not take, a run that waits for a person now when nobody here would answer, and a run whose steps left need what this machine lacks. A run waits for a person when a step ready in its published state is a required approval, an `interactive` step, or a choice the runner's `--auto-approve` does not answer. A step that may need a person later does not stop the runner: it takes the run, and hands it back if it reaches one. Nobody answers in an unattended run, or with the local driver and no terminal. What a machine can lack:

| Steps left | Lacking here when | Listed fix |
|---|---|---|
| A step or its `setup` with `requires.env` | a key has no value here, or the team env cannot be read | `teamai env set <KEY>` for a declared key, or `teamai env add <KEY> --secret` then `teamai env set <KEY>` for an undeclared one, or set it in the environment |
| A prompt step, with the local driver | `--tools`, `workflows.tools` and your AI tool name no tool for its agent, or only one teamai does not launch | `--tools default=<tool>` (or `<agent>=<tool>`), or `workflows.tools.default` |
| A prompt step, with the local driver | the tool they name is not on `PATH` | install it, or `--tools` names one that is |

A step that already settled for good counts for none of these, as for a person. With `--driver skill` the session runs the prompt steps, so only env counts. It claims the first one left as `resume <run>` would, and drives it with the driver `--driver` names. A claim that another runner beat answers `state_moved` inside `--next`, which then tries the next run. On stderr it says why it left each offered run of this repository: `Left <run> (<workflow>) offered for a person: …`, or a warning `Left <run> (<workflow>) offered: <what this machine lacks>: <what gives it>`. With nothing to take, it prints `{"data":{"idle":{"offered":N}}}` and exits 0: `N` counts the runs other installs offer that it left.

Who may take an offered run follows the workflow's `invoke`, as `resume` does:

| Caller of `--next` | `invoke: allow` | `invoke: ask` | `invoke: deny` |
|---|---|---|---|
| A job or a terminal, no agent session | takes it | takes it | takes it |
| An agent session, attended | takes it | takes it with `--confirmed` | skips it (`invoke_denied`) |
| An agent session, unattended | takes it | skips it | skips it |

`--driver skill` always counts as an agent session, and also skips a run only the local driver can run (`needs_local_driver`). The listing shows a run skipped this way with the refusal's code, or as `needs the local driver`.

`teamai workflow resume` with no run id lists, after the same fetch, the offered runs of this checkout's business repository and this machine's running runs, once each. `STATUS` is `running` (with `may need a person at <step>` when a step left may need one), `needs a person` (a step ready now does; a person takes it over with `resume <run> --claim`), `cannot run here` (with what this machine lacks and what gives it), `needs the local driver`, `claimed` (another install took your run), `succeeded`, `failed` or `cancelled` (your run ended on the install that took it, and `--claim` brings how it ended here), or the code of another refusal. A checkout without an origin lists no offered run, since `--next` takes none there. When the fetch fails, it warns and lists what the last fetch saw.

| Code | What happened | Next step |
|---|---|---|
| `invalid_arguments` | `--next` came with a run id, or with `--claim`. | Pass one: a run id, or `--next`. |
| `unsupported_repo` | The team repo is an `http` repo, which has no `teamai-reports`. | Use a git team repo. |
| `origin_unavailable` | This checkout has no `origin`, so there is no business repository to match. | Run it in a checkout of the business repository. |
| `reports_unreachable` | `teamai-reports` could not be fetched. Nothing was claimed. | Check the connection, then try again. |

### Publish from CI

A CI job that runs a workflow with `--driver local` can publish the run when it fails, so a member resumes it on their own machine. The job publishes from the checkout the run started in. `publish` pushes the run's base to the business repository's origin once, as `teamai/<run>/base`, without force, and reads the run's branches there with `git ls-remote`. The job's token therefore needs push access to the business repository, which on GitHub Actions is `permissions: contents: write`. A workflow that runs for a pull request from a fork gets a read-only token and cannot publish. The job also needs write access to the team repo, where `teamai-reports` lives.

### Claim from your own driver

A driver other than `local` claims a run by adding `"claim": true` to its first `next` payload:

```text
teamai workflow next <run> --json '{"claim":true,"driver":{"kind":"script","machine":"runner","workspace":"/work"}}'
```

The claim takes the run's offer away, as every claim does. A `next` without `claim` on a run another install claimed answers `not_owner` once this machine's `teamai-reports` checkout shows that claim (after `teamai pull` or `workflow resume`), instead of leasing from the stale copy here. The claim runs before `next` leases anything, and checks a running run's branches on the origin of `driver.workspace`. It then brings each local branch to the commit the run recorded, as `resume` does, and answers `branch_diverged` when it cannot. A run this install already owns stays as it is, but no longer offered. A claim refusal comes back as the `next` error envelope. From an agent session, the claim follows the run's `invoke` as `resume` does: a payload cannot carry the person's yes, so an `ask` run answers `confirm_needed`, and once the person agrees the session continues it with `teamai workflow resume <run> --claim --confirmed`. On `state_moved`, send the claim again. A value other than a boolean answers `invalid_json` with `claim must be a boolean`. A driver whose runs another machine may continue reports full commit ids in `changes` and `read`. `publish` refuses a run with any other commit value as `snapshot_unsupported`, naming the field.

## Workspaces in your own driver

A driver other than `local` that takes workspace leases keeps the run's commits where another driver or another machine can find them. Every driver follows two rules:

1. Before it starts a step from `workspace.start`, merges an entry of `workspace.merge`, or restores agent files from `workspace.configCommit`, it checks that its checkout has the commit, with `git cat-file -e <commit>^{commit}`. When one is missing, it fetches the run's branches with the refspec `+refs/heads/teamai/<run>/*:refs/remotes/origin/teamai/<run>/*` and checks again. A fetch whose refspec matches no branch still succeeds, so only the second check decides. A commit that is still missing fails the step with `workspace_base` before anything runs, and the message names the commit and its branch.
2. When the checkout has an `origin`, it pushes the branch of the commits it reports in `changes` before it sends the report, also when the step failed. When that push fails, it still reports the commits. A step that succeeded then fails with `push_failed`. A step that failed keeps its own failure, and its message adds that the branch was not pushed.

`workflowGitConformanceScenarios` in `src/workflow/conformance/git.ts` checks both rules against a bare `origin`. Run them against your driver, as `src/__tests__/workflow-git-conformance.test.ts` runs them against `local`.

A driver that continues a [published run](#publish-and-claim) relies on these rules too:

- `publish` pins the run's base on `origin` as `teamai/<run>/base`, so the fetch in rule 1 also brings in the base commit.
- After a claim, before it continues a workspace it has locally, the driver moves that branch forward to the commit the run recorded. It refuses, and moves nothing, when the local branch is ahead of that commit or has diverged from it, when its worktree has changes or is on another branch, or when a read-only step left it and it is not back. The local driver does this once per claim, before its first lease, and answers `branch_diverged` with what to do.
- A workspace the claim brought in has no owner until a driver leases a step in it. That driver becomes its owner.
- A lease another machine held in a step that opened its own workspace starts again as that step's next pass, on a new branch. The old branch stays on `origin` with whatever was pushed to it. That step asks its HITL question again. A lease in any other step is released and runs again in the same pass.

### Let TeamAI prepare the workspace

A driver can leave the workspace and its git to TeamAI. `next <run> --prepare --json '<payload>'` leases a step and prepares its workspace: it creates or reuses the worktree in the checkout the run started from, applies the base agent files and team delivery, and returns the directory as `lease.cwd`. Preparing again keeps the edits already there. Run the step in `lease.cwd`, and run no git there. Two attempts never share a place, and the checkout is one place, so steps that work in the checkout run one after another, even parallel ones: a lease whose place another open attempt holds answers `busy` and stays leased; prepare it with `--attempt` once that attempt reports. Setup runs in the `runMode` the driver sent on `next`, else in the mode of the process that calls `next --prepare` (see [Attended and unattended runs](workflow.md#attended-and-unattended-runs)), never in the mode the run started in.

`report` then finishes the attempt. It commits, pushes, and fills `changes` or `read` itself, so a report of a prepared attempt that carries `changes` or `read` answers `invalid_report`. TeamAI removes the worktree only after it accepts a successful report whose answer allows cleanup. A failed attempt keeps its work for a retry.

To prepare an attempt the driver already leased, run `next <run> --prepare --attempt <attempt>`. It answers `wrong_attempt` when the run no longer leases that attempt to the driver. With `--adopt <dir>`, the attempt runs in a place the host made: a clean worktree of this repository on the lease's workspace branch, or detached at its start, as `git worktree add` makes it. A place that does not fit answers `adopt_mismatch`, and the attempt stays leased. TeamAI commits and pushes there as in its own worktree, and never removes the place.

A prompt step's child lists every path it changed, relative to the place, on `changed` in `attempts/<attempt>/result.json`. A rename lists both paths. TeamAI commits those paths. A path git would commit that is missing from the list fails the step with `unreported_changes`: nothing is committed or pushed, and the file stays. That is also the failure when the step ran and reported a failure of its own. A failure from before the step ran, such as a model this session cannot run, stays that failure, and the file is still not committed. A file the preparation merge staged, and that the step left as the merge wrote it, is part of that merge. It does not have to be in the list.

```json
{"kind":"output","output":"Fixed the null check.","changed":["src/app.ts","src/legacy.ts"]}
```

`adopt` checks a clean tree. A host setup that writes afterwards is not in that list. The host files below are examples. This repository does not run them. Paseo runs `worktree.setup` from `paseo.json` when it creates the worktree. This one waits, then writes a file git does not ignore:

```json
{
  "worktree": {
    "setup": "sleep 2; echo host > .setup-out"
  }
}
```

T3 runs each `t3.json` script with `runOnWorktreeCreate` the same way:

```json
{
  "scripts": [
    {
      "name": "Setup Worktree",
      "command": "echo host > .setup-out",
      "runOnWorktreeCreate": true
    }
  ]
}
```

The step then fails:

```text
Step "fix" left .setup-out in /work/teamai-fix, which the step did not report changing, so nothing was committed or pushed. If your host's setup wrote it, make setup write only files git ignores, or wait for it to finish before adopt. Otherwise remove it, then retry the step.
```

An install into an ignored directory does not fail. With `node_modules/` in `.gitignore`, this Paseo setup leaves the install in the place and out of the commit:

```json
{
  "worktree": {
    "setup": "npm install"
  }
}
```

A command step has no `changed` list. If the place is already dirty when the command is about to start, the command does not run and the step fails the same way. The base agent files prepare put there are not that dirt: a path that still matches them is left out, the command runs, and finish puts the branch's copies back when the command left them unchanged. A file the command itself writes during the run is still committed. Wait for the host setup to finish before adopt, or make it write only ignored files. A report sent through the CLI, with no child `result.json`, still commits the dirty tree. The skill driver is what supplies the list.

What TeamAI records to prepare an attempt stays on this machine: paths and file fingerprints, with no prompt, env value, or graph.

## Clone workspaces in your own driver

```text
teamai workflow next <run> --prepare --json '{"driver":{"kind":"script","machine":"runner","workspace":"/work","can":{"workspace":["read-only","new","continue","clone"],"isolation":"sandbox","env":true,"setup":true,"tools":["claude"],"end_turn":true}},"running":[]}'
```

With `--prepare`, teamai makes a [clone step](#clone-workspaces)'s clone on this machine, installs its team assets and runs setup, then answers the lease with `cwd`, the clone. A call can take as long as setup takes. A clone step is held from a driver that does not list `clone` in `workspace` or does not ask with `--prepare`, and `wait.held[].missing` names `workspace.clone` or `prepare`. A clone that runs as a team role also needs `can.role`. A step [confined to a directory](#confined-steps-in-your-own-driver) needs no place: `--prepare` answers its lease with `cwd`, its `confined.dir`, and makes, sets up or snapshots nothing of the checkout for it.

For each lease the driver:

1. Runs every process with `lease.env` and `TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>`, so a `teamai` call from it changes no run, and without the names in `lease.envScope.withhold`. A command lease's `env` already carries `TEAMAI_WORKFLOW_ATTEMPT`, `TEAMAI_RUN_DIR` and `TEAMAI_MODE`, so the `teamai score` steps of [`teamai-score`](scorers.md) run under any driver. It runs a command lease, such as `teamai benchmark check`, in `cwd`, or in its own workspace for a lease without one, and reports the JSON it prints as `outputs`.
2. Launches a prompt lease's `lease.tool` in `cwd` on `lease.prompt`, with `lease.model` as given, and holds it to `lease.limits` from the tool's launch.
3. Reports a prompt with `tool`, the `model`, `session` and `tokens` the tool reported, `durationMs` measured around the tool launch only, and `cost` (`{"amount":0.12,"unit":"USD"}`) only when the tool stated one. When a limit stopped the tool, the report has `outcome: "success"` and `limit`: `timeout`, `budget` or `max_turns`; a `budget` or `max_turns` the driver could not hold the tool to goes in `unenforced`. A report whose `limit` the lease does not set answers `invalid_report`, as does one with `changes` or `read`, which teamai fills from the clone.

`src/__tests__/e2e/benchmark-driver-contract.test.ts` checks this contract against a driver that runs a [benchmark](benchmarks.md#your-own-driver).

## Confined steps in your own driver

A script that offers a confined Claude takes the `judge` step of [`judge-change`](workflow.md#a-prompt-confined-to-a-directory) once `evidence` succeeded, runs it in `confined.dir`, and reports the reply:

```console
$ teamai workflow next r245b… --prepare --json '{"driver":{"kind":"script","machine":"runner","workspace":"/work/app","can":{"workspace":["read-only"],"confined":[{"level":"best-effort","access":"read","tools":["claude"]}]}}}'
{"data":{"lease":{"attempt":"afd63…","revision":2,"run":"r245b…","step":"judge","pass":1,"prompt":"Read change.diff. Answer pass when the change does one thing and tests it, else fail.","output":{"type":"object","fields":{"verdict":{"type":"enum","values":["pass","fail"]}}},"confined":{"dir":"/home/ana/.teamai/workflows/runs/r245b…/scratch/evidence","level":"best-effort","tools":["claude"]},"cwd":"/home/ana/.teamai/workflows/runs/r245b…/scratch/evidence"},"cancelled":[]}}
$ teamai workflow report r245b… --json '{"attempt":"afd63…","revision":2,"outcome":"success","driver":{…},"outputs":{"verdict":"fail"},"confined":{"tool":"claude","isolation":"best-effort","access":"read","model":{"reported":"claude-sonnet-4-6"}}}'
{"data":{"accepted":true,"revision":3,"step":{"id":"judge","status":"succeeded","outcome":"success"}}}
```

A step [confined to a directory](workflow.md#a-prompt-confined-to-a-directory) is leased only to a driver with a `can.confined` offer at its level or above. Its lease carries `confined`: `dir`, `level`, `tools`, the tools of the offers that reach the level in their order with those `prefer` names first, in its order, and `schema` when `confined.json` names one. A step whose model none of those tools resolves on this machine waits, with `wait.held[].missing` naming `model`, as one no offer reaches names `confined`.

The driver runs `lease.prompt` on the first of `tools` that resolves `lease.model`, with `dir` as the tool's working directory and only readable root, none of the team's env, and no session kept. It reports the reply as `outputs`, which TeamAI checks against the step's `output`, and `confined` as that run measured it: `tool`, `isolation`, `access`, and `model`, `effort` and `usage` when the tool reported them. A driver that finds no tool to run reports `outcome: "released"`. `confinedConformanceScenarios` in `src/workflow/conformance/confined.ts` checks the leasing rules.

## Judge work in your own driver

Judge work is a run like any other: the driver drives each teamai-score run an answer lists in `started`, its judge step a [confined step](#confined-steps-in-your-own-driver). See [Scorers](scorers.md#any-driver).

An unattended driver ends with `teamai score --drain`. It judges what can be judged here, publishes run records, labels and sessions, and prints what is left for other drivers. The local driver runs it at the end of an unattended run, unless publishing and scoring of unattended sessions are both `off`, after the run's `done` envelope on stdout, and prints its lines on stderr. The exit status stays the run's outcome, also when the drain fails. See [Drain before an unattended job ends](scorers.md#drain-before-an-unattended-job-ends).
