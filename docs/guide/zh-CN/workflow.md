# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它运行命令步骤和只读提示词步骤，每个步骤在它依赖的步骤之后运行。

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

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且必须且只能使用 `command`、`prompt`、`prompt_file`、`workflow` 之一。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

第一个步骤之后的每个步骤都要用 `needs` 列出它等待的步骤。`needs: []` 表示另起一个没有依赖的分支。每次只运行一个步骤：文件中第一个依赖都已完成的步骤。某个依赖失败，或所有依赖都被跳过时，该步骤会被跳过。被跳过的步骤不会运行。一个步骤失败不会停止其他分支。没有可运行的步骤时，只要有步骤失败，运行结果就是 `failed`，否则是 `succeeded`。缺少 `needs`、`needs` 中的 id 不是本工作流的步骤，或依赖成环，都会让该文件无效。缺少 `needs` 时，即使之前有有效版本，该工作流也没有可运行版本。

步骤可以带 `if` 表达式。表达式为假时跳过该步骤，这不会让运行失败。表达式可以读取 `steps.<id>.outcome`（`success`、`failed` 或 `skipped`）和 `steps.<id>.outputs.<field>`，且只能读取该步骤直接或间接依赖的步骤。可用 `==`、`!=`、`&&`、`||`、`!`、括号，以及字面量 `'text'`、数字、`true`、`false`、`null` 和 `[]`。不存在的值读作 `null`。`false`、`null`、`0` 和 `''` 为假，其他值都为真。`==` 是严格比较，并比较整个值：`'1' == 1` 和 `'Build' == 'build'` 都为假。

依赖失败的步骤，如果 `if` 读取了每个失败的依赖，仍会运行。可以用它做补救：

```yaml
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: gh issue edit 42 --add-label needs-human
```

除非到达某个结局，运行结果仍是 `failed`。`if` 无法解析、读取了未依赖的步骤，或读取了该步骤 `output` 中没有的字段，都会让该文件无效。`if` 恒为假也会让文件无效，此时即使之前有有效版本，该工作流也没有可运行版本。

`teamai pull` 和 `teamai push` 会检查每个文件，并按被运行工作流的可运行版本检查运行它的步骤。`prompt_file` 必须是团队仓库 `prompts/` 下的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存，前提是这份缓存仍与它运行的工作流相符。这一版 teamai 不认识的字段除外：该工作流没有可运行版本，需要先更新 teamai。

工作流可以声明具名的 `ends`，每个结局是 `succeeded` 或 `failed`，例如 `ends: { dropped: succeeded, stuck: failed }`。带 `end: <name>` 的步骤成功后，工作流以该结局结束。只有 `id`、`needs`、`if` 和 `end` 的步骤不运行任何内容：它的依赖完成时就结束工作流。到达结局后，所有尚未运行的步骤都会被跳过，运行结果取该结局声明的结果，即使有其他步骤失败。此时 `done` 会带上结局：`{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`。`end` 不在 `ends` 中、有 `end` 但没有 `ends`、声明的结局没有步骤使用，或某个步骤依赖只用于结束工作流的步骤，都会让该文件无效。

工作流可以用和 `output` 相同的简写声明 `inputs`，例如 `inputs: { issue: number, title: string }`。每个输入都必填。用 JSON 对象传入：`teamai workflow start fix --driver local --inputs '{"issue":42,"title":"Crash"}'`。缺少、多出或类型不对的输入会返回 `invalid_inputs` 并指出字段，且不会创建运行。`if` 可以读取 `inputs.<name>`。

`{{ inputs.<name> }}` 和 `{{ steps.<id>.outputs.<field> }}`（或 `.outcome`）会在步骤开始时填入 `prompt`、`prompt_file` 的文本和 `env` 的值。其他 `{{ ... }}` 文本，例如 `${{ secrets.TOKEN }}`，保持原样。紧跟在 `$` 后面的 `{{` 也保持原样，例如讲解 GitHub Actions 的提示词中的 `${{ inputs.version }}`。要在 `$` 后面填入值，请加一个空格：`$ {{ inputs.price }}`。字符串原样填入，数字和布尔值填入其文本，对象和数组填入 JSON，`null` 或不存在的值填入空文本。模板只能读取该步骤的 `if` 能读取的内容。

