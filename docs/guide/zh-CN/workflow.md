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

有 agent 专用配置时优先于 `default`。支持 `claude`、`claude-internal`、`tclaude`、`codex`、`codex-internal`、`tcodex`、`opencode`、`codebuddy` 和 `workbuddy`。CI 可以在单次启动时用 `--tools default=claude,implementer=codex` 覆盖。没有专用配置的步骤依次使用 `TEAMAI_AI_TOOL`、`default`、运行所在 workspace 配置中的 [`ai.tool`](./reference.md#ai-工具aitool)、`~/.teamai/config.yaml` 中的 `ai.tool`。`TEAMAI_AI_TOOL` 或 `ai.tool` 指定的工具不能运行步骤时，步骤会跳过它并给出警告；指定的名称根本不是 teamai 能启动的工具时，步骤以 `tool_unsupported` 失败。命名 agent 从 `teamai pull` 已经部署到该工具、该 scope 目录里的文件读取。

```text
teamai workflow start build --driver local
```

`--driver local` 在当前检出目录里运行没有 `workspace` 的步骤，除非外层步骤打开了工作区。这里的命令是只读的：退出码为 0，且改了仓库文件、文件权限、符号链接目标、已暂存重命名的新路径、已脏子模块里的文件、暂存区或 HEAD 时，步骤失败，改动留在原地。已有未跟踪目录里的文件变化也算；该目录保持不变时，步骤不会因此失败。`workspace: new` 的步骤在自己的分支上改文件。见[工作区](#工作区)。共用当前检出目录的步骤一次只运行一个。不同工作树里的步骤可以一起运行，上限是 [`workflows.max_parallel`](workflow-advanced.md#并行运行本地命令)。每次 attempt 的 `result.json` 位于当前 scope 的 TeamAI 数据目录中，不在产品检出目录内。驱动调用的 `next` 和 `report` 与下面相同：

```text
teamai workflow start build
teamai workflow next <run> --json '{"driver":{"kind":"local","machine":"host","workspace":"/work"}}'
teamai workflow report <run> --json '{"attempt":"<attempt>","revision":1,"outcome":"success","driver":{"kind":"local","machine":"host","workspace":"/work"}}'
```

`outcome` 可以是 `success`、`failed` 或 `released`。`released` 把步骤退回 pending，不消耗重试。已经上报过的 attempt 返回 `repeated_report`，revision 旧了也一样。运行状态会记住最近上报过的 attempt。更早的 attempt 走其余检查：revision 旧了返回 `stale_revision`，revision 是当前值但不是当前租约的 attempt 时返回 `wrong_attempt`。其他驱动返回 `wrong_driver`。`changes` 的 `branch` 或 `base` 与租约不符时返回 `invalid_report`，步骤仍处于租约中。工作区里的只读步骤上报 `read`（`branch`、`base` 和它读取的 `commit`），而不是 `changes`。它上报 `changes`、成功时没有 `read`、其他步骤上报 `read`，或 `read` 与租约不符时，同样返回 `invalid_report`。`used`（`{"skills":["review-notes"]}`）写明该轮次加载过的团队技能，供它的[评分标签](scorers.md#任意-driver)使用。不是技能名的值会被丢弃，其他形状的 `used` 返回 `invalid_report`。`next` 上的 `runMode`（`attended` 或 `unattended`）是驱动运行其租约时的[运行模式](#有人值守与无人值守的运行)。租约会保留它，所以无论轮次如何结束（包括超时或取消），轮次及其标签都会保留它。其他值返回 `invalid_json`。CLI 不读取的 payload 字段——例如把 `tokens` 拼成 `tokenz`，或来自更新协议版本的字段——会被接受但回报出来：`next`、`report` 和 `respond --json` 的成功信封会带上 `ignored`，先列顶层字段、再列 `driver.<字段>` 和 `changes.<字段>`，只有名字、没有值。没有未读字段时不带这个键，错误信封保持原样。

运行状态保存在所属 scope 的 TeamAI 数据目录里。`next`、`report`、`respond` 和运行控制命令按 id 跨本机已配置 scope 查找，工作流 worktree 内或产品仓库外也可以使用。两个 scope 中都有的 id 返回 `ambiguous_run`。命令结束后进程就退出。本地运行以 `failed` 或 `cancelled` 结束时，退出码是 1。不会留下常驻的工作流进程。

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

## 交付 PR

在写分支的步骤上设置 `deliver: pr`，步骤成功后 TeamAI 会从这条分支开一个 pull request，并且从不合并它。设置了 `workspace: new` 或 `continue` 的步骤会写分支，位于已开分支的工作流中的提示词步骤也会。交付的命令必须设置 `workspace`，因为没有 `workspace` 的命令是只读的。设置了 `workspace: new` 的 `workflow` 步骤为它的全部步骤只交付一次自己的分支。其中写自己分支的步骤，需要有后续步骤通过 `needs` 合并那条分支，或者自己设置 `deliver: pr`。否则交付以 `delivery_failed` 失败，因为 pull request 会漏掉那部分工作。`for_each` 步骤的每个 item 各自交付自己的分支。

```yaml
schemaVersion: v1alpha1
name: ship-issue
description: Implement an issue for review.
inputs: { issue: number }
steps:
  - id: change
    workspace: new
    deliver: pr
    prompt: "Implement issue #{{ inputs.issue }}."
```

会以只读方式运行的 `deliver: pr` 步骤无法通过校验；设置了 `deliver: pr` 的 `workflow` 步骤（无论是否 `for_each`），若其工作流中没有步骤写分支，也无法通过校验。运行若会从 detached HEAD 开始，`workflow start` 会拒绝它，因为 pull request 没有可以合入的分支。请先检出一个有名称的分支。

步骤成功时，驱动已经像对任何可写步骤一样推送了分支，步骤进入 `delivering` 状态，需要它的步骤会等待。下一次 `teamai workflow next`（无论哪个驱动调用）会查找从这条分支合入目标分支的已打开 pull request，没有时才新开一个。写同一条分支的另一个步骤仍在运行时，交付会等它上报，这样 TeamAI 会在开出或接受 pull request 之前检查那个步骤的提交。因崩溃而中断的运行，会找到之前开的 pull request，不会再开第二个。被另一台机器接管的运行也是如此，除非交出运行的机器此刻仍在开 pull request；GitHub 和 GitLab 会拒绝这样的重复请求。TeamAI 在 GitHub、GitLab、TGit 和 GitCode 的 origin 上开 pull request，使用 provider 的 CLI 或 token 已有的登录，从不弹出登录提示。在其他 origin 上（例如通用 Git 主机或 CNB），它不开 pull request，步骤失败并写明分支。

pull request 合入这条分支来源中最近一条已经交付过的分支，没有时合入运行开始时的分支。分支首先来自其 `for_each` item 的 `after` 分支，然后依次来自 `needs`。子工作流的第一个步骤来自运行它的步骤的 needs。跳过的步骤没有写分支，会被越过。因此每个 pull request 只显示它所合入的分支之后的工作。

循环中 `workspace: new` 步骤的每个 pass 都有自己的 `/p<pass>` 分支，因此各开一个 pull request。之前的 pull request 保持打开，这是有意为之。在同一条 `continue` 分支上循环的步骤只有一个 pull request。

开出或接受 pull request 之前，TeamAI 将交付的提交与运行的基准提交比较。修改 CI 配置（例如 `.github/workflows` 或 `.gitlab-ci.yml`）、hooks、任意层级的 `AGENTS.md` 或 `CLAUDE.md`，或任一工具的 agent、rule、MCP 文件，步骤会以 `protected_path` 失败，消息列出这些文件。这些路径就是工作区步骤从运行基准获得的 agent 文件，再加上 CI 和 hook 路径。删除和重命名也算，分支从前序步骤带来的修改也算。之后运行 `teamai workflow retry <run> <step>`，会在新的 pass 中重新运行这个步骤。如果修改只来自另一个步骤之后在共享分支上记录的提交，步骤改为以 `delivery_failed` 失败，重试也不会重新运行它。消息会说明如何只交付该步骤自己的提交，或如何在新分支上重新运行那条分支的步骤。

其他交付失败会让步骤以 `delivery_failed` 失败。消息说明出了什么问题、工作保存在哪条分支，并给出重试命令。修复原因（例如 provider 的凭据）后，运行 `teamai workflow retry <run> <step>`，再运行 `teamai workflow resume <run>`，或让驱动调用 `next`。重试会再次交付同一条分支，不会重新运行步骤。运行在开 pull request 期间被取消时，这个 pull request 无法收回。运行会列出它，步骤保持 cancelled。

如果 origin 没有要交付的分支，TeamAI 不会打开请求。失败消息会指出缺失的分支和要推送到该分支的提交，然后给出重试命令。

如果主机可能已打开请求，但 TeamAI 无法确认，步骤会以 `delivery_failed` 失败，且不记录 URL。运行消息中的重试命令。TeamAI 会先查找已有请求，再尝试打开请求。

自己开 pull request 的驱动（例如在另一台机器上的驱动）把它作为 `changes.pr_url`，和步骤的其他 `changes` 一起上报。TeamAI 保留不含凭据、不超过 512 个字符的 `https` URL，并去掉 query 和 fragment。在 origin 自己的主机上，URL 必须是这条分支合入目标分支的已打开 pull request；TeamAI 无法向主机核对的 URL 会被丢弃，之后由交付自己查找已打开的 pull request。其他主机上的 URL（例如私有审查服务）原样保留。TeamAI 不保留的 URL 会被丢弃；没有交付使用的 URL 也会被丢弃：来自未设置 `deliver: pr` 的步骤、来自失败或被 released 的步骤，或分支相对运行基线没有变更时的 URL。report 仍会被接受，其信封列出 `"dropped":[{"field":"changes.pr_url","reason":"…"}]`，不包含 URL 本身。随后这条分支像其他驱动的分支一样交付。

### 从 CI 启动

GitHub Actions 作业可以用本地驱动启动运行，运行会在无人值守的情况下交付它的 pull request。把工作流放进团队仓库。给作业一个 token，它要能读取团队仓库、向产品仓库推送分支，并在产品仓库开 pull request。下面的作业从 `WORKFLOW_TOKEN` secret 读取它，从 `TEAM_REPO` 变量读取团队仓库的 URL。runner 还需要运行提示词步骤的工具，并且已经登录，`--tools` 为这次启动选择它。

```yaml
on: { issues: { types: [labeled] } }
concurrency: ship-issue-${{ github.event.issue.number }}
jobs:
  ship:
    runs-on: ubuntu-latest
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.WORKFLOW_TOKEN }}
    steps:
      - uses: actions/checkout@v5
        with: { ref: main, token: "${{ secrets.WORKFLOW_TOKEN }}" }
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace
      - run: npx teamai-cli pull
      - run: npx teamai-cli workflow start ship-issue --driver local --tools default=claude --auto-approve --inputs '{"issue":${{ github.event.issue.number }}}'
```

`--auto-approve` 对可选的 `approve` 请求回答 yes，对可选的 `choose` 请求选择默认值。无人值守的作业里没人能回答必需的请求，因此它所在的步骤以 `hitl_required` 失败，运行也随之失败。要从另一条分支启动运行（例如 CI 失败的分支），请按分支名检出它，例如在 `pull_request` 事件中使用 `ref: ${{ github.head_ref }}`。默认的 `pull_request` checkout 是 detached merge commit，`workflow start` 会拒绝它。TeamAI 不安装触发器，也不等待 CI 或合并。

## 在另一台机器上继续运行

运行保存在启动它的那台机器的 TeamAI 数据目录里。要在别处接着运行，先发布它，再在另一台机器上继续。适用的情况：工具在运行中途用完了 token，把运行交给队友，或者 CI 里的运行失败了，你想在自己的机器上把它跑完。

```text
teamai workflow publish <run>     # 在有这个运行的机器上
teamai workflow resume <run>      # 在另一台机器上，位于同一个仓库的检出目录中
```

`publish` 把运行状态写到团队的 `teamai-reports` 分支，并让本安装实例成为该运行的所有者。先停止驱动，让没有步骤在执行。发布时仍处于租约中的步骤会在另一台机器上重新运行。按 Ctrl-C 后，正在执行的步骤写下的内容会留在本机该步骤的工作树里，另一台机器仍然可以认领这个运行。之后你在运行仍在进行时把它接管回本机，认领会让本安装实例成为所有者，但 `resume` 会返回 `branch_diverged` 并指出那个工作树。把这些改动移到别处或删除，再执行 `resume`。在没有这个运行的机器上，`resume` 从 `teamai-reports` 取得它，让该安装实例成为所有者，并用本地驱动运行它。

已发布的运行只有所有者能继续。在另一个已有该运行的安装实例上，`resume` 和 `publish` 都返回 `not_owner`，带上所有者的用户名和安装实例 id。同一成员的两个安装实例显示相同的用户名，靠安装实例 id 区分。要接管这个运行，执行 `teamai workflow resume <run> --claim`。认领会替换本机的运行副本，并释放其他机器持有的租约。此后原所有者不能再发布或继续这个运行，除非它再认领回来。

要在编程会话中继续这个运行，由 agent 执行 `teamai workflow resume <run> --driver skill`，加 `--claim` 则从所有者那里接管。它以同样的方式认领运行，然后在会话的运行模式下用 skill 驱动运行它，选项与 skill 启动相同：`--parallel`、`--hitl` 或 `--auto-approve`，以及 `--no-judge`。不带这些选项时，一次只运行一个步骤，agent 在回答可选关卡前会先问你。在无人值守的运行中，它像 `--auto-approve` 那样回答可选关卡，并在认领之前拒绝剩余步骤需要人参与的运行（`unattended_denied`）；已经执行过的审批或交互步骤不再计入，除非循环可能再次执行它。它的第一个回合在工作流有 prompt 步骤或由会话评审时提出宿主问题，并重新派发另一台机器持有租约的步骤。必须用本地驱动运行的工作流会以 `teamai workflow resume <run>` 交还给你。接管运行由你决定，所以 agent 执行这两条命令前都会先问你。

已发布的运行结束时，teamai 会发布它的结束状态，不带 `--sessions`。之后接手该运行的成员不会重新运行它的任何步骤。

无论[使用统计上报](reporting.md)是否开启，`publish` 都会写入运行状态：这是另一台机器继续运行所需的状态，不是使用统计上报。从未发布的运行留在本机。使用统计上报开启时，只有它的[运行记录](#运行记录)会进入 `teamai-reports`。

带 `session: continue` 或 `session.from` 的步骤在另一台机器上会开一个新的 agent 会话，除非发布时加上 `--sessions`。运行在机器之间来回交接时，每台继续过会话的机器都要在下一次认领前用 `--sessions` 发布，这样下一个步骤能拿到所有对话轮次。[发布和认领](workflow-advanced.md#发布和认领)说明发布的状态包含什么、每个错误及下一步怎么做，以及如何从 CI 发布。

## 运行记录

开启[使用统计上报](reporting.md)时，每次运行都会向团队的 `teamai-reports` 分支发布一条保护隐私的记录：开始时一次，结束时一次。关闭后不发布任何记录，返回中也不带 `record`。记录存放在 `workflows/runs/<run id>.json`，以 run id 为键，重试的发布会更新同一条记录而不是产生副本。

记录只包含：run id、工作流名、`sourceHash`、可选的 `teamRevision`、阶段（`start` 或 `end`）、驱动的 kind、运行启动时的模式（`runMode`）、状态、运行到达的 end（到达时才有）、未到达 end 就失败的运行的失败代码（仅限 teamai 设定的代码，如循环用完次数时的 `loop_exhausted`，或本地驱动找不到工具时的 `tool_unavailable`，不含失败消息）、开始和结束时间、时长、逐步条目（step 路径如 `check.classify`、agent、tool、model、outcome、tokens，驱动在 `next` 上发送了时该 pass 的 `runMode`，以及该 pass 的产出（`outcomes`：它分支上的 commit 哈希、为它交付的拉取请求，以及 `teamai contribute` 在它的 attempt 中记录的经验 ID）——混合 agent 的运行会分别记录每步自己的字段；`tool` 仅在是本地驱动的工具之一时保留，`model` 是驱动报告的名称，仅在形如模型名时保留）、步骤汇总计数（succeeded、failed、skipped、cancelled）、累计已结算 attempt 数、运行交付的 pull request（`prs`），以及发布者用户名。`sourceHash` 标识实际运行的工作流和提示文件的精确字节。只有一个远端可达的团队提交同时保存父工作流和所有子工作流的这些精确字节时，才写入 `teamRevision`；本地或未推送的修改以及混合缓存版本都会省略它。每条条目都带 `pass` 编号，循环运行了多次的步骤每个 pass 各有一条条目。`for_each` 的项按该项自己运行的次数计 `pass`，所以前面某个 pass 的项较少时，项的 `pass` 可能比所属步骤的小。被取消步骤的条目 outcome 为 `cancelled`，被跳过的步骤没有 outcome。汇总计数按运行结束时的状态，每个步骤只计一次。从未开始的子工作流里的步骤不计入。提示词、命令文本、输入值、`env` 值、输出、diff、秘密值、本地工作区路径、会话 id 和主机名没有可落地的字段——记录由白名单构建，而不是从运行状态里过滤。

条目的 `agent` 是该 pass 实际运行时观察到的组合：步骤的 `agent:` 定义及工具如何拿到它（工具自己读取 agent 文件时为 `main`，指令拼接到提示词前时为 `prompt`）、工具及其版本、启动时请求的模型和 effort、工具报告的模型、检出最近一次 pull 的团队提交以及之后是否改过已下发的文件、项目提交、TeamAI 版本和驱动的 kind。没有观察到的值不写。`fingerprint` 对定义、工具、模型、effort 和团队提交做哈希，fingerprint 相同的两个 pass 记录下来的这些部分相同。模型或团队提交未知，或改过已下发的文件时，不写 `fingerprint`。没有任何观察的 pass，以及旧版 TeamAI 写的记录，只带定义的名称。步骤运行期间，如果该检出最近一次 pull 已完整下发到步骤启动的工具，该工具以及它在同一检出中启动的会话都会跳过会话开始时的 pull，步骤因此保持它记录的团队提交。

`prs` 列出运行交付的每个 pull request，无论是 TeamAI 开的还是驱动上报的，每个只列一次，按运行首次交付它们的顺序排列。步骤输出中的 URL 从不列入。和记录的其他部分一样，`prs` 遵循 usage-report 的退出设置，团队仓库公开时它也公开。没有 `prs` 的旧记录仍可读取。要查找开出某个 pull request 的运行，在团队仓库 `teamai-reports` 分支的检出中运行：

```text
jq -r 'select((.prs // []) | index("<url>")) | .run' workflows/runs/*.json
```

结束运行的操作在锁内排队保存结束记录，在释放锁后发布。发布失败时——没有远端、reports 锁被占用、push 被拒——记录会进入当前 scope 数据目录的本地队列，在下一次 `teamai pull` 时重试。此时 `start`、`next` 的返回会带 `record: pending` 而不是 `record: published`。运行本身不受影响：一台机器在运行开始后崩溃，该运行会以"已开始未结束"的状态保持可见。

Run id 是 `r` 加 16 位十六进制。此方案之前创建的运行用 8 位十六进制，仍然可以解析。

工作流总量（runs、succeeded、failed、累计时长）在发布时折入 reports 分支的 `stats/<username>.yaml`，由 `teamai digest` 展示。

## 在编程会话中运行

Claude Code、Codex 等编程会话可以替与它协作的人运行团队工作流。工作流文件中的 `invoke` 决定它能否这样做。它只限制 agent：

| `invoke` | agent 会话（任何驱动；`--driver skill` 始终算作 agent） | 本人的终端，本地驱动 | 没有 agent 会话的 CI，本地驱动 | 子工作流 |
|---|---|---|---|---|
| `allow` | 启动 | 启动 | 启动 | 启动 |
| `ask` | 本人同意后启动（先 describe，再 `--confirmed`）。无人值守时为 `denied`，带 `--confirmed` 也一样 | 启动 | 启动 | 启动 |
| `deny`（默认） | 拒绝 | 启动 | 启动 | 启动 |

`resume`、`next --takeover` 和驱动在 `next` 中的认领遵循同一规则。

`alias` 是 `workflow start` 可选的第二个名称，必须是单个 token。别名若与另一个工作流的别名或名称相同，就不启动任何工作流（`alias_conflict`）。请用名称启动这些工作流。

```yaml
schemaVersion: v1alpha1
name: session-change
description: Implement a requested task in a separate branch.
invoke: allow
alias: session-fix
inputs: { task: string }
steps:
  - id: implement
    workspace: new
    prompt: "Implement {{ inputs.task }}."
```

0.28.0 之前的 teamai 会丢弃设置了 `invoke` 或 `alias` 的工作流，所以成员和 CI 任务需要 0.28.0 或更高版本。`teamai review --branch` 会对每个新增这两个键之一的工作流给出警告。

设置了 agent 的会话变量（如 `CLAUDE_CODE_SESSION_ID`）的进程，就算在 agent 会话内运行。在这样的进程中，`workflow start` 启动 `deny` 工作流时返回 `invoke_denied`。消息会给出本人在自己终端运行的命令，以及让 agent 能启动该工作流的 `invoke` 设置。启动 `ask` 工作流时，没有 `--confirmed` 就返回 `confirm_needed`；会话在本人同意后加上它。在无人值守的运行中（`TEAMAI_MODE=unattended` 或 `CI`），即使带 `--confirmed` 也返回 `unattended_denied`，因为没有人能同意。这些规则对所有驱动都成立，不指定驱动时也一样。`CI` 不豁免任何东西：CI 任务能启动任何工作流，是因为它不设置会话变量。`workflow start --driver skill` 即使宿主没有设置这类变量也算 agent 发起，因为只有编码 agent 会驱动 skill 驱动。

运行的步骤内不能启动或驱动另一次运行。步骤的进程带有 `TEAMAI_WORKFLOW_ATTEMPT`：本地驱动为它运行的命令和提示词步骤的工具设置它，skill 驱动为它的 runner 及其命令设置它，所有驱动都为 setup 设置它。设置了它时，每个会改变运行的 `workflow` 命令（`start`、`next`、`report`、`respond`、`retry`、`cancel`、`resume` 和 `publish`）都返回 `nested_workflow`，只有 skill 驱动的 runner 上报它自己的 attempt 除外。在 `.teamai/workflow-worktrees` 下的工作流 worktree 中，以及在 `teamai/<run>/...` 分支上的检出中，`start` 也返回 `nested_workflow`。其他命令在那里仍然可用，因为步骤的子 agent 从它的位置上报。要让另一个工作流成为运行的一部分，把它作为 `workflow` 步骤加入定义。

### 工作流 skill

`teamai pull` 为每个 `invoke: allow` 或 `ask` 的工作流写入一个 `workflow-<name>` skill。会话通过它找到工作流：skill 带有工作流的描述和别名，并引导 agent 读取 `teamai skill get workflow`，即已安装 CLI 提供的指令。它不带任何步骤、提示词或命令。在 Claude Code 和 CodeBuddy 中，`allow` 工作流的 skill 会预先批准它的 `workflow start` 命令。用户级安装的 pull 会把这些 skill 写入你的主目录，所有会话都能看到。在没有同名可运行工作流的项目中，`workflow start` 会启动用户级安装的那个工作流，该运行属于用户级安装。

请修改工作流，而不是 skill。工作流变化时，pull 会重写未改动过的 skill；工作流被删除或改为 `deny` 时，pull 会删除它。被你编辑过的 skill 会保留，并给出警告。没有生成标记、名为 `workflow-<name>` 的团队或成员 skill 会取代它，`teamai doctor` 会列出这种情况。`teamai push` 从不发布生成的 skill。`push --skill` 拒绝生成的 skill，也拒绝 CLI 自有的 skill，如 `teamai`。在项目中，pull 会把生成的 skill 列入 `.git/info/exclude`。

self 模式下，工作流 worktree 中的团队文件是已提交的版本。会话要在 worktree 中运行某个工作流前，先提交该工作流，否则那里没有它的 skill。

### 会话做什么

agent 运行 `teamai workflow start --describe <name> --driver skill`。回复说明如何启动运行：直接启动、先问本人一个问题，或交给本地驱动。这个问题涵盖输入、同时运行几个步骤、谁回答可选审批，以及是否评审。

TeamAI 从宿主设置的会话变量得知会话所用的工具。找不到时（例如 Oh My Pi 或 Qoder），且有步骤指定了模型或需要评分，describe 会要求提供工具，agent 就用 `--tools default=<tool>` 再次 describe。之后 teamai 打印的每条命令都会带上它。运行会记住这个工具：评分步骤由它评审；teamai 为该工具安装 agent 时，步骤的模型也按它解析。

启动后，每次回复都是一个 turn：agent 要做的 action、正在运行的步骤、上次调用以来发生的事，以及下一条要运行的命令。运行状态保存在 CLI 中，agent 在两次调用之间不需要记住任何东西。上下文压缩后或在新会话中，`teamai workflow next <run> --driver skill` 会打印当前 turn。如果另一个会话仍在驱动这次运行，它返回 `orchestrator_active`，由本人决定是否让本会话用 `--takeover` 接管。

- 命令步骤在 TeamAI 于本机启动的后台进程中运行。
- 提示词步骤交给会话启动的子 agent，附带任务说明和工作目录。子 agent 完成后自行上报。步骤有工作区时，TeamAI 会 commit 并 push 子 agent 的工作。
- `interactive` 步骤由会话的 agent 自己和本人一起完成，一次一个。
- 每次运行，agent 会说明一次它的宿主如何启动子 agent。宿主为每个子 agent 创建 worktree 时，TeamAI 检查并接管该 worktree。宿主不启动子 agent 时，agent 自己在检出中完成每个步骤，需要 worktree 的步骤则等本人在自己的终端运行。
- 会话告诉本人发生了什么，提出问题，并给出结果和 PR。

`teamai skill get workflow` 打印 agent 遵循的指令。`teamai workflow <command> --help` 列出所有选项。

skill 驱动声明 `env: "commands"`（见[要求和限制](workflow-advanced.md#要求和限制)）。命令步骤和 setup 像在本地驱动中一样获得各自的 `requires.env` 键。带 `requires.env` 的提示词步骤会等待，因为 TeamAI 只在自己启动的进程中限定团队 env。该驱动从不声明 `tokens`、`max_turns` 或 `network`，因为没有宿主会把子 agent 的 token 或轮次报告给 TeamAI。处于 `budget` 下的无头提示词步骤会等待，所以运行级的 `budget` 会让该运行的所有无头提示词步骤等待。`max_turns` 和 `requires.network: false` 会列入 `unenforced`。worktree 不是 sandbox：`requires.isolation: sandbox` 也会列入 `unenforced`。

当一个因 env 或 budget 而等待的步骤，在同一次运行中较早步骤打开的工作区里工作时，describe 会把整个运行交给本地驱动，由本人在自己的终端启动。否则会话先运行它能运行的部分。只剩等待的步骤时，它把运行交给本人，由本人在自己的终端用 `teamai workflow resume <run>` 继续。本地驱动用本地配置中 `workflows.tools` 指定的、或 `--tools` 选择的无头工具运行提示词步骤。`TEAMAI_AI_TOOL`、`workflows.tools.default` 和两处 `ai.tool` 都没有指定工具时，会话给出的本地启动命令和 `resume` 命令会带上 `--tools default=<会话的工具>`。

### 有人值守与无人值守的运行

有人在场回答时，运行是有人值守的；在 CI 或云端 agent 中，运行是无人值守的。TeamAI 先看 `TEAMAI_MODE`（`attended` 或 `unattended`），再看 `CI`（已设置且不是 `0` 或 `false` 即为无人值守），都没有时按有人值守处理。`TEAMAI_MODE` 为其他值时，TeamAI 给出警告并忽略它。

在无人值守的运行中，describe 不提问。它给出推荐选项的启动命令，并带上 `--auto-approve`，由 agent 根据自己的任务填写 `{inputs}`。需要人参与的工作流会被拒绝（`denied`），并说明原因：`invoke: ask`、`interactive` 步骤、必需审批、没有默认值的选择，或只有本地驱动能运行的路径。

无论用哪种驱动，TeamAI 为步骤启动的每个进程（包括 setup）都会拿到这次运行的 `TEAMAI_MODE`。skill 驱动沿用启动时或 `resume --driver skill` 时解析出的模式；本地驱动在每次开始驱动时（`start` 或 `resume`）重新解析。

### 只有本人能给的回答

必需审批只交给本人。会话展示它，并把 `teamai workflow respond` 命令交给本人在自己的终端运行，或由本人在 [`teamai dashboard`](dashboard.md#工作流运行workflow-runs) 中回答。TeamAI 根据发送回答的进程判断是谁回答的。从 agent 会话内发出的回答都算 agent 的：`respond --driver skill`、带驱动身份的 `respond --json`，以及从该会话启动的 dashboard。必需审批会以 `agent_in_path` 拒绝这样的回答。这些变量是证据，不是证明：取消这些变量或打开终端的进程可以冒充本人。

可选审批和选择按本人在启动时选的方式回答。启动问题会说明每一个守着什么：它之前的命令、prompt 步骤、工作流或 end，或者等它的步骤；选择则说明它的选项和默认值。命令只显示第一行，超过 80 个字符的部分会截掉。例如：

```text
- Optional approval at contribute: before `teamai contribute --file "$FILE" --title "$TITLE" --namespace "$NS" --session-id…`.
- The recommended start lets this session's agent answer optional approvals and say why; "answer optional approvals automatically" answers each approval yes.
```

`--hitl person` 时，agent 问本人。`--hitl recommend` 时，agent 自己决定并说明理由。`--auto-approve` 时，TeamAI 对审批回答 yes，对选择取其默认值。

### 评审

当步骤列出[评分器](scorers.md)，且本机安装了会话所用工具的受限评审器时，TeamAI 在后台评审每个被评分的 pass，会话把标签告诉本人。本机没有会话所用工具的已验证评审器时（例如 Cursor），会话在运行结束后领取该运行的评审任务，在新的子 agent 中以 `best-effort` 隔离评审每个 pass。评分器要求 `verified` 的任务保持打开，留给其他 driver；会话的宿主不能启动子 agent 时，全部任务都这样留下。如果不想在本机评审这些步骤，本人选择不评审的启动选项（`--no-judge`）。负责编排的 agent 从不在自己的上下文中评审。

### 限制

- 在 Windows 上，后台 runner 被杀掉后，它启动的命令会一直运行到结束。TeamAI 不会停止它。
- 提示词步骤的 `timeout` 在会话下一次调用 `next` 或轮询时才被发现，而不是在超时的那一刻。
