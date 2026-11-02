# 自我改进

> 本文是 [TeamAI CLI 使用指南](../../usage-guide.zh-CN.md) 的一部分。

一个评分器反复判定同一类工作失败，说明团队的 harness 缺了点什么：一个 skill、一条 rule、一个 agent、一个 prompt、一个 hook、一个 MCP 服务、一个模型、团队文化，或 teamai 分发的其他任何东西。`teamai self-improvement run <scorer>` 把这些失败变成团队仓库上的一个 pull request：PR 修改这些资产，为每个失败加一个回归任务；一个 CI 任务在团队用的每个工具上证明这个修改修好了它们、也没有弄坏别的。

```text
review-quality failed 4 sessions this month, 2 of them also by hand

Monday 06:00   self-improvement job
  teamai self-improvement run review-quality --tools default=claude --sandbox
    plan      → 4 failures with the commit each started at, 0 tasks yet
    improve   → in a fresh clone of the team repo on teamai/self-improvement/review-quality:
                edits skills/code-review/SKILL.md and rules/backend.md, writes 4 tasks in benchmarks/regressions/tasks/,
                pushes the branch and opens its PR, or updates the one already open

On the PR      regressions job
  teamai pull --team-ref teamai/self-improvement/review-quality
  teamai benchmark run regressions --sandbox
              → every regression task, on claude and codex, on main and on the PR
  gh pr edit --body-file
              → the results in the PR body
```

PR 正文在 `<!-- teamai:regressions -->` 和 `<!-- /teamai:regressions -->` 之间得到的内容：

```markdown
## Regression benchmark
| Arm | Tool | Model (source) | Team | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-main | claude | tool default (team) | main 3f9c2ab | 12 | 3 | 9 | 0 | 0 | 0 | 0 | 0 | 0 | 25% (3/12) |
| claude-pulled | claude | tool default (team) | pulled 81d0e4c | 12 | 11 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 92% (11/12) |
| codex-main | codex | tool default (team) | main 3f9c2ab | 12 | 2 | 10 | 0 | 0 | 0 | 0 | 0 | 0 | 17% (2/12) |
| codex-pulled | codex | tool default (team) | pulled 81d0e4c | 12 | 10 | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 83% (10/12) |

| Arm | Median tokens (input + output) | Median duration | Cost |
| --- | --- | --- | --- |
| claude-main | 39800 (12) | 79.0 s (12) | 1.74 USD (12) |
| claude-pulled | 41200 (12) | 84.0 s (12) | 1.82 USD (12) |
| codex-main | unknown (0) | 91.0 s (12) | unknown (0) |
| codex-pulled | unknown (0) | 97.5 s (12) | unknown (0) |

| Task | claude-main | claude-pulled | codex-main | codex-pulled |
| --- | --- | --- | --- | --- |
| missed-null-check | 0% (0/3) | 100% (3/3) | 0% (0/3) | 100% (3/3) |
| retry-loop-unbounded | 0% (0/3) | 67% (2/3) | 0% (0/3) | 67% (2/3) |
| expired-token-accepted | 100% (3/3) | 100% (3/3) | 67% (2/3) | 67% (2/3) |
| … | | | | |

### How far each judge agrees with hand labels
| Scorer | Judge | Paired | Agree | Judge passed, member failed | Judge failed, member passed |
| --- | --- | --- | --- | --- | --- |
| review-quality | claude claude-opus-5-5 | 9 | 8 | 1 | 0 |
```

这样读：这个 PR 在两个工具上都修好了新任务（`*-main` 对比 `*-pulled`）；之前的 PR 修好的 `expired-token-accepted` 仍然通过；不报告 token 或费用的工具显示 `unknown` 而不是 0；发现这些失败的评审模型，在成员手工标注的 9 个会话里有 8 个和成员一致。一致率从不决定 PR 能否合并，它告诉评审者这些失败有多可信。

## teamai 读取什么

```console
$ teamai digest --json | jq '.data.failures[0]'
```

