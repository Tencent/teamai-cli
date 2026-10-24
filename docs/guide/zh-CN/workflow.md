# 工作流

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

工作流是团队仓库里的 `workflows/<name>.yaml`。它运行命令步骤和提示词步骤，每个步骤在它依赖的步骤之后运行。没有 workspace 的命令是只读的；[工作区](#工作区)说明步骤如何在自己的分支上改代码。[高级工作流](workflow-advanced.md) 介绍并行步骤、循环、`for_each`、到达结局时仍在运行的步骤会怎样，以及完整的表达式语言。

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

`schemaVersion` 必须是 `v1alpha1`。`name` 必须和文件名一致。`description` 必填。每个步骤有唯一的 `id`，并且只能使用 `command`、`prompt`、`prompt_file`、`workflow` 中的一种动作。带有 `end`、`approve` 或 `choose` 的步骤可以省略动作。提示词步骤可选填 `agent`。`output` 沿用已有简写：`string`、`number`、`boolean`、字面量联合、对象，或只含一种元素类型的数组。TeamAI 会用它校验成功命令的 stdout 或提示词工具返回的 `output`。

本地命令步骤以 UTF-8 读取 stdout 和 stderr。JSON 字符串中的非 ASCII 文本会原样保存到输出中，后续步骤读取时也保持原文。

提示词步骤可以设置 `model`：`models/aliases.yaml` 中的别名或模型名，不能含空格或模板。文件顶层的 `defaults: { model: fast }` 为其中的提示词步骤设置模型。提示词步骤使用以下第一个已设置的模型：

1. 步骤的 `model`；
2. 其 agent 定义为该工具设置的模型；
3. `defaults.model`；
4. 工具的默认模型。

步骤的 `model` 替换 agent 的模型和推理强度（effort），保留其他设置。不是别名的模型名使用工具默认的推理强度。被另一个工作流运行的工作流文件使用自己的 `defaults.model`，没有时使用运行它的步骤所在处生效的那个。内联工作流使用外层的。别名没有该步骤工具的模型，或成员的 `~/.teamai/models/aliases.yaml` 关闭了它时，步骤会在工具启动前以 `model_unavailable` 失败。在 OpenCode 1 上，步骤的 `model` 是其 agent 自己的模型且没有推理强度、而 agent 文件设置了 `variant` 且 `mode` 不是 `subagent` 时，也会这样失败，因为 OpenCode 1 会套用那个 variant。OpenCode 2 不从 agent 文件读取模型和 variant，OpenCode 1 的 `opencode run --agent` 也不会启动 subagent，所以驱动在命令行上传入定义自己的模型和 variant。对 `mode: subagent` 的 agent 文件（pull 默认这样写），OpenCode 1 从提示词中获得 agent 的指令，驱动会对此时不生效的文件设置发出警告。租约原样携带 `model` 和 `defaultModel`，由驱动解析。

提示词步骤或工作流步骤可以列出[评分器](scorers.md)，用来评判它成功的执行：

```yaml
schemaVersion: v1alpha1
name: ship
description: Implement the change, then review it.
defaults:
  scorers: { batch: true }
steps:
  - id: implement
    prompt: Implement the change.
    scorers: [review-quality]
  - id: review
    needs: [implement]
    prompt: Review the change.
    scorers: { names: [review-quality], batch: false }
```

第一个步骤之后的每个步骤都要用 `needs` 列出它等待的步骤。`needs: []` 表示另起一个没有依赖的分支。每次 `next` 租出文件中第一个依赖都已完成的步骤。`--driver local` 一次运行一个步骤，除非 `workflows.max_parallel` 大于 1。某个依赖失败，或所有依赖都被跳过时，该步骤会被跳过。被跳过的步骤不会运行。一个步骤失败不会停止其他分支。没有可运行的步骤时，只要有步骤失败，运行结果就是 `failed`，否则是 `succeeded`。缺少 `needs`、`needs` 中的 id 不是本工作流的步骤，或依赖成环，都会让该文件无效。缺少 `needs` 时，即使之前有有效版本，该工作流也没有可运行版本。

步骤可以带 `if` 表达式。表达式为假时跳过该步骤，这不会让运行失败。表达式可以读取 `steps.<id>.outcome`（`success`、`failed` 或 `skipped`）和 `steps.<id>.outputs.<field>`，且只能读取该步骤直接或间接依赖的步骤。可用 `==`、`!=`、`<`、`<=`、`>`、`>=`、`&&`、`||`、`!`、括号，以及字面量 `'text'`、数字、`true`、`false`、`null` 和 `[]`。路径可以用下标读取数组元素，例如 `steps.review.outputs.files[0]`。函数 `length`、`any`、`all` 和 `filter` 读取数组。不存在的值读作 `null`。`false`、`null`、`0` 和 `''` 为假，其他值都为真。`==` 是严格比较，并比较整个值：`'1' == 1` 和 `'Build' == 'build'` 都为假。

依赖失败的步骤，如果 `if` 读取了每个失败的依赖，仍会运行。可以用它做补救：

```yaml
  - id: label
    needs: [check]
    if: steps.check.outcome == 'failed'
    command: gh issue edit 42 --add-label needs-human
```

除非到达某个结局，运行结果仍是 `failed`。`if` 无法解析、读取了未依赖的步骤，或读取了该步骤 `output` 中没有的字段，都会让该文件无效。`if` 恒为假也会让文件无效，此时即使之前有有效版本，该工作流也没有可运行版本。

`teamai pull` 和 `teamai push` 会检查每个文件，并按被运行工作流的可运行版本检查运行它的步骤。`prompt_file` 必须是团队仓库 `prompts/` 下的普通文件，不能是符号链接。校验时会把文件内容和工作流一起缓存，因此已经开始的运行会继续使用对应修订版，即使源文件后来被修改或删除。新修订版无效时，仍保留上一份有效缓存，前提是这份缓存仍与它运行的工作流相符。这一版 teamai 不认识的字段除外：该工作流没有可运行版本，需要先更新 teamai。

`teamai review --branch <name>` 用同样的规则检查该分支。任一工作流文件无效，或步骤的 `model`、`defaults.model` 是分支的 `models/aliases.yaml` 没有为任何工具映射的别名时，退出码为 1。它不写入任何文件，也不运行工作流。下面这个文件过不了检查：

```yaml
schemaVersion: v1alpha1
name: deploy
description: Ship the release candidate.
steps:
  - id: release
    needs: [biuld]
    command: echo release
```

```text
teamai review --branch feature/deploy
[review] branch feature/deploy: 1 fail, 0 warn, 0 info
  ✖ [workflows] workflows/deploy.yaml:6: field "steps[0].needs": step "release" needs "biuld", which is not a step in this workflow
```

CI 里用一步拦住这个分支：

```yaml
- run: teamai review --branch feature/deploy
```

工作流可以声明具名的 `ends`，每个结局是 `succeeded` 或 `failed`，例如 `ends: { dropped: succeeded, stuck: failed }`。带 `end: <name>` 的步骤成功后，工作流以该结局结束。只有 `id`、`needs`、`if` 和 `end` 的步骤不运行任何内容：它的依赖完成时就结束工作流。到达结局后，所有尚未运行的步骤都会被跳过，运行结果取该结局声明的结果，即使有其他步骤失败。此时 `done` 会带上结局：`{"done":{"run":"<run>","outcome":"succeeded","end":"dropped"}}`。`end` 不在 `ends` 中、有 `end` 但没有 `ends`、声明的结局没有步骤使用，或某个步骤依赖只用于结束工作流的步骤，都会让该文件无效。

工作流可以用和 `output` 相同的简写声明 `inputs`，例如 `inputs: { issue: number, title: string }`。每个输入都必填。用 JSON 对象传入：`teamai workflow start fix --driver local --inputs '{"issue":42,"title":"Crash"}'`。缺少、多出或类型不对的输入会返回 `invalid_inputs` 并指出字段，且不会创建运行。`if` 可以读取 `inputs.<name>`。

`{{ inputs.<name> }}` 和 `{{ steps.<id>.outputs.<field> }}`（或 `.outcome`）会在步骤开始时填入 `prompt`、`prompt_file` 的文本和 `env` 的值。模板也可以像 `if` 一样对表达式求值，例如 `{{ length(steps.review.outputs.files) }}`。其他 `{{ ... }}` 文本，例如 `${{ secrets.TOKEN }}`，保持原样。紧跟在 `$` 后面的 `{{` 也保持原样，例如讲解 GitHub Actions 的提示词中的 `${{ inputs.version }}`。要在 `$` 后面填入值，请加一个空格：`$ {{ inputs.price }}`。字符串原样填入，数字和布尔值填入其文本，对象和数组填入 JSON，`null` 或不存在的值填入空文本。模板只能读取该步骤的 `if` 能读取的内容。

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

`with` 中任意层级的字符串都是模板。恰好只有一个模板的字符串保留其 JSON 类型，所以 `task` 拿到的是对象本身；其他字符串都是文本。步骤就绪时，这些值会按子工作流的 `inputs` 校验，不匹配时该步骤以 `invalid_inputs` 失败。子工作流只能看到自己的输入和步骤。它的步骤代替该步骤运行，并按路径租用，例如 `check.classify`。该步骤的结果就是子工作流的结果。子工作流中的 `end` 只结束子工作流，父工作流通过 `steps.<id>.end` 读取它。子工作流用 `outputs` 返回值，每个值是指向它某个步骤的路径，例如 `outputs: { verdict: steps.classify.outputs.verdict }`，父工作流读取 `steps.<id>.outputs.verdict`。运行工作流的步骤不能有 `output`、`agent`、`model` 或 `env`。

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

`--driver local` 在当前检出目录里运行没有 `workspace` 的步骤，除非外层步骤打开了工作区。这里的命令是只读的：退出码为 0，且改了仓库文件、文件权限、符号链接目标、已暂存重命名的新路径、已脏子模块里的文件、暂存区或 HEAD 时，步骤失败，改动留在原地。已有未跟踪目录里的文件变化也算；该目录保持不变时，步骤不会因此失败。`workspace: new` 的步骤在自己的分支上改文件。见[工作区](#工作区)。共用当前检出目录的步骤一次只运行一个。不同工作树里的步骤可以一起运行，上限是 [`workflows.max_parallel`](workflow-advanced.md#并行运行本地命令)。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。`changes` 的 `branch` 或 `base` 与租约不符时返回 `invalid_report`，步骤仍处于租约中。工作区里的只读步骤上报 `read`（`branch`、`base` 和它读取的 `commit`），而不是 `changes`。它上报 `changes`、成功时没有 `read`、其他步骤上报 `read`，或 `read` 与租约不符时，同样返回 `invalid_report`。`used`（`{"skills":["review-notes"]}`）写明该轮次加载过的团队技能，供它的[评分标签](scorers.md#任意-driver)使用。不是技能名的值会被丢弃，其他形状的 `used` 返回 `invalid_report`。CLI 不读取的 payload 字段——例如把 `tokens` 拼成 `tokenz`，或来自更新协议版本的字段——会被接受但回报出来：`next`、`report` 和 `respond --json` 的成功信封会带上 `ignored`，先列顶层字段、再列 `driver.<字段>`，只有名字、没有值。没有未读字段时不带这个键，错误信封保持原样。

运行状态保存在当前 scope 的 TeamAI 数据目录里。命令结束后进程就退出。本地运行以 `failed` 或 `cancelled` 结束时，退出码是 1。不会留下常驻的工作流进程。

等待 HITL 请求用 `workflow respond <run> <step> <choice>` 回答，失败或卡住的步骤用 `workflow retry <run> <step>` 重试，`workflow cancel <run> [step]` 停止工作，`workflow resume <run>` 继续本地执行，`workflow publish <run>` 让另一台机器接着运行（见[在另一台机器上继续运行](#在另一台机器上继续运行)）。next 返回 lease、hitl、wait 或 done。参见[HITL](workflow-advanced.md#hitl人在回路中)和[重试、取消和继续运行](workflow-advanced.md#重试取消和继续运行)。本地运行以 failed 或 cancelled 结束时退出码为 1。结束运行的操作在锁内排队写入结束记录，在释放锁后发布；重试后仍更新同一路径。回答记录只发布 choice、channel 和 agent，备注、回答时间和回答驱动身份只保存在本地。

## 工作区

没有 `workspace` 的命令是只读的。在工作区之外，它在当前检出目录中运行。退出码为 0，且改了仓库文件、文件权限、符号链接目标、已暂存重命名的新路径、已脏子模块里的文件、暂存区或 HEAD 时，步骤以 `read_only_dirty` 失败，改动留在原地。没有 `workspace` 的无头提示词也一样，除非外层工作流或 `for_each` 打开了工作区。交互提示词会保留人的修改，除非该提示词设置了 `workspace: read-only`。即使 `submodule.<name>.ignore` 或 `diff.ignoreSubmodules` 让 `git status` 不显示子模块的改动，这些改动也算数：只读步骤做了这类改动会失败，写入的步骤会提交子模块的新提交。

在外层步骤打开的工作区里，只读步骤在该工作区中运行，因此测试能看到它所跟随的改动。它读取 `needs` 改动过的分支；`needs` 没有改动任何分支时，读取外层分支。`needs` 改动了不止一个分支时，它以 `workspace_base` 失败：添加一个合并这些分支的步骤，并依赖该步骤。它与该工作区的其他步骤一次只运行一个，使用同样的基准 agent 文件，只有声明了 `continue` 且拥有该工作区的驱动才会领取它。它不提交任何内容。结束后，驱动把工作区恢复成步骤开始时的样子：步骤改动了工作区或离开了它的分支时，改动先保存在 `refs/teamai/kept/<attempt>`，它在子模块里做的提交保存在 `refs/teamai/kept-modules/<attempt>/` 下。然后 worktree 和步骤改动过的子模块重置到它读取的提交，并删除未跟踪文件；退出码为 0 时仍以 `read_only_dirty` 失败。被忽略的文件留在原地。步骤改动过的子模块里有未提交或未跟踪的文件时无法保存，这时什么都不重置。工作区没有恢复时，步骤以 `workspace_base` 失败。步骤开始时工作区就会被标记，所以即使驱动在步骤运行时被杀掉，之后在该工作区的步骤也都会失败，直到你把它放回它的分支、停在那个提交、恢复成步骤开始时的样子，再运行 `teamai workflow retry <run> <step>`。如果步骤开始时工作区已有改动，还要删除失败信息中给出的标记文件。该 pass 记录 `read`：分支、基准和它读取的提交。工作区是新的 worktree，没有 `node_modules` 这类被忽略的文件，所以测试要自己安装依赖，例如 `npm ci && npm test`，除非团队的 [`postDeploy`](distribution.md#团队脚本) 已经安装。

`workspace: new` 在独立的 git worktree 里运行该步骤，分支名带有这次运行、步骤和 pass。步骤会提交它改过的文件。步骤离开了该分支（例如用 `git switch`）时，以 `workspace_base` 失败：不提交也不推送任何内容，worktree 保持步骤离开时的样子。当前检出目录不会被切换、重置或清理。在 `needs` 里列出它的后续步骤，从这些分支的第一个开始，再按 `needs` 的顺序合并其余分支。合并冲突会停在第一处。命令步骤以 `merge_conflict` 失败，消息里写明分支和文件。提示词步骤会被告知哪些文件仍有冲突、哪些分支还没合并。

`workspace: continue` 留在外层 `workflow` 步骤用 `new` 打开的那条分支上。没有 `workspace` 的提示词会沿用这份副本。带 `workspace: new` 的 `for_each` 给每一项自己的分支，因此各项不共用一个 worktree。`steps.<id>.branches` 列出这些分支；某一项有分支时，对应的 `results` 条目带 `branch`。带 `after` 的项从它等待的那些分支开始。顶层的 `workspace: continue` 没有外层 `new` 时，步骤以 `workspace_base` 失败。

步骤看到的是运行开始时那个提交上的 agent 文件：`AGENTS.md`、`CLAUDE.md`、`.agents`、`.githooks`，每个工具的项目目录（如 `.claude` 或 `.tclaude`），项目级 MCP 文件 `.mcp.json` 和 `opencode.json`，以及 Copilot 在 `.github` 下的 agent 路径。前一个步骤提交的 hook 不会在后面的步骤里运行。团队的 skills、rules、agents 和 MCP 随后会交付到这个 worktree，和这个检出目录的其他新 worktree 一样。这些交付的文件不属于该步骤的提交。步骤自己改过的文件会被提交。

检出目录有 `origin`，并且这一步产生了提交时，驱动会推送该分支，步骤失败时也一样。后一次尝试即使没有新提交，只要这个分支上有 `origin` 还没有的提交，仍会再推一次。这包括第一次推送根本没成功，以及 `origin` 上还没有任何分支。推送失败时，成功的步骤以 `push_failed` 失败，并保留 worktree。本身已失败的步骤保留自己的失败，消息里再补充推送失败。没有 `origin`，或 `origin` 已经有这个提交时，运行仍然成功，并报告该分支。

`session: continue` 用同一个工具恢复这一步上一 pass 的会话。`session: { from: <步骤> }` 恢复这一步所依赖的步骤。换成别的工具时，会把会话复制到该工具里，再恢复这份副本。OpenCode 也会拿到副本，但总是新开会话，因为它没有恢复会话的参数。步骤恢复的会话，是最后一个继续它的步骤留下的样子，不管那个步骤在哪个工具或哪台机器上运行。新开会话的步骤（例如 OpenCode 步骤）不会改变后续步骤恢复什么。

自己启动沙箱的命令（例如 `docker`）仍然是只读的。它写出去的内容不会变成后续步骤可以合并的分支。

```yaml
schemaVersion: v1alpha1
name: change
description: Change two files on their own branches, then join them.
steps:
  - id: left
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('left.txt', 'L')"
  - id: right
    needs: []
    workspace: new
    command: node -e "require('fs').writeFileSync('right.txt', 'R')"
  - id: join
    needs: [left, right]
    workspace: new
    command: node -e "require('fs').writeFileSync('joined.txt', 'J')"
```

## 在另一台机器上继续运行

运行保存在启动它的那台机器的 TeamAI 数据目录里。要在别处接着运行，先发布它，再在另一台机器上继续。适用的情况：工具在运行中途用完了 token，把运行交给队友，或者 CI 里的运行失败了，你想在自己的机器上把它跑完。

```text
teamai workflow publish <run>     # 在有这个运行的机器上
teamai workflow resume <run>      # 在另一台机器上，位于同一个仓库的检出目录中
```

`publish` 把运行状态写到团队的 `teamai-reports` 分支，并让本安装实例成为该运行的所有者。先停止驱动，让没有步骤在执行。发布时仍处于租约中的步骤会在另一台机器上重新运行。按 Ctrl-C 后，正在执行的步骤写下的内容会留在本机该步骤的工作树里，另一台机器仍然可以认领这个运行。之后你在运行仍在进行时把它接管回本机，认领会让本安装实例成为所有者，但 `resume` 会返回 `branch_diverged` 并指出那个工作树。把这些改动移到别处或删除，再执行 `resume`。在没有这个运行的机器上，`resume` 从 `teamai-reports` 取得它，让该安装实例成为所有者，并用本地驱动运行它。

已发布的运行只有所有者能继续。在另一个已有该运行的安装实例上，`resume` 和 `publish` 都返回 `not_owner`，带上所有者的用户名和安装实例 id。同一成员的两个安装实例显示相同的用户名，靠安装实例 id 区分。要接管这个运行，执行 `teamai workflow resume <run> --claim`。认领会替换本机的运行副本，并释放其他机器持有的租约。此后原所有者不能再发布或继续这个运行，除非它再认领回来。

已发布的运行结束时，teamai 会发布它的结束状态，不带 `--sessions`。之后接手该运行的成员不会重新运行它的任何步骤。

无论[使用统计上报](reporting.md)是否开启，`publish` 都会写入运行状态：这是另一台机器继续运行所需的状态，不是使用统计上报。从未发布的运行留在本机。使用统计上报开启时，只有它的[运行记录](#运行记录)会进入 `teamai-reports`。

带 `session: continue` 或 `session.from` 的步骤在另一台机器上会开一个新的 agent 会话，除非发布时加上 `--sessions`。运行在机器之间来回交接时，每台继续过会话的机器都要在下一次认领前用 `--sessions` 发布，这样下一个步骤能拿到所有对话轮次。[发布和认领](workflow-advanced.md#发布和认领)说明发布的状态包含什么、每个错误及下一步怎么做，以及如何从 CI 发布。

## 运行记录

开启[使用统计上报](reporting.md)时，每次运行都会向团队的 `teamai-reports` 分支发布一条保护隐私的记录：开始时一次，结束时一次。关闭后不发布任何记录，返回中也不带 `record`。记录存放在 `workflows/runs/<run id>.json`，以 run id 为键，重试的发布会更新同一条记录而不是产生副本。

记录只包含：run id、工作流名、`sourceHash`、可选的 `teamRevision`、阶段（`start` 或 `end`）、驱动的 kind、状态、运行到达的 end（到达时才有）、未到达 end 就失败的运行的失败代码（仅限 teamai 设定的代码，如循环用完次数时的 `loop_exhausted`，或本地驱动找不到工具时的 `tool_unavailable`，不含失败消息）、开始和结束时间、时长、逐步条目（step 路径如 `check.classify`、agent、tool、model、outcome、tokens——混合 agent 的运行会分别记录每步自己的字段；`tool` 仅在是本地驱动的工具之一时保留，`model` 是驱动报告的名称，仅在形如模型名时保留）、步骤汇总计数（succeeded、failed、skipped、cancelled）、累计已结算 attempt 数，以及发布者用户名。`sourceHash` 标识实际运行的工作流和提示文件的精确字节。只有一个远端可达的团队提交同时保存父工作流和所有子工作流的这些精确字节时，才写入 `teamRevision`；本地或未推送的修改以及混合缓存版本都会省略它。每条条目都带 `pass` 编号，循环运行了多次的步骤每个 pass 各有一条条目。`for_each` 的项按该项自己运行的次数计 `pass`，所以前面某个 pass 的项较少时，项的 `pass` 可能比所属步骤的小。被取消步骤的条目 outcome 为 `cancelled`，被跳过的步骤没有 outcome。汇总计数按运行结束时的状态，每个步骤只计一次。从未开始的子工作流里的步骤不计入。提示词、命令文本、输入值、`env` 值、输出、diff、秘密值、本地工作区路径、会话 id 和主机名没有可落地的字段——记录由白名单构建，而不是从运行状态里过滤。

条目的 `agent` 是该 pass 实际运行时观察到的组合：步骤的 `agent:` 定义及工具如何拿到它（工具自己读取 agent 文件时为 `main`，指令拼接到提示词前时为 `prompt`）、工具及其版本、启动时请求的模型和 effort、工具报告的模型、检出最近一次 pull 的团队提交以及之后是否改过已下发的文件、项目提交、TeamAI 版本和驱动的 kind。没有观察到的值不写。`fingerprint` 对定义、工具、模型、effort 和团队提交做哈希，fingerprint 相同的两个 pass 记录下来的这些部分相同。模型或团队提交未知，或改过已下发的文件时，不写 `fingerprint`。没有任何观察的 pass，以及旧版 TeamAI 写的记录，只带定义的名称。步骤运行期间，如果该检出最近一次 pull 已完整下发到步骤启动的工具，该工具以及它在同一检出中启动的会话都会跳过会话开始时的 pull，步骤因此保持它记录的团队提交。

结束运行的操作在锁内排队保存结束记录，在释放锁后发布。发布失败时——没有远端、reports 锁被占用、push 被拒——记录会进入当前 scope 数据目录的本地队列，在下一次 `teamai pull` 时重试。此时 `start`、`next` 的返回会带 `record: pending` 而不是 `record: published`。运行本身不受影响：一台机器在运行开始后崩溃，该运行会以"已开始未结束"的状态保持可见。

Run id 是 `r` 加 16 位十六进制。此方案之前创建的运行用 8 位十六进制，仍然可以解析。

工作流总量（runs、succeeded、failed、累计时长）在发布时折入 reports 分支的 `stats/<username>.yaml`，由 `teamai digest` 展示。
