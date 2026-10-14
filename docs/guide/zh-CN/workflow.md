# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它按顺序运行命令步骤和只读提示词步骤。

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

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，最多指定一个动作：`command`、`prompt`、`prompt_file`、`workflow` 之一（或纯 `end` 步骤）。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

### 依赖关系与条件执行

使用 `needs` 声明有向无环图（DAG）依赖。当步骤未声明 `needs` 时，按顺序执行。

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

- **汇聚规则（Join rule）**：具有多个依赖的步骤，仅当其所有依赖项均被跳过（skipped）时才会被跳过。
- **条件表达式（`if`）**：支持布尔逻辑、比较（`==`、`!=`、`<`、`<=`、`>`、`>=`），可读取 `inputs.*` 或已结算的步骤属性 `steps.<id>.outcome`、`steps.<id>.outputs.*` 与 `steps.<id>.end`。不使用 JavaScript `eval`。
- **故障恢复分支（Recovery branches）**：当依赖项失败时，后续步骤默认会被跳过，除非其 `if` 条件明确读取了失败的依赖项。

### 输入与命令环境变量

在工作流根层级声明 `inputs`。命令步骤仅通过声明的 `env:` 映射接收输入值。命令字符串本身不会进行模板展开，能防止输入包含 `$(...)` 等字符时被 shell 误执行。

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

### 子工作流与组合

步骤可通过名称调用另一个工作流（文件子工作流），或声明内联子工作流。

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

文件子工作流的输入仅限于 `with:` 传入的参数，作用域相互隔离。内联工作流可访问外层作用域中的变量。

### 输出与命名结束状态

声明 `outputs` 导出工作流结算后的值。声明 `ends` 定义命名的终态（`succeeded` 或 `failed`），可提前结算工作流，并将终态名称暴露给父级步骤（如 `steps.<id>.end`）。

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

`teamai pull` 和 `teamai push` 分别检查每个文件。`prompt_file` 必须是团队仓库 `prompts/` 下的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存。这一版 teamai 不认识的字段除外：该工作流没有可运行版本，需要先更新 teamai。

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

`--driver local` 在当前目录里一次运行一个步骤。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。提示词步骤只读；如果工具修改了仓库，步骤会失败，同时保留文件供检查。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 结束时，退出码是 1。不会留下常驻的工作流进程。
