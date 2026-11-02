# Self-improvement

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A scorer that keeps failing the same kind of work says the team's harness is missing something: a skill, a rule, an agent, a prompt, a hook, an MCP server, a model, the team culture, or anything else teamai delivers. `teamai self-improvement run <scorer>` turns those failures into one pull request on the team repo. The PR changes the assets, adds one regression task per failure, and a CI job proves on every tool the team uses that the change fixes them and breaks nothing.

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

What the PR body gets, between `<!-- teamai:regressions -->` and `<!-- /teamai:regressions -->`:

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

Read it as: the PR fixes the new tasks on both tools (`*-main` against `*-pulled`), `expired-token-accepted`, fixed by an earlier PR, still passes, a tool that reports no tokens or cost says `unknown` instead of 0, and the judge that found the failures agreed with members on 8 of 9 sessions they labelled by hand. The agreement never gates the PR; it tells a reviewer how much the failures can be trusted.

## What teamai reads

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

`digest --json` prints one envelope, `{"data":{"window","scorers","failures"}}`, for the last 30 days of labels, read as the dashboard's [Scorers page](dashboard.md#scorers) reads them:

| Key | Holds |
| --- | --- |
| `scorers[].cohorts[]` | Each measurement of a scorer, as the Scorers page splits them: rubric version, source, run mode and judge, with `stats`. A model judge's cohort has `agreement`: `handLabelled`, `paired`, `agree`, `judgePassedHumanFailed`, `judgeFailedHumanPassed`. |
| `failures[]` | Every failing label, the newest per subject, rubric and judge, newest first. Never a judge's reasoning, a prompt or a transcript. A [benchmark](benchmarks.md)'s labels are left out. |
| `failure.subject` | The work it judged: `{ platform, sessionId }` for a session, `{ runId, step, pass }` for a workflow pass. |
| `start` | `{ "commit" }`: the commit the work started at, as its agent recorded the project. `{ "refused": "tracked_changes" }`: tracked files were modified when it started, so no commit holds that state. `{ "refused": "not_recorded" }`: nothing recorded it, such as a hand label of a session whose start teamai did not see. |
| `task` | The benchmark task this checkout pulled whose `source` is this subject: the failure is a regression task already. |
| `session.name` | The name of the pushed session, when the team archive holds it. |
| `learnings` | Only for a session: the learnings whose frontmatter `session` names it (written by `teamai contribute` from that session), `[]` when none does. `id` is the path under `learnings/` without `.md`; `path` is the file to read. |

A regression task names the failure it came from in `source`, so `digest` marks it as `task` and the `plan` step lists it as covered. A workflow pass is named as a label names it:

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


## Set it up

You need a scorer whose labels reach `teamai-reports` ([Scorers](scorers.md)), the suite's project on a host CI can clone, and a GitHub-hosted team repo: the PR job uses `gh` to write the PR body. Three files, all in the team repo.

### 1. The regression suite

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

`team: [main, pulled]` is the before and after: `main` is the team's default branch, `pulled` the revision the job pinned, the PR's. `tool` lists every tool the team syncs to, so the change is proven on each. Push this file with no tasks first: a run writes tasks only into a suite the team repo's default branch has.

### 2. The job that runs it

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

- `TEAM_TOKEN` clones the team repo and pushes the proposal's branch to it; `PROJECT_READ_TOKEN` reads the suite's repo. The proof job below needs no push: it runs in the team repo, so its own `github.token` clones it and edits the PR body.
- `--tools default=claude` runs the prompt step on Claude Code; `--sandbox` declares the runner a machine to throw away, which that step requires: it edits files without asking.
- `--suite` names another suite than `benchmarks/regressions`, such as `--suite benchmarks/web/regressions` for a role's.

### What a run does

