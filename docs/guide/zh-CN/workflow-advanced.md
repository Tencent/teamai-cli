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
3. 按文件顺序租出第一个就绪的步骤。子工作流的步骤位于运行它的那个步骤的位置。需要 `driver.can.workspace` 未列出的工作区模式的步骤，或使用其他驱动打开的工作区的步骤，会被暂缓，改为租出下一个就绪的步骤。
4. 每个就绪的步骤都已租出时，返回 `wait`，`reason` 指出第一个未结租约。每个就绪的步骤都被暂缓时，`reason` 逐一列出它们，以 `; ` 分隔。

不发送 `running` 的驱动每次调用都会拿回自己的未结租约，因此一次只运行一个步骤。

`"canTakeLease":false` 不发放新租约，但对声明了 `driver.can.hitl` 的驱动仍返回 HITL 请求。返回的是 `done`、一个 `running` 没有列出的未结租约、`hitl` 或 `wait`。没有任何租约和 HITL 请求时，`wait` 的 reason 是 `canTakeLease is false`。驱动没有空位运行新步骤时，可以用它来得知是否已到达结局。这个 `wait` 并不表示没有剩余的步骤可运行，所以驱动有空位后要再次调用 `next`。第 2 步仍可能交还一个驱动没有空位运行的未结租约，所以要为驱动尚未启动的租约维护一个队列。

`next` 的每个 `data` 返回都带 `cancelled`。它列出 `running` 中已经不再是本驱动未结租约的 attempt。请停止这些进程。`error` 返回不带 `cancelled`。

`running` 或 `canTakeLease` 格式不对时，返回 `invalid_json`，消息为 `running must be an array of attempt ids` 或 `canTakeLease must be a boolean`。一个驱动持有租约时，其他驱动会收到 `wait`，`reason` 指出那个租约。

`report` 按每次上报自己租约的 revision 检查，而不是按运行最新的 revision。上例中 `next` 在 revision 1 租出了两个租约。`test` 以 `"revision":1` 上报后，运行变为 revision 2。`lint` 以 `"revision":1` 上报仍会被接受，运行变为 revision 3。未结租约以其他 revision 上报时返回 `stale_revision`：

```text
{"error":{"code":"stale_revision","message":"Revision 2 is stale; attempt ae75cb049 was leased at 1"}}
```

### 并行运行本地命令

`--driver local` 最多同时运行 `workflows.max_parallel` 个命令步骤。在本地配置中设置它。默认值是 1，没有对应的命令行参数。

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

为 1 时，驱动一次运行一个步骤，命令在你的终端里运行，Ctrl-C 会直接到达它。

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

