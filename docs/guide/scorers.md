# Scorers

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

A scorer is a rubric a judge applies to a workflow step's work or to a finished agent session. It is a Markdown file at `scorers/<name>.md` in the team repo.

`scorers/review-quality.md`:

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

| Field | Meaning |
|---|---|
| `labels` | 2 to 20 `{ value, score, description }`. At least one scores at or above `passingScore`, and one below it. |
| `passingScore` | A label passes when its score is at or above this. |
| `samplingRate`, `model`, `isolation` | Optional. Percent of passes judged, 0 to 100, default 25. The judge's model: a team [model alias](sharing.md#model-aliases), resolved per judge tool, or a model name, which goes unchanged to the first judge tool; default the tool's. `verified` or `best-effort`. |
| `sessions` | Optional. `true`: the scorer also judges [finished sessions](#finished-sessions). |
| `tool` | Optional. The judge tool to prefer, such as `codex`. When the driver that leases the judge offers it, it judges; else the tool the judged work ran in, else the driver's first tool. A name teamai does not know is warned about, not refused. |
| `stages` | Optional. Which [stages](#score-what-a-run-delivered) may decide the scorer before its judge: some of `check`, `ci` and `protected`. Default all three. |

The text after the frontmatter is the judge's prompt. `teamai pull` caches valid scorers, which `teamai status` lists, and warns about the rest. `teamai review --branch` fails on a malformed scorer, on a model alias the branch's `models/aliases.yaml` maps for no tool, on any file in `scorers/` other than `<name>.md`, `<namespace>/<name>.md`, `scoring.yaml` and `README.md`, on a `scoring.yaml` with a key or value it does not know, and on a credential or internal address in any file there, as it does for rules.

`scorers/ops/review-quality.md` belongs to the `ops` namespace. Members get it when their role or project lists it:

```yaml
# manifest/roles.yaml
roles:
  - id: ops
    resources: { knowledge: [], skills: [], scorers: [ops] }
```

It replaces a root scorer of the same name. One name in two active namespaces is an error. A `scorers/<dir>/` that no role or project lists is shared: every member gets its scorers, and one named like a root scorer is an error. A team without roles or projects gets every namespace.

## Choose the judge's model

```yaml
# scorers/review-quality.md, in the frontmatter
model: fast
```

```yaml
# models/aliases.yaml
aliases:
  fast:
    claude: haiku
```

Judge tools are tried in order, and the first whose entry gives a model judges. When none does, the judge step of its teamai-score run waits for a driver whose tools can, and `teamai doctor` warns about the scorer. A member's `~` entry for the tool sends it to the tool's default model. So does an active `teamai models switch`, except that Claude keeps `opus`, `sonnet` or `haiku` and routes it through the switch; a switch also drops the alias's effort. CodeBuddy judges run without the alias's effort.

Each label records what judged:

```json
"judge":{"kind":"model","tool":"claude","model":{"requested":"haiku","reported":"claude-haiku-4-5","alias":"fast"},"isolation":"verified","access":"read"}
```

`requested` is the model the judge was launched with, or the one a driver's report of the judge step names in `confined.model`. `reported` is the one the tool reports. `alias` stays when the tool default judges. An alias effort adds `"effort":{"requested":"low"}`.

## Score a step

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

A name with no valid `scorers/<name>.md` fails `teamai review --branch`; `teamai pull` warns and the step runs without it. An older teamai does not know `scorers`, so update every member and runner first. [Workflows](workflow.md) shows the long form.

## A run and its judge

```console
$ teamai workflow start review-and-fix --driver local     # attended: each scored pass gets its own teamai-score run
ℹ run:r3f9…:review:1: review-quality good (teamai-score run r7c2…).
{"data":{"done":{"run":"r3f9…","outcome":"succeeded",…}}}
```

When a pass of a scored step settles, the `workflow report` that settles it (`workflow next` for a `workflow:` step) starts one [`teamai-score`](#the-teamai-score-workflow) run for that pass, with `demand: auto`, and lists it in `started` on every answer until that run ends. The scored run's driver drives it as its own run. The scored run's steps and `finally` never wait for it, and it never changes the run's outcome:

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…}}'   # your own driver
{"data":{"accepted":true,…,"started":[{"run":"r7c2…","step":"review","pass":1,"scorers":["review-quality"]}]}}
$ teamai workflow next r7c2… --json '{"driver":{…}}'                                                   # drive it as any run
```

| Driver | Who starts the run | Who drives it | `--no-judge` |
|---|---|---|---|
| `local`, attended | the report that settles the pass | `workflow start` or `resume`, before it returns, so the label is written by then | no such option |
| `local`, unattended | the same | the same, before the [drain](#drain-before-an-unattended-job-ends). Before this release the drain judged the pass | no such option |
| `skill` | the same | the skill driver, as a child run: its commands in the background runner, its judge as the agent's judging reference says | the run starts and stays running for `teamai workflow resume <run>` |
| `none`, or your own | the same | your driver, with `workflow next` and `report` on the run id in `started` | no such option |

`samplingRate` picks the succeeded passes to judge, the same way on every machine; a teamai-score run for a pass it does not pick ends with no label. A step whose `scorers` sets `sampling: all` has every succeeded pass judged, whatever its scorers sample, by a teamai-score run of its own as above, and its run ends without waiting for them. A [benchmark](benchmarks.md) sets it with `start: workflow`, and judges its trials with its own `score` step.

The label records `used.skills`, the team skills the pass or its subagents loaded, found as for [a session](#score-a-session) from what the checkout held as teamai delivered it when the pass started. A `workflow:` step's label lists every skill its child passes recorded, and has no `used` when none of them recorded one.

The evidence directory holds `evidence.json`, `prompt.md`, `diff.patch` when a range was recorded, `repo/` (tracked files at the judged commit, symlink targets stored as text), `transcripts/` (with readable subagents) and `outputs.json`. Every file is redacted, including the values of the secrets the team declares in `env/secrets.yaml`. A tracked file that is not text is left out and listed under `omitted`. Missing evidence is listed as gap codes. It is written under the teamai-score run's directory.

### Labels before the next step

`scorers.start: workflow` leaves the scoring of a step's passes to the workflow's own steps. teamai starts no teamai-score run for them. `teamai score subjects` lists them, and a `workflow: teamai-score` step labels each. Pull warns on such a step that no `workflow: teamai-score` step after it reads `teamai score subjects --step` for: its passes are then scored only after the run ended, by the next `teamai-finished-sessions` that `teamai score --drain` or a session start runs:

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

`revise` runs only after `fix`'s label is written, and only when it is not `good`; a label that is missing reads `null`. `teamai-score`'s own `timeout`, 336h, binds it as a step too, and the shorter of the two ends it, so the step sets a shorter one, with `continue_on_failure: true`.

### The harness a label judged

Every label also records `agent`, the harness the judged work ran with. Here the fix runs with your role and the review runs as a reviewer, and one scorer judges both:

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

After `teamai workflow start fix-and-review --driver local`, the review pass's label in `<dataHome>/scores/labels.jsonl` reads (one line, wrapped here):

```text
{"scorer":"review-quality","label":"partial","score":0.5,"passed":false,"source":"workflow",
 "subject":{"runId":"r3f9…","step":"review","pass":1},
 "agent":{"v":1,"tool":{"name":"claude","version":"2.1.308"},"model":{"requested":"claude-sonnet-4-6"},
  "team":{"revision":"62432de…","localChanges":false,
   "selection":{"scope":"project","primaryRole":"frontend","additionalRoles":[],"stepRole":"review"}},
  "project":{"commit":"9e1b…","dirty":false},"teamai":"0.22.0","driver":"local","fingerprint":"5c0d…"},
 "judge":{"kind":"model","tool":"claude",…},"scoredAt":"2026-10-27T10:00:00.000Z"}
```

`stepRole: review` is the role the step ran with; `primaryRole` is yours. The `fix` label has no `stepRole`.

- A prompt step's label carries its pass's `agent` as the run recorded it, also when the pass recorded no model and so no `fingerprint`.
- A `workflow:` step's label carries the `agent` of its first prompt pass when all its prompt passes agree on tool, model, effort, definition and team. Command passes are left out. When they do not agree, as when the items of a `for_each` run with different roles, the label has no `agent`.
- A session label carries the `agent` its captures agree on, compared the same way.
- The judge never sees `agent`. It is not part of the label's key, so a rescore still replaces the label it rescored.

On the dashboard's [Scorers page](dashboard.md#scorers), **Group by** `Role` counts each label under `stepRole` when its pass ran with one, else under `primaryRole`, so the review step shows beside the member steps:

```text
By Role
VALUE            LABELS  PASSED  FAILED  PASS RATE
frontend member  14      11      3       79%
review step      12      7       5       58%
Not recorded     3       2       1       67%
```

Beside each role, `step` means its labels ran with a step's role, `member` with the member's, and `both` some of each.

**Failing labels** names the harness of each label and opens its run while the run is still listed. Select a group to list only its own:

```text
SCORED      AUTHOR  LABEL    HARNESS                                                     PLATFORM      SKILLS  OPEN
10/27/2026  bob     partial  claude · claude-sonnet-4-6 · review step role · 62432de     Workflow run  —       r3f9… ↗  review #1
10/26/2026  ana     bad      codex · gpt-5 · frontend member role · 62432de              Workflow run  —       r1a2… Run not found  fix #1
10/20/2026  ana     bad      Harness not recorded                                        Workflow run  —       r0c7… Run not found  fix #1
```

The harness comes from the label, so it stays after the run file is deleted. `Harness not recorded` means that neither the label nor the run's record has an `agent`: a label written by an older teamai whose run is gone, a `workflow:` step whose prompt passes disagree, or a session whose captures disagree. In **By Role**, such a label counts under `Not recorded`, as does one whose `agent` names no team.

## Any driver

A driver drives each teamai-score run in `started` with `workflow next` and `report`, as any run. Its command steps run in the place `workflow next --prepare` gives them, with the lease's `env`. Its judge step is a confined prompt: the driver runs its own judge on it, with the evidence directory as its only readable root, and reports the answer and what judged:

```console
$ teamai workflow next r7c2… --prepare --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work","can":{"confined":[{"level":"verified","access":"read","tools":["claude"]}],"workspace":["team"]}}}'
$ teamai workflow report r7c2… --json '{"attempt":"…","revision":5,"outcome":"success","driver":{…},
 "outputs":{"answer":{"label":"good","reasoning":"…"}},"confined":{"tool":"claude","isolation":"verified","access":"read"}}'
