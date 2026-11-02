# Benchmark

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

```text
teamai benchmark run fix-auth --sandbox
```

benchmark 套件用团队自己的任务比较工具或模型。一次运行把每个任务交给每个 arm 各做几次，检查每个结果，然后打印表格。trial 只在声明为 sandbox 的机器上运行，例如 CI runner 或容器。

一次 benchmark 运行就是工作流 `teamai-benchmark` 的一次运行，这个工作流由 teamai 提供，团队可以替换它。见 [benchmark 工作流](#benchmark-工作流)。

## 编写套件

套件是团队仓库里的一个目录：`benchmarks/<suite>/suite.yaml`，以及 `tasks/` 里每个任务一个文件。

```yaml
# benchmarks/fix-auth/suite.yaml
schemaVersion: v1alpha1
name: fix-auth
description: Fix bugs in the auth service.
repo: https://github.com/acme/auth-service.git
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
  - name: strong
    model: strong
repetitions: 3
timeout: 45m
setup:
  command: npm ci
```

| 键 | 值 |
| --- | --- |
| `repo` | 任务所基于的项目：不带凭据的 https、ssh 或 git URL。 |
| `defaults` | 其他 arm 用来对比的那个 arm：`tool`，以及可选的 `model`、`team` 和 `workflow`。它不是工作流的 `defaults`。 |
| `arms` | 1 到 6 个。每个最多改变一个 `defaults` 键，最多只有一个什么都不改。 |
| `matrix` | 代替 `arms`：teamai 把这些值列表交叉组合成 arm。见[用 matrix 交叉工具和团队资产](#用-matrix-交叉工具和团队资产)。 |
| `team` | arm 运行时使用的团队资产。见[使用其他团队资产的 arm](#使用其他团队资产的-arm)。 |
| `workflow` | 每个 trial 在任务上运行的团队工作流，代替单个 prompt。见[运行工作流的 arm](#运行工作流的-arm)。 |
| `model` | `models/aliases.yaml` 里的模型别名（运行启动时按每个 arm 的工具解析），或一个模型名。 |
| `repetitions` | 1 到 10，默认 3。 |
| `parallel` | 运行基线和 trial 的通道数，1 到 32，默认 1。见[并行通道](#并行通道)。 |
| `timeout` | 必填：整个运行的超时。 |
| `trial` | 可选：每个 trial 的 prompt 的限制。见 [trial 限制](#trial-限制)。 |
| `setup` | 可选，即[工作流的 `setup`](workflow-advanced.md#要求和限制)。在每个全新克隆中、工具或 check 之前运行。 |
| `scorers` | 可选，评判每个 trial 的[评分器](scorers.md)。没有有效 `scorers/<name>.md` 的名字会让 `teamai review --branch` 失败，`teamai pull` 会警告，start 会拒绝该套件。 |

### 使用其他团队资产的 arm

arm 默认使用本检出目录 pull 到的团队修订，除非它设置了 `team`。可以用它衡量团队资产带来了多少提升、合并前的某个分支，或某一个 skill：

```yaml
defaults:
  tool: claude
arms:
  - name: pulled              # 你 pull 到的修订
  - name: bare
    team: none                # 完全不带团队资产
  - name: next
    team: next                # 团队仓库的 next 分支
  - name: no-auth-tokens
    team:
      without: [skills/auth-tokens]  # pull 到的修订，去掉这个 skill
```

| `team` | arm 运行时使用 |
| --- | --- |
| `pulled`，或不写 `team` | 本检出目录 pull 到的团队修订。 |
| `none` | 不带团队资产。如果本机 user 范围的 teamai 安装会把资产交付给该 arm 的工具，start 会拒绝它，因为它的 trial 会读到你 home 目录里的这些资产。 |
| 分支、tag 或提交 | 团队仓库的该修订，在运行启动时解析。分支按团队仓库里的名字写，例如 `next`，而不是 `origin/next`。 |
| `without: [<path>, ...]` | pull 到的修订，去掉团队仓库中的这些文件和目录。见[去掉团队资产](#去掉团队资产)。 |

记录中的 `skillChanges` 为每个使用其他修订或 `without` 路径的 arm 列出它相对 pull 到的修订新增、去掉或改变的团队 skill，结果会显示每个 arm 加载它们的频率。见[结果](#结果)。

### 去掉团队资产

`without` 接受团队仓库中的路径，写法与 git 列出的一致：一个 skill、一条 rule、一个 agent、一个 `claudemd/` 文件、一篇文档、整个命名空间目录，或任何其他文件，例如 `hooks/hooks.yaml`：

```yaml
arms:
  - name: pulled
  - name: no-release
    team:
      without: [skills/release, skills/ops/release]
  - name: no-ops
    team:
      without: [skills/ops, rules/ops]
```

运行先规划每个 arm，按 pull 交付给你的方式，带上你的角色、项目、tag 和排除的 skill。以下情况它会拒绝该 arm，并且不启动运行：

| `without` 列出 | 原因 |
| --- | --- |
| pull 到的修订中没有的路径，或 `teamai.yaml` | 没有可去掉的内容，或者没有 trial 能安装团队。 |
| 位于它列出的另一个路径之内的路径 | 只列出外层那个。 |
| `skills/`、`rules/`、`agents/`、`claudemd/` 或 `docs/` 下、无论去不去掉 pull 都交付得一样的路径 | 去掉它什么都不改变。消息会说明原因：你的角色或项目不接收的命名空间、只通过你没有订阅的 tag 才接收的共享 skill、你排除的 skill、只带有你没有订阅的 tag 的 rule。 |
| 你接收的某个命名空间会用自己的副本代替的共享路径 | 命名空间的副本仍会到达 trial：消息会说 `list skills/ops/release too`。 |

其他位置的路径只需要存在。`without` 路径会去掉整个文件：要去掉共享文件中的一个条目，例如一个 MCP 服务器、hook、env 键或模型别名，推送一个不含它的团队仓库分支，并指定这个分支：

```yaml
arms:
  - name: pulled
  - name: no-github-mcp
    team: no-github-mcp       # 团队仓库的一个分支，其 mcp/mcp.yaml 去掉了 github 服务器
```

benchmark 不在单仓库模式下运行，因为那里由项目自己的提交决定团队资产：运行会以 `team_ref_blocked` 拒绝每个 arm。

### 运行工作流的 arm

带 `workflow` 的 arm 在每个任务上运行一个团队工作流，而不是单个 prompt。工作流把任务的 prompt 作为输入 `task`：

```yaml
defaults:
  tool: claude
arms:
  - name: prompt
  - name: plan-then-fix
    workflow: plan-then-fix   # workflows/plan-then-fix.yaml，带 inputs: { task: string }
```

运行在 arm 的团队修订上读取该工作流及其运行的工作流，像任何团队工作流一样经过你接收的命名空间，并在 arm 的工具、模型和 effort 上运行其中每个 prompt 步骤，像 trial 自己的 prompt 一样无人值守。工作流没有输入 `task`、还要求其他输入，或有 `finally` 步骤时，它的某个步骤会交付、询问某个人、打开 `continue` 以外的工作区，或运行 `workflow: { from }` 时，或者它的某个 prompt 运行 `agent` 而 arm 没有设置 `model`（agent 自己的模型可能取代工具的默认模型；请在 `defaults` 中设置 `model`：带 `workflow` 的 arm 不能再改其他键）时，运行拒绝该 arm（`arm_workflow_unrunnable`）；你接收的两个命名空间都有该工作流时，以 `workflow_namespace_conflict` 拒绝。trial 的 check 或评判根据工作流留在克隆中的内容判定。它的时长是各个 prompt 轮次之和，token 和成本是各个 prompt 之和。[trial 限制](#trial-限制)的 `timeout` 和 `budget` 是它的 prompt 加起来可以花费的量；`max_turns` 不执行，会列在 `unenforced` 中。

### 用 matrix 交叉工具和团队资产

`matrix` 为其值的每种组合生成一个 arm，因此任意两个只差一个值的 arm 只比较这一个值。下面这个例子同时回答：团队资产对每个工具帮助多大，以及带上资产后哪个工具更好：

```yaml
defaults:
  tool: claude
matrix:
  tool: [claude, codex]
  team: [pulled, none]
```

| Arm | 工具 | 团队 |
| --- | --- | --- |
| `claude-pulled` | claude | pulled |
| `claude-none` | claude | none |
| `codex-pulled` | codex | pulled |
| `codex-none` | codex | none |

matrix 可以变化 `tool`、`model`、`team` 或 `workflow`，其中至少一个要有两个或更多值，并生成 2 到 12 个 arm。它没写的键取自 `defaults`。每个 arm 的名字由各个变化键的值拼接而成：ref 原样使用，字母、数字、`-`、`_` 以外的字符写成 `-`，`without: [skills/auth-tokens]` 写成 `without-skills-auth-tokens`。一个套件只能有 `arms` 或 `matrix` 之一。

任务从 `repo` 的一个完整提交开始，并且恰好由 `check` 和 `successCriteria` 之一判定：

```yaml
# benchmarks/fix-auth/tasks/expired-token.yaml
schemaVersion: v1alpha1
title: Reject expired refresh tokens
prompt: |
  Refresh tokens past their expiry are still accepted. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add: [test/auth/refresh.test.ts]
source: { platform: claude-code, sessionId: 7c1e2b9a, fix: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e }
```

```yaml
# benchmarks/fix-auth/tasks/login-copy.yaml
schemaVersion: v1alpha1
title: Clearer login error
prompt: Make the login error say which field is wrong.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
successCriteria: The error names the wrong field and still reveals nothing about which accounts exist.
```

| 键 | 值 |
| --- | --- |
| `startingCommit` | 任务开始时 `repo` 的完整提交。 |
| `check` | `run`：任务完成后以 0 退出的命令；`protect`：agent 不能提供的路径。 |
| `check.add` | 可选：check 之前写入、agent 永远拿不到的文件：按 `source.fix` 中的样子写入的文件，例如修复的测试；或者 `{ from, to }`，套件目录中的一个文件或目录。目录会加入其下的所有文件，但不包括以点开头的条目，例如 `.DS_Store`；要加入点文件，在 `from` 中直接指明它。见[修复带来的测试](#修复带来的测试)和[套件目录中的测试](#套件目录中的测试)。 |
| `successCriteria` | 代替 `check`：由评判器按这些标准判定。 |
| `source` | 可选：任务来自的会话，`platform` 和 `sessionId`，以及 `fix`，即在那里修复它的完整提交，[`benchmark try`](#试运行任务) 会检查它。 |

`teamai pull` 和 `teamai review --branch` 检查每个文件，并带文件和行号报告每个问题。`benchmarks/<namespace>/<suite>/` 下的套件只发给该角色或项目的成员，见[角色和项目](distribution.md#角色和项目)。

### `protect` 要覆盖什么

agent 完成工作后 check 以 0 退出，trial 就通过。check 之前，teamai 把每个 `protect` 路径恢复成起始提交里的样子：

```text
the agent left                       the check sees
src/auth/refresh.ts       edited     edited
test/auth/session.test.ts edited     as 3f2c9a7 has it
test/helpers/skip.js      added      deleted
vitest.config.ts          edited     as 3f2c9a7 has it
```

所以 `protect` 要列出 check 读取、而 agent 不能提供的一切：测试、测试配置、它们加载的脚本和辅助文件，以及包清单和锁文件。

| 不要保护 | 原因 |
| --- | --- |
| `setup` 写入的路径，例如构建目录 | 恢复会删除 setup 写在那里的内容。 |
| git 检出时会转换的文件：Git LFS 文件、带 `eol=crlf` 属性的文件 | 每个受保护文件都必须与起始提交存储的字节完全一致，所以 trial 的结果是 `error`。 |
| 子模块内部或其下的路径 | teamai 无法恢复子模块里的文件，所以 trial 的结果是 `error`。 |

check 读取的内容无法一一列出的任务，应改用 `successCriteria`。

### 修复带来的测试

如果证明修复的测试是修复本身带来的，把这个测试文件列进 `check.add`；修复只是在起始提交已有的文件里加了一个用例时也一样。check 读到的是 `source.fix` 中的版本，agent 永远看不到：

```text
step                          test/auth/refresh.test.ts
the agent's clone             absent
trial check                   protect restored, then written from 9a1d4e7
baseline at 3f2c9a7           written from 9a1d4e7: the check must fail
try at 3f2c9a7                written from 9a1d4e7: the check must fail
try at 9a1d4e7                protect restored, then written from 9a1d4e7: the check must pass
```

| `teamai pull` 和 `teamai review --branch` 拒绝 | 原因 |
| --- | --- |
| 没有 `source.fix` 的 `check.add` | 这些文件来自 `source.fix`。 |
| 没有任何 `protect` 条目匹配的 `check.add` 路径 | agent 可以自己提供它。 |
| `check.add` 里的通配符 | 每一项都只指明一个文件。 |

### 套件目录中的测试

任务的提交里没有的测试，例如你专门为任务写的测试，可以放在套件目录中。`check.add` 的 `{ from, to }` 条目把它写到 check 读取的位置，写入的时机和修复的测试相同；agent 永远拿不到它：

```text
benchmarks/fix-auth/
  suite.yaml
  tasks/expired-token.yaml
  check-files/expired-token/refresh.test.ts
```

```yaml
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add:
    - from: check-files/expired-token/refresh.test.ts
      to: test/auth/refresh.test.ts
```

`from` 是套件目录中的一个文件或目录；目录会把其下的每个文件写到 `to` 之下。每个文件按字节写入，保留可执行位。`teamai pull` 把这些文件和套件一起保存，运行写入的是它启动时的版本，所以运行期间 pull 不会改变任何 check。修改其中一个文件会改变任务的 `sourceHash`。这种条目不需要 `source.fix`。

| `teamai pull` 和 `teamai review --branch` 拒绝 | 原因 |
| --- | --- |
| `from` 在套件目录中找不到、指向套件目录之外，或者是符号链接 | 只读取套件目录自己的文件。 |
| 带 `..` 或通配符的 `to` | 它只指明克隆中的一个路径。 |
| 没有任何 `protect` 条目匹配的 `to` 或其下的文件 | agent 可以自己提供它。 |
| 两个条目写同一个路径 | 每个路径只写一次。 |

### 基线

在任务的第一个 trial 之前，teamai 在起始提交的全新克隆上运行 setup，写入任务的 `check.add` 文件，并运行一次 check：

| check 在起始提交上 | 任务 |
| --- | --- |
| 失败 | 有效：它的 trial 会运行。 |
| 通过 | `invalid: check passes without changes`，不运行 trial。 |
| 无法运行 | `check could not run`，不运行 trial。 |

| check 无法运行的情况 | 记为 |
| --- | --- |
| 以 127 退出 | `not_found` |
| 以 126 退出 | `not_executable` |
| 在 Windows 以外以 129 到 192 退出 | `signal`：shell 把被信号杀死的命令报告为 128 加上信号编号。不要把它们用作 check 自己的失败退出码。 |
| 运行超过超时时间 | `timeout` |

prompt 之后无法运行的 check 让 trial 得到 `error`，而不是 `failed`。

### trial 限制

`trial` 限制每个 trial 的 prompt。达到限制会结束智能体的这一轮，teamai 随后在智能体留下的结果上运行 trial 的 check 或评判，所以用完时间的工具算作任务失败，而不是测试框架出错：

```yaml
timeout: 45m
trial:
  timeout: 8m
  budget: { tokens: 300000 }
  max_turns: 60
```

| 键 | 限制 | 在本地驱动上 |
| --- | --- | --- |
| `timeout` | 从工具启动起的时间。要短于套件的 `timeout`，后者仍然结束整个运行。 | 停止工具及其启动的每个进程。 |
| `budget.tokens` | 输入加输出 token，按 [工作流预算](workflow-advanced.md#要求和限制)的方式计算。 | 在工具运行时从其输出中计数，超过预算后停止工具，所以 trial 可能多出最后一次模型调用。Codex 只在结束时给出 token，CodeBuddy 的 token 不会在运行时计数：两者都会运行到结束，并在 `unenforced` 中列出 `budget`。不报告 token 的工具会让其 trial 以 `error` 结束，除非另一个限制先停止了它：这时该 trial 会在 `unenforced` 中列出 `budget`。 |
| `max_turns` | 智能体轮数，按工具自己的计数。 | 传给 Claude。其他工具在 `unenforced` 中列出 `max_turns`。 |

被限制停止的 trial 在记录中带 `limit`，并计入 “Stopped by a limit”。在 `unenforced` 中列出套件限制的 trial 算作偏差，所以有上限的 arm 不会被悄悄地与没有上限的 arm 比较。完全无法结束一轮的驱动会把这些限制当作硬性截止时间来运行 trial，并在 `unenforced` 中列出 `on_limit`。运行保持它启动时的限制。

## 试运行任务

新任务文件加入套件之前，可以先试运行。在套件 `repo` 的检出目录中运行，团队仓库检出在旁边：

```console
$ teamai benchmark try ../team/benchmarks/fix-auth/tasks/expired-token.yaml
ℹ Task expired-token: trying the check at 3f2c9a7
ℹ Task expired-token: trying the check at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them
{"data":{"try":{"task":"expired-token","message":"Task \"expired-token\": the check fails at 3f2c9a7 and passes at the fix 9a1d4e7, with the protected paths as 3f2c9a7 has them."}}}
```

```text
task           at startingCommit      at source.fix (protect restored)   exit
pod-startup    check fails            check passes                       0
old-bug        check passes           not tried                          1: "check passes without changes at 3f2c9a7"
bad-fix        check fails            check fails                        1: "check fails at the fix 9a1d4e7"
test-in-fix    check fails            check fails (fix's test restored)  1: "The fix changes test/startup.test.ts, which protect puts back as 3f2c9a7 has them: list a test the fix brought in check.add"
changed-test   check fails            check passes (check.add written)   0
add-missing    not tried              not tried                          1: "test/missing.test.ts is not a file at the fix 9a1d4e7"
no-fix         check fails            not tried                          0: "the check was not tried on a fix"
criteria-only  no check               no check                           0: "there is no check to try"
missing-tool   could not run          not tried                          1: names the command and 3f2c9a7
setup-error    setup failed           not tried                          1: names setup and 3f2c9a7
```

`benchmark try` 按原样读取任务文件及其上两级目录中的 `suite.yaml`，并像 `teamai pull` 一样校验两者（连同其 `check.add` 条目从该套件目录指明的文件）。它不需要 `teamai init`。检出目录缺少的提交会像运行时一样，按 SHA 从套件的 `repo` 获取。每个提交都有一个全新克隆、套件的 `setup`、trial 得到的环境（见[运行套件](#运行套件)），以及套件的 `timeout`。它不创建运行，也不写记录。check 会在你的机器上运行项目代码，所以只试运行你信任的任务。

## 运行套件

```console
$ teamai benchmark run fix-auth --sandbox
ℹ Run r38302f8e6a18c377 started. If it stops before it ends, continue it with: teamai workflow resume r38302f8e6a18c377 --sandbox
```

`benchmark run` 先规划套件，所以无法运行的套件不会留下运行。然后它用套件的 `timeout` 启动工作流 `teamai-benchmark`，并用本地驱动驱动它。

每个 trial 的 prompt 都以 [`permissions: unattended`](workflow-advanced.md#无人值守的-prompt) 运行，因为 teamai 自带的工作流在严格的 sandbox 中运行 trial：无论这台机器上该工具的设置如何，工具都无需询问就编辑文件和运行命令。

| 选项或配置 | 效果 |
| --- | --- |
| `--sandbox` | 只为当前这个进程把本机声明为 sandbox。只在可以丢弃的机器上使用。 |
| 配置里的 `workflows.sandbox: true` | 为每个进程声明它，见[要求和限制](workflow-advanced.md#要求和限制)。 |
| 两者都没有 | 运行在启动时以 `requirement_unmet` 被拒绝：trial 需要严格 sandbox。 |
| `--member-aliases` | 你自己的 `~/.teamai/models/aliases.yaml` 优先于团队的 `models/aliases.yaml`，表格会把由你的文件决定的模型的来源显示为 `member`。 |
| `--fail-on-regression` | 某个 arm 的通过率下降时也以 1 退出。见[回归时失败](#回归时失败)。 |

| `benchmark run` 退出码 | 何时 |
| --- | --- |
| 0 | 运行成功并写出了报告，无论 trial 的结果如何。 |
| 1 | 套件或启动被拒绝、运行超时或被取消、报告失败或被取消，或者 `--fail-on-regression` 发现了下降。 |

仍在等待发布的记录从不改变退出码。

| trial 得到 | |
| --- | --- |
| 起始提交的全新克隆 | 没有远程仓库。你的检出目录从不被改动。 |
| 团队资产和套件 | 来自本检出目录上次 pull 到的团队修订（该修订必须已推送），或来自 arm 的 `team`。启动时冻结：运行期间 pull 不会改变它运行的任何内容。 |
| 环境 | 去掉 `GITHUB_TOKEN`、`GH_TOKEN`、`GITLAB_TOKEN`、`GL_TOKEN`、`CI_JOB_TOKEN`、`SSH_AUTH_SOCK`、`GIT_ASKPASS` 和 `SSH_ASKPASS`：trials 步骤是[严格 sandbox](workflow-advanced.md#要求和限制)，它让 trial 的每个进程都拿不到这些变量。 |
| 你的主目录 | 保持原样：teamai 去不掉其中的登录信息、MCP 服务器和插件。 |
| 本机上的团队仓库 | 保持原样：你的团队检出目录，以及每个 trial 克隆旁边用来安装其团队资产的那份团队修订副本，都包含 `benchmarks/`，check 文件也在其中。在本机上搜索的 agent 能找到它们。 |

本地驱动按这个顺序运行每个 trial：全新克隆、团队资产、setup、用 prompt 启动 arm 的工具，然后运行 check。

| | |
| --- | --- |
| 工具 | 它能运行 `claude`、`codex` 和 `opencode`。安装 arm 用到的每个工具并登录。找不到工具的 arm，它的 trial 为 `not_run`，其他 arm 照常运行。 |
| 通道 | 一次一个 trial，除非套件设置了 [`parallel`](#并行通道)。 |
| 超时 | 套件的 `timeout` 是整个运行的超时。setup、工具和 check 到时都会停止：它们所属的 trial 记为 `error`，仍未完成的 trial 结算为 `not_run`。让它低于 CI 任务的时限，否则任务会在打印表格之前被杀掉。 |
| 卡住的 trial | 没有 [`trial.timeout`](#trial-限制) 时，一个永不返回的工具会一直运行到套件超时，它之后的每个 trial 结算为 `not_run`。 |
| 评判 | 带 `successCriteria` 的任务和套件的评分器在运行结束前评判，评判在运行了 trial 的那个安装上进行。机器无法评判时，需要评判的套件在启动时被拒绝。 |
| 控制命令 | trial 的步骤要等运行的 `plan` 步骤报告后才存在。在此之前，对 trial 步骤执行 `teamai workflow cancel <run> <step>` 会返回 `step_not_found`。benchmark 运行是[隔离的](workflow-advanced.md#隔离运行)：`workflow retry`、`publish` 和 `--claim` 拒绝它，`publish` 和 `--claim` 返回 `isolated_run`，retry 会给出 `teamai benchmark run <suite>`。 |
| 停下 | 用 `teamai workflow resume <run> --sandbox` 继续。 |

无法运行的启动会被拒绝，消息说明该怎么做，并且不会创建运行。你的 user 范围 teamai 安装也能到达该团队，或团队通过 HTTP 提供时，运行无法固定 trial 得到的团队，会以 `team_ref_blocked` 拒绝，并说明要改什么。

### 并行通道

```yaml
parallel: 4
```

基线和 trial 最多在 `parallel` 个通道中运行，每个通道内一个接一个。本地驱动同时最多运行 `workflows.max_parallel` 个，除非你的配置设置了它，否则为 1，所以两者都要设置。并行的 trial 共享机器的 CPU、内存和网络，以及工具的速率限制：时长、有时还有结果，都会与串行运行不同。只比较 `parallel` 相同的运行。

## benchmark 工作流

`benchmark run` 启动工作流 `teamai-benchmark`。teamai 提供的是这个：

```yaml
# workflows/teamai-benchmark.yaml，随 npm 包发布
schemaVersion: v1alpha1
name: teamai-benchmark
description: Run a benchmark suite. Every arm works the same tasks in fresh clones, judged by checks it never sees.
invoke: deny
inputs: { suite: string, aliases: string }
steps:
  - id: plan
    command: teamai benchmark plan "$SUITE" --aliases "$ALIASES"
    env: { SUITE: "{{ inputs.suite }}", ALIASES: "{{ inputs.aliases }}" }
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
    requires: { isolation: sandbox, strict: true }
finally:
  - id: report
    command: teamai benchmark report
    output: { text: string, table: json }
outputs: { text: steps.report.outputs.text, table: steps.report.outputs.table }
```

| 命令 | 作为 | 作用 |
| --- | --- | --- |
| `teamai benchmark plan <suite>` | `plan` 步骤 | 冻结你 pull 到的团队修订，获取 trial 读取的每个提交，并把 trial 打印成一个工作流，每个基线和 trial 一个克隆。 |
| `teamai benchmark check --baseline\|--trial` | 每个克隆中的一个步骤 | 写入 `check.add`，对 trial 恢复 `protect`，运行任务的 check，并打印其结果。 |
| `teamai benchmark report` | `finally` 步骤 | 给 trial 分类，写出记录，并打印结果。 |

`trials` 运行 `plan` 打印的内容：见[运行步骤打印的工作流](workflow-advanced.md#运行步骤打印的工作流)。`report` 在 trial 之后运行，无论它们发生了什么，就像 [finally 步骤](workflow-advanced.md#finally-步骤)那样。`benchmark run --member-aliases` 把 `aliases` 传为 `member`，否则传为 `team`。

要修改它，推送你自己的 `workflows/teamai-benchmark.yaml`，或者为某个角色或项目的成员推送 `workflows/<namespace>/teamai-benchmark.yaml`。它会为接收它的人替换 teamai 的版本，就像任何[默认工作流](workflow.md#覆盖默认工作流)一样，`benchmark run` 会说明这一点：

```text
ℹ Running the team's workflows/ops/teamai-benchmark.yaml, which replaces teamai's benchmark workflow.
```

你的版本必须接受输入 `suite`，要用 `--member-aliases` 运行还必须接受输入 `aliases`；否则 `benchmark run` 会拒绝它。保留 `plan` 的步骤 id，并把 `report` 保留为 `finally` 步骤。去掉 `strict: true` 会让 trial 在不扣留凭据的情况下运行，并且使用各工具自己的权限设置，而不是无人值守：不能编辑的工具会让它的 trial 失败，报告的第一行会说明这一点。你接收的两个命名空间都有 `teamai-benchmark.yaml` 时，`benchmark run` 以 `workflow_namespace_conflict` 拒绝，并指出两个文件，绝不退回 teamai 自带的版本。

## 结果

运行结束时，`benchmark run` 把结果打印到 stderr。stdout 上的 JSON 返回在 `data.done.outputs.text` 中带同样的文本，在 `data.done.outputs.table` 中带数字。对这个套件，再加一个 check 本来就通过的第三个任务 `old-bug`：

```text
| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | claude | tool default (team) | 9 | 4 | 2 | 0 | 0 | 3 | 0 | 0 | 0 | 44% (4/9) |
| codex | codex | tool default (team) | 9 | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 33% (3/9) |
| strong | claude | claude-opus-5-5 high (team) | 9 | 6 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 67% (6/9) |

| Arm | Median tokens (input + output) | Median duration | Cost |
| --- | --- | --- | --- |
| claude | 41200 (6) | 84.0 s (6) | 1.82 USD (6) |
| codex | 38900 (6) | 97.5 s (6) | unknown (0) |
| strong | 52300 (6) | 121.0 s (6) | 4.1 USD (6) |

| Task | claude | codex | strong |
| --- | --- | --- | --- |
| expired-token | 33% (1/3) | 33% (1/3) | 100% (3/3) |
| login-copy | 100% (3/3) | 67% (2/3) | 100% (3/3) |
| old-bug | 0% (0/3) | 0% (0/3) | 0% (0/3) |

| Task | Baseline |
| --- | --- |
| old-bug | invalid: check passes without changes |

These results hold for these tasks, this run and this machine.
```

| 表格 | 内容 |
| --- | --- |
| Arm | 按结果统计每个 arm 的 trial，以及被 [trial 限制](#trial-限制)停止的数量。偏差是 prompt 运行时的工具、团队修订或模型与其 arm 不同的 trial，或者其 driver 无法执行某个 trial 限制的 trial。记录缺少其中某个值的 trial 为未验证。有 arm 使用 pull 到的修订以外的团队资产时，Team 列显示每个 arm 的团队资产，例如 `pulled 3f9c2ab`、`next 81d0e4c`、`3f9c2ab without skills/auth-tokens` 或 `none`。 |
| 用量 | 每个 arm 的中位数和成本合计，并注明各自用了多少个 trial。token 和成本只按工具自己声明的显示，所以不声明的工具显示 `unknown (0)`。 |
| 任务 | 每个任务在每个 arm 上的通过率。 |
| 基线 | 没有运行的任务及原因。 |
| Skill | 仅当某个 arm 改变团队 skill 时出现：它新增、去掉或改变的每个 skill，以及该 arm 的 trial 中有多少加载了它，与什么都不改变的 arm 并列。 |

```text
| Arm | Skill | Change | Loaded in this arm | Loaded in the defaults arm |
| --- | --- | --- | --- | --- |
| no-auth-tokens | auth-tokens | removed | 0/3 | 2/3, 1 unknown |
```

只有 teamai 能看到的加载才计数：`unknown` 是其工具不报告 skill 加载的 trial，而不是没有加载该 skill 的 trial。

结果不是运行的状态：所有 trial 都失败的运行仍然成功。运行只在超时或被取消时失败。

`report` 把运行的 benchmark 记录写到本机上该运行的目录中。[使用统计上报](reporting.md)开启时，它还会把记录发布到团队仓库 `teamai-reports` 分支的 `benchmarks/runs/<run>.json`，所以任务的 token 还需要团队仓库的推送权限。发布失败的记录会在队列中等待，并在下一次 `teamai pull` 时重试；在此之前，文本以 `record: pending` 结尾。[运行记录](workflow.md#运行记录)列出记录的字段，并给出只从记录算出每个 arm 通过率的 `jq` 命令。关闭时，结果仍在返回中。Dashboard 的[基准测试页面](dashboard.md#基准测试benchmarks)按时间画出已发布的运行和本机的运行。

## 回归时失败

```console
$ teamai benchmark run fix-auth --sandbox --fail-on-regression
Arm "claude" passed 4/9 paired trials, against 8/9 in run r1c0d9e2f4b6a8c7d: a drop of 44 points, with a 95% interval of -73 to -16 points.
```

`--fail-on-regression` 把这次运行与该套件最新的一次更早的运行比较，那次运行必须已成功、已发布在 `teamai-reports` 上，并且任务和 arm 相同。名字、工具、模型、effort、工作流和团队处理方式都相同的 arm 就是同一个 arm，无论它 pull 到的是哪个修订。trial 按任务和重复次数配对，就像 Dashboard 的 Compare 那样配对，某个 arm 的通过率下降超出偶然范围时，运行以 1 退出。仍在本机等待的记录不参与比较。没有这样的运行时，它打印一条提示，不改变退出码。

## 在 CI 中运行

GitHub Actions 任务：

```yaml
on: workflow_dispatch
jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.TEAM_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @anthropic-ai/claude-code
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
      - run: npx teamai-cli pull
      - run: npx teamai-cli benchmark run fix-auth --sandbox > done.json
      - if: always()
        run: jq -r '.data.done.outputs.text // empty' done.json >> "$GITHUB_STEP_SUMMARY"
```

- `TEAM_TOKEN` 读取团队仓库，并在使用统计上报开启时推送到团队仓库。
- `--agent claude` 为 Claude Code 设置 teamai，全新的 runner 还从未运行过它。
- 套件 `repo` 的检出带完整历史，所以每个任务的起始提交都在。
- 最后一步把结果写进任务摘要，运行失败时也会写。

GitLab CI 任务：

```yaml
benchmark:
  image: node:22
  timeout: 1h
  when: manual
  script:
    - npm install -g @anthropic-ai/claude-code
    - npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
    - npx teamai-cli pull
    - npx teamai-cli benchmark run fix-auth --sandbox > done.json
  artifacts:
    when: always
    paths: [done.json]
```

把 `TEAM_REPO`、`GITLAB_TOKEN`（读取团队仓库）和 `ANTHROPIC_API_KEY` 设为 masked CI/CD 变量。任务日志会显示结果，`done.json` 会保存结果。换成别的工具时，同样安装它并设置它的密钥：每个 arm 的工具都必须在 runner 上。

## 在自己的驱动里运行

benchmark 运行是一次普通的工作流运行，所以任何驱动都通过 `workflow next --prepare` 和 `workflow report` 运行它，见[在自己的驱动里使用克隆工作区](workflow-advanced.md#在自己的驱动里使用克隆工作区)：

```text
teamai workflow start teamai-benchmark --inputs '{"suite":"fix-auth","aliases":"team"}' --timeout 45m
teamai workflow next <run> --prepare --json '{"driver":{..., "can":{"workspace":["read-only","new","continue","clone"],"isolation":"sandbox","env":true,"setup":true,"tools":["claude"],"unattended":true,"end_turn":true}}}'
  -> a command lease (plan, check, report): run lease.command in lease.cwd, or in your checkout without one, with TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>
  -> a prompt lease: launch lease.tool in lease.cwd on lease.prompt, with lease.model, in its unattended mode for lease.permissions, held to lease.limits
teamai workflow report <run> --json '{..., "tool":"claude", "durationMs":84000, "cost":{"amount":0.31,"unit":"USD"}}'
```

| | |
| --- | --- |
| `driver.can` | 每次 `next` 都带：`workspace` 中的 `clone`、`isolation: "sandbox"`、`env: true`、`setup: true`、`tools` 中列出各 arm 的工具、`unattended: true`，以及在租约的限制处结束一轮时带 `end_turn: true`。驱动缺少其中任何一项时，trial 会被扣住，`wait.held[].missing` 会指明缺的是哪项。 |
| `--prepare` | teamai 在本机创建每个克隆、安装其团队资产并运行 setup，然后返回带 `cwd` 的租约。 |
| 每个进程 | 运行时不带 `lease.envScope.withhold` 中的名字，带 `lease.env` 和 `TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>`，所以从中调用的 `teamai` 不会改变任何运行。命令步骤把它的输出以 JSON 打印到 stdout；把它们作为 `outputs` 报告。 |
| `report` | 对 prompt：`tool`、只围绕工具启动测得的 `durationMs`，以及仅在工具给出时才带的 `cost`。 |
| 限制 | 让工具遵守 `lease.limits`。某个限制停止了工具时，报告 `outcome: "success"` 并带 `limit`：`timeout`、`budget` 或 `max_turns`；无法让工具遵守的 `budget` 或 `max_turns` 列在 `unenforced` 中。 |
| 超时 | `benchmark run` 把套件的 `timeout` 作为 `--timeout` 传入；直接执行 `workflow start teamai-benchmark` 时也必须传入它，否则 `plan` 会失败。 |
| 评判 | 套件的评分器仍在评判时，`next` 返回带 `judging` 的 `wait`：在运行了 trial 的那个安装上运行 `teamai score --next`。 |
