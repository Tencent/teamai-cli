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
3. It leases the first ready step in file order. The steps of a sub-workflow take the place of the step that runs it.
4. When every ready step is leased, it answers `wait`, and `reason` names the first open lease.

A driver that sends no `running` gets its open lease back on every call, so it runs one step at a time.

`"canTakeLease":false` issues no new lease but still returns a waiting HITL request to a driver that declares `driver.can.hitl`. The answer is `done`, an open lease that `running` leaves out, `hitl`, or `wait`. When nothing is leased or waiting at a HITL request, the `wait` reason is `canTakeLease is false`. Use it to learn about an end while the driver has no room for another step. That `wait` does not mean that nothing is left to run, so call `next` again once the driver has room. Step 2 can still hand back an open lease that the driver has no room for, so keep a queue of the leases the driver has not started.

Every `data` answer of `next` has `cancelled`. It lists the attempts in `running` that are no longer open leases of this driver. Stop those processes. An `error` answer has no `cancelled`.

A wrong `running` or `canTakeLease` returns `invalid_json` with `running must be an array of attempt ids` or `canTakeLease must be a boolean`. While one driver holds a lease, another driver gets `wait`, and `reason` names that lease.

`report` checks each report against the revision of its own lease, not the run's latest revision. Above, `next` handed out both leases at revision 1. A report for `test` with `"revision":1` moves the run to revision 2. A report for `lint` with `"revision":1` is still accepted and moves it to 3. A report with another revision for an open lease returns `stale_revision`:

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

### Run local commands in parallel

`--driver local` runs up to `workflows.max_parallel` command steps at once. Set it in the local config. It defaults to 1, and no flag sets it.

```yaml
workflows:
  max_parallel: 4
  auto_approve: false
```

A prompt step always runs alone. The driver starts it once every command has exited, and starts no command until it finishes. For a headless prompt, the read-only check compares the whole working tree before and after the prompt, so a command that changes files while the prompt runs would fail it.

With `max_parallel` above 1:

- Commands share the working tree. Two commands that write the same file can overwrite each other.
- Each command runs without a terminal, so it cannot read input from you.
- On Ctrl-C, or on a SIGTERM, SIGQUIT, or SIGHUP, teamai stops every command, waits for them to exit, and exits with that signal.

With 1, the driver runs one step at a time, and a command runs in your terminal, where Ctrl-C reaches it.

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

A failed item does not stop the other items. The step settles when every item has settled, and it fails if any item failed. `output` checks the outputs of each item.

`steps.<id>.results` lists how each item went, in item order. Each entry has `item`, `outcome`, and `outputs` when the item has outputs:

```json
[{"item":{"id":"core","dir":"packages/core"},"outcome":"success"},{"item":{"id":"cli","dir":"packages/cli"},"outcome":"failed"}]
```

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

### Read every pass

Each run of a step is a pass, numbered from 1. A lease carries its `pass`. In a run of `loop-implement-task`, the second lease of `e2e` is:

```text
{"data":{"lease":{"run":"rd50c3422","step":"e2e","attempt":"a54df2231","revision":4,"pass":2,"command":"npm run test:e2e"},"cancelled":[]}}
```