```

`workflow next` finds a run's scope by its id, so a driver can drive it from outside the checkout the run started in. To judge one session by id, start its run with [`score --session`](#with-your-own-judge).

| `can.confined` entry | Meaning |
|---|---|
| `level` | `verified` or `best-effort`. A judge step is leased only to a driver that offers the [level](#isolation) its scorers need. |
| `access` | What the judge can do: `answer` (no tools), `read` (reads the evidence) or `full` (any tool). Labels record it. |
| `tools` | The tools your judge runs. |

`confined` in the report says what judged: `tool`, `isolation` and `access`, and optionally `model`, `effort` and `usage`. The label records it. An answer with a label the scorer does not list fails the pass `judge_answer_invalid` and writes no label; [`teamai score --run`](#on-demand) judges it again. `teamai workflow next --help` and `teamai workflow report --help` have every field.

Your driver names the team skills a pass loaded when it reports the pass, and the pass's labels carry them:

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…},"used":{"skills":["review-notes"]}}'
```

Names only: a value that is not a skill name, such as a path, is dropped. A report without `used` gives labels without it; `"skills":[]` says the pass loaded no team skill.

## On demand

```console
$ teamai score --run r5863… --scorer review-quality                                        # the one step that lists it, latest succeeded pass
ℹ Run rd4894… started. If it stops before it ends, continue it with: teamai workflow resume rd4894…
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/d3ce….md
$ teamai score --run r3f9… --step review --pass 2 --scorer review-quality --driver none   # any driver's workflow next takes it
```

