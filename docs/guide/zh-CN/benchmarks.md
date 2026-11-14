# Benchmark

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

```text
teamai benchmark run fix-auth --sandbox
```

benchmark 套件用团队自己的任务比较工具或模型。一次运行把每个任务交给每个 arm 各做几次，检查每个结果，然后打印表格。trial 只在声明为 sandbox 的机器上运行，例如 CI runner 或容器。

一次 benchmark 运行就是工作流 `teamai-benchmark` 的一次运行，这个工作流由 teamai 提供，团队可以替换它。见 [benchmark 工作流](#benchmark-工作流)。

## 编写套件

套件是团队仓库里的一个目录：`benchmarks/<suite>/SUITE.yaml`，以及 `tasks/` 里每个任务一个文件。写成 `suite.yaml` 也可以，但同一目录里不能两个都有。

```yaml
# benchmarks/fix-auth/SUITE.yaml
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
| `defaults` | 其他 arm 用来对比的那个 arm：`tool`，以及可选的 `model`、`team`、`workflow` 和 `role`。它不是工作流的 `defaults`。 |
| `arms` | 1 到 6 个。每个最多改变一个 `defaults` 键，最多只有一个什么都不改。 |
| `matrix` | 代替 `arms`：teamai 把这些值列表交叉组合成 arm。见[用 matrix 交叉工具和团队资源](#用-matrix-交叉工具和团队资源)。 |
| `team` | arm 运行时使用的团队资源。见[使用其他团队资源的 arm](#使用其他团队资源的-arm)。 |
| `workflow` | 每个 trial 在任务上运行的团队工作流，代替单个 prompt。见[运行工作流的 arm](#运行工作流的-arm)。 |
| `role` | 每个 trial 的克隆使用的 `manifest/roles.yaml` 中的角色。见[以角色运行的 arm](#以角色运行的-arm)。 |
| `recall` | 该 arm 的 trial 克隆是否部署团队的 recall，而每个 workflow 克隆都默认关闭它。见[开启 recall 的 arm](#开启-recall-的-arm)。 |
| `model` | `models/aliases.yaml` 里的模型别名（运行启动时按每个 arm 的工具解析），或一个模型名。 |
| `repetitions` | 1 到 10，默认 3。 |
| `parallel` | 运行基线和 trial 的通道数，1 到 32，默认 1。见[并行通道](#并行通道)。 |
| `timeout` | 必填：整个运行的超时。 |
| `trial` | 可选：每个 trial 的 prompt 的限制。见 [trial 限制](#trial-限制)。 |
| `setup` | 可选，即[工作流的 `setup`](workflow-advanced.md#要求和限制)。在每个全新克隆中、工具或 check 之前运行。 |
| `scorers` | 可选，评判每个 trial 的[评分器](scorers.md)；任务可以[再列出更多](#每个任务的评分器)。没有有效 `scorers/<name>.md` 或[评分器目录](scorers.md#评分器目录) `scorers/<name>/SCORER.md` 的名字会让 `teamai review --branch` 失败，`teamai pull` 会警告，start 会拒绝该套件。 |
| `calibration` | 可选的 `{ rate }`，0 到 100，默认 0：check 失败的 trial 中，也交给正确性评判打标签的百分比，用来衡量这个评判。见[校准评判](#校准评判)。 |

### 使用其他团队资源的 arm

arm 默认使用本检出目录 pull 到的团队修订，除非它设置了 `team`。可以用它衡量团队资源带来了多少提升、合并前的某个分支，或某一个 skill：

```yaml
defaults:
  tool: claude
arms:
  - name: pulled              # 你 pull 到的修订
  - name: bare
    team: none                # 完全不带团队资源
  - name: next
    team: next                # 团队仓库的 next 分支
  - name: no-auth-tokens
    team:
      without: [skills/auth-tokens]  # pull 到的修订，去掉这个 skill
```

| `team` | arm 运行时使用 |
| --- | --- |
| `pulled`，或不写 `team` | 本检出目录 pull 到的团队修订。 |
| `none` | 不带团队资源。如果本机 user 范围的 teamai 安装会把资源交付给该 arm 的工具，start 会拒绝它，因为它的 trial 会读到你 home 目录里的这些资源。 |
| 分支、tag 或提交 | 团队仓库的该修订，在运行启动时解析。分支按团队仓库里的名字写，例如 `next`，而不是 `origin/next`。 |
| `without: [<path>, ...]` | pull 到的修订，去掉团队仓库中的这些文件和目录。见[去掉团队资源](#去掉团队资源)。 |

记录中的 `skillChanges` 为每个使用其他修订或 `without` 路径的 arm 列出它相对 pull 到的修订新增、去掉或改变的团队 skill，结果会显示每个 arm 加载它们的频率。见[结果](#结果)。

### 去掉团队资源

`without` 接受团队仓库中的路径，写法与 git 列出的一致：一个 skill、一条 rule、一个 agent、一个 `claudemd/`（或 `agentsmd/`）文件、一篇文档、整个命名空间目录，或任何其他文件，例如 `hooks/hooks.yaml`：

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
| `skills/`、`rules/`、`agents/`、`claudemd/`（或 `agentsmd/`）、或 `docs/` 下、无论去不去掉 pull 都交付得一样的路径 | 去掉它什么都不改变。消息会说明原因：你的角色或项目不接收的命名空间、只通过你没有订阅的 tag 才接收的共享 skill、你排除的 skill、只带有你没有订阅的 tag 的 rule。 |
| 你接收的某个命名空间会用自己的副本代替的共享路径 | 命名空间的副本仍会到达 trial：消息会说 `list skills/ops/release too`。 |

其他位置的路径只需要存在。`without` 路径会去掉整个文件：要去掉共享文件中的一个条目，例如一个 MCP 服务器、hook、env 键或模型别名，推送一个不含它的团队仓库分支，并指定这个分支：

```yaml
arms:
  - name: pulled
  - name: no-github-mcp
    team: no-github-mcp       # 团队仓库的一个分支，其 mcp/mcp.yaml 去掉了 github 服务器
```

benchmark 不在 self 模式下运行，因为那里由项目自己的提交决定团队资源：运行会以 `team_ref_blocked` 拒绝每个 arm。

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

运行在 arm 的团队修订上读取该工作流及其运行的工作流，像任何团队工作流一样经过你接收的命名空间，并在 arm 的工具、模型和 effort 上运行其中每个 prompt 步骤，像 trial 自己的 prompt 一样无人值守。工作流没有输入 `task`、还要求其他输入，或有 `finally` 步骤时，它的某个步骤会交付、询问某个人、打开 `continue` 以外的工作区、以 `workspace: continue` 按 `for_each` 的每一项运行工作流，或运行 `workflow: { from }` 时，或者它的某个 prompt 运行 `agent` 而 arm 没有设置 `model`（agent 自己的模型可能取代工具的默认模型；请在 `defaults` 中设置 `model`：带 `workflow` 的 arm 不能再改其他键）时，运行拒绝该 arm（`arm_workflow_unrunnable`）；你接收的两个命名空间都有该工作流时，以 `workflow_namespace_conflict` 拒绝。trial 的 check 或评判根据工作流留在克隆中的内容判定。它的时长是各个 prompt 轮次之和，token 和成本是各个 prompt 之和。[trial 限制](#trial-限制)的 `timeout` 和 `budget` 是它的 prompt 加起来可以花费的量；`max_turns` 不执行，会列在 `unenforced` 中。

### 以角色运行的 arm

在同一个改动上，审查者的知识是否比前端开发者的知识发现更多问题？给每个 arm 一个角色：

```yaml
schemaVersion: v1alpha1
name: review-sql
description: Flag unsafe SQL in a change before it merges.
repo: https://github.com/acme/billing.git
defaults:
  tool: claude
  model: strong
  role: frontend
arms:
  - name: frontend
  - name: review
    role: review
repetitions: 3
timeout: 45m
```

```console
$ teamai benchmark run review-sql --sandbox
```

两个 arm 使用相同的工具、模型和团队修订。每个 trial 的克隆像[带 `role` 的克隆步骤](workflow-advanced.md#以团队角色运行克隆)一样获得其 arm 的角色：该角色的 skill、规则、agent、文档和其他知识，加上你的项目，以及你自己的 hook、MCP 服务器、env 和模型。记录在 arm 上保留角色，并在每个 trial 上保留其克隆交付时使用的角色：

```json
"arms": [
  { "name": "frontend", "tool": "claude", "model": "claude-opus-5-5", "alias": "strong", "source": "team", "team": { "kind": "pulled", "revision": "3f9c2ab…" }, "role": "frontend" },
  { "name": "review", "tool": "claude", "model": "claude-opus-5-5", "alias": "strong", "source": "team", "team": { "kind": "pulled", "revision": "3f9c2ab…" }, "role": "review" }
],
"trials": [
  { "task": "orders-report", "arm": "review", "result": "passed", "agent": { "team": { "revision": "3f9c2ab…", "selection": { "primaryRole": "frontend", "stepRole": "review", … } }, … }, … }
]
```

运行打印的结果多出一个 Role 列：

```text
| Arm | Tool | Model (source) | Role | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | claude | claude-opus-5-5 (team) | frontend | 6 | 2 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 33% (2/6) |
| review | claude | claude-opus-5-5 (team) | review | 6 | 5 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 83% (5/6) |
```

克隆运行时的角色与其 arm 不同的 trial 计入“偏差”，记录中没有角色的 trial 计入“未验证”。在有角色 arm 的套件中，没有 `role` 的 arm 显示为 `member's roles`：它使用你自己的角色。在仪表盘的 [Benchmarks 页面](dashboard.md#benchmarks)上，每个 arm 的名字下方显示 `review 角色`；**对比** 按 **角色** 显示 `review 角色 对比 frontend 角色`，逐个 trial 配对。

运行会在 arm 所用的团队修订上检查 `manifest/roles.yaml` 是否声明了该 arm 的角色，未声明时在任何 trial 运行之前拒绝：

```text
role_unavailable: Arm "review" runs with role review, which manifest/roles.yaml at team revision 3f9c2ab does not declare; it declares frontend, backend. Add the role to manifest/roles.yaml, or fix the arm's role, push it, run teamai pull, and start again.
```

带角色的 arm 需要团队资源供角色选择，因此套件拒绝同时写 `role` 和 `team: none`。matrix 也可以交叉角色：`matrix: { tool: [claude, codex], role: [frontend, review] }` 生成 `claude-frontend`、`claude-review`、`codex-frontend` 和 `codex-review`。对比会在每个工具上配对两个角色，在每个角色内配对两个工具，绝不配对两者都不同的一对。

### 开启 recall 的 arm

团队的 recall 对任务到底有没有帮助——比如某条规则声明了它的文档和代码页讲的是同一件事？给各 arm 开 recall。trial 的克隆里 recall 是关闭的，和每个 workflow 克隆一样；`recall: true` 为该 arm 的克隆打开它，它的会话会在加载的资源上看到 `Related:` 行：

```yaml
schemaVersion: v1alpha1
name: relations-help
description: 声明的关联是否帮助修复落地。
repo: https://github.com/acme/billing.git
defaults:
  tool: claude
  model: strong
arms:
  - name: with-relations
    recall: true
  - name: without-relations
    team: { without: [rules/payments.md] }
    recall: true
repetitions: 3
timeout: 45m
```

两个 arm 都开着 recall。这个示例移除整条规则，而不仅仅是关联。要单独测量声明式关联，请保留规则正文，并像[声明式关联试验](../../../examples/related-recall/README.md)一样为两组固定不同的团队提交。套件要求各 arm 在某个 `defaults` 键上不同——`recall` 不算，因为它是测量的对照条件而不是页面要对比的值——所以两个 arm 改的是 `team`。

`recall` 从不算作一个被更改的 `defaults` 键，matrix 也不能交叉它。不写它时，该 arm 和每个 workflow 克隆一样在没有 recall 下运行。

记录会把这个 arm 的 `recall` 保留下来，因此之后的对比能分清一个 run 测了 recall、另一个没测；只要有 arm 开了它，结果就会多出一列 Recall：

```text
| Arm | Tool | Model (source) | Recall | Planned | Passed | … |
| --- | --- | --- | --- | --- | --- | --- |
| with-relations | claude | claude-opus-5-5 (team) | on | 6 | 4 | … |
| without-relations | claude | claude-opus-5-5 (team) | on | 6 | 1 | … |
```

不写它的 arm 读作 `off`。

### 用 matrix 交叉工具和团队资源

`matrix` 为其值的每种组合生成一个 arm，因此任意两个只差一个值的 arm 只比较这一个值。下面这个例子同时回答：团队资源对每个工具帮助多大，以及带上资源后哪个工具更好：

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

matrix 可以变化 `tool`、`model`、`team`、`workflow` 或 `role`，其中至少一个要有两个或更多值，并生成 2 到 12 个 arm。它没写的键取自 `defaults`。每个 arm 的名字由各个变化键的值拼接而成：ref 原样使用，字母、数字、`-`、`_` 以外的字符写成 `-`，`without: [skills/auth-tokens]` 写成 `without-skills-auth-tokens`。一个套件只能有 `arms` 或 `matrix` 之一。

任务从 `repo` 的一个完整提交开始，由 `check`、`successCriteria` 或两者一起判定：

```yaml
# benchmarks/fix-auth/tasks/expired-token.yaml
schemaVersion: v1alpha1
title: Reject expired refresh tokens
prompt: |
  Refresh tokens past their expiry are still accepted. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
solutionCommit: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add: [test/auth/refresh.test.ts]
source: { platform: claude-code, sessionId: 7c1e2b9a }
```

```yaml
# benchmarks/fix-auth/tasks/login-copy.yaml
schemaVersion: v1alpha1
title: Clearer login error
prompt: Make the login error say which field is wrong.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/login.test.ts
  protect: ['test/**', 'package.json', 'package-lock.json']
successCriteria: The error names the wrong field and still reveals nothing about which accounts exist.
```

`login-copy` 两者都有：测试能判定的部分由 check 判定，其余部分由评判器判定，且只在 check 通过之后：

```text
check fails  → the check step writes the failing label, decidedBy check → teamai-score skips the scorer: no judge
check passes → the check step writes no label → the judge decides on successCriteria, decidedBy judge
```

| 键 | 值 |
| --- | --- |
| `startingCommit` | 任务开始时 `repo` 的完整提交。 |
| `solutionCommit` | 可选：包含任务参考解决方案的完整提交。[`benchmark try`](#试运行任务) 会检查 check 在这里通过，`check.add` 也从这里读取文件。 |
| `check` | `run`：任务完成后以 0 退出的命令；`protect`：agent 不能提供的路径。 |
| `check.add` | 可选：check 之前写入、agent 永远拿不到的文件：按 `solutionCommit` 中的样子写入的文件，例如解决方案的测试；或者 `{ from, to }`，套件目录中的一个文件或目录。目录会加入其下的所有文件，但不包括以点开头的条目，例如 `.DS_Store`；要加入点文件，在 `from` 中直接指明它。见[解决方案带来的测试](#解决方案带来的测试)和[套件目录中的测试](#套件目录中的测试)。 |
| `successCriteria` | 评判器据以判定的标准：单独使用，或在 `check` 通过之后。 |
| `covers` | 可选：该任务的工作预期需要的团队仓库路径，写法与 [`without`](#去掉团队资源) 相同。[资源效果](#资源效果) 表按覆盖它的任务拆分一个去掉了该路径的 arm。 |
| `source` | 可选：任务的来源：会话的 `platform` 和 `sessionId`，或工作流 pass 的 `runId`、`step` 和 `pass`。不会从它运行任何东西；[`digest --json`](self-improvement.md#teamai-读取什么) 会把它指向的失败标为已覆盖。 |
| `scorers` | 可选：除套件的评分器外，还评判这个任务 trial 的[评分器](scorers.md)。见[每个任务的评分器](#每个任务的评分器)。 |

`teamai pull` 和 `teamai review --branch` 检查每个文件，并带文件和行号报告每个问题，例如既没有 `check` 也没有 `successCriteria` 的任务。`benchmarks/<namespace>/<suite>/` 下的套件只发给该角色或项目的成员，见[角色和项目](distribution.md#角色和项目)。

### 每个任务的评分器

任务的 `scorers` 和套件的评分器一起评判它的 trial，每个评分器只评判一次，所以只适用于少数任务的评分器不会在其他任务上花评判调用：

```yaml
# benchmarks/fix-auth/suite.yaml 的一部分
scorers: [review-quality]
```

```yaml
# benchmarks/fix-auth/tasks/session-fixation.yaml
schemaVersion: v1alpha1
title: Rotate the session id at login
prompt: Sessions keep their id across login. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/session.test.ts
  protect: ['test/**', 'package.json', 'package-lock.json']
scorers: [security-review]
```

| 任务 | 评判其 trial 的评分器 |
| --- | --- |
| session-fixation | review-quality, security-review |
| expired-token | review-quality |

任务的评分器名字和套件的一样检查：没有有效 `scorers/<name>.md` 或[评分器目录](scorers.md#评分器目录) `scorers/<name>/SCORER.md` 的名字会让 `teamai review --branch` 失败，`teamai pull` 会警告，start 会拒绝该套件。带 `:` 的名字（例如 `teamai:correctness:<task>`）会被拒绝，因为没有评分器文件或目录叫这个名字。这个列表是任务文件的一部分，所以改动它会改变任务的 `sourceHash`，[回归门禁](#回归时失败)不会跨这次改动配对它的 trial。start 像固定套件评分器的评判那样[固定每个评分器的评判](#对所有-arm-用同一个评判)，只要有任务列出评分器，就需要评判工具。

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

### 解决方案带来的测试

如果证明解决方案的测试是解决方案本身带来的，把这个测试文件列进 `check.add`；解决方案只是在起始提交已有的文件里加了一个用例时也一样。check 读到的是 `solutionCommit` 中的版本，agent 永远看不到：

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
| 没有 `solutionCommit` 的 `check.add` | 这些文件来自 `solutionCommit`。 |
| 没有任何 `protect` 条目匹配的 `check.add` 路径 | agent 可以自己提供它。 |
| `check.add` 里的通配符 | 每一项都只指明一个文件。 |

### 套件目录中的测试

任务的提交里没有的测试，例如你专门为任务写的测试，可以放在套件目录中。`check.add` 的 `{ from, to }` 条目把它写到 check 读取的位置，写入的时机和解决方案的测试相同；agent 永远拿不到它：

```text
benchmarks/fix-auth/
  SUITE.yaml
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

`from` 是套件目录中的一个文件或目录；目录会把其下的每个文件写到 `to` 之下。每个文件按字节写入，保留可执行位。`teamai pull` 把这些文件和套件一起保存，运行写入的是它启动时的版本，所以运行期间 pull 不会改变任何 check。修改其中一个文件会改变任务的 `sourceHash`。这种条目不需要 `solutionCommit`。

| `teamai pull` 和 `teamai review --branch` 拒绝 | 原因 |
| --- | --- |
| `from` 在套件目录中找不到、指向套件目录之外，或者是符号链接 | 只读取套件目录自己的文件。 |
| 带 `..` 或通配符的 `to` | 它只指明克隆中的一个路径。 |
| 没有任何 `protect` 条目匹配的 `to` 或其下的文件 | agent 可以自己提供它。 |
| 两个条目写同一个路径 | 每个路径只写一次。 |

### 基线

对带 `check` 的任务，不论有没有 `successCriteria`，teamai 在它的第一个 trial 之前，在起始提交的全新克隆上运行 setup，写入任务的 `check.add` 文件，并运行一次 check。只有 `successCriteria` 的任务没有基线。

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
ℹ Task expired-token: trying the check at the solution 9a1d4e7, with the protected paths as 3f2c9a7 has them
{"data":{"try":{"task":"expired-token","message":"Task \"expired-token\": the check fails at 3f2c9a7 and passes at the solution 9a1d4e7, with the protected paths as 3f2c9a7 has them."}}}
```

```text
task           at startingCommit      at solutionCommit (protect restored)    exit
pod-startup    check fails            check passes                            0
old-bug        check passes           not tried                               1: "check passes without changes at 3f2c9a7"
bad-fix        check fails            check fails                             1: "check fails at the solution 9a1d4e7"
test-in-fix    check fails            check fails (solution's test restored)  1: "The solution changes test/startup.test.ts, which protect puts back as 3f2c9a7 has them: list a test the solution brought in check.add"
changed-test   check fails            check passes (check.add written)        0
add-missing    not tried              not tried                               1: "test/missing.test.ts is not a file at the solutionCommit 9a1d4e7"
no-solution    check fails            not tried                               0: "the check was not tried on a solution"
criteria-only  no check               no check                           0: "there is no check to try"
missing-tool   could not run          not tried                          1: names the command and 3f2c9a7
setup-error    setup failed           not tried                          1: names setup and 3f2c9a7
```

`benchmark try` 按原样读取任务文件及其上两级目录中的 `SUITE.yaml`，并像 `teamai pull` 一样校验两者（连同其 `check.add` 条目从该套件目录指明的文件）。它不需要 `teamai init`。检出目录缺少的提交会像运行时一样，按 SHA 从套件的 `repo` 获取。每个提交都有一个全新克隆、套件的 `setup`、trial 得到的环境（见[运行套件](#运行套件)），以及套件的 `timeout`。它不创建运行，也不写记录。check 会在你的机器上运行项目代码，所以只试运行你信任的任务。

## 把会话变成任务

你和 agent 一起完成的工作，无论是修 bug、加功能还是重构，都是套件能得到的最好任务：真实的工作，在你的代码里，还有证明它能完成的提交。让完成它的那个会话把它留下来：

```text
你：     把这个修复变成 benchmark 任务
agent:  teamai workflow start --describe teamai-session-to-task --driver skill
        proposes session 7c1e…, source claude-code, suite benchmarks/fix-auth,
                 start 3f2c9a7…, solution 9a1d4e7…
你：     可以，但可选审批要问我
agent:  和你一起起草任务：你最初描述的 bug、检查、解决方案带来的测试
agent:  Propose benchmarks/fix-auth/tasks/refresh-race.yaml to the team as a pull request?
你：     是
step:   copies the file to benchmarks/fix-auth/tasks/refresh-race.yaml in a fresh clone of the team repo
        pull request https://github.com/acme/team/pull/77 from teamai/session-to-task/benchmarks/fix-auth/refresh-race
```

拉取请求只新增一个文件：

```yaml
# benchmarks/fix-auth/tasks/refresh-race.yaml
schemaVersion: v1alpha1
title: Racing refreshes reuse a token
prompt: |
  Two refreshes that race with the same refresh token both get new tokens. Reject the second one.
  The solution may add rotateRefreshToken(token, { now }) to src/auth/refresh.ts; the check calls it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
solutionCommit: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e
check:
  run: npx vitest run test/auth/refresh-race.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
  add: ['test/auth/refresh-race.test.ts']   # the solution's own test: hidden from the agent, written in before the check
source: { platform: claude-code, sessionId: 7c1e2b9a }
```

由会话起草，因为它已经知道你问了什么、怎么做的；不用回读任何转录。从其他会话起草时（例如[从过去的会话构建套件](#从过去的会话构建套件)），agent 先用 `teamai session show` 读取那个会话的转录。`check.add` 让解决方案自带的测试不进入 trial 的 clone（见[解决方案带来的测试](#解决方案带来的测试)），prompt 写出该测试调用的函数，这样不看测试也能完成任务。

不同的会话起草不同的任务：

| 会话 | 它起草的任务 |
| --- | --- |
| 修了 bug 并新增 `test/auth/refresh-race.test.ts` | `check`，带 `add: [test/auth/refresh-race.test.ts]`，如上 |
| 修了 bug 并在 `test/auth/refresh.test.ts` 里加了一个用例 | `check`，带 `add: [test/auth/refresh.test.ts]`：文件取解决方案中的内容，含该用例 |
| 改写了登录错误信息，`test/auth/login.test.ts` 检查它，而且它仍不能透露任何账号信息 | `check` 和 `successCriteria`，如上面的 `login-copy`：测试失败时由它判定，测试通过后其余部分由评判器判定 |
| 修了一个没有测试覆盖的布局 bug | `successCriteria: "The checkout button stays visible at 320 px wide."`，由模型评判 |
| 新增 `POST /sessions/revoke-all` 及 `test/auth/revoke-all.test.ts` | `check`，带 `add: [test/auth/revoke-all.test.ts]`；prompt 写出测试调用的端点及其返回 |
| 把 token 存储移到 `TokenStore` 之后，行为不变 | `successCriteria: "Every read and write of tokens goes through TokenStore; the auth tests still pass."`：改动前测试也通过，`check` 分不出它和没有改动 |
| 只是在探索，没有提交任何东西 | 什么都不起草：你说它不是好任务，运行结束，不开拉取请求 |

### describe 提议什么

describe 为调用它的会话填好每个输入，并说明原因，没有提议值时也说明：

| 输入 | 提议 | 不提议的情况 |
| --- | --- | --- |
| `session`、`source` | 本会话及其工具 | 没有 agent 会话：所有输入都没有值 |
| `start` | session-start hook 在本会话第一次启动时记录的提交，与会话的 capture 一起保存，所以 dashboard 压缩日志后恢复的会话仍能拿到它 | 会话启动时有已跟踪文件被修改，或 teamai 没有记录启动（恢复会话不算） |
| `solution` | `HEAD` | `HEAD` 仍是 `start`、有已跟踪文件被修改，或没有 `start` |
| `suite` | `repo` 是本 checkout `origin` 的那唯一一个套件：`benchmarks/fix-auth`，在 namespace 中则如 `benchmarks/web/fix-auth` | 没有套件或有多个套件匹配 `origin` |

```text
start     HEAD         proposal
3f2c9a7   9a1d4e7      both
3f2c9a7   3f2c9a7      start only: "No value: HEAD is still the starting commit. Commit the change, then ask again, or give the commit."
3f2c9a7   9a1d4e7 *    start only: "No value: tracked files are modified. Commit the change, then ask again, or give the commit."
(none)    9a1d4e7      neither: give both
```

`solution` 是完成任务的那个提交，无论是什么工作：修复，或功能、重构的提交。任务把它记为 `solutionCommit`。当该套件已有任务来自本会话或这个提交时，`session` 或 `solution` 的 why 会写出它，例如 `benchmarks/fix-auth/tasks/refresh-race.yaml already comes from it.`，避免同一份工作被提议两次。

| 你怎样启动 | 谁回答“Propose … as a pull request?” |
| --- | --- |
| 推荐选项 | 你的 agent，并说明理由；dashboard 把它记为 agent 的回答 |
| “Same, but ask me at optional approvals” | 你 |
| “Same, but answer optional approvals automatically” | teamai 回答 yes |

这个审批是可选的，因为拉取请求无论如何都会被评审：错误的任务只多花一次评审，不会弄坏套件。没有任何东西会主动提供这个工作流；你可以直接要求，或由生成的 `teamai-session-to-task` skill 把 agent 指向它。团队文件 `workflows/teamai-session-to-task.yaml` 会取代它，describe 仍按名称为它保留的字符串输入填值。

任务在自己的分支上提议，分支名取自它的套件和 id，所以再次提出时会接着第一次运行继续：

```text
draft id       on the team repo
refresh-race   pull request 77, from teamai/session-to-task/benchmarks/fix-auth/refresh-race
refresh-race   drafted again, by you or a teammate: the same branch, and pull request 77 updated
refresh-race   after pull request 77 merged, the same bytes: nothing pushed, no pull request
../escape      not a task file name: the check step fails before any approval or clone
```

### 从过去的会话构建套件

一周的会话里，你和队友的，都有许多已完成的修复和功能。让 agent 把它们变成任务（“用这周的会话构建 benchmarks/fix-auth”），它会启动 `teamai-sessions-to-tasks`：

```console
$ teamai workflow start teamai-sessions-to-tasks --inputs '{"suite":"benchmarks/fix-auth","count":12}'
```

```text
step         does
local        teamai session list --finished --all --within 30d --suite benchmarks/fix-auth --sizes "$SIZES" --json
             → each finished session with start, solution, files, lines and size; only those whose commits are reachable
               in the suite's repo and that no task of the suite already comes from (by session or solution commit)
pushed       teamai session list --all --suite benchmarks/fix-auth --sizes "$SIZES" --json
             → the same, of the sessions the team pushed for the suite's repo, each with its teamSession and author
pick         an answer step: the AI picks representative candidates per size, up to count
draft        for_each pick, max_parallel 1: workflow teamai-session-to-task with session, source, suite, start, solution
             (and team_session, author for a pushed one); you accept, edit or skip each draft, and each accepted task is a pull request
```

`start` 是会话开始时的提交，`solution` 是它最后一次 Stop 时检出的提交：teamai 把两者记录在会话的 capture 旁边。列表会说明有多少会话被排除，以及原因：

```json
{"list":[{"session":"7c1e2b9a","source":"claude-code","ended":"2026-11-05T17:40:00Z","prompt":"Refresh tokens past…",
          "start":"3f2c9a7…","solution":"9a1d4e7…","files":2,"lines":31,"size":"S"}],
 "leftOut":[{"reason":"no recorded end","sessions":4},{"reason":"ended with tracked files modified","sessions":1}]}
```

| 排除原因 | 为什么 |
| --- | --- |
| `no recorded end` | 会话在 teamai 开始记录会话如何结束之前就结束了，不知道它的解决方案 |
| `no recorded start` | 它启动时没有记录提交，例如不在 git 中 |
| `started with tracked files modified`、`ended with tracked files modified` | 没有提交保存那个状态 |
| `ended on the commit it started at` | 什么都没有提交 |
| `a task of the suite already comes from it` | 有任务把这个会话写作 `source`，或把它的解决方案写作 `solutionCommit` |
| `commits not in the suite repo` | 按 SHA fetch 之后，套件的 `repo` 仍缺少某个提交：推送分支后再试 |

从会话贡献过经验不会让它在这里被排除。该工作流列出 30 天内活动过的会话（`--within 30d`），因为 Claude Code 默认保留会话记录 30 天；可在团队自己的工作流副本中修改。

大小取 S、M、L 中第一个行数和文件数限制都容得下这次改动的，否则为 XL。限制写在工作流里，团队在自己的文件副本中修改；命令只负责套用：

```yaml
# workflows/teamai-sessions-to-tasks.yaml (excerpt): what a team may change
inputs: { suite: string, count: number, sizes: string }
defaults:
  # The largest S, M and L solution diffs, as lines,files; anything larger is XL.
  inputs: { sizes: "S=40,3 M=200,10 L=800,30" }
```

```text
lines  files  size
31     2      S
12     4      M    4 files is more than S allows
801    1      XL   more lines than L allows
```

每份草稿和[为当前会话起草](#把会话变成任务)是同样的对话；agent 先用 `teamai session show <id> --source <platform>` 读取那个过去的会话，队友推送的会话则用 `teamai session show <id> --team-session <name> --author <member> --suite benchmarks/<suite>`。

推送会话的归档保留推送它的机器上会话启动时和最后一次 Stop 时记录的提交，所以队友的工作也能成为任务：

```console
$ teamai session list --all --suite benchmarks/fix-auth --json
{"list":[{"session":"7c1e2b9a","source":"claude-code","ended":"2026-11-05T17:40:00Z","title":"Refresh tokens past expiry",
          "teamSession":"claude-code_refresh-tokens-past-expiry_20261105","author":"ana",
          "start":"3f2c9a7…","solution":"9a1d4e7…","files":2,"lines":31}],
 "leftOut":[{"reason":"archived without recorded commits","sessions":6}]}
```

在 teamai 开始记录提交之前推送的会话，以 `archived without recorded commits` 被排除。先运行 `teamai session pull` 拿到团队最新的会话。

### 在团队仓库的 CI 中检查任务

任务的检查会运行项目的 setup 和代码，所以在 CI 中试，而不是在你的机器上。这个 job 用 [`benchmark try`](#试运行任务) 试拉取请求新增或修改的每个任务，任何一个分不清解决方案与未修改时就失败：

```yaml
# .github/workflows/benchmark-tasks.yml in the team repo
on:
  pull_request:
    paths: ['benchmarks/fix-auth/tasks/*.yaml']
jobs:
  try:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v5          # the team repo, at the pull request
        with: { path: team, fetch-depth: 0 }
      - uses: actions/checkout@v5          # the suite's repo, with every commit a task names
        with: { repository: acme/auth-service, path: project, fetch-depth: 0, token: "${{ secrets.PROJECT_READ_TOKEN }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g teamai-cli
      - name: Try each new or changed task
        working-directory: project
        shell: bash
        env: { BASE_REF: "${{ github.base_ref }}" }
        run: |
          tasks=$(git -C ../team diff --name-only --no-renames --diff-filter=AM "origin/$BASE_REF...HEAD" -- 'benchmarks/fix-auth/tasks/*.yaml')
          failed=0
          for file in $tasks; do              # task paths have no spaces
            teamai benchmark try "../team/$file" || failed=1
          done
          exit "$failed"
```

```text
task           at startingCommit   at solutionCommit   job
refresh-race   check fails  ✔      check passes ✔      passes
refresh-case   check fails  ✔      check passes ✔      passes: the solution added a case to a test file, listed in check.add
old-bug        check passes ✖      not tried           fails: "the check passes without changes at 3f2c9a7"
not-added      check fails  ✔      check fails ✖       fails: "the check fails at the solution 9a1d4e7": the solution's test is not in check.add
add-missing    not tried           not tried           fails: "check.add path test/auth/refresh-race.test.ts is not a file at the solutionCommit 9a1d4e7…": commit it, or fix solutionCommit
no-solution    check fails  ✔      not tried           passes, and says the check was not tried on a solution
```

每个任务都会被试一遍，job 在失败前列出每个失败。`git diff` 读不到基础分支时，job 直接失败，而不是什么都不试。在团队仓库的合并规则里把它设为必需，失败的任务就进不了套件。`PROJECT_READ_TOKEN` 读取套件的仓库。解决方案不在那个仓库的远端时，job 会失败并写出该提交：推送解决方案所在的分支，或把 `solutionCommit` 设为把它合入默认分支的提交，再重跑。

团队有多个仓库的套件时，每个套件对它自己的仓库试：

```yaml
# .github/workflows/benchmark-tasks.yml, one suite per matrix entry
on:
  pull_request:
    paths: ['benchmarks/**/tasks/*.yaml']
jobs:
  try:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include:
          - { suite: benchmarks/fix-auth, repository: acme/auth-service }
          - { suite: benchmarks/payments/checkout, repository: acme/checkout }
    steps:
      - uses: actions/checkout@v5
        with: { path: team, fetch-depth: 0 }
      - uses: actions/checkout@v5
        with: { repository: "${{ matrix.repository }}", path: project, fetch-depth: 0, token: "${{ secrets.PROJECT_READ_TOKEN }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g teamai-cli
      - working-directory: project
        shell: bash
        env: { BASE_REF: "${{ github.base_ref }}", SUITE: "${{ matrix.suite }}" }
        run: |
          tasks=$(git -C ../team diff --name-only --no-renames --diff-filter=AM "origin/$BASE_REF...HEAD" -- "$SUITE/tasks/*.yaml")
          failed=0
          for file in $tasks; do
            teamai benchmark try "../team/$file" || failed=1
          done
          exit "$failed"
```

拉取请求没有改动其套件的 matrix 项什么都不试，直接通过。

## 运行套件

```console
$ teamai benchmark run fix-auth --sandbox
ℹ Suite fix-auth: 54 trials (3 arms × 6 tasks × 3 repetitions), 36 judge calls, 4 calibration judge calls.
ℹ Estimated 49.4–68.7 USD, incomplete (agents 41.4–56.7, judges 8–12), from run r1c0d9e2f4a7b3c51.
  claude 0.82 · codex unknown (no cost stated) · strong 1.95 USD per trial
ℹ Run r38302f8e6a18c377 started. If it stops before it ends, continue it with: teamai workflow resume r38302f8e6a18c377
```

`benchmark run` 先规划套件，所以无法运行的套件不会留下运行。然后它用套件的 `timeout` 启动工作流 `teamai-benchmark`，在 `--driver` 指定的驱动上运行；未指定则用 [`workflows.driver`](reference.md#成员设置) 指定的驱动，都未指定则由本地驱动在本机驱动它。

运行开始前，它会打印这次运行的成本估算，依据是该套件最近一次成功的早先运行，来自本机，或来自你的检出目录上次读到的 `teamai-reports`。arm 的成本是它的 trial 数乘以那次运行中它每个 trial 成本的中位数，按名字、工具、模型、effort、team、workflow 和 role 匹配 arm，四分位数作为范围。评判的成本是被评判的 trial 数加校准调用数，乘以那次运行中评判一个 trial 或校准一次的成本的中位数。评判调用按 teamai 的 benchmark 工作流的批处理方式计数；同时有 check 和成功标准的任务，它的正确性调用和[校准](#校准评判)调用按最多可能的次数计。工具没有声明成本的 arm，或那次没有运行的 arm，显示 `unknown`，总计会注明 `incomplete`。没有这样的运行时，它打印 `No earlier run of fix-auth to estimate from.`。估算从不停止运行，也不改变退出码：要少花一些，就少运行一些 `--task` 或 `--arm`。计划会保存估算，JSON 返回在最后的 `data.done.outputs.table.estimate` 中带上它，用量表把它放在实际花费旁边，一部分如下：

```text
| Arm | Cost | Estimated |
| --- | --- | --- |
| claude | 15.4 USD (18) | 12.6–17.1 USD |
```

每个 trial 的 prompt 都以 [`permissions: unattended`](workflow-advanced.md#无人值守的-prompt) 运行，因为 teamai 自带的工作流在严格的 sandbox 中运行 trial：无论这台机器上该工具的设置如何，工具都无需询问就编辑文件和运行命令。

| 选项或配置 | 效果 |
| --- | --- |
| `--sandbox` | 为这次运行把本机声明为 sandbox，本机上的 `workflow resume` 会沿用它。只在可以丢弃的机器上使用。 |
| 配置里的 `workflows.sandbox: true` | 为每个进程声明它，见[要求和限制](workflow-advanced.md#要求和限制)。 |
| 两者都没有 | 运行在启动时以 `requirement_unmet` 被拒绝：trial 需要严格 sandbox。 |
| `--member-aliases` | 你自己的 `~/.teamai/models/aliases.yaml` 优先于团队的 `models/aliases.yaml`，表格会把由你的文件决定的模型的来源显示为 `member`。 |
| `--task <id>`、`--arm <name>` | 只运行这些任务和 arm。两者都可以重复。见[只运行部分任务和 arm](#只运行部分任务和-arm)。 |
| `--fail-on-regression` | 某个 arm 的通过率下降时也以 1 退出。见[回归时失败](#回归时失败)。 |

| `benchmark run` 退出码 | 何时 |
| --- | --- |
| 0 | 运行成功并写出了报告，无论 trial 的结果如何。 |
| 1 | 套件或启动被拒绝、运行超时或被取消，或者某个 `finally` 步骤失败或被取消：报告，或者 `--fail-on-regression` 发现下降时的 `regression` 关卡。 |

仍在等待发布的记录从不改变退出码。

| trial 得到 | |
| --- | --- |
| 起始提交的全新克隆 | 没有远程仓库。你的检出目录从不被改动。 |
| 团队资源和套件 | 来自本检出目录上次 pull 到的团队修订（该修订必须已推送），或来自 arm 的 `team`。启动时冻结：运行期间 pull 不会改变它运行的任何内容。 |
| 环境 | 去掉 `GITHUB_TOKEN`、`GH_TOKEN`、`GITLAB_TOKEN`、`GL_TOKEN`、`CI_JOB_TOKEN`、`SSH_AUTH_SOCK`、`GIT_ASKPASS` 和 `SSH_ASKPASS`：trials 步骤是[严格 sandbox](workflow-advanced.md#要求和限制)，它让 trial 的每个进程都拿不到这些变量。 |
| 你的主目录 | 保持原样：teamai 去不掉其中的登录信息、MCP 服务器和插件。 |
| 本机上的团队仓库 | 保持原样：你的团队检出目录，以及每个 trial 克隆旁边用来安装其团队资源的那份团队修订副本，都包含 `benchmarks/`，check 文件也在其中。在本机上搜索的 agent 能找到它们。 |

本地驱动按这个顺序运行每个 trial：全新克隆、团队资源、setup、用 prompt 启动 arm 的工具，然后运行 check。

- **工具**: 它能运行 `claude`、`codex` 和 `opencode`。安装 arm 用到的每个工具并登录。找不到工具的 arm，它的 trial 为 `not_run`，其他 arm 照常运行。
- **通道**: 一次一个 trial，除非套件设置了 [`parallel`](#并行通道)。
- **超时**: 套件的 `timeout` 是整个运行的超时。setup、工具和 check 到时都会停止：它们所属的 trial 记为 `error`，仍未完成的 trial 结算为 `not_run`。让它低于 CI 任务的时限，否则任务会在打印表格之前被杀掉。
- **卡住的 trial**: 没有 [`trial.timeout`](#trial-限制) 时，一个永不返回的工具会一直运行到套件超时，它之后的每个 trial 结算为 `not_run`。
- **评判**: 带 `successCriteria` 的任务和套件的评分器由运行自己的 `score` 步骤评判，它在 trial 之后、`report` 之前运行，每个评分器[对所有 arm 用同一个评判](#对所有-arm-用同一个评判)。机器上没有安装某个评分器的评判工具，或该工具不能以评分器要求的隔离级别运行它的模型时，需要评判的套件在启动时被拒绝。
- **控制命令**: trial 的步骤要等运行的 `plan` 步骤报告后才存在。在此之前，对 trial 步骤执行 `teamai workflow cancel <run> <step>` 会返回 `step_not_found`。benchmark 运行是[隔离的](workflow-advanced.md#隔离运行)：`workflow retry`、`publish` 和 `--claim` 拒绝它，`publish` 和 `--claim` 返回 `isolated_run`，retry 会给出 `teamai benchmark run <suite>`。
- **停下**: 用 `teamai workflow resume <run>` 继续，沿用启动时的 `--sandbox`。升级前的 teamai 启动的运行，如果计划的版本不同，就不能继续：`workflow resume` 会拒绝它，并指出 `teamai benchmark run <suite>`。

无法运行的启动会被拒绝，消息说明该怎么做，并且不会创建运行。你的 user 范围 teamai 安装也能到达该团队，或团队通过 HTTP 提供时，运行无法固定 trial 得到的团队，会以 `team_ref_blocked` 拒绝，并说明要改什么。

### 只运行部分任务和 arm

```console
$ teamai benchmark run fix-auth --sandbox --task expired-token --arm claude --arm strong
```

这次运行包含 `expired-token` 的基线，以及 `claude` 和 `strong` 在它上面的 trial，它的记录和表格只列出这些。之后 `--fail-on-regression` 只把它与 arm 相同的运行比较。只要套件有一次运行了全部任务和 arm 的运行，Dashboard 就绝不会把这样的运行当作套件的当前版本。套件没有的名字会在任何运行开始之前被拒绝：

```console
$ teamai benchmark run fix-auth --sandbox --task expierd-token
{"error":{"code":"invalid_arguments","message":"Suite \"fix-auth\" has no task \"expierd-token\". Its tasks: expired-token, login-copy, old-bug."}}
```

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
inputs: { suite: string, aliases: string, tasks: [string], arms: [string], fail_on_regression: boolean }
steps:
  - id: plan
    command: teamai benchmark plan "$SUITE" --aliases "$ALIASES" --tasks "$TASKS" --arms "$ARMS"
    env: { SUITE: "{{ inputs.suite }}", ALIASES: "{{ inputs.aliases }}", TASKS: "{{ inputs.tasks }}", ARMS: "{{ inputs.arms }}" }
    output: { definition: workflow, plan: json }
  - id: trials
    needs: [plan]
    workflow: { from: plan }
    requires: { isolation: sandbox, strict: true }
  # Judges every trial with the scorers as of the run's start, a criteria task's teamai:correctness:<task> included. Reading
  # trials keeps a failed trial from stopping the others being judged. Without these two steps nothing judges a trial.
  # batch: the suite's scorers that share a judge tool, model and stages share one judge call per trial; a correctness
  # scorer is always judged alone. Set it false in a workflow of this name to judge each scorer apart.
  - id: subjects
    needs: [trials]
    if: steps.trials.outcome != 'skipped'
    command: teamai score subjects --run "$RUN" --step trials
    env: { RUN: "{{ run.id }}" }
    output: { list: [string] }
  - id: score
    needs: [subjects]
    for_each: steps.subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item }}", scorers: [], label: "", batch: true, demand: named }
    timeout: 2h
    continue_on_failure: true
  # Calibrates each correctness judge against the check: the suite's calibration.rate of the trials of a task with a check
  # and success criteria whose check failed, labelled by that judge too. store: false keeps the label out of the trial's
  # verdicts: it decides nothing, and the results show it as Judge calibration. Drop these two steps to calibrate nothing.
  - id: calibration-subjects
    needs: [score]
    if: steps.score.outcome != 'skipped'
    command: teamai score subjects --calibration --run "$RUN" --step trials
    env: { RUN: "{{ run.id }}" }
    output: { list: [{ subject: string, scorer: string }] }
  - id: calibrate
    needs: [calibration-subjects]
    for_each: steps.calibration-subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item.subject }}", scorers: ["{{ item.scorer }}"], label: "", store: false, batch: false, demand: named }
    timeout: 2h
    continue_on_failure: true
finally:
  - id: report
    command: teamai benchmark report
    env: { COMPARE: "{{ inputs.fail_on_regression }}" }
    output: { text: string, table: json, regression: dropped | held | no_comparable | off }
  - id: regression
    needs: [report]
    if: steps.report.outputs.regression == 'dropped'
    command: exit 1
outputs: { text: steps.report.outputs.text, table: steps.report.outputs.table }
```

| 命令 | 作为 | 作用 |
| --- | --- | --- |
| `teamai benchmark plan <suite>` | `plan` 步骤 | 冻结你 pull 到的团队修订，获取 trial 读取的每个提交，并把 trial 打印成一个工作流，每个基线和 trial 一个克隆。 |
| `teamai benchmark check --baseline\|--trial` | 每个克隆中的一个步骤 | 写入 `check.add`，对 trial 恢复 `protect`，运行任务的 check，并打印 `{ result, cause, label }`。trial 的 check 还会保存该 trial 的正确性标签，见[谁判定一个 trial](#谁判定一个-trial)。 |
| `teamai score subjects --run <run> --step trials` | `subjects` 步骤 | 列出 trial 在本机结算的、需要评分的执行轮次。 |
| [`teamai-score`](scorers.md#teamai-score-工作流) | `score` 步骤，每个 subject 一次 | 用运行开始时的评分器评判 trial。 |
| `teamai score subjects --calibration --run <run> --step trials` | `calibration-subjects` 步骤 | 列出用来[校准评判](#校准评判)的 trial，每个带它的正确性评分器。 |
| [`teamai-score`](scorers.md#teamai-score-工作流)，带 `store: false` | `calibrate` 步骤，每个列出的 trial 一次 | 用正确性评分器给 trial 打标签，不保存任何东西。 |
| `teamai benchmark report` | `report` 这个 `finally` 步骤 | 给 trial 分类，写出记录，并打印结果。`COMPARE=true` 时还会比较记录，见[回归时失败](#回归时失败)。 |

`trials` 运行 `plan` 打印的内容：见[运行步骤打印的工作流](workflow-advanced.md#运行步骤打印的工作流)。`report` 在 trial 之后运行，无论它们发生了什么，就像 [finally 步骤](workflow-advanced.md#finally-步骤)那样。`benchmark run --member-aliases` 把 `aliases` 传为 `member`，否则传为 `team`。`--task` 和 `--arm` 传入 `tasks` 和 `arms`，否则传 `[]`，即规划所有任务和 arm。`--fail-on-regression` 把 `fail_on_regression` 传为 `true`，否则传为 `false`。`report` 从运行文件中 `score` 步骤的结果读取每个 trial 的标签，因为 `finally` 步骤不能读取 `steps`。

要修改它，推送你自己的 `workflows/teamai-benchmark.yaml`，或者为某个角色或项目的成员推送 `workflows/<namespace>/teamai-benchmark.yaml`。它会为接收它的人替换 teamai 的版本，就像任何[默认工作流](workflow.md#覆盖默认工作流)一样，`benchmark run` 会说明这一点：

```text
ℹ Running the team's workflows/ops/teamai-benchmark.yaml, which replaces teamai's benchmark workflow.
```

你的版本必须接受输入 `suite`，要用 `--member-aliases` 运行还必须接受输入 `aliases`，要用 `--task` 和 `--arm` 运行还必须接受输入 `tasks` 和 `arms`，要用 `--fail-on-regression` 运行还必须接受输入 `fail_on_regression`；否则 `benchmark run` 会拒绝它，并指出缺少的输入。保留 `plan` 的步骤 id，并把 `report` 保留为 `finally` 步骤。去掉 `strict: true` 会让 trial 在不扣留凭据的情况下运行，并且使用各工具自己的权限设置，而不是无人值守：不能编辑的工具会让它的 trial 失败，报告的第一行会说明这一点。你接收的两个命名空间都有 `teamai-benchmark.yaml` 时，`benchmark run` 以 `workflow_namespace_conflict` 拒绝，并指出两个文件，绝不退回 teamai 自带的版本。

你可以修改 `score` 的 `timeout`，去掉 `calibration-subjects` 和 `calibrate` 以不[校准](#校准评判)任何评判，或者把这两个和 `subjects`、`score` 一起去掉，不经评判地运行。这样一来，每个本该由评判决定的 trial 都以 `unscored` 结束：

```yaml fragment
# workflows/teamai-benchmark.yaml：只运行 trial，从不评判
steps:
  # plan，同 teamai 的
  - id: trials
    needs: [plan]
    workflow: { from: plan }
    requires: { isolation: sandbox, strict: true }
  # 没有 subjects、score、calibration-subjects 和 calibrate 步骤
finally:
  # report 和 regression，同 teamai 的
```

## 结果

运行结束时，`benchmark run` 把结果打印到 stderr。stdout 上的 JSON 返回在 `data.done.outputs.text` 中带同样的文本，在 `data.done.outputs.table` 中带数字，其中 `verdicts` 给出每个 trial 在每个评分器下的结论，正确性评分器排在最前：`labelled` 带它的标签和分数，或 `unscored` 带 `because`，即评判的失败码、`check_could_not_run`，运行中没有驱动提供评判工具时为 `judge_tool_unavailable`，没有标签时为 `run_ended`。对这个套件，再加一个 check 本来就通过的第三个任务 `old-bug`：

```text
| Arm | Tool | Model (source) | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude | claude | tool default (team) | 9 | 4 | 2 | 0 | 0 | 3 | 0 | 0 | 0 | 44% (4/9) |
| codex | codex | tool default (team) | 9 | 3 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 33% (3/9) |
| strong | claude | claude-opus-5-5 high (team) | 9 | 6 | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 67% (6/9) |

| Arm | Median tokens (input + output) | Median duration | Cost | Cost per passed trial | Against claude (defaults arm) |
| --- | --- | --- | --- | --- | --- |
| claude | 41200 (6) | 84.0 s (6) | 1.82 USD (6) | 0.455 USD |  |
| codex | 38900 (6) | 97.5 s (6) | unknown (0) | — | -11 pp (-36 to +16, not separated) |
| strong | 52300 (6) | 121.0 s (6) | 4.1 USD (6) | 0.6833 USD | +22 pp (-11 to +48, not separated) |

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
| Arm | 按结果统计每个 arm 的 trial，以及被 [trial 限制](#trial-限制)停止的数量。偏差是 prompt 运行时的工具、团队修订、模型或角色与其 arm 不同的 trial，其 driver 无法执行某个 trial 限制的 trial，或者由[计划](#对所有-arm-用同一个评判)以外的评判打标签的 trial。记录缺少其中某个值，或缺少其评判的模型的 trial 为未验证。有 arm 使用 pull 到的修订以外的团队资源时，Team 列显示每个 arm 的团队资源，例如 `pulled 3f9c2ab`、`next 81d0e4c`、`3f9c2ab without skills/auth-tokens` 或 `none`。有 arm [以角色运行](#以角色运行的-arm)时，Role 列显示每个 arm 的角色，或 `member's roles`。正确性评分标准有两个以上标签时，通过率后面还有 Mean correctness score 列，见[正确性评分标准](#正确性评分标准)。 |
| 用量 | 每个 arm 的中位数和成本合计，并注明各自用了多少个 trial。token 和成本只按工具自己声明的显示，所以不声明的工具显示 `unknown (0)`。如果一个 trial 的各次 pass 没有全部声明 token（输入和输出）、成本或时长，它在这一项上按没有声明处理，并让成本合计显示 `incomplete`。Cost per passed trial 是 arm 的成本合计除以它通过的 trial 数，与 dashboard 一致：没有通过的 trial 或合计不在同一单位时显示 `—`，合计为 `incomplete` 时标为 `incomplete`。Against 把每个 arm 与默认 arm 对比，见[每个通过 trial 的成本](#每个通过-trial-的成本)。有早先运行可供估算时，Cost 旁边的 Estimated 列是启动时[估算](#运行套件)的每个 arm 的成本。 |
| 任务 | 每个任务在每个 arm 上的通过率。 |
| 评分器 | 仅当套件或某个任务列出评分器时出现：每个 arm 在每个评分器上的通过率，见[每个评分器的通过率](#每个评分器的通过率)。 |
| 评判校准 | 仅当套件设置了[校准比例](#校准评判)时出现：正确性评判让多少 check 失败的工作通过。 |
| 基线 | 没有运行的任务及原因。 |
| Skill | 仅当某个 arm 改变团队 skill 时出现：它新增、去掉或改变的每个 skill，以及该 arm 的 trial 中有多少加载了它，与什么都不改变的 arm 并列。 |
| 资源效果 | 仅当某个任务覆盖一个团队仓库路径时出现：每个被覆盖资源一张表，见[资源效果](#资源效果)。 |

```text
| Arm | Skill | Change | Loaded in this arm | Loaded in the defaults arm |
| --- | --- | --- | --- | --- |
| no-auth-tokens | auth-tokens | removed | 0/3 | 2/3, 1 unknown |
```

只有 teamai 能看到的加载才计数：`unknown` 是其工具不报告 skill 加载的 trial，而不是没有加载该 skill 的 trial。

### 每个通过 trial 的成本

用量表把每个 arm 与默认 arm 对比。默认 arm 是不改变任何 `defaults` 键的 arm；每个 arm 都改变某个键时，与第一个 arm 对比。再加一个 arm `cheap`，它和 `claude` 一样通过九个 trial 中的八个，但成本更低，用量表的一部分：

```text
| Arm | Cost | Cost per passed trial | Against claude (defaults arm) |
| --- | --- | --- | --- |
| claude | 7.2 USD (9) | 0.9 USD |  |
| cheap | 3.2 USD (9) | 0.4 USD | dominates: same pass rate, 56% cheaper per passed trial; 0 pp (-30 to +30, not separated) |
| codex | unknown (0) | — | -22 pp (-54 to +14, not separated) |
```

一个 arm 每个通过 trial 的成本更低、通过率至少一样高时，它 dominates 默认 arm；默认 arm 对它做到这一点时，它是 dominated。成本为 `incomplete`、未知或单位不同时，两者都不标。两个 arm 通过率的配对差值及其 95% 区间总会显示，按[回归门禁](#回归时失败)会比较的那些配对计算，区间跨过零时标 `not separated`，被排除的配对写在后面，例如 `2 excluded: their judge changed (…)`。dominance 看的是通过率的点估计，并不证明两者相当：这里九个 trial 不能排除最多 30 个百分点的下降。这些标记不改变退出码，也不影响回归门禁。

### 谁判定一个 trial

只有 trial 的 `teamai:correctness:<task>` 标签决定 `passed`、`failed` 或 `unscored`。`error` 和 `not_run` 来自 trial 工作的状态。对带 `check` 的任务，check 步骤在 prompt 之后立即在 trial 的克隆中自己写下这个标签，不运行任何评判。任务还带 `successCriteria` 时，通过的 check 不写标签，由评判器按 prompt 留下的工作判定，不包括 check 恢复的 `protect` 路径和它写入的 `check.add` 文件。标签和运行的其他标签一起保存在本机上，并且和隔离运行的所有标签一样，从不发布：

```json
{"source":"workflow","scorer":"teamai:correctness:expired-token","rubric":{"sourceHash":"…"},
 "label":"correct","score":1,"passed":true,"judge":{"kind":"stage"},"decidedBy":"check",
 "subject":{"runId":"r38302f8e6a18c377","step":"trials.r1.expired-token.claude.prompt","pass":1},
 "scoredAt":"2026-11-08T10:12:03Z"}
```

| check | 标签 | trial 结果 |
| --- | --- | --- |
| 以 0 退出 | 分数不低于 `passingScore` 的标签中分数最高的那个 | `passed` |
| 以 0 退出，任务带 `successCriteria` | 无：由评判器给 trial 打标签 | 评判器给出的结果 |
| 以非 0 退出 | 分数最低的标签 | `failed` |
| 无法运行 | 无 | `error`，`failure: { cause }` |

`cause` 是 `not_found`、`not_executable`、`signal`、`timeout`、`spawn_failed`、`prepare_failed`（恢复 `protect` 或写入 `check.add` 失败）之一。

每个记录下来的 trial 都带着它的结论：

```json
"verdicts": [
  { "scorer": "teamai:correctness:expired-token", "outcome": { "kind": "labelled", "label": "correct", "score": 1, "passed": true },
    "decider": { "by": "check", "task": "<task sourceHash>" } },
  { "scorer": "review-quality", "outcome": { "kind": "labelled", "label": "good", "score": 1, "passed": true },
    "decider": { "by": "judge", "rubric": "<rubric sourceHash>", "tool": "claude", "model": "claude-opus-5-5", "effort": "high", "batched": true },
    "asPlanned": "match" }
]
```

`decider.batched` 是标签的 `judge.batched`。`decider.model` 是评判工具报告的模型，没有报告时是启动它时用的模型；别名不属于它。`asPlanned` 把评判给出的标签与计划为该评分器固定的评判相比较。

### 正确性评分标准

每个 `teamai:correctness:<task>` 都是 teamai 的[默认评分器](scorers.md#默认评分器) `scorers/teamai-correctness.md`，填入任务的 `prompt` 和 `successCriteria`（只有 `check` 的任务填空字符串）：

```markdown
---
labels:
  - { value: correct, score: 1, description: The change meets every success criterion. }
  - { value: incorrect, score: 0, description: The change misses at least one success criterion. }
passingScore: 1
samplingRate: 100
---
Judge whether the change made from the starting commit, commits included, meets the success criteria.
Read the task to understand the intent, then the diff. Do not read the transcript. Decide only on the success criteria.

## Task

{{ task.prompt }}

## Success criteria

{{ task.successCriteria }}
```

团队用一个同名文件替换它，例如用团队便宜的模型别名评判，并加一个部分完成的标签：

```markdown
---
labels:
  - { value: correct, score: 1, description: Meets every criterion. }
  - { value: partial, score: 0.5, description: Meets the main criterion only. }
  - { value: incorrect, score: 0, description: Misses the main criterion. }
passingScore: 1
samplingRate: 100
model: fast
---
…the team's wording, reading {{ task.prompt }} and {{ task.successCriteria }}…
```

start 从本检出拉取的团队修订读取这个文件，并用它评判每个 arm，不管 arm 的 `team` 是什么。它的 `model` 和 `tool` 像[任何评分器](#对所有-arm-用同一个评判)的一样固定评判：这里每个 arm 都由 claude 用别名 `fast` 评判。它的标签至少要有一个通过、一个不通过，check 按上表在其中挑选：通过的 check 写 `correct`，失败的写 `incorrect`。新的评分标准就是新的评分标准哈希，所以[回归门禁](#回归时失败)不会把它之前评判的 trial 和之后评判的配对。

有两个以上标签时，Arm 表多出 Mean correctness score 列：每个 arm 有标签的正确性结论的平均分，check 写下的也算在内。用上面的评分标准时，部分如下：

```text
| Arm | Pass rate | Mean correctness score |
| --- | --- | --- |
| claude | 44% (4/9) | 0.67 |
| codex | 44% (4/9) | 0.50 |
```

两个 arm 都在九个 trial 中通过四个，但 claude 其余的 trial 中 `partial` 更多。没有任何有标签的正确性结论的 arm 显示 `-`。回归门禁仍然只读取通过率。

### 对所有 arm 用同一个评判

一个评分器用同一个工具和同一个模型评判所有 arm 的 trial，因此它的通过率比较的是 arm，而不是各自的评判。启动时按评分器固定：评分器的 `tool`，没有时用套件的 `defaults.tool`；以及评分器原样写的 `model`，别名仍是别名（`""` 表示工具的默认模型）。计划把它们冻结为 `judges`，记录也保留它们。例如：

```yaml
# models/aliases.yaml
aliases:
  judge:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
```

```yaml
# benchmarks/fix-auth/suite.yaml 的一部分
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
scorers: [review-quality]          # scorers/review-quality.md 设置了 model: judge，没有设置 tool
```

| Trial · 评分器 | 评判 |
| --- | --- |
| login-copy · claude · review-quality | claude, opus, high |
| login-copy · codex · review-quality | claude, opus, high |
| login-copy · claude · correctness | claude，它的默认模型 |
| login-copy · codex · correctness | claude，它的默认模型 |

别名在运行的团队修订中没有该工具的模型时，启动以 `judge_model_unavailable` 拒绝该套件。每次评判调用都只在这个工具上运行，评分器的标签记下实际运行的是什么：

| 情况 | 结果 |
| --- | --- |
| 驱动不提供该工具 | 评判步骤被扣住，`wait.held[].missing: ['confined']`；不会由其他工具评判。 |
| 运行中没有驱动提供它，skill 驱动放弃了这个评判 | 结论为 `unscored`，`because` 为 `judge_tool_unavailable`，结果中会写出该工具。 |
| 标签写的工具与计划不同，或 `model.alias` 不同（计划的模型不是别名时比较 `model.requested`） | 该 trial 计入 Deviations；`asPlanned` 为 `deviation`。 |
| 标签没有 `model.reported` | 该 trial 计入 Not verified；`asPlanned` 为 `not_verified`。 |
| 两台机器把别名解析成了不同的模型 | 不算偏差。 |
| 各 arm 的 `tool` 不同，且评判工具是其中之一 | 结果中写出 `Judge claude is also arm claude's tool; set tool in the scorer to judge with another.` |

套件中工具、模型和阶段都相同的评分器，每个 trial 共用一次评判调用。正确性评分器总是单独评判，所以决定 trial 的标签从不与别的评分器共用一个回答。

### 每个评分器的通过率

套件或某个任务列出评分器时，结果按 trial 的结论为每个 arm 的每个评分器加一行。正确性评分器没有这一行：它的标签就是 arm 的通过率。对于

```yaml
# benchmarks/fix-auth/suite.yaml 的一部分
scorers: [review-quality, test-coverage]
```

```text
| Arm | Scorer | Passed | Labelled | Unscored | Pass rate | 95% interval | Batched |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | review-quality | 5 | 9 | 0 | 56% (5/9) | 27% to 81% | yes |
| claude | test-coverage | 3 | 8 | 1 | 38% (3/8) | 14% to 69% | yes |
```

通过率及其 95% 区间（与 Arm 表相同的 Wilson 区间）只计入有标签的结论。没有标签的结论计入 Unscored，没有运行的 trial 两边都不计。Batched 说明评判是否[批量](scorers.md#批量评审)打出这些标签：`yes`、`no`，部分是部分不是时为 `mixed`，因为批量打出的标签与同一评分器在真实会话上单独评判不是同一种测量。这些评分器从不改变 trial 的结果，[回归门禁](#回归时失败)也不读取它们。

[任务的评分器](#每个任务的评分器)只计入它评判过的 trial。`session-fixation` 运行三次时：

```text
| Arm | Scorer | Passed | Labelled | Unscored | Pass rate | 95% interval | Batched |
| --- | --- | --- | --- | --- | --- | --- | --- |
| claude | review-quality | 5 | 9 | 0 | 56% (5/9) | 27% to 81% | yes |
| claude | security-review | 2 | 3 | 0 | 67% (2/3) | 21% to 94% | yes |
```

`security-review` 只评判 `session-fixation` 的三个 trial，所以不会在其他任务上花评判调用，其他任务也不会稀释它的通过率。

### 校准评判

评判决定的每个通过率，都建立在评判正确的前提上。同时有 `check` 和 `successCriteria` 的任务能看出评判何时出错：它的 check 经过基线验证，说明工作没有完成，所以把这样的工作标为 `correct` 的评判就错了。设置一个比例，让正确性评判也给其中一部分 trial 打标签：

```yaml
# benchmarks/fix-auth/suite.yaml 的一部分
calibration: { rate: 20 }     # 混合任务中 check 失败、也交给评判打标签的 trial 百分比；默认 0
```

运行 id 和 trial 步骤的哈希落在比例之内时，这个 trial 被抽中，所以恢复的运行抽中同样的 trial。[benchmark 工作流](#benchmark-工作流)的 `calibrate` 步骤用 `store: false` 让它的 `teamai:correctness:<task>` 评分器打标签，由[计划的评判](#对所有-arm-用同一个评判)评判：不保存标签，trial 仍是 check 决定的 `failed`，这个标签不与其他 trial 配对，也不会进入[回归门禁](#回归时失败)。记录把它保存在 trial 上：

```json
"calibration": { "label": "correct", "passed": true,
  "decider": { "by": "judge", "rubric": "<rubric sourceHash>", "tool": "claude", "model": "claude-haiku-4-5", "batched": false } }
```

结果为每个评判加一行，按它报告的工具、模型和 effort 区分。一次运行用[同一个评判](#对所有-arm-用同一个评判)评判所有 trial，所以要衡量更便宜的评判，就把它的别名设为你的 [`scorers/teamai-correctness.md`](#正确性评分标准) 的 `model`，再运行一次套件。两次这样的运行得到的行：

```text
Judge calibration · teamai:correctness

| Judge | Judged with a failed check | Labelled passing | False pass rate | 95% interval |
| --- | --- | --- | --- | --- |
| claude claude-opus-5-5 high | 10 | 0 | 0% | 0% to 28% |
| claude claude-haiku-4-5 | 10 | 3 | 30% | 11% to 60% |
```

可以这样读：便宜的评判让大约三分之一测试失败的工作通过；无论它省多少，都不适合作为这个套件正确性的 `model`。check 通过的 trial 得到通过标签，既不算对也不算错，因为成功标准可能比测试要求更多。

### 资源效果

任务的 `covers` 写明该任务的工作预期需要哪些团队仓库路径，结果按每个被覆盖的路径回答：一个恰好 [`without`](#去掉团队资源) 该路径的 arm，在覆盖它的任务上是不是通过得更少——并且在其他任务上没有更差。设有一个 skill `auth-tokens`、一条规则 `rules/auth.md`，两个任务都覆盖，一个任务都不覆盖：

```yaml
# benchmarks/fix-auth/tasks/refresh-race.yaml
schemaVersion: v1alpha1
title: Close the refresh token race
prompt: |
  Two refreshes of one token can race; the loser revokes the winner's session. Fix it.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
check:
  run: npx vitest run test/auth/refresh.test.ts
  protect: ['test/**', 'vitest.config.ts', 'package.json', 'package-lock.json']
covers: [skills/auth-tokens, rules/auth.md]
```

运行的结果随之为每个被某个 arm 去掉的覆盖资源附一张表：

```text
Resource effect · skills/auth-tokens · no-auth-tokens -> pulled · claude

task   covers   passed without   passed with   loaded with
expired-token   yes   1/3   3/3   3/3 fit
refresh-race   yes   0/3   2/3   2/3 fit, 1 missed
login-copy   no   3/3   3/3   1/3 extra, 2 idle

tasks that cover it   +67 pp   1/6 -> 5/6   95% +11 to +86 pp
other tasks   0 pp   3/3 -> 3/3   not separated
passed when loaded 6/6 · passed when not loaded 2/3
```

这样读：

- skill 在 `expired-token` 上有用，而且每次都加载了：它在那里有效。
- 在 `refresh-race` 上它加载了两次、任务通过了两次；没加载的那一次也没通过，`missed` 计数点名了它。一个覆盖该 skill、每次都加载、却没有变化的任务说的是相反的事：description 触达了任务，正文没有帮助。
- `login-copy` 没有变差，尽管 skill 在不需要它的地方加载了一次。

`loaded with` 用的是[路由](scorers.md#skill-路由)打分器在已结束会话上读的值，只是改由任务而非评判器判定：`fit` 加载了且任务覆盖它，`missed` 没加载但任务覆盖它，`extra` 加载了但任务不覆盖它，`idle` 没加载也不覆盖，`unknown` 是工具不报告 skill 加载——`unknown` 的 trial 仍计入通过率，但不计入"加载时"或"未加载时"。只有 skill 有这一列：teamai 只观察 skill 加载，规则、`claudemd/` 文件、文档或整个命名空间目录都读作 `not observed`。在 dashboard 的[基准测试页面](dashboard.md#基准测试benchmarks)，Compare 页签在配对之下显示这些表（没有可比的两个 arm 时单独显示），skill 还会链接到它在真实会话上的 `teamai:routing:...` 计数。

只有两边由同一方判定时，一对 trial 才计入，规则见[回归时失败](#回归时失败)。因此，如果一次运行中评判器对某些 trial 报告了另一个模型，表格会说明它排除了什么：`2 comparable pairs; 1 excluded: their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5)`。

`not separated` 是一个答案，不是失败：配对差异的 95% 区间穿过零，这些 trial 无法把差异与偶然区分开。一条规则通常只影响少数任务——增加覆盖它的任务或重复次数，直到区间离开零。去掉多个路径的 arm 没有单资源表：它的差异属于整个集合，Compare 已经显示。`plan` 会拒绝没有任何 arm 收到的覆盖路径（每个 arm 按其团队修订、role 以及去掉的路径来读），以及两个同名的覆盖 skill 路径，因为 trial 的加载记录只有裸名。

结果不是运行的状态：所有 trial 都失败的运行仍然成功。运行只在超时或被取消时失败。

`report` 把运行的 benchmark 记录写到本机上该运行的目录中。[使用统计上报](reporting.md)开启时，它还会把记录发布到团队仓库 `teamai-reports` 分支的 `benchmarks/runs/<run>.json`，所以任务的 token 还需要团队仓库的推送权限。发布失败的记录会在队列中等待，并在下一次 `teamai pull` 时重试；在此之前，文本以 `record: pending` 结尾。[运行记录](workflow.md#运行记录)列出记录的字段，并给出只从记录算出每个 arm 通过率的 `jq` 命令。记录带有 `schemaVersion`。更早的 teamai 写下的记录仍会显示在 Dashboard 上，但 Dashboard 只合并、`--fail-on-regression` 只比较记录版本相同的运行。关闭时，结果仍在返回中。Dashboard 的[基准测试页面](dashboard.md#基准测试benchmarks)按时间画出已发布的运行和本机的运行。

## 回归时失败

```console
$ teamai benchmark run fix-auth --sandbox --fail-on-regression > done.json
Arm "claude" passed 4/9 paired trials, against 8/9 in run r1c0d9e2f4b6a8c7d: a drop of 44 points, with a 95% interval of -73 to -16 points.
$ echo $?
1
$ jq -c .data.done.finally done.json
[{"id":"regression","outcome":"failed"}]
```

`--fail-on-regression` 把这次运行与该套件最新的一次更早的运行比较，那次运行必须已成功、已发布在 `teamai-reports` 上，arm 相同，并且记录版本相同。名字、工具、模型、effort、工作流和团队处理方式都相同的 arm 就是同一个 arm，无论它 pull 到的是哪个修订。trial 按任务和重复次数配对，只有两边由同一方判定时这一对才计入，就像 Dashboard 的 Compare 那样配对。第一条匹配的规则决定：

| # | 配对 | 是否比较 |
| --- | --- | --- |
| 1 | 两次运行之间任务文件改动了 | 否 |
| 2 | 两边都由评判器判定，且它的评分标准、工具、模型、effort 或是否批量评判不同 | 否 |
| 3 | 其他情况：两边都由 check 判定、一边由 check 一边由评判器判定（同时有 check 和 `successCriteria` 的任务，其 check 结果翻转了：这是 agent 的变化）、同一个评判器，或某一边是 `error`、`not_run` 或 `unscored`（算作未通过） | 是 |

某个 arm 在它参与比较的配对上通过率下降超出偶然范围时，这个 arm 就算下降了；没有任何可比较配对的 arm 不会下降。文本会说明每个 arm 比较了多少对、排除了多少对以及原因。两次运行之间评判器的模型变了时，没有任何配对可比较：

```text
run rA (Mon)   judge claude, alias judge → claude-opus-5-5     8/9 passed
   (a member's models/aliases.yaml maps judge to another model on the judging machine)
run rB (Tue)   judge claude, alias judge → claude-sonnet-5-5   4/9 passed
Arm claude: 0 comparable pairs against run rA; 9 excluded: their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5).
No arm has a comparable pair against run rA, so --fail-on-regression has nothing to compare with.
```

仍在本机等待的记录不参与比较。

| `report` 的输出 `regression` | 何时 | `regression` 步骤 |
| --- | --- | --- |
| `dropped` | 有 arm 下降。文本会像上面那样逐个指出。 | 运行 `exit 1` 并失败：`benchmark run` 以 1 退出。 |
| `held` | 没有 arm 下降。文本指出用来比较的那次运行。 | 跳过。 |
| `no_comparable` | 没有这样的运行，或者那次运行中没有任何 arm 有可比较的配对。文本会指出它尝试比较的运行（如果有），以及每对被排除的原因。 | 跳过。 |
| `off` | `fail_on_regression` 为 `false`：没有比较任何东西。 | 跳过。 |

这个关卡是运行的一个步骤，所以无论谁启动了运行，运行的驱动都会在这里结束它。teamai 的 `teamai-benchmark` 是 `invoke: deny`，所以要用 `--driver local` 启动它：用 `--driver skill` 启动会得到 `invoke_denied`，除非团队的副本设了 `invoke: allow`。用 `"fail_on_regression":true` 执行 `workflow start teamai-benchmark` 会运行同一个关卡。它的退出码跟随运行的结果，而 `finally` 步骤不会改变这个结果，所以要读取 `done.finally`。

这个关卡由团队修改。要在下降时只警告而不让任务失败，替换 `regression` 步骤，其余保持与 teamai 的相同：

```yaml
# workflows/teamai-benchmark.yaml：下降只在 CI 日志中警告，任务仍然通过
finally:
  # report，与 teamai 的相同
  - id: regression
    needs: [report]
    if: steps.report.outputs.regression == 'dropped'
    command: echo "::warning title=Benchmark regression::$TEXT"
    env: { TEXT: "{{ steps.report.outputs.text }}" }
```

要把评分器反复判定的失败变成一个修改团队资源、每个失败加一个回归任务的 PR，并在每个工具上对比改动前后，见[自我改进](self-improvement.md)。

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
teamai workflow start teamai-benchmark --inputs '{"suite":"fix-auth","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false}' --timeout 45m
teamai workflow next <run> --prepare --json '{"driver":{..., "can":{"workspace":["read-only","new","continue","clone"],"isolation":"sandbox","env":true,"setup":true,"tools":["claude"],"unattended":true,"end_turn":true}}}'
  -> a command lease (plan, check, report): run lease.command in lease.cwd, or in your checkout without one, with TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>
  -> a prompt lease: launch lease.tool in lease.cwd on lease.prompt, with lease.model, in its unattended mode for lease.permissions, held to lease.limits
teamai workflow report <run> --json '{..., "tool":"claude", "durationMs":84000, "cost":{"amount":0.31,"unit":"USD"}}'
```

- **`driver.can`**: 每次 `next` 都带：`workspace` 中的 `clone`、`isolation: "sandbox"`、`env: true`、`setup: true`、`tools` 中列出各 arm 的工具、`unattended: true`，以及在租约的限制处结束一轮时带 `end_turn: true`。驱动缺少其中任何一项时，trial 会被扣住，`wait.held[].missing` 会指明缺的是哪项。
- **`--prepare`**: teamai 在本机创建每个克隆、安装其团队资源并运行 setup，然后返回带 `cwd` 的租约。
- **每个进程**: 运行时不带 `lease.envScope.withhold` 中的名字，带 `lease.env` 和 `TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>`，所以从中调用的 `teamai` 不会改变任何运行。命令步骤把它的输出以 JSON 打印到 stdout；把它们作为 `outputs` 报告。
- **`report`**: 对 prompt：`tool`、只围绕工具启动测得的 `durationMs`，以及仅在工具给出时才带的 `cost`。
- **限制**: 让工具遵守 `lease.limits`。某个限制停止了工具时，报告 `outcome: "success"` 并带 `limit`：`timeout`、`budget` 或 `max_turns`；无法让工具遵守的 `budget` 或 `max_turns` 列在 `unenforced` 中。
- **超时**: `benchmark run` 把套件的 `timeout` 作为 `--timeout` 传入；直接执行 `workflow start teamai-benchmark` 时也必须传入它，否则 `plan` 会失败。
- **评判**: trial 的评判是某个 `teamai-score` 运行中的一个步骤，像其他步骤一样被租出，并在[计划固定的那个工具](#对所有-arm-用同一个评判)上[限制在一个目录中](workflow-advanced.md#在自己的驱动里运行受限步骤)：在 `can.confined` 中提供它，否则该步骤会等待，`wait.held[].missing` 指出 `confined`。运行 `lease.confined.tools` 中的一个，并把它作为 `tool` 报告。
