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

评审工具按顺序尝试，第一个条目给出模型的工具负责评审。没有工具给出模型时，`score --next` 把该评审任务列在 `skipped` 下并说明原因，任务保持打开，留给工具能运行该模型的 driver；`teamai doctor` 会对该评分器给出警告。成员为该工具写的 `~` 条目让它使用工具默认模型。启用的 `teamai models switch` 也一样，但 Claude 会保留 `opus`、`sonnet` 或 `haiku`，经切换路由；切换还会丢弃别名的 effort。CodeBuddy 评审者不使用别名的 effort。

每个标签记录由谁评审：

```json
"judge":{"kind":"model","tool":"claude","model":{"requested":"haiku","reported":"claude-haiku-4-5","alias":"fast"},"isolation":"verified","access":"read"}
```

`requested` 是评审者启动时使用的模型；对 driver 自己的评审者，是租约指定的模型。`reported` 是工具报告的模型，或提交中的 `judge.model`。工具默认模型评审时 `alias` 仍会保留。别名设置了 effort 时还会有 `"effort":{"requested":"low"}`。

## 为步骤评分

```yaml
# workflows/review-and-fix.yaml
steps:
  - id: review
    prompt: Review the change.
    scorers: [review-quality]
```

没有有效 `scorers/<name>.md` 的名字会让 `teamai review --branch` 失败；`teamai pull` 会警告，步骤照常运行，只是不用这个评分器。旧版 teamai 不认识 `scorers`，所以先更新所有成员和运行器。完整写法见[工作流](workflow.md)。

## 一次运行和它的评审

```console
$ teamai workflow start review-and-fix --driver local     # 运行照常结束，评审从不阻塞它
$ teamai score --next --json '{"driver":{"kind":"local","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"verified","tools":["claude"]}}}}'
{"data":{"lease":{"ref":"s5d1e07c2a9b4/a91c0d7e","subject":{"runId":"r3f9…","step":"review","pass":1},
  "evidence":"…/scores/evidence/a91c0d7e/","prompt":"…/prompt.md","answer":{"schema":{…}},
  "submit":"teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin"}}}
$ teamai score --lease s5d1e07c2a9b4/a91c0d7e --json '{"driver":{"kind":"local","machine":"m1","workspace":"/work"}}'
{"data":{"label":{"scorer":"review-quality","label":"good","score":1,"passed":true,…},"published":true}}
```

