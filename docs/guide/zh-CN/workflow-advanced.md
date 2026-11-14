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
4. 每个就绪的步骤都已租出时，返回 `wait`，`reason` 指出第一个未结租约。每个就绪的步骤都被暂缓时，`reason` 逐一列出它们，以 `; ` 分隔，`held` 以 `{ step, reason, missing }` 列出它们。`missing` 指出驱动缺少什么，例如 `hitl` 或 `workspace.new`。因工作区被暂缓时，也会列出即使该工作区可用仍然存在的缺口；仅因其他驱动占用该工作区而暂缓时，`missing` 为空。

不发送 `running` 的驱动每次调用都会拿回自己的未结租约，因此一次只运行一个步骤。

`"canTakeLease":false` 不发放新租约，但对声明了 `driver.can.hitl` 的驱动仍返回 HITL 请求。返回的是 `done`、一个 `running` 没有列出的未结租约、`hitl` 或 `wait`。没有任何租约和 HITL 请求时，`wait` 的 reason 是 `canTakeLease is false`。驱动没有空位运行新步骤时，可以用它来得知是否已到达结局。这个 `wait` 并不表示没有剩余的步骤可运行，所以驱动有空位后要再次调用 `next`。第 2 步仍可能交还一个驱动没有空位运行的未结租约，所以要为驱动尚未启动的租约维护一个队列。

把这些租约也列在 `queued` 里，例如正在等待被占用的 checkout 的租约。这样每个租约的步骤自身超时从这次调用开始计算，等待不会耗掉它；返回的 `deadlines` 给出每个租约的新截止时间，例如 `"deadlines":{"a0ce8107f":"2026-05-01T10:12:00.000Z"}`。只有列出该 attempt 的调用才会重新开始计时，所以等待期间要持续调用 `next`，并在每次 `report` 和每次 `respond --json` 时带上同样的 `queued`，因为它们也可能让最近没有重新计时的租约超时。

`next` 的每个 `data` 返回都带 `cancelled`。它列出 `running` 中已经不再是本驱动未结租约的 attempt。请停止这些进程。`error` 返回不带 `cancelled`。

`running`、`queued` 或 `canTakeLease` 格式不对时，返回 `invalid_json`，消息为 `running must be an array of attempt ids`、`queued must be an array of attempt ids` 或 `canTakeLease must be a boolean`。一个驱动持有租约时，其他驱动会收到 `wait`，`reason` 指出那个租约。

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

`workflows.idle_timeout` 是一个时长，例如 `5m`：回答或提示词步骤的工具若这么久没有任何输出，就会被停止，步骤以 `tool_failed` 失败；不是时长的值会让步骤以 `tool_unconfigured` 失败。它只作用于边工作边输出的工具：提示词步骤中是没有终端时启动的 Claude；回答步骤中是 Claude、OpenCode 和 Codex。只在结束时才输出的工具总会达到这个限制，所以其他工具以及在终端里运行的 Claude 都没有这个限制。

当前检出目录里的提示词要等该目录空闲后才启动，结束前该目录里不会再启动别的步骤。只读检查比较的是这个检出目录在提示词前后的状态。`workspace: new` 的提示词在自己的 worktree 里运行，因此可以和其他 worktree 里的步骤重叠，上限是 `max_parallel`。没有 `workspace` 的命令共用检出目录，并且和那里的其他步骤一次只运行一个。

`max_parallel` 大于 1 时：

- 没有 `workspace` 的命令共用检出目录，一次只运行一个。后一个命令能看到前一个留下的文件。`workspace: new` 的命令使用各自的 worktree，可以一起运行。
- 每个命令都在没有终端的情况下运行，因此无法读取你的输入。
- 收到 Ctrl-C，或 SIGTERM、SIGQUIT、SIGHUP 时，teamai 停止所有命令，等它们退出，然后以该信号退出。

为 1 时，驱动一次运行一个步骤，命令在你的终端里运行，Ctrl-C 会直接到达它。只发给 teamai 的 SIGTERM 或 SIGHUP 会停止命令，等它退出，然后以该信号退出。teamai 没有终端时（例如在 CI 里），或作为后台作业运行时，命令也没有终端，和 `max_parallel` 大于 1 时一样。

未设置 `max_parallel` 时，驱动仍然一次运行一个步骤，只有声明了 `max_parallel` 的 `for_each` 的各项例外：它们并排运行，最多为该数目。这些项运行期间不会启动其他步骤；没有 `max_parallel` 的 `for_each` 一次只运行一项。含有这种 `for_each` 的运行按 `max_parallel` 大于 1 的方式运行：命令没有终端，Ctrl-C 会停止所有命令。answer 项和没有 `workspace` 的命令项共用检出目录，一次只运行一个，即使 fan-out 允许更多并行项目。给 answer 加上 `workspace: new`，各项就能并排运行。

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
ℹ Run rb7a66009e227f202 started. If it stops before it ends, continue it here with: teamai workflow resume rb7a66009e227f202, or hand it to another machine with: teamai workflow publish rb7a66009e227f202
{"data":{"done":{"run":"rb7a66009e227f202","outcome":"succeeded","progress":[{"step":"report","lines":["[{\"item\":\"api\",\"outcome\":\"success\",\"outputs\":{\"text\":\"HTTP routes and handlers.\"}},{\"item\":\"cli\",\"outcome\":\"success\",\"outputs\":{\"text\":\"Command parsing and output.\"}},{\"item\":\"web\",\"outcome\":\"success\",\"outputs\":{\"text\":\"The dashboard pages.\"}}]"]}],"record":"published"},"cancelled":[]}}
```

每个回答读取自己的 worktree，所以工具同时回答 `api` 和 `cli`，然后回答 `web`；三项都完成后 `report` 才启动。其他驱动本来就会并排运行就绪的步骤，所以这一点只适用于本地驱动。

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

`max_parallel` 也可以是读取一个数字输入的模板，由启动运行的人决定上限。读取其他内容的模板，例如步骤的输出或 `item`，或在 `{{ … }}` 外加了文字的模板，pull 会拒绝。

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
ℹ Run r3112e07f9a6d93ad started. If it stops before it ends, continue it here with: teamai workflow resume r3112e07f9a6d93ad, or hand it to another machine with: teamai workflow publish r3112e07f9a6d93ad
{"data":{"done":{"run":"r3112e07f9a6d93ad","outcome":"succeeded","progress":[{"step":"describe[0]","lines":["described api"]},{"step":"describe[1]","lines":["described cli"]}],"record":"published"},"cancelled":[]}}
```

传入 `"concurrency":0`，或任何不是从 1 开始的整数的值时，启动会在运行创建前被拒绝：

```text
{"error":{"code":"invalid_inputs","message":"Step \"describe\" for_each.max_parallel {{ inputs.concurrency }} renders 0, which is not a whole number from 1. Pass a whole number from 1 for the input it reads."}}
```

某一项失败不会停止其他项。所有项都完成后，该步骤才完成，任一项失败时该步骤失败。`output` 检查每一项的输出。

`steps.<id>.results` 按项的顺序列出每一项的结果。每个条目有 `item`、`outcome`，该项有输出时还有 `outputs`：

```json
[{"item":{"id":"core","dir":"packages/core"},"outcome":"success"},{"item":{"id":"cli","dir":"packages/cli"},"outcome":"failed"}]
```

某一项在工作区里运行时，对应条目还有 `branch`。`steps.<id>.branches` 按同样的顺序列出这些分支。设置了 `deliver: pr` 的步骤中，某一项交付了 pull request 时，对应条目还有 `pr`，形如 `{ url }`。

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

## 让步骤失败而不让工作流失败

`continue_on_failure: true` 让步骤失败、超时或被取消时不会让它所在的工作流失败。该步骤仍读作 `failed` 或 `cancelled`，依赖它的步骤照常处理：需要它的步骤只有在 `if` 读取它时才会运行。在 `for_each` 步骤上，某一项失败会让该步骤失败，但不会让运行失败；该步骤超时或被取消时，会保留已结束各项的 `results`。运行工作流的步骤也可以使用它。`finally` 步骤不能使用。

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

`review[0]` 使用模型别名 `strong` 运行，`review[1]` 的模型渲染为空，因此使用工具的默认模型。某个评审失败时，`summarize` 仍会基于另一个评审运行，运行成功，`reviews` 中包含每一项。

### 只在部分失败时回退

`steps.<id>.failure` 读取步骤失败的原因：它的 `code` 和 `message`。步骤没有失败时为 `null`。回退步骤读取它，只处理它要处理的失败，其他失败照样失败：

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

工具超时或出错退出时，`keep` 运行，运行成功。`TEAMAI_AI_TOOL` 或 `ai.tool` 指定的工具无法运行时，`stop` 让运行以 `failed` 结束，成员会看到需要修改的设置。只用 `continue_on_failure` 的话，运行会在什么都没做的情况下成功。`failure` 只读取步骤当前的 pass。租约渲染的模板（如 `model` 或受限目录）和 `writes` 模板不能读取它，就像它们不能读取 `outcome` 一样。

退出码为 65（`EX_DATAERR`）的命令步骤以 `input_rejected` 失败：它拒绝了收到的输入。teamai 不提示重试它，因为同样的输入会以同样的方式失败。其他非零退出码以 `command_failed` 失败，其 message 写明退出码，后面接命令 stderr 的开头：

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

`npm test` 以 1 退出并输出 `2 tests failed` 时，`report` 输出 `Tests failed: command exited with status 1: 2 tests failed`。

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

副本里的循环会保留它在那里做的每个提交，即使最后一个 pass 被跳过。下面每个条目在条目自己的分支上实现一个任务并修复它。`open-pr` 从两个条目及其修复开始：

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

当 `api` 的第一次测试失败时，运行过程如下：

```text
tasks[0].implement   teamai/<run>/tasks-0/p1   写入 1a2b3c4
tasks[0].test        读取 1a2b3c4              失败
tasks[0].fix         teamai/<run>/tasks-0/p1   写入 5d6e7f8
tasks[0].test        读取 5d6e7f8              通过，因此跳过 fix，循环结束
tasks[1].implement   teamai/<run>/tasks-1/p1   从 5d6e7f8（修复后的 api）开始
open-pr              teamai/<run>/open-pr/p1   从 5d6e7f8 开始并合并 tasks-1
```

`implement` 和 `fix` 没有设置 `workspace`，所以它们继续条目的分支，`test` 读取同一个分支。

### 读取每一个 pass

步骤的每次运行是一个 pass，从 1 开始编号。租约带有它的 `pass`。在 `loop-implement-task` 的一次运行中，`e2e` 的第二个租约是：

```text
{"data":{"lease":{"run":"rd50c3422","step":"e2e","attempt":"a54df2231","revision":4,"pass":2,"command":"npm run test:e2e"},"cancelled":[]}}
```

`steps.<id>.outcome`、`steps.<id>.end` 和 `steps.<id>.outputs` 读取最新的 pass。`steps.<id>.passes` 列出该步骤的每个 pass，当前 pass 完成后也包括在内。每个元素都有 `pass` 和 `outcome`，该 pass 有 `outputs`、`end` 和 `pr` 时也带上它们。`for_each` 步骤的 pass 带 `results`，没有 `outputs`，读取上一个 pass 时也如此。在 `loop-review-and-fix` 中，工作流输出 `reviews` 返回每一次审查。

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

## finally 步骤

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

`finally` 步骤在运行的步骤都结束后运行，无论它们如何结束：成功、失败、超时或被取消。它们是命令，只读，没有自己的工作区，只带 `id`、`needs`、`if`、`command`、`env`、`output` 和 `timeout`。它们运行期间，运行保持 `running`，最多 10 分钟，然后以其步骤达到的结果结束：失败的 `finally` 步骤从不改变它。`done.finally` 列出每个失败或被取消的 `finally` 步骤及其失败原因。在它们运行期间执行 `workflow cancel` 会结束它们和这次运行。取消时如果没有驱动在推进这次运行（本机上的本地驱动已停止，或者从没有驱动领取它），运行会立即结束：它的 `finally` 步骤不会运行，`done.finally` 把每一个都列为已取消。带 `finally` 的工作流只能作为独立的运行运行，从不作为另一个工作流的步骤。

`done.outputs` 带工作流的顶层 `outputs`，在 `finally` 之后解析，所以它们可以读取 `finally` 步骤。所属步骤失败的输出会被省略。

```text
teamai workflow start nightly-e2e --driver local --timeout 30m
```

使用 `--driver local` 或 `--driver skill` 时，`--timeout` 把运行限制在它和文件的 `timeout` 中较短的那个。超过后运行以 `timeout` 失败，它的 `finally` 步骤仍会运行。

## 给输入设默认值

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

只传 `{"test":false}` 的启动漏了没有默认值的 `package`，因此不会创建运行：

```text
{"error":{"code":"invalid_inputs","message":"inputs.package is missing"}}
```

`defaults.inputs` 给出某个输入的值：启动或步骤的 `with` 没有传这个输入时，就用这个值。每个值必须符合该输入声明的类型，且必须是文件声明过的输入，否则 pull 会拒绝该文件。没有默认值的输入仍然必填。运行会记下它用到的值，所以 `steps.<id>.inputs` 和仪表盘会显示默认值。

这样，一个被其他团队运行的工作流可以新增输入而不破坏它们：运行它的步骤保持原来的 `with` 即可。

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

## 运行步骤打印的工作流

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

`plan` 把它的输出以 JSON 打印出来，其中包括一个工作流：

```text
{"definition":{"definition":{"schemaVersion":"v1alpha1","name":"shards","description":"One job per package.","steps":[{"id":"api","command":"npm test -w api"},{"id":"web","command":"npm test -w web"}]}},"notes":{"packages":2}}
```

| 输出类型 | 包含 |
| --- | --- |
| `workflow` | 一个 bundle：`definition`，即要运行的工作流；以及可选的 `workflows`，它运行的具名工作流。 |
| `json` | 任意 JSON 值。表达式无法读取其内部；顶层 `outputs` 可以整个传递它。 |