`steps.<id>.outcome`, `steps.<id>.end`, and `steps.<id>.outputs` read the latest pass. `steps.<id>.passes` lists every pass of the step, the current one included once it has settled. Each element has `pass` and `outcome`, and `outputs` and `end` when that pass has them. A pass of a `for_each` step has `results` instead of `outputs`, including in a previous-pass read. In `loop-review-and-fix`, the workflow output `reviews` returns every review.

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
| Every pass of a step | `steps.review.passes`, `steps.review.passes[0].outputs.verdict`. See [Read every pass](#read-every-pass). |
| The results of a `for_each` step | `steps.build.results`, `steps.build.results[0].outcome` |
| The item of a `for_each` instance | `item`, `item.dir` |
| A string | `'failed'`. Use single quotes. Write a quote inside a string twice: `'it''s'`. |
| A number | `3`, `-1`, `1.5`. Write a digit before the decimal point: `0.5`, not `.5`. |
| A boolean or null | `true`, `false`, `null` |
| An empty array | `[]`. It is the only array literal. |

A missing value reads as `null`. A step that has not settled reads as `null` too.

### Indexes

`[n]` reads element `n` of an array, counting from 0: `steps.review.outputs.files[0].path`, `inputs.tags[1]`, or `steps.grid.outputs.rows[1][0]`. An index past the end, or an index into a value that is not an array, reads `null`.

An index is a whole number from 0. `[-1]`, `[01]`, and `[inputs.n]` do not parse. An index reads an array inside `inputs`, `outputs`, `passes`, `results`, or `item`. It cannot follow a step id, `outcome`, or `end`, so `steps.build[2].outcome` does not parse.

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

For an approval that must come directly from a person, use `approve: { message: Publish?, required: true }`. Required approvals never use automatic answers. `respond` records the answer time, channel, choice, and optional note. With `--json`, its channel is `driver`, with `agent: false`. Without `--json`, TTY stdin records `tty`, with `agent: false`; otherwise it records `cli`, with `agent: true`. A required approval rejects `cli` answers with `agent_in_path`. A TTY is a channel convention, not protection against someone who can create a PTY.

```sh
teamai workflow respond <run> decide build --note "Ready" --pass 1
teamai workflow resume <run>
```

`--pass` rejects an answer for a HITL request replaced by a later pass. A second answer in the same pass is `repeated_response`.

Drivers other than `local` use the same HITL contract. Send `driver.can.hitl` on every `next` request, including busy polls. Set it to `true` when a person can answer HITL requests and work in interactive steps. When no lease is ready, `next` returns `hitl` with `run`, `step`, `pass`, `kind`, rendered `message`, `options`, optional `default`, and `required`, plus a `respond` command template. Show `hitl.message` and `hitl.respond` to that person, who runs `teamai workflow respond` with `<option>` replaced by a choice. The template quotes fan-out step paths such as `'items[0].ask'`; keep those quotes. The `cli` channel can answer optional HITL requests only. A driver with its own UI can submit a person's answer, including a required approval, with `respond --json '{"driver":{"kind":"ide","machine":"host","workspace":"/work"}}'`; this records channel `driver`, `agent: false`, and the driver identity locally. The driver declares that a person answered in its UI and must never send an answer its agent chose; like the TTY convention, this is a declaration, not protection.

A ready lease wins over a HITL request. While a tool runs, poll `next` with its attempt id in `running` and `canTakeLease: false`, show any HITL request, and stop tools whose attempt ids appear in `cancelled`. Only a driver with HITL may take `interactive` leases; a driver without HITL fails them with `hitl_required`.

Without that capability, a `next` request that can take a lease applies this table. Busy polls leave waiting HITL requests unanswered and return `wait` when the driver has no HITL capability.

| HITL request | `auto_approve: true` | Default (`false`) |
|---|---|---|
| Optional approve | `yes`, channel `auto_approve` | `no`, channel `no_hitl`; skip |
| Required approve | Fail `hitl_required` | Fail `hitl_required` |
| Choose with default | Take default, channel `auto_approve` | Fail `hitl_required` |
| Choose without default | Fail `hitl_required` | Fail `hitl_required` |

Every decision without HITL and `hitl_required` failure logs a warning to stderr. Set `workflows.auto_approve` beside `workflows.max_parallel` in local config, or pass `--auto-approve` to `start --driver local` or `resume` for that process only. JSON `next` cannot set this override. The local driver declares HITL only when stdin and stderr are TTYs. It asks on stderr, accepts a choice followed by an optional note, and keeps polling while the question is open. An answer from elsewhere or a cancellation closes that question. Questions wait while an interactive tool owns the terminal.

`interactive: true` needs `prompt` or `prompt_file`. A driver without HITL fails it with `hitl_required`. The local driver opens the tool here in the workspace with inherited stdio and the prompt as its first message. Repository edits by the person are kept, as with a command step. Headless prompts remain read-only. Terminal Ctrl-C and Ctrl-\ go to the interactive tool; SIGTERM and SIGHUP stop it and the driver. A result file is optional when the interactive tool exits successfully without outputs. The driver polls every two seconds during prompts and stops a cancelled tool.

## Retry, cancel, and resume

```sh
teamai workflow retry <run> <step>
teamai workflow cancel <run> [step]
teamai workflow resume <run> --tools default=claude
```

`retry` accepts a leased, failed, or cancelled step, a refused approve with an answer, or an answered choose. Retry a HITL request to change its answer; its old answer stays in pass history. It frees an old lease and starts a new pass at a new revision. The local driver stops a command it was running and starts the new pass only after that command has exited. It resets the steps that depend on or read that step, including loop waits and item `after` dependencies. A HITL request among them that waits, or was answered and has not run, is asked again at a new pass. It reopens settled enclosing workflows, items, fan-out steps, and the run. If the reopened run is still running, the result includes a `resume` command. Run it to continue locally, or let your driver poll `next`. Unanswered skips in each affected container are re-derived; manual cancellations outside it stay cancelled. An independent standing end or break prevents retry.

History stays in `passes` and the archive, so `length(steps.x.passes)` counts failed attempts too. Retrying a loop owner resets its iteration count. Retrying another step in its range keeps the owner's count. Retry keeps the top-level workflow's round count, so retry in its exhausted final round can fail `loop_exhausted` again.

A single-step `cancel` stops pending, waiting, leased, or running work. Its open descendants stop too. Cancelled steps count as stopped, so dependents skip unless an `if` reads their outcome for recovery. The run normally fails. A whole-run cancel ends immediately with run outcome `cancelled`, without starting another loop round. Cancel does not bump the revision. A late report returns `lease_cancelled`; `next.cancelled` tells drivers which tools to stop.

`resume` drives the run locally after a retry, response, Ctrl-C, or closed terminal. It uses this machine's open local lease workspace first, then the workspace of the latest driver that called `next` when that driver was local on this machine, then the current directory. Resuming after a retry from a subdirectory therefore keeps the original local workspace. Only one local driver can drive a run at a time. A second resume returns `driver_running` with the owning process id; stop that driver or wait. Locks from dead processes are reclaimed automatically. A settled run returns `done`. Failed and cancelled local runs exit 1; successful control commands exit 0 even when their answer describes a failed or cancelled run.