`--run`, `--session` or `--team-session` with `--scorer` starts [`teamai-score`](#the-teamai-score-workflow) for that pass or session on the driver [`workflows.driver`](reference.md#member-settings) names, else on the local driver, and prints the labels it wrote. `--driver none` only starts the run, for any driver's `workflow next`; it replaces `--queue`. For a driver this machine does not run, it only starts the run, which waits for that driver, and prints `<run> waits for driver <name>, which this machine does not run. To drive it here: teamai workflow resume <run> --driver local`. `--step` is optional when one step of the run with a succeeded pass lists the scorer. Otherwise the error names the steps to pick from. Sampling does not apply, and judge work that failed or expired opens again. `--run` reads each scorer at the team commit the run started from, with the changes the checkout had past it, so a rubric edited during the run does not change the label; a session takes any scorer `teamai pull` cached, with its current one. An unknown run, step, pass or scorer fails, lists the ones that exist, and starts no run.

A scorer left without a label makes the command exit 1 with its code, and `labels` lists what the others got:

```console
$ teamai score --run r2907… --scorer review-quality --scorer style   # style asks for model alias fast, which maps only codex
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/c6cb….md
{"error":{"code":"judge_pending","message":"Run rffc… left the judge of style open for a driver that can run it: … The run waits for one until its timeout, and teamai score --drain lists it. Kept the label of review-quality: good.","labels":[…]}}
```

When only a judge step no tool here can take is left, such as one whose model no tool here runs, or a `verified` scorer with no verified judge here, the code is `judge_pending`, and the run stays open for a driver that can take it. A scorer another `teamai-score` run is still judging gets `not_planned`.

A pass whose commits or recorded session are gone from this machine fails before any judge, and no label is written:

```console
$ teamai score --run r3f9… --scorer delivered
{"error":{"code":"evidence_missing","message":"Pass 1 of step change in run r3f9… cannot be scored: no longer on this machine: claude-code session 6f1c2a0e-… of change#1. Restore what is missing, or score another pass. No label was written."}}
```

## Score what a run delivered

A step with `deliver: pr` hands its work to review as a pull request. A scorer on that step judges the pull request, and three stages can decide its label before any judge runs.

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

`scorers/delivered.md`:

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

The stages run in this order, and the first that fails decides:

| Stage | Fails when | `decidedBy` |
|---|---|---|
| Scorer check | `check.run` exits non-zero in a fresh clone of the delivered commit, after the `protect` paths are put back as they were where the work started. An agent that edited `test/` to pass cannot pass this way. | `check` |
| Pull request CI | The CI of the delivered commit finished and failed. GitHub: any check run that failed, timed out or needs action, or a failed commit status. GitLab: the newest pipeline failed. | `ci` |
| Protected paths | The pass changed a path the run protects, so the step failed with `protected_path` and delivered nothing. | `protected` |

A scorer's `stages` picks which of them may decide it, when `teamai-score` labels the pass. `clarity` neither waits for CI nor is decided by it:

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

On a step with `scorers: [clarity, delivered]` and CI still running, `clarity` is judged at once and `delivered` waits for CI. A failed CI decides `delivered`, not `clarity`.

The failing label is the highest one below `passingScore`, here `partial`. No judge is launched and no tokens are spent. When every stage passes, or any CI check is still running, there are no checks, or the origin is not GitHub or GitLab, the judge decides and the label says `"decidedBy":"judge"`. A scorer without `check` skips that stage. A pass that changed nothing delivered no commit, so its check and CI are skipped too.

The judge of a delivering step also reads the run's inputs (`inputs.json`) and the outputs of every step, so it can compare the pull request with the issue `read-issue` returned.

A CI failure, as `teamai score --run r3f9… --scorer delivered` publishes it:

```json
{"scorer":"delivered","label":"partial","score":0.5,"passed":false,"source":"workflow",
 "subject":{"runId":"r3f9…","step":"change","pass":1},"decidedBy":"ci",
 "evidenceHash":"sha256:8ddbddc64a7180bc866ce3fc0da3e5ad940854e7855a51b0318851f932737ba1",
 "judge":{"kind":"stage"},…}
```

`evidenceHash` identifies the evidence the label read. Two labels of one pass with the same hash read the same work, so if their labels differ, the rubric or the judge changed, not the work. What the stage found (the check's exit code, the CI result) is kept only in the local reasoning file the command prints. Its judge is `{"kind":"stage"}`: no judge ran, so the label names no judge tool and has no `usage`. Labels earlier releases wrote name the judge that would have run, with `kind: model`, and read as decided by the stage just the same.

A check that cannot run, such as a command this machine does not have or one that times out, writes no label. Fix the check, then score the pass again:

```console
$ teamai score --run r3f9… --scorer delivered
{"error":{"code":"check_could_not_run","message":"The check of scorer delivered, `npm test`, could not run on commit 4be1c0d… (not_found). Fix the check, then run this command again. No label was written."}}
```

The teamai-score run of an automatic pass fails it with `check_could_not_run` and the same reason. A scorer with a `check` is never [batched](#batching) with others, since its check runs alone. Two passes of one step that delivered two pull requests get a label each, told apart by `subject.pass`.

[The Scorers page](dashboard.md#scorers) shows how many labels each stage decided.

## Score a session

```console
$ teamai score --session 7c1e… --scorer review-quality          # in your own terminal
ℹ Scoring claude-code session 7c1e… in /work/app
ℹ First prompt: Add retries to the client
ℹ Run r2b7… started. If it stops before it ends, continue it with: teamai workflow resume r2b7…
ℹ review-quality: bad (score 0, did not pass). Reasoning: ~/.teamai/scores/reasoning/9f2c….md
ℹ To share what went wrong, ask your agent to read ~/.teamai/scores/reasoning/9f2c….md and share it with the team (teamai contribute --session-id 7c1e…).
$ teamai score --session 7c1e… --source codex --scorer review-quality --push
```

To score the session you are in, ask its agent ("score this session with review-quality"). It runs [`/teamai-share-session`](workflow.md#teamai-share-learnings-and-teamai-share-session), whose `teamai-score` step judges the session in a background judge or a fresh subagent, never in the agent's own context. `teamai score` run by the agent answers `invoke_denied`.

Pass `--session <id>`: scoring never guesses the session. `--source` takes the platform names of `teamai session migrate --source`. Leave it out when the session's captures name one platform. The judge reads the redacted session with its subagents' transcripts, and sampling does not apply. Its `evidence.json` lists `skills`: `available`, the team skills the captures show teamai delivered, each with its skills `namespace` (`namespaceUnknown` when two identical copies cannot be told apart) and its `description` (left out when the frontmatter does not parse), and `used`. A session captured by an older release has the `skills_unknown` gap instead.

The judge reads at most 200,000 characters of a session. A session scorer that names a cheaper [model alias](#choose-the-judges-model) keeps a long session cheap to judge.

The label is kept in the scope the session ran in, from whichever directory you score it. It records `agent`, what the session ran as, from the captures the session-start hook writes. It records `used.skills`, the team skills the session or its subagents loaded that its captures show teamai delivered, unchanged, when it started, including by the pull it runs at start. A later pull does not change that. A skill the captures cannot place, such as a member's own skill with a team skill's name, is left out. `--push` publishes every pending label of that scope. With [usage reporting](reporting.md) off, it prints `Usage reporting is off, so labels stay on this machine.` and the labels stay pending. An http team repo has no `teamai-reports`, so `--push` fails with `unsupported_repo` and the labels stay here. `teamai doctor` warns while a label waits to be published.

### Label a session by hand

A judge is a model, and a model can be wrong. Label a few sessions yourself, and the [Scorers page](dashboard.md#scorers) shows how often the judge agrees with you.

The agent just said the retry loop is fixed, and it is not. In your own terminal:

```console
$ teamai score --session 7c1e… --scorer review-quality --label missed-bug --push
ℹ Labelling claude-code session 7c1e… in /work/app
ℹ First prompt: Fix the retry loop in sync.ts
ℹ Run rfc5… started. If it stops before it ends, continue it with: teamai workflow resume rfc5…
ℹ review-quality: missed-bug (score 0, did not pass), by hand. No judge ran.
```

A session you finished yesterday, from any directory:

```console
$ teamai score --session 7c1e… --source claude-code --scorer review-quality --label good --push
```

A value the scorer does not list fails, and nothing is written:

```console
$ teamai score --session 7c1e… --scorer review-quality --label flaky
{"error":{"code":"label_invalid","message":"\"flaky\" is not a label of scorer review-quality. Use one of: good, partial, missed-bug."}}
```

A hand label is the person's. Run by an agent, the command answers `invoke_denied` and writes nothing:

```console
$ teamai score --session 7c1e… --scorer review-quality --label good       # in the agent's shell
{"error":{"code":"invoke_denied","message":"Workflow \"teamai-score\" has invoke: deny, so no coding agent starts it, with any driver, and this command runs inside an agent session (CLAUDE_CODE_SESSION_ID is set). The person runs teamai score --session 7c1e… --source claude-code --scorer review-quality --label good in their own terminal, and the agent judges this session with /teamai-share-session."}}
```

`--label` takes one `--scorer`, a name `teamai pull` cached, and is checked before any run starts. `teamai-score` then skips the stages and the judge. The label's `score` and pass come from the scorer, as for a judge's label, and it has no reasoning file. It is stored and published as a judge's label is, with `judge: { kind: "human" }`. A hand label and a judge's label of the same session are kept side by side: rescoring with the judge never replaces a hand label. When several members label one session by hand, the newest hand label is the one counted.

`--label` labels a session. To label a workflow pass by hand, start `teamai-score` from your own terminal with the label in its inputs. The subject is `run:<run id>:<step path>:<pass>`:

```console
$ teamai score --run r24df… --step review --pass 1 --scorer review-quality --label missed-bug
{"error":{"code":"invalid_arguments","message":"--label labels a session. To label pass 1 of step review of run r24df… by hand, run in your own terminal: teamai workflow start teamai-score --driver local --inputs '{\"subject\":\"run:r24df…:review:1\",\"scorers\":[\"review-quality\"],\"label\":\"missed-bug\",\"batch\":false,\"demand\":\"named\"}'"}}
$ teamai workflow start teamai-score --driver local --inputs '{"subject":"run:r24df…:review:1","scorers":["review-quality"],"label":"missed-bug","batch":false,"demand":"named"}'
ℹ Run re440… started. If it stops before it ends, continue it with: teamai workflow resume re440…
{"data":{"done":{"run":"re440…","outcome":"succeeded","outputs":{"labels":[{…,"outputs":{"labels":[{"scorer":"review-quality","label":"missed-bug","code":""}],"written":["9c41…"]}}]}},"cancelled":[]}}
```

The label is stored with `judge: { kind: "human" }`, and the run's `publish` step sends it to `teamai-reports`, as for a session.

### A session a teammate pushed

Alice pushed her session with `teamai session push`. In your checkout of the same project:

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

The label is about the session Alice ran, so it pairs with the judge's label from her machine. Leave out `--label` and the judge scores the pushed session:

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --scorer review-quality
ℹ Scoring claude-code session 7c1e… in packages/api
ℹ Pushed by alice
ℹ First prompt: Fix the retry loop in sync.ts
ℹ review-quality: good (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/2b7d….md
```

When two members pushed a session with that name, the command fails and lists them. Pick one with `--author`:

```console
$ teamai score --team-session claude-code_fix-the-retry-loop-in-sync-ts_20261021 --author bob --scorer review-quality --label good
```

`--team-session` reads the sessions pushed for the project of the current directory on `teamai-reports`. On a git team it reads where teamai kept sessions on the default branch before only when `teamai-reports` has no session of that name, and `--author` picks among the members who pushed the name where it was found. It cannot be combined with `--session`, `--source` or `--json`. The session is redacted before the judge reads it, also when it was pushed without `--scrub`. The directory it names is the one the session ran in, relative to its repository. Its label takes `agent` from the archive ([what a scrubbed session keeps](dashboard.md#what-a-scrubbed-session-keeps)), so the Scorers page groups it by tool, model and team revision with the sessions scored where they ran. A session archived without one, such as one pushed by teamai 0.28 or earlier, counts as `Not recorded` there.

### When the scorer changes

| You change | Hand labels |
|---|---|
| The prompt, or a label's `description` | Still pair. A hand label is your reading of the session, and the judge's prompt does not change it. Rescore with the judge, and the new rubric shows how often it agrees with the hand labels you already gave. |
| A label's `value`, such as `bad` to `missed-bug` | A hand label of `bad` pairs with no label of the new rubric. Label those sessions again. |
| `passingScore`, or a label's `score` | Label again: a hand label keeps the pass it was stored with. |

### With your own judge

A driver that judges with its own tool, such as a Cursor session or an orchestrator, starts the session's teamai-score run with `--driver none` and drives it [as any driver does](#any-driver), its judge step with its own tool:

```console
$ teamai score --session 7c1e… --source cursor --scorer review-quality --driver none
{"data":{"run":"r9a1…",…}}
$ teamai workflow next r9a1… --prepare --json '{"driver":{"kind":"cursor","machine":"m1","workspace":"/work","can":{"confined":[{"level":"best-effort","access":"read","tools":["cursor"]}],"workspace":["team"]}}}'
```

`--source` names where the session is read. The run judges whatever sampling, the six idle hours, `scoring.sessions`, the scorer's `sessions`, an earlier label or `daily_limit` say, and counts toward the day's `daily_limit`. Several scorers share one judge step with `--batch`. A scorer that asks for more [isolation](#isolation) than you offer leaves the judge step to a driver that offers it. The label records your tool, `access` and the model you report.

### Try a scorer file

```console
$ teamai score --session 7c1e… --scorer ./scorers/review-quality.md
```

Before you push a new or edited scorer, try it on a session from your checkout of the team repo. `--scorer` takes a path, a value with a `/` or ending in `.md`, relative to the current directory. The file is checked as `teamai pull` checks it, and an invalid file fails with pull's message before any run starts. The command starts the [default workflow](workflow.md#default-workflows) `teamai-try-scorer` on the driver `--driver` or `workflows.driver` names, else local. It runs [`teamai-score`](#the-teamai-score-workflow) twice with the file and `store: false`, on the session and on its first prompt alone, then `teamai score report` reads both verdicts. The judge runs as it does for a cached scorer, also with `--batch`: a judge no tool here can take for the file's `model` or `isolation` holds the run with `confined_pending`.

The file's label is never stored, so the command takes no `--push`, `--run` takes scorer names only, and a scorer name beside a file is refused: score it in a command of its own. The output prints the label with its reasoning and `"stored": false`. Next to it, `stored` lists the newest label kept on this machine for that session and the scorer of the same name, one per rubric, so you see whether your edit changes the verdict. `control` is the file judged a second time, on the session's first prompt alone. When it passes, it carries a warning: the rubric passes a session where the agent did nothing, so it may not judge the work. It warns and never fails, since a rubric may judge the prompt by design.

`teamai-try-scorer` is `invoke: deny`, so from an agent session the command answers `invoke_denied`. Ask the agent for `/teamai-new-scorer` instead. It writes the scorer with you, tries it the same way on the session you name, shows the verdict, and asks before it proposes `scorers/<name>.md` to the team as a pull request.

A workflow or a whole team branch is tried with `teamai pull --team-ref <branch>` ([distribution](distribution.md)).

### Finished sessions

Unattended runs now publish and score their sessions by default. In CI, on a cloud VM or in a hosted job ([`CI` or `TEAMAI_MODE=unattended`](workflow.md#attended-and-unattended-runs)), [`teamai score --drain`](#drain-before-an-unattended-job-ends) archives the sessions this machine captured as unattended, and the step sessions of the workflow runs driven here, scrubbed, on `teamai-reports`. Every scorer with `sessions: true` judges a sample of those captured sessions, within `daily_limit`. To keep the old behavior, set `unattended: off` in both team files:

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

```yaml
# scorers/scoring.yaml
sessions: { unattended: off }
```

`sessions` in `scorers/scoring.yaml` takes a policy for each run mode. The boolean form keeps working:

```yaml
# scorers/scoring.yaml, or scorers/<namespace>/scoring.yaml
sessions: { attended: auto, unattended: auto }   # true = auto in both modes, false = off in both
daily_limit: 10                                  # per data home: on a fresh CI runner it caps one job, not one day
```

| Policy | `attended` | `unattended` |
|---|---|---|
| `off` | Nothing. The default. | Nothing. |
| `ask` | When the friction reminder offers [`teamai-share-learnings`](workflow.md#teamai-share-learnings-and-teamai-share-session), it proposes the scorers that sample the session, and they judge it once the person confirms. | Acts as `off`, since nobody is there to answer. |
| `auto` | A session is judged once nothing has happened in it for six hours, by the [`teamai-finished-sessions`](#teamai-finished-sessions) run a session start begins. | A session is judged when `teamai score --drain` runs, before the job ends. The default. |

Each mode resolves on its own, from the first of these that sets it: a member's `scoring.sessions` in `config.yaml`, the active namespaces' `scoring.yaml` files, the root `scorers/scoring.yaml`, the default. When two active namespaces disagree, the most restrictive policy wins (`off`, then `ask`, then `auto`), and so does the lowest `daily_limit`. A partial mapping such as `{ attended: ask }` leaves the other mode to the next level:

```yaml
# config.yaml
scoring:
  sessions: { attended: ask }   # attended only; unattended still follows the team
```

`scoring` in `~/.teamai/config.yaml` applies in every workspace and self scope on the machine, to each mode and limit their own `config.yaml` leaves unset, and only where it is stricter than the team: a mode the team leaves on can be turned off, and a lower `daily_limit` applies. A machine never starts judging:

| `scorers/scoring.yaml` | `~/.teamai/config.yaml` | In a workspace |
|---|---|---|
| `sessions: true` | `scoring: { sessions: { unattended: off } }` | attended `auto`, unattended `off` |
| `sessions: { attended: ask }` | `scoring: { sessions: false }` | `off` in both modes |
| `sessions: false` | `scoring: { sessions: true }` | `off` in both modes: the team's `off` stays |
| `daily_limit: 4` | `scoring: { daily_limit: 2 }` | 2 sessions a day in each workspace |
| `daily_limit: 4` | `scoring: { daily_limit: 20 }` | 4 sessions a day in each workspace |

Like the team's, the machine's limit counts each workspace on its own: a laptop with three workspaces under `daily_limit: 2` can still judge six sessions a day.

`teamai doctor` says what decided each mode and the limit, once a setting does:

```text
Session judging: attended auto, set by scorers/scoring.yaml sessions; unattended off, set by ~/.teamai/config.yaml scoring.sessions.unattended; up to 2 sessions a day, set by ~/.teamai/config.yaml scoring.daily_limit.
```

`teamai doctor` reports a value that is not `off`, `ask` or `auto` (or a boolean), with its file and key, and teamai ignores it, so that mode falls to the next level. [Sessions](sharing.md#sessions) covers `sessions.publish`, which decides whether sessions are archived.

| What is judged | Set by |
|---|---|
| A workflow step's passes | The step's `scorers`, sampled by each scorer's `samplingRate`, or every pass under `sampling: all`. `sessions` plays no part. |
| A captured session: yours, or one a `CI` or `TEAMAI_MODE` job ran that teamai did not launch | `sessions` for the session's run mode, for every scorer with `sessions: true`, sampled by its `samplingRate`. |
| A session teamai launched, such as a workflow step or a judge | Nothing. It writes no capture, and its step is judged as a pass. |
| A session of a tool teamai reads no sessions from, such as Pi | Nothing. `teamai doctor` notes each such tool the team enables, in each mode whose publish or scoring policy is not `off`. With the defaults, that is both modes. |

A namespace scorer judges a session only when the roles and projects each of its starts recorded make that namespace active.

A session is judged once per scorer and rubric. A label or a failed judgment closes it. A lapse, such as a judge its timeout cancelled, is started again by the next `teamai-finished-sessions`, until the fourth; before this release a lapse closed it. `scoring.daily_limit` in `config.yaml` sets how many session judgings one data home starts per local day, 10 by default, each start of a lapse included and a batch of scorers on one session counted once. On a fresh CI runner each job starts a new data home, so the limit caps one job, not one day. `0` turns session scoring off. Scorers a person names count toward the limit and are never refused by it. Editing a scorer's rubric makes the captured sessions judge work again for it, and the daily limit spreads that over the following days.

With `attended: auto`, you do not have to run a driver. After the pull at a session's start, teamai starts one `teamai-finished-sessions` run in each scope the session's directory reaches, its project and your user scope, that judges or archives attended sessions automatically, and drives it in a detached process. The run archives and judges each finished session with a judge tool installed here, and starts `teamai-score` again for each pass and session whose judging lapsed. So a member's session start also rescores the lapsed workflow passes of that data home. The run ends after 30 minutes. Each `teamai-score` it runs publishes its labels to `teamai-reports`; offline, they stay pending for the next `teamai pull`. A start that would find nothing starts no run, and a run already working on the data home is left to finish. Each judging is one judge call on your account, at most `daily_limit` a day. A session scorer with a cheap [model alias](#choose-the-judges-model), such as `model: fast`, keeps that cheap. To stop it, set `scoring.sessions: { attended: off }` in `config.yaml`, or in `~/.teamai/config.yaml` for every workspace on this machine.

The detached run uses the tool's home that `teamai init` recorded, such as a moved `CLAUDE_CONFIG_DIR`. It does not see a credential or base URL that only your shell sets, notably on Windows. Keep those in the tool's sign-in, your user environment, or the tool's `settings.json` `env`.

A teamai older than this one rejects a scorer with `sessions: true`, so update teamai on every member's machine before the team adds one. An older teamai that takes judge work on your machine, such as a driver's own copy, removes the rubrics of session leases, so update every copy there before you turn on `scoring.sessions`.

#### Skill routing

Routing questions ask whether each team skill loaded where it should, and only there. Turn them on for the sessions `sessions` already judges. They are off by default:

```yaml
# scorers/scoring.yaml
sessions: true
skill_routing: true
```

Suppose a session asked for a review. It was delivered the root skill `review-notes` and the skill `release` from the `ops` skills namespace, and it loaded `review-notes`. Its `evidence.json` lists both skills:

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

The session gets one generated question per skill in `skills.available`: `teamai:routing:<skill>` for a root skill and `teamai:routing:<namespace>:<skill>` for a namespaced one. A skill marked `namespaceUnknown` gets no question, because it could be confused with another skill of the same name. The questions are never sampled. They share one judge launch however many there are, and count toward `daily_limit`. Under `batch: true`, the team's session scorers that ask for the same model and tool join that launch too. The names also resolve on demand, whatever `skill_routing` says, but only for a skill in that session's `skills.available`; any other name gives `scorer_not_found`:

```console
$ teamai score --session 7c1e… --scorer teamai:routing:ops:release --scorer teamai:routing:review-notes
ℹ teamai:routing:ops:release: idle (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/4b1d….md
ℹ teamai:routing:review-notes: fit (score 1, passed). Reasoning: ~/.teamai/scores/reasoning/8e07….md
```

After a few weeks, the [dashboard](dashboard.md)'s labels by value count each skill:

```text
teamai:routing:ops:release · session · 30 days
label    score   labels
fit      1       31
idle     1       112
extra    0       6
missed   0       9
```

Precision and recall come from those counts:

```text
precision(ops:release) ≈ 31 / (31 + 6) = 84%   loaded where it was not needed 6 times
recall(ops:release)    ≈ 31 / (31 + 9) = 78%   not loaded where it was needed 9 times
```

Every skill gets the same rubric, with only the skill's name filled in. Rewriting a skill's description leaves the scorer's measurement unchanged, so the counts from before and after the change can be compared:

```text
fit     1  <skill> is in skills.used, and the session needed what its description says.
idle    1  <skill> is not in skills.used, and the session did not need what its description says, or another skill or the agent's own steps did it.
extra   0  <skill> is in skills.used, and the session did not need what its description says.
missed  0  The session needed what the description of <skill> says, <skill> is not in skills.used, and nothing else did it.
Judge only the team skill <skill>, against its entry in skills.available in evidence.json.
```

That rubric is teamai's [default scorer](#default-scorers) `scorers/teamai-routing.md`. A team file of that name changes it for every skill.

An active scorers namespace's `scoring.yaml` overrides the root file's `skill_routing`, and one that sets `false` turns routing off for its members:

```yaml
# scorers/ops/scoring.yaml
skill_routing: false
```

A member's `scoring.skill_routing` in `config.yaml` wins over the team's. `~/.teamai/config.yaml` below a workspace or self scope can only turn it off, so a machine never starts paid judging.

To judge one skill its own way, leave `skill_routing` off and write one scorer per skill. This one adds an `unavailable` value for sessions that were not delivered `release`:

`scorers/ops/routing-release.md`:

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

With [`batch: true`](#batching), one judge launch answers all of a session's scorers that ask for the same model and tool. Each scorer samples sessions on its own, so ten per-skill scorers at 25% still reach about 94% of sessions while getting about a quarter of the answers. At 100%, the same launches answer every scorer. To spend less, lower `daily_limit` instead of `samplingRate`.

#### Recall adoption

Adoption questions ask whether a session used each doc `teamai recall` gave it but it never opened, such as one a recall subagent summarised. A doc the session opened is credited without a judge. Turn them on for the team, or for yourself:

```yaml
# scorers/scoring.yaml in the team repo
recall_adoption: true
```

```yaml
# ~/.teamai/projects/<project>/config.yaml, one member
scoring:
  recall_adoption: true
  sessions: { attended: auto }
```

A member's `recall_adoption` wins over the team's. `~/.teamai/config.yaml` below a workspace or self scope can only turn it off, so a machine never starts paid judging. `TEAMAI_UPVOTE_JUDGE=1` reads as the member setting above for each key the member config leaves unset, and `teamai doctor` says it is deprecated.

A finished root session gets one question per such doc, `teamai:adoption:<hash>`, named after the doc's vote key:

```text
session 7c1e…  recalled: pod-startup-timeouts, helm-values, retry-policy
opened by a tool call  → helm-values                      credited, no judge
teamai:adoption:3f9a1c… (pod-startup-timeouts)  → adopted   upvote, judged_count +1
teamai:adoption:b27e04… (retry-policy)          → ignored   judged_count +1
```

The judge reads the doc as the session got it, in `recalled/<hash>.md` of the evidence: at most 1,200 characters of a `.md` file under the team's knowledge roots. A doc it cannot read there gets no question. The questions share one judge launch and count toward `daily_limit`. A doc is credited once per root session, by a read or by a verdict, whichever comes first; judging it again on demand stores a label and credits nothing. When the votes file is busy, the verdict waits in the recall log and the next `teamai score` or `teamai pull` writes it. The recall log keeps a line for at most 30 days. A verdict written after the log has dropped every line of its session credits nothing, so a score run paused that long does not credit adoption, and `teamai pull` forgets which docs that session was credited for. See [Knowledge](knowledge.md#recall-adoption-and-upvotes) for what the counts do to confidence.

The rubric is the [default scorer](#default-scorers) `scorers/teamai-adoption.md`.

### teamai-finished-sessions

```text
teamai-finished-sessions   private, invoke: deny, timeout 30m
  sessions   teamai session list --finished --idle 6h   the finished sessions to archive or judge here
  share      teamai-share-session, for each             its publish step, then its teamai-score step
  lapsed     teamai score subjects --lapsed             passes and sessions whose judging lapsed, and passes no run scored, each with its scorers
  rescore    teamai-score, for each                     starts their judging again with those scorers only
```

A session start and `teamai score --drain` start it with `{"publish":"policy","scorers":[]}`, so the session policies decide. From your own terminal you can pass other inputs, for example to judge every finished session with one scorer and archive none, whatever the policies say:

```console
$ teamai workflow start teamai-finished-sessions --driver local --inputs '{"publish":"never","scorers":["review-quality"]}'
```

`publish` is `policy`, `always` or `never`. `scorers` names the scorers that judge each finished session, unsampled, counted toward `daily_limit` and never refused by it; `[]` leaves that to `scoring.sessions`. A run that a session start, a drain or an agent started lists sessions only with `policy` and `[]`, and other inputs fail with `policy_override_refused`.

| Clock | Set in | Default |
|---|---|---|
| A session counts as finished | `--idle` of the `sessions` step | 6 hours after its last activity; an unattended session once a drain reached it |
| A run ends | the file's `timeout` | 30 minutes; what it cancels lapses, and the next run starts it again |
| A judge no driver here takes | the `timeout` of share-session's `score` step | 30 minutes; the session stays published and its judging lapses |
| A lapse is started again | the scoring marks | until the fourth lapse, and only within 14 days of the run's last change; with the scorers its marks hold, a named one included, unsampled and, once named, never refused by `daily_limit`, and with no scorer the session policy would add now |

A team changes these in `workflows/teamai-finished-sessions.yaml` in its team repo, which replaces the default: `--idle 1h` takes a session one hour after its last activity, and `timeout` bounds a run. Steps can be added or reordered there too. What a team cannot change stays in the CLI: the automatic starts pass no agent evidence and only the policy inputs.

### Drain before an unattended job ends

```console
$ teamai score --drain
✔ Judged 1 sampled session here (review-quality)
✔ Published 1 label to teamai-reports
✔ Archived 1 captured session to teamai-reports (scrubbed)
✔ Reported usage to stats/<member>.yaml
ℹ Left open: the judge of 1 session in run rffc…: … A driver whose tools judge it takes it with: teamai workflow next rffc… --json '{"driver":{…,"can":{…}}}'
```

Every unattended driver ends with `teamai score --drain`. The local driver runs it at the end of an unattended run, unless publishing and scoring of unattended sessions are both `off`, or the run is a `teamai-finished-sessions` run. The skill driver, T3, Paseo and a CI script run it as their last step. It works in this order:

1. In unattended mode, every session this data home captured as unattended counts as finished, the calling session included. Attended sessions keep the six-hour rule.
2. It starts a [`teamai-finished-sessions`](#teamai-finished-sessions) run here, as a session start does, and drives it on the driver `workflows.driver` names, else on the local driver. A run for a driver this machine does not run waits for it, and the drain says how to drive it here. The run archives the finished sessions with `publish: auto` for their mode and judges the sampled ones the policies allow, within `daily_limit`. It starts `teamai-score` again for each pass and session whose judging lapsed, for each `start: workflow` pass its run left unscored, and for the open passes and sessions the upgrade carried over from judge attempts, except a pass whose run last changed more than 14 days ago. A run already working on this data home is left to it, and the drain says so: run the drain again once it ends.
3. It publishes every pending label, and what a [`deliver: publish`](workflow.md#publish-to-a-data-branch) step left pending on a data branch, as `score --push` does, and the workflow run records a run could not publish, as `teamai pull` does.
4. With `publish: auto` for the current mode, it archives on `teamai-reports`, scrubbed, the step sessions of the runs driven here that are not archived yet. A step session it cannot archive from here, because teamai reads no sessions from its tool or this machine cannot read it, is listed once as skipped with the reason, and never tried again. The other step sessions of that run are still archived. The trial sessions of a [benchmark](benchmarks.md) run stay on the machine that ran it.
5. It reports usage to `stats/<member>.yaml`, as `teamai pull` does, so the counts of an ephemeral runner reach the team.
6. It prints what is left: a judge step of its run that no driver here can take, such as one whose scorer pins a model no judge tool here runs, which waits for another driver's `workflow next`, and each pass or session whose CI has not finished, which the next drain labels.

A drain finishes and publishes only the sessions of its own run mode, so on a machine that is not in unattended mode, run `TEAMAI_MODE=unattended teamai score --drain` to drain unattended sessions.

The drain exits 0 when nothing is left that it can do here, judging left for other drivers included. It exits 1 when a judgment, a publish, a usage report or its run failed. A failed publish or usage report stays pending, and the next `--drain` retries it. A failed judgment is final: the drain prints it and never retries it. To ask for a new one, run `teamai score --session <id> --source <platform> --scorer <name>`.

Where the drain runs decides what it sees of the calling session:

```text
CI job:  claude -p "…"  →  tool exits  →  teamai score --drain      # the job's last step: the session is complete
skill:   … last turn of an unattended session → teamai score --drain  # the session as it stands now
```

As the job's last step, after the tool exits, the drain sees the session complete. From inside a session, it judges and publishes that session as it stands, and its later turns are neither judged nor published again.

Runs and scoring marks live in the runner's data home, so a runner killed before its drain loses that judging. A long-lived VM runs `teamai score --drain` at the end of each job.

## Default scorers

teamai ships the rubric of each question it generates per item as a default scorer in the installed package. A team file of the same name in `scorers/` replaces it for every member at their next `teamai pull`:

| Default | Asks | Variables |
|---|---|---|
| `scorers/teamai-routing.md` | one [routing question](#skill-routing) per team skill a session was delivered | `skill.name` |
| `scorers/teamai-adoption.md` | one [adoption question](#recall-adoption) per recalled doc a session never opened | `doc.id`, `doc.path`, `doc.file` |

A default is a scorer file whose text reads its variables as `{{ … }}`, filled in for each item. This one judges whether a skill was worth its context:

`scorers/teamai-routing.md`:

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

Pull refuses a file that reads anything but its default's variables, or that is no scorer once they are filled in, and the default keeps running:

```console
$ teamai pull
⚠ [scorers] scorers/teamai-routing.md: reads {{ skill.title }}, which teamai's default scorer teamai-routing does not offer. It offers skill.name; teamai's default runs until the file reads only those
```

Put each `{{ … }}` of the frontmatter inside a double-quoted string, as above: pull fills the file in with values that hold quotes, colons and newlines, and refuses it when one breaks the YAML. The file is not a scorer of its own: no step lists it, and `teamai score --scorer teamai-routing` finds no scorer. A changed rubric is a new rubric hash for each question, so its labels are counted apart from the old ones, as for [any scorer](#when-the-scorer-changes).

## The teamai-score workflow

`teamai score` and `teamai-share-session` label a subject by starting the [default workflow](workflow.md#default-workflows) `teamai-score`, `workflows/teamai-score.yaml` in the installed package:

```text
teamai-score   private, invoke: deny, timeout 336h
inputs: { subject: string, scorers: [string], label: string, batch: boolean, demand: auto | named, files: [string], store: boolean, control: boolean }
defaults: { inputs: { files: [], store: true, control: false } }

plan           teamai score plan → the groups: scorers that share one judge launch and the same stages
score          once per group:
  evidence     teamai score evidence → the redacted evidence, in a directory of its own
  check, ci, protected   the stages a delivered pass goes through; the first that fails decides
  judge        a prompt confined to the evidence directory, unless a stage decided or label is set
  label        teamai score label → each scorer's label
  write        teamai score write → scores/labels.jsonl and the pending outbox
  publish      teamai score publish → this member's pending labels, published to teamai-reports; skipped when store is false
  settle       teamai score settle, after a step of the group broke
```

`subject` is `run:<run>:<step>:<pass>`, `session:<source>:<id>` or `team-session:<author>:<archive>`. `files`, `store` and `control` have [defaults](workflow-advanced.md#give-an-input-a-default), so a step that runs `teamai-score` may leave them out; [`teamai-try-scorer`](#try-a-scorer-file) sets them to judge scorer files on a session, `store: false` writes and publishes no label, and `control: true` judges the session's first prompt alone. The run is `private`: it and the judge's reasoning stay on this machine. `invoke: deny` keeps every agent session from starting it, so an agent never labels its own work. A score verb run outside a `teamai-score` attempt answers `score_attempt_required`.

### Replace it for your team

A team `workflows/teamai-score.yaml` replaces teamai's for whoever receives it. It may reword the judge prompt around the rubric and the schema, reorder the stages, or drop `ci` or `protected`:

```yaml
# workflows/teamai-score.yaml (team file): teamai's, with the ci step left out and the judge prompt reworded
        - id: judge
          prompt: |
            Judge this change for our team, strictly. The rubric is in {{ steps.evidence.outputs.rubric }}.
            Reply with {"answer": <the answer>}, where the answer matches the schema in {{ steps.evidence.outputs.schema }}.
```

Pull refuses a file that changes what a label means, and teamai's default runs instead:

```text
⚠ [workflows] workflows/teamai-score.yaml:1: field "invoke": sets invoke: allow, so an agent session could start it and label its own work. Set invoke: deny
⚠ [workflows] workflows/teamai-score.yaml has no runnable version, so teamai's default teamai-score stays in effect
```

| Code | The file |
|---|---|
| `score_override_contract` | changes `inputs`, their `defaults`, or any `outputs`, drops `private: true`, or sets `invoke` to anything but `deny` |
| `score_override_command` | runs a command other than a score verb with the arguments teamai's gives it, gives a verb other `env`, or adds a `finally` step or a `setup` command |
| `score_override_workflow_step` | has a `workflow:` step other than the inline `score` |
| `score_override_prompt` | has a prompt step not confined to a directory, or one that lists `scorers` |
| `score_override_confined_dir` | confines the judge to a directory that is not an output of a step it needs |
| `score_override_judge_prompt` | has a judge prompt that does not read `steps.evidence.outputs.rubric` and `steps.evidence.outputs.schema` |
| `score_override_publish` | runs `teamai score publish` without `deliver: publish` to `teamai-reports`, publishes to another branch, or publishes without `if: inputs.store`, so a run that only tries scorers would publish |
| `score_override_step_missing` | drops or renames `plan`, `evidence`, `judge`, `label`, `write`, `publish` or `settle`, or `check` while a scorer here has a check |
| `default_override_alias` | is another workflow with `alias: teamai-score` |

A project runs teamai's default, or the project team's file, never a user scope's `teamai-score`, and each start from the project says so:

```text
⚠ [workflows] Ignored the user scope's teamai-score from this project: teamai's default runs here. Replace it for this project in the project's team repo.
```

### Run it from your workflow

```yaml
# workflows/wrap-up.yaml (team file)
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

A judge no driver here can take keeps `teamai-score` open until a timeout ends it. Its own `timeout`, 336h, binds it as a step and binds each `for_each` item, and the step's own ends it when that is shorter. Give the step a shorter `timeout` and `continue_on_failure: true`, as `teamai-share-session` does. Pull warns on a step without a timeout:

```text
⚠ [workflows] workflows/score-this.yaml: step "score" runs teamai-score with no timeout, so a judge no driver here can take holds it open until the run ends. Give it a timeout, such as timeout: 30m, and continue_on_failure: true.
```

In a coding session, the skill driver gives up such a judge step at once, when nothing else of the run is left and `continue_on_failure` lets it.

A judging run is never judged. Pull refuses `scorers:` on a step that runs `teamai-score` or `teamai-finished-sessions`, with `judging_scored`, and the file does not run:

```text
⚠ [workflows] workflows/wrap-up.yaml:1: field "steps.score.scorers": step "score" runs teamai-score and lists scorers, so its judging would be judged in turn. Remove scorers from the step
```

## Batching

```yaml
schemaVersion: v1alpha1
description: Review the change, judged by two scorers in one judge call.
steps:
  - id: review
    prompt: Review the change.
    scorers: { names: [review-quality, test-coverage], batch: true }
```

`scorers/test-coverage.md`:

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

The scorers of one pass that ask for the same `model` and `tool` and take the same stages share one judge step, one evidence directory and one prompt, and the answer has one label per scorer. The judge tool is chosen when the driver leases the step, not by what this machine has installed:

```json
{"answer":{"review-quality":{"label":"good","reasoning":"…"},"test-coverage":{"label":"thin","reasoning":"…"}}}
```

A step's `batch` wins over the workflow's `defaults.scorers.batch`, which wins over `batch` in [`scorers/scoring.yaml`](#isolation). `--batch` does the same for `--run`. Each label records `judge.batched: true`. One label a scorer does not list fails the whole answer `judge_answer_invalid`, and no label is written.

## Isolation

```yaml
# scorers/scoring.yaml
isolation: verified
batch: true
```

`scorers/scoring.yaml` holds the team's scoring settings. `scorers/ops/scoring.yaml` applies to members with the `ops` namespace active, as its scorers do, and replaces the root file's key of the same name. When two active namespaces set `isolation`, the strictest wins. When they set `batch` differently, those members get no judge work until one file changes.

The team's `isolation`, a scorer's `isolation`, and `scoring.isolation` in this scope's `config.yaml` or in `~/.teamai/config.yaml` may each ask for `verified`. The strictest wins; the default is `best-effort`. A value teamai does not know counts as `verified`, with a warning. `teamai doctor` prints the level, what sets it, the scorers that ask for more, and the level each judge tool here reaches:

```text
Scoring isolation: verified, set by scorers/scoring.yaml isolation.
Scoring isolation: best-effort, the default. scorers/ops/review-quality.md asks for verified for its own work.
Judge tools here: claude 2.1.308 (Claude Code) is verified, codebuddy 2.3.0 is best-effort.
```

The local judge runs each tool in its own profile:

| Tool | Level | `access` | Profile |
|---|---|---|---|
| Claude Code 2.1.308 | `verified` | `read` | `--restricted`, Read, Grep and Glob only, no MCP, no saved session. |
| codex-cli 0.163.0 | `verified` | `read` | A temporary home whose permission profile lets its shell read only the evidence, with no network and no writes. |
| OpenCode v2.1.2 | `verified` outside any git or hg checkout, else `best-effort` | `read` | Standalone, with isolated settings, database and data dirs; command, edit, web and external-directory permissions denied; judge sessions deleted after reading. |
| CodeBuddy, WorkBuddy | `best-effort` | `full` | Read-only tools, no MCP, no saved session. It lists about 70 tools whatever `--tools` says. Not signed in fails `judge_tool_unavailable`. |
| Cursor CLI | `best-effort` | `full` | Ask mode in Cursor's sandbox. |
| Pi Coding Agent | `best-effort` | `full` | Only its read, grep, find and ls tools; no context files, extensions or skills; no saved session. |
| Antigravity CLI | `best-effort` | `read` | Plan mode in agy's sandbox: it reads files, runs no shell and writes nothing in the evidence. The judge's conversation stays in agy's history. |
| Any other version | `best-effort` | as above | The same profile, unproven. |

A `best-effort` tool cannot judge for a scorer that requires `verified`, nor can [your own judge](#with-your-own-judge) at a lower level than required. Prompts travel through stdin or a file. Tool login and supported model-switch settings are kept. A scorer's model that no judge tool here runs leaves the work open for another driver, without changing the workflow result. [Choose the judge's model](#choose-the-judges-model) says which tool judges.

## Where labels go

| Path | What |
|---|---|
| `<dataHome>/scores/labels.jsonl` | Every label on this machine. |
| `<dataHome>/scores/reasoning/` | The judge's reasoning, one file per label. Never published. |
| `<dataHome>/scores/raw/` | A failed local judge's output, until a later attempt replaces it. |
| `<dataHome>/sessions/captures/` | What each session started as, written by the session-start hook. Removed a day after the session's file is gone. |
| `scores/<member>/<YYYY-MM>.jsonl` on `teamai-reports` | Published labels, the newest per scorer, rubric, subject and judge: a person, or each model judge's tool and model. Labels wait in `<dataHome>/scores/pending/` until the `publish` step of `teamai-score`, `teamai score --push` or `teamai pull` finds them on `teamai-reports`, and stay there while usage reporting is off. |

Labels never enter a workflow run or its record. A benchmark run freezes each trial's verdict when it ends, and its record carries the trial's result, not the label. Workflow Runs shows each pass's labels, and what judging cost apart from the run's own tokens. For a run on this machine that counts every judge attempt; for a run a member published, only the labelled ones. The dashboard's [Scorers page](dashboard.md#scorers) shows each scorer's pass rate over time and by configuration. `teamai digest --json` prints the same measurements with each failing label and the commit its work started at, which [`teamai self-improvement run`](self-improvement.md) turns into a PR.
