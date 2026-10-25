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

| `can.judge` | 含义 |
|---|---|
| `isolation` | `verified` 或 `best-effort`。只租出它满足[所需级别](#隔离)的任务。 |
| `access` | 评审者能做什么：`answer`（不用工具）、`read`（读取证据）或 `full`（任意工具，默认值）。标签会记录该值。 |
| `tools` | 按你的偏好排序。首个能解析评分器模型的工具胜出。 |

评分器未列出的标签会被拒绝，租约保持打开。`running` 列出你仍在评判的租约，从而续期；租约在领取或续期 30 分钟后过期。不要把评审租约放进 `workflow next` 的 `running`。所有字段见 `teamai score --help`。

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

### 已结束的会话

成员在 `config.yaml` 中设置 `scoring.sessions: true` 后，该作用域捕获的每个会话在六小时内没有任何活动时，就成为评审工作，由每个设置了 `sessions: true` 的评分器按其 `samplingRate` 抽样评判。命名空间中的评分器只在会话每次启动时记录的角色和项目都使该命名空间生效时，才评判该会话。`score --next` 先分发工作流的评审工作，再分发会话。会话租约带有 `"source":"session"`，其 `cwd` 是提交答案时所在的目录。

团队可以在 `scorers/scoring.yaml` 或某个生效命名空间的 `scoring.yaml` 中设置 `sessions` 和 `daily_limit`，命名空间的设置覆盖根文件。两个生效命名空间不一致时，`sessions: false` 和最低的 `daily_limit` 生效。成员的 `config.yaml` 覆盖以上所有设置。

每个会话对同一评分器和评分标准只评判一次。释放、过期或本地评审失败都会关闭它。过期租约的答案仍会被记录，除非之后已有评审者为该会话打了标签。`config.yaml` 中的 `scoring.daily_limit` 设置每个数据目录每个本地日最多租出多少个会话，默认 10，失败或无法读取的会话也计入。`0` 关闭会话评分。修改评分器的评分标准后，已捕获的会话会重新成为它的评审工作，每日上限会把这些工作分摊到之后几天。

你不需要自己运行 driver。会话启动时的 pull 之后，如果会话所在项目或你的用户作用域开启了会话评分，teamai 会为这两个作用域在后台启动评审。它用本机安装的评审工具评判每个已结束的会话，30 分钟后不再领取新工作，标签保持待发布，由下一次 `teamai pull` 发布。每个租约是一次在你账号上的评审调用，每天最多 `daily_limit` 次。会话评分器指定便宜的[模型别名](#选择评审者的模型)（例如 `model: fast`）可以控制成本。要停止，在 `config.yaml` 中设置 `scoring.sessions: false`。

后台评审使用 `teamai init` 记录的工具主目录，例如移动过的 `CLAUDE_CONFIG_DIR`。它看不到只在你的 shell 中设置的凭据或 base URL，在 Windows 上尤其如此。请把它们放在工具的登录状态、用户环境变量或工具 `settings.json` 的 `env` 中。

比当前版本更旧的 teamai 会拒绝带有 `sessions: true` 的评分器，因此团队添加这样的评分器之前，请先在每位成员的机器上更新 teamai。在你的机器上领取评审工作的旧版 teamai（例如某个驱动自带的副本）会删除会话租约的评分标准，因此开启 `scoring.sessions` 之前，请先更新机器上的每一份 teamai。

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
| CodeBuddy | `best-effort` | `full` | 只读工具，不加载 MCP，不保存会话。无论 `--tools` 如何设置，它都会列出约 70 个工具。未登录时以 `judge_tool_unavailable` 失败。 |
| 其他版本 | `best-effort` | 同上 | 相同配置，未经验证。 |

`best-effort` 工具不能评判要求 `verified` 的评分器。提示通过标准输入或文件传入。保留工具登录和受支持的模型切换设置。本机没有评审工具能运行评分器的模型时，评审任务保持打开，留给其他 driver，不改变工作流结果。由哪个工具评审见[选择评审者的模型](#选择评审者的模型)。

## 标签存放位置

| 路径 | 内容 |
|---|---|
| `<dataHome>/scores/labels.jsonl` | 本机的所有标签。 |
| `<dataHome>/scores/reasoning/` | 评审者的理由，每个标签一个文件。从不发布。 |
| `<dataHome>/scores/raw/` | 本机评审失败时的输出，保留到之后的评审尝试取代它。 |
| `<dataHome>/sessions/captures/` | 每个会话启动时的运行配置，由会话启动 hook 写入。会话文件消失一天后删除。 |
| `teamai-reports` 上的 `scores/<member>/<YYYY-MM>.jsonl` | 已发布的标签，每个评分器、评分标准、评分对象和评审类型只保留最新一条。推送成功前标签留在 `<dataHome>/scores/pending/`；关闭用量上报时一直留在那里。 |

标签从不进入运行或它的记录。工作流运行页面显示每一轮的标签，以及评审开销，与运行本身的 token 分开统计。本机的运行统计每一次评审尝试；成员发布的运行只统计产生了标签的评审。
