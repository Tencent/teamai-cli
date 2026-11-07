# Benchmarks

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

```text
teamai benchmark run fix-auth --sandbox
```

A benchmark suite compares tools or models on your team's own tasks. One run gives every task to every arm, a few times each, checks each result, and prints a table. Trials run only on a machine declared a sandbox, such as a CI runner or a container.

A benchmark run is a run of the workflow `teamai-benchmark`, which teamai ships and a team can replace. See [The benchmark workflow](#the-benchmark-workflow).

## Write a suite

A suite is a directory in the team repo: `benchmarks/<suite>/suite.yaml`, and one file per task in `tasks/`.

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

| Key | Value |
| --- | --- |
| `repo` | The project the tasks start from: an https, ssh or git URL without credentials. |
| `defaults` | The arm the others are compared with: `tool`, and optionally `model`, `team`, `workflow` and `role`. Not a workflow's `defaults`. |
| `arms` | 1 to 6. Each changes at most one `defaults` key, and at most one changes none. |
| `matrix` | Instead of `arms`: lists of values that teamai crosses into arms. See [Cross tools with team assets](#cross-tools-with-team-assets). |
| `team` | The team assets an arm runs with. See [Arms on other team assets](#arms-on-other-team-assets). |
| `workflow` | A team workflow each trial runs on the task, instead of one prompt. See [Arms that run a workflow](#arms-that-run-a-workflow). |
| `role` | A role from `manifest/roles.yaml` each trial's clone runs with. See [Arms that run as a role](#arms-that-run-as-a-role). |
| `recall` | Whether the arm's trial clones get the team's recall deployment, which every workflow clone leaves off. See [Arms that run with recall](#arms-that-run-with-recall). |
| `model` | A model alias from `models/aliases.yaml`, resolved for each arm's tool when the run starts, or a model name. |
| `repetitions` | 1 to 10, 3 by default. |
| `parallel` | 1 to 32 lanes that baselines and trials run in, 1 by default. See [Parallel lanes](#parallel-lanes). |
| `timeout` | Required: the whole run's. |
| `trial` | Optional limits of every trial's prompt. See [Trial limits](#trial-limits). |
| `setup` | Optional, a [workflow's `setup`](workflow-advanced.md#requirements-and-limits). Runs in every fresh clone before the tool or the check. |
| `scorers` | Optional [scorers](scorers.md) that judge every trial. A name with no valid `scorers/<name>.md` fails `teamai review --branch`, `teamai pull` warns, and start refuses the suite. |

### Arms on other team assets

An arm runs with the team revision this checkout pulled unless it sets `team`. Measure what the team's assets add, a branch before you merge it, or one skill:

```yaml
defaults:
  tool: claude
arms:
  - name: pulled              # the revision you pulled
  - name: bare
    team: none                # no team assets at all
  - name: next
    team: next                # the team repo's branch next
  - name: no-auth-tokens
    team:
      without: [skills/auth-tokens]  # the pulled revision, without this skill
```

| `team` | The arm runs with |
| --- | --- |
| `pulled`, or no `team` | The team revision this checkout pulled. |
| `none` | No team assets. Start refuses it on a machine whose user-scope teamai install delivers to the arm's tool, since its trials would read those assets in your home. |
| A branch, tag or commit | That revision of the team repo, resolved when the run starts. Name a branch as the team repo names it, `next`, not `origin/next`. |
| `without: [<path>, ...]` | The pulled revision, without these files and directories of the team repo. See [Leave team assets out](#leave-team-assets-out). |

`skillChanges` in the record lists, for each arm on another revision or `without` paths, the team skills it adds, removes or changes against the pulled revision, and the results show how often each arm loaded them. See [Results](#results).

### Leave team assets out

`without` takes paths in the team repo, as git lists them: a skill, a rule, an agent, a `claudemd/` (or `agentsmd/`) file, a doc, a whole namespace directory, or any other file, such as `hooks/hooks.yaml`:

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

The run plans every arm first, as pull would deliver to you, with your roles, projects, tags and excluded skills. It refuses an arm, and starts no run, when:

| `without` lists | Because |
| --- | --- |
| A path the pulled revision does not have, or `teamai.yaml` | There is nothing to leave out, or no trial could install the team. |
| A path inside another path it lists | List only the outer one. |
| A path under `skills/`, `rules/`, `agents/`, `claudemd/` (or `agentsmd/`), or `docs/` that pull delivers the same with or without | Leaving it out changes nothing. The message says why: a namespace your roles or projects do not receive, a shared skill they receive only through a tag you do not subscribe to, a skill you exclude, a rule tagged only with tags you do not subscribe to. |
| A shared path a namespace you receive delivers in its place | The namespace copy still reaches the trial: the message says `list skills/ops/release too`. |

A path anywhere else only has to exist. A `without` path removes a whole file: to leave out one entry inside a shared file, such as one MCP server, hook, env key or model alias, push a branch of the team repo without it and name the branch:

```yaml
arms:
  - name: pulled
  - name: no-github-mcp
    team: no-github-mcp       # a team repo branch whose mcp/mcp.yaml drops the github server
```

Benchmarks do not run in single-repo mode, where the project's own commit decides the team assets: the run refuses every arm with `team_ref_blocked`.

### Arms that run a workflow

An arm with `workflow` runs a team workflow on each task instead of one prompt. The workflow takes the task's prompt as its input `task`:

```yaml
defaults:
  tool: claude
arms:
  - name: prompt
  - name: plan-then-fix
    workflow: plan-then-fix   # workflows/plan-then-fix.yaml, with inputs: { task: string }
```

The run reads the workflow, and the workflows it runs, at the arm's team revision, through the namespaces you receive like any team workflow, and runs every prompt step in it on the arm's tool, model and effort, unattended as the trial's own prompt would be. It refuses the arm (`arm_workflow_unrunnable`) when the workflow takes no input `task`, requires another input, or has `finally` steps, when a step of it delivers, asks a person, opens a workspace other than `continue`, runs a workflow per item of a `for_each` with `workspace: continue`, or runs `workflow: { from }`, or when a prompt of it runs an `agent` and the arm sets no `model`, as the agent's own model could replace the tool's default (set `model` in `defaults`: an arm with `workflow` changes no other key), and with `workflow_namespace_conflict` when two namespaces you receive both have it. The trial's check, or its judge, decides on what the workflow left in the clone. Its duration is the sum of its prompt turns, its tokens and cost the sum of its prompts'. [Trial limits](#trial-limits) `timeout` and `budget` are what its prompts may spend together; `max_turns` is not enforced, and is listed in `unenforced`.

### Arms that run as a role

Does a reviewer's knowledge catch more than a frontend developer's on the same change? Give each arm a role:

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

Both arms run the same tool, model and team revision. Each trial's clone gets its arm's role the way a [clone step with `role`](workflow-advanced.md#run-a-clone-as-a-team-role) does: that role's skills, rules, agents, docs and other knowledge, with your projects, and your own hooks, MCP servers, env and models. The record keeps the role on the arm, and on each trial the role its clone was delivered for:

```json
"arms": [
  { "name": "frontend", "tool": "claude", "model": "claude-opus-5-5", "alias": "strong", "source": "team", "team": { "kind": "pulled", "revision": "3f9c2ab…" }, "role": "frontend" },
  { "name": "review", "tool": "claude", "model": "claude-opus-5-5", "alias": "strong", "source": "team", "team": { "kind": "pulled", "revision": "3f9c2ab…" }, "role": "review" }
],
"trials": [
  { "task": "orders-report", "arm": "review", "result": "passed", "agent": { "team": { "revision": "3f9c2ab…", "selection": { "primaryRole": "frontend", "stepRole": "review", … } }, … }, … }
]
```

The results the run prints gain a Role column:

```text
| Arm | Tool | Model (source) | Role | Planned | Passed | Failed | Error | Unscored | Not run | Stopped by a limit | Deviations | Not verified | Pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| frontend | claude | claude-opus-5-5 (team) | frontend | 6 | 2 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 33% (2/6) |
| review | claude | claude-opus-5-5 (team) | review | 6 | 5 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 83% (5/6) |
```

A trial whose clone ran with another role than its arm's counts under Deviations, and one whose record names no role under Not verified. An arm without `role` in a suite that has role arms reads `member's roles`: it runs with your own. On the dashboard's [Benchmarks page](dashboard.md#benchmarks), each arm shows `review role` under its name, and **Compare**, by **Role**, reads `review role against frontend role`, paired trial by trial.

The run checks each arm's role in `manifest/roles.yaml` at the team revision the arm runs on, and refuses one it does not declare before any trial runs:

```text
role_unavailable: Arm "review" runs with role review, which manifest/roles.yaml at team revision 3f9c2ab does not declare; it declares frontend, backend. Add the role to manifest/roles.yaml, or fix the arm's role, push it, run teamai pull, and start again.
```

An arm with a role needs team assets for it to select, so the suite refuses `role` with `team: none`. A matrix crosses roles too: `matrix: { tool: [claude, codex], role: [frontend, review] }` makes `claude-frontend`, `claude-review`, `codex-frontend` and `codex-review`. Compare then pairs the two roles on each tool, and the two tools within each role, never a pair that differs in both.

### Arms that run with recall

Does the team's recall help a task at all — say, because a rule declares what its docs and code pages are about? Give the arms recall. Recall is off in a trial's clone, as in every workflow clone; `recall: true` turns it on for that arm's clones, so its sessions see `Related:` lines on the assets they load:

```yaml
schemaVersion: v1alpha1
name: relations-help
description: Do declared relations help a fix land.
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

Both arms run with recall, so the only thing between them is the relation: the second runs without the rule that declares it. A suite needs its arms to differ in a `defaults` key — `recall` is not one, since it is a measurement's control rather than a value the page compares — so the arms differ in their `team` instead.

`recall` never counts as a changed `defaults` key, and the matrix cannot cross it. Leave it out and the arm runs as every workflow clone does, without recall.

The record keeps `recall` on the arm, so a later comparison can tell a run that measured recall from one that did not, and the results gain a Recall column once an arm runs with it:

```text
| Arm | Tool | Model (source) | Recall | Planned | Passed | … |
| --- | --- | --- | --- | --- | --- | --- |
| with-relations | claude | claude-opus-5-5 (team) | on | 6 | 4 | … |
| without-relations | claude | claude-opus-5-5 (team) | on | 6 | 1 | … |
```

An arm that leaves it out reads `off`.

### Cross tools with team assets

`matrix` makes one arm for each combination of its values, so every two arms that differ in one value compare that value alone. Here, how much the team's assets help each tool, and which tool does better with them:

```yaml
defaults:
  tool: claude
matrix:
  tool: [claude, codex]
  team: [pulled, none]
```

| Arm | Tool | Team |
| --- | --- | --- |
| `claude-pulled` | claude | pulled |
| `claude-none` | claude | none |
| `codex-pulled` | codex | pulled |
| `codex-none` | codex | none |

A matrix varies `tool`, `model`, `team`, `workflow` or `role`, at least one of them with two values or more, and makes 2 to 12 arms. A key it leaves out comes from `defaults`. Each arm's name joins its values for the keys that vary: a ref is used as it is, with a character other than a letter, digit, `-` or `_` written `-`, and `without: [skills/auth-tokens]` is `without-skills-auth-tokens`. A suite has `arms` or `matrix`, not both.

A task starts from a full commit of `repo` and is decided by exactly one of `check` and `successCriteria`:

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
successCriteria: The error names the wrong field and still reveals nothing about which accounts exist.
```

| Key | Value |
| --- | --- |
| `startingCommit` | The full commit of `repo` the task starts from. |
| `solutionCommit` | Optional: the full commit with the task's reference solution. [`benchmark try`](#try-a-task) checks the check passes there, and `check.add` reads its files from it. |
| `check` | `run`, a command that exits 0 once the task is done, and `protect`, the paths the agent must not supply. |
| `check.add` | Optional: files written before the check that the agent never has: a file as `solutionCommit` has it, such as the solution's test, or `{ from, to }`, a file or directory of the suite directory. A directory adds every file under it except its dot entries, such as `.DS_Store`; name a dotfile in `from` to add it. See [Tests the solution brought](#tests-the-solution-brought) and [Tests in the suite directory](#tests-in-the-suite-directory). |
| `successCriteria` | Instead of `check`: a judge decides from these. |
| `covers` | Optional: the team repo paths the task's work is expected to need, as [`without`](#leave-team-assets-out) takes them. The [asset effect](#asset-effect) tables split an arm that runs without one of them by the tasks that cover it. |
| `source` | Optional: where the task came from: a session's `platform` and `sessionId`, or a workflow pass's `runId`, `step` and `pass`. Nothing runs from it; [`digest --json`](self-improvement.md#what-teamai-reads) marks the failure it names as covered. |

`teamai pull` and `teamai review --branch` check every file and report each problem with its file and line. A suite in `benchmarks/<namespace>/<suite>/` goes only to members of that role or project, as [Roles and projects](distribution.md#roles-and-projects) describes.

### What `protect` covers

A trial passes when the check exits 0 after the agent's work. Before the check, teamai puts every `protect` path back as the starting commit has it:

```text
the agent left                       the check sees
src/auth/refresh.ts       edited     edited
test/auth/session.test.ts edited     as 3f2c9a7 has it
test/helpers/skip.js      added      deleted
vitest.config.ts          edited     as 3f2c9a7 has it
```

So `protect` lists everything the check reads that the agent must not supply: the tests, the test config, the scripts and helpers they load, and the package manifest and lockfile.

| Do not protect | Why |
| --- | --- |
| A path `setup` writes into, such as a build directory | The restore deletes what setup wrote there. |
| Files git converts on checkout: Git LFS files, files with an `eol=crlf` attribute | Each protected file must hold exactly the bytes the starting commit stores, so the trial ends in `error`. |
| A path in or under a submodule | teamai cannot put a submodule's files back, so the trial ends in `error`. |

A task whose check reads things you cannot list belongs in `successCriteria`.

### Tests the solution brought

When the solution brought the test that proves it, list that test file in `check.add`, also when the solution only added a case to a file the starting commit has. The check reads it as `solutionCommit` has it; the agent never does:

```text
step                          test/auth/refresh.test.ts
the agent's clone             absent
trial check                   protect restored, then written from 9a1d4e7
baseline at 3f2c9a7           written from 9a1d4e7: the check must fail
try at 3f2c9a7                written from 9a1d4e7: the check must fail
try at 9a1d4e7                protect restored, then written from 9a1d4e7: the check must pass
```

| `teamai pull` and `teamai review --branch` refuse | Because |
| --- | --- |
| `check.add` without `solutionCommit` | The files come from `solutionCommit`. |
| A `check.add` path no `protect` entry matches | The agent could supply it. |
| A glob in `check.add` | Each entry names one file. |

### Tests in the suite directory

A test the task's commits do not have, such as one you wrote for the task, can live in the suite directory. A `{ from, to }` entry of `check.add` writes it where the check reads it, at the same steps as a solution's test; the agent never has it:

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

`from` is a file or a directory of the suite directory; a directory writes every file under it below `to`. Each file is written as bytes, with its executable bit. `teamai pull` keeps the files with the suite, and a run writes them as they were when it started, so a pull during the run changes no check. Editing one changes the task's `sourceHash`. The entry needs no `solutionCommit`.

| `teamai pull` and `teamai review --branch` refuse | Because |
| --- | --- |
| A `from` that names nothing in the suite directory, leaves it, or is a symlink | Only the suite directory's own files are read. |
| A `to` with `..` or a glob | It names one path in the clone. |
| A `to`, or a file under it, that no `protect` entry matches | The agent could supply it. |
| Two entries that write one path | Each path is written once. |

### Baselines

Before a task's first trial, teamai runs setup, writes the task's `check.add` files and runs the check once, on a fresh clone of the starting commit:

| The check at the starting commit | The task |
| --- | --- |
| fails | Valid: its trials run. |
| passes | `invalid: check passes without changes`, no trials. |
| cannot run | `check could not run`, no trials. |

| A check cannot run when | It is read as |
| --- | --- |
| it exits 127 | `not_found` |
| it exits 126 | `not_executable` |
| it exits 129 to 192, outside Windows | `signal`: a shell reports a killed command as 128 plus the signal. Do not use these as your check's own failure code. |
| it runs past the timeout | `timeout` |

After a prompt, a check that cannot run gives the trial `error`, not `failed`.

### Trial limits

`trial` limits every trial's prompt. Reaching a limit ends the agent's turn, and teamai runs the trial's check, or its judges, on what the agent left, so a tool that runs out of time fails the task rather than the harness:

```yaml
timeout: 45m
trial:
  timeout: 8m
  budget: { tokens: 300000 }
  max_turns: 60
```

| Key | Limits | On the local driver |
| --- | --- | --- |
| `timeout` | The time from the tool's launch. Shorter than the suite's `timeout`, which still ends the whole run. | Stops the tool and every process it started. |
| `budget.tokens` | Input plus output tokens, as a [workflow budget](workflow-advanced.md#requirements-and-limits) counts them. | Counts them from the tool's output as it runs, and stops the tool once they pass the budget, so a trial can go over by its last model call. Codex states its tokens only as it ends, and CodeBuddy's are not counted as it runs: both run to the end, and list `budget` in `unenforced`. A tool that reports no tokens ends its trial `error`, unless another limit stopped it first: then its trial lists `budget` in `unenforced`. |
| `max_turns` | Agent turns, as the tool counts them. | Passes it to Claude. Other tools list `max_turns` in `unenforced`. |

A trial a limit stopped carries `limit` in the record, and counts under "Stopped by a limit". A trial that lists a suite limit in `unenforced` counts as a deviation, so a capped arm is never compared with an uncapped one silently. A driver that cannot end a turn at all runs the trial with the limits as a hard deadline and lists `on_limit` in `unenforced`. A run keeps the limits it started with.

## Try a task

Try a new task file before it joins the suite, in a checkout of the suite's `repo`, with the team repo checked out beside it:

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

`benchmark try` reads the task file and the `suite.yaml` two directories up from it as they are written, and validates both as `teamai pull` does, with the files its `check.add` entries name from that suite directory. It needs no `teamai init`. A commit the checkout lacks is fetched by SHA from the suite's `repo`, as a run does. Each commit gets a fresh clone, the suite's `setup`, the environment a trial gets (see [Run a suite](#run-a-suite)), and the suite's `timeout`. It creates no run and no record. The check runs the project's code on your machine, so try only tasks you trust.

## Turn a session into a task

Work you finished with your agent, a bug fix, a feature or a refactor, is the best task a suite can get: real work, in your code, with the commit that proves it can be done. Ask the session that did it to keep it:

```text
you:    turn this fix into a benchmark task
agent:  teamai workflow start --describe teamai-session-to-task --driver skill
        proposes session 7c1e…, source claude-code, suite benchmarks/fix-auth,
                 start 3f2c9a7…, solution 9a1d4e7…
you:    ok, but ask me at optional approvals
agent:  drafts the task with you: the bug as you first described it, the check, the test the solution brought
agent:  Propose benchmarks/fix-auth/tasks/refresh-race.yaml to the team as a pull request?
you:    yes
step:   copies the file to benchmarks/fix-auth/tasks/refresh-race.yaml in a fresh clone of the team repo
        pull request https://github.com/acme/team/pull/77 from teamai/session-to-task/benchmarks/fix-auth/refresh-race
```

The pull request adds one file:

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

The session drafts it because it already knows what you asked and how it was done; no transcript is read back. `check.add` keeps the solution's test out of the trial's clone (see [Tests the solution brought](#tests-the-solution-brought)), and the prompt names the function that test calls, so the task can be solved without seeing it.

Other sessions draft other tasks:

| The session | The task it drafts |
| --- | --- |
| Fixed a bug and added `test/auth/refresh-race.test.ts` | `check` with `add: [test/auth/refresh-race.test.ts]`, as above |
| Fixed a bug and added a case to `test/auth/refresh.test.ts` | `check` with `add: [test/auth/refresh.test.ts]`: the file as the solution has it, case included |
| Fixed a layout bug no test covers | `successCriteria: "The checkout button stays visible at 320 px wide."`, judged by a model |
| Added `POST /sessions/revoke-all` with `test/auth/revoke-all.test.ts` | `check` with `add: [test/auth/revoke-all.test.ts]`; the prompt names the endpoint and what it returns, as the test calls it |
| Moved token storage behind `TokenStore`, behavior unchanged | `successCriteria: "Every read and write of tokens goes through TokenStore; the auth tests still pass."`: the tests pass before the change too, so a `check` could not tell it from no change |
| Was exploring, with nothing committed | Nothing: you say it is not a good task, the run ends, no pull request |

### What describe proposes

describe fills every input for the calling session, and says why, also when it proposes nothing:

| Input | Proposed | Not proposed when |
| --- | --- | --- |
| `session`, `source` | this session and its tool | no agent session: no input gets a value |
| `start` | the commit this session's first start recorded | the session started with tracked files modified, or teamai recorded no start (a resume does not count) |
| `solution` | `HEAD` | `HEAD` is still `start`, tracked files are modified, or there is no `start` |
| `suite` | the one suite whose `repo` is this checkout's `origin`: `benchmarks/fix-auth`, or `benchmarks/web/fix-auth` in a namespace | no suite, or several, match `origin` |

```text
start     HEAD         proposal
3f2c9a7   9a1d4e7      both
3f2c9a7   3f2c9a7      start only: "No value: HEAD is still the starting commit. Commit the change, then ask again, or give the commit."
3f2c9a7   9a1d4e7 *    start only: "No value: tracked files are modified. Commit the change, then ask again, or give the commit."
(none)    9a1d4e7      neither: give both
```

`solution` is the commit that completes the task, whatever the work was: the fix, or the feature's or refactor's commit. The task keeps it as `solutionCommit`. When a task of that suite already comes from this session or this commit, the why of `session` or `solution` names it, for example `benchmarks/fix-auth/tasks/refresh-race.yaml already comes from it.`, so the same work is not proposed twice.

| How you start it | Who answers "Propose … as a pull request?" |
| --- | --- |
| The recommended option | Your agent, which says why; the dashboard records it as the agent's answer |
| "Same, but ask me at optional approvals" | You |
| "Same, but answer optional approvals automatically" | teamai answers yes |

The approval is optional because the pull request is reviewed anyway: a wrong task costs a review, not a broken suite. Nothing offers this workflow on its own; ask for it, or let the generated `teamai-session-to-task` skill point your agent at it. A team file `workflows/teamai-session-to-task.yaml` replaces it, and describe still fills the inputs it keeps by name, as strings.

A task is proposed on a branch of its own, named for its suite and id, so asking again goes on where the first run left off:

```text
draft id       on the team repo
refresh-race   pull request 77, from teamai/session-to-task/benchmarks/fix-auth/refresh-race
refresh-race   drafted again, by you or a teammate: the same branch, and pull request 77 updated
refresh-race   after pull request 77 merged, the same bytes: nothing pushed, no pull request
../escape      not a task file name: the check step fails before any approval or clone
```

### Check tasks in the team repo's CI

The task's check runs your project's setup and code, so it is tried in CI, not on your machine. This job tries every task a pull request adds or changes, with [`benchmark try`](#try-a-task), and fails if any of them does not tell its solution from no change:

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

Every task is tried, and the job lists each failure before it fails. If `git diff` cannot read the base branch, the job fails rather than trying nothing. Mark it required in the team repo's merge rules, so a task that fails it never reaches the suite. `PROJECT_READ_TOKEN` reads the suite's repo. A solution that is not on that repo's remote fails the job naming the commit: push the solution's branch, or set `solutionCommit` to the commit that landed it on the default branch, and re-run.

A team with suites for several repositories tries each suite against its own repository:

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

A matrix entry whose suite the pull request does not touch tries nothing and passes.

## Run a suite

```console
$ teamai benchmark run fix-auth --sandbox
ℹ Run r38302f8e6a18c377 started. If it stops before it ends, continue it with: teamai workflow resume r38302f8e6a18c377
```

`benchmark run` plans the suite first, so a suite that cannot run leaves no run. It then starts the workflow `teamai-benchmark` with the suite's `timeout`, on the driver `--driver` names, else the one [`workflows.driver`](reference.md#member-settings) names, else the local driver, which drives it here.

Each trial prompt runs with [`permissions: unattended`](workflow-advanced.md#unattended-prompts), because the shipped workflow runs the trials in a strict sandbox: the tool edits files and runs commands without asking, whatever this machine's settings for it say.

| Flag or setting | Effect |
| --- | --- |
| `--sandbox` | Declares this machine a sandbox for this run, which `workflow resume` on this machine keeps. Only on a machine you can throw away. |
| `workflows.sandbox: true` in config | Declares it for every process, as [Requirements and limits](workflow-advanced.md#requirements-and-limits) describes. |
| neither | The run is refused at start with `requirement_unmet`: the trials require a strict sandbox. |
| `--member-aliases` | Your own `~/.teamai/models/aliases.yaml` wins over the team's `models/aliases.yaml`, and the table shows `member` as the source of each model your file decided. |
| `--task <id>`, `--arm <name>` | Run only these tasks and arms. Each repeats. See [Run some tasks and arms](#run-some-tasks-and-arms). |
| `--fail-on-regression` | Also exit 1 when an arm's pass rate dropped. See [Fail on a regression](#fail-on-a-regression). |

| `benchmark run` exits | When |
| --- | --- |
| 0 | The run succeeded and its report was written, whatever the trials' results. |
| 1 | The suite or the start was refused, the run timed out or was cancelled, or a `finally` step failed or was cancelled: the report, or the `regression` gate when `--fail-on-regression` found a drop. |

A record still waiting for publication never changes the exit code.

| A trial gets | |
| --- | --- |
| A fresh clone of the starting commit | With no remotes. Your checkout is never changed. |
| The team assets and the suite | Of the team revision this checkout last pulled, which must be pushed, or of the arm's `team`. Frozen at start: a pull during the run changes nothing it runs. |
| An environment | Without `GITHUB_TOKEN`, `GH_TOKEN`, `GITLAB_TOKEN`, `GL_TOKEN`, `CI_JOB_TOKEN`, `SSH_AUTH_SOCK`, `GIT_ASKPASS` and `SSH_ASKPASS`: the trials step is a [strict sandbox](workflow-advanced.md#requirements-and-limits), which keeps them from every process of a trial. |
| Your home directory | As it is: teamai cannot remove its logins, MCP servers and plugins. |
| The team repo on this machine | As it is: your team checkout, and the copy of the team revision beside each trial's clone that its team assets are installed from, hold `benchmarks/`, check files included. An agent that searches the machine can find them. |

The local driver runs each trial as fresh clone, team assets, setup, the arm's tool on the prompt, then the check.

| | |
| --- | --- |
| Tools | It runs `claude`, `codex` and `opencode`. Install and log in every tool the arms use. An arm whose tool it cannot find gets its trials `not_run`, and the other arms still run. |
| Lanes | One trial at a time, unless the suite sets [`parallel`](#parallel-lanes). |
| Timeout | The suite's `timeout` is the whole run's. Setup, the tool and the check all stop at it: the trial they ran for counts as `error`, and the trials still open settle `not_run`. Keep it below your CI job's limit, or the job is killed before it prints the table. |
| A hung trial | Without [`trial.timeout`](#trial-limits), a tool that never returns runs until the suite's timeout, and every trial after it settles `not_run`. |
| Judges | A task with `successCriteria`, and the suite's scorers, are judged by the run's own `score` step, after the trials and before `report`. Start refuses a suite that needs a judge on a machine with no judge tool that runs its scorers' model at the isolation they ask for. |
| Control commands | A trial's steps exist only once the run's `plan` step reported. Until then, `teamai workflow cancel <run> <step>` on a trial step answers `step_not_found`. A benchmark run is [isolated](workflow-advanced.md#isolated-runs): `workflow retry`, `publish` and `--claim` refuse it, `publish` and `--claim` with `isolated_run`, and retry names `teamai benchmark run <suite>`. |
| Stopped | `teamai workflow resume <run>` continues it, with the `--sandbox` the run started with. |

A start that cannot run refuses with a message that says what to do, and makes no run. When your user-scope teamai install also reaches the team, or the team is served over HTTP, the run cannot pin the team a trial gets, and refuses with `team_ref_blocked`, saying what to change.

### Run some tasks and arms

```console
$ teamai benchmark run fix-auth --sandbox --task expired-token --arm claude --arm strong
```

The run has the baseline of `expired-token` and the trials of `claude` and `strong` on it, and its record and table list only them. `--fail-on-regression` then compares it only with a run of the same tasks and arms. The dashboard never takes such a run as the suite's current version while the suite has a run of all its tasks and arms. A name the suite does not have is refused before any run starts:

```console
$ teamai benchmark run fix-auth --sandbox --task expierd-token
{"error":{"code":"invalid_arguments","message":"Suite \"fix-auth\" has no task \"expierd-token\". Its tasks: expired-token, login-copy, old-bug."}}
```

### Parallel lanes

```yaml
parallel: 4
```

Baselines and trials run in up to `parallel` lanes, one after another in each lane. The local driver runs at most `workflows.max_parallel` of them at once, 1 unless your config sets it, so set both. Trials in parallel share the machine's CPU, memory and network, and the tools' rate limits: durations, and sometimes results, differ from a serial run. Compare runs made with the same `parallel`.

## The benchmark workflow

`benchmark run` starts the workflow `teamai-benchmark`. teamai ships this one:

```yaml
# workflows/teamai-benchmark.yaml, shipped in the npm package
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
    with: { subject: "{{ item }}", scorers: [], label: "", batch: false, demand: named }
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

| Command | Runs as | Does |
| --- | --- | --- |
| `teamai benchmark plan <suite>` | The `plan` step | Freezes the team revision you pulled, fetches every commit a trial reads, and prints the trials as a workflow, with one clone per baseline and trial. |
| `teamai benchmark check --baseline\|--trial` | A step in each clone | Writes `check.add`, puts `protect` back for a trial, runs the task's check, and prints its result. |
| `teamai score subjects --run <run> --step trials` | The `subjects` step | Lists the trials' scored passes that settled on this machine. |
| [`teamai-score`](scorers.md#the-teamai-score-workflow) | The `score` step, once per subject | Judges the trial with the scorers as of the run's start. |
| `teamai benchmark report` | The `report` `finally` step | Classifies the trials, writes the record, and prints the results. With `COMPARE=true`, also compares the record, as [Fail on a regression](#fail-on-a-regression) says. |

`trials` runs what `plan` printed: see [Run a workflow a step printed](workflow-advanced.md#run-a-workflow-a-step-printed). `report` runs after the trials whatever happened to them, as [finally steps](workflow-advanced.md#finally-steps) do. `benchmark run --member-aliases` passes `aliases` as `member`, else as `team`. `--task` and `--arm` pass `tasks` and `arms`, else `[]`, which plans every task and arm. `--fail-on-regression` passes `fail_on_regression` as `true`, else `false`. `report` reads each trial's labels from the `score` step's results in the run file, since a `finally` step cannot read `steps`.

To change it, push your own `workflows/teamai-benchmark.yaml`, or `workflows/<namespace>/teamai-benchmark.yaml` for members of one role or project. It replaces teamai's for whoever receives it, as any [default workflow](workflow.md#override-a-default) does, and `benchmark run` says so:

```text
ℹ Running the team's workflows/ops/teamai-benchmark.yaml, which replaces teamai's benchmark workflow.
```

Yours must take input `suite`, input `aliases` to run with `--member-aliases`, inputs `tasks` and `arms` to run with `--task` and `--arm`, and input `fail_on_regression` to run with `--fail-on-regression`; `benchmark run` refuses it otherwise, naming the input. Keep `plan`'s step id and `report` as a `finally` step. Dropping `strict: true` lets trials run without the credentials being kept from them, and with each tool's own permission settings rather than unattended: a tool that may not edit fails its trials, and the report opens with a line that says so. When two namespaces you receive both have a `teamai-benchmark.yaml`, `benchmark run` refuses with `workflow_namespace_conflict`, naming both files, and never falls back to teamai's.

You may change `score`'s `timeout`, or drop `subjects` and `score` to run without judging. Every trial a judge would decide then ends `unscored`:

```yaml fragment
# workflows/teamai-benchmark.yaml: the trials, never judged
steps:
  # plan, as teamai's
  - id: trials
    needs: [plan]
    workflow: { from: plan }
    requires: { isolation: sandbox, strict: true }
  # no subjects or score step
finally:
  # report and regression, as teamai's
```

## Results

When the run ends, `benchmark run` prints the results on stderr. The JSON envelope on stdout carries the same text in `data.done.outputs.text`, and the numbers in `data.done.outputs.table`, whose `verdicts` give each judged trial's verdict per scorer: `labelled` with its label, or `unscored` with `because`, the judge's failure code, or `run_ended` when no label came. For this suite with a third task, `old-bug`, whose check already passes:

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

| Table | Shows |
| --- | --- |
| Arms | Each arm's trials by result, and how many a [trial limit](#trial-limits) stopped. A deviation is a trial whose prompt ran on another tool, team revision, model or role than its arm's, or without a trial limit its driver could not enforce. A trial is not verified when its record lacks one of those. When an arm runs on other team assets than the pulled revision, a Team column shows each arm's, such as `pulled 3f9c2ab`, `next 81d0e4c`, `3f9c2ab without skills/auth-tokens` or `none`. When an arm [runs as a role](#arms-that-run-as-a-role), a Role column shows each arm's role, or `member's roles`. |
| Usage | Each arm's medians and cost total, with how many trials each used. Tokens and cost appear only as the tool stated them, so a tool that states none shows `unknown (0)`. A trial whose passes did not all state its tokens (input and output), cost or duration counts as one that stated none of it, and makes a cost total `incomplete`. |
| Tasks | Each task's pass rate on each arm. |
| Baselines | The tasks that did not run, and why. |
| Skills | Only when an arm changes team skills: each skill it adds, removes or changes, and how many of the arm's trials loaded it, beside the arm that changes nothing. |
| Asset effects | Only when a task covers a team repo path: a table per covered asset, under [Asset effect](#asset-effect). |

```text
| Arm | Skill | Change | Loaded in this arm | Loaded in the defaults arm |
| --- | --- | --- | --- | --- |
| no-auth-tokens | auth-tokens | removed | 0/3 | 2/3, 1 unknown |
```

A load is counted only where teamai could see it: `unknown` is a trial whose tool reports no skill loads, never a trial that did not load the skill.

### Asset effect

A task's `covers` names the team repo paths its work is expected to need, and the results answer, per covered path, whether an arm that runs [`without`](#leave-team-assets-out) exactly that path passes less on the tasks that cover it — and no less on the others. With a skill `auth-tokens`, a rule `rules/auth.md`, two tasks that cover both and one that covers neither:

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

The run's results then hold one table per covered asset an arm leaves out:

```text
Asset effect · skills/auth-tokens · no-auth-tokens -> pulled · claude

task   covers   passed without   passed with   loaded with
expired-token   yes   1/3   3/3   3/3 fit
refresh-race   yes   0/3   2/3   2/3 fit, 1 missed
login-copy   no   3/3   3/3   1/3 extra, 2 idle

tasks that cover it   +67 pp   1/6 -> 5/6   95% +11 to +86 pp
other tasks   0 pp   3/3 -> 3/3   not separated
passed when loaded 6/6 · passed when not loaded 2/3
```

Read it as:

- The skill helps on `expired-token`, and loaded every time there: it works there.
- On `refresh-race` it loaded twice and the task passed twice; the one repetition that did not load it also did not pass, which the `missed` count names. A task that covers the skill, loaded it every time and did not change says the opposite: the description reaches the task and the body does not help.
- `login-copy` did not get worse, though the skill loaded once where it was not needed.

`loaded with` uses the [routing](scorers.md#skill-routing) values a finished session's scorer reads, from the task instead of a judge: `fit` loaded and the task covers it, `missed` not loaded and it does, `extra` loaded and it does not, `idle` not loaded and it does not, and `unknown` when the tool reports no skill loads — an `unknown` trial still counts in the pass rates, in neither "when loaded" nor "when not loaded". Only skills have the column: teamai observes skill loads and nothing else, so a rule, a `claudemd/` file, a doc or a namespace directory reads `not observed`. On the dashboard's [Benchmarks page](dashboard.md#benchmarks), the Compare tab shows the tables under the pair, or on their own when no two arms compare, and a skill links to its `teamai:routing:...` counts on real sessions.

`not separated` is an answer, not a failure: the 95% interval of the paired difference crosses zero, so these trials cannot tell the difference from chance. A single rule usually moves a few tasks — add tasks that cover it, or repetitions, until the interval leaves zero. An arm that leaves out more than one path gets no per-asset table: its difference belongs to the set, which Compare already shows. `plan` refuses a covered path no arm receives, each arm read at its team revision, with its role and without the paths it leaves out, and two covered skill paths of the same skill name, since a trial's loads are bare names.

The results are not the run's status: a run whose trials all failed still succeeds. The run fails when it times out or is cancelled.

`report` writes the run's benchmark record into the run's directory on this machine. With [usage reporting](reporting.md) on, it also publishes it to `benchmarks/runs/<run>.json` on the team repo's `teamai-reports` branch, so the job's token also needs push access to the team repo. A publication that fails waits in the queue and is retried on the next `teamai pull`; until then the text ends with `record: pending`. [Run records](workflow.md#run-records) lists the record's fields and gives the `jq` command that computes each arm's pass rate from the record alone. With it off, the results are still in the envelope. The dashboard's [Benchmarks page](dashboard.md#benchmarks) draws the published runs and this machine's over time.

## Fail on a regression

```console
$ teamai benchmark run fix-auth --sandbox --fail-on-regression > done.json
Arm "claude" passed 4/9 paired trials, against 8/9 in run r1c0d9e2f4b6a8c7d: a drop of 44 points, with a 95% interval of -73 to -16 points.
$ echo $?
1
$ jq -c .data.done.finally done.json
[{"id":"regression","outcome":"failed"}]
```

`--fail-on-regression` compares this run with the newest earlier run of the suite that succeeded and is published on `teamai-reports` with the same tasks and arms. An arm is the same when its name, tool, model, effort, workflow and team treatment are, whatever revision it pulled. Trials pair by task and repetition, as the dashboard's Compare pairs them, and an arm dropped when its pass rate dropped by more than chance. Records still waiting on this machine are not compared.

| `report` output `regression` | When | The `regression` step |
| --- | --- | --- |
| `dropped` | An arm dropped. The text names each one, as above. | Runs `exit 1` and fails: `benchmark run` exits 1. |
| `held` | No arm dropped. The text names the run it compared with. | Skipped. |
| `no_comparable` | No such run. The text says so. | Skipped. |
| `off` | `fail_on_regression` is `false`: nothing was compared. | Skipped. |

The gate is a step of the run, so the run's driver ends it there whoever started it. teamai's `teamai-benchmark` is `invoke: deny`, so start it with `--driver local`: a `--driver skill` start answers `invoke_denied`, unless your team's copy sets `invoke: allow`. `workflow start teamai-benchmark` with `"fail_on_regression":true` runs the same gate. Its exit code follows the run's outcome, which a `finally` step does not change, so read `done.finally`.

The gate is the team's to change. To warn of a drop instead of failing the job, replace the `regression` step and keep the rest as teamai's:

```yaml
# workflows/teamai-benchmark.yaml: a drop warns in the CI log, and the job still passes
finally:
  # report, as teamai's
  - id: regression
    needs: [report]
    if: steps.report.outputs.regression == 'dropped'
    command: echo "::warning title=Benchmark regression::$TEXT"
    env: { TEXT: "{{ steps.report.outputs.text }}" }
```

To turn a scorer's repeated failures into a PR that changes the team's assets and adds one regression task each, proven on every tool before and after, see [Self-improvement](self-improvement.md).

## Run in CI

A GitHub Actions job:

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

- `TEAM_TOKEN` reads the team repo, and pushes to it when usage reporting is on.
- `--agent claude` sets teamai up for Claude Code, which a fresh runner has never run.
- The checkout of the suite's `repo` has its full history, so every task's starting commit is there.
- The last step puts the results in the job's summary, also when the run failed.

A GitLab CI job:

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

Set `TEAM_REPO`, `GITLAB_TOKEN` (reads the team repo) and `ANTHROPIC_API_KEY` as masked CI/CD variables. The job log shows the results, and `done.json` keeps them. For another tool, install it and set its key the same way: each arm's tool must be on the runner.

## Your own driver

A benchmark run is an ordinary workflow run, so any driver runs it through `workflow next --prepare` and `workflow report`, as [Clone workspaces in your own driver](workflow-advanced.md#clone-workspaces-in-your-own-driver) describes:

```text
teamai workflow start teamai-benchmark --inputs '{"suite":"fix-auth","aliases":"team","tasks":[],"arms":[],"fail_on_regression":false}' --timeout 45m
teamai workflow next <run> --prepare --json '{"driver":{..., "can":{"workspace":["read-only","new","continue","clone"],"isolation":"sandbox","env":true,"setup":true,"tools":["claude"],"unattended":true,"end_turn":true}}}'
  -> a command lease (plan, check, report): run lease.command in lease.cwd, or in your checkout without one, with TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>
  -> a prompt lease: launch lease.tool in lease.cwd on lease.prompt, with lease.model, in its unattended mode for lease.permissions, held to lease.limits
teamai workflow report <run> --json '{..., "tool":"claude", "durationMs":84000, "cost":{"amount":0.31,"unit":"USD"}}'
```

| | |
| --- | --- |
| `driver.can` | On every `next`: `clone` in `workspace`, `isolation: "sandbox"`, `env: true`, `setup: true`, the arms' tools in `tools`, `unattended: true`, and `end_turn: true` when it ends a turn at the lease's limits. A trial is held for a driver that lacks one of them, and `wait.held[].missing` names it. |
| `--prepare` | teamai makes each clone on this machine, installs its team assets and runs setup, then answers the lease with `cwd`. |
| Every process | Runs without the names in `lease.envScope.withhold`, with `lease.env`, and with `TEAMAI_WORKFLOW_ATTEMPT=<run>/<attempt>`, so a `teamai` call from it changes no run. A command step prints its outputs as JSON on stdout; report them as `outputs`. |
| `report` | For a prompt: `tool`, `durationMs` measured around the tool launch, and `cost` only when the tool stated one. |
| Limits | Hold the tool to `lease.limits`. When one stopped it, report `outcome: "success"` with `limit`: `timeout`, `budget` or `max_turns`, and list in `unenforced` a `budget` or `max_turns` you could not hold it to. |
| Timeout | `benchmark run` passes the suite's `timeout` as `--timeout`; a direct `workflow start teamai-benchmark` must pass it too, or `plan` fails. |
| Judges | A trial's judge is a step of a `teamai-score` run, leased like any other and [confined to a directory](workflow-advanced.md#confined-steps-in-your-own-driver): offer `can.confined`, or it waits with `wait.held[].missing` naming `confined`. |
