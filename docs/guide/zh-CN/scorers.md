# 评分器

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

评分器（scorer）是评审者用来评判工作流步骤成果或已结束的 agent 会话的评分标准。它是团队仓库里的 Markdown 文件 `scorers/<name>.md`。

`scorers/review-quality.md`：

```markdown
---
labels:
  - value: good
    score: 1
    description: The change does what the step asked, with tests.
  - value: partial
    score: 0.5
    description: The change works but misses part of the request.
  - value: bad
    score: 0
    description: The change does not do what the step asked.
passingScore: 1
samplingRate: 25
---
Judge whether the change does what the step asked. Read the diff and the session.
```

| 字段 | 含义 |
|---|---|
| `labels` | 2 到 20 个 `{ value, score, description }`。至少一个分数不低于 `passingScore`，至少一个低于它。 |
| `passingScore` | 标签分数不低于它即为通过。 |
| `samplingRate`、`model`、`isolation` | 可选。被评判的步骤执行比例，0 到 100，默认 25。评审者的模型：团队[模型别名](sharing.md#模型别名)，按评审工具分别解析；或模型名，原样交给第一个评审工具。默认用工具自己的模型。`verified` 或 `best-effort`。 |
| `sessions` | 可选。`true`：评分器也评判[已结束的会话](#已结束的会话)。 |
| `tool` | 可选。优先使用的评审工具，例如 `codex`。租用评审步骤的驱动提供它时由它评审；否则用被评判工作所用的工具，再否则用驱动的第一个工具。teamai 不认识的名称只给出警告，不会被拒绝。 |
| `stages` | 可选。哪些[阶段](#为交付的工作评分)可以在评审者之前为该评分器做出判定：`check`、`ci`、`protected` 中的若干个。默认三个都用。 |

frontmatter 之后的文本是评审者的提示词。`teamai pull` 缓存有效的评分器（`teamai status` 会列出它们），并对其余文件给出警告。`teamai review --branch` 遇到格式错误的评分器、分支的 `models/aliases.yaml` 没有为任何工具映射的模型别名、`scorers/` 里除 `<name>.md`、`<namespace>/<name>.md`、`scoring.yaml` 和 `README.md` 以外的文件、含有它不认识的键或值的 `scoring.yaml`，或其中任何文件含有凭据或内网地址时会失败，与规则的检查相同。

`scorers/ops/review-quality.md` 属于 `ops` 命名空间。成员的角色或项目列出它时才会拿到：

```yaml
# manifest/roles.yaml
roles:
  - id: ops
    resources: { knowledge: [], skills: [], scorers: [ops] }
```

它会替换根目录下同名的评分器。同一个名字出现在两个生效的命名空间里会报错。没有任何角色或项目列出的 `scorers/<dir>/` 是共享的：所有成员都会拿到其中的评分器，与根目录评分器同名时报错。没有角色也没有项目的团队会拿到所有命名空间。

## 选择评审者的模型

```yaml
# scorers/review-quality.md 的 frontmatter 中
model: fast
```

```yaml
# models/aliases.yaml
aliases:
  fast:
    claude: haiku
```

评审工具按顺序尝试，第一个条目给出模型的工具负责评审。没有工具给出模型时，其 teamai-score 运行的评审步骤会等待工具能运行该模型的 driver；`teamai doctor` 会对该评分器给出警告。成员为该工具写的 `~` 条目让它使用工具默认模型。启用的 `teamai models switch` 也一样，但 Claude 会保留 `opus`、`sonnet` 或 `haiku`，经切换路由；切换还会丢弃别名的 effort。CodeBuddy 评审者不使用别名的 effort。

每个标签记录由谁评审：

```json
"judge":{"kind":"model","tool":"claude","model":{"requested":"haiku","reported":"claude-haiku-4-5","alias":"fast"},"isolation":"verified","access":"read"}
```

`requested` 是评审者启动时使用的模型；对 driver 自己的评审者，是它报告评审步骤时在 `confined.model` 中给出的模型。`reported` 是工具报告的模型。工具默认模型评审时 `alias` 仍会保留。别名设置了 effort 时还会有 `"effort":{"requested":"low"}`。

## 为步骤评分

```yaml
# workflows/review-and-fix.yaml
schemaVersion: v1alpha1
name: review-and-fix
description: Review the change, judged by review-quality.
steps:
  - id: review
    prompt: Review the change.
    scorers: [review-quality]
```

没有有效 `scorers/<name>.md` 的名字会让 `teamai review --branch` 失败；`teamai pull` 会警告，步骤照常运行，只是不用这个评分器。旧版 teamai 不认识 `scorers`，所以先更新所有成员和运行器。完整写法见[工作流](workflow.md)。

## 一次运行和它的评审

```console
$ teamai workflow start review-and-fix --driver local     # 有人值守：每个被评分的轮次都有自己的 teamai-score 运行
ℹ run:r3f9…:review:1: review-quality good (teamai-score run r7c2…).
{"data":{"done":{"run":"r3f9…","outcome":"succeeded",…}}}
```

被评分步骤的一个轮次结算后，结算它的 `workflow report`（`workflow:` 步骤则是 `workflow next`）会为该轮次启动一个 [`teamai-score`](#teamai-score-工作流) 运行（`demand: auto`），并在之后每个应答的 `started` 中列出它，直到该运行结束。被评分运行的驱动像驱动自己的运行一样驱动它。被评分运行的步骤和 `finally` 从不等待它，它也从不改变该运行的结果：

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…}}'   # 你自己的驱动
{"data":{"accepted":true,…,"started":[{"run":"r7c2…","step":"review","pass":1,"scorers":["review-quality"]}]}}
$ teamai workflow next r7c2… --json '{"driver":{…}}'                                                   # 像任何运行一样驱动它
```

| 驱动 | 谁启动该运行 | 谁驱动它 | `--no-judge` |
|---|---|---|---|
| `local`，有人值守 | 结算该轮次的 report | `workflow start` 或 `resume`，在返回前驱动，所以返回时标签已经写好 | 无此选项 |
| `local`，无人值守 | 同上 | 同上，在 [drain](#无人值守任务结束前运行-drain) 之前。在此版本之前由 drain 评判该轮次 | 无此选项 |
| `skill` | 同上 | skill 驱动，作为子运行：命令在后台 runner 中运行，评审按 agent 的 judging 参考执行 | 该运行照常启动，并保持运行，留给 `teamai workflow resume <run>` |
| `none` 或你自己的驱动 | 同上 | 你的驱动，对 `started` 中的运行 id 执行 `workflow next` 和 `report` | 无此选项 |

`samplingRate` 决定评判哪些成功的执行轮次，在每台机器上结果相同；为未被选中的轮次启动的 teamai-score 运行结束时没有标签。`scorers` 设置了 `sampling: all` 的步骤，每个成功的执行轮次都会被评判，不管评分器如何抽样，评判方式同上：每个轮次一个自己的 teamai-score 运行，运行结束时不等待它们。[基准测试](benchmarks.md)以 `start: workflow` 设置它，并用自己的 `score` 步骤评判 trial。

标签记录 `used.skills`，即该轮次或其子 agent 加载过的团队技能。判定方式与[会话](#为会话评分)相同，依据该轮次开始时检出目录中由 teamai 交付并未经修改的技能。`workflow:` 步骤的标签列出其子轮次记录的全部技能。若子轮次都未记录，标签没有 `used`。

证据目录包含 `evidence.json`、`prompt.md`、有记录范围时的 `diff.patch`、`repo/`（被评判提交中的跟踪文件，符号链接的目标以文本保存）、`transcripts/`（包含可读取的子代理）和 `outputs.json`。所有文件都经过脱敏，团队在 `env/secrets.yaml` 中声明的密钥值也会被遮蔽。不是文本的跟踪文件不会写入，并列在 `omitted` 里。缺失证据以 gap 代码列出。证据写在 teamai-score 运行的目录下。

### 在下一步之前拿到标签

`scorers.start: workflow` 把步骤各轮次的评分交给工作流自己的步骤。teamai 不为它们启动 teamai-score 运行。`teamai score subjects` 列出它们，再由一个 `workflow: teamai-score` 步骤为每个轮次打标签。如果这样的步骤之后没有 `workflow: teamai-score` 步骤读取针对它的 `teamai score subjects --step`，pull 会发出警告：这样它的轮次只会在运行结束后，由 `teamai score --drain` 或会话启动运行的下一次 `teamai-finished-sessions` 评分：

```yaml
# workflows/fix-until-good.yaml
schemaVersion: v1alpha1
name: fix-until-good
description: Fix a change, and revise it once when its review label is not good.
inputs: { task: string }
steps:
  - id: fix
    prompt: "{{ inputs.task }}"
    workspace: new
    scorers: { names: [review-quality], sampling: all, start: workflow }
  - id: subjects
    needs: [fix]
    if: steps.fix.outcome != 'skipped'
    command: teamai score subjects --run "$RUN" --step fix
    env: { RUN: "{{ run.id }}" }
    output: { list: [string] }
  - id: score
    needs: [subjects]
    for_each: steps.subjects.outputs.list
    workflow: teamai-score
    with: { subject: "{{ item }}", scorers: [], label: "", batch: false, demand: named }
    timeout: 1h
    continue_on_failure: true
  - id: revise
    needs: [fix, score]
    if: steps.score.results[0].outputs.labels[0].outputs.labels[0].label != 'good'
    prompt: The review of this change did not score good. Address what it asks for, with tests.
    workspace: continue
```

`revise` 只在 `fix` 的标签写好之后运行，并且只在标签不是 `good` 时运行；缺失的标签读作 `null`。`teamai-score` 自己的 `timeout` 是 336h，它作为步骤运行时同样生效，两者中较短的那个会结束它，所以这个步骤设置一个更短的 `timeout`，并加上 `continue_on_failure: true`。

### 标签评判的 Harness

每个标签还记录 `agent`，即被评判的工作运行时的 Harness。下例中修复用你的角色运行，审查以审查者身份运行，同一个评分器评判两者：

```yaml
# workflows/fix-and-review.yaml
schemaVersion: v1alpha1
name: fix-and-review
description: Fix the issue with your role, then review and finish the fix as a reviewer.
steps:
  - id: fix
    workspace: new
    prompt: Fix what the issue reports.
    scorers: [review-quality]
  - id: review
    needs: [fix]
    role: review
    workspace: new
    prompt: Review the fix, then fix what is still wrong.
    scorers: [review-quality]
```

运行 `teamai workflow start fix-and-review --driver local` 后，审查轮次在 `<dataHome>/scores/labels.jsonl` 中的标签如下（原为一行，此处折行）：

```text
{"scorer":"review-quality","label":"partial","score":0.5,"passed":false,"source":"workflow",
 "subject":{"runId":"r3f9…","step":"review","pass":1},
 "agent":{"v":1,"tool":{"name":"claude","version":"2.1.308"},"model":{"requested":"claude-sonnet-4-6"},
  "team":{"revision":"62432de…","localChanges":false,
   "selection":{"scope":"project","primaryRole":"frontend","additionalRoles":[],"stepRole":"review"}},
  "project":{"commit":"9e1b…","dirty":false},"teamai":"0.22.0","driver":"local","fingerprint":"5c0d…"},
 "judge":{"kind":"model","tool":"claude",…},"scoredAt":"2026-10-27T10:00:00.000Z"}
```

`stepRole: review` 是步骤运行时的角色，`primaryRole` 是你的角色。`fix` 的标签没有 `stepRole`。

- prompt 步骤的标签带有运行记录中该轮次的 `agent`，轮次没有记录模型、因而没有 `fingerprint` 时也一样。
- `workflow:` 步骤的标签在其所有 prompt 轮次的工具、模型、effort、定义和团队都一致时，带有第一个 prompt 轮次的 `agent`。command 轮次不计入。不一致时标签没有 `agent`，例如 `for_each` 的各项以不同角色运行。
- 会话标签带有其捕获记录一致的 `agent`，比较方式相同。
- 评审者看不到 `agent`。它不属于标签的键，所以重新评分仍会替换被重评的标签。

在仪表盘的[评分器页面](dashboard.md#评分器scorers)，**分组依据**选`角色`时，轮次带 `stepRole` 的标签计入 `stepRole`，否则计入 `primaryRole`，因此审查步骤和成员步骤并列显示：

```text
按 角色
值               标签数  通过  未通过  通过率
frontend 成员    14      11    3       79%
review 步骤      12      7     5       58%
未记录           3       2     1       67%
```

角色旁的 `步骤` 表示它的标签以步骤的角色运行，`成员` 表示以成员的角色运行，`两者` 表示两种都有。

**未通过的标签**列出每个标签的 Harness，运行仍在列表中时可打开该运行。选择一个分组只列出该组的标签：

```text
评分时间    作者  标签     HARNESS                                                     平台        技能  打开
10/27/2026  bob   partial  claude · claude-sonnet-4-6 · review 步骤角色 · 62432de      工作流运行  —     r3f9… ↗  review #1
10/26/2026  ana   bad      codex · gpt-5 · frontend 成员角色 · 62432de                 工作流运行  —     r1a2… 未找到运行  fix #1
10/20/2026  ana   bad      未记录 Harness                                              工作流运行  —     r0c7… 未找到运行  fix #1
```

Harness 来自标签本身，所以运行文件删除后仍然保留。`未记录 Harness` 表示标签和运行记录都没有 `agent`：旧版 teamai 写入、且运行已不存在的标签，prompt 轮次不一致的 `workflow:` 步骤，或捕获记录不一致的会话。在**按 角色**中，这类标签计入`未记录`，`agent` 没有团队信息的标签也一样。

## 任意 driver

driver 像驱动任意运行一样，用 `workflow next` 和 `report` 驱动 `started` 中的每个 teamai-score 运行。它的命令步骤在 `workflow next --prepare` 给出的位置运行，使用租约的 `env`。它的评审步骤是一个受限提示：driver 用自己的评审者处理它，只允许它读取证据目录，然后报告答案和评审者：

```console
$ teamai workflow next r7c2… --prepare --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work","can":{"confined":[{"level":"verified","access":"read","tools":["claude"]}],"workspace":["team"]}}}'
$ teamai workflow report r7c2… --json '{"attempt":"…","revision":5,"outcome":"success","driver":{…},
 "outputs":{"answer":{"label":"good","reasoning":"…"}},"confined":{"tool":"claude","isolation":"verified","access":"read"}}'
```

`workflow next` 按运行 id 找到运行的 scope，所以 driver 可以在运行起始检出目录之外驱动它。要按 id 评审一个会话，用 [`score --session`](#用自己的评审者) 启动它的运行。

| `can.confined` 条目 | 含义 |
|---|---|
| `level` | `verified` 或 `best-effort`。评审步骤只租给提供其评分器所需[级别](#隔离)的 driver。 |
| `access` | 评审者能做什么：`answer`（不用工具）、`read`（读取证据）或 `full`（任意工具）。标签会记录该值。 |
| `tools` | 你的评审者运行的工具。 |

报告中的 `confined` 说明由什么评审：`tool`、`isolation` 和 `access`，可选 `model`、`effort` 和 `usage`。标签会记录它。答案中的标签不在评分器列表中时，该轮以 `judge_answer_invalid` 失败，不写入标签；[`teamai score --run`](#按需评分) 会再次评判它。所有字段见 `teamai workflow next --help` 和 `teamai workflow report --help`。

你的 driver 在上报一个轮次时写明它加载过的团队技能，该轮次的标签会带上它们：

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…},"used":{"skills":["review-notes"]}}'
```

只写名字：不是技能名的值（例如路径）会被丢弃。上报中没有 `used` 时，标签也没有；`"skills":[]` 表示该轮次没有加载团队技能。

## 按需评分

```console
$ teamai score --run r5863… --scorer review-quality                                        # 唯一列出它的步骤，最近一次成功的执行
ℹ Run rd4894… started. If it stops before it ends, continue it with: teamai workflow resume rd4894…
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/d3ce….md
$ teamai score --run r3f9… --step review --pass 2 --scorer review-quality --driver none   # 交给任意 driver 的 workflow next
```

`--run`、`--session` 或 `--team-session` 加上 `--scorer`，会在 [`workflows.driver`](reference.md#成员设置) 指定的 driver 上（未指定则在本地 driver 上）为该执行轮次或会话启动 [`teamai-score`](#teamai-score-工作流)，并输出它写入的标签。`--driver none` 只启动运行，交给任意 driver 的 `workflow next`；它取代了 `--queue`。指定的 driver 本机不运行时，只启动运行，让它等待该 driver，并输出 `<run> waits for driver <name>, which this machine does not run. To drive it here: teamai workflow resume <run> --driver local`。运行中只有一个有成功执行的步骤列出该评分器时，`--step` 可以省略；否则错误会列出可选的步骤。不应用抽样，失败或过期的评审任务会重新打开。`--run` 在运行开始时的团队提交读取每个评分器，并带上检出当时在该提交之后的改动，因此运行期间修改的评分标准不会改变标签；会话接受 `teamai pull` 缓存的任意评分器，使用当前版本。未知的运行、步骤、执行轮次或评分器会失败，列出存在的值，且不启动运行。

有评分器没有得到标签时，命令以退出码 1 结束并给出它的代码，`labels` 列出其他评分器得到的标签：

```console
$ teamai score --run r2907… --scorer review-quality --scorer style   # style 要求模型别名 fast，它只映射了 codex
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/c6cb….md
{"error":{"code":"judge_pending","message":"Run rffc… left the judge of style open for a driver that can run it: … The run waits for one until its timeout, and teamai score --drain lists it. Kept the label of review-quality: good.","labels":[…]}}
```

只剩本机没有工具能接手的评审步骤时，例如本机没有工具能运行其模型的评审步骤，或要求 `verified` 而本机没有已验证评审者的评分器，代码为 `judge_pending`，运行保持打开，等待能接手它的 driver。另一个 `teamai-score` 运行仍在评审的评分器得到 `not_planned`。

某轮执行的提交或记录的会话已不在本机时，评审前就会失败，不写入任何标签：

```console
$ teamai score --run r3f9… --scorer delivered
{"error":{"code":"evidence_missing","message":"Pass 1 of step change in run r3f9… cannot be scored: no longer on this machine: claude-code session 6f1c2a0e-… of change#1. Restore what is missing, or score another pass. No label was written."}}
```

## 为交付的工作评分

带 `deliver: pr` 的步骤以合并请求的形式把工作交给评审。该步骤上的评分器评判这个合并请求，并且在任何评审者运行之前，有三个阶段可以直接判定标签。

```yaml
# workflows/ship-issue.yaml
schemaVersion: v1alpha1
name: ship-issue
description: Make the change an issue asks for, and deliver it as a pull request.
inputs: { issue: number }
steps:
  - id: read-issue
    prompt: Read issue {{ inputs.issue }} and return its title and body.
    output: { title: string, body: string }
  - id: change
    needs: [read-issue]
    prompt: Make the change the issue asks for.
    workspace: new
    deliver: pr
    scorers: [delivered]
```

`scorers/delivered.md`：

```markdown
---
labels:
  - { value: complete, score: 1, description: Delivers what the issue asked and nothing else. }
  - { value: partial, score: 0.5, description: Delivers part of what was asked. }
  - { value: off-target, score: 0, description: Delivers something other than what was asked. }
passingScore: 1
check:
  run: npm test
  protect: [test/**, package.json]
---
Judge whether the pull request delivers what the issue asked, and only that.
```

各阶段按以下顺序运行，第一个未通过的阶段做出判定：

| 阶段 | 何时未通过 | `decidedBy` |
|---|---|---|
| 评分器检查 | 在交付提交的全新克隆中，先把 `protect` 路径恢复为工作开始时的样子，再运行 `check.run`，退出码非零。为了通过而修改 `test/` 的代理无法以这种方式通过。 | `check` |
| 合并请求 CI | 交付提交的 CI 已结束且失败。GitHub：任一检查运行失败、超时或需要操作，或提交状态为失败。GitLab：最新的流水线失败。 | `ci` |
| 受保护路径 | 该轮修改了运行保护的路径，步骤以 `protected_path` 失败，没有交付任何内容。 | `protected` |

`teamai-score` 为该轮打标签时，评分器的 `stages` 决定哪些阶段可以为它做出判定。`clarity` 既不等待 CI，也不由 CI 判定：

```markdown
---
stages: [protected]
labels:
  - { value: clear, score: 1, description: The change reads clearly. }
  - { value: unclear, score: 0, description: It does not. }
passingScore: 1
---
Judge whether the change is easy to read.
```

在 `scorers: [clarity, delivered]` 的步骤上，CI 仍在运行时，`clarity` 立即评审，`delivered` 等待 CI。CI 失败判定 `delivered`，不判定 `clarity`。

未通过时的标签是低于 `passingScore` 的最高标签，此例中为 `partial`。不启动评审者，不消耗 token。所有阶段都通过时，或者仍有 CI 检查在运行、没有任何检查、源仓库不在 GitHub 或 GitLab 上时，由评审者判定，标签记为 `"decidedBy":"judge"`。没有 `check` 的评分器跳过该阶段。未做任何修改的执行没有交付提交，因此同样跳过检查和 CI。

交付步骤的评审者还会读取运行的输入（`inputs.json`）和每个步骤的输出，从而把合并请求与 `read-issue` 返回的 issue 进行对比。

`teamai score --run r3f9… --scorer delivered` 发布的一个 CI 失败标签：

```json
{"scorer":"delivered","label":"partial","score":0.5,"passed":false,"source":"workflow",
 "subject":{"runId":"r3f9…","step":"change","pass":1},"decidedBy":"ci",
 "evidenceHash":"sha256:8ddbddc64a7180bc866ce3fc0da3e5ad940854e7855a51b0318851f932737ba1",
 "judge":{"kind":"stage"},…}
```

`evidenceHash` 标识标签读取的证据。同一轮执行的两个标签哈希相同，说明读取的是同一份工作；如果标签不同，变化的是评分标准或评审者，而不是工作。阶段发现的内容（检查的退出码、CI 结果）只保存在命令输出中指明的本地 reasoning 文件里。它的 judge 是 `{"kind":"stage"}`：没有评审者运行，因此标签不记录评审工具，也没有 `usage`。早期版本写入的标签以 `kind: model` 记录本应运行的评审者，同样按阶段判定读取。

无法运行的检查（例如本机没有该命令，或运行超时）不写入标签。修复检查后，再次为该轮评分：

```console
$ teamai score --run r3f9… --scorer delivered
{"error":{"code":"check_could_not_run","message":"The check of scorer delivered, `npm test`, could not run on commit 4be1c0d… (not_found). Fix the check, then run this command again. No label was written."}}
```

自动轮次的 teamai-score 运行以 `check_could_not_run` 让它失败，并附上同样的原因。带 `check` 的评分器从不与其他评分器[批量评审](#批量评审)，因为它的检查单独运行。同一步骤交付了两个合并请求的两轮执行各得一个标签，以 `subject.pass` 区分。

[评分器页面](dashboard.md#评分器scorers)显示每个阶段判定了多少标签。

## 为会话评分

```console
$ teamai score --session 7c1e… --scorer review-quality          # 在你自己的终端里
ℹ Scoring claude-code session 7c1e… in /work/app
ℹ First prompt: Add retries to the client
ℹ Run r2b7… started. If it stops before it ends, continue it with: teamai workflow resume r2b7…
ℹ review-quality: bad (score 0, did not pass). Reasoning: ~/.teamai/scores/reasoning/9f2c….md
ℹ To share what went wrong, ask your agent to read ~/.teamai/scores/reasoning/9f2c….md and share it with the team (teamai contribute --session-id 7c1e…).
$ teamai score --session 7c1e… --source codex --scorer review-quality --push
```

要为当前所在的会话评分，请让它的 agent 来做（“用 review-quality 给这个会话评分”）。agent 会运行 [`/teamai-share-session`](workflow.md#teamai-share-learnings-和-teamai-share-session)，由它的 `teamai-score` 步骤在后台评审者或新的子 agent 中评审该会话，从不在 agent 自己的上下文中评审。agent 运行 `teamai score` 会得到 `invoke_denied`。

传入 `--session <id>`：评分从不猜测会话。`--source` 使用 `teamai session migrate --source` 的平台名。会话的捕获记录只指向一个平台时，可以省略。评审者读取脱敏后的会话及其子 agent 的记录，不应用抽样。它的 `evidence.json` 列出 `skills`：`available` 是捕获记录显示 teamai 交付的团队 skill，每项带 skills `namespace`（两个相同副本无法区分时为 `namespaceUnknown`）和 `description`（frontmatter 无法解析时省略）；以及 `used`。旧版本捕获的会话改为带 `skills_unknown` gap。

评审者最多读取会话的 200,000 个字符。会话评分器指定更便宜的[模型别名](#选择评审者的模型)，长会话的评审成本也会更低。

无论在哪个目录评分，标签都保存在会话所在的作用域。标签记录 `agent`，即会话启动时的运行配置，来自会话启动 hook 写入的捕获记录。标签还记录 `used.skills`，即会话或其子 agent 加载过、且捕获记录显示会话启动时（包括启动时那次 pull）由 teamai 交付并未经修改的团队技能。之后的 pull 不会改变它。捕获记录无法确认来源的技能不记录，例如与团队技能同名的成员自有技能。`--push` 发布该作用域所有待发布的标签。关闭[用量上报](reporting.md)时，它输出 `Usage reporting is off, so labels stay on this machine.`，标签继续待发布。http 团队仓库没有 `teamai-reports`，因此 `--push` 以 `unsupported_repo` 失败，标签留在本机。有标签等待发布时，`teamai doctor` 会给出警告。

### 手动标注会话

评审者是模型，模型也会出错。自己标注几个会话，[评分器页面](dashboard.md#评分器scorers)就会显示评审者与你一致的频率。

agent 刚说重试循环已经修好，其实没有。在你自己的终端里：

```console
$ teamai score --session 7c1e… --scorer review-quality --label missed-bug --push
ℹ Labelling claude-code session 7c1e… in /work/app
ℹ First prompt: Fix the retry loop in sync.ts
ℹ Run rfc5… started. If it stops before it ends, continue it with: teamai workflow resume rfc5…
ℹ review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.
```

昨天结束的会话，在任意目录：

```console
$ teamai score --session 7c1e… --source claude-code --scorer review-quality --label good --push
```

评分器没有列出的值会失败，且不写入任何内容：

```console
$ teamai score --session 7c1e… --scorer review-quality --label flaky
{"error":{"code":"label_invalid","message":"\"flaky\" is not a label of scorer review-quality. Use one of: good, partial, missed-bug."}}
```

手动标签属于本人。由 agent 运行时，命令返回 `invoke_denied`，不写入任何内容：

```console
$ teamai score --session 7c1e… --scorer review-quality --label good       # 在 agent 的 shell 里
{"error":{"code":"invoke_denied","message":"Workflow \"teamai-score\" has invoke: deny, so no coding agent starts it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set). The person runs teamai score --session 7c1e… --source claude-code --scorer review-quality --label good in their own terminal, and the agent judges this session with /teamai-share-session."}}
```

`--label` 只接受一个 `--scorer`，且必须是 `teamai pull` 缓存的评分器名，在任何运行开始前检查。之后 `teamai-score` 跳过各阶段和评审者。标签的 `score` 和是否通过来自评分器，与评审者的标签相同，没有推理文件。它与评审者的标签一样存储和发布，`judge` 为 `{ kind: "human" }`。同一会话的手动标签和评审者标签并存：用评审者重新评分不会替换手动标签。多个成员手动标注同一会话时，只计入最新的那个手动标签。

`--label` 只标注会话。要手动标注某个工作流 pass，请在你自己的终端中启动 `teamai-score`，把标签写进它的 inputs。主体为 `run:<run id>:<step path>:<pass>`：

```console
$ teamai score --run r24df… --step review --pass 1 --scorer review-quality --label missed-bug
{"error":{"code":"invalid_arguments","message":"--label labels a session. To label pass 1 of step review of run r24df… by hand, run in your own terminal: teamai workflow start teamai-score --driver local --inputs '{\"subject\":\"run:r24df…:review:1\",\"scorers\":[\"review-quality\"],\"label\":\"missed-bug\",\"batch\":false,\"demand\":\"named\"}'"}}
$ teamai workflow start teamai-score --driver local --inputs '{"subject":"run:r24df…:review:1","scorers":["review-quality"],"label":"missed-bug","batch":false,"demand":"named"}'
ℹ Run re440… started. If it stops before it ends, continue it with: teamai workflow resume re440…
{"data":{"done":{"run":"re440…","outcome":"succeeded","outputs":{"labels":[{…,"outputs":{"labels":[{"scorer":"review-quality","label":"missed-bug","code":""}],"written":["9c41…"]}}]}},"cancelled":[]}}
```

该标签以 `judge: { kind: "human" }` 存储，并由该运行的 `publish` 步骤发送到 `teamai-reports`，与会话相同。

### 队友推送的会话

Alice 用 `teamai session push` 推送了她的会话。在你检出的同一项目中：

```console
$ teamai session pull
$ teamai session list

Sessions for github.com/acme/app:

  SESSION                                             AUTHOR      PLATFORM        MSGS  UPDATED
  ─────────────────────────────────────────────────────────────────────────────────────────────
  claude-code_fix-the-retry-loop-in-sync-ts_20261021  alice       claude-code       84  2026-10-21

  1 session(s)

$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --scorer review-quality --label missed-bug --push
ℹ Labelling claude-code session 7c1e… in packages/api
ℹ Pushed by alice
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.
```

这个标签针对的是 Alice 运行的会话，因此会与她机器上评审者给出的标签配对。省略 `--label` 时，由评审者为推送的会话评分：

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --scorer review-quality
ℹ Scoring claude-code session 7c1e… in packages/api
ℹ Pushed by alice
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/2b7d….md
```

两个成员推送了同名会话时，命令失败并列出他们。用 `--author` 选择其一：

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --author bob --scorer review-quality --label good
```

`--team-session` 在 `teamai-reports` 上读取为当前目录所在项目推送的会话。在 git 团队上，只有 `teamai-reports` 中没有该名称的会话时，才读取 teamai 以前保存在默认分支上的会话；`--author` 只在找到该名称的位置推送过它的成员中选择。它不能与 `--session`、`--source` 或 `--json` 同时使用。评审者读取前会对会话脱敏，即使推送时没有使用 `--scrub`。它显示的目录是会话运行时相对于仓库的目录。它的标签从归档中取 `agent`（见[脱敏后的会话保留什么](dashboard.md#脱敏后的会话保留什么)），所以评分器页面按工具、模型和团队版本分组时，它与在运行机器上评分的会话归在一起。归档中没有 `agent` 的会话（例如 teamai 0.28 及更早版本推送的）在那里计为“未记录”。

### 评分器变更时

| 你修改了 | 手动标签 |
|---|---|
| 提示词，或某个标签的 `description` | 仍然配对。手动标签是你对会话的判断，评审者的提示词不会改变它。用评审者重新评分，新 rubric 会显示它与你已给出的手动标签的一致程度。 |
| 某个标签的 `value`，例如 `bad` 改为 `missed-bug` | 值为 `bad` 的手动标签不与新 rubric 的任何标签配对。请重新标注这些会话。 |
| `passingScore`，或某个标签的 `score` | 请重新标注：手动标签保留存储时的通过结果。 |

### 用自己的评审者

用自己工具评审的 driver（例如 Cursor 会话或编排器）用 `--driver none` 启动会话的 teamai-score 运行，再[像任意 driver 一样](#任意-driver)驱动它，用自己的工具完成评审步骤：

```console
$ teamai score --session 7c1e… --source cursor --scorer review-quality --driver none
{"data":{"run":"r9a1…",…}}
$ teamai workflow next r9a1… --prepare --json '{"driver":{"kind":"cursor","machine":"m1","workspace":"/work","can":{"confined":[{"level":"best-effort","access":"read","tools":["cursor"]}],"workspace":["team"]}}}'
```

`--source` 指定从哪里读取会话。无论抽样、六小时空闲、`scoring.sessions`、评分器的 `sessions`、之前的标签或 `daily_limit` 如何，该运行都会评判，并计入当天的 `daily_limit`。多个评分器加 `--batch` 时共用一个评审步骤。评分器要求的[隔离](#隔离)高于你提供的级别时，评审步骤留给能提供该级别的 driver。标签记录你的工具、`access` 和你报告的模型。

### 试用评分器文件

```console
$ teamai score --session 7c1e… --scorer ./scorers/review-quality.md
```

推送新建或修改过的评分器之前，可以在团队仓库的本地检出中先拿一个会话试一下。`--scorer` 接受路径：含 `/` 或以 `.md` 结尾的值，相对当前目录。文件按 `teamai pull` 的方式校验，无效文件在任何运行开始前以 pull 的提示失败。该命令在 `--driver` 或 `workflows.driver` 指定的 driver 上启动[默认工作流](workflow.md#默认工作流) `teamai-try-scorer`，都未指定时用 local。它用该文件和 `store: false` 运行两次 [`teamai-score`](#teamai-score-工作流)：一次评判会话，一次只评判会话的第一条提示，然后由 `teamai score report` 读取两次结论。评审方式与缓存的评分器相同，也支持 `--batch`：本机没有工具能按文件的 `model` 或 `isolation` 接手的评审，会让运行以 `confined_pending` 停下等待。

文件的标签从不保存，因此该命令不接受 `--push`，`--run` 也只接受评分器名称，与文件一起给出的评分器名称会被拒绝：请用单独的命令评判它。输出给出标签及其理由，并带 `"stored": false`。旁边的 `stored` 列出本机为该会话和同名评分器保存的最新标签，每个评分标准一条，便于看出修改是否改变了结论。`control` 是用同一文件只对会话的第一条提示再评审一次的结果。它通过时会附带警告：该评分标准会让 agent 什么都没做的会话通过，可能并未评判 agent 的工作。它只警告、从不失败，因为评分标准可能本就是评判提示本身。

`teamai-try-scorer` 是 `invoke: deny`，所以在 agent 会话中该命令返回 `invoke_denied`。请让 agent 使用 `/teamai-new-scorer`：它和你一起编写评分器，以同样的方式在你指定的会话上试用，展示结论，并在把 `scorers/<name>.md` 作为合并请求提交给团队之前征得你的同意。

工作流或整个团队分支用 `teamai pull --team-ref <branch>` 试用（[分发](distribution.md)）。

### 已结束的会话

无人值守的运行现在默认发布并评判自己的会话。在 CI、云虚拟机或托管任务中（[`CI` 或 `TEAMAI_MODE=unattended`](workflow.md#有人值守与无人值守的运行)），[`teamai score --drain`](#无人值守任务结束前运行-drain) 会把本机记录为无人值守的已捕获会话，以及在这里驱动的工作流运行的步骤会话，脱敏后归档到 `teamai-reports`。每个设置了 `sessions: true` 的评分器在 `daily_limit` 之内抽样评判这些已捕获的会话。要保持原来的行为，在两个团队文件中都设置 `unattended: off`：

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

```yaml
# scorers/scoring.yaml
sessions: { unattended: off }
```

`scorers/scoring.yaml` 中的 `sessions` 按运行模式分别设置策略。布尔写法仍然有效：

```yaml
# scorers/scoring.yaml，或 scorers/<namespace>/scoring.yaml
sessions: { attended: auto, unattended: auto }   # true 等于两种模式都是 auto，false 等于都是 off
daily_limit: 10                                  # 按数据目录计数：在全新的 CI runner 上，它限制的是一次任务，而不是一天
```

| 策略 | `attended` | `unattended` |
|---|---|---|
| `off` | 什么都不做。默认值。 | 什么都不做。 |
| `ask` | 摩擦提醒提供 [`teamai-share-learnings`](workflow.md#teamai-share-learnings-和-teamai-share-session) 时，它提议抽样选中该会话的评分器，成员确认后由它们评判。 | 等同于 `off`，因为没有人回答。 |
| `auto` | 会话六小时没有任何活动后，由会话启动时开始的 [`teamai-finished-sessions`](#teamai-finished-sessions) 运行评判。 | 在任务结束前运行 `teamai score --drain` 时评判。默认值。 |

每种模式单独解析，取下面第一个设置了它的位置：成员 `config.yaml` 中的 `scoring.sessions`、生效命名空间的 `scoring.yaml`、根目录的 `scorers/scoring.yaml`、默认值。两个生效命名空间不一致时，最严格的策略生效（`off`，其次 `ask`，最后 `auto`），`daily_limit` 也取最低值。只写一种模式的映射（例如 `{ attended: ask }`）会把另一种模式留给下一级：

```yaml
# config.yaml
scoring:
  sessions: { attended: ask }   # 只设置有人值守；无人值守仍按团队设置
```

`~/.teamai/config.yaml` 中的 `scoring` 作用于本机每个 workspace 和 self scope 中其自身 `config.yaml` 没有设置的模式和上限，且只在比团队更严格时生效：团队开启的模式可以被关闭，更低的 `daily_limit` 生效。本机永远不会开启评判：

| `scorers/scoring.yaml` | `~/.teamai/config.yaml` | 在 workspace 中 |
|---|---|---|
| `sessions: true` | `scoring: { sessions: { unattended: off } }` | 有人值守 `auto`，无人值守 `off` |
| `sessions: { attended: ask }` | `scoring: { sessions: false }` | 两种模式都是 `off` |
| `sessions: false` | `scoring: { sessions: true }` | 两种模式都是 `off`：团队的 `off` 保持不变 |
| `daily_limit: 4` | `scoring: { daily_limit: 2 }` | 每个 workspace 每天 2 个会话 |
| `daily_limit: 4` | `scoring: { daily_limit: 20 }` | 每个 workspace 每天 4 个会话 |

和团队的上限一样，本机的上限按每个 workspace 分别计数：一台有三个 workspace 的笔记本在 `daily_limit: 2` 下每天仍可评判六个会话。

一旦有设置（而不是默认值）决定了某种模式或上限，`teamai doctor` 会说明它来自哪里：

```text
Session judging: attended auto, set by scorers/scoring.yaml sessions; unattended off, set by ~/.teamai/config.yaml scoring.sessions.unattended; up to 2 sessions a day, set by ~/.teamai/config.yaml scoring.daily_limit.
```

值不是 `off`、`ask` 或 `auto`（也不是布尔值）时，`teamai doctor` 会报告它所在的文件和键，teamai 忽略该值，这种模式交给下一级。会话是否归档由 `sessions.publish` 决定，见[会话](sharing.md#会话)。

| 评判对象 | 由谁决定 |
|---|---|
| 工作流步骤的 pass | 步骤的 `scorers`，按每个评分器的 `samplingRate` 抽样，或在 `sampling: all` 下评判每个 pass。与 `sessions` 无关。 |
| 已捕获的会话：你的会话，或 `CI`、`TEAMAI_MODE` 任务中不是由 teamai 启动的会话 | 该会话运行模式对应的 `sessions`，由每个设置了 `sessions: true` 的评分器按其 `samplingRate` 抽样评判。 |
| teamai 启动的会话，例如工作流步骤或评审 | 不评判。它不写捕获记录，它的步骤按 pass 评判。 |
| teamai 读不到会话的工具（例如 Pi）的会话 | 不评判。对发布或评判策略不是 `off` 的每种模式，`teamai doctor` 会列出团队启用的每个这类工具。按默认值，两种模式都会列出。 |

命名空间中的评分器只在会话每次启动时记录的角色和项目都使该命名空间生效时，才评判该会话。

每个会话对同一评分器和评分标准只评判一次。标签或失败的评审会关闭它。过期（例如评审被自身的超时取消）会由下一次 `teamai-finished-sessions` 重新开始，直到第四次过期为止；在此版本之前，过期会关闭它。`config.yaml` 中的 `scoring.daily_limit` 设置每个数据目录每个本地日最多开始多少次会话评审，默认 10，每次重新开始的过期都计入，同一会话上一批评分器只算一次。在全新的 CI runner 上，每次任务都从新的数据目录开始，所以这个上限限制的是一次任务，而不是一天。`0` 关闭会话评分。由人指定的评分器计入上限，但从不因上限被拒绝。修改评分器的评分标准后，已捕获的会话会重新成为它的评审工作，每日上限会把这些工作分摊到之后几天。

设置 `attended: auto` 后，你不需要自己运行 driver。会话启动时的 pull 之后，teamai 会在会话目录能到达的每个作用域（它的项目和你的用户作用域）中，只要该作用域自动评判或归档有人值守的会话，就启动一次 `teamai-finished-sessions` 运行，并在一个分离的进程中驱动它。该运行用本机安装的评审工具归档并评判每个已结束的会话，并为评审过期的每个 pass 和会话重新启动 `teamai-score`。因此成员的会话启动也会重新评分该数据目录中过期的工作流 pass。运行在 30 分钟后结束。它运行的每个 `teamai-score` 都会把标签发布到 `teamai-reports`；离线时，标签保持待发布，由下一次 `teamai pull` 发布。找不到任何工作的启动不会创建运行，已在处理该数据目录的运行会被留给它自己完成。每次评审是一次在你账号上的评审调用，每天最多 `daily_limit` 次。会话评分器指定便宜的[模型别名](#选择评审者的模型)（例如 `model: fast`）可以控制成本。要停止，在 `config.yaml` 中设置 `scoring.sessions: { attended: off }`；写在 `~/.teamai/config.yaml` 中则对本机所有 workspace 生效。

分离的运行使用 `teamai init` 记录的工具主目录，例如移动过的 `CLAUDE_CONFIG_DIR`。它看不到只在你的 shell 中设置的凭据或 base URL，在 Windows 上尤其如此。请把它们放在工具的登录状态、用户环境变量或工具 `settings.json` 的 `env` 中。

比当前版本更旧的 teamai 会拒绝带有 `sessions: true` 的评分器，因此团队添加这样的评分器之前，请先在每位成员的机器上更新 teamai。在你的机器上领取评审工作的旧版 teamai（例如某个驱动自带的副本）会删除会话租约的评分标准，因此开启 `scoring.sessions` 之前，请先更新机器上的每一份 teamai。

#### 技能路由

路由问题判断每个团队技能是否在该加载时加载、且只在那时加载。它默认关闭，为 `sessions` 已经在评判的会话开启：

```yaml
# scorers/scoring.yaml
sessions: true
skill_routing: true
```

例如一个要求做评审的会话，它得到了根技能 `review-notes` 和 `ops` 技能命名空间中的 `release`，加载了 `review-notes`。它的 `evidence.json` 列出这两个技能：

```json
{
  "subject": { "platform": "claude-code", "sessionId": "7c1e…" },
  "kind": "session",
  "gaps": [],
  "skills": {
    "available": [
      { "name": "release", "namespace": "ops", "description": "Cut an npm release: bump, changelog, tag, publish. Use when asked to release or publish a version." },
      { "name": "review-notes", "description": "Write review notes for a PR. Use when asked to review a branch or a PR." }
    ],
    "used": ["review-notes"]
  }
}
```

会话为 `skills.available` 中的每个技能各生成一个问题：根技能是 `teamai:routing:<skill>`，带命名空间的是 `teamai:routing:<namespace>:<skill>`。标记为 `namespaceUnknown` 的技能没有问题，因为它可能和同名的另一个技能混淆。这些问题从不抽样，无论多少个都共用一次评审调用，并计入 `daily_limit`。设置 `batch: true` 时，团队中要求同一模型和工具的会话评分器也加入这次调用。这些名字也可以按需解析，不受 `skill_routing` 影响，但只对该会话 `skills.available` 中的技能有效；其他名字会得到 `scorer_not_found`：

```console
$ teamai score --session 7c1e… --scorer teamai:routing:ops:release --scorer teamai:routing:review-notes
ℹ teamai:routing:ops:release: idle (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/4b1d….md
ℹ teamai:routing:review-notes: fit (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/8e07….md
```

几周后，[看板](dashboard.md)按取值统计标签，得出每个技能的计数：

```text
teamai:routing:ops:release · session · 30 days
label    score   labels
fit      1       31
idle     1       112
extra    0       6
missed   0       9
```

由这些计数可以算出精确率和召回率：

```text
precision(ops:release) ≈ 31 / (31 + 6) = 84%   不需要时加载了 6 次
recall(ops:release)    ≈ 31 / (31 + 9) = 78%   需要时没有加载 9 次
```

每个技能都用同一份评分标准，只填入技能名。改写技能描述不会改变评分器的度量，所以改写前后的计数可以直接比较：

```text
fit     1  <skill> is in skills.used, and the session needed what its description says.
idle    1  <skill> is not in skills.used, and the session did not need what its description says, or another skill or the agent's own steps did it.
extra   0  <skill> is in skills.used, and the session did not need what its description says.
missed  0  The session needed what the description of <skill> says, <skill> is not in skills.used, and nothing else did it.
Judge only the team skill <skill>, against its entry in skills.available in evidence.json.
```

这份评分标准是 teamai 的[默认评分器](#默认评分器) `scorers/teamai-routing.md`。团队提交同名文件，就会为每个技能换掉它。

生效的评分器命名空间的 `scoring.yaml` 会覆盖根文件的 `skill_routing`，设为 `false` 时为它的成员关闭路由问题：

```yaml
# scorers/ops/scoring.yaml
skill_routing: false
```

成员在 `config.yaml` 中设置的 `scoring.skill_routing` 优先于团队的。工作区或 self 作用域之下，`~/.teamai/config.yaml` 只能关闭它，因此一台机器永远不会自行开始付费评审。

想用单独的方式评判某个技能，就保持 `skill_routing` 关闭，为每个技能写一个评分器。下面这个评分器为没有得到 `release` 的会话加了一个 `unavailable` 取值：

`scorers/ops/routing-release.md`：

```markdown
---
labels:
  - { value: fit, score: 1, description: "release is in skills.used, and the session needed it." }
  - { value: idle, score: 1, description: "release is in skills.available, is not in skills.used, and the session did not need it, or another skill or the agent's own steps did it." }
  - { value: unavailable, score: 1, description: "release is not in skills.available." }
  - { value: extra, score: 0, description: "release is in skills.used, and the session did not need it." }
  - { value: missed, score: 0, description: "The session needed what the description of release says, release is not in skills.used, and nothing else did it." }
passingScore: 1
samplingRate: 100
sessions: true
---
Judge only the team skill `release`, against its entry in `skills.available` in `evidence.json`.
```

设置 [`batch: true`](#批量评审) 后，一次评审调用回答一个会话中要求同一模型和工具的所有评分器。每个评分器各自抽样会话，所以十个按技能、抽样率 25% 的评分器仍会覆盖约 94% 的会话，而只得到约四分之一的回答。抽样率为 100% 时，同样的调用会回答每个评分器。想少花一些，就调低 `daily_limit`，而不是 `samplingRate`。

#### Recall 采纳

采纳问题判断会话是否用了 `teamai recall` 给它、但它从未打开的每篇文档，例如 recall 子 agent 总结过的文档。会话打开过的文档不经评审直接计分。可以为团队开启，也可以只为自己开启：

```yaml
# 团队仓库中的 scorers/scoring.yaml
recall_adoption: true
```

```yaml
# ~/.teamai/projects/<project>/config.yaml，单个成员
scoring:
  recall_adoption: true
  sessions: { attended: auto }
```

成员的 `recall_adoption` 优先于团队的。工作区或 self 作用域之下，`~/.teamai/config.yaml` 只能关闭它，因此一台机器永远不会自行开始付费评审。`TEAMAI_UPVOTE_JUDGE=1` 相当于上面的成员设置（只补成员配置没写的键），`teamai doctor` 会提示它已弃用。

结束的根会话为每篇这样的文档得到一个问题 `teamai:adoption:<hash>`，以文档的投票键命名：

```text
session 7c1e…  recalled: pod-startup-timeouts, helm-values, retry-policy
opened by a tool call  → helm-values                      credited, no judge
teamai:adoption:3f9a1c… (pod-startup-timeouts)  → adopted   upvote, judged_count +1
teamai:adoption:b27e04… (retry-policy)          → ignored   judged_count +1
```

评审者在证据的 `recalled/<hash>.md` 中读到会话当时拿到的文档：团队知识根目录下 `.md` 文件的前 1,200 个字符。在那里读不到的文档不提问。这些问题共用一次评审启动，并计入 `daily_limit`。每个根会话中一篇文档只计分一次，读取或判定，以先到者为准；按需再次评审只存标签，不再计分。投票文件被占用时，判定先留在 recall 日志中，下一次 `teamai score` 或 `teamai pull` 写入。recall 日志中的每行最多保留 30 天。日志删掉某会话的全部记录后，再写入的判定不计分，因此暂停这么久的评分运行不会记入采纳；`teamai pull` 也会忘掉该会话已计分的文档。这些计数如何影响置信度见[知识库](knowledge.md#recall-采纳与-upvote)。

评分标准是[默认评分器](#默认评分器) `scorers/teamai-adoption.md`。

### teamai-finished-sessions

```text
teamai-finished-sessions   private, invoke: deny, timeout 30m
  sessions   teamai session list --finished --idle 6h   the finished sessions to archive or judge here
  share      teamai-share-session, for each             its publish step, then its teamai-score step
  lapsed     teamai score subjects --lapsed             passes and sessions whose judging lapsed, and passes no run scored, each with its scorers
  rescore    teamai-score, for each                     starts their judging again with those scorers only
```

会话启动和 `teamai score --drain` 用 `{"publish":"policy","scorers":[]}` 启动它，因此由会话策略决定。在你自己的终端中可以传入其他输入，例如不管策略怎么说，用一个评分器评判每个已结束的会话且不归档任何会话：

```console
$ teamai workflow start teamai-finished-sessions --driver local --inputs '{"publish":"never","scorers":["review-quality"]}'
```

`publish` 取 `policy`、`always` 或 `never`。`scorers` 指定评判每个已结束会话的评分器，不抽样，计入 `daily_limit` 但从不因它被拒绝；`[]` 则交给 `scoring.sessions`。由会话启动、drain 或 agent 启动的运行只能用 `policy` 和 `[]` 列出会话，其他输入会以 `policy_override_refused` 失败。

| 时钟 | 设置位置 | 默认 |
|---|---|---|
| 会话算作已结束 | `sessions` 步骤的 `--idle` | 最后一次活动后 6 小时；无人值守的会话在 drain 到达它时 |
| 运行结束 | 文件的 `timeout` | 30 分钟；它取消的工作会过期，下一次运行会重新开始 |
| 本机没有 driver 领取的评审 | share-session 的 `score` 步骤的 `timeout` | 30 分钟；会话保持已发布，它的评审过期 |
| 过期被重新开始 | 评分标记 | 直到第四次过期，且只在运行最后一次变更后的 14 天内；只用标记里的评分器，包括有人点名的那个，不抽样；点名过的不会被 `daily_limit` 拒绝；不加入会话策略此时会选的其他评分器 |

团队在团队仓库的 `workflows/teamai-finished-sessions.yaml` 中修改这些，它会替换默认文件：`--idle 1h` 在会话最后一次活动一小时后就处理它，`timeout` 限定一次运行的时长。也可以在那里添加或调整步骤的顺序。团队不能改变的部分留在 CLI 中：自动启动不传递 agent 证据，只传策略输入。

### 无人值守任务结束前运行 drain

```console
$ teamai score --drain
✔ Judged 1 sampled session here (review-quality)
✔ Published 1 label to teamai-reports
✔ Archived 1 captured session to teamai-reports (scrubbed)
✔ Reported usage to stats/<member>.yaml
ℹ Left open: the judge of 1 session in run rffc…: … A driver whose tools judge it takes it with: teamai workflow next rffc… --json '{"driver":{…,"can":{…}}}'
```

每个无人值守的 driver 都以 `teamai score --drain` 结束。本地驱动在无人值守运行结束时自动执行它，除非无人值守会话的发布和评判都设为 `off`，或该运行本身是 `teamai-finished-sessions` 运行。skill 驱动、T3、Paseo 和 CI 脚本把它作为最后一步执行。它按以下顺序工作：

1. 在无人值守模式下，本数据目录记录为无人值守的每个已捕获会话都算已结束，包括调用它的会话。有人值守的会话仍按六小时规则。
2. 像会话启动那样在这里启动一次 [`teamai-finished-sessions`](#teamai-finished-sessions) 运行，并用 `workflows.driver` 指定的驱动（未指定则用本地驱动）驱动它。指定的驱动本机不运行时，运行会等待该驱动，drain 会说明如何在本机驱动它。该运行在会话所属模式的 `publish` 为 `auto` 时归档已结束的会话，并在 `daily_limit` 内评判策略允许的抽样会话。它为评审过期的每个 pass 和会话、运行未评分的每个 `start: workflow` pass，以及升级时从评审尝试带过来的未完成 pass 和会话重新启动 `teamai-score`，但运行最后一次变更已超过 14 天的 pass 除外。已在处理该数据目录的运行会被留给它，drain 会说明这一点：等它结束后再运行一次 drain。
3. 像 `score --push` 一样发布每个待发布的标签，以及 [`deliver: publish`](workflow.md#发布到数据分支) 步骤留在数据分支上待发布的内容，并像 `teamai pull` 一样发布运行当时没能发布的工作流运行记录。
4. 当前模式的 `publish` 为 `auto` 时，把在这里驱动的运行中尚未归档的步骤会话，脱敏后归档到 `teamai-reports`。无法从这里归档的步骤会话（teamai 读不到其工具的会话，或本机读不到这个会话）只列出一次已跳过及原因，之后不再重试。该运行的其他步骤会话照常归档。[基准测试](benchmarks.md)运行的 trial 会话留在运行它的机器上。
5. 像 `teamai pull` 一样把用量上报到 `stats/<member>.yaml`，让临时 runner 的计数到达团队。
6. 输出剩下的工作：它的运行中本机没有 driver 能领取的评审步骤（例如评分器固定的模型本机没有评审工具能运行），它们等待其他 driver 的 `workflow next`；以及 CI 尚未结束的每个 pass 或会话，下一次 drain 会为它们打标签。

drain 只结束并发布与其运行模式相同的会话，因此在不处于无人值守模式的机器上，要处理无人值守会话，请运行 `TEAMAI_MODE=unattended teamai score --drain`。

在这里没有能做的事时，drain 以 0 退出，留给其他 driver 的评审也算在内。评审、发布、用量上报或它的运行失败时以 1 退出。发布或上报失败的内容保持待发布，下一次 `--drain` 会重试。评审失败是最终结果：drain 输出这次失败，但从不重试。要重新请求评审，运行 `teamai score --session <id> --source <platform> --scorer <name>`。

drain 在哪里运行，决定它看到的调用会话是什么样子：

```text
CI job:  claude -p "…"  →  tool exits  →  teamai score --drain      # 任务的最后一步：会话已完整
skill:   … last turn of an unattended session → teamai score --drain  # 会话此刻的样子
```

作为任务的最后一步、在工具退出后运行时，drain 看到的是完整的会话。在会话内部运行时，它按会话此刻的样子评判并发布该会话，之后的对话轮次不会再被评判或发布。

运行和评分标记都保存在 runner 的数据目录中，因此在 drain 之前被终止的 runner 会丢失那次评审。长期运行的虚拟机在每次任务结束时运行 `teamai score --drain`。

## 默认评分器

teamai 为它按条目生成的每类问题附带一份评分标准，作为默认评分器放在安装包里。团队在 `scorers/` 中放一个同名文件，就会在每个成员下次 `teamai pull` 时替换它：

| 默认评分器 | 提出的问题 | 变量 |
|---|---|---|
| `scorers/teamai-routing.md` | 会话得到的每个团队技能一个[路由问题](#技能路由) | `skill.name` |
| `scorers/teamai-adoption.md` | 会话从未打开的每篇已召回文档一个[采纳问题](#recall-采纳) | `doc.id`、`doc.path`、`doc.file` |

默认评分器是一个评分器文件，文本用 `{{ … }}` 读取变量，按每个条目填入。下面这个评判技能是否值得占用上下文：

`scorers/teamai-routing.md`：

```markdown
---
labels:
  - { value: earned, score: 1, description: "{{ skill.name }} was loaded, and the final reply used what it says." }
  - { value: skipped, score: 1, description: "{{ skill.name }} was not loaded, and the session did not need it." }
  - { value: wasted, score: 0, description: "{{ skill.name }} was loaded, and nothing in the final reply used it." }
  - { value: missed, score: 0, description: "The session needed {{ skill.name }} and did not load it." }
passingScore: 1
sessions: true
---
Judge only the team skill `{{ skill.name }}`, against its entry in `skills.available` in evidence.json.
```

文件读取了默认评分器没有提供的变量，或填入变量后不是有效的评分器时，pull 会拒绝它，默认评分器继续生效：

```console
$ teamai pull
⚠ [scorers] scorers/teamai-routing.md: reads {{ skill.title }}, which teamai's default scorer teamai-routing does not offer. It offers skill.name; teamai's default runs until the file reads only those
```

像上面那样，把 frontmatter 里的每个 `{{ … }}` 放在双引号字符串中：pull 会用含引号、冒号和换行的值填入文件，只要有一个值破坏 YAML 就拒绝它。这个文件本身不是评分器：步骤不能列出它，`teamai score --scorer teamai-routing` 也找不到它。评分标准一改，每个问题的评分标准哈希就变了，所以新旧标签分开计数，和[任何评分器](#评分器变更时)一样。

## teamai-score 工作流

`teamai score` 和 `teamai-share-session` 通过启动[默认工作流](workflow.md#默认工作流) `teamai-score` 为一个对象打标签，即已安装包中的 `workflows/teamai-score.yaml`：

```text
teamai-score   private, invoke: deny, timeout 336h
inputs: { subject: string, scorers: [string], label: string, batch: boolean, demand: auto | named, files: [string], store: boolean, control: boolean }
defaults: { inputs: { files: [], store: true, control: false } }

plan           teamai score plan → 各组：共用一次评审调用、走相同阶段的评分器
score          每组一次：
  evidence     teamai score evidence → 脱敏后的证据，放在单独的目录里
  check, ci, protected   交付的执行轮次要经过的阶段；第一个未通过的阶段做出判定
  judge        限定在证据目录里的提示步骤，除非某个阶段已经判定或设置了 label
  label        teamai score label → 每个评分器的标签
  write        teamai score write → scores/labels.jsonl 和待发布队列
  publish      teamai score publish → 把本成员待发布的标签发布到 teamai-reports；store 为 false 时跳过
  settle       teamai score settle，在该组的某个步骤出错之后
```

`subject` 为 `run:<run>:<step>:<pass>`、`session:<source>:<id>` 或 `team-session:<author>:<archive>`。`files`、`store` 和 `control` 有[默认值](workflow-advanced.md#给输入设默认值)，所以运行 `teamai-score` 的步骤可以不传它们；[`teamai-try-scorer`](#试用评分器文件) 设置它们来用评分器文件评判会话，`store: false` 不写入也不发布任何标签，`control: true` 只评判会话的第一条提示。运行是 `private` 的：它和评审者的推理都留在本机。`invoke: deny` 让任何 agent 会话都不能启动它，所以 agent 从不为自己的工作打标签。在 `teamai-score` 尝试之外运行的 score 动词返回 `score_attempt_required`。

### 为团队替换它

团队的 `workflows/teamai-score.yaml` 会为收到它的人替换 teamai 的版本。它可以改写评分标准和 schema 周围的评审提示，调整各阶段的顺序，或去掉 `ci` 或 `protected`：

```yaml
# workflows/teamai-score.yaml（团队文件）：teamai 的版本，去掉 ci 步骤并改写评审提示
        - id: judge
          prompt: |
            Judge this change for our team, strictly. The rubric is in {{ steps.evidence.outputs.rubric }}.
            Reply with {"answer": <the answer>}, where the answer matches the schema in {{ steps.evidence.outputs.schema }}.
```

pull 拒绝改变标签含义的文件，改为运行 teamai 的默认版本：

```text
⚠ [workflows] workflows/teamai-score.yaml:1: field "invoke": sets invoke: allow, so an agent session could start it and label its own work. Set invoke: deny
⚠ [workflows] workflows/teamai-score.yaml has no runnable version, so teamai's default teamai-score stays in effect
```

| 代码 | 该文件 |
|---|---|
| `score_override_contract` | 改变了 `inputs`、它们的 `defaults` 或任何 `outputs`，去掉了 `private: true`，或把 `invoke` 设为 `deny` 以外的值 |
| `score_override_command` | 运行的命令不是带有 teamai 版本所给参数的 score 动词，给动词的 `env` 不同，或添加了 `finally` 步骤或 `setup` 命令 |
| `score_override_workflow_step` | 含有内联 `score` 以外的 `workflow:` 步骤 |
| `score_override_prompt` | 含有不限定在目录里的提示步骤，或列出 `scorers` 的提示步骤 |
| `score_override_confined_dir` | 把评审者限定在的目录不是它所依赖步骤的输出 |
| `score_override_judge_prompt` | 评审提示没有读取 `steps.evidence.outputs.rubric` 和 `steps.evidence.outputs.schema` |
| `score_override_publish` | 运行 `teamai score publish` 却没有 `deliver: publish` 到 `teamai-reports`，发布到其他分支，或发布步骤没有 `if: inputs.store`，使只试用评分器的运行也会发布 |
| `score_override_step_missing` | 去掉或改名了 `plan`、`evidence`、`judge`、`label`、`write`、`publish` 或 `settle`，或在本机有评分器带 check 时去掉了 `check` |
| `default_override_alias` | 是另一个带 `alias: teamai-score` 的工作流 |

项目运行 teamai 的默认版本或项目团队的文件，从不运行用户作用域的 `teamai-score`，每次从该项目启动时都会提示：

```text
⚠ [workflows] Ignored the user scope's teamai-score from this project: teamai's default runs here. Replace it for this project in the project's team repo.
```

### 在你的工作流中运行它

```yaml
# workflows/wrap-up.yaml（团队文件）
schemaVersion: v1alpha1
name: wrap-up
description: Label the session that just ended with the scorers it names.
inputs: { source: string, session: string, scorers: [string] }
steps:
  - id: score
    workflow: teamai-score
    with: { subject: "session:{{ inputs.source }}:{{ inputs.session }}", scorers: "{{ inputs.scorers }}", label: "", batch: false, demand: named }
    timeout: 30m
    continue_on_failure: true
```

本机没有 driver 能接手的评审者会让 `teamai-score` 一直保持打开，直到某个 timeout 结束它。它自己的 `timeout` 是 336h，作为步骤运行时和对每个 `for_each` 项都生效，步骤自己的 `timeout` 更短时由它结束。像 `teamai-share-session` 一样，给该步骤设置更短的 `timeout` 和 `continue_on_failure: true`。步骤没有 timeout 时 pull 会警告：

```text
⚠ [workflows] workflows/score-this.yaml: step "score" runs teamai-score with no timeout, so a judge no driver here can take holds it open until the run ends. Give it a timeout, such as timeout: 30m, and continue_on_failure: true.
```

在编程会话中，运行里没有别的步骤可做、且 `continue_on_failure` 允许时，skill 驱动会立即放弃这样的评审步骤。

评审运行本身从不被评审。步骤运行 `teamai-score` 或 `teamai-finished-sessions` 并列出 `scorers:` 时，pull 以 `judging_scored` 拒绝它，该文件不会运行：

```text
⚠ [workflows] workflows/wrap-up.yaml:1: field "steps.score.scorers": step "score" runs teamai-score and lists scorers, so its judging would be judged in turn. Remove scorers from the step
```

## 批量评审

```yaml
schemaVersion: v1alpha1
description: Review the change, judged by two scorers in one judge call.
steps:
  - id: review
    prompt: Review the change.
    scorers: { names: [review-quality, test-coverage], batch: true }
```

`scorers/test-coverage.md`：

```markdown
---
labels:
  - { value: covered, score: 1, description: Tests cover each behavior the change adds or alters. }
  - { value: thin, score: 0.5, description: Tests cover the main path only. }
  - { value: none, score: 0, description: No test covers the change. }
passingScore: 1
---
Judge whether the tests in the diff cover what the change does.
```

同一轮中请求相同 `model` 和 `tool` 且经过相同阶段的评分器共用一个评审步骤、一个证据目录和一个提示，答案为每个评分器给出一个标签。评审工具在驱动程序租用该步骤时选定，而不取决于本机安装了什么：

```json
{"answer":{"review-quality":{"label":"good","reasoning":"…"},"test-coverage":{"label":"thin","reasoning":"…"}}}
```

步骤的 `batch` 优先于工作流的 `defaults.scorers.batch`，后者优先于 [`scorers/scoring.yaml`](#隔离) 里的 `batch`。`--batch` 对 `--run` 起同样作用。每个标签记录 `judge.batched: true`。只要有一个标签不在对应评分器的列表中，整个答案都以 `judge_answer_invalid` 失败，不写入标签。

## 隔离

```yaml
# scorers/scoring.yaml
isolation: verified
batch: true
```

`scorers/scoring.yaml` 存放团队的评分设置。`scorers/ops/scoring.yaml` 对启用了 `ops` 命名空间的成员生效（与该目录下的评分器相同），并替换根文件中同名的键。两个启用的命名空间都设置了 `isolation` 时，取最严格的一项。两者设置的 `batch` 不同时，这些成员拿不到评审任务，直到其中一个文件被修改。

团队的 `isolation`、评分器的 `isolation`，以及本作用域 `config.yaml` 或 `~/.teamai/config.yaml` 中的 `scoring.isolation` 都可以要求 `verified`。取最严格的一项；默认是 `best-effort`。teamai 不认识的值按 `verified` 处理，并给出警告。`teamai doctor` 打印该级别、其来源、要求更高级别的评分器，以及本机每个评审工具能达到的级别：

```text
Scoring isolation: verified, set by scorers/scoring.yaml isolation.
Scoring isolation: best-effort, the default. scorers/ops/review-quality.md asks for verified for its own work.
Judge tools here: claude 2.1.308 (Claude Code) is verified, codebuddy 2.3.0 is best-effort.
```

本机评审为每个工具使用各自的配置：

| 工具 | 级别 | `access` | 配置 |
|---|---|---|---|
| Claude Code 2.1.308 | `verified` | `read` | `--restricted`，只开放 Read、Grep 和 Glob，不加载 MCP，不保存会话。 |
| codex-cli 0.163.0 | `verified` | `read` | 临时主目录，其权限配置只允许 shell 读取证据，禁止网络和写入。 |
| OpenCode v2.1.2 | 不在任何 git 或 hg 检出内时为 `verified`，否则 `best-effort` | `read` | standalone 模式，使用独立的配置、数据库和数据目录；禁止命令、编辑、网页和目录外访问；读取结果后删除评判会话。 |
| CodeBuddy、WorkBuddy | `best-effort` | `full` | 只读工具，不加载 MCP，不保存会话。无论 `--tools` 如何设置，它都会列出约 70 个工具。未登录时以 `judge_tool_unavailable` 失败。 |
| Cursor CLI | `best-effort` | `full` | 在 Cursor 沙箱中以 ask 模式运行。 |
| Pi Coding Agent | `best-effort` | `full` | 只开放 read、grep、find 和 ls 工具；不加载上下文文件、扩展和技能；不保存会话。 |
| Antigravity CLI | `best-effort` | `read` | 在 agy 沙箱中以 plan 模式运行：可以读文件，不运行 shell，不在证据目录中写入。评判对话会留在 agy 的历史记录中。 |
| 其他版本 | `best-effort` | 同上 | 相同配置，未经验证。 |

`best-effort` 工具不能评判要求 `verified` 的评分器，[你自己的评审者](#用自己的评审者)低于所需级别时也不能。提示通过标准输入或文件传入。保留工具登录和受支持的模型切换设置。本机没有评审工具能运行评分器的模型时，评审任务保持打开，留给其他 driver，不改变工作流结果。由哪个工具评审见[选择评审者的模型](#选择评审者的模型)。

## 标签存放位置

| 路径 | 内容 |
|---|---|
| `<dataHome>/scores/labels.jsonl` | 本机的所有标签。 |
| `<dataHome>/scores/reasoning/` | 评审者的理由，每个标签一个文件。从不发布。 |
| `<dataHome>/scores/raw/` | 本机评审失败时的输出，保留到之后的评审尝试取代它。 |
| `<dataHome>/sessions/captures/` | 每个会话启动时的运行配置，由会话启动 hook 写入。会话文件消失一天后删除。 |
| `teamai-reports` 上的 `scores/<member>/<YYYY-MM>.jsonl` | 已发布的标签，每个评分器、评分标准、评分对象和评审者只保留最新一条：人，或每个模型评审者的工具和模型。标签留在 `<dataHome>/scores/pending/`，直到 `teamai-score` 的 `publish` 步骤、`teamai score --push` 或 `teamai pull` 在 `teamai-reports` 上找到它们；关闭用量上报时一直留在那里。 |

标签从不进入工作流运行或它的记录。基准测试运行在结束时冻结每个 trial 的评判结果，其记录携带 trial 的结果，而不是标签。工作流运行页面显示每一轮的标签，以及评审开销，与运行本身的 token 分开统计。本机的运行统计每一次评审尝试；成员发布的运行只统计产生了标签的评审。仪表盘的[评分器页面](dashboard.md#评分器scorers)按时间和配置显示每个评分器的通过率。`teamai digest --json` 输出同样的度量，以及每个失败的标签和它的工作开始时的 commit，[`teamai self-improvement run`](self-improvement.md) 把它们变成一个 PR。