`samplingRate` 决定评判哪些成功的执行轮次，在每台机器上结果相同。`workflow next` 从不分发评审任务。`--lease <ref>` 在本机用租约选定的工具、以[受限配置](#隔离)评判，并像任意 driver 的答案一样结算租约。评审失败时租约保持打开。

标签记录 `used.skills`，即该轮次或其子 agent 加载过的团队技能。判定方式与[会话](#为会话评分)相同，依据该轮次开始时检出目录中由 teamai 交付并未经修改的技能。`workflow:` 步骤的标签列出其子轮次记录的全部技能。若子轮次都未记录，标签没有 `used`。

证据目录包含 `evidence.json`、`prompt.md`、有记录范围时的 `diff.patch`、`repo/`（被评判提交中的跟踪文件，符号链接的目标以文本保存）、`transcripts/`（包含可读取的子代理）和 `outputs.json`。所有文件都经过脱敏，团队在 `env/secrets.yaml` 中声明的密钥值也会被遮蔽。不是文本的跟踪文件不会写入，并列在 `omitted` 里。缺失证据以 gap 代码列出。租约结算或过期后删除证据。

## 任意 driver

driver 用自己的评审者处理 `prompt.md`，只允许它读取证据目录，然后提交答案：

```console
$ teamai score --next --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"verified","access":"read","tools":["claude"]}}},"running":[]}'
$ teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin <<'JSON'
{"driver":{"kind":"t3","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"label":"good","reasoning":"…"},"judge":{"tool":"claude"}}
JSON
{"data":{"label":{"scorer":"review-quality","label":"good","score":1,"passed":true,…},"published":true}}
```

带 `run` 时，`score --next` 按运行 id 找到运行的 scope，所以 driver 可以在运行的工作树里或运行起始检出目录之外请求，并在那里评审和提交租约。要按 id 评审一个会话，用 [`score --session`](#用自己的评审者) 租出它。

| `can.judge` | 含义 |
|---|---|
| `isolation` | `verified` 或 `best-effort`。只租出它满足[所需级别](#隔离)的任务。[按 id 租出的会话](#用自己的评审者)要求更高级别时，以 `isolation_unmet` 失败。 |
| `access` | 评审者能做什么：`answer`（不用工具）、`read`（读取证据）或 `full`（任意工具，默认值）。标签会记录该值。 |
| `tools` | 按你的偏好排序。首个能解析评分器模型的工具胜出。 |

评分器未列出的标签会被拒绝，租约保持打开。`running` 列出你仍在评判的租约，从而续期；租约在领取或续期 30 分钟后过期。不要把评审租约放进 `workflow next` 的 `running`：它会回答 `judge_lease`，且不做任何改动。`run` 是一个运行 id，只领取该运行的工作流 pass，从不领取会话。`canTakeLease: false` 只续期 `running`，不领取任何租约。所有字段见 `teamai score --help`。

你的 driver 在上报一个轮次时写明它加载过的团队技能，该轮次的标签会带上它们：

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…},"used":{"skills":["review-notes"]}}'
```

只写名字：不是技能名的值（例如路径）会被丢弃。上报中没有 `used` 时，标签也没有；`"skills":[]` 表示该轮次没有加载团队技能。

## 按需评分

```console
$ teamai score --run r3f9… --step review --scorer review-quality                     # 在本机评判最近一次成功的执行
$ teamai score --run r3f9… --step review --pass 2 --scorer review-quality --queue     # 交给任意 driver 的 --next
```

不应用抽样，失败或过期的评审任务会重新打开。运行固定过的评分器使用固定的评分标准；`teamai pull` 缓存的其他评分器使用当前版本。不加 `--queue` 时，运行 PATH 上首个可用的评审工具，优先使用执行该轮的工具。未知的运行、步骤、执行轮次或评分器会失败，并列出存在的值。若本机没有评审工具能运行某个评分器的模型，该评分器以 `judge_model_unavailable` 失败并保持打开。错误的 `labels` 列出其他评分器已生成的标签。

## 为会话评分

```console
$ teamai score --scorer review-quality          # 在 agent 会话内：为该会话评分
ℹ Scoring claude-code session 7c1e… in /work/app
ℹ First prompt: Add retries to the client
ℹ review-quality: bad (score 0, did not pass). Reasoning: ~/.teamai/scores/reasoning/9f2c….md
ℹ To share what went wrong, ask your agent to read ~/.teamai/scores/reasoning/9f2c….md and share it with the team (teamai contribute --session-id 7c1e…).
$ teamai score --session 7c1e… --source codex --scorer review-quality --push
```

在会话外运行时，传入 `--session <id>`。评分从不猜测会话。`--source` 使用 `teamai session migrate --source` 的平台名。`CLAUDE_CODE_SESSION_ID` 等 agent 会话环境变量或会话的捕获记录只指向一个平台时，可以省略。评审者读取脱敏后的会话及其子 agent 的记录，不应用抽样。

评审者最多读取会话的 200,000 个字符。会话评分器指定更便宜的[模型别名](#选择评审者的模型)，长会话的评审成本也会更低。

无论在哪个目录评分，标签都保存在会话所在的作用域。标签记录 `agent`，即会话启动时的运行配置，来自会话启动 hook 写入的捕获记录。标签还记录 `used.skills`，即会话或其子 agent 加载过、且捕获记录显示会话启动时（包括启动时那次 pull）由 teamai 交付并未经修改的团队技能。之后的 pull 不会改变它。捕获记录无法确认来源的技能不记录，例如与团队技能同名的成员自有技能。`--push` 发布该作用域所有待发布的标签。关闭[用量上报](reporting.md)时，它输出 `Usage reporting is off, so labels stay on this machine.`，标签继续待发布。http 团队仓库没有 `teamai-reports`，因此 `--push` 以 `unsupported_repo` 失败，标签留在本机。有标签等待发布时，`teamai doctor` 会给出警告。

### 手动标注会话

评审者是模型，模型也会出错。自己标注几个会话，[评分器页面](dashboard.md#评分器scorers)就会显示评审者与你一致的频率。

agent 刚说重试循环已经修好，其实没有。仍在该会话内：

```console
$ teamai score --scorer review-quality --label missed-bug --push
ℹ Labelling claude-code session 7c1e… in /work/app
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.
```

昨天结束的会话，在任意目录：

```console
$ teamai score --session 7c1e… --source claude-code --scorer review-quality --label good --push
```

评分器没有列出的值会失败，且不写入任何内容：

```console
$ teamai score --scorer review-quality --label flaky
{"error":{"code":"label_invalid","message":"\"flaky\" is not a label of scorer review-quality. Use one of: good, partial, missed-bug."}}
```

`--label` 只接受一个 `--scorer`，且必须是 `teamai pull` 缓存的评分器名。标签的 `score` 和是否通过来自评分器，与评审者的标签相同，没有推理文件。它与评审者的标签一样存储和发布，`judge` 为 `{ kind: "human" }`。同一会话的手动标签和评审者标签并存：用评审者重新评分不会替换手动标签。多个成员手动标注同一会话时，只计入最新的那个手动标签。

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
ℹ Labelling claude-code session 7c1e… in /home/alice/app
ℹ Pushed by alice
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.
```

这个标签针对的是 Alice 运行的会话，因此会与她机器上评审者给出的标签配对。省略 `--label` 时，由评审者为推送的会话评分：

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --scorer review-quality
ℹ Scoring claude-code session 7c1e… in /home/alice/app
ℹ Pushed by alice
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/2b7d….md
```

两个成员推送了同名会话时，命令失败并列出他们。用 `--author` 选择其一：

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --author bob --scorer review-quality --label good
```

`--team-session` 在 `teamai-reports` 上读取为当前目录所在项目推送的会话。在 git 团队上，只有 `teamai-reports` 中没有该名称的会话时，才读取 teamai 以前保存在默认分支上的会话；`--author` 只在找到该名称的位置推送过它的成员中选择。它不能与 `--session`、`--source` 或 `--json` 同时使用。评审者读取前会对会话脱敏，即使推送时没有使用 `--scrub`。它的标签没有 `agent`，因为会话的运行配置只记录在运行它的机器上，所以评分器页面按工具和模型分组时将其计为“未记录”。

### 评分器变更时

| 你修改了 | 手动标签 |
|---|---|
| 提示词，或某个标签的 `description` | 仍然配对。手动标签是你对会话的判断，评审者的提示词不会改变它。用评审者重新评分，新 rubric 会显示它与你已给出的手动标签的一致程度。 |
| 某个标签的 `value`，例如 `bad` 改为 `missed-bug` | 值为 `bad` 的手动标签不与新 rubric 的任何标签配对。请重新标注这些会话。 |
| `passingScore`，或某个标签的 `score` | 请重新标注：手动标签保留存储时的通过结果。 |

### 用自己的评审者

用自己工具评审的 driver（例如 Cursor 会话或编排器）可以租出会话，而不是在本机评审。用 `--json` 声明 `can.judge`（与 [`score --next`](#任意-driver) 相同）时，`score --session` 返回一个租约。由子 agent 或另一个 agent 只根据 `prompt.md` 和证据目录评审，再由 driver 提交答案：

```console
$ teamai score --session 7c1e… --source cursor --scorer review-quality \
    --json '{"driver":{"kind":"cursor","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"best-effort","access":"read","tools":["cursor"]}}}}'
{"data":{"lease":{"ref":"s0c4a9e2f7b1d3/a6e8f2107","source":"session","scorer":"review-quality","prompt":"…/prompt.md","cwd":"/work/app",
  "submit":"teamai score --lease s0c4a9e2f7b1d3/a6e8f2107 --submit --stdin",…}}}
$ teamai score --lease s0c4a9e2f7b1d3/a6e8f2107 --submit --stdin <<'JSON'
{"driver":{"kind":"cursor","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"label":"good","reasoning":"…"},"judge":{"tool":"cursor","model":"…"}}
JSON
```

`--source` 指定从哪里读取会话，`tools` 指定由什么评审。无论抽样、六小时空闲、`scoring.sessions`、评分器的 `sessions`、之前的标签或 `daily_limit` 如何，都会租出，并计入当天的 `daily_limit`。多个评分器加 `--batch` 时共用一个租约。评分器要求的[隔离](#隔离)高于你提供的级别时（`isolation_unmet`）、评分器指定的模型你的工具都无法运行时（`judge_model_unavailable`：指定模型需要 teamai 认识的工具，例如 `cursor`），或另一个有效租约持有该任务时（`busy`），不租出任何任务。标签记录你的工具、`access` 和你报告的模型。

### 试用评分器文件

```console
$ teamai score --session 7c1e… --scorer ./scorers/review-quality.md
```

推送新建或修改过的评分器之前，可以在团队仓库的本地检出中先拿一个会话试一下。`--scorer` 接受路径：含 `/` 或以 `.md` 结尾的值，相对当前目录。文件按 `teamai pull` 的方式校验，无效文件在任何评审运行前以 pull 的提示失败。评审方式与缓存的评分器相同，也支持 `--batch` 和在会话内运行。

文件的标签从不保存，因此该命令不接受 `--push`，`--run` 也只接受评分器名称。输出给出标签及其理由，并带 `"stored": false`。旁边的 `stored` 列出本机为该会话和同名评分器保存的最新标签，每个评分标准一条，便于看出修改是否改变了结论。`control` 是用同一文件只对会话的第一条提示再评审一次的结果。它通过时会附带警告：该评分标准会让 agent 什么都没做的会话通过，可能并未评判 agent 的工作。它只警告、从不失败，因为评分标准可能本就是评判提示本身。

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
| `ask` | 目前等同于 `off`。 | 等同于 `off`，因为没有人回答。 |
| `auto` | 会话六小时没有任何活动后，由后台评审评判。 | 在任务结束前运行 `teamai score --drain` 时评判。默认值。 |

每种模式单独解析，取下面第一个设置了它的位置：成员 `config.yaml` 中的 `scoring.sessions`、生效命名空间的 `scoring.yaml`、根目录的 `scorers/scoring.yaml`、默认值。两个生效命名空间不一致时，最严格的策略生效（`off`，其次 `ask`，最后 `auto`），`daily_limit` 也取最低值。只写一种模式的映射（例如 `{ attended: ask }`）会把另一种模式留给下一级：

```yaml
# config.yaml
scoring:
  sessions: { attended: ask }   # 只设置有人值守；无人值守仍按团队设置
```

值不是 `off`、`ask` 或 `auto`（也不是布尔值）时，`teamai doctor` 会报告它所在的文件和键，teamai 忽略该值，这种模式交给下一级。会话是否归档由 `sessions.publish` 决定，见[会话](sharing.md#会话)。

| 评判对象 | 由谁决定 |
|---|---|
| 工作流步骤的 pass | 步骤的 `scorers`，按每个评分器的 `samplingRate` 抽样。与 `sessions` 无关。 |
| 已捕获的会话：你的会话，或 `CI`、`TEAMAI_MODE` 任务中不是由 teamai 启动的会话 | 该会话运行模式对应的 `sessions`，由每个设置了 `sessions: true` 的评分器按其 `samplingRate` 抽样评判。 |
| teamai 启动的会话，例如工作流步骤或评审 | 不评判。它不写捕获记录，它的步骤按 pass 评判。 |
| teamai 读不到会话的工具（例如 Pi）的会话 | 不评判。对发布或评判策略不是 `off` 的每种模式，`teamai doctor` 会列出团队启用的每个这类工具。按默认值，两种模式都会列出。 |

命名空间中的评分器只在会话每次启动时记录的角色和项目都使该命名空间生效时，才评判该会话。`score --next` 先分发工作流的评审工作，再分发会话。会话租约带有 `"source":"session"`，其 `cwd` 是提交答案时所在的目录。

每个会话对同一评分器和评分标准只评判一次。释放、过期或本地评审失败都会关闭它。过期租约的答案仍会被记录，除非之后已有评审者为该会话打了标签，或[你自己的评审者](#用自己的评审者)又租走了它。`config.yaml` 中的 `scoring.daily_limit` 设置每个数据目录每个本地日最多租出多少个会话，默认 10，失败或无法读取的会话也计入。在全新的 CI runner 上，每次任务都从新的数据目录开始，所以这个上限限制的是一次任务，而不是一天。`0` 关闭会话评分。修改评分器的评分标准后，已捕获的会话会重新成为它的评审工作，每日上限会把这些工作分摊到之后几天。

设置 `attended: auto` 后，你不需要自己运行 driver。会话启动时的 pull 之后，如果会话所在项目或你的用户作用域开启了会话评分，teamai 会为这两个作用域在后台启动评审。它用本机安装的评审工具评判每个已结束的会话，30 分钟后不再领取新工作，标签保持待发布，由下一次 `teamai pull` 发布。每个租约是一次在你账号上的评审调用，每天最多 `daily_limit` 次。会话评分器指定便宜的[模型别名](#选择评审者的模型)（例如 `model: fast`）可以控制成本。要停止，在 `config.yaml` 中设置 `scoring.sessions: { attended: off }`。

后台评审使用 `teamai init` 记录的工具主目录，例如移动过的 `CLAUDE_CONFIG_DIR`。它看不到只在你的 shell 中设置的凭据或 base URL，在 Windows 上尤其如此。请把它们放在工具的登录状态、用户环境变量或工具 `settings.json` 的 `env` 中。

比当前版本更旧的 teamai 会拒绝带有 `sessions: true` 的评分器，因此团队添加这样的评分器之前，请先在每位成员的机器上更新 teamai。在你的机器上领取评审工作的旧版 teamai（例如某个驱动自带的副本）会删除会话租约的评分标准，因此开启 `scoring.sessions` 之前，请先更新机器上的每一份 teamai。

### 无人值守任务结束前运行 drain

```console
$ teamai score --drain
✔ Judged 1 sampled session here (review-quality)
✔ Published 1 label to teamai-reports
✔ Archived 1 captured session to teamai-reports (scrubbed)
✔ Reported usage to stats/<member>.yaml
ℹ Left open: 1 session whose scorer pins a model no judge tool here runs (judge_model_unavailable). A driver whose tools run it takes it with: teamai score --next --json '{"driver":{…,"can":{"judge":{…}}}}'
```

每个无人值守的 driver 都以 `teamai score --drain` 结束。本地驱动在无人值守运行结束时自动执行它，除非无人值守会话的发布和评判都设为 `off`。skill 驱动、T3、Paseo 和 CI 脚本把它作为最后一步执行。它按以下顺序工作：

1. 在无人值守模式下，本数据目录记录为无人值守的每个已捕获会话都算已结束，包括调用它的会话。有人值守的会话仍按六小时规则。
2. 评判本机能评判的每个未完成的评审项：抽样的步骤 pass，以及策略允许的抽样会话，受 `daily_limit` 限制。本机有另一个评审过程（例如后台评审）正在运行时，它不评判任何评审项，并会说明这一点。等那个过程结束后再运行一次 drain。
3. 像 `score --push` 一样发布每个待发布的标签，并像 `teamai pull` 一样发布运行当时没能发布的工作流运行记录。
4. 当前模式的 `publish` 为 `auto` 时，把该模式下已结束、尚未归档的已捕获会话，以及在这里驱动的运行中尚未归档的步骤会话，脱敏后归档到 `teamai-reports`。无法从这里归档的步骤会话（teamai 读不到其工具的会话，或本机读不到这个会话）只列出一次已跳过及原因，之后不再重试。该运行的其他步骤会话照常归档。
5. 像 `teamai pull` 一样把用量上报到 `stats/<member>.yaml`，让临时 runner 的计数到达团队。
6. 输出剩下的工作：评分器固定的模型本机没有评审工具能运行（`judge_model_unavailable`），或本机达不到其隔离要求的评审项；本机没有安装评审工具时，是所有未完成的评审项。它们等待其他 driver 的 `score --next`。

drain 只结束并发布与其运行模式相同的会话，因此在不处于无人值守模式的机器上，要处理无人值守会话，请运行 `TEAMAI_MODE=unattended teamai score --drain`。

在这里没有能做的事时，drain 以 0 退出，留给其他 driver 的评审项也算在内。评审、发布或用量上报失败时以 1 退出。发布或上报失败的内容保持待发布，下一次 `--drain` 会重试。评审失败是最终结果：drain 输出这次失败，但从不重试。要重新请求评审，运行 `teamai score --session <id> --source <platform> --scorer <name>`。

drain 在哪里运行，决定它看到的调用会话是什么样子：

```text
CI job:  claude -p "…"  →  tool exits  →  teamai score --drain      # 任务的最后一步：会话已完整
skill:   … last turn of an unattended session → teamai score --drain  # 会话此刻的样子
```

作为任务的最后一步、在工具退出后运行时，drain 看到的是完整的会话。在会话内部运行时，它按会话此刻的样子评判并发布该会话，之后的对话轮次不会再被评判或发布。

运行、评审尝试和租约都保存在 runner 的数据目录中。过期的会话租约或失败的评审尝试是最终结果，在 drain 之前被终止的 runner 会丢失那次评审。长期运行的虚拟机在每次任务结束时运行 `teamai score --drain`。

## 批量评审

```yaml
steps:
  - id: review
    prompt: Review the change.
    scorers: { names: [review-quality, test-coverage], batch: true }
```

同一轮中解析到相同工具和模型的评分器共用一个租约、一个证据目录和一个提示。租约列出 `scorers` 并带有 `batched: true`，答案为每个评分器给出一个标签：

```json
{"driver":{"kind":"t3","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"review-quality":{"label":"good","reasoning":"…"},"test-coverage":{"label":"thin","reasoning":"…"}}}
```

步骤的 `batch` 优先于工作流的 `defaults.scorers.batch`，后者优先于 [`scorers/scoring.yaml`](#隔离) 里的 `batch`。`--batch` 对 `--run` 起同样作用。每个标签记录 `judge.batched: true`。只要有一个标签不在对应评分器的列表中，整个答案都会被拒绝，租约保持打开。

## 隔离

```yaml
# scorers/scoring.yaml
isolation: verified
batch: true
```

`scorers/scoring.yaml` 存放团队的评分设置。`scorers/ops/scoring.yaml` 对启用了 `ops` 命名空间的成员生效（与该目录下的评分器相同），并替换根文件中同名的键。两个启用的命名空间都设置了 `isolation` 时，取最严格的一项。两者设置的 `batch` 不同时，这些成员拿不到评审任务，直到其中一个文件被修改。

团队的 `isolation`、评分器的 `isolation`，以及本作用域 `config.yaml` 中的 `scoring.isolation` 都可以要求 `verified`。取最严格的一项；默认是 `best-effort`。teamai 不认识的值按 `verified` 处理，并给出警告。`teamai doctor` 打印该级别、其来源、要求更高级别的评分器，以及本机每个评审工具能达到的级别：

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
| 其他版本 | `best-effort` | 同上 | 相同配置，未经验证。 |

`best-effort` 工具不能评判要求 `verified` 的评分器，[你自己的评审者](#用自己的评审者)低于所需级别时也不能。提示通过标准输入或文件传入。保留工具登录和受支持的模型切换设置。本机没有评审工具能运行评分器的模型时，评审任务保持打开，留给其他 driver，不改变工作流结果。由哪个工具评审见[选择评审者的模型](#选择评审者的模型)。

## 标签存放位置

| 路径 | 内容 |
|---|---|
| `<dataHome>/scores/labels.jsonl` | 本机的所有标签。 |
| `<dataHome>/scores/reasoning/` | 评审者的理由，每个标签一个文件。从不发布。 |
| `<dataHome>/scores/raw/` | 本机评审失败时的输出，保留到之后的评审尝试取代它。 |
| `<dataHome>/sessions/captures/` | 每个会话启动时的运行配置，由会话启动 hook 写入。会话文件消失一天后删除。 |
| `teamai-reports` 上的 `scores/<member>/<YYYY-MM>.jsonl` | 已发布的标签，每个评分器、评分标准、评分对象和评审类型只保留最新一条。推送成功前标签留在 `<dataHome>/scores/pending/`；关闭用量上报时一直留在那里。 |

标签从不进入运行或它的记录。工作流运行页面显示每一轮的标签，以及评审开销，与运行本身的 token 分开统计。本机的运行统计每一次评审尝试；成员发布的运行只统计产生了标签的评审。仪表盘的[评分器页面](dashboard.md#评分器scorers)按时间和配置显示每个评分器的通过率。