`workflow: { from: <step> }` 运行它 `needs` 的某个步骤的 bundle。该步骤报告时，teamai 像 `workflow start` 检查文件一样检查这个 bundle，固定它，并在运行期间保留它。无法接受的 bundle，例如包含秘密值、`from` 步骤、`prompt_file` 步骤或 `finally` 步骤的 bundle，会让产生它的步骤以 `invalid_output` 失败并给出原因。产生 bundle 的步骤只运行一次，不在任何循环或 `for_each` 中。带 `from` 步骤的运行是[隔离的](#隔离运行)。

## 让成员的 AI 工具给出回答

`answer` 是一个由成员的 AI 工具一次调用就回答的提示词，在检出目录中只读运行，没有会话和 agent。只需要模型给出一段文字或一个判断的步骤用它：

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

- 必须写 `output`。`{ text: string }` 把回答当作文字。其他 output 说明回答中的 JSON，本地驱动会向工具要这个 JSON。
- `answer_file: <file>` 从文件读取提示词，代替 `answer`：[工作流文件夹](workflow.md#工作流文件夹)里的文件，在文件夹之外则是 `prompts/` 下的文件，和 `prompt_file` 一样。它的文本和 `answer` 一样是模板。[`from` 步骤](#运行步骤打印的工作流)打印的工作流不能使用它。
- 这个步骤不指定工具，由运行它的 driver 回答。skill driver 把它交给会话的子 agent，你自己的 driver 用它自己的模型回答。local driver 启动的工具和 teamai 自己的 AI 调用相同：先看 `TEAMAI_AI_TOOL`，再看项目的 `ai.tool`，再看本机的，最后是 teamai 能启动的第一个已安装工具。pull 拒绝这个步骤上的 `tool`、`agent`、`model` 和 `session`，以及 `new` 以外的 `workspace`。
- 这次启动标记为 teamai 自己的，成员的 hooks 不会捕获它。
- 它占用检出目录直到回答结束，因此使用该目录的回答和命令依次运行，包括 `for_each` 的不同项目。修改检出目录会让回答以 `read_only_dirty` 失败。
- 加上 `workspace: new` 后，它在自己的 worktree 中回答，该 worktree 位于运行开始时的提交，因此 `for_each` 的各项最多按其 `max_parallel` 并排运行。这个 worktree 不含你未提交的改动，也不含 pull 交付给工具的文件。修改它同样会让回答以 `read_only_dirty` 失败。回答成功后 teamai 删除这个 worktree，运行成功后删除它的分支。
- 在不是 git 仓库的目录中，没有办法检查回答，所以在本地驱动上，那里的回答互不等待，无论有没有 `workspace: new`。
- 提示词没有默认超时，请给这个步骤设置一个。
- `workflows.idle_timeout` 是写在 `~/.teamai/config.yaml` 或某个工作区 `config.yaml` 里的一个时长：回答或提示词步骤的工具在这么长时间内没有任何输出时会被停止，步骤以 `tool_failed` 失败；不是时长的值会让步骤以 `tool_unconfigured` 失败。在回答步骤中，它作用于边工作边输出的 Claude、OpenCode 和 Codex；其他工具没有这个限制：

  ```yaml
  workflows:
    idle_timeout: 5m
  ```
- 没有安装工具或为该工具记录的主目录已不存在时，它以 `tool_unavailable` 失败，成员指定的工具无法运行时以 `tool_unconfigured` 失败，调用失败时以 `tool_failed` 失败，回答里没有符合其 `output` 的 JSON 时以 `invalid_output` 失败。调用能继续其会话的工具（Claude、OpenCode）会先在同一会话里、在步骤的 timeout 内被再问一次，并附上它上次的回答。

其他驱动把 answer 步骤当作带 `answer: true`、没有独立工作区的提示词租约；带 `workspace: new` 时，租约带有一个只读的 `workspace` 合约，指向它自己的分支。驱动准备租约，在 `cwd` 中回答提示词并报告 outputs；准备过程像其他只读步骤一样占用检出目录或那个 worktree，并记录快照。

## 运行中的工作流文件夹

运行会为它用到的每个[工作流文件夹](workflow.md#工作流文件夹)保留一份自己的副本：

- `workflow start` 按内容把文件夹的文件存一次，放在 TeamAI 数据目录下的 `workflows/folders/<sourceHash>/`，`$TEAMAI_WORKFLOW_DIR` 在整个运行期间都指向这份副本，之后的 pull 修改或删除什么都不影响它。哈希覆盖每个文件的路径、git 记录的可执行位，以及换行转为 LF 后的文本，因此 Windows、macOS 和 Linux 上的检出结果一致。
- `workflow publish` 不携带这些文件。另一台机器上的 `workflow resume --claim` 像重建定义一样重建文件夹：取自运行所在的团队提交；teamai 的默认工作流则取自本机 teamai 的安装包，不一致时以 `definition_mismatch` 拒绝。
- `teamai doctor --fix` 会删除本机没有任何运行、也没有任何已拉取工作流使用的已存文件夹，前提是它已存放满一小时。`doctor --fix` 已按 `workflows.retention` 清理过遗留内容的运行不再占用它的文件夹：重试不会再打开这个运行。
- 文件夹含有符号链接、不是 UTF-8 文本的文件，或总大小（包括 `README.md`）超过 1 MB 时，pull 以 `workflow_folder_invalid` 拒绝它。消息会指出那个文件；文件夹过大时列出最大的五个文件。和所有带代码的诊断一样，它也会丢弃上一个有效版本，因此修好文件夹之前该工作流没有可运行的内容。
- [受限步骤](workflow.md#限定在一个目录里的提示步骤)只能读取自己的目录，所以它的提示词提到该文件夹时 pull 会警告：`step <id> is confined and may not be able to read $TEAMAI_WORKFLOW_DIR`。
- [基准测试](benchmarks.md)的 arm 暂时不能运行工作流文件夹，也不能运行会运行文件夹的工作流，因为试验运行的是工作流的副本，不带任何文件。plan 会拒绝这样的 arm：`benchmark arms cannot run workflow folders yet`。

## 让命令在检出中写入

没有 `workspace` 的命令以只读方式运行：它在检出中留下的改动会让它以 `read_only_dirty` 失败。`writes` 列出相对于检出的路径，这些路径下的改动会被保留：

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

命令在 `docs/api/<area>/` 下写的文件留在检出中，步骤成功。它在检出当前分支上新增的提交也会保留，只要这个提交改动的每个路径都在 `writes` 之下，比如命令发布它写的内容时。其他地方的改动仍会让它以 `read_only_dirty` 失败，HEAD 的其他移动也一样：切换分支、分离 HEAD、重置。

命令写入调用方指定的目录（可能在检出之外）时，列出那个输入：

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

`teamai workflow start render-site --inputs '{"out":"/home/alice/site"}'` 渲染出一个绝对路径。它在检出之内时，其下的改动和相对路径一样被保留。它在检出之外时，命令可以随意写入：写在那里的内容不会弄脏检出。

- 只有命令步骤可以写 `writes`。
- pull 拒绝文件里直接写的绝对路径、离开检出的路径，以及读取 `inputs` 之外内容的模板。模板渲染出离开检出的相对路径或空值时，步骤在运行前以 `invalid_template` 失败。

## 克隆工作区

```yaml
  - id: try-fix
    workspace:
      clone:
        commit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
        team: { treatment: none }
    prompt: Fix the failing test.
```

带 `workspace: { clone: { commit, repo?, team } }` 的步骤在检出目录之外、`commit` 的全新克隆中运行：有自己的 git 数据，没有远程仓库，hook 关闭。`team` 指明为它安装的团队资源，安装在它自己的 home 下：`{ treatment: none }`，或 `{ revision, selection, treatment }`，其中 `treatment` 为 `pulled`、一个 ref 或 `{ without: [<path>, ...] }`，另可写 `recall: true` 来部署团队的 recall——克隆默认不部署它；这个键由 [benchmark 的 arm](benchmarks.md#开启-recall-的-arm) 设置，测量 recall 的 workflow 步骤也可以设置。`selection` 包含与你的配置同名的 `primaryRole`、`additionalRoles`、`projects`、`subscribedTags` 和 `excludedSkills`，以及 `enabledAgents`，即资源安装到的工具：默认为打开克隆的步骤的工具，否则为你启用的 agent。只要 `revision` 中存在 `manifest/members.yaml`，它就像在你的检出目录中一样决定你在克隆中的角色：`primaryRole` 或 `additionalRoles` 与它分配给你的不同时，克隆以 `clone_prepare_failed` 失败。请省略它们；要以某个角色的知识运行步骤，还需在步骤上设置 `role`。teamai 离线创建克隆，来源是运行的检出目录或提交缓存；`repo` 只指明缓存，从不是 URL。打开克隆的 workflow 步骤拥有它，供其下每个 `continue` 步骤使用。克隆中的任何内容都不会被推送或交付。[Benchmark](benchmarks.md) 会为你写出这些步骤。

### 以团队角色运行步骤

带 `workspace: new` 的提示词步骤在自己的 worktree 中以其 `role` 运行。用 `role` 打开副本的 `workflow` 步骤，会让所有延续该副本的步骤都以这个角色运行，命令步骤也一样。下例是一次代码评审，把结论写在改动旁边，然后在同一副本中检查：

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

`teamai workflow start review-change --driver local` 以 `review` 运行 `build`、`review` 和 `test`。每个步骤开始前，teamai 在数据目录的 `checkout-roles.json` 中记录副本运行时使用的角色，副本自己的 pull 按该角色交付。副本获得该角色的 skill、规则、agent、文档、wiki 和经验，加上你的项目；你的标签和 skill 排除不会过滤它。它保留你的 hook、MCP 服务器、env 和模型。在副本中运行的 `teamai pull` 或 hook 会保留该角色，步骤在那里启动的会话不会自己再 pull，那里的 `teamai recall` 读取副本自己的索引。你的检出目录和配置都不会改变，步骤的提交不包含 pull 交付的任何内容。你的 `teamai recall` 仍然返回你自己角色的知识：副本的 pull 可能移动你的索引所依据的团队仓库，因此会删除该索引，你下一次 `teamai recall` 时会重建它。

`role` 写在打开或沿用副本的提示词步骤上，写在 `workflow` 步骤上（作用于其中的步骤），或写在 `defaults` 中；优先级见[以团队角色运行步骤](workflow.md#以团队角色运行步骤)。pull 会以 `bad_role` 拒绝：命令步骤上的 `role`、不在任何副本中运行的提示词步骤上的 `role`、以不同于副本的角色沿用副本的步骤，以及没有任何副本中的步骤采用的 `role` 或 `defaults.role`。以下情况步骤会以 `role_unavailable` 失败并说明原因：没有 teamai 的项目安装管理该检出目录，`manifest/roles.yaml` 缺失、无法读取或未声明该角色，步骤的工具会从副本之外读取知识，或副本的 pull 没有按该角色交付（例如另一个 pull 占着团队的锁）。修复原因后重试该步骤。对你启用的任何工具，副本的 pull 都不会把角色的知识交付到副本之外的地方：像 Hermes 这样从你的 home 读取 skill 的工具不会得到该角色的任何内容。只有声明了 [`can.role`](#要求和限制) 并用 `next --prepare` 请求的驱动才会接这个步骤，这样角色由 teamai 交付。运行按 teamai 交付的内容记录 `agent.team.selection.stepRole`，从不采用驱动报告的值。

`for_each` 步骤可以让每一项以自己的角色运行：`role: "{{ item.role }}"`。下面的评审把 UI 改动交给前端评审，把 API 改动交给代码评审：

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

`review[0]` 在自己的副本中运行，得到 `frontend` 交付的内容；`review[1]` 在另一个副本中运行，得到 `review` 交付的内容。运行文件中每一项的步骤都记录它运行时的角色：

```json
{ "id": "review[0]", "status": "succeeded", "agent": { "team": { "selection": { "stepRole": "frontend", … } }, … } }
{ "id": "review[1]", "status": "succeeded", "agent": { "team": { "selection": { "stepRole": "review", … } }, … } }
```

角色模板只读取当前项，并且只能写在绑定了项的地方。pull 只把它当作模板检查；每一项的租约检查它给出的值。模板给出的不是字符串（例如数字，或缺少 `role`）时，该项会在工具启动前以 `role_unavailable` 失败；`manifest/roles.yaml` 未声明的角色也一样。以另一个角色沿用该项副本的步骤会在租约时以 `role_unavailable` 失败；跨两个角色恢复会话（`session.from`，或循环再次带回的 `session: continue`）的步骤会以 `bad_session` 失败。

### 以团队角色运行克隆

克隆步骤可以使用 `manifest/roles.yaml` 中的另一个角色运行，而不是你的角色。例如，让代码审查步骤知道审查者知道的内容：

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

像其他工作流一样用 `teamai workflow start review` 启动它。所有延续该克隆的步骤都使用这个角色。克隆的安装获得 `review` 和你的项目的知识：skill、规则、agent、文档、wiki 和 learnings。你可以运行的东西保持不变：你的角色的 hook、MCP 服务器、env 和模型，以及你能找到的工作流、prompt、scorer 和 benchmark。在克隆中运行的 `teamai pull` 或 hook 保留这个角色，你自己的配置和检出目录不会改变。

运行会记录它：克隆中的每个步骤在你的 `primaryRole` 旁边带有 `agent.team.selection.stepRole: review`，scorer 结果把这样的步骤归在 `review` 下。在克隆中，`role` 写在 workspace 为 `{ clone: … }` 的步骤上，且该克隆必须安装团队。pull 会以 `bad_role` 拒绝写在沿用该克隆的步骤上、与克隆不同的 role。克隆的角色按克隆的团队修订版中的 `manifest/roles.yaml` 检查，而不是你 pull 到的那份，所以在角色改名之前固定的克隆仍可以用旧名称运行。该修订版未声明该角色，或角色无法交付到克隆中时，步骤以 `role_unavailable` 失败并说明原因。例如，`sharing.docs.localDir` 可能把文档放在克隆之外，所有检出目录都会读到它们。步骤的提交只包含它自己的修改，不包含安装交付的内容。只有声明了 [`can.role`](#要求和限制) 的驱动才会接这个步骤，例如 `local`。编程会话的 skill 驱动不声明它：describe 会让你用 `--driver local` 启动这样的工作流；若仍把该步骤交给它，步骤会等待，`wait.held[].missing` 列出 `role`。0.29.0 之前的 teamai 会丢弃带步骤 `role` 或 `defaults.role` 的工作流，`teamai review --branch` 会对此发出警告。

### 隔离运行

某个步骤打开克隆或运行 `workflow: { from }` 时，运行就是隔离的。它只在启动它的机器上运行：`workflow publish` 和 `--claim` 以 `isolated_run` 拒绝它，`workflow retry` 拒绝它并给出启动新运行的命令。它的记录带 `isolated: true`，使用统计上报开启时仍会到达 `teamai-reports`，并且不计入任何工作流总量。

### 私有工作流

`private: true` 让工作流的步骤所做的事留在运行它们的机器上，该工作流作为另一个工作流的步骤运行时也是如此。它作用于该工作流自己的步骤，以及这些步骤运行的工作流中的步骤，从不作用于运行它的步骤，也不作用于该步骤周围的任何步骤。

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

私有步骤的会话从不归档到 `teamai-reports`，发布的运行也不带它的任何输出：`rate` 发布 `triage-notes` 声明的 `severity`，`reasoning` 留在本机。私有步骤尚未结束时，`workflow publish` 和 `--claim` 以 `private_open` 拒绝该运行；它结束后两者都可以。从私有工作流启动的运行不发布运行记录，因此不计入任何工作流总量，也不出现在 Workflow Runs 页面上。它只在启动它的机器上运行：`workflow publish` 和 `--claim` 以 `isolated_run` 拒绝它。

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
| 步骤失败的原因，或 `null` | `steps.summary.failure.code`、`steps.summary.failure.message`。见[只在部分失败时回退](#只在部分失败时回退)。 |
| 步骤的每个 pass | `steps.review.passes`、`steps.review.passes[0].outputs.verdict`。见[读取每一个 pass](#读取每一个-pass)。 |
| `for_each` 步骤的 results | `steps.build.results`、`steps.build.results[0].outcome`、`steps.build.branches` |
| 设置了 `deliver: pr` 的步骤交付的 pull request，或 `null` | `steps.fix.pr`、`steps.fix.pr.url`、`steps.build.results[0].pr.url`。见[交付 PR](workflow.md#交付-pr)。 |
| `for_each` 实例的项 | `item`、`item.dir` |
| 这次运行的 id，在它运行的每个工作流中都相同 | `run.id` |
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

步骤在 `requires` 中声明它需要什么。工作流文件中的 `defaults.requires` 作用于其中每个步骤，也作用于它按名称运行的每个工作流，包括团队替换后的该工作流。步骤自己的键，以及下层工作流自己的 `defaults.requires`，会替换 `network` 和 `isolation`（除非 `strict` 设了下限），`env` 和 `labels` 列表会合并，`host: true` 只会添加：下层无法关闭它。工作流文件还可以设置 `setup`、`timeout` 和 `budget`，prompt 步骤可以设置 `max_turns`、`on_limit` 和 `permissions`。

```yaml
schemaVersion: v1alpha1
name: release
description: Build the package, then review it.
timeout: 1h
budget: { tokens: 200000 }       # 运行的预算：每个步骤报告时计入
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
| `requires.env` | 把这些[团队 env](sharing.md#env环境变量) 键交给步骤。其他团队 env 键，以及运行中其他步骤要求的键，都不会交给它。运行中只记录键名。某个键在本机没有值时，步骤在运行前以 `missing_env` 失败，消息写明怎样给它一个值：见[必需的键在本机没有值](#必需的键在本机没有值)。步骤 `env:` 中的项与团队 secret 或被要求的键同名时，以 `env_conflict` 失败。 | 步骤等待。 |
| `requires.network` | `false` 要求步骤不能访问网络。 | 步骤照常运行，其 `unenforced` 列出 `network`。本地驱动无法禁止网络。 |
| `requires.isolation` | `none`、`worktree` 或 `sandbox`。有工作区的步骤至少是 `worktree`。 | 步骤照常运行，其 `unenforced` 列出 `isolation`。 |
| `requires.labels` | 列出机器必须具备、但 teamai 不建模的东西，例如 `[computer-use]` 或 `[gpu]`，类似 CI runner 的标签。机器在 `~/.teamai/config.yaml` 的 `workflows.labels` 里声明自己的标签；fleet 条目在它的 `labels` 选项里声明池的标签。这些都是承诺：teamai 不检查机器。 | 步骤等待声明了每个标签的运行时。运行只有一个驱动且它一个都没声明时，步骤以 `requirement_unmet` 失败，并列出这些标签。 |
| `requires.host` | `true` 让步骤留在这台机器上：命令在 teamai 自己的进程里运行（host 槽位），提示词在定义中运行于本机的运行时上，绝不交给本机之外的运行时。teamai 自带的工作流在整个工作流都在本机运行、且不按名称运行其他工作流时，只在 `defaults.requires` 里设置一次（文件的 `defaults.requires` 也会作用于它按名称运行的工作流）；否则在每个命令步骤上设置，所以团队以其他名字复制的工作流也留在本机。`teamai workflow start <name> --describe --driver skill` 的回复在 `facts.runs` 中用 `host: true` 标出这样的步骤。 | 步骤等待。运行的所有运行时都不在本机时，步骤以 `requirement_unmet` 失败，并指出 `host`。 |
| `requires.strict` | `true` 让这一级的 `isolation` 和 `network` 成为下限：其下每个步骤至少得到它们，无论内层要求什么。严格的 `isolation: sandbox` 还会让步骤的每个进程都拿不到 `GITHUB_TOKEN`、`GH_TOKEN`、`GITLAB_TOKEN`、`GL_TOKEN`、`CI_JOB_TOKEN`、`SSH_AUTH_SOCK`、`GIT_ASKPASS` 和 `SSH_ASKPASS`，其下某个步骤的 `requires.env` 指定了其中之一时，pull 会拒绝它。使用 `--driver local` 时，本地驱动永远无法运行的启动会以 `requirement_unmet` 被拒绝。 | 步骤等待。严格的 sandbox 还需要 `can.env: true`，或者 fleet 条目上的 `env: member`。 |
| `setup` | 驱动在它创建的每个工作区中、在步骤之前运行 `command`。setup 获得它的 `requires.env` 键；步骤只有自己也要求时才会获得。setup 以非零退出（`setup_failed`）、改动 git 会提交的文件（`setup_dirty`），或把自己某个键的值留在它写入的文件中（包括被忽略的文件，`setup_secret`）时，步骤不运行即失败，工作区被删除。步骤的 `timeout` 也约束 setup。 | 带工作区的步骤等待。 |
| `timeout` | `500ms`、`30s`、`10m`、`2h` 或 `1d`，写在步骤或工作流文件上。超时的步骤被停止，结果为 `timeout`。写在 workflow 步骤上时，会停止其中每个步骤。写在工作流文件上时，运行以 `failed` 结束，失败码为 `timeout`。重试会重新开始计时。 | 不是能力。每个驱动都会在租约上拿到 `expiresAt`。 |
| `budget` | `{ tokens: N }`，写在工作流文件、workflow 步骤或带 `on_limit: end_turn` 的 prompt 步骤上。其下每个步骤的输入和输出 token 从它开始时计入：运行从开始时算起，workflow 步骤从每次开始时算起，例如循环的下一轮。重试会重新开始计算预算。工作流文件或 workflow 步骤的预算在每个步骤报告时计入它的 token：超过 `N` 时，其下仍在运行的步骤停止，并以 `budget_exceeded` 失败。这期间正在运行的 prompt 不会在达到 `N` 时被停止，只有另一个步骤的报告超过它时才会。要在一个 prompt 运行时就停止它，给这个 prompt 步骤加上自己的 `budget` 和 `on_limit: end_turn`。 | 预算内的非交互 prompt 步骤等待，它没有 token 的成功报告以 `budget_unmeasured` 失败。交互式 prompt 由人操作，照常运行；它的报告没有 token 时，其 `unenforced` 列出 `budget`。 |
| `max_turns` | 限制 prompt 步骤的智能体轮数。本地驱动只把它传给无头 Claude。 | 步骤照常运行，其 `unenforced` 列出 `max_turns`。 |
| `permissions` | prompt 步骤上的 `unattended`：它的工具无需询问就编辑文件和运行命令。只能在严格的 `isolation: sandbox` 之下使用，可以写在步骤本身、外层步骤、`defaults`，或运行其工作流的步骤上：没有它时，启动以 `unattended_unsandboxed` 被拒绝；[步骤打印的工作流](#运行步骤打印的工作流)没有它时，该步骤以 `invalid_output` 失败。见[无人值守的 prompt](#无人值守的-prompt)。 | 步骤等待。运行唯一的驱动没有 `can.unattended` 时，该步骤以 `tool_unavailable` 失败。 |
| `on_limit` | 在带 `timeout`、`max_turns` 或 `budget` 的 prompt 步骤上为 `end_turn`：从工具启动算起达到其中之一时，结束智能体的这一轮，而不是让步骤失败。步骤以设置了 `limit` 的状态成功并保留它的工作，所以它之后的步骤仍会运行。在带 `timeout` 或 `budget` 的 workflow 步骤上，这些是其中的 prompt 加起来可以花费的量，每次只运行一个 prompt：用完后，其未运行的步骤被跳过。`fail` 是默认值，在达到限制时让步骤失败。交还的步骤保持其第一次租约的截止时间。 | 没有 `can.end_turn` 时，步骤按 `fail` 运行，其 `unenforced` 列出 `on_limit`。 |

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
- `sandbox: true` 表示本机会隔离它运行的内容，例如 CI 虚拟机或容器，因此本地驱动声明 `sandbox` 隔离。此时设置 [`permissions: unattended`](#无人值守的-prompt) 的步骤运行其工具时不再询问，无论该步骤使用哪个工作区，包括你自己的 checkout。`teamai workflow start` 和 `resume` 接受 `--sandbox`，只为当前进程声明。
- `max_parallel` 还限制本机上所有驱动同时持有同一运行的租约数。

`allow.network` 筛选步骤显式声明的网络请求。v1 的 setup 仅声明环境变量键，不会从该设置继承网络限制。如需保证 setup 和步骤都无法联网，请使用能约束每个进程的驱动和运行环境。

`env/secrets.yaml` 中声明的每个键的值（包括本机像 CI 任务那样从环境变量中获取的值），以及名称看起来像 secret 的环境变量的值，在运行文件、运行记录、每个 `teamai workflow` 输出以及本地驱动和 skill 驱动为每次 attempt 保留的 `result.json` 中都会显示为 `<REDACTED:KEY>`。`start` 拒绝包含这些值的输入，返回 `invalid_inputs`，只指出键名，不显示值。要遮蔽名称看起来不像 secret 的值（例如 `DATABASE_URL`），请在 `env/secrets.yaml` 中声明它的键。

`local` 以外的驱动在每次 `next` 的 `driver.can` 中声明它能做什么：

| `driver.can` 键 | 驱动 |
|---|---|
| `hitl` | 让人回答 HITL 请求并在交互步骤中工作。 |
| `exec` | `false`：不运行任何命令，所以命令步骤和带 `setup` 的步骤会等待其他驱动。与其他键不同，省略 `exec` 表示驱动会运行命令。 |
| `workspace` | 接受这些工作区模式的租约：`read-only`、`new`、`continue`、`clone`、`team`（在[团队工作区](workflow.md#团队工作区)中运行的步骤，例如 `teamai-score` 的 `publish`）。克隆步骤只通过 [`next --prepare`](#在自己的驱动里使用克隆工作区) 租出。 |
| `env` | `true`：自己解析 `lease.envScope.provide`，移除 `lease.envScope.withhold`，并且不把值交给运行步骤的程序。`"commands"`：只对命令步骤和 setup 这样做，所以带 `requires.env` 的提示词步骤会等待。由智能体运行步骤的驱动不要声明它；如果命令由驱动自己启动，可以发送 `"commands"`。0.28.0 之前的 teamai 对 `"commands"` 返回 `invalid_json`。 |
| `setup` | 在它创建的每个工作区以及 setup 未完成的工作区中，用 `lease.setup.envScope` 运行 `lease.setup.command`，并以上述失败码让步骤失败。工作流声明了 `setup` 时，每个带工作区的租约都携带 `setup`。 |
| `tokens` | 报告每个成功的非交互 prompt 步骤的 token。 |
| `max_turns` | 把 `lease.maxTurns` 传给它能限制的工具，对其他工具报告 `"unenforced":["max_turns"]`。 |
| `network` | 能禁止步骤访问网络。 |
| `isolation` | 以此级别运行每个步骤：`none`、`worktree` 或 `sandbox`。 |
| `tools` | 在这些工具上启动指定了 `tool` 的 prompt 步骤，例如 `["claude"]`。没有它，就不会拿到这样的步骤。 |
| `end_turn` | 在 `lease.limits` 处结束 prompt 的这一轮，并报告它停在的 `limit` 和 `durationMs`。 |
| `unattended` | 对租约带 `permissions: "unattended"` 的 prompt，以其工具自己的无需询问即可编辑和运行命令的模式启动它；工具没有这种模式时让步骤失败，而不是照常启动。 |
| `role` | 接受[以团队角色运行](#以团队角色运行步骤)的步骤（通过 `--prepare` 取得、租约带 `role`），并在 teamai 为该角色交付的克隆或 worktree 副本中运行它。 |
| `confined` | 接受[限定在一个目录里的提示步骤](workflow.md#限定在一个目录里的提示步骤)：一组提供，每个为 `{ "level", "access", "tools" }`，即它在 `level`（`verified` 或 `best-effort`）下以 `access`（`read` 或 `full`）受限启动的工具，按尝试顺序排列。见[在自己的驱动里运行受限步骤](#在自己的驱动里运行受限步骤)。 |

省略的键表示驱动做不到。隔离是尽力而为，除非 `strict: true` 让它成为下限。`next` 会在 `ignored` 中列出其他键。[编程会话](workflow.md#在编程会话中运行)的 skill 驱动声明 `hitl`、所有 `workspace` 模式、`env: "commands"` 和 `setup`。它从不声明 `tokens`、`max_turns`、`network`、`unattended` 或 `role`，其 `isolation` 为 `none`：编程会话绝不绕过使用者自己的权限。它只在评审该运行时声明 `confined`：本机有会话所用工具的受限评审器时，以 `verified` 提供该工具，否则以 `best-effort` 提供它，交给新的子 agent。

### 无人值守的 prompt

以无头方式启动的工具在编辑文件或运行命令前会先询问，没有人回答时，步骤什么也做不了。`permissions: unattended` 让 prompt 的工具直接执行，所以只在可以丢弃的机器上使用：

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

本地驱动随后以工具自己的这种模式启动它：

| 工具 | 启动参数 |
|---|---|
| Claude Code，以及使用其参数的工具 | `--permission-mode bypassPermissions` |
| CodeBuddy、WorkBuddy | `--permission-mode bypassPermissions` |
| Codex CLI，以及使用其参数的工具 | `--dangerously-bypass-approvals-and-sandbox` |
| OpenCode | `--auto`，权限规则拒绝的操作仍然被拒绝 |
| agy | `--dangerously-skip-permissions` |

对于 teamai 不知道有这种模式的工具，步骤以 `tool_unavailable` 失败，工具绝不会在没有该模式的情况下启动。[工具支持](tool-support.md)的 `Unattended prompts` 列说明哪些工具有这种模式，以及依据。租约带 `permissions: "unattended"`，所以你自己的驱动能看到它；只有声明了 `can.unattended` 的驱动才会拿到该步骤。

### 必需的键在本机没有值

`sign` 步骤需要一个签名密钥，团队里还没有人声明过它：

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

在没有 `SIGNING_KEY` 的机器上，`sign` 在运行前就失败：

```text
$ teamai workflow start sign-release --driver local
ℹ Run r55b0e3a6017968bf started. If it stops before it ends, continue it here with: teamai workflow resume r55b0e3a6017968bf, or hand it to another machine with: teamai workflow publish r55b0e3a6017968bf
{"data":{"done":{"run":"r55b0e3a6017968bf","outcome":"failed","record":"published"},"cancelled":[]}}
✖ Step "sign" failed with missing_env: Step "sign" requires env SIGNING_KEY, which has no value on this machine. Set SIGNING_KEY in the environment, or declare it in the team repo with teamai env add SIGNING_KEY --secret and give it a value with teamai env set SIGNING_KEY, then retry the step.
ℹ Retry it with teamai workflow retry r55b0e3a6017968bf sign, then continue the run with teamai workflow resume r55b0e3a6017968bf
```

声明它，设置你自己的值，再把运行跑完。`build` 不会重跑：

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

本机的运行不必等 `teamai push`。推送之后，队友才能拿到这个声明，并看到下表第一行那种更短的建议。

| 情况 | 失败的步骤怎么说 | 要运行什么 |
|---|---|---|
| 团队已声明这个键，你还没在本机设置 | `Run teamai env set SIGNING_KEY, or set it in the environment, then retry the step.` | `teamai env set SIGNING_KEY`，再重试并继续 |
| 值放在密码管理器里，不想让 teamai 保存 | 上面任一条消息 | 先重试，再 `SIGNING_KEY="$(op read op://release/signing-key/password)" teamai workflow resume <run>` |
| 由 CI 作业接手运行 | 上面任一条消息，出现在作业日志里 | 像[该 CI 作业](workflow.md#从-ci-接手交出的运行)那样，在作业的 `env` 里导出这个键 |
| 步骤需要两个键，团队只声明了其中一个 | 每个键一句，用 `;` 连接，如 `Run teamai env set NPM_TOKEN, or set it in the environment; set SIGNING_KEY in the environment, or declare it …` | 各键各自的补齐方式 |

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

终端前无人的本地驱动不会让必需审批或它无法回答的选择失败：该步骤等待，驱动把运行[交给人](workflow.md#运行需要人参与时)，发布到 `teamai-reports`。只有运行无法发布为待接手时才以 `hitl_required` 失败，消息会说明原因。其他没有 HITL 的驱动仍按上表处理。

每次无 HITL 决策和 hitl_required 失败都会向 stderr 写警告。在本地配置中与 `workflows.max_parallel` 一起设置 `workflows.auto_approve`，或给 `start --driver local`、`resume` 传 `--auto-approve`，对这次运行生效：运行会在本安装实例上记住它，`resume --no-auto-approve` 可以关闭它。没有 HITL 的驱动不能通过 JSON next 设置此覆盖。支持 HITL 的驱动忽略 `workflows.auto_approve`：用户为这次运行选择自动批准时，它在 `next` 中发送 `autoApprove: true`，终端中的本地驱动在传入 `--auto-approve` 时也这样做。此时可选 approve 和有 default 的 choose 按 `auto_approve: true` 一列回答；必需 approve 和无 default 的 choose 仍以 `hitl` 返回。本地驱动仅在有人值守的运行（见[有人值守与无人值守的运行](workflow.md#有人值守与无人值守的运行)）中、且 stdin 和 stderr 都是 TTY 时声明支持 HITL，通过 stderr 提问，接受选择及其后的可选备注，并在提问期间继续轮询。其他进程回答或取消 HITL 请求会关闭问题。交互工具占用终端时，HITL 请求提问会等待。

`interactive: true` 要求 `prompt` 或 `prompt_file`。步骤会等待支持 HITL 的驱动。没有终端时，`--driver local` 会[把运行交给人](workflow.md#运行需要人参与时)，由人在终端中用 `resume <run> --claim` 继续。本地驱动在工作目录以前台方式打开工具，继承 stdio，并把 prompt 作为第一条消息。人对仓库的修改会保留，步骤成功。设置了 `workspace: read-only` 的交互步骤和命令一样检查：改了检出目录就以 `read_only_dirty` 失败，改动留在原地。在外层步骤打开的工作区里，改动保存在 `refs/teamai/kept/<attempt>`，并从工作区移除。在自己工作区里的交互步骤仍可以改那个工作区。无头 prompt 仍然只读。终端的 Ctrl-C 和 Ctrl-\ 交给交互工具处理；SIGTERM 和 SIGHUP 会停止工具和驱动。交互工具以 0 退出且没有输出时可以不写结果文件。驱动在 prompt 运行时每两秒轮询，发现取消后停止工具。

### 逐条询问

choose 步骤不能带 `for_each`，但 `for_each` 运行的 inline workflow 里可以有 choose，这样每个条目都由人回答一次。每个结果以 `item` 带上条目，以 `outputs.choice` 和 `outputs.note` 带上回答：

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

本地驱动器逐条询问。没有人回答时，运行会像上表中没有默认值的 choose 那样等待或失败。`teamai import --from-tools` 在 `teamai-import-learnings` 中就是这样逐条确认找到的文件。

## 重试、取消和继续运行

```sh
teamai workflow retry <run> <step>
teamai workflow cancel <run> [step]
teamai workflow resume <run>
```

用 `--driver local` 启动的运行会在本安装实例上记住它的 `--tools`、`--auto-approve` 和 `--sandbox`，所以 CLI 打印的每条 `resume` 命令照原样就能用：

```console
$ teamai workflow start loop-plan-change --driver local --tools default=claude --auto-approve --sandbox --inputs '{"issue":42}'
ℹ Run redf22a69e4ae6652 started. If it stops before it ends, continue it here with: teamai workflow resume redf22a69e4ae6652, or hand it to another machine with: teamai workflow publish redf22a69e4ae6652
^C                                                   # 或者终端关闭了，或者 claude 用完了 token

$ teamai workflow resume redf22a69e4ae6652           # 和启动时一样：claude、--auto-approve 和 --sandbox
$ teamai workflow retry redf22a69e4ae6652 decide     # 它的 JSON 以 "resume":"teamai workflow resume redf22a69e4ae6652" 结尾
$ teamai workflow resume redf22a69e4ae6652 --tools default=codex     # 从现在起，每个 prompt 步骤都用 codex
$ teamai workflow resume redf22a69e4ae6652 --no-auto-approve         # 从现在起，可选审批不再自动回答 yes
```

`resume` 上的参数会替换运行记住的值，`--tools` 按名字逐个替换，替换后的结果供下一次 `resume` 使用：

| 参数 | 在本安装实例上 `resume` | 在另一台机器上认领 |
|---|---|---|
| `--tools default=claude` | 保留；`--tools <name>=<tool>` 替换该名字 | 不带过去；列表提示 `pass --tools default=<tool>` |
| `--auto-approve` | 保留；`--no-auto-approve` 关闭它 | 不带过去 |
| `--sandbox` | 保留 | 不带过去；列表和 `busy` 都会指出 `--sandbox`，`--next` 跳过这个运行 |

`retry` 接受 leased、failed 或 cancelled 步骤，也接受已回答并拒绝的 approve 和已回答的 choose。重试 HITL 请求可以更改答案，旧答案保留在 pass 历史中。它释放旧租约，以新修订号启动新 pass（本地驱动会停止正在运行的命令，并等它退出后才启动新 pass），重置依赖或读取该步骤的后续步骤，包括循环等待和 item 的 after 依赖（其中正在等待、或已回答但尚未运行的 HITL 请求会在新 pass 中重新询问；重新打开已结束的运行时，其 `$TEAMAI_RUN_DIR` 已被删除，所以其中的 `workspace: { confined }` 步骤还会重置它 `needs` 中的步骤以及这些步骤所需的步骤，由它们写入其目录；其中在模板中（而不只是在 `if` 中）读取另一步骤输出、且该输出是该目录内路径的步骤，还会重置那个步骤；若那个步骤位于被重试步骤外层的工作流中，包含被重试步骤的 `workflow` 步骤也会在它之后重新运行；`workflow retry` 会打印它一并重新运行的其他步骤），并重新打开已结算的外层工作流、item、fan-out 步骤和运行。交付 pull request 失败的步骤保留原来的 pass，只重新运行交付。如果重新打开后运行仍在进行，返回结果会包含 `resume` 命令。执行该命令继续本地运行，或让驱动轮询 `next`。每个受影响容器中未回答的跳过步骤会重新计算；范围外手动取消的步骤保持取消。无关步骤已到达的有效结局或 break 会阻止重试。

历史保留在 passes 和 archive 中，因此 `length(steps.x.passes)` 也统计失败尝试。重试循环所有者会重置其迭代数；重试范围内的其他步骤则保留所有者的计数。重试保留顶层工作流的 round，耗尽最后一轮后重试仍可能再次 `loop_exhausted`。

指定步骤的 cancel 停止 pending、waiting、leased、running 或 delivering 工作，同时停止尚未结束的后代。cancelled 属于 stopped，因此依赖步骤会跳过，除非其 if 读取取消结果来恢复；运行通常失败。取消整个运行立即以 `cancelled` 结束，不启动下一轮。cancel 不增加修订号。迟到的报告返回 `lease_cancelled`，`next.cancelled` 告诉驱动停止哪些工具。在 `--driver skill` 下，若 skill 驱动中某步骤的 runner 仍在本机运行，它会在约 10 秒内自行停止该步骤，连同它持有的工具和登录：`cancel` 会说明这一点，并把该步骤留给它。若一分钟后 runner 仍在运行，先停止它，再运行一次 `cancel`。

在重试、回答、Ctrl-C 或关闭终端后，用 resume 继续本地运行。`workflow start --driver local` 在运行开始时就把运行 id 和继续它的 `resume` 命令输出到 stderr。它优先使用本机未结本地租约的工作目录，其次使用最近调用 `next` 的驱动工作目录（该驱动必须是本机本地驱动），最后使用当前目录。因此重试后即使从子目录继续，也会保留原来的本地工作目录。每个运行同时只能有一个本地驱动。重复 resume 返回 driver_running 和持有者进程号，请停止该驱动或等待；死进程留下的锁会自动回收。被杀掉的驱动留下仍在运行的命令时，会在它的步骤再次运行前停止该命令及它启动的进程。如果 teamai 是在你的终端里由另一个程序（例如 `npm run` 或脚本）启动的，并且命令的 shell 和它一起被杀掉，那个 shell 启动的进程会继续运行，需要你自己停止。已结算运行返回 done。本地运行失败时，`start`、`resume` 和 `resume --next` 会在 stderr 写出每个步骤失败的原因，以及它的 `retry` 和 `resume` 命令，见[必需的键在本机没有值](#必需的键在本机没有值)。如果是整个运行的限制（它的 `timeout` 或 `budget`）让它停下，则改为写出运行失败的原因，以及限制停下的每个步骤的 `retry` 命令。本地运行以 failed 或 cancelled 结束时退出码为 1；控制命令成功时退出码为 0，即使返回的运行状态为 failed 或 cancelled。

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
- 认领一个已结束的运行，不会重新运行它的任何步骤。认领的安装实例成为该运行的所有者，所以在那里执行 `workflow retry` 只重新运行指定的步骤、依赖它的步骤，以及其中 `workspace: { confined }` 步骤 `needs` 中的步骤和这些步骤所需的步骤。
- `--claim` 从所有者那里接管已发布的运行，并替换本机的运行副本。本机有该运行的本地驱动正在运行时，它返回 `driver_running`，不认领任何内容。仍在运行、没有人留给运行器接手、且所有者在最近一小时内写到 `teamai-reports` 的运行返回 `owner_active`，在没有该运行的机器上执行 `resume <run>` 也是如此：见[在另一台机器上继续运行](workflow.md#在另一台机器上继续运行)。

在该运行的业务仓库的检出目录中执行 `resume`。认领仍在运行的运行时，会用 `git ls-remote` 检查该运行的分支在这个检出目录的 `origin` 上，并且停在运行记录的提交上。它从不 fetch 到这个检出目录。已结束的运行不需要它的任何分支，所以即使合并后分支已被删除，认领也会成功，`resume` 会报告它的结束结果。如果重试重新打开了它，下一次 `resume` 会 fetch 它需要的分支。本机的工作流缓存与运行所用的工作流不同时，认领会在运行的团队提交上读取它们（团队仓库没有该提交时先 fetch），并在 stderr 输出 `[team commit <commit>] Synced N workflows`。你的缓存和团队仓库检出目录保持不变。能写 `teamai-reports` 的人都能指定这个提交，所以你的团队仓库检出和 origin 上团队默认分支都不包含的提交（例如只在某个旁支上的提交）返回 `definition_mismatch`，不认领任何内容：等它进入默认分支后，执行 `teamai pull` 再认领。把工作流放在业务仓库中的团队，也可以在消息指出的检出目录中检出一个包含该提交、且你信任的分支。运行固定其团队评分器所用的提交同样如此。

发布的状态是 `teamai-reports` 上的 `workflows/runs/<run>/state.json`。它包含运行继续所需的内容：状态、输入、每个步骤的结果、输出、pass 和带备注的 HITL 回答、基准、每个工作区的提交，以及步骤继续过的每个会话副本的工具和 id。工作流本身只以 `sourceHash`、`definitionHash` 和 `teamRevision` 传递。它不包含步骤和 pass 的 `message`、每个租约和回答的驱动身份（租约保留驱动类型）、工作区所有者，以及业务检出目录的路径。每条失败消息都换成 `The details stay on the machine that ran this step.`，失败的 `code` 保留。提交只以完整 id（40 或 64 位十六进制）出现。`publish` 用 TeamAI 的密钥规则、本进程环境变量里的密钥，以及团队在 [`env/secrets.yaml`](sharing.md#env环境变量) 中声明的每个密钥的值（无论名称如何）检查每个值和键，遇到第一个匹配就以 `secret_detected` 拒绝。声明的值短于 8 个字符时只按完整单词匹配，短于 4 个字符时不检查，`publish` 会给出警告并写明它的名称。拒绝信息写明步骤、字段和密钥类型，从不包含值本身。本机的绝对路径同样以 `local_path_detected` 拒绝：Windows 盘符或共享路径、`~/` 路径、`file://` URL，以及第一级目录存在于本机根目录下的 `/` 路径，例如 `/Users/alice/data.csv`。URL、`src/main.ts` 这样的相对路径和 `/api/v1` 这样的路由可以发布。这样的运行不能交接，请在本机继续，或改用相对于仓库的路径重新启动它。

`--sessions` 还会把未结算步骤将要继续的每个 agent 会话的最新副本（`session: continue` 或 `session.from`）放进 `teamai-reports` 上的团队会话归档，并像 `teamai session push --scrub` 一样脱敏。这包括循环即将再次运行的步骤，以及尚未开始的工作流步骤里的步骤。已结算步骤的会话和更早 pass 的会话从不包括在内。信封随后在 `sessions` 中以 `{"tool","id"}` 列出它们，没有时为空列表。本机读不到的会话不归档：其所在的链归档本机能读的最新会话，`skipped` 列出被跳过的较新会话。整条链都读不到时，发布被拒绝。会话在写入状态之前归档，所以之后被拒绝的发布仍会留下已归档的会话，没有变化的发布也照样归档。在接着运行的机器上，本地驱动按以下顺序恢复步骤的会话：

1. 本机上的会话。步骤的工具与会话的工具相同时按 id 恢复，否则得到它的一份副本。
2. 归档会话的副本。副本只写一次，之后的恢复会复用它，包括后来加入的对话轮次。驱动按认领同步后的样子读取 `teamai-reports` 上的归档。旧版 teamai 归档在默认分支上的会话，按团队仓库的 origin 上的样子读取，每次驱动运行 fetch 一次，所以你不需要先执行 `teamai pull`，你的团队仓库克隆也保持不变。fetch 失败时，驱动读取你的克隆，并说明它可能比 origin 旧。
3. 如果该会话是另一个步骤做出的副本，而前两种方式都拿不到它，就对这个副本所继续的会话用同样两种方式，依此类推直到最初的会话。这时步骤会缺少拿不到的那些副本中的对话轮次。
4. 新会话，并在 stderr 输出以 `⚠ Step "<id>" starts a new <tool> session:` 开头的警告，说明上述每种方式为什么失败。

步骤的工具需要在那台机器上有自己的会话存储，例如 Claude Code 的 `~/.claude/projects`，和 `teamai session restore` 一样。OpenCode 会得到归档的会话，但它的步骤仍然开一个新会话，因为 OpenCode 没有恢复会话的参数。

租约的 `session` 在 `earlier` 中按从新到旧列出它所继续的会话，供拿不到该会话本身的驱动使用。`local` 以外的驱动如果继续了租约的 `session` 或 `earlier` 中的某个会话（按 id 或在副本中），要在上报中把它继续的那个会话作为 `resumed`（`{"tool","id"}`）放在它运行的 `session` 旁边。新开会话时不带 `resumed`。在以自己的方式启动智能体的运行时上，local 驱动的 prompt 还带有 `continue`（`{"handle","op"}`），即之前某个尝试在 teamai 保持打开的位置里启动的对话；运行时只有在这一轮确实在其中继续时才回答 `resumed: true`，否则开一个新对话，并发出一条 `notice`。没有 `resumed` 时，后续步骤恢复租约的会话，而不是副本。缺少工具或 id 的 `resumed`、出现在不恢复会话的步骤上的 `resumed`，或指向租约未提供的会话（既不是它的 `session`，也不在 `earlier` 中）的 `resumed`，都返回 `invalid_report`。

每个拒绝都是一个 JSON 信封，带 `error.code`、`error.message` 和下表列出的额外字段。命令以退出码 1 结束。

| 代码 | 发生了什么 | 下一步 |
|---|---|---|
| `not_owner` | 另一个安装实例拥有该运行。带 `owner` 和 `ownedAt`。 | 联系所有者，或用 `resume <run> --claim` 接管。 |
| `owner_active` | 所有者在最近一小时内写过这个仍在运行的运行，且没有人留给运行器接手，它的驱动可能正在执行步骤。带 `owner` 和 `wroteAt`。 | 请所有者停止驱动并发布。停止后执行 `resume <run> --claim --confirmed`；无人值守时，等这一小时过去。 |
| `run_offered` | 对本安装实例留给运行器接手的运行，执行了不带认领的 `next`。 | 撤回待接手状态：`resume <run>`，或在 next 中加 `"claim": true`。 |
| `driver_running` | 本机有该运行的本地驱动正在运行，或 skill 驱动正在本机执行它的某个步骤时，执行了 `publish`。 | 停止那个驱动，或等 skill 驱动报告该步骤后，再发布。 |
| `place_kept` | 运行在本机为一个对话保留了位置，而它的步骤运行时无法关闭这个位置时，执行了 `publish`：接手运行的机器够不到它。什么都没有发布，运行留在本机。 | 在本机继续它，或者等它的步骤运行时能关闭这个位置后再发布。 |
| `state_moved` | 本机准备认领或发布期间，运行发生了变化：认领时在 `teamai-reports` 上，发布时在本机上。没有认领或发布任何内容。 | 再认领一次，或再发布一次。 |
| `state_conflict` | `teamai-reports` 上的状态比本机上次看到的更新。 | 执行 `resume <run>` 取得已发布的状态。 |
| `run_not_published` | 没有人发布过该运行。 | 在有这个运行的机器上发布它。 |
| `run_not_found` | 本机没有这个 id 的运行。 | 检查 id。 |
| `run_unreadable` | 本机的运行文件无法读取。 | 检查 TeamAI 数据目录中的运行文件。 |
| `run_mismatch` | 本机有一个 id 相同、但开始时间不同的运行。带 `localCreatedAt` 和 `remoteCreatedAt`。 | 两个运行都不会被改动。它们是不同的运行。 |
| `invalid_run` | id 不是 `r` 加 8 或 16 位十六进制数字。 | 检查 id。 |
| `unsupported_repo` | 团队仓库是 `http` 仓库，没有 `teamai-reports`。 | 在有这个运行的机器上继续。 |
| `busy` | 另一个 teamai 进程正在写 `teamai-reports` 或该运行，或者 `next --prepare` 要准备的位置被另一个未结束的 attempt 占用。 | 重试；位置被占用时，等那个 attempt 报告后再试。 |
| `reports_unreachable` | 无法从团队仓库的 origin 读取 `teamai-reports`，或这台机器无权写入存放它的文件夹（例如在沙箱中）。 | 检查网络连接后重试。消息里给出了文件夹时，给 teamai 该文件夹的写权限，或在沙箱外运行该命令。 |
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

`teamai workflow resume --next` 像 `teamai pull` 一样 fetch `teamai-reports`，然后从最早待接手的运行开始逐个尝试。它跳过本安装实例发布的运行、`repository` 与本检出目录的 `origin` 不同的运行、调用方不能接手的运行、本机无人回答时现在就在等人的运行，以及剩余步骤需要本机所缺之物的运行。运行在等人，是指其发布状态中现在就绪的某个步骤是必需审批、`interactive` 步骤，或运行器的 `--auto-approve` 不回答的选择。以后才可能需要人的步骤不会挡住运行器：它接手运行，运行到这样的步骤时再交回。无人值守的运行中无人回答，使用本地驱动且没有终端时也无人回答。本机可能缺少的东西：

| 剩余步骤 | 本机缺少的情况 | 列出的补救 |
|---|---|---|
| 带 `requires.env` 的步骤或其 `setup` | 某个键在本机没有值，或读不到团队 env | 团队已声明的键用 `teamai env set <KEY>`；未声明的键先 `teamai env add <KEY> --secret` 再 `teamai env set <KEY>`；或在环境中设置 |
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

不带运行 id 的 `teamai workflow resume` 在同样的 fetch 之后，列出本检出目录所属业务仓库的待接手运行，以及本机仍在运行的运行，每个只列一次。`STATUS` 为 `running`（剩余步骤可能需要人时附 `may need a person at <step>`）、`needs a person`（现在就绪的步骤需要人；由人用 `resume <run> --claim` 接管）、`cannot run here`（附本机缺少什么、怎样补上）、`needs the local driver`、`claimed`（另一个安装实例接手了你的运行）、`succeeded`、`failed` 或 `cancelled`（你的运行已在接手它的安装实例上结束，`--claim` 把它的结束状态带到本机），或其他拒绝的代码。没有 origin 的检出目录不列出待接手运行，因为 `--next` 在那里不接手任何运行。fetch 失败时，它给出警告，并列出上一次 fetch 看到的内容。

| 代码 | 发生了什么 | 下一步 |
|---|---|---|
| `invalid_arguments` | `--next` 和运行 id 一起传入，或和 `--claim` 一起传入。 | 只传其中一个：运行 id，或 `--next`。 |
| `unsupported_repo` | 团队仓库是 `http` 仓库，没有 `teamai-reports`。 | 使用 git 团队仓库。 |
| `origin_unavailable` | 本检出目录没有 `origin`，因此没有可匹配的业务仓库。 | 在业务仓库的检出目录中执行。 |
| `reports_unreachable` | 无法 fetch `teamai-reports`，或这台机器无权写入存放它的文件夹（例如在沙箱中）。没有认领任何运行。 | 检查网络连接后重试。消息里给出了文件夹时，给 teamai 该文件夹的写权限，或在沙箱外运行该命令。 |

### 从 CI 发布

用 `--driver local` 运行工作流的 CI 任务可以在运行失败时发布它，让成员在自己的机器上继续。任务在运行开始时所在的检出目录中发布。`publish` 把运行的基准以 `teamai/<run>/base` 推送到业务仓库的 origin，只推一次且不强制推送，并用 `git ls-remote` 读取运行在那里的分支。因此任务的 token 需要业务仓库的推送权限：在 GitHub Actions 上是 `permissions: contents: write`。为来自 fork 的 pull request 运行的工作流只拿到只读 token，无法发布。任务还需要团队仓库的写权限，因为 `teamai-reports` 在团队仓库里。

### 在自己的驱动里认领

`local` 以外的驱动在第一次 `next` 的 payload 中加上 `"claim": true` 来认领运行：

```text
teamai workflow next <run> --json '{"claim":true,"driver":{"kind":"script","machine":"runner","workspace":"/work"}}'
```

和所有认领一样，这个认领会撤下运行的待接手状态。对本安装实例发布过的运行，不带 `claim` 的 `next` 会重新读取 `teamai-reports` 上的运行（每个进程最多每分钟一次），被另一个安装实例认领时返回 `not_owner`，而不是从本机过时的副本租出步骤。对本安装实例留给运行器接手的运行，它返回 `run_offered`：待接手状态保留给人或运行器，直到认领或 `resume` 撤回它。对已被另一个安装实例认领的运行上报同样返回 `not_owner`，这次尝试的内容不会提交、推送或记录。认领在 `next` 租出任何步骤之前执行，并在 `driver.workspace` 的 origin 上检查仍在运行的运行的分支。随后它像 `resume` 一样，把每个本地分支移到运行记录的提交，无法移动时返回 `branch_diverged`。本安装实例已经拥有的运行保持原样，但不再留给运行器接手。认领被拒绝时，作为 `next` 的错误信封返回。从 agent 会话发出时，认领像 `resume` 一样遵循运行的 `invoke`：payload 无法带上本人的同意，所以 `ask` 运行返回 `confirm_needed`，本人同意后，会话用 `teamai workflow resume <run> --claim --confirmed` 继续它。出于同样的原因，所有者可能仍在驱动的运行返回 `owner_active`。遇到 `state_moved` 时，再发送一次认领。非布尔值返回 `invalid_json`，消息为 `claim must be a boolean`。运行可能被其他机器继续的驱动，要在 `changes` 和 `read` 中上报完整的提交 id。`publish` 遇到其他形式的提交值时以 `snapshot_unsupported` 拒绝，并写明字段。

## 驱动定义和步骤运行时

驱动定义是一个 YAML 文件，`workflow start` 和 `workflow resume` 用 `--driver <name>` 选中它。它指定运行每个步骤的步骤运行时，也可以指定提示步骤使用的工具。步骤运行时是一个程序：它为一次尝试打开一个位置，在那里运行命令或工具，再把工作带回来。它和工具自带的运行时（例如 WorkBuddy 解包的 Node）不是一回事。

```yaml
# 团队仓库里的 drivers/toy.yaml
schemaVersion: v1alpha1
name: toy
description: Run steps on the team's toy runtime.
tool: claude            # 步骤或 --tools 没有指定其他工具时，提示步骤在 Claude Code 上运行
runtimes:
  - use: toy            # 团队仓库里的 runtimes/toy/runtime
    options:
      state: /var/tmp/toy-state
```

```sh
teamai workflow start review --driver toy
teamai workflow resume r1a2b3c4d                 # 在 toy 上继续，即这台机器上次驱动这个运行时用的定义
teamai workflow resume r1a2b3c4d --driver local  # 回到普通的 local；运行也会记住这一点
```

teamai 按下面的顺序查找 `<name>.yaml`，或存放 `DRIVER.yaml`（内容相同）的文件夹 `<name>/`，使用找到的第一个。同一位置用两种方式定义同一个名字时，失败为 `driver_namespace_conflict`。某个位置有这个名字却无法使用时，失败为 `driver_invalid`，不会转到下一个位置：文件夹 `<name>/` 里没有 `DRIVER.yaml`（缺失或拼错）、文件夹本身是链接或含有链接，或定义无法读取：

| 位置 | 说明 |
| --- | --- |
| 内置：`host` | 没有文件定义或替换它，下面各处的 `host.yaml` 都不会被读取，并给出警告。它在下文所述的 `host` 槽位上运行每个步骤，因此只运行命令、关卡，以及步骤都不需要 AI 工具的工作流。`workflow start` 以 `requirement_unmet` 拒绝 prompt、`interactive`、`answer:` 或列出评分器的步骤，并指出该步骤和 `--driver local`。`workflow: { from }` 步骤生成的工作流中若有这类步骤，该步骤也以同样方式失败，且该工作流的任何步骤都不会开始。 |
| `~/.teamai/drivers/` | 只属于你自己。`resume --next` 从不读取它。 |
| 团队仓库的 `drivers/`（self 模式下是 `.teamai/drivers/`），以及你的角色或项目为 workflows 激活的每个 `drivers/<namespace>/` | 两个生效的命名空间定义同一个名字时，失败为 `driver_namespace_conflict`。`drivers` 文件夹是链接时失败为 `driver_invalid`，不会经由它读取任何内容。 |
| 用户作用域的团队仓库 | 只在项目里启动时查找。 |
| teamai 自带的定义 | 每个都命名为 `teamai-<name>`。 |

没有名为 `x` 的定义时，`--driver x` 运行 `teamai-x`，所以 `--driver claude` 和 `--driver teamai-claude` 都运行自带的 `teamai-claude`。`--driver local`，以及没有设置驱动时替你启动运行的命令（例如 `teamai score`），运行 `teamai-local`：先找你在 `~/.teamai/drivers/` 中的，再找团队的，最后是 teamai 自带的。运行用了你的或团队的定义时，会说明用的是哪个文件。`local`、`none`、`skill` 和 `fleet` 不能用作定义名：teamai 从不读取 `drivers/none.yaml` 这样的文件。

一个定义列出一个或多个运行时。teamai 按列出的顺序把每个步骤交给它们，第一个能接下的运行时运行它：

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/sandboxed.yaml
schemaVersion: v1alpha1
name: sandboxed
tool: claude
runtimes:
  - use: sandbox          # 接下它能接的每个步骤
    sandbox: containers     # 见 [sandbox 档案](runtime-sandbox.md#sandbox-档案)
    options:
      max_parallel: 2
  - use: tools            # 接下其余的，例如交互步骤或必须回答的审批
```

没有任何单个运行时能接下的步骤会失败为 `requirement_unmet`，消息列出每个运行时缺什么：

```text
Step "review" needs what no single runtime of driver "sandboxed" offers: runtime sandbox lacks tools; runtime tools lacks isolation. Give one runtime of the definition all of it, or change what the step requires.
```

步骤要求严格隔离、而定义里没有运行时提供时，`workflow start` 会直接拒绝，不会创建运行。每个运行时都因为这台机器的原因暂缓的步骤（例如你的 `workflows.allow` 不允许的网络）保持待运行。这期间，等你回答的审批或选择仍会照常提问。没有其他步骤在运行、也没有等待回答的问题时，运行以 `busy` 停下并给出原因，仪表盘的运行详情会写明是哪个运行时暂缓了它、为什么。

每个定义都在本机留一个 `host` 槽位，给留在这里的步骤，所以你的运行时不能叫 `host`。它用 teamai、git 和 shell 运行命令，不启动任何 AI 工具。定义列出 `tools` 时，它占 `tools` 条目在顺序中的位置，否则排在最后。它不启动提示步骤的工具：那是 `tools` 的事。这个位置接下：

- 命令步骤和 setup，前提是定义里没有运行时运行命令（`"exec": false`）；
- teamai 自带的每个工作流（如 `teamai-score` 和 `teamai-share-session`）的命令步骤，它们在本机规划、检查和写入标签；以同名团队文件替换某个自带工作流时，其命令步骤同样如此；
- 带 `deliver: publish` 的步骤，它从这里推送到数据分支；
- `answer:` 步骤，由你自己的 AI 工具在本机回答，所以本机需要装有该工具。若 `defaults.requires` 是本机达不到的严格要求，`workflow start` 会以 `requirement_unmet` 拒绝。

其他运行时都不接这些步骤。定义里有运行时运行命令时，你自己的命令步骤交给它，而不是 host。所以只由外部运行时组成的定义，在没有安装 AI 工具的机器上也能运行每个没有 `answer:` 步骤的工作流：

```yaml
# drivers/sandbox-only.yaml
schemaVersion: v1alpha1
name: sandbox-only
tool: claude
runtimes:
  - use: sandbox          # 提示步骤和你的命令步骤；teamai 自己的步骤在 host 条目上运行；档案 default：teamai 的 sbx microVM
```

打分 pass 的评判在[回答限定提示的运行时](runtime-protocol.md#回答限定提示的运行时)上运行；没有这种运行时而定义列出了 `tools` 时，用本机的工具；两者都没有时，运行以 `confined_pending` 停下。teamai 自己的工作流换个名字复制后，其命令步骤也会通过该文件设置的 `requires.host` 留在本机。运行状态中每个步骤都以 `runtime` 记录它运行在哪个运行时上：其条目的 `use`；在 teamai 进程中运行的步骤，命令和回答记为 `host`，提示记为 `tools`。

`use: tools` 按 `--driver local` 的方式，在本机的工具上运行提示步骤。`use: local` 是它的旧名字。其他名字都是外部程序，用文件 `runtimes/<name>.yaml` 声明，或用文件夹 `runtimes/<name>/` 存放它的 `RUNTIME.yaml` 和代码。teamai 按下面的顺序在每个位置先找完全相同的名字，再用同样的方式找 `teamai-<name>`：

```text
~/.teamai/runtimes/<name>.yaml 或 <name>/RUNTIME.yaml   你自己的
runtimes/<name>.yaml 或 <name>/RUNTIME.yaml             团队仓库，以及每个生效命名空间的 runtimes/<namespace>/
runtimes/teamai-<name>.yaml                              teamai 自带的，在它的包里
```

PATH 上的可执行文件只作为上面某个声明的 `entry` 运行：teamai 不再单独运行它在 PATH 上找到的 `teamai-runtime-<name>`。

```yaml
# runtimes/acme/RUNTIME.yaml，放在运行时代码旁边
protocol: 1                          # 它使用的运行时协议
entry: ./runtime                     # teamai 启动的、文件夹里的文件
exec: false                          # 可选：它不运行命令，所以不需要 AI 工具的运行不会启动它
```

```yaml
# runtimes/acme.yaml：单独安装的运行时
protocol: 1
entry: { command: acme-runtime }     # PATH 上的可执行文件，只写名字
```

团队文件夹在你接受它的修订后运行，团队文件在你接受文件内容后运行，和工具实例的命令一样。你自己的和 teamai 的不需要接受。团队运行时的文件夹必须是团队仓库中、不含任何链接的文件夹，这样你接受的修订就是它运行的全部内容：本身是链接或含有链接的文件夹，或者 `runtimes` 文件夹本身是链接，都以 `runtime_not_found` 失败。名字找到的运行时无法运行时也一样：你或团队有这个名字的文件夹却没有 `RUNTIME.yaml`（缺失或拼错）、标记文件无法解析、`protocol` 不是 `1`，或 entry 不存在。消息会指出它的文件，teamai 不会改用其他层的运行时。名字先找到你自己的或团队的运行时、而不是 teamai 自带的（比如团队的 `runtimes/t3/`）时，它照常运行，并警告它替换了 teamai 的；每次尝试的记录都写明它的运行时来自哪里、是哪个修订。

teamai 自带这些定义：

| 定义 | 运行时 |
| --- | --- |
| `teamai-local` | `tools`，自己不指定工具 |
| `teamai-claude`、`teamai-codex`、`teamai-opencode` | `tools`，提示步骤用对应的工具 |
| `teamai-t3` | `t3`（`environment: local`、`max_parallel: 4`） |
| `teamai-paseo` | `paseo`（`max_parallel: 4`，连接你的 Paseo 配置指定的地址） |
| `teamai-sandbox` | `sandbox`（sandbox 档案 `default`，teamai 的是 sbx microVM；`max_parallel: 4`），然后 `tools` |

### 各部分放在哪里

运行用到的驱动、运行时、sandbox 档案和工具都是团队仓库中的文件，每个可以是一个文件，也可以是一个文件夹，存放它的标记文件和所需的内容：

```text
drivers/
├── ci.yaml                     驱动定义 "ci"
└── gpu/
    └── DRIVER.yaml             驱动定义 "gpu"
runtimes/
├── acme.yaml                   步骤运行时 "acme"，PATH 上的可执行文件
└── t3/
    ├── RUNTIME.yaml            步骤运行时 "t3"，替换 teamai 自带的
    └── runtime                 它的代码，随文件夹的修订一起接受
sandboxes/
├── default.yaml                sandbox 档案 "default"，替换 teamai 自带的
└── node-deps/
    ├── SANDBOX.yaml            sandbox 档案 "node-deps"
    └── Containerfile           它的预热镜像从这里构建
tools/
├── acme-claude.yaml            工具实例 "acme-claude"
└── web-claude/
    └── TOOL.yaml               工具实例 "web-claude"
```

| 想要 | 添加 | 参见 |
| --- | --- | --- |
| 在其他运行时上运行步骤，或在另一个工具上运行提示步骤 | 驱动定义 | [上面的查找顺序](#驱动定义和步骤运行时) |
| 在你自己的程序里运行步骤，比如某个应用或远程机器 | 步骤运行时 | [编写步骤运行时](runtime-protocol.md) |
| 让 `sandbox` 运行时的步骤换一个 provider 或镜像运行 | sandbox 档案 | [sandbox 档案](runtime-sandbox.md#sandbox-档案) |
| 用另一个命令或主目录运行某个工具 | 工具实例 | [团队工具](reference.md#团队工具tools) |

名字在三个位置查找，先在每个位置按完全相同的名字查找，再查找 `teamai-<name>`，所以团队的 `runtimes/t3/` 会替换 teamai 自带的 `teamai-t3` 运行：

```text
~/.teamai/<folder>/                     你自己的
<folder>/<namespace>/, then <folder>/   团队仓库：先是你的角色或项目为 workflows 激活的命名空间，再是根目录
<folder>/teamai-<name> in teamai        teamai 自带的，在它的包里
```

teamai 的某个功能如果自带多种资源，会用同一个名字提供它们：

| 功能 | teamai 以其名字提供的资源 |
| --- | --- |
| Recall | `rules/teamai-recall/`、`agents/teamai-recall.md` |
| T3 Code | `drivers/teamai-t3.yaml`、`runtimes/teamai-t3.yaml` |
| Paseo | `drivers/teamai-paseo.yaml`、`runtimes/teamai-paseo.yaml` |
| Sandbox | `drivers/teamai-sandbox.yaml`、`runtimes/teamai-sandbox.yaml`、`sandboxes/teamai-default.yaml`，以及每个 provider 一个 `sandboxes/teamai-<provider>.yaml` |

### 运行时选项

运行时在 `init` 时自己检查 `options`，不接受的键会在任何步骤运行前失败为 `bad_option`。有两个键属于 teamai，运行时看不到：

| 键 | 含义 |
| --- | --- |
| `max_parallel` | 这个运行时上同时最多有这么多次尝试。它没有空位时，步骤交给下一个运行时。`workflows.max_parallel` 仍然限制整个运行。 |
| `credentials` | `codex: login`：步骤里的 Codex 使用 teamai 单独保存的登录，见下文。`NAME: env:VARIABLE`：步骤的工具得到 `NAME`，值在运行开始时从你的 `VARIABLE` 读取，见下文。 |

不改定义也能在你的机器上调整它的选项，写在 `~/.teamai/config.yaml` 或工作区自己的 `config.yaml` 里。键逐个覆盖定义里的值，工作区的优先：

```yaml
workflows:
  drivers:
    teamai-t3:
      runtimes:
        t3:
          max_parallel: 2
```

### 通过另一个运行时运行

带 `through` 的条目让一个运行时的工具在另一个运行时准备的位置里运行，例如让你的应用里的代理在沙箱里运行。每个运行时的选项写在它自己的名字下：

```yaml
# drivers/app-sandboxed.yaml
schemaVersion: v1alpha1
name: app-sandboxed
runtimes:
  - use: my-app
    through: my-sandbox
    options:
      my-app: { mode: full-access }
      my-sandbox: { image: acme/agent:1 }
  - use: tools
```

对运行来说，这个条目是一个运行时，消息里叫 `my-app through my-sandbox`。工具在哪里运行由外层运行时（`my-sandbox`）决定：隔离、env 凭据、setup 和命令步骤。工具怎样启动由内层运行时（`my-app`）决定：它的工具、工作区、HITL 和结束轮次的方式。条目还提供外层准备的 `clone` 和 `team` 工作区。只有内层运行时自己提供无人值守时，它才提供 `permissions: unattended`，而且只为内层以完全访问运行的工具提供；T3 和 Paseo 都不提供。它不运行受限步骤。步骤的登录交给外层，由外层交给工具；内层只得到它自己的凭据。

teamai 先打开外层，再打开内层。它先停止并关闭内层；内层无法确认已停止时，外层的位置保留。teamai 在内层打开位置的过程中被杀掉时也是如此：teamai 记下的句柄都没有指向那个位置，所以 `workflow cancel` 会保留外层的位置并说明原因，直到你自己关闭内层的位置并释放这次尝试。

只有支持这种方式的运行时才能参与。teamai 自带的运行时中，sandbox 作为外层，T3 和 Paseo 作为内层：

| 条目 | 智能体 | 它的工具 | 参见 |
| --- | --- | --- | --- |
| `use: t3`，`through: sandbox` | 一个 T3 Code 线程 | Claude，在这次尝试的沙箱里 | [T3](runtime-t3.md)、[通过应用运行](runtime-sandbox.md#通过应用运行teamai-sandbox-tool) |
| `use: paseo`，`through: sandbox` | 一个 Paseo 智能体 | 在这次尝试的沙箱里 | [Paseo](runtime-paseo.md#通过沙箱运行) |

沙箱的提供方必须提供这次尝试的套接字：`sbx`，或 Docker Desktop 上、这台 Linux 机器上 26.0.0 或更高（25.0.5、23.0.11）且镜像里有 `node` 的 `docker`，它们让工具连不到这台机器的端口（[步骤能连到什么](runtime-sandbox.md#步骤能连到这台机器的什么)）。

[协议](runtime-protocol.md#协议)说明内层和外层的请求各带什么。

### 在其他成员的机器上运行步骤（`fleet`）

`use: fleet` 把步骤交给同一业务仓库的另一位成员的安装来运行。teamai 在 `teamai-reports` 上发布这个步骤，池中的一位成员领取后在自己的机器上运行，并把产出推送到 origin 的 `teamai/attempts/<run>/<attempt>`。之后你的驱动把这些产出拿进步骤的位置，像自己运行的步骤一样继续。只有你的安装会移动工作流的分支。

```yaml
# drivers/build-fleet.yaml
schemaVersion: v1alpha1
name: build-fleet
runtimes:
  - use: fleet
    options:
      pool: build          # 可选；默认 default
      stale_after: 30m     # 可选；默认 30m
      max_parallel: 4      # 同时最多发出 4 个尝试
  - use: tools
```

成员领取某个池为当前检出的 origin 发布的最早的尝试：

```sh
teamai workflow resume --next --pool build   # 指定的池
teamai workflow resume --next --pool         # default 池
teamai workflow resume --next                # 和以前一样只领取已发布的运行，从不领取尝试
```

它输出 `{"data":{"ran":{"run":…,"attempt":…,"step":…,"exit_code":…}}}`，没有领取时输出 `{"data":{"idle":{"offered":N}}}`。两位成员同时领取同一个尝试时只有一位能拿到，另一位会去试下一个。

每次调用最多领取一个尝试，所以一直作为成员的机器在循环里运行它，或者用 CI 定时任务运行：

```sh
while :; do teamai workflow resume --next --pool build; sleep 60; done
```

要同时领取多个尝试，就运行多个循环。不带运行 id 的 `teamai workflow resume` 会列出当前检出的 origin 上正在外面的尝试：池、状态、领取它的成员，以及它最近一次进度。

设置 `wake` 后，对没人领取的尝试，你的安装会自己启动一个成员：通过一个能在其他机器上启动 agent、且其 init 提供 `wake` 的运行时：

```yaml
# drivers/gpu-fleet.yaml
schemaVersion: v1alpha1
name: gpu-fleet
runtimes:
  - use: fleet
    options:
      pool: gpu
      wake:
        use: t3            # 启动成员的运行时
        options:           # 它的选项，与驱动中给它的一样；你的 workflows.drivers.gpu-fleet.runtimes.t3 会覆盖它们
          environment: local
  - use: tools
```

你的驱动第一次读到该尝试处于已发布状态时，会请求那个运行时一次：在它能到达的某台机器上、业务仓库的一个检出里运行 `teamai workflow resume --next --pool gpu`。它启动的成员像其他成员一样领取尝试。每个尝试只唤醒一次，驱动重启后也一样；尝试被领取或等待结束时，还在进行中的唤醒会被停止。唤醒失败时会提示一次，并附上那条命令，尝试继续等待有人启动的成员。成员运行的是它自己那台机器 PATH 上的 `teamai`，所以那台机器需要一个支持 fleet 的 teamai 版本：旧版本会在不认识的 `--pool` 选项上停下。被唤醒的成员失败时，原因显示在那台机器上它自己的线程或 agent 里，尝试继续等待。`teamai workflow resume` 会在 WOKEN 一列列出成员是在哪里被唤醒的，只在你的安装上可见。init 不提供 wake 的运行时会让启动以 `bad_option` 失败。被唤醒的成员用那台机器的工具和登录运行步骤，所以消耗的是那台机器的账号，并在那里运行步骤要运行的内容：只指定能到达你信任其运行本池步骤的机器的运行时。

哪些步骤交给 fleet 沿用平常的路由，不需要步骤键：`runtimes` 的顺序、fleet 的 `options` 下 `can` 所承诺的能力（由成员的机器提供，teamai 不做检查）、步骤的 `requires` 和 `strict`，以及总是留在本机的步骤。fleet 接命令步骤和提示词步骤。受限（confined）的提示词步骤不交给它，不管它的 `can` 怎么写：它的目录在本机的 `$TEAMAI_RUN_DIR` 下，成员拿不到，所以它在驱动的下一个运行时上运行，例如 `tools`。带 `requires.labels` 的步骤交给 `labels` 选项列出每个标签的 fleet 条目，成员按它自己那份工作流定义要求的标签，只有在它将运行该步骤的地方列出每个标签时才接：在本机运行的步骤看它的 `workflows.labels`，在它 `--driver` 的某个运行时上运行的步骤看该运行时的 `labels`；其他成员会跳过它并记录原因。成员用它自己的工具、模型和登录，按它自己那份步骤定义运行提示词步骤；在 fleet 的 `can.tools` 里列出你的池拥有的工具，其他步骤就不会交给它。成员会把这个会话连同步骤在其尝试的 `out/` 目录里留下的文件（[保留哪些](scorers.md#无人值守任务结束前运行-drain)）推送到团队会话归档，之后带 `session: continue` 的步骤就在你这里接着它继续。每个就绪的步骤、`for_each` 的每一项都是单独的尝试，数量最多到 fleet 的 `max_parallel`。请给这类步骤设置工作区，例如 `workspace: new`：没有工作区的步骤在你的检出里运行，成员对它的改动会让步骤以 `read_only_dirty` 失败。

当成员能独立运行整个 `workflow:` 步骤时，它会作为一次尝试整体交给 fleet：它运行的是一个工作流文件，或者一个内联工作流，其中的步骤除了 `inputs` 之外不读取外层的任何内容（不读其他步骤，也不读 `item`）；其中的步骤都是在该步骤的副本里工作的命令步骤或提示词步骤（自身的 `workspace` 只能是 `continue` 或 `read-only`），且没有角色、`deliver`、回答步骤、嵌套工作流或 `interactive`，步骤本身也没有 `on_limit: end_turn`。其中的闸门在你这里提问：成员等待你的驱动像在你运行中的闸门那样问你，然后按你的回答继续；你的驱动前没有人时，按你的驱动此时回答自己闸门的方式作答（`auto_approve`），否则步骤以 `hitl_required` 失败。备注里含有密钥或本地路径的回答不会写入 teamai-reports，你会被再问一次。成员按它自己那份团队工作流运行这些步骤，使用它自己的驱动，并把它们的工作作为这次尝试推送。成员只有在拥有其中每个提示词步骤的工具时才接这个步骤，和下文的提示词尝试一样；其他成员会跳过它并记录原因，例如 `its step "review" runs on claude, which is not on PATH here`。你的运行用该工作流返回的输出和结束点记录这个工作流步骤。其他工作流步骤，以及没有 fleet 条目接的整体步骤，照旧在本机启动，其中的步骤逐个交出。对这类步骤做 `for_each` 会把整条流水线分发出去，每一项一次尝试。

每个 fleet 条目在自己的 `pool` 里提供尝试，第一个 `can` 适合某步骤的条目接走它。多个 pool 就是多个 fleet 条目，提供得少的放在前面：`can` 被前面某个条目覆盖的 fleet 条目永远拿不到步骤，`workflow start` 会对此发出警告。[池和标签](#fleet-示例)说明了顺序。fleet 条目不接受 `through`，也没有条目能经由 `fleet` 运行：定义里出现任一种都会以 `driver_invalid` 失败，因为每个成员都在自己的驱动上运行步骤。

你不必一直在线。驱动发出尝试后就可以停掉，之后运行 `teamai workflow resume <run>`：它读取尝试的记录，成员完成时取回产出，没完成就继续等。尝试在外期间，不依赖它的步骤照常在本机运行。

领取尝试的成员每个 `stale_after` 内会写三次自己仍在运行，并附上到目前为止推送的产出。你的驱动超过 `stale_after` 没有收到它的消息时，尝试以 `fleet_member_gone` 失败。它最后一次推送之前的产出留在步骤的位置里，`teamai workflow retry <run> <step>` 会从那里再次发布这个步骤。

每个尝试的分支 `teamai/attempts/<run>/<attempt>` 会留在 origin 上，直到 `workflows.retention` 过去后 `teamai doctor --fix` 删除这个运行的分支（[运行留下的分支](workflow.md#运行留下的分支)）。成员为某个尝试保留的内容（例如它的日志）会一直留到该尝试的记录结束后 `workflows.retention` 过去，之后在下一次 `teamai workflow resume --next --pool` 时删除。

`teamai workflow cancel <run>` 结束在外的尝试，无论你的驱动在运行还是已停止。没有人领取的尝试会被撤回。已领取的成员会停止步骤，推送到目前为止的产出，并输出 `{"data":{"cancelled":{"run":…,"attempt":…,"step":…}}}`；这些产出会进入步骤的位置。成员在 `stale_after` 内没有回应时，尝试以 `fleet_member_gone` 失败，同上。如果取消在 60 秒内都无法写入尝试的记录（例如你的另一个 teamai 命令正占用 `teamai-reports`），或者在 `stale_after` 内完全读不到这条记录，teamai 会停止尝试并说明原因，同时保留该尝试；请再次运行 `teamai workflow cancel <run>`。

成员在自己检出的一个克隆里运行步骤，所以步骤写进 git 配置的内容不会影响检出。带 `--driver <name>`（团队的或 teamai 自带的定义，从不读 `~/.teamai/drivers/`）时，成员在该驱动里第一个能运行命令的运行时上运行命令步骤（例如沙箱），只带步骤自己的 env 和尝试的标记，在第一个能运行提示词的运行时上运行提示词步骤；不带它，或驱动的第一个运行时是 `tools` 时，就在本机运行。命令步骤会像在本地驱动上一样拿到 `TEAMAI_WORKFLOW_ATTEMPT`、`TEAMAI_MODE`（成员自己的）和 `TEAMAI_RUN_DIR`；这个目录是成员自己的，为该尝试创建，尝试结束时删除，所以步骤留在里面的文件既不会到你的安装，也不会到其他尝试。成员按它自己那份步骤定义，像本地驱动一样限定步骤的 env：步骤 `requires.env` 列出的每个键取自成员的团队 env，团队的其他键都不给，严格沙箱下也不给代码托管平台的令牌；步骤的 `requires.env` 不在它 `workflows.allow.env` 允许范围内时，成员会跳过它。带 `requires.env` 的步骤只有在 fleet 条目的 `can` 声明 `env: true` 或 `env: member` 时才交给它。`env: true` 还要求你的安装上有每个值；`env: member` 不要求：成员从它自己的团队 env 给出每个值，只有在本机运行的工作流 setup 需要你的安装上有它的值。成员没有某个键的值时，会跳过该尝试并记录原因，例如 `its step requires env DEPLOY_KEY, which has no value here: …`。成员在步骤中途被杀掉时，它下一次运行 `teamai workflow resume --next --pool` 会先停止上次留下的内容（无论在本机还是在它的运行时上），再从已推送的产出继续完成它仍持有的尝试。如果无法确认上次运行启动的某个进程已经结束（例如容器里的成员重启前启动的进程），它会保留该尝试，不再重复运行其中任何部分，并说出那个进程：等它结束后再运行一次这条命令。

每条记录都写明写入它的 teamai 版本。teamai 遇到更新格式的记录，或者记录要求一个它不认识的字段时：作为成员会跳过这个尝试，作为所有者会让步骤以 `fleet_record_newer` 失败，并说明要升级到哪个版本。记录不要求的未知字段会被忽略。尝试在外时，你的驱动每秒读一次它的记录；记录没有变化时读得越来越少，最慢每 30 秒一次。成员如果运行不了这个步骤（缺少标签、env 或工具，或找不到运行的定义），会把它留给其他成员，并在记录上写明原因；你的驱动会把每个成员的原因打印一次。

**升级一个池。** 请把你的安装和池里的每个成员一起升级。记录现在是格式 2，旧版 teamai 读不了；这个 teamai 也不读旧版写的记录：成员会跳过它，所有者会让步骤以 `fleet_record_unreadable` 失败，并写明写入它的 teamai。以前只接命令步骤的 fleet 条目，现在也接提示词步骤，用它 `can.tools` 列出的工具；没有列出时，就是 teamai 能启动的所有工具。成员只有在自己的环境里有该步骤的工具时才接提示词尝试，查找方式和本地驱动一样：先看步骤自己的 `tool`，再看 `workflows.tools` 和你的 AI 工具，然后在 PATH 上找；或者在它 `--driver` 中运行该步骤的运行时的工具里找。其他成员会跳过它并记录原因，例如 `Left attempt a2f0a5441 of run rf03e08d02eec400b for another member: its prompt step runs on claude, which is not on PATH here.`。要让提示词步骤不交给某个池，就在 `can.tools` 下列出它拥有的工具，或者设置 `can.prompt: false`。

有尝试在外的运行，`teamai workflow publish` 会拒绝（`fleet_attempts_out`）：认领会释放所有租约，而尝试的产出只会回到你机器上的位置。先用 `teamai workflow resume <run>` 等它完成，再发布。

#### fleet 示例

**任何安装都可以当成员，用任何驱动。** 成员只需要 teamai 和业务仓库的一个检出，不需要 T3。它用自己的工具、登录和模型，在它指定的驱动上运行每次尝试：

```sh
teamai workflow resume --next --pool build                          # 命令和提示词步骤在本机运行
teamai workflow resume --next --pool build --driver teamai-sandbox  # 在它的沙箱里
teamai workflow resume --next --pool build --driver teamai-t3       # 提示词步骤作为 T3 线程
```

只有替你启动成员这件事因运行时而异：`wake`，通过 [T3](runtime-t3.md#在关联的机器上唤醒-fleet-成员) 或 [Paseo](runtime-paseo.md#在其他-daemon-上唤醒-fleet-成员)。

**发布和 fleet。** 两者都写入 `teamai-reports`；在循环里运行 `--next --pool` 的 CI 任务就是那个池的成员：

| 你运行 | 另一个安装运行 | 谁拥有这次运行 | 用途 |
| --- | --- | --- | --- |
| `teamai workflow publish <run>` | `teamai workflow resume --next` | 认领它的安装 | 在这里开始，在 CI 里完成 |
| 带 `use: fleet` 的定义 | `teamai workflow resume --next --pool` | 你；只有你移动工作流的分支 | 把步骤分散到多台机器 |

**哪些步骤会交出去。** 除了 host 槽位的步骤，需要人的步骤也留在这里：fleet 不提供 `hitl`。要让其他步骤留在这台机器上，给它 [`requires.host`](#要求和限制)：

```yaml
# workflows/test-then-deploy.yaml
schemaVersion: v1alpha1
name: test-then-deploy
description: Test on any machine of the pool, then deploy from this one.
steps:
  - id: test
    command: npm test
    workspace: new
  - id: deploy
    needs: [test]
    command: ./scripts/deploy.sh
    requires: { host: true }
```

**池和标签。** 需要 teamai 不建模的东西的步骤，比如 GPU、显示器或 E2E 机器，用 `requires.labels` 说明。fleet 条目在自己的池里提供它们，通用条目放在前面，因为列出标签的条目也会接没有标签的步骤：

```yaml
# drivers/team-fleet.yaml
schemaVersion: v1alpha1
name: team-fleet
runtimes:
  - use: fleet                       # 没有标签的步骤，池 default
    options:
      max_parallel: 10
  - use: fleet                       # 要求 computer-use 的步骤
    options:
      pool: e2e
      labels: [computer-use]
  - use: tools                       # 两者都不接的步骤，比如需要人的步骤
```

| 步骤 | 去向 |
| --- | --- |
| `command: npm test` | 池 `default` |
| `requires: { labels: [computer-use] }` | 池 `e2e`，由标签列出 `computer-use` 的成员接 |
| `interactive: true` | `tools`，在这里 |

成员的标签是它的承诺：teamai 不检查那台机器是否真有显示器或 GPU。

**并行步骤。** `for_each` 有 20 个条目、`max_parallel: 10` 时，一次交出十个尝试，三个成员每次调用各接一个，分担它们。

**预算。** 成员花的是自己的账号。它报告的 token 随工作一起回来，计入这里步骤外层的预算。整个交出的 `workflow:` 步骤带着提供时那些预算剩下的额度，成员在那里停下它的步骤。

**信任。** 成员的可信程度和任何能推送到业务仓库及 `teamai-reports` 的人一样：它推送的内容就是步骤的工作，你的驱动把它快进合并到步骤的位置，你的评分器像评判在这里完成的工作一样评判它。给 `wake` 指定的运行时，只应能到达你放心交给池中步骤的机器。

### 步骤运行时的 Codex 登录

Codex 拒绝重复使用的刷新令牌，所以你自己登录的副本一旦在步骤里刷新，你的其他 Codex 会话就会被登出。`credentials: { codex: login }` 改用 teamai 单独保存的登录。第一个需要它、且在终端里运行的 Codex 步骤会替你创建：

```text
$ teamai workflow start review --driver containers
ℹ Step "review" signs Codex in on the login teamai keeps apart from your daily one, and /home/me/.teamai/logins/codex has no Codex login yet. Running CODEX_HOME=/home/me/.teamai/logins/codex codex login once to create it.
```

随后 Codex 自己的登录在你的终端里运行，结束后步骤继续。没有 Codex 步骤的运行从不询问。无人值守的运行不会替你登录：这个步骤以 `credential_missing` 失败，并写明这条命令以及之后要运行的重试命令。也可以提前创建登录：

```sh
CODEX_HOME=~/.teamai/logins/codex codex login
```

teamai 把这个 `auth.json` 复制到这次尝试的工具主目录，步骤结束后再把刷新过的文件写回去，而且只写回同一个账号的。整台机器上同一时间只有一次尝试持有这个登录。其他尝试会等待，并说明在等谁：

```text
ℹ Step "review" waits for the codex login teamai keeps, which attempt a339da600 of run r9a395746ec65dbd7 holds. It goes on once that attempt ends; teamai workflow cancel r9a395746ec65dbd7 releases it.
```

本机上的 Codex 评审（judge）在它这次尝试下自己的主目录里使用你自己的 Codex 登录，运行期间持有同一把锁：放开之前，它会把 Codex 在那里刷新过的登录写回你的 Codex 主目录，所以一次刷新不会让你日常使用的 Codex 退出登录。

如果持有者的驱动已被杀掉，对它的运行执行 `teamai workflow resume` 或 `teamai workflow cancel` 会先停止工具（在步骤运行时上或本机上）并写回登录，再释放它。联系不上运行时，登录就继续被持有，命令会说明工具停止后如何放开该 attempt。

Codex 运行期间运行时自己停止，或之后无法关闭位置时，登录同样继续被持有，因为 Codex 可能还在那里运行。步骤失败为 `runtime_lost`，teamai 会说明怎么处理：

```text
⚠ Step runtime "sandbox" could not close the place of attempt a339da600, so what ran there may still run (runtime_exited): Step runtime "sandbox" stopped: it exited with status 70.
⚠ The codex login teamai keeps stays held by attempt a339da600 of run r9a395746ec65dbd7, whose tool may still run. Stop that tool on its step runtime; once run r9a395746ec65dbd7 has ended, run teamai workflow cancel r9a395746ec65dbd7 --release a339da600, which lets the attempt go and ends its login.
```

### 来自你环境的凭据

容器里的工具读不到保存在钥匙串里的登录。改为从你的环境给它一个令牌：`NAME: env:VARIABLE` 为步骤的工具设置 `NAME`，值取自你的 `VARIABLE`。

```yaml
# sandboxes/containers.yaml
provider: docker
image: ghcr.io/acme/agent:1
```

```yaml
# drivers/containers.yaml
schemaVersion: v1alpha1
name: containers
tool: claude
runtimes:
  - use: sandbox
    sandbox: containers
    options:
      credentials:
        CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN   # 来自 `claude setup-token`
        NPM_TOKEN: env:ACME_NPM_TOKEN                          # 私有仓库，在你 shell 里用另一个名字
  - use: tools
```

```sh
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/acme/claude-token)
export ACME_NPM_TOKEN=$(security find-generic-password -s acme-npm -w)
teamai workflow start review --driver containers
```

teamai 在运行开始或继续时读取每个变量一次。未设置的变量会在任何步骤运行前让启动停止：

```text
{"error":{"code":"credential_missing","message":"Runtime \"sandbox\" of driver definition drivers/containers.yaml in the team repo declares credential CLAUDE_CODE_OAUTH_TOKEN: env:CLAUDE_CODE_OAUTH_TOKEN, and CLAUDE_CODE_OAUTH_TOKEN is not set in your environment. Set CLAUDE_CODE_OAUTH_TOKEN, then start again."}}
```

如果运行时条目没有声明任何凭据，既没有 `env:` 凭据也没有登录，它会按名字拿到你环境中已设置的工具登录变量：Claude 的 `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`（连同 `ANTHROPIC_BASE_URL`），Codex 的 `OPENAI_API_KEY` 或 `CODEX_API_KEY`，以及 CodeBuddy 的 `CODEBUDDY_API_KEY` 或 `CODEBUDDY_AUTH_TOKEN`。这样团队的定义只需写出工具，每个成员用自己的方式登录。这些值和其他凭据一样会被遮盖。teamai 只把它们发给自己运行工具进程并提供 `can.env` 的运行时，并且每个变量只发给它所登录的工具：同时设置了 `ANTHROPIC_API_KEY` 和 `OPENAI_API_KEY` 时，Claude 步骤只拿到 `ANTHROPIC_API_KEY`，Codex 步骤只拿到 `OPENAI_API_KEY`。以自己的方式启动代理的运行时在它运行代理的地方为其登录，teamai 不会发给它这些值；不过和所有运行时一样，它的进程仍以你的环境启动。

这些值去哪里：

| 会得到 | 永远得不到 |
| --- | --- |
| 这个运行时上提示步骤的工具 | 命令步骤，或 setup |
| 发给自己启动智能体的运行时的 prompt | 定义里的其他运行时 |
| | 步骤扣留的名字，例如严格沙箱里的代码托管令牌 |
| | 任何文件：运行的记录、`runtime.json`、日志。工具打印出的值在 teamai 保存的内容里会被遮盖 |
| 这个运行时上的评审，只限它的工具在本机受限运行时读取的名字，例如 Claude 评审得到 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_BASE_URL`，任何评审都得到 `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`、`SSL_CERT_FILE` 和 `NODE_EXTRA_CA_CERTS` | 评审，任何其他名字：Claude 评审永远得不到 `OPENAI_API_KEY` |

只有提供 `can.env` 的运行时接受凭据，因为只有它决定每个进程的环境。`tools` 运行时不接受：你的步骤本来就在你的环境里运行。两种情况都会在启动时被拒绝为 `bad_option`。

团队运行时是队友推送的代码，所以只有在这台机器上有人接受过的修订才会运行。它目录下任何文件的改动都会产生新的修订。有人值守的运行在第一次启动前会询问：

```text
Step runtime "toy" comes from the team repo (runtimes/toy) at revision 3f9c0a1b2d4e, which you have not accepted on this machine. It runs as you, with your files. Review /home/me/.teamai/projects/…/workflows/runtime-copies/48213-9b1c0e7a4d2f-Xq3LZp (RUNTIME.yaml, runtime) before you accept it.
Run it? [y/N]
```

无人值守的运行不会询问。它失败为 `runtime_not_accepted`，什么也不启动。要接受这个修订，在终端里运行一次同样的命令。接受过的修订保存在 `~/.teamai/trust/runtimes.json`。

每次尝试在运行时上得到：

- 工作树，在主机上的原路径可读写。git 目录和 `.git` 指针只读。teamai 在主机上提交和推送，并关闭钩子、fsmonitor 和引用替换。
- `attempts/<attempt>/out/`，可读写。结果文件是 `out/result.json`。
- 提示步骤有自己的工具主目录：`attempts/<attempt>/tool-home/<tool>`，通过 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 或 `CODEBUDDY_CONFIG_DIR` 设置。提示步骤只在 Claude Code、Codex 或 CodeBuddy 上运行，并且只以无头方式运行，不能交互。评分、发布和之后续接这个会话的轮次都从这个目录读取会话。之后的轮次从它的副本开始。新的主目录带着你自己为该工具选的模型，不带你设置里的其他内容：Claude 取 `settings.json` 的 `model`、`effortLevel` 和 `modelSettings`，Codex 取 `config.toml` 的 `model` 和 `model_reasoning_effort`。步骤自己的 `model` 仍然优先。[自己启动智能体的运行时](runtime-protocol.md#自己启动智能体的运行时)没有工具主目录，除非它的 `init` 回答 `toolHome: true`（sandbox 就是这样）：它的工具把会话保存在 `tools` 运行时保存的位置。
- 租约提供的环境变量键、租约的 `env` 和这次尝试的标记。租约扣留的键会从运行时的环境里移除。
- 提示步骤得到它的运行时声明的[凭据](#来自你环境的凭据)。命令步骤得不到。

teamai 在发送每个操作之前，把它的操作 id 写入 `attempts/<attempt>/runtime.json`。teamai 被杀掉后，`workflow resume` 会再次发送同样的 id：

| 被杀掉的时机 | 继续运行时 |
| --- | --- |
| 运行时接受 `open` 之后 | 同一个句柄，不会打开第二个位置 |
| 运行时接受 `open` 后又让它失败 | 同一个失败；不会再次发送 `open` |
| 已发送 `open`，但 teamai 还没记下它的句柄 | `workflow cancel` 保留这次尝试，并说明运行时可能留着一个 teamai 无法关闭的位置：请自己在那里关闭它，然后运行 `teamai workflow cancel <run> --release <attempt>` |
| 一次 exec 结束之后 | 从运行时保存的内容读取它的输出、会话和用量，工具不会再次运行 |
| exec 运行期间 | 它被停止，步骤失败为 `runtime_interrupted`，工作会保留 |
| 一次 prompt 结束之后 | 从运行时保存的内容读取它的输出、会话和用量，不会再次发送 prompt |
| prompt 运行期间 | 再次发送同一个 prompt，重新连上那个智能体，步骤继续 |

`workflow cancel` 会停止正在运行的 exec 或 prompt，以及它启动的所有进程。驱动被杀掉时，cancel 会让这次尝试的运行时去停止它。即使运行时无法为新工作启动（例如它的提供方宕机，或登录过期），这也能工作：teamai 以 `recover` 模式打开它，这种模式只停止并关闭它运行过的东西。

无法停止工作的运行时会说明原因。teamai 随后保留位置、记录和登录，并打印运行时给出的建议：

```text
⚠ Could not stop attempt a3f0c2b1d of run r48201aa5c3e9d10b on step runtime "sandbox" of driver "containers": its exec or prompt may still run, since the runtime did not confirm it stopped (cancel_failed): docker could not stop container teamai-r48201aa5c3e9d10b-a3f0c2b1d: the daemon is not running. Start Docker, then run teamai workflow cancel r48201aa5c3e9d10b again.
⚠ The codex login teamai keeps stays held by attempt a3f0c2b1d of run r48201aa5c3e9d10b, whose tool may still run. Stop that tool on its step runtime, then run teamai workflow cancel r48201aa5c3e9d10b --release a3f0c2b1d, which lets the attempt go and ends its login.
```

解决原因后，再运行一次同样的 `teamai workflow cancel r48201aa5c3e9d10b`。这个运行已经取消，所以它会停止这次尝试、关闭它的位置、释放登录，并回答这个运行以及它关闭的尝试。没有可停止的内容时，它回答 `run_settled`：

```text
ℹ Stopped attempt a3f0c2b1d of run r48201aa5c3e9d10b on step runtime "sandbox" and closed its place.
ℹ Released the codex login teamai keeps, which attempt a3f0c2b1d of run r48201aa5c3e9d10b held.
{"data":{"run":{"id":"r48201aa5c3e9d10b","status":"cancelled"},"closed":["a3f0c2b1d"]}}
```

如果之前失败的只是 close，这一行改为说明它关闭的位置：`Closed the place of attempt a3f0c2b1d of run r48201aa5c3e9d10b on step runtime "sandbox", which an earlier close had kept.`

你取消时仍在运行的驱动，以及发现这样的 exec 仍在运行的 `workflow resume`，都会让步骤失败为 `runtime_lost` 并给出同样的建议，同样保留位置和登录。运行时能够停止它之后，对这个运行执行 `teamai workflow cancel` 就会停止它。

用一个不使用某个尝试所在运行时的驱动执行 `workflow resume`（包括 `--driver local`）时，会先通过为它记录的驱动停止被杀掉的驱动留在那里的东西，和 `teamai workflow cancel` 一样，然后在自己的运行时上重新运行这个步骤：

```console
$ teamai workflow resume r48201aa5c3e9d10b --driver local
ℹ Stopped attempt a3f0c2b1d of run r48201aa5c3e9d10b on step runtime "sandbox" and closed its place.
```

那个运行时无法确认停止时，步骤失败为 `runtime_lost`，给出应该用来恢复的驱动，并保留位置。

### 工具达到用量上限时

teamai 自己启动的工具（在 `tools` 运行时上，或通过运行时的 `exec`）达到用量上限时，teamai 从 Claude、Codex 或 OpenCode 自己的错误中识别额度上限，并保留原文，包括重置时间。模型 API 返回的速率限制，例如 Claude 的 `API Error: Request rejected (429)`，也算一次。answer 步骤的调用也一样，它用 `ai.tool` 指定的工具。[自己启动智能体的运行时](runtime-protocol.md#自己启动智能体的运行时)自己以 `usage_limited` 结束这样的提示。

本地驱动不会让这样的步骤失败。它交还该步骤，在额度重置前不再在驱动的任何运行时上用这个工具启动步骤；重置后在同一个工作区里再运行该步骤，工具停止前在那里做的改动都还在。用其他工具的步骤照常运行，有自己 home 的实例有自己的额度。fleet 成员也是如此，它用自己的账号登录：它遇到的额度只在 fleet 上挡住该工具，这期间本机的运行时可以运行该步骤。剩下的步骤只被额度挡住时，驱动等待重置，无人值守时最多等 6 小时。超过这个时间，或重置在它之后，驱动的 fleet 条目可以接手该步骤；否则运行会在 teamai-reports 上交出，就像只有人能处理的步骤那样。在终端里，驱动会改为询问：

```text
⚠ Step "review" stopped: claude hit its usage limit: You've hit your limit · resets 3pm (Europe/Madrid). teamai launches no more steps on claude until its limit resets, then runs the step again.
claude hit its usage limit, which resets at 15:00 (Europe/Madrid). Wait here until it resets, or offer run r7a1… to another machine on teamai-reports? [wait/offer]
```

运行该步骤的子智能体报告 `usage_limited` 时，skill 驱动也这样挡住该步骤：它在两次调用之间把额度上限和运行一起保存，每一轮都说明该步骤在等什么，额度重置后再次派发该步骤。无人值守时，超过 6 小时，它会在 teamai-reports 上交出运行。交不出时，这一轮会说明原因，并在步骤仍被挡住的情况下结束循环：额度重置后，从该会话继续这个运行。

### 编写步骤运行时

要在你自己的运行时上运行步骤，见 [编写步骤运行时](runtime-protocol.md)：从 toy 运行时开始，用场景测试套件测试你的运行时，再回答协议。

### 错误

| 错误 | 下一步 |
| --- | --- |
| `driver_not_found` | 添加 `drivers/<name>.yaml` 并运行 `teamai pull`，或者添加 `~/.teamai/drivers/<name>.yaml` |
| `driver_invalid` | 修正消息里指出的文件 |
| `driver_namespace_conflict`、`runtime_namespace_conflict` | 只在一个命名空间里保留这个名字，推送，然后运行 `teamai pull` |
| `runtime_not_found` | 把运行时安装到上面的某个位置 |
| `runtime_not_accepted` | 有人值守地运行一次这个命令，审查并接受这个修订 |
| `credential_missing` | 设置消息里给出的变量，然后再次启动或继续 |
| `bad_option` | 修正定义里的选项，或你配置里 `workflows.drivers` 下的选项 |
| `requirement_unmet` | 让定义里的某一个运行时提供步骤要求的全部内容，或修改步骤 |
| `login_missing` | 运行 `CODEX_HOME=~/.teamai/logins/codex codex login`，然后重试这个步骤 |
| `login_not_written_back` | 如果 Codex 刷新过令牌，用同一条命令重新登录，然后重试这个步骤 |
| `runtime_failed`、`runtime_interrupted` | 重试这个步骤：`teamai workflow retry <run> <step>` |
| `runtime_lost` | 步骤运行期间运行时停止了，所以它的工具可能还在那里运行。在运行时上停止它，如果警告给出了 `teamai workflow cancel <run> --release <attempt>` 就运行它，然后重试这个步骤 |

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

要准备驱动已经领取的 attempt，运行 `next <run> --prepare --attempt <attempt>`。运行不再把该 attempt 租给这个驱动时，返回 `wrong_attempt`。加上 `--adopt <dir>` 时，attempt 改在会话宿主创建的位置运行：该仓库的一个干净 worktree，位于租约的工作区分支上，或分离在其起点，就像 `git worktree add` 创建的那样。不符合的位置返回 `adopt_mismatch`，attempt 仍保持租约。TeamAI 在那里像在自己的 worktree 中一样 commit 和 push，但从不删除该位置。

提示词步骤的子代理在 `attempts/<attempt>/out/result.json` 的 `changed` 里列出它改过的每个路径，相对该位置。重命名要列出旧路径和新路径。TeamAI 只提交这些路径。git 会提交、但名单里没有的路径让步骤以 `unreported_changes` 失败：什么都不 commit、不 push，文件留在原地。步骤已经跑过并自己报了失败时，也是这个失败。步骤还没跑就失败时，例如这个会话跑不了所需的模型，保留那个失败，文件仍然不会被提交。准备时的合并已经暂存、并且步骤没有再改的文件属于这次合并，不必写进名单。

```json
{"kind":"output","output":"Fixed the null check.","changed":["src/app.ts","src/legacy.ts"]}
```

`adopt` 检查的是当时干净的树。宿主在这之后写入的文件不在名单里。下面的宿主配置是例子，本仓库不运行它们。Paseo 创建 worktree 时运行 `paseo.json` 的 `worktree.setup`。下面这段先等两秒，再写入一个 git 不会忽略的文件：

```json
{
  "worktree": {
    "setup": "sleep 2; echo host > .setup-out"
  }
}
```

T3 对 `t3.json` 里每个带 `runOnWorktreeCreate` 的脚本做同样的事：

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

步骤接着失败，CLI 的原文是英文：

```text
Step "fix" left .setup-out in /work/teamai-fix, which the step did not report changing, so nothing was committed or pushed. If your session host's setup wrote it, make setup write only files git ignores, or wait for it to finish before adopt. Otherwise remove it, then retry the step.
```

装到已被忽略的目录里不会失败。`.gitignore` 含有 `node_modules/` 时，这段 Paseo setup 把安装留在位置里，不放进 commit：

```json
{
  "worktree": {
    "setup": "npm install"
  }
}
```

命令步骤没有 `changed`。命令即将启动时位置已经不干净，命令不会运行，步骤以同样的方式失败。准备时放上的基线 agent 文件不算这份脏：仍与它们一致的路径被排除，命令会运行；命令没有改它们时，结束时把分支上的副本放回去。命令自己在运行期间写入的文件仍会被提交。所以要等宿主的 setup 结束后再 `adopt`，或让它只写 git 忽略的文件。经 CLI 发送、没有子代理 `result.json` 的报告仍会提交整棵脏树。名单由 skill 驱动提供。

TeamAI 为准备 attempt 记录的内容只保存在本机：路径和文件指纹，不含提示词、env 值或图。

## 在自己的驱动里使用克隆工作区

```text
teamai workflow next <run> --prepare --json '{"driver":{"kind":"script","machine":"runner","workspace":"/work","can":{"workspace":["read-only","new","continue","clone"],"isolation":"sandbox","env":true,"setup":true,"tools":["claude"],"end_turn":true}},"running":[]}'
```

带上 `--prepare` 时，teamai 在本机为[克隆步骤](#克隆工作区)创建克隆、安装其团队资源并运行 setup，然后返回带 `cwd`（即该克隆）的租约。一次调用可能要等 setup 运行完。驱动未在 `workspace` 中列出 `clone`，或没有用 `--prepare` 请求时，克隆步骤会被暂缓，`wait.held[].missing` 在缺少克隆支持时列出 `workspace.clone`，并列出提供克隆后仍然存在的缺口，例如 `prepare`、`isolation` 或 `env`。以团队角色运行的克隆还需要 `can.role`。[限定在一个目录里](#在自己的驱动里运行受限步骤)的步骤不需要位置：`--prepare` 返回带 `cwd`（即它的 `confined.dir`）的租约，不为它在 checkout 中创建、设置或快照任何东西。

对每个租约，驱动：

1. 运行每个进程时带上 `lease.env` 和 `TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>`，这样从中发出的 `teamai` 调用不会改变任何运行，并去掉 `lease.envScope.withhold` 里的名字。命令租约的 `env` 已经带有 `TEAMAI_WORKFLOW_ATTEMPT`、`TEAMAI_RUN_DIR` 和 `TEAMAI_MODE`，所以 [`teamai-score`](scorers.md) 的 `teamai score` 步骤在任何驱动下都能运行。工作流文件夹中步骤的每个租约，其 `env` 也带有 `TEAMAI_WORKFLOW_DIR`。它在 `cwd` 中运行命令租约（例如 `teamai benchmark plan`），没有 `cwd` 的租约则在它自己的工作区中运行，并把命令打印的 JSON 作为 `outputs`、把它的退出状态作为 `exitCode` 报告。
2. 在 `cwd` 中以 `lease.prompt` 启动 prompt 租约的 `lease.tool`，按原样使用 `lease.model`，并从工具启动起让它遵守 `lease.limits`。
3. 报告 prompt 时带上 `tool`、工具报告的 `model`、`session` 和 `tokens`、只围绕工具启动测得的 `durationMs`，以及仅在工具给出时才带的 `cost`（`{"amount":0.12,"unit":"USD"}`）。某个限制停止了工具时，报告带 `outcome: "success"` 和 `limit`：`timeout`、`budget` 或 `max_turns`；驱动无法让工具遵守的 `budget` 或 `max_turns` 列在 `unenforced` 中。`limit` 是租约没有设置的限制时，报告返回 `invalid_report`；带有 `changes` 或 `read`（由 teamai 从克隆中填写）的报告也一样。

`src/__tests__/e2e/benchmark-driver-contract.test.ts` 用这份约定检查运行 [benchmark](benchmarks.md#在自己的驱动里运行) 的驱动。

## 在自己的驱动里运行受限步骤

提供受限 Claude 的脚本在 `evidence` 成功后接下 [`judge-change`](workflow.md#限定在一个目录里的提示步骤) 的 `judge` 步骤，在 `confined.dir` 中运行它，并报告回复：

```console
$ teamai workflow next r245b… --prepare --json '{"driver":{"kind":"script","machine":"runner","workspace":"/work/app","can":{"workspace":["read-only"],"confined":[{"level":"best-effort","access":"read","tools":["claude"]}]}}}'
{"data":{"lease":{"attempt":"afd63…","revision":2,"run":"r245b…","step":"judge","pass":1,"prompt":"Read change.diff. Answer pass when the change does one thing and tests it, else fail.","output":{"type":"object","fields":{"verdict":{"type":"enum","values":["pass","fail"]}}},"confined":{"dir":"/home/ana/.teamai/workflows/runs/r245b…/scratch/evidence","level":"best-effort","tools":["claude"]},"cwd":"/home/ana/.teamai/workflows/runs/r245b…/scratch/evidence"},"cancelled":[]}}
$ teamai workflow report r245b… --json '{"attempt":"afd63…","revision":2,"outcome":"success","driver":{…},"outputs":{"verdict":"fail"},"confined":{"tool":"claude","isolation":"best-effort","access":"read","model":{"reported":"claude-sonnet-4-6"}}}'
{"data":{"accepted":true,"revision":3,"step":{"id":"judge","status":"succeeded","outcome":"success"}}}
```

[限定在一个目录里](workflow.md#限定在一个目录里的提示步骤)的步骤只租给 `can.confined` 中有不低于其级别的提供的驱动。它的租约带 `confined`：`dir`、`level`、`tools`（达到该级别的各提供中的工具，按顺序排列，`prefer` 列出的工具按其顺序在最前；有 `require` 时只有它指定的那个工具），以及 `confined.json` 指定了 schema 时的 `schema`。这些工具在本机都解析不了该步骤的模型时，步骤等待，`wait.held[].missing` 列出 `model`；没有提供达到其级别，或达到其级别的提供中没有所要求的工具时，列出 `confined`。

驱动在 `tools` 中第一个能解析 `lease.model` 的工具上运行 `lease.prompt`，以 `dir` 作为工具的工作目录和唯一可读的根目录，不带任何团队 env，也不保留会话。它把回答作为 `outputs` 报告，TeamAI 按步骤的 `output` 检查它，并按这次运行的测量报告 `confined`：`tool`、`isolation`、`access`，以及工具报告了时的 `model`、`effort` 和 `usage`。找不到工具运行的驱动报告 `outcome: "released"`。`src/workflow/conformance/confined.ts` 中的 `confinedConformanceScenarios` 检查这些租用规则。

## 在自己的驱动里评审

评审任务和其他运行一样：driver 驱动回答在 `started` 中列出的每个 teamai-score 运行，其评审步骤是[受限步骤](#在自己的驱动里运行受限步骤)。见[评分器](scorers.md#任意-driver)。

无人值守的 driver 以 `teamai score --drain` 结束。它评判本机能评判的工作，发布运行记录、标签和会话，并输出留给其他 driver 的工作。本地驱动在无人值守运行结束时执行它（无人值守会话的发布和评判都设为 `off` 时除外）：先在 stdout 输出运行的 `done` 信封，再在 stderr 输出 drain 的各行。退出状态仍是运行本身的结果，drain 失败时也一样。见[无人值守任务结束前运行 drain](scorers.md#无人值守任务结束前运行-drain)。