```json
{
  "failure": {
    "scorer": "review-quality", "cohort": "4be1c0d29a7f3e85",
    "judge": { "kind": "model", "tool": "claude", "model": { "id": "claude-opus-5-5", "isReported": true } },
    "rubric": { "sourceHash": "9d4c…", "teamRevision": "3f9c2ab…" },
    "label": "missed-bug", "score": 0, "scoredAt": "2026-10-28T09:12:44.000Z", "author": "alice",
    "source": "session", "subject": { "platform": "claude-code", "sessionId": "7c1e…" },
    "runMode": "attended",
    "agent": { "v": 1, "tool": { "name": "claude", "version": "2.1.312" }, "project": { "commit": "3f2c9a7…", "dirty": false }, "…": "…" },
    "used": { "skills": ["code-review"] }
  },
  "start": { "commit": "3f2c9a7…" },
  "session": { "name": "claude-code_review-the-retry-change_20261028" },
  "learnings": [
    { "id": "retry-loops-need-a-bound-2026-10-28-k3x9q2", "path": "/home/alice/.teamai/projects/…/teamai-learnings/learnings/retry-loops-need-a-bound-2026-10-28-k3x9q2.md" },
    { "id": "backend/null-checks-in-handlers-2026-10-22-a8c1d0", "path": "/home/alice/.teamai/projects/…/teamai-learnings/learnings/backend/null-checks-in-handlers-2026-10-22-a8c1d0.md" }
  ]
}
```