必须由人直接回答的审批使用 `approve: { message: Publish?, required: true }`，永远不自动回答。`respond` 保存时间、渠道、选择和可选备注。使用 `--json` 时渠道为 `driver`，`agent: false`。不使用 `--json` 时，stdin 是 TTY 则渠道为 `tty`，`agent: false`；否则为 `cli`，`agent: true`。必需审批以 `agent_in_path` 拒绝 cli 回答。TTY 是渠道约定，不能防止有能力创建 PTY 的调用者。从[仪表盘](dashboard.md#工作流运行workflow-runs)回答时渠道为 `dashboard`，`agent: false`。

```sh
teamai workflow respond <run> decide build --note "Ready" --pass 1
teamai workflow resume <run>
```

`--pass` 拒绝已经被后续 pass 替代的 HITL 请求回答。同一个 pass 重复回答返回 `repeated_response`。

非 `local` 驱动使用相同的 HITL 契约。每次 `next` 请求都发送 `driver.can.hitl`，包括忙碌时的轮询。有人可以回答 HITL 请求并参与交互步骤时，将其设为 `true`。没有可租出的工作时，`next` 返回 `hitl`，包括 `run`、`step`、`pass`、`kind`、渲染后的 `message`、`options`、可选 `default`、`required`，以及 `respond` 命令模板。向该用户展示 `hitl.message` 和 `hitl.respond`，由其将 `<option>` 替换为选择后运行 `teamai workflow respond`。模板会给 `'items[0].ask'` 这样的 fan-out 步骤路径加上引号；运行时保留这些引号。`cli` 渠道只能回答可选 HITL 请求。有自己 UI 的驱动可以用 `respond --json '{"driver":{"kind":"ide","machine":"host","workspace":"/work"}}'` 提交用户的回答，包括必需审批；这会记录渠道 `driver`、`agent: false`，并在本地保留驱动身份。驱动声明答案由用户在其 UI 中给出，绝不能提交 agent 自己选择的答案；与 TTY 约定一样，这只是声明，不是保护机制。

有就绪租约时优先返回租约。工具运行期间，将其 attempt id 放入 `running`，以 `canTakeLease: false` 轮询 `next`，展示返回的 HITL 请求，并停止 attempt id 出现在 `cancelled` 中的工具。只有支持 HITL 的驱动才能获取 `interactive` 租约；没有 HITL 的驱动会以 `hitl_required` 失败。

未声明此能力时，可以获取租约的 `next` 请求按下表处理。忙碌时的轮询保留等待中的 HITL 请求，不代为回答；驱动没有 HITL 能力时返回 `wait`。

| HITL 请求 | `auto_approve: true` | 默认 (`false`) |
|---|---|---|
| 可选 approve | `yes`，渠道 `auto_approve` | `no`，渠道 `no_hitl`，跳过 |
| 必需 approve | 失败 `hitl_required` | 失败 `hitl_required` |
| 有 default 的 choose | 选择 default，渠道 `auto_approve` | 失败 `hitl_required` |
| 无 default 的 choose | 失败 `hitl_required` | 失败 `hitl_required` |

每次无 HITL 决策和 hitl_required 失败都会向 stderr 写警告。在本地配置中与 `workflows.max_parallel` 一起设置 `workflows.auto_approve`，或给 `start --driver local`、`resume` 传 `--auto-approve`，仅对当前进程生效。JSON next 不能设置此覆盖。本地驱动仅在 stdin 和 stderr 都是 TTY 时声明支持 HITL，通过 stderr 提问，接受选择及其后的可选备注，并在提问期间继续轮询。其他进程回答或取消 HITL 请求会关闭问题。交互工具占用终端时，HITL 请求提问会等待。

`interactive: true` 要求 `prompt` 或 `prompt_file`。没有 HITL 的驱动以 `hitl_required` 失败。本地驱动在工作目录以前台方式打开工具，继承 stdio，并把 prompt 作为第一条消息。人对仓库的修改会保留，步骤成功。设置了 `workspace: read-only` 的交互步骤和命令一样检查：改了检出目录就以 `read_only_dirty` 失败，改动留在原地。在外层步骤打开的工作区里，改动保存在 `refs/teamai/kept/<attempt>`，并从工作区移除。在自己工作区里的交互步骤仍可以改那个工作区。无头 prompt 仍然只读。终端的 Ctrl-C 和 Ctrl-\ 交给交互工具处理；SIGTERM 和 SIGHUP 会停止工具和驱动。交互工具以 0 退出且没有输出时可以不写结果文件。驱动在 prompt 运行时每两秒轮询，发现取消后停止工具。

## 重试、取消和继续运行

```sh
teamai workflow retry <run> <step>
teamai workflow cancel <run> [step]
teamai workflow resume <run> --tools default=claude
```

`retry` 接受 leased、failed 或 cancelled 步骤，也接受已回答并拒绝的 approve 和已回答的 choose。重试 HITL 请求可以更改答案，旧答案保留在 pass 历史中。它释放旧租约，以新修订号启动新 pass（本地驱动会停止正在运行的命令，并等它退出后才启动新 pass），重置依赖或读取该步骤的后续步骤，包括循环等待和 item 的 after 依赖（其中正在等待、或已回答但尚未运行的 HITL 请求会在新 pass 中重新询问），并重新打开已结算的外层工作流、item、fan-out 步骤和运行。如果重新打开后运行仍在进行，返回结果会包含 `resume` 命令。执行该命令继续本地运行，或让驱动轮询 `next`。每个受影响容器中未回答的跳过步骤会重新计算；范围外手动取消的步骤保持取消。无关步骤已到达的有效结局或 break 会阻止重试。

历史保留在 passes 和 archive 中，因此 `length(steps.x.passes)` 也统计失败尝试。重试循环所有者会重置其迭代数；重试范围内的其他步骤则保留所有者的计数。重试保留顶层工作流的 round，耗尽最后一轮后重试仍可能再次 `loop_exhausted`。

指定步骤的 cancel 停止 pending、waiting、leased 或 running 工作，同时停止尚未结束的后代。cancelled 属于 stopped，因此依赖步骤会跳过，除非其 if 读取取消结果来恢复；运行通常失败。取消整个运行立即以 `cancelled` 结束，不启动下一轮。cancel 不增加修订号。迟到的报告返回 `lease_cancelled`，`next.cancelled` 告诉驱动停止哪些工具。

在重试、回答、Ctrl-C 或关闭终端后，用 resume 继续本地运行。它优先使用本机未结本地租约的工作目录，其次使用最近调用 `next` 的驱动工作目录（该驱动必须是本机本地驱动），最后使用当前目录。因此重试后即使从子目录继续，也会保留原来的本地工作目录。每个运行同时只能有一个本地驱动。重复 resume 返回 driver_running 和持有者进程号，请停止该驱动或等待；死进程留下的锁会自动回收。已结算运行返回 done。本地运行以 failed 或 cancelled 结束时退出码为 1；控制命令成功时退出码为 0，即使返回的运行状态为 failed 或 cancelled。