`command` 永远不会被填充。通过 `env` 把值传给命令，只有命令步骤可以有 `env`：

```yaml
  - id: label
    needs: [plan]
    command: gh issue edit "$ISSUE" --title "$TITLE"
    env:
      ISSUE: "{{ inputs.issue }}"
      TITLE: "{{ steps.plan.outputs.title }}"
```

命令在原有环境之上获得这些变量，因此 `$(touch pwned)` 这样的值只是普通文本。变量名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`。YAML 数字或布尔值按其文本传入。`command` 中出现模板、提示词步骤带 `env`，或 `if`、模板读取了工作流未声明的输入，都会让该文件无效。模板无法解析或读取了不能读取的内容时，即使之前有有效版本，该工作流也没有可运行版本。步骤 id 或字段名中含有 `.` 时也是如此。

步骤可以用 `workflow: <name>` 运行 `workflows/` 中的另一个工作流，并用 `with` 传入该工作流的输入：

```yaml
  - id: check
    needs: [plan]
    workflow: check-issue
    with:
      issue: "{{ inputs.issue }}"
      task: "{{ steps.plan.outputs.task }}"
```

`with` 中任意层级的字符串都是模板。恰好只有一个模板的字符串保留其 JSON 类型，所以 `task` 拿到的是对象本身；其他字符串都是文本。步骤就绪时，这些值会按子工作流的 `inputs` 校验，不匹配时该步骤以 `invalid_inputs` 失败。子工作流只能看到自己的输入和步骤。它的步骤代替该步骤运行，并按路径租用，例如 `check.classify`。该步骤的结果就是子工作流的结果。子工作流中的 `end` 只结束子工作流，父工作流通过 `steps.<id>.end` 读取它。子工作流用 `outputs` 返回值，每个值是指向它某个步骤的路径，例如 `outputs: { verdict: steps.classify.outputs.verdict }`，父工作流读取 `steps.<id>.outputs.verdict`。运行工作流的步骤不能有 `output`、`agent` 或 `env`。

`prompt` 或 `prompt_file` 步骤也可以有 `with`，这样多个工作流可以共用一个提示词文件。这些值遵循同样的规则，提示词用 `{{ with.<name> }}` 读取它们，例如 `Fix {{ with.task }}`。`{{ with.<name> }}` 只在 `with` 中有该名称的步骤的提示词里有效。命令步骤不能有 `with`，应使用 `env`。

`workflow: <name>` 按名称在 `teamai pull` 写入的已校验缓存中查找，而不是在文件中查找。`workflow start` 从该缓存取出运行用到的每个工作流并保存在运行中，因此之后的 pull 不会改变进行中的运行。子工作流没有可运行版本，或工作流之间循环调用时，`start` 会报错并指出它们。`teamai pull` 会在父工作流的对应步骤上报告同样的问题，以及与子工作流 `inputs` 不匹配的 `with` 键、读取子工作流未声明的输出或结束名称；出现这种读取时，父工作流也会没有可运行的版本。

步骤也可以直接写出它运行的工作流，把一组步骤当作一个步骤：

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

内联工作流包含 `steps`，以及可选的 `ends` 和 `outputs`，用法与文件中相同。它没有 `inputs`，它所在的步骤也不能有 `with`：它的步骤读取外层工作流的输入，以及外层步骤直接或间接 `needs` 的步骤。内联工作流中与外层步骤同 id 的步骤会遮住外层那个步骤。它的步骤按路径租用，例如 `check.classify`；其中的 `end` 只结束这个内联工作流。内联工作流可以运行工作流文件，也可以再包含内联工作流。

在本地配置中按机器选择无界面工具：

```yaml
workflows:
  tools:
    default: claude
    implementer: codex
```

有 agent 专用配置时优先于 `default`。支持 `claude`、`codex` 和 `opencode`。CI 可以在单次启动时用 `--tools default=claude,implementer=codex` 覆盖。命名 agent 从 `teamai pull` 已经部署到该工具、该 scope 目录里的文件读取。

```text
teamai workflow start build --driver local
```

`--driver local` 在当前目录里一次运行一个步骤。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。提示词步骤只读；如果工具修改了仓库，步骤会失败，同时保留文件供检查。这也包括已有未跟踪目录内的文件变化；该目录保持不变时，步骤不会因此失败。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 结束时，退出码是 1。不会留下常驻的工作流进程。