`self-improvement run` starts the workflow `teamai-self-improvement` with inputs `scorer` and `suite`, on the local driver, as `benchmark run` starts `teamai-benchmark`. teamai ships it as a [default workflow](workflow.md#default-workflows):

| Step | Does |
| --- | --- |
| `plan` | `teamai digest --json --scorer <scorer> --suite <dir> --proposal teamai/self-improvement/<scorer>`: prints in `data.improvement` the failures a task can start from: the scorer's failures in [`digest --json`](#what-teamai-reads) with a recorded start commit this checkout has, and no task of the suite naming them on the team repo's default branch or on the proposal. Each subject once, newest first, with `hasProposal`: whether the proposal is open on origin. |
| `improve` | Runs when its `if` holds: two failures or more, or one more for a proposal on origin that the default branch does not hold yet. A single failure is not a pattern, even when a task that landed covers another. It runs in a fresh clone of the team repo, on `teamai/self-improvement/<scorer>` with the default branch merged in, or a new branch from it ([`workspace: { team }`](workflow.md#the-team-workspace)). The agent reads each failure, its learnings and the rubric, changes the assets, and writes one task per failure. `deliver: pr` pushes the branch and opens its PR, or updates the one already open. |

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

The threshold is the `if` of `improve`. To start from one failure, [override the default](workflow.md#override-a-default) with `cp "$(npm root -g)/teamai-cli/workflows/teamai-self-improvement.yaml" workflows/` in the team repo, change that line, push and pull. The dashboard reads the same `if` to say whether a scorer is ready:

```diff
   - id: improve
     needs: [plan]
-    if: length(steps.plan.outputs.data.improvement.failures) >= 2 || (length(steps.plan.outputs.data.improvement.failures) >= 1 && steps.plan.outputs.data.improvement.hasProposal)
+    if: length(steps.plan.outputs.data.improvement.failures) >= 1
```

Run it twice on the same failures and the second run opens nothing: each failure has its task on the proposal's branch, so `plan` keeps none and `improve` is skipped. A new failure of the same scorer updates the same PR, keeping the tasks it had. What happens to the proposal's branch:

| On origin | The next run |
| --- | --- |
| The branch conflicts with the default branch | Fails `improve` with `merge_conflict` before the agent starts. Merge the default branch into it, or delete it. |
| A teammate pushed to the branch while the run worked | Fails `improve` with `push_failed`, and pushes nothing over that commit. The next run starts from it. |
| The agent changed a file `teamai pull` would not place or would reject | Fails `improve` with `push_failed`, naming each file: outside the directories pull places (outside `.teamai/` in single-repo mode), a symlink, a benchmark file in no suite, or a workflow, scorer or suite pull rejects and did not reject on the default branch, such as a workflow whose scorer the agent deleted. Nothing is pushed. |
| The PR was squash-merged, and the branch kept | Pushes nothing and opens no PR while the branch holds what the default branch holds. |
| The PR was closed without merging, and the branch kept | Goes on from the branch, and opens a new PR when it has new failures. Delete the branch with the PR to drop the proposal. |

To run it your way, push your own `workflows/teamai-self-improvement.yaml`: it replaces the default for `self-improvement run`, which gives it the inputs `scorer` and `suite`, so it declares both. `teamai list workflows` shows which one is in effect.

### 3. The job that proves the PR

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

It runs on every PR, a person's too, so every change is measured against every failure fixed before. It has no `paths:` filter: GitHub leaves a required check that a filter skipped pending, which would block every PR outside those paths. Each push to the PR runs it again and replaces the section between the two markers; the rest of the body stays. `--team-ref "$HEAD_REF"` pins the run to the PR's branch: the `pulled` arms and the suite's tasks come from it, the `main` arms from `main`. The judge agreement table lists the scorer a self-improvement PR is for, and every scorer on a person's PR. The last step fails the job when a task passes less often on the PR than on `main` with any tool, when a task's check could not run or passed before any change, when a trial did not run, or when a tool the suite runs has no pair of a `main` arm and a PR arm to compare: only those pairs count, so a suite that drops the PR's or `main`'s arms fails it. Mark the job required in the team repo's merge rules to keep a change that fails it out of `main`.

The dashboard's [Self-improvement page](dashboard.md#self-improvement) follows each proposal and each landed change: the assets it touched, its proof on the regression suite per tool, and the scorer's pass rate before and after it landed.

## When a failure is not used

`plan` lists each failure of the scorer it cannot start a task from in `refused`, with why:

```json
"refused": [
  { "subject": { "platform": "claude-code", "sessionId": "9d2f…" }, "why": "tracked_changes" },
  { "subject": { "platform": "codex", "sessionId": "a0b1…" }, "why": "not_recorded" },
  { "subject": { "runId": "r9e0c1d2a3b4c5d6e", "step": "review", "pass": 2 }, "why": "not_in_checkout" }
]
```

| Failure | Becomes a task? | Why |
| --- | --- | --- |
| Started on a clean commit of the suite's repo | Yes | The task starts where the work did. |
| Started with tracked files modified (`tracked_changes`) | No | No commit holds the state the work saw. |
| No start recorded (`not_recorded`) | No | A hand label of a session teamai did not see start, or a record from an older teamai. |
| Started on a commit this checkout lacks (`not_in_checkout`) | No | It came from another project; give that project its own regression suite, and run the job in its checkout. |
| Has a task already (listed in `covered`) | No | It is a regression already, merged or on the open proposal. |
| A benchmark trial's | Never listed | Benchmark labels measure the tools, not the team's work. |

`digest` reads only labels on `teamai-reports`. A label still pending on a member's machine is not seen until `teamai score --push` publishes it, which needs [usage reporting](reporting.md) on.
