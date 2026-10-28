# 高级工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

下面每一节都建立在 [工作流](workflow.md) 之上，各节相互独立。

## 并行运行就绪的步骤

一个驱动可以同时持有多个租约。每次调用 `next` 时，它在 `running` 里列出自己仍在运行的未结租约的 attempt。这样 `next` 会租出下一个就绪的步骤，而不是把未结租约交还给它。

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

下面每次调用都发送 `"driver":{"kind":"script","machine":"host","workspace":"/work"}` 和表中的字段：

| `driver` 之外的 `next` 字段 | 返回 |
| --- | --- |
| 无 | `{"data":{"lease":{"run":"ra780d018","step":"lint","attempt":"af143e3a7","revision":1,"pass":1,"command":"npm run lint"},"cancelled":[]}}` |
| `"running":["af143e3a7"]` | `{"data":{"lease":{"run":"ra780d018","step":"test","attempt":"a0ce8107f","revision":1,"pass":1,"command":"npm test"},"cancelled":[]}}` |
| `"running":["af143e3a7","a0ce8107f"]` | `{"data":{"wait":{"reason":"lint is leased"},"cancelled":[]}}` |

每次调用 `next` 都按顺序执行以下几步：

1. 结算运行。如果运行已经结束，返回 `done`。
2. 把本驱动的、`running` 里没有列出的未结租约交还给它。重启后的驱动发送 `"running":[]`，每次调用拿回一个未结租约。
3. 按文件顺序租出第一个就绪的步骤。子工作流的步骤位于运行它的那个步骤的位置。需要 `driver.can.workspace` 未列出的工作区模式的步骤、需要 `driver.can` 未声明的其他能力的步骤（见[要求和限制](#要求和限制)），或使用其他驱动打开的工作区的步骤，会被暂缓，改为租出下一个就绪的步骤。
4. 每个就绪的步骤都已租出时，返回 `wait`，`reason` 指出第一个未结租约。每个就绪的步骤都被暂缓时，`reason` 逐一列出它们，以 `; ` 分隔，`held` 以 `{ step, reason, missing }` 列出它们。`missing` 指出驱动缺少什么，例如 `hitl` 或 `workspace.new`；其他驱动占用该工作区时为空。

不发送 `running` 的驱动每次调用都会拿回自己的未结租约，因此一次只运行一个步骤。

`"canTakeLease":false` 不发放新租约，但对声明了 `driver.can.hitl` 的驱动仍返回 HITL 请求。返回的是 `done`、一个 `running` 没有列出的未结租约、`hitl` 或 `wait`。没有任何租约和 HITL 请求时，`wait` 的 reason 是 `canTakeLease is false`。驱动没有空位运行新步骤时，可以用它来得知是否已到达结局。这个 `wait` 并不表示没有剩余的步骤可运行，所以驱动有空位后要再次调用 `next`。第 2 步仍可能交还一个驱动没有空位运行的未结租约，所以要为驱动尚未启动的租约维护一个队列。

`next` 的每个 `data` 返回都带 `cancelled`。它列出 `running` 中已经不再是本驱动未结租约的 attempt。请停止这些进程。`error` 返回不带 `cancelled`。

`running` 或 `canTakeLease` 格式不对时，返回 `invalid_json`，消息为 `running must be an array of attempt ids` 或 `canTakeLease must be a boolean`。一个驱动持有租约时，其他驱动会收到 `wait`，`reason` 指出那个租约。

`report` 按每次上报自己租约的 revision 检查，而不是按运行最新的 revision。上例中 `next` 在 revision 1 租出了两个租约。`test` 以 `"revision":1` 上报后，运行变为 revision 2。`lint` 以 `"revision":1` 上报仍会被接受，运行变为 revision 3。未结租约以其他 revision 上报时返回 `stale_revision`：

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

### 并行运行本地命令

`--driver local` 最多同时运行 `workflows.max_parallel` 个命令步骤。在 `~/.teamai/config.yaml` 或某个 workspace 自己的 `config.yaml` 中设置它。默认值是 1，没有对应的命令行参数。

```yaml
workflows:
  max_parallel: 4
  auto_approve: false
```

当前检出目录里的提示词要等该目录空闲后才启动，结束前该目录里不会再启动别的步骤。只读检查比较的是这个检出目录在提示词前后的状态。`workspace: new` 的提示词在自己的 worktree 里运行，因此可以和其他 worktree 里的步骤重叠，上限是 `max_parallel`。没有 `workspace` 的命令共用检出目录，并且和那里的其他步骤一次只运行一个。

`max_parallel` 大于 1 时：

- 没有 `workspace` 的命令共用检出目录，一次只运行一个。后一个命令能看到前一个留下的文件。`workspace: new` 的命令使用各自的 worktree，可以一起运行。
- 每个命令都在没有终端的情况下运行，因此无法读取你的输入。
- 收到 Ctrl-C，或 SIGTERM、SIGQUIT、SIGHUP 时，teamai 停止所有命令，等它们退出，然后以该信号退出。

为 1 时，驱动一次运行一个步骤，命令在你的终端里运行，Ctrl-C 会直接到达它。只发给 teamai 的 SIGTERM 或 SIGHUP 会停止命令，等它退出，然后以该信号退出。

结局取消一个正在运行的命令时，驱动向它及其启动的进程发送 SIGTERM，5 秒后如果其中任何进程仍在运行，再发送 SIGKILL。正在停止的命令仍占用并行槽位，直到它的所有进程退出。

## 到达结局时取消仍未结束的步骤

工作流到达结局时，它尚未完成的步骤都会停止。pending 的步骤被跳过。已租出的步骤，以及其工作流正在运行的步骤，变为 `cancelled`。它的子工作流中的步骤也一样。子工作流里的结局只停止该子工作流，父工作流继续运行。

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

驱动同时运行 `lint` 和 `test`。`lint` 失败，于是 `stop` 到达 `broken`。之后在 `running` 中列出 `test` 的那次 `next` 返回：

```text
{"data":{"done":{"run":"r2c7f2c70","outcome":"failed","end":"broken"},"cancelled":["acc763f50"]}}
```

`report` 不记录已取消 attempt 的上报。无论哪个驱动上报，都返回 `lease_cancelled`：

```text
{"error":{"code":"lease_cancelled","message":"Attempt acc763f50 was cancelled; its report is not recorded"}}
```

被取消的步骤，`steps.<id>.outcome` 读作 `cancelled`。工作流到达结局后不再运行任何步骤，所以只有该工作流的 `outputs` 能读到它。下例中，父工作流得知 `lint` 在测试完成前就失败了：

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

## 对每一项运行一次步骤

`for_each` 让一个步骤对列表中的每一项各运行一次。它的值是给出列表的表达式，或一个映射，`items` 里写这个表达式，`max_parallel` 里写上限。每一项作为单独的实例运行，以步骤 id 和该项从 0 开始的下标命名：`build[0]`、`build[1]`，依此类推。

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

`build` 在就绪时读取一次 `inputs.packages`。值不是列表时，该步骤以 `invalid_items` 失败。列表为空时，该步骤立即成功，其 results 为 `[]`。

每个实例在 `prompt`、`env` 和 `with` 中，以及它运行的内联工作流的每个步骤中，以 `item` 读取自己的那一项。只有 `{{ item }}` 的 `with` 值保留该项的 JSON 类型。`command` 不会被填充，所以请通过 `env` 传入该项。步骤自己的 `if` 和 `for_each` 在任何一项运行之前求值一次，因此读不到该步骤的项。在 `for_each` 之外，`{{ item }}` 保持原样，其他读取 `item` 的地方都会被 pull 拒绝，例如 `if` 中或 `{{ filter(inputs.xs, . == item) }}` 中。

驱动拿到的每一项都是普通租约，其 `step` 为 `build[0]`、`build[1]` 等。在 `running` 中列出未结租约的驱动，会在其他项运行时拿到下一项。`max_parallel` 限制同时处于已租出或运行中的项数。达到上限时，`next` 不再租出其他项，直到其中一项完成。

某一项失败不会停止其他项。所有项都完成后，该步骤才完成，任一项失败时该步骤失败。`output` 检查每一项的输出。

`steps.<id>.results` 按项的顺序列出每一项的结果。每个条目有 `item`、`outcome`，该项有输出时还有 `outputs`：

```json
[{"item":{"id":"core","dir":"packages/core"},"outcome":"success"},{"item":{"id":"cli","dir":"packages/cli"},"outcome":"failed"}]
```

某一项在工作区里运行时，对应条目还有 `branch`。`steps.<id>.branches` 按同样的顺序列出这些分支。

带 `for_each` 的步骤没有自己的输出，不带 `for_each` 的步骤没有 results。读取其中任何一个，pull 都会拒绝，包括在工作流 outputs 和之前的 pass 中的读取。要读取某一项，请对 results 使用下标，例如 `steps.build.results[1].outcome`。

要重试失败的项，在带 `needs: [build]` 的步骤上同时设置 `for_each: "filter(steps.build.results, .outcome == 'failed')"` 和 `if: steps.build.outcome == 'failed'`。`if` 读取失败的依赖，所以重试步骤可以运行。每个重试项将原始值保存在 `item.item` 中。

是对象的项可以带一个字符串 `id`，以及一个 `after` 列表，列出其他项的 id。该项要等这些项都成功后才开始。其中任一项失败、被跳过或被取消时，该项被跳过。

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

`publish[1]` 在 `publish[0]` 成功后开始。每一项的工作流中的步骤，id 形如 `publish[0].pack` 和 `publish[1].verify`。

`after` 中的 id 没有对应的项、两项 id 相同，或 `after` 不是 id 列表时，该步骤在任何一项运行之前以 `invalid_items` 失败。项之间循环等待时，该步骤以 `item_cycle` 失败，消息会指出这个循环：

```text
step "publish" has items that run after each other in a cycle: core -> cli -> core
```

`for_each` 与 `loop`、`end` 或 `break` 一起使用时，pull 会拒绝。要再次运行某一项的工作，请把循环放进该项运行的工作流里。

## 先到达的结局生效

驱动再次调用 `next` 之前，多个上报可能到达两个结局。此时 `next` 采用先到达的那个结局，与步骤在文件中的顺序无关。

- 驱动上报的步骤，在该次上报产生的 revision 到达它的结局。
- 只有 `id`、`needs`、`if` 和 `end` 的步骤，在它依赖或读取的最后一个步骤完成时到达它的结局。
- 同时到达时，先声明的步骤生效。

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

如果 `rewrite` 先上报成功，`patch` 随后上报成功，下一次 `next` 返回 `{"data":{"done":{"run":"ra0ca39d4","outcome":"succeeded","end":"rewritten"},"cancelled":[]}}`。驱动何时调用 `next` 不会改变生效的结局。在胜出的结局之后才上报时，即使还没调用 `next`，也会返回 `lease_cancelled`。这次上报不会增加修订号、改变工作流的输出，也不会开始新的循环 pass。无需驱动即可发生的跳过和失败，使用导致该转换的修订号，因此也可能先到达另一个结局。

## 回到前面的步骤再运行

带 `loop` 的步骤成功后会再次运行，连同它前面直到 `back_to` 的步骤一起。这些步骤是循环的范围：`back_to`、带循环的步骤，以及两者之间的每个步骤。一个步骤依赖 `back_to`，而带循环的步骤又依赖它，无论直接依赖还是通过依赖的依赖，它就位于两者之间。

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

`loop` 有以下字段：

- `back_to` 是范围的第一个步骤。它是带循环的步骤本身，或该步骤直接或间接依赖的步骤。
- `max_iterations` 是带循环的步骤最多运行的次数，是从 1 开始的整数。
- `while` 可选。它是一个表达式，带循环的步骤每次成功后求值。

带循环的步骤成功且 `while` 为假时，循环结束。否则范围从 `back_to` 起再次运行。带循环的步骤被跳过或失败时，循环也会结束。上例中，审查通过后 `fix` 被跳过，于是循环结束，运行成功。

`max_iterations` 限制带循环的步骤：

- 有 `while` 时，如果最后一次运行后 `while` 仍为真，该步骤以 `loop_exhausted` 失败。
- 没有 `while` 时，范围会再运行一次。如果该步骤的 `if` 让它超出上限运行，它以 `loop_exhausted` 失败。上例中，第三次修复之后会运行第四次审查。审查通过时 `fix` 被跳过，运行成功。否则 `fix` 以 `loop_exhausted` 失败。

以 `loop_exhausted` 失败的步骤保留它最后一次运行的输出。

范围外依赖或读取范围内步骤的步骤，会等到循环结束。在此之前它既不会被跳过，也不会运行。这里 `done` 只依赖 `e2e`，但仍要等 `fix` 循环：

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

使用 `--driver local` 时，如果 `e2e` 在一次修复后通过，运行结束：

```text
{"data":{"done":{"run":"re4b12bbc","outcome":"succeeded","end":"done"},"cancelled":[]}}
```

如果三次修复后 `e2e` 仍然失败，`fix` 不会运行第四次，而是以 `loop_exhausted` 失败，`give-up` 到达 `stuck`：

```text
{"data":{"done":{"run":"r3319969c","outcome":"failed","end":"stuck"},"cancelled":[]}}
```

### 读取每一个 pass

步骤的每次运行是一个 pass，从 1 开始编号。租约带有它的 `pass`。在 `loop-implement-task` 的一次运行中，`e2e` 的第二个租约是：

```text
{"data":{"lease":{"run":"rd50c3422","step":"e2e","attempt":"a54df2231","revision":4,"pass":2,"command":"npm run test:e2e"},"cancelled":[]}}
```

`steps.<id>.outcome`、`steps.<id>.end` 和 `steps.<id>.outputs` 读取最新的 pass。`steps.<id>.passes` 列出该步骤的每个 pass，当前 pass 完成后也包括在内。每个元素都有 `pass` 和 `outcome`，该 pass 有 `outputs` 和 `end` 时也带上它们。`for_each` 步骤的 pass 带 `results`，没有 `outputs`，读取上一个 pass 时也如此。在 `loop-review-and-fix` 中，工作流输出 `reviews` 返回每一次审查。

步骤可以读取它所在范围内后面的步骤，即直接或间接依赖它的步骤。这种读取得到后面那个步骤的上一个 pass，在第 1 个 pass 上为 `null`，并且不会等待它。在这种读取中，`passes` 只列出之前的 pass。这里 `plan` 读取上一次决定的备注：

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

在第 1 个 pass 上，`{{ steps.decide.outputs.note }}` 是空文本。在第 2 个 pass 上，它是 `decide` 在第 1 个 pass 返回的备注。

### pull 拒绝的循环

以下情况下，`teamai pull` 拒绝步骤循环：

- `back_to` 既不是带循环的步骤，也不是它直接或间接依赖的步骤
- 带循环的步骤还有 `end`
- 它的范围与同一工作流中另一个循环的范围有共同的步骤
- 它所在的工作流自身有 `loop`
- 它范围内的某个步骤有 `break`
- 多个循环通过依赖或读取循环内步骤的步骤互相等待，形成环

此时该文件没有可运行版本，即使之前有有效版本也一样。循环只能通过子工作流嵌套，子工作流可以是文件，也可以内联。例如，在 `loop-implement-task` 中给 `e2e` 再加一个循环，它与 `fix` 循环共用 `e2e`：

```yaml
  - id: e2e
    needs: [implement]
    command: npm run test:e2e
    loop: { back_to: implement, max_iterations: 2 }
```

`teamai pull` 报告：

```text
⚠ [workflows] workflows/loop-implement-task.yaml:16: field "steps[2].loop": step "fix" loop runs "e2e" again, which the loop of step "e2e" also runs; loops in one workflow share no step, so put the inner one in a sub-workflow
⚠ [workflows] workflows/loop-implement-task.yaml has no runnable version
```

## 整个工作流再次运行，并用 `break` 停止

带 `loop` 的工作流一轮接一轮地重新运行它的所有步骤。它的 `loop` 有 `max_iterations`（最多运行的轮数）和可选的 `while`。它没有 `back_to`。内联工作流也可以有 `loop`。

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

带 `break` 的步骤成功时求值 `break`。值为真时，该步骤所在的工作流以成功结束，它的循环也停止。和结局一样，它会跳过尚未运行的步骤，并取消未结租约。`break` 和结局按 [先到达的结局生效](#先到达的结局生效) 的顺序竞争。没有 `loop` 的工作流也可以用 `break`。

每一轮运行到它到达结局或 `break`，或没有可运行的步骤为止：

- 结局停止循环，工作流取该结局的 outcome。上例中，`red` 让它以 `failed` 停止。
- `break` 让循环以成功停止。上例中，那一轮的 `wait` 被跳过。
- 否则 teamai 求值 `while`。为假时，工作流以这一轮的 outcome 和输出结束。为真，或没有 `while` 时，每个步骤都在下一轮再次运行。
- 运行 `max_iterations` 轮之后，工作流以 `loop_exhausted` 失败，不再运行下一轮。

仅有步骤失败不会停止循环。下一轮照常运行，工作流以最后一轮的 outcome 结束。要重试一个不稳定的步骤，可以写 `loop: { while: "steps.e2e.outcome == 'failed'", max_iterations: 3 }`。

没有 `while` 的工作流循环只能通过结局或 `break` 成功。轮数用完时，它以 `loop_exhausted` 失败。

每一轮都是每个步骤的一个新 pass，所以 `steps.<id>.passes` 列出之前的各轮。`while` 只读取它所在工作流的输入和步骤。

`loop-wait-for-ci` 用 `--driver local` 运行三次，结果如下：

| CI 状态 | 返回 |
| --- | --- |
| `pending`、`pending`、`passed` | `{"data":{"done":{"run":"re0ac0c1e","outcome":"succeeded"},"cancelled":[]}}` |
| `pending`、`failed` | `{"data":{"done":{"run":"r7d3d9b06","outcome":"failed","end":"red"},"cancelled":[]}}` |
| `pending` 30 次 | `{"data":{"done":{"run":"r7ac9a988","outcome":"failed","failure":{"code":"loop_exhausted","message":"Loop of workflow \"loop-wait-for-ci\" is exhausted: it ran 30 rounds, its max_iterations"}},"cancelled":[]}}` |

运行失败的原因不是某个结局时，`done` 带有 `failure`，例如顶层的 `loop_exhausted`。运行循环工作流的步骤也以同样的方式以 `loop_exhausted` 失败，并保留最后一轮的输出。

带 `loop` 的工作流不能包含带 `loop` 的步骤。请把其中一个循环放进子工作流。

## 表达式参考

`if` 是一个表达式。它能读取哪些步骤、哪些值为真，见 [工作流](workflow.md)。

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

### 值

| 值 | 示例 |
| --- | --- |
| 输入 | `inputs.issue`、`inputs.issue.labels` |
| 步骤的 outcome、结局或输出 | `steps.check.outcome`、`steps.check.end`、`steps.review.outputs.files` |
| 步骤的每个 pass | `steps.review.passes`、`steps.review.passes[0].outputs.verdict`。见[读取每一个 pass](#读取每一个-pass)。 |
| `for_each` 步骤的 results | `steps.build.results`、`steps.build.results[0].outcome`、`steps.build.branches` |
| `for_each` 实例的项 | `item`、`item.dir` |
| 字符串 | `'failed'`。使用单引号。字符串里的单引号写两次：`'it''s'`。 |
| 数字 | `3`、`-1`、`1.5`。小数点前要有数字：写 `0.5`，不写 `.5`。 |
| 布尔值或 null | `true`、`false`、`null` |
| 空数组 | `[]`。这是唯一的数组字面量。 |

不存在的值读作 `null`。尚未完成的步骤也读作 `null`。

### 下标

`[n]` 读取数组的第 `n` 个元素，从 0 开始计数：`steps.review.outputs.files[0].path`、`inputs.tags[1]` 或 `steps.grid.outputs.rows[1][0]`。超出末尾的下标，或对非数组值使用的下标，读作 `null`。

下标是从 0 开始的整数。`[-1]`、`[01]` 和 `[inputs.n]` 无法解析。下标读取 `inputs`、`outputs`、`passes`、`results`、`branches` 或 `item` 里的数组。它不能跟在步骤 id、`outcome` 或 `end` 后面，所以 `steps.build[2].outcome` 无法解析。

### 运算符和优先级

从结合最松到最紧：

| 运算符 | 结果 |
| --- | --- |
| `\|\|` | 任一侧为真时为 `true` |
| `&&` | 两侧都为真时为 `true` |
| `!` | 操作数为假时为 `true` |
| `==`、`!=` | 两侧是否为同一个值，严格比较 |
| `<`、`<=`、`>`、`>=` | 比较两个数字 |
| 值、函数调用或 `( … )` | 该值 |

`!` 的结合比 `==` 松。`!steps.check.outcome == 'success'` 表示 `!(steps.check.outcome == 'success')`。

`==`、`!=` 和比较运算符不能连写。`1 < 2 < 3` 和 `1 == 1 == true` 无法解析。请加括号，例如 `(1 == 1) == true`。

只有两侧都是数字时，比较才可能为真。任一侧是其他值，例如字符串或 `null`，结果都为假。

### 函数

| 调用 | 结果 |
| --- | --- |
| `length(list)` | 元素个数 |
| `any(list, predicate)` | 至少一个元素使 predicate 为真时为 `true`。空数组为 `false`。 |
| `all(list, predicate)` | 每个元素都使 predicate 为真时为 `true`。空数组为 `true`。 |
| `filter(list, predicate)` | 使 predicate 为真的元素组成的数组 |

运行时 `list` 不是数组时，每个函数都返回 `null`。

predicate 用以 `.` 开头的路径读取当前元素，和 jq 一样：

- `.` 是元素本身。
- `.findings` 是元素的一个字段。
- `.files[0]` 和 `.[0]` 按下标读取。

在嵌套调用里，`.` 是最内层调用的元素。predicate 也可以读取 `inputs` 和 `steps`。以 `.` 开头的路径在 predicate 之外无法解析。

其他函数名无法解析：`"contains" is not a function; the functions are length, any, all and filter`。参数个数不对的调用也无法解析：`any is called as any(list, predicate)`。

### pull 时的类型检查

`teamai pull` 检查每个 `if` 中的类型。它知道字面量、每个运算符和函数结果的类型，以及工作流在 `inputs` 或 `output` 中声明的每个路径的类型。以下任一情况都会让文件无效：

- 比较的某一侧不是数字。这样的一侧可以是字符串、布尔值、`null`、条件、`any`、`all` 或 `filter` 调用，或声明类型不是 `number` 的路径。
- `list` 参数不是数组。这样的参数可以是 `[]` 以外的字面量、条件、`length`、`any` 或 `all` 调用，或声明类型不是数组的路径。
- predicate 读取了声明的元素类型中没有的字段。

例如，如果上面的 `review` 还声明了 `title: string`，下面这个 `fix` 步骤会让文件无效：

```yaml
  - id: fix
    needs: [review]
    if: steps.review.outputs.title > 3 || any(steps.review.outputs.files, .finding > 0) || all(steps.review.outputs.title, .done)
    prompt: Fix the findings.
```

`teamai pull` 报告：

```text
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if compares steps.review.outputs.title with >, but it is not a number
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if reads .finding, which is not in an item of steps.review.outputs.files
⚠ [workflows] workflows/review-files.yaml:12: field "steps[1].if": step "fix" if passes steps.review.outputs.title to all as its list, but it is not an array
```

运行工作流的步骤，其输出没有声明类型，因此 pull 不检查它们。运行时，与非数字值的比较为假，`list` 不是数组的函数返回 `null`。

### 模板

模板读取一个路径，可以带下标，例如 `{{ steps.review.outputs.files[0].path }}` 或 `{{ with.refs[1] }}`。表达式以路径开头（前面可以有 `!` 或 `(`），或对路径调用 `length`、`any`、`all` 或 `filter` 时，模板也会像 `if` 一样对它求值，例如 `{{ length(steps.build.results) }}` 或 `{{ steps.build.outcome == 'failed' }}`。表达式不读取 `with`。只包含一个表达式的 `with` 值保留其 JSON 类型。`teamai pull` 像检查 `if` 一样检查该表达式，写错时还会指出要改什么，包括对步骤拼错的函数名，例如 `{{ lenght(steps.build.results) }}`。其他文本保持原样，例如 Vue 示例中的 `{{ filter(items) }}`。

要把计数或过滤后的列表放进提示词，请在模板中对它求值：

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

提示词需要每一项时，像 `fan-build` 中的 `explain` 那样传入整个列表。


## 要求和限制

步骤在 `requires` 中声明它需要什么。工作流文件中的 `defaults.requires` 作用于其中每个步骤。步骤自己的键会替换这些键，`env` 列表则会合并。工作流文件还可以设置 `setup`、`timeout` 和 `budget`，prompt 步骤可以设置 `max_turns`。

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

| 键 | 作用 | 驱动做不到时 |
|---|---|---|
| `requires.env` | 把这些[团队 env](sharing.md#env环境变量) 键交给步骤。其他团队 env 键，以及运行中其他步骤要求的键，都不会交给它。运行中只记录键名。某个键在本机没有值时，步骤在运行前以 `missing_env` 失败，并给出建议：在环境中设置该键，或对团队已声明的键执行 `teamai env set` 命令。步骤 `env:` 中的项与团队 secret 或被要求的键同名时，以 `env_conflict` 失败。 | 步骤等待。 |
| `requires.network` | `false` 要求步骤不能访问网络。 | 步骤照常运行，其 `unenforced` 列出 `network`。本地驱动无法禁止网络。 |
| `requires.isolation` | `none`、`worktree` 或 `sandbox`。有工作区的步骤至少是 `worktree`。 | 步骤照常运行，其 `unenforced` 列出 `isolation`。 |
| `setup` | 驱动在它创建的每个工作区中、在步骤之前运行 `command`。setup 获得它的 `requires.env` 键；步骤只有自己也要求时才会获得。setup 以非零退出（`setup_failed`）、改动 git 会提交的文件（`setup_dirty`），或把自己某个键的值留在它写入的文件中（包括被忽略的文件，`setup_secret`）时，步骤不运行即失败，工作区被删除。步骤的 `timeout` 也约束 setup。 | 带工作区的步骤等待。 |
| `timeout` | `500ms`、`30s`、`10m` 或 `2h`，写在步骤或工作流文件上。超时的步骤被停止，结果为 `timeout`。写在 workflow 步骤上时，会停止其中每个步骤。写在工作流文件上时，运行以 `failed` 结束，失败码为 `timeout`。重试会重新开始计时。 | 不是能力。每个驱动都会在租约上拿到 `expiresAt`。 |
| `budget` | `{ tokens: N }`，写在工作流文件或 workflow 步骤上。其下每个步骤的输入和输出 token 从它开始时计入：运行从开始时算起，workflow 步骤从每次开始时算起，例如循环的下一轮。重试会重新开始计算预算。超过 `N` 时，其中未结束的步骤停止，并以 `budget_exceeded` 失败。 | 预算内的非交互 prompt 步骤等待，它没有 token 的成功报告以 `budget_unmeasured` 失败。交互式 prompt 由人操作，照常运行；它的报告没有 token 时，其 `unenforced` 列出 `budget`。 |
| `max_turns` | 限制 prompt 步骤的智能体轮数。本地驱动只把它传给无头 Claude。 | 步骤照常运行，其 `unenforced` 列出 `max_turns`。 |

`unenforced` 出现在租约、步骤和运行记录中。每个 `interactive: true` 步骤还需要支持 HITL 的驱动，见 [HITL](#hitl人在回路中)。

成员可以在 `~/.teamai/config.yaml` 或某个 workspace 自己的 `config.yaml` 中、`max_parallel` 旁边，设置本机上任何驱动可以使用什么：

```yaml
workflows:
  max_parallel: 4
  sandbox: true
  allow:
    network: false
    env: [NPM_TOKEN]
```

- `allow.network: false` 会暂缓每个要求 `network: true` 的步骤。`allow.env` 会暂缓 `requires.env`（或其 setup 的 `requires.env`）中含有未列出键的步骤。`wait.held[].missing` 指出 `policy.network` 或 `policy.env`。`~/.teamai/config.yaml` 中错误的 `allow` 会让工作流命令停止运行，直到修正为止，因此拼写错误不会解除限制。
- `sandbox: true` 表示本机会隔离它运行的内容，例如 CI 虚拟机或容器，因此本地驱动声明 `sandbox` 隔离。
- `max_parallel` 还限制本机上所有驱动同时持有同一运行的租约数。

`allow.network` 筛选步骤显式声明的网络请求。v1 的 setup 仅声明环境变量键，不会从该设置继承网络限制。如需保证 setup 和步骤都无法联网，请使用能约束每个进程的驱动和运行环境。

`env/secrets.yaml` 中声明的每个键的值（包括本机像 CI 任务那样从环境变量中获取的值），以及名称看起来像 secret 的环境变量的值，在运行文件、运行记录、每个 `teamai workflow` 输出以及本地驱动为每次 attempt 保留的 `result.json` 中都会显示为 `<REDACTED:KEY>`。`start` 拒绝包含这些值的输入，返回 `invalid_inputs`，只指出键名，不显示值。要遮蔽名称看起来不像 secret 的值（例如 `DATABASE_URL`），请在 `env/secrets.yaml` 中声明它的键。

`local` 以外的驱动在每次 `next` 的 `driver.can` 中声明它能做什么：

| `driver.can` 键 | 驱动 |
|---|---|
| `hitl` | 让人回答 HITL 请求并在交互步骤中工作。 |
| `workspace` | 接受这些工作区模式的租约：`read-only`、`new`、`continue`。 |
| `env` | `true`：自己解析 `lease.envScope.provide`，移除 `lease.envScope.withhold`，并且不把值交给运行步骤的程序。`"commands"`：只对命令步骤和 setup 这样做，所以带 `requires.env` 的提示词步骤会等待。由智能体运行步骤的驱动不要声明它；如果命令由驱动自己启动，可以发送 `"commands"`。0.28.0 之前的 teamai 对 `"commands"` 返回 `invalid_json`。 |
| `setup` | 在它创建的每个工作区以及 setup 未完成的工作区中，用 `lease.setup.envScope` 运行 `lease.setup.command`，并以上述失败码让步骤失败。工作流声明了 `setup` 时，每个带工作区的租约都携带 `setup`。 |
| `tokens` | 报告每个成功的非交互 prompt 步骤的 token。 |
| `max_turns` | 把 `lease.maxTurns` 传给它能限制的工具，对其他工具报告 `"unenforced":["max_turns"]`。 |
| `network` | 能禁止步骤访问网络。 |
| `isolation` | 以此级别运行每个步骤：`none`、`worktree` 或 `sandbox`。 |

省略的键表示驱动做不到。`next` 会在 `ignored` 中列出其他键。[编程会话](workflow.md#在编程会话中运行)的 skill 驱动声明 `hitl`、所有 `workspace` 模式、`env: "commands"` 和 `setup`。它从不声明 `tokens`、`max_turns` 或 `network`，其 `isolation` 为 `none`。

## HITL（人在回路中）

HITL 包括需要人参与的 `approve`、`choose` 和 `interactive` 步骤。

`approve: <message>` 在动作前询问。`yes` 执行动作，`no` 跳过步骤；也可以单独作为无动作步骤。`choose: { message, options, default? }` 只记录选择，不运行动作。选项必须唯一、非空且不含空白。choose 不接受动作或 `required`。两个 HITL 请求都不能与 `for_each` 同用，应放在 fan-out 依赖的步骤上。消息使用与 prompt 相同的模板和就绪规则。

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

后续步骤读取 `steps.decide.choice` 和 `steps.decide.note`，也可以通过 `passes[n]` 读取历史。每个新 pass 都重新询问。无动作结局步骤上的 approve 必须得到 `yes` 才会到达结局。

必须由人直接回答的审批使用 `approve: { message: Publish?, required: true }`，永远不自动回答。`respond` 保存时间、渠道、选择和可选备注。使用 `--json` 时渠道为 `driver`。不使用 `--json` 时，stdin 是 TTY 则渠道为 `tty`；否则为 `cli`。渠道为 `cli`，或发送回答的进程运行在 agent 会话中（设置了 `CLAUDE_CODE_SESSION_ID` 这类 agent 会话变量）时，回答记录为 `agent: true`；否则为 `agent: false`。在工作流 attempt 中（设置了 `TEAMAI_WORKFLOW_ATTEMPT`），`respond` 不记录任何回答，返回 `nested_workflow`。必需审批以 `agent_in_path` 拒绝 `agent: true` 的回答，错误信息会给出用户应在自己终端里运行的命令。TTY 和这些变量只是证据，不能防止有能力创建 PTY 或取消变量的调用者。从[仪表盘](dashboard.md#工作流运行workflow-runs)回答时渠道为 `dashboard`，`agent: false`，除非 `teamai dashboard` 运行在 agent 会话中。

```sh
teamai workflow respond <run> decide build --note "Ready" --pass 1
teamai workflow resume <run>
```

`--pass` 拒绝已经被后续 pass 替代的 HITL 请求回答。同一个 pass 重复回答返回 `repeated_response`。

非 `local` 驱动使用相同的 HITL 契约。每次 `next` 请求都发送 `driver.can.hitl`，包括忙碌时的轮询。有人可以回答 HITL 请求并参与交互步骤时，将其设为 `true`。没有可租出的工作时，`next` 返回 `hitl`，包括 `run`、`step`、`pass`、`kind`、渲染后的 `message`、`options`、可选 `default`、`required`，以及 `respond` 命令模板。向该用户展示 `hitl.message` 和 `hitl.respond`，由其将 `<option>` 替换为选择后运行 `teamai workflow respond`。模板会给 `'items[0].ask'` 这样的 fan-out 步骤路径加上引号；运行时保留这些引号。`cli` 渠道只能回答可选 HITL 请求。有自己 UI 的驱动可以用 `respond --json '{"driver":{"kind":"ide","machine":"host","workspace":"/work"}}'` 提交用户的回答，包括必需审批；这会记录渠道 `driver`、`agent: false`，并在本地保留驱动身份。从 agent 会话中发送时记录为 `agent: true`，因此必需审批会拒绝它。驱动声明答案由用户在其 UI 中给出，绝不能提交 agent 自己选择的答案；与 TTY 约定一样，这只是声明，不是保护机制。

有就绪租约时优先返回租约。工具运行期间，将其 attempt id 放入 `running`，以 `canTakeLease: false` 轮询 `next`，展示返回的 HITL 请求，并停止 attempt id 出现在 `cancelled` 中的工具。只有支持 HITL 的驱动才能获取 `interactive` 租约；交互步骤会等待这样的驱动。

未声明此能力时，可以获取租约的 `next` 请求按下表处理。忙碌时的轮询保留等待中的 HITL 请求，不代为回答；驱动没有 HITL 能力时返回 `wait`。

| HITL 请求 | `auto_approve: true` | 默认 (`false`) |
|---|---|---|
| 可选 approve | `yes`，渠道 `auto_approve` | `no`，渠道 `no_hitl`，跳过 |
| 必需 approve | 失败 `hitl_required` | 失败 `hitl_required` |
| 有 default 的 choose | 选择 default，渠道 `auto_approve` | 失败 `hitl_required` |
| 无 default 的 choose | 失败 `hitl_required` | 失败 `hitl_required` |

每次无 HITL 决策和 hitl_required 失败都会向 stderr 写警告。在本地配置中与 `workflows.max_parallel` 一起设置 `workflows.auto_approve`，或给 `start --driver local`、`resume` 传 `--auto-approve`，仅对当前进程生效。没有 HITL 的驱动不能通过 JSON next 设置此覆盖。支持 HITL 的驱动忽略 `workflows.auto_approve`：用户为这次运行选择自动批准时，它在 `next` 中发送 `autoApprove: true`，终端中的本地驱动在传入 `--auto-approve` 时也这样做。此时可选 approve 和有 default 的 choose 按 `auto_approve: true` 一列回答；必需 approve 和无 default 的 choose 仍以 `hitl` 返回。本地驱动仅在有人值守的运行（见[有人值守与无人值守的运行](workflow.md#有人值守与无人值守的运行)）中、且 stdin 和 stderr 都是 TTY 时声明支持 HITL，通过 stderr 提问，接受选择及其后的可选备注，并在提问期间继续轮询。其他进程回答或取消 HITL 请求会关闭问题。交互工具占用终端时，HITL 请求提问会等待。

`interactive: true` 要求 `prompt` 或 `prompt_file`。步骤会等待支持 HITL 的驱动。没有终端时，`--driver local` 以 `busy` 停止，原因中指出 `hitl`；请在终端中运行 `resume`。本地驱动在工作目录以前台方式打开工具，继承 stdio，并把 prompt 作为第一条消息。人对仓库的修改会保留，步骤成功。设置了 `workspace: read-only` 的交互步骤和命令一样检查：改了检出目录就以 `read_only_dirty` 失败，改动留在原地。在外层步骤打开的工作区里，改动保存在 `refs/teamai/kept/<attempt>`，并从工作区移除。在自己工作区里的交互步骤仍可以改那个工作区。无头 prompt 仍然只读。终端的 Ctrl-C 和 Ctrl-\ 交给交互工具处理；SIGTERM 和 SIGHUP 会停止工具和驱动。交互工具以 0 退出且没有输出时可以不写结果文件。驱动在 prompt 运行时每两秒轮询，发现取消后停止工具。

## 重试、取消和继续运行

```sh
teamai workflow retry <run> <step>
teamai workflow cancel <run> [step]
teamai workflow resume <run> --tools default=claude
```

`retry` 接受 leased、failed 或 cancelled 步骤，也接受已回答并拒绝的 approve 和已回答的 choose。重试 HITL 请求可以更改答案，旧答案保留在 pass 历史中。它释放旧租约，以新修订号启动新 pass（本地驱动会停止正在运行的命令，并等它退出后才启动新 pass），重置依赖或读取该步骤的后续步骤，包括循环等待和 item 的 after 依赖（其中正在等待、或已回答但尚未运行的 HITL 请求会在新 pass 中重新询问），并重新打开已结算的外层工作流、item、fan-out 步骤和运行。交付 pull request 失败的步骤保留原来的 pass，只重新运行交付。如果重新打开后运行仍在进行，返回结果会包含 `resume` 命令。执行该命令继续本地运行，或让驱动轮询 `next`。每个受影响容器中未回答的跳过步骤会重新计算；范围外手动取消的步骤保持取消。无关步骤已到达的有效结局或 break 会阻止重试。

历史保留在 passes 和 archive 中，因此 `length(steps.x.passes)` 也统计失败尝试。重试循环所有者会重置其迭代数；重试范围内的其他步骤则保留所有者的计数。重试保留顶层工作流的 round，耗尽最后一轮后重试仍可能再次 `loop_exhausted`。

指定步骤的 cancel 停止 pending、waiting、leased、running 或 delivering 工作，同时停止尚未结束的后代。cancelled 属于 stopped，因此依赖步骤会跳过，除非其 if 读取取消结果来恢复；运行通常失败。取消整个运行立即以 `cancelled` 结束，不启动下一轮。cancel 不增加修订号。迟到的报告返回 `lease_cancelled`，`next.cancelled` 告诉驱动停止哪些工具。

在重试、回答、Ctrl-C 或关闭终端后，用 resume 继续本地运行。`workflow start --driver local` 在运行开始时就把运行 id 和继续它的 `resume` 命令输出到 stderr。它优先使用本机未结本地租约的工作目录，其次使用最近调用 `next` 的驱动工作目录（该驱动必须是本机本地驱动），最后使用当前目录。因此重试后即使从子目录继续，也会保留原来的本地工作目录。每个运行同时只能有一个本地驱动。重复 resume 返回 driver_running 和持有者进程号，请停止该驱动或等待；死进程留下的锁会自动回收。已结算运行返回 done。本地运行以 failed 或 cancelled 结束时退出码为 1；控制命令成功时退出码为 0，即使返回的运行状态为 failed 或 cancelled。

## 发布和认领

```sh
teamai workflow publish <run> [--sessions]
teamai workflow resume <run> [--claim]
teamai workflow resume [--next]
```

[在另一台机器上继续运行](workflow.md#在另一台机器上继续运行)介绍常见用法。本节说明具体规则。

第一次 `publish` 让本安装实例成为该运行的所有者。所有者是一个安装实例 id（保存在 TeamAI 数据目录下的 `workflows/owner.json`）加上成员的 TeamAI 用户名，与运行记录中的相同。同一成员的两个安装实例显示相同的用户名，用 id 区分它们。`publish` 输出一个信封：

```json
{"data":{"run":"<run>","publication":"published","stateRevision":1,"offered":true,"inFlight":[{"step":"fix","attempt":"<attempt>","driverKind":"local"}]}}
```

运行仍在进行时，`offered` 为 true：见[把运行留给运行器接手](#把运行留给运行器接手)。

`inFlight` 列出仍未结束的租约。认领会释放它们，所以这些步骤会重新运行。发布一个自上次发布以来没有变化的运行，返回 `"publication":"unchanged"` 和相同的 `stateRevision`，不写入任何内容。每次发布有变化的运行，都会把完整状态加入 `teamai-reports` 的历史，所以在交接运行时发布，而不是每个步骤后都发布。只有所有者能发布该运行。在另一个安装实例上，`publish` 返回 `not_owner`，不做任何改动。

已发布的运行结束时（通过 `next`，或通过 `workflow respond`、`retry`、`cancel`），teamai 会像 `workflow publish` 一样发布它的结束状态。被拒绝时，`next` 的 `done` 信封，或该命令的 `data`，会带上 `notPublished`，内容是下表中的一个拒绝。`not_owner` 表示另一个安装实例认领了该运行，所以它的状态和运行记录保持那个安装实例的样子。其他拒绝按其下一步处理。之后对该运行的 `next` 或 `workflow resume` 也会再次发布结束状态。

`resume` 根据本机已有的内容决定怎么做：

- 本机有、且从未发布过的运行在本地继续。`resume` 不读取 `teamai-reports`。
- 第一次发布没有到达 `teamai-reports` 的运行也在本地继续。`resume` 会读取 `teamai-reports` 来确认，读不到时返回 `reports_unreachable`。
- 本机没有的运行从 `teamai-reports` 认领，然后运行。
- 已发布的运行只在本安装实例拥有它时继续。否则 `resume` 返回 `not_owner`，带 `owner`（`id`、`user`）和 `ownedAt`。
- 认领一个已结束的运行，不会重新运行它的任何步骤。认领的安装实例成为该运行的所有者，所以在那里执行 `workflow retry` 只重新运行指定的步骤和依赖它的步骤。
- `--claim` 从所有者那里接管已发布的运行，并替换本机的运行副本。本机有该运行的本地驱动正在运行时，它返回 `driver_running`，不认领任何内容。

在该运行的业务仓库的检出目录中执行 `resume`。认领仍在运行的运行时，会用 `git ls-remote` 检查该运行的分支在这个检出目录的 `origin` 上，并且停在运行记录的提交上。它从不 fetch 到这个检出目录。已结束的运行不需要它的任何分支，所以即使合并后分支已被删除，认领也会成功，`resume` 会报告它的结束结果。如果重试重新打开了它，下一次 `resume` 会 fetch 它需要的分支。本机的工作流缓存与运行所用的工作流不同时，认领会在运行的团队提交上读取它们（团队仓库没有该提交时先 fetch），并在 stderr 输出 `[team commit <commit>] Synced N workflows`。你的缓存和团队仓库检出目录保持不变。

发布的状态是 `teamai-reports` 上的 `workflows/runs/<run>/state.json`。它包含运行继续所需的内容：状态、输入、每个步骤的结果、输出、pass 和带备注的 HITL 回答、基准、每个工作区的提交，以及步骤继续过的每个会话副本的工具和 id。工作流本身只以 `sourceHash`、`definitionHash` 和 `teamRevision` 传递。它不包含步骤和 pass 的 `message`、每个租约和回答的驱动身份（租约保留驱动类型）、工作区所有者，以及业务检出目录的路径。每条失败消息都换成 `The details stay on the machine that ran this step.`，失败的 `code` 保留。提交只以完整 id（40 或 64 位十六进制）出现。`publish` 用 TeamAI 的密钥规则、本进程环境变量里的密钥，以及团队在 [`env/secrets.yaml`](sharing.md#env环境变量) 中声明的每个密钥的值（无论名称如何）检查每个值和键，遇到第一个匹配就以 `secret_detected` 拒绝。声明的值短于 8 个字符时只按完整单词匹配，短于 4 个字符时不检查，`publish` 会给出警告并写明它的名称。拒绝信息写明步骤、字段和密钥类型，从不包含值本身。本机的绝对路径同样以 `local_path_detected` 拒绝：Windows 盘符或共享路径、`~/` 路径、`file://` URL，以及第一级目录存在于本机根目录下的 `/` 路径，例如 `/Users/alice/data.csv`。URL、`src/main.ts` 这样的相对路径和 `/api/v1` 这样的路由可以发布。这样的运行不能交接，请在本机继续，或改用相对于仓库的路径重新启动它。

`--sessions` 还会把未结算步骤将要继续的每个 agent 会话的最新副本（`session: continue` 或 `session.from`）放进 `teamai-reports` 上的团队会话归档，并像 `teamai session push --scrub` 一样脱敏。这包括循环即将再次运行的步骤，以及尚未开始的工作流步骤里的步骤。已结算步骤的会话和更早 pass 的会话从不包括在内。信封随后在 `sessions` 中以 `{"tool","id"}` 列出它们，没有时为空列表。本机读不到的会话不归档：其所在的链归档本机能读的最新会话，`skipped` 列出被跳过的较新会话。整条链都读不到时，发布被拒绝。会话在写入状态之前归档，所以之后被拒绝的发布仍会留下已归档的会话，没有变化的发布也照样归档。在接着运行的机器上，本地驱动按以下顺序恢复步骤的会话：

1. 本机上的会话。步骤的工具与会话的工具相同时按 id 恢复，否则得到它的一份副本。
2. 归档会话的副本。副本只写一次，之后的恢复会复用它，包括后来加入的对话轮次。驱动按认领同步后的样子读取 `teamai-reports` 上的归档。旧版 teamai 归档在默认分支上的会话，按团队仓库的 origin 上的样子读取，每次驱动运行 fetch 一次，所以你不需要先执行 `teamai pull`，你的团队仓库克隆也保持不变。fetch 失败时，驱动读取你的克隆，并说明它可能比 origin 旧。
3. 如果该会话是另一个步骤做出的副本，而前两种方式都拿不到它，就对这个副本所继续的会话用同样两种方式，依此类推直到最初的会话。这时步骤会缺少拿不到的那些副本中的对话轮次。
4. 新会话，并在 stderr 输出以 `⚠ Step "<id>" starts a new <tool> session:` 开头的警告，说明上述每种方式为什么失败。

步骤的工具需要在那台机器上有自己的会话存储，例如 Claude Code 的 `~/.claude/projects`，和 `teamai session restore` 一样。OpenCode 会得到归档的会话，但它的步骤仍然开一个新会话，因为 OpenCode 没有恢复会话的参数。

租约的 `session` 在 `earlier` 中按从新到旧列出它所继续的会话，供拿不到该会话本身的驱动使用。`local` 以外的驱动如果继续了租约的 `session` 或 `earlier` 中的某个会话（按 id 或在副本中），要在上报中把它继续的那个会话作为 `resumed`（`{"tool","id"}`）放在它运行的 `session` 旁边。新开会话时不带 `resumed`。没有 `resumed` 时，后续步骤恢复租约的会话，而不是副本。缺少工具或 id 的 `resumed`、出现在不恢复会话的步骤上的 `resumed`，或指向租约未提供的会话（既不是它的 `session`，也不在 `earlier` 中）的 `resumed`，都返回 `invalid_report`。

每个拒绝都是一个 JSON 信封，带 `error.code`、`error.message` 和下表列出的额外字段。命令以退出码 1 结束。

| 代码 | 发生了什么 | 下一步 |
|---|---|---|
| `not_owner` | 另一个安装实例拥有该运行。带 `owner` 和 `ownedAt`。 | 联系所有者，或用 `resume <run> --claim` 接管。 |
| `state_moved` | 本机准备认领或发布期间，运行发生了变化：认领时在 `teamai-reports` 上，发布时在本机上。没有认领或发布任何内容。 | 再认领一次，或再发布一次。 |
| `state_conflict` | `teamai-reports` 上的状态比本机上次看到的更新。 | 执行 `resume <run>` 取得已发布的状态。 |
| `run_not_published` | 没有人发布过该运行。 | 在有这个运行的机器上发布它。 |
| `run_not_found` | 本机没有这个 id 的运行。 | 检查 id。 |
| `run_unreadable` | 本机的运行文件无法读取。 | 检查 TeamAI 数据目录中的运行文件。 |
| `run_mismatch` | 本机有一个 id 相同、但开始时间不同的运行。带 `localCreatedAt` 和 `remoteCreatedAt`。 | 两个运行都不会被改动。它们是不同的运行。 |
| `invalid_run` | id 不是 `r` 加 8 或 16 位十六进制数字。 | 检查 id。 |
| `unsupported_repo` | 团队仓库是 `http` 仓库，没有 `teamai-reports`。 | 在有这个运行的机器上继续。 |
| `busy` | 另一个 teamai 进程正在写 `teamai-reports` 或该运行，或者 `next --prepare` 要准备的位置被另一个未结束的 attempt 占用。 | 重试；位置被占用时，等那个 attempt 报告后再试。 |
| `reports_unreachable` | 无法从团队仓库的 origin 读取 `teamai-reports`。 | 检查网络连接后重试。 |
| `reports_failed` | 写入 `teamai-reports` 失败。 | 重试。 |
| `records_pending` | 运行记录没有到达 `teamai-reports`：git 推送出错、另一个写入方占用，或发布期间有记录排队。 | 重试。 |
| `definition_mismatch` | 认领拿不到运行所用的工作流。可能带 `teamRevision`。 | 按消息操作：等另一台机器推送工作流后执行 `teamai pull`，fetch 该团队提交，或两台机器使用相同的 teamai 版本。 |
| `snapshot_unsupported` | 状态中有一个字段（`field` 给出）快照格式无法承载，或当前 teamai 无法读取。 | 认领时，更新 teamai 后重试。发布时，修复写入该值的驱动，例如不是完整 id 的提交。 |
| `secret_detected` | 某个值看起来像密钥。带 `step`（位于步骤中时）、`field` 和 `label`。 | 在本机继续该运行。 |
| `local_path_detected` | 某个值包含本机的绝对路径。带 `step`（位于步骤中时）和 `field`。 | 在本机继续该运行，或改用相对于仓库的路径重新启动它。 |
| `sessions_not_archived` | 本机读不到某条链的所有会话（或其工具不是 teamai 能读取的）、归档被占用，或提交或推送失败。 | 再发布一次，或不加 `--sessions` 发布，让这些步骤开新会话。 |
| `origin_unavailable` | 无法读取或更新业务仓库的 origin。 | 在该运行的业务检出目录中执行命令，并确保能访问它的 origin。 |
| `commit_missing` | 记录的分支不在 origin 上，发布时落后于记录的提交，或本检出目录缺少基准提交，无法固定基准。带 `branch` 和 `commit`。 | 在有该提交的机器上推送分支。发布时，消息会给出要执行的 `git -C <checkout> push origin <commit>:refs/heads/<branch>`。或在运行开始时所在的检出目录中发布。 |
| `branch_diverged` | origin 上的某个分支包含运行不知道的工作。带 `branch`、`expected` 和 `actual`。 | 发布时，让推送它的驱动上报它，或把 origin 上的分支移回记录的提交。认领时，消息里写明的成员可以再发布一次该运行；把分支移回会丢弃记录的提交之后的提交。 |

认领之后，如果本地分支无法移到运行记录的提交，`resume` 也可能返回 `branch_diverged`。消息里写明工作区和该怎么做。见[在自己的驱动里使用工作区](#在自己的驱动里使用工作区)。

### 把运行留给运行器接手

[把运行交给运行器](workflow.md#把运行交给运行器)介绍常见用法。发布运行中的运行时，会把 `repository` 和 `offered` 写进发布状态 `workflows/runs/<run>/state.json` 的头部：

```text
{"snapshot":1,"run":"r482011be75fd0ad9","owner":{"id":"4c514375-352d-44ad-83f9-9f7a06a25e3f","user":"alice"},"ownedAt":"2026-10-28T00:26:39.443Z",
 "repository":"github.com/acme/web-app","offered":{"at":"2026-10-28T00:26:39.443Z"},"stateRevision":1,"write":"4f071543-…", …the run's state}
```

`repository` 是业务仓库，从检出目录的 `origin` 读取，形如 `host/owner/repo`。之后的认领会保留它。`offered` 保留到被认领为止：每次认领都在更换所有者的同一次写入中去掉它。已结束的运行不会待接手，从没有 `origin` 的目录发布的运行也不会，因为 `--next` 按仓库接手运行。不支持待接手的 teamai 版本发布的运行不带这两个字段，`--next` 从不接手它。

`teamai workflow resume --next` 像 `teamai pull` 一样 fetch `teamai-reports`，然后从最早待接手的运行开始逐个尝试。它跳过本安装实例发布的运行、`repository` 与本检出目录的 `origin` 不同的运行、调用方不能接手的运行、本机无人回答时剩余步骤需要人参与的运行，以及剩余步骤需要本机所缺之物的运行。无人值守的运行中无人回答，使用本地驱动且没有终端时也无人回答。本机可能缺少的东西：

| 剩余步骤 | 本机缺少的情况 | 列出的补救 |
|---|---|---|
| 带 `requires.env` 的步骤或其 `setup` | 某个键在本机没有值，或读不到团队 env | 团队已声明的键用 `teamai env set <KEY>`，其余在环境中设置 |
| 提示词步骤，使用本地驱动 | `--tools`、`workflows.tools` 和你的 AI 工具都没有为其 agent 指定工具，或只指定了 teamai 不启动的工具 | `--tools default=<tool>`（或 `<agent>=<tool>`），或 `workflows.tools.default` |
| 提示词步骤，使用本地驱动 | 指定的工具不在 `PATH` 上 | 安装它，或用 `--tools` 指定一个在 `PATH` 上的工具 |

已经彻底结束的步骤不计入以上任何一项，与需要人参与的判断相同。使用 `--driver skill` 时由会话运行提示词步骤，所以只看 env。它像 `resume <run>` 一样认领剩下的第一个运行，并用 `--driver` 指定的驱动驱动它。被另一个运行器抢先的认领在 `--next` 内部返回 `state_moved`，`--next` 随后尝试下一个运行。它在 stderr 上说明为何留下本仓库的每个待接手运行：`Left <run> (<workflow>) offered for a person: …`，或警告 `Left <run> (<workflow>) offered: <本机缺少什么>: <怎样补上>`。没有可接手的运行时，它输出 `{"data":{"idle":{"offered":N}}}` 并以 0 退出：`N` 是它跳过的、由其他安装实例设为待接手的运行数。

谁能接手待接手的运行，像 `resume` 一样取决于工作流的 `invoke`：

| `--next` 的调用方 | `invoke: allow` | `invoke: ask` | `invoke: deny` |
|---|---|---|---|
| 作业或终端，不在 agent 会话中 | 接手 | 接手 | 接手 |
| 有人值守的 agent 会话 | 接手 | 带 `--confirmed` 时接手 | 跳过（`invoke_denied`） |
| 无人值守的 agent 会话 | 接手 | 跳过 | 跳过 |

`--driver skill` 总是算作 agent 会话，还会跳过只有本地驱动能运行的运行（`needs_local_driver`）。这样被跳过的运行在列表中显示拒绝的代码，或显示为 `needs the local driver`。

不带运行 id 的 `teamai workflow resume` 在同样的 fetch 之后，列出本检出目录所属业务仓库的待接手运行，以及本机仍在运行的运行，每个只列一次。`STATUS` 为 `running`、`needs a person`（由人用 `resume <run> --claim` 接管）、`cannot run here`（附本机缺少什么、怎样补上）、`needs the local driver`、`claimed`（另一个安装实例接手了你的运行）、`succeeded`、`failed` 或 `cancelled`（你的运行已在接手它的安装实例上结束，`--claim` 把它的结束状态带到本机），或其他拒绝的代码。没有 origin 的检出目录不列出待接手运行，因为 `--next` 在那里不接手任何运行。fetch 失败时，它给出警告，并列出上一次 fetch 看到的内容。

| 代码 | 发生了什么 | 下一步 |
|---|---|---|
| `invalid_arguments` | `--next` 和运行 id 一起传入，或和 `--claim` 一起传入。 | 只传其中一个：运行 id，或 `--next`。 |
| `unsupported_repo` | 团队仓库是 `http` 仓库，没有 `teamai-reports`。 | 使用 git 团队仓库。 |
| `origin_unavailable` | 本检出目录没有 `origin`，因此没有可匹配的业务仓库。 | 在业务仓库的检出目录中执行。 |
| `reports_unreachable` | 无法 fetch `teamai-reports`。没有认领任何运行。 | 检查网络连接后重试。 |

### 从 CI 发布

用 `--driver local` 运行工作流的 CI 任务可以在运行失败时发布它，让成员在自己的机器上继续。任务在运行开始时所在的检出目录中发布。`publish` 把运行的基准以 `teamai/<run>/base` 推送到业务仓库的 origin，只推一次且不强制推送，并用 `git ls-remote` 读取运行在那里的分支。因此任务的 token 需要业务仓库的推送权限：在 GitHub Actions 上是 `permissions: contents: write`。为来自 fork 的 pull request 运行的工作流只拿到只读 token，无法发布。任务还需要团队仓库的写权限，因为 `teamai-reports` 在团队仓库里。

### 在自己的驱动里认领

`local` 以外的驱动在第一次 `next` 的 payload 中加上 `"claim": true` 来认领运行：

```text
teamai workflow next <run> --json '{"claim":true,"driver":{"kind":"script","machine":"runner","workspace":"/work"}}'
```

和所有认领一样，这个认领会撤下运行的待接手状态。对已被另一个安装实例认领的运行，不带 `claim` 的 `next` 在本机的 `teamai-reports` 检出显示这次认领后（`teamai pull` 或 `workflow resume` 之后）返回 `not_owner`，而不是从本机过时的副本租出步骤。认领在 `next` 租出任何步骤之前执行，并在 `driver.workspace` 的 origin 上检查仍在运行的运行的分支。随后它像 `resume` 一样，把每个本地分支移到运行记录的提交，无法移动时返回 `branch_diverged`。本安装实例已经拥有的运行保持原样，但不再留给运行器接手。认领被拒绝时，作为 `next` 的错误信封返回。从 agent 会话发出时，认领像 `resume` 一样遵循运行的 `invoke`：payload 无法带上本人的同意，所以 `ask` 运行返回 `confirm_needed`，本人同意后，会话用 `teamai workflow resume <run> --claim --confirmed` 继续它。遇到 `state_moved` 时，再发送一次认领。非布尔值返回 `invalid_json`，消息为 `claim must be a boolean`。运行可能被其他机器继续的驱动，要在 `changes` 和 `read` 中上报完整的提交 id。`publish` 遇到其他形式的提交值时以 `snapshot_unsupported` 拒绝，并写明字段。

## 在自己的驱动里使用工作区

`local` 以外领取工作区租约的驱动，要把运行的提交放在其他驱动或其他机器能找到的地方。每个驱动都遵守两条规则：

1. 从 `workspace.start` 开始一个步骤、合并 `workspace.merge` 里的一项，或从 `workspace.configCommit` 恢复 agent 文件之前，先用 `git cat-file -e <commit>^{commit}` 检查检出目录里有没有这个提交。缺少时，用 refspec `+refs/heads/teamai/<run>/*:refs/remotes/origin/teamai/<run>/*` 取回这次运行的分支，再检查一次。refspec 没有匹配到任何分支时，fetch 也会成功，所以只有第二次检查算数。仍然缺少的提交会让步骤在运行任何内容之前以 `workspace_base` 失败，消息里写明该提交和它所在的分支。
2. 检出目录有 `origin` 时，驱动在发送报告之前推送 `changes` 里报告的提交所在的分支，步骤失败时也一样。推送失败时，这些提交仍然会被报告。成功的步骤随后以 `push_failed` 失败。本身已失败的步骤保留自己的失败，消息里再补充该分支没有推送。

`src/workflow/conformance/git.ts` 里的 `workflowGitConformanceScenarios` 在一个 bare `origin` 上检查这两条规则。像 `src/__tests__/workflow-git-conformance.test.ts` 对 `local` 所做的那样，用它们检查你的驱动。

继续一个[已发布的运行](#发布和认领)的驱动同样依赖这些规则：

- `publish` 把运行的基准以 `teamai/<run>/base` 固定在 `origin` 上，所以规则 1 的 fetch 也会取回基准提交。
- 认领之后，驱动在继续一个本地已有的工作区之前，先把该分支向前移到运行记录的提交。本地分支领先于该提交或与它分叉、worktree 有改动或不在该分支上、或被只读步骤留下且尚未恢复时，驱动拒绝，什么都不移动。本地驱动在每次认领后、第一次租约前做一次这项检查，并以 `branch_diverged` 返回，说明该怎么做。
- 认领带来的工作区在某个驱动租下其中的步骤之前没有所有者。该驱动成为它的所有者。
- 另一台机器在一个自己打开工作区的步骤上持有的租约，会作为该步骤的下一个 pass 重新开始，使用新分支。旧分支和推送到它上面的内容留在 `origin` 上。该步骤会重新询问它的 HITL 问题。其他步骤上的租约被释放，并在同一个 pass 中重新运行。

### 让 TeamAI 准备工作区

驱动可以把工作区及其 git 操作交给 TeamAI。`next <run> --prepare --json '<payload>'` 领取一个步骤并准备它的工作区：在运行启动时所在的检出目录中创建或复用 worktree，应用基线 agent 文件和团队资源，并以 `lease.cwd` 返回该目录。再次准备会保留已有的编辑。在 `lease.cwd` 中运行步骤，不要在那里运行 git。两个 attempt 从不共用一个位置，而检出目录是同一个位置，所以在检出目录中工作的步骤即使可以并行，也会依次运行：租约的位置被另一个未结束的 attempt 占用时，返回 `busy`，attempt 仍保持租约；等那个 attempt 报告后，用 `--attempt` 准备它。setup 按驱动在 `next` 上发送的 `runMode` 运行；没有发送时，按调用 `next --prepare` 的进程的模式运行（见[有人值守与无人值守的运行](workflow.md#有人值守与无人值守的运行)），而不是运行启动时的模式。

之后由 `report` 完成这个 attempt。它负责 commit、push，并自己填写 `changes` 或 `read`，所以已准备的 attempt 的报告如果带有 `changes` 或 `read`，会返回 `invalid_report`。TeamAI 只在接受了成功报告且回复允许 cleanup 后才删除 worktree。失败的 attempt 保留其工作，以便重试。

要准备驱动已经领取的 attempt，运行 `next <run> --prepare --attempt <attempt>`。运行不再把该 attempt 租给这个驱动时，返回 `wrong_attempt`。加上 `--adopt <dir>` 时，attempt 改在宿主创建的位置运行：该仓库的一个干净 worktree，位于租约的工作区分支上，或分离在其起点，就像 `git worktree add` 创建的那样。不符合的位置返回 `adopt_mismatch`，attempt 仍保持租约。TeamAI 在那里像在自己的 worktree 中一样 commit 和 push，但从不删除该位置。

TeamAI 为准备 attempt 记录的内容只保存在本机：路径和文件指纹，不含提示词、env 值或图。

## 在自己的驱动里评审

```text
teamai score --next --json '{"driver":{"kind":"script","machine":"runner","workspace":"/work","can":{"judge":{"isolation":"best-effort","tools":["claude"]}}},"running":[]}'
```

评审任务来自 `teamai score --next`，从不来自 `workflow next`。见[评分器](scorers.md#任意-driver)。

无人值守的 driver 以 `teamai score --drain` 结束。它评判本机能评判的工作，发布运行记录、标签和会话，并输出留给其他 driver 的工作。本地驱动在无人值守运行结束时执行它（无人值守会话的发布和评判都设为 `off` 时除外）：先在 stdout 输出运行的 `done` 信封，再在 stderr 输出 drain 的各行。退出状态仍是运行本身的结果，drain 失败时也一样。见[无人值守任务结束前运行 drain](scorers.md#无人值守任务结束前运行-drain)。