`digest --json` 输出一个信封 `{"data":{"window","scorers","failures"}}`，覆盖最近 30 天的标签，读法和看板的 [评分器页面](dashboard.md#评分器scorers) 相同：

| 键 | 内容 |
| --- | --- |
| `scorers[].cohorts[]` | 评分器的每一组度量，和评分器页面的划分一样：评分标准版本、来源、运行模式和评审者，带 `stats`。模型评审者的分组有 `agreement`：`handLabelled`、`paired`、`agree`、`judgePassedHumanFailed`、`judgeFailedHumanPassed`。 |
| `failures[]` | 每个失败的标签，每个对象、评分标准和评审者只取最新一条，按时间从新到旧。从不包含评审者的理由、prompt 或会话记录。[Benchmark](benchmarks.md) 的标签不在其中。 |
| `failure.subject` | 被评判的工作：会话是 `{ platform, sessionId }`，工作流 pass 是 `{ runId, step, pass }`。 |
| `start` | `{ "commit" }`：工作开始时的 commit，即它的 agent 记录的项目状态。`{ "refused": "tracked_changes" }`：开始时有已跟踪的文件被修改，没有哪个 commit 保存那个状态。`{ "refused": "not_recorded" }`：没有任何记录，比如 teamai 没看到开始的会话的手工标签。 |
| `task` | 本检出拉取到的、`source` 指向这个对象的 benchmark 任务：这个失败已经是回归任务了。 |
| `session.name` | 团队归档里有这个会话时，推送的会话名。 |
| `learnings` | 仅会话有：frontmatter 里 `session` 指向它的 learnings（`teamai contribute` 从那个会话写出），没有时是 `[]`。`id` 是 `learnings/` 下去掉 `.md` 的路径；`path` 是要读的文件。 |

回归任务在 `source` 里写明它来自哪个失败，这样 `digest` 和 `plan` 步骤能认出它已被覆盖。工作流 pass 的写法和标签里一样：

```yaml
# benchmarks/regressions/tasks/missed-null-check.yaml
schemaVersion: v1alpha1
title: Review approves a handler that drops its null check
prompt: |
  Review the change on this branch: it refactors src/handlers/session.ts. Report every bug it brings in.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
successCriteria: The review names the removed null check on session.user in src/handlers/session.ts as a bug.
source: { platform: claude-code, sessionId: 7c1e5a0b-2d4f-4c8e-9a61-3b7f0e2d9c45 }
```

```yaml
source: { runId: r38302f8e6a18c377, step: review, pass: 1 }   # a workflow pass instead
```

## 搭建

你需要：一个标签会到达 `teamai-reports` 的评分器（[评分器](scorers.md)）、CI 能克隆的套件项目，以及托管在 GitHub 上的团队仓库：证明 PR 的任务用 `gh` 写 PR 正文。一共三个文件，都在团队仓库里。

### 1. 回归套件

```yaml
# benchmarks/regressions/suite.yaml
schemaVersion: v1alpha1
name: regressions
description: Failures the team fixed in its prompts, skills and agents. Every change to them runs against all of them.
repo: https://github.com/acme/auth-service.git
defaults:
  tool: claude
matrix:
  tool: [claude, codex]
  team: [main, pulled]
repetitions: 3
timeout: 2h
setup:
  command: npm ci
```

`team: [main, pulled]` 就是改动前后：`main` 是团队的默认分支，`pulled` 是任务固定的版本，即 PR 的版本。`tool` 列出团队同步到的每个工具，这样改动在每个工具上都得到证明。先推送这个不带任务的文件：一次运行只会把任务写进团队仓库默认分支已有的套件。

### 2. 运行它的任务

```yaml
# .github/workflows/self-improvement.yml
on:
  schedule: [{ cron: "0 6 * * 1" }]
  workflow_dispatch:
    inputs: { scorer: { default: review-quality } }
concurrency: self-improvement
jobs:
  improve:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ secrets.TEAM_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      SCORER: ${{ inputs.scorer || 'review-quality' }}
    steps:
      - uses: actions/checkout@v5          # the suite's repo, with every commit a failure started at
        with: { repository: acme/auth-service, fetch-depth: 0, token: "${{ secrets.PROJECT_READ_TOKEN }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @anthropic-ai/claude-code
      - run: git config --global user.name acme-improver && git config --global user.email improver@acme.example
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude
      - run: npx teamai-cli pull
      - run: npx teamai-cli self-improvement run "$SCORER" --tools default=claude --sandbox
```

- `TEAM_TOKEN` 克隆团队仓库，并把提案分支推送上去；`PROJECT_READ_TOKEN` 读取套件仓库。下面的证明任务不需要推送：它在团队仓库里运行，用它自己的 `github.token` 克隆仓库并编辑 PR 正文。
- `--tools default=claude` 让 prompt 步骤在 Claude Code 上运行；`--sandbox` 声明这台 runner 是用完即弃的机器，那个步骤需要这一点：它不经询问就修改文件。
- `--suite` 指定 `benchmarks/regressions` 以外的套件，比如某个角色的 `--suite benchmarks/web/regressions`。

### 一次运行做什么

`self-improvement run` 以输入 `scorer` 和 `suite` 在本地驱动上启动工作流 `teamai-self-improvement`，就像 `benchmark run` 启动 `teamai-benchmark`。teamai 把它作为[默认工作流](workflow.md#默认工作流)提供：

| 步骤 | 作用 |
| --- | --- |
| `plan` | `teamai digest --json --scorer <scorer> --suite <dir> --proposal teamai/self-improvement/<scorer>`：在 `data.improvement` 里输出能作为任务起点的失败：[`digest --json`](#teamai-读取什么) 里这个评分器的失败中，记录了本检出也有的开始 commit、且团队仓库默认分支和提案上都还没有套件任务指向它的那些。每个对象只取一次，按时间从新到旧；`hasProposal` 表示 origin 上的提案是否还开着。 |
| `improve` | 它的 `if` 成立时运行：两个或以上失败，或者 origin 上有默认分支尚未包含的提案时再多一个。单个失败不构成规律，即使另一个失败已有合并的任务覆盖。它在团队仓库的全新克隆里运行，在 `teamai/self-improvement/<scorer>` 上并合并默认分支，或从默认分支新建这个分支（[`workspace: { team }`](workflow.md#团队工作区)）。agent 读每个失败、它的 learnings 和评分标准，修改资产，并为每个失败写一个任务。`deliver: pr` 推送分支并打开它的 PR，或更新已经打开的那个。 |

```console
$ teamai digest --json --scorer review-quality --suite benchmarks/regressions --proposal teamai/self-improvement/review-quality \
    | jq '.data.improvement | {hasProposal, failures: (.failures | length), covered, refused}'
{
  "hasProposal": true,
  "failures": 1,
  "covered": [
    "benchmarks/regressions/tasks/missed-null-check.yaml",
    "benchmarks/regressions/tasks/retry-loop-unbounded.yaml"
  ],
  "refused": [
    { "subject": { "platform": "claude-code", "sessionId": "9d2f…" }, "why": "tracked_changes" }
  ]
}
```

阈值就是 `improve` 的 `if`。要从一个失败开始，在团队仓库里用 `cp "$(npm root -g)/teamai-cli/workflows/teamai-self-improvement.yaml" workflows/` [覆盖默认工作流](workflow.md#覆盖默认工作流)，改这一行，推送并 pull。仪表盘读同一个 `if` 来判断评分器是否可以运行：

```diff
   - id: improve
     needs: [plan]
-    if: length(steps.plan.outputs.data.improvement.failures) >= 2 || (length(steps.plan.outputs.data.improvement.failures) >= 1 && steps.plan.outputs.data.improvement.hasProposal)
+    if: length(steps.plan.outputs.data.improvement.failures) >= 1
```

在同样的失败上再跑一次，第二次什么也不会打开：每个失败在提案分支上已经有任务，所以 `plan` 一个也不保留，`improve` 被跳过。同一评分器的新失败会更新同一个 PR，并保留它已有的任务。提案分支的各种情况：

| origin 上 | 下一次运行 |
| --- | --- |
| 分支和默认分支冲突 | `improve` 在 agent 开始前以 `merge_conflict` 失败。把默认分支合并进去，或者删掉它。 |
| 运行期间队友推送到了分支 | `improve` 以 `push_failed` 失败，不会覆盖那个提交。下一次运行从它开始。 |
| agent 改了 `teamai pull` 不会放置或会拒绝的文件 | `improve` 以 `push_failed` 失败并逐个列出文件：在 pull 放置的目录之外（单仓库模式下在 `.teamai/` 之外）、符号链接、不属于任何套件的 benchmark 文件，或 pull 会拒绝、而默认分支上原本接受的工作流、评分器、套件（比如 agent 删掉了某个工作流所用的评分器）。什么也不推送。 |
| PR 被 squash 合并，分支保留 | 分支内容和默认分支相同时，什么也不推送，也不打开 PR。 |
| PR 未合并就被关闭，分支保留 | 从分支继续，有新失败时打开一个新 PR。要放弃提案，关闭 PR 时一并删除分支。 |

想按自己的方式运行，就推送你自己的 `workflows/teamai-self-improvement.yaml`：它会替换 `self-improvement run` 用的默认工作流，`self-improvement run` 会给它输入 `scorer` 和 `suite`，所以它要声明这两个输入。`teamai list workflows` 显示当前生效的是哪一个。

### 3. 证明 PR 的任务

```yaml
# .github/workflows/regressions.yml
on: pull_request
concurrency: regressions-${{ github.event.pull_request.number }}
jobs:
  benchmark:
    runs-on: ubuntu-latest
    timeout-minutes: 150
    permissions: { contents: read, pull-requests: write }
    env:
      TEAM_REPO: ${{ vars.TEAM_REPO }}
      GH_TOKEN: ${{ github.token }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      HEAD_REF: ${{ github.head_ref }}
      PR: ${{ github.event.pull_request.number }}
    steps:
      - uses: actions/checkout@v5          # the suite's repo
        with: { repository: acme/auth-service, fetch-depth: 0, token: "${{ secrets.PROJECT_READ_TOKEN }}" }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install -g @anthropic-ai/claude-code @openai/codex
      - run: npx teamai-cli init "$TEAM_REPO" --scope workspace --agent claude --agent codex
      - run: npx teamai-cli pull --team-ref "$HEAD_REF"
      - run: npx teamai-cli benchmark run regressions --sandbox > done.json
      - if: always()
        run: npx teamai-cli digest --json > digest.json
      - if: always()
        run: |
          {
            echo '<!-- teamai:regressions -->'
            echo '## Regression benchmark'
            jq -r '.data.done.outputs.text // "The benchmark did not finish: see the job log."' done.json || echo 'The benchmark did not finish: see the job log.'
            echo
            echo '### How far each judge agrees with hand labels'
            echo '| Scorer | Judge | Paired | Agree | Judge passed, member failed | Judge failed, member passed |'
            echo '| --- | --- | --- | --- | --- | --- |'
            jq -r --arg ref "$HEAD_REF" '($ref | ltrimstr("teamai/self-improvement/")) as $mine | .data.scorers[] | select($mine == $ref or .scorer == $mine) | .scorer as $s | .cohorts[] | select(.agreement) | "| \($s) | \(.judge.tool) \(.judge.model.id // "") | \(.agreement.paired) | \(.agreement.agree) | \(.agreement.judgePassedHumanFailed) | \(.agreement.judgeFailedHumanPassed) |"' digest.json
            echo '<!-- /teamai:regressions -->'
          } > evidence.md
          gh pr view "$PR" -R "$GITHUB_REPOSITORY" --json body -q .body | perl -0pe 's/<!-- teamai:regressions -->.*?<!-- \/teamai:regressions -->\n?//gs' > body.md
          cat evidence.md >> body.md
          gh pr edit "$PR" -R "$GITHUB_REPOSITORY" --body-file body.md
      - name: Fail on a regression
        run: |
          jq -e '.data.done.outputs.table as $table
            | [$table.pairs[]? | select(.dimension == "team" and (.from | fromjson)[4] == {kind: "ref", ref: "main"} and (.to | fromjson)[4].kind == "pulled")] as $pairs
            | ($table.invalid | length) == 0
              and all($table.results[]?; .counts.not_run == 0)
              and ($pairs | length) > 0
              and ([$table.results[]?.tool | select(. != null)] - [$pairs[] | (.to | fromjson)[1]] | length) == 0
              and all($pairs[].tasks[]; .to.planned > 0 and .to.passed * .from.planned >= .from.passed * .to.planned)' done.json
```

它在每个 PR 上运行，人提的 PR 也一样，所以每次改动都会和之前修好的每个失败对比。它没有 `paths:` 过滤：被过滤跳过的必需检查在 GitHub 上会一直等待，会挡住所有不在这些路径里的 PR。PR 每推送一次就再跑一次，替换两个标记之间的部分；正文其余部分保持不变。`--team-ref "$HEAD_REF"` 把运行固定到 PR 的分支：`pulled` 组和套件的任务来自它，`main` 组来自 `main`。评审一致性表格在自我改进 PR 上只列这个 PR 针对的评分器，在人提的 PR 上列出所有评分器。最后一步在任何工具上有任务在 PR 上比在 `main` 上通过得少，有任务的检查无法运行或在改动前就通过、有试验没有运行，或者套件运行的某个工具没有 `main` 组和 PR 组的配对可以对比时，让任务失败：只看这些配对，所以去掉 PR 组或 `main` 组的套件也会让它失败。在团队仓库的合并规则里把这个任务设为必需，就能把没通过的改动挡在 `main` 之外。

Dashboard 的[自我改进页面](dashboard.md#自我改进self-improvement)跟踪每个提议和每个已合并的修改：它改了哪些资产、它在回归套件上每个工具的证明，以及合并前后评分器的通过率。

## 失败什么时候用不上

`plan` 在 `refused` 里列出这个评分器中无法作为任务起点的每个失败，并说明原因：

```json
"refused": [
  { "subject": { "platform": "claude-code", "sessionId": "9d2f…" }, "why": "tracked_changes" },
  { "subject": { "platform": "codex", "sessionId": "a0b1…" }, "why": "not_recorded" },
  { "subject": { "runId": "r9e0c1d2a3b4c5d6e", "step": "review", "pass": 2 }, "why": "not_in_checkout" }
]
```

| 失败 | 会变成任务吗？ | 原因 |
| --- | --- | --- |
| 从套件仓库的一个干净 commit 开始 | 会 | 任务从工作开始的地方开始。 |
| 开始时有已跟踪的文件被修改（`tracked_changes`） | 不会 | 没有哪个 commit 保存工作看到的状态。 |
| 没有记录开始（`not_recorded`） | 不会 | teamai 没看到开始的会话的手工标签，或者旧版 teamai 写的记录。 |
| 从本检出没有的 commit 开始（`not_in_checkout`） | 不会 | 它来自别的项目；给那个项目单独建一个回归套件，并在它的检出里运行任务。 |
| 已经有任务（列在 `covered` 里） | 不会 | 它已经是回归任务了，已合并或在打开的提案上。 |
| Benchmark trial 的失败 | 从不列出 | Benchmark 标签度量的是工具，不是团队的工作。 |

`digest` 只读 `teamai-reports` 上的标签。还在成员机器上等待发布的标签，要等 `teamai score --push` 发布后才看得到，这需要打开[用量上报](reporting.md)。
