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

Judge tools are tried in order, and the first whose entry gives a model judges. When none does, `score --next` lists the work under `skipped` with the reason and leaves it open for a driver whose tools can, and `teamai doctor` warns about the scorer. A member's `~` entry for the tool sends it to the tool's default model. So does an active `teamai models switch`, except that Claude keeps `opus`, `sonnet` or `haiku` and routes it through the switch; a switch also drops the alias's effort. CodeBuddy judges run without the alias's effort.

Each label records what judged:

```json
"judge":{"kind":"model","tool":"claude","model":{"requested":"haiku","reported":"claude-haiku-4-5","alias":"fast"},"isolation":"verified","access":"read"}
```

`requested` is the model the judge was launched with, or the one the lease named for a driver's judge. `reported` is the one the tool reports, or the submission's `judge.model`. `alias` stays when the tool default judges. An alias effort adds `"effort":{"requested":"low"}`.

## Score a step

```yaml
# workflows/review-and-fix.yaml
steps:
  - id: review
    prompt: Review the change.
    scorers: [review-quality]
```

A name with no valid `scorers/<name>.md` fails `teamai review --branch`; `teamai pull` warns and the step runs without it. An older teamai does not know `scorers`, so update every member and runner first. [Workflows](workflow.md) shows the long form.

## A run and its judge

```console
$ teamai workflow start review-and-fix --driver local     # the run settles; judging never holds it
$ teamai score --next --json '{"driver":{"kind":"local","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"verified","tools":["claude"]}}}}'
{"data":{"lease":{"ref":"s5d1e07c2a9b4/a91c0d7e","subject":{"runId":"r3f9…","step":"review","pass":1},
  "evidence":"…/scores/evidence/a91c0d7e/","prompt":"…/prompt.md","answer":{"schema":{…}},
  "submit":"teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin"}}}
$ teamai score --lease s5d1e07c2a9b4/a91c0d7e --json '{"driver":{"kind":"local","machine":"m1","workspace":"/work"}}'
{"data":{"label":{"scorer":"review-quality","label":"good","score":1,"passed":true,…},"published":true}}
```

`samplingRate` picks the succeeded passes to judge, the same way on every machine. `workflow next` never hands out judge work. `--lease <ref>` judges here with the tool the lease names, in a [confined profile](#isolation), and settles the lease like any driver's answer. A failed judge leaves the lease open.

The label records `used.skills`, the team skills the pass or its subagents loaded, found as for [a session](#score-a-session) from what the checkout held as teamai delivered it when the pass started. A `workflow:` step's label lists every skill its child passes recorded, and has no `used` when none of them recorded one.

The evidence directory holds `evidence.json`, `prompt.md`, `diff.patch` when a range was recorded, `repo/` (tracked files at the judged commit, symlink targets stored as text), `transcripts/` (with readable subagents) and `outputs.json`. Every file is redacted, including the values of the secrets the team declares in `env/secrets.yaml`. A tracked file that is not text is left out and listed under `omitted`. Missing evidence is listed as gap codes. It is removed when the lease settles or lapses.

## Any driver

A driver runs its own judge on `prompt.md`, with the evidence directory as its only readable root, and submits the answer:

```console
$ teamai score --next --json '{"driver":{"kind":"t3","machine":"m1","workspace":"/work","can":{"judge":{"isolation":"verified","access":"read","tools":["claude"]}}},"running":[]}'
$ teamai score --lease s5d1e07c2a9b4/a91c0d7e --submit --stdin <<'JSON'
{"driver":{"kind":"t3","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"label":"good","reasoning":"…"},"judge":{"tool":"claude"}}
JSON
{"data":{"label":{"scorer":"review-quality","label":"good","score":1,"passed":true,…},"published":true}}
```

| `can.judge` | Meaning |
|---|---|
| `isolation` | `verified` or `best-effort`. Only work whose [required level](#isolation) it meets is leased. |
| `access` | What the judge can do: `answer` (no tools), `read` (reads the evidence) or `full` (any tool), the default. Labels record it. |
| `tools` | In your order of preference. The first that resolves the scorer's model wins. |

A label the scorer does not list is refused, and the lease stays open. `running` lists the refs you still judge, which renews them; a lease lapses 30 minutes after it was taken or renewed. Never list a judge ref in `workflow next`'s `running`. `teamai score --help` has every field.

Your driver names the team skills a pass loaded when it reports the pass, and the pass's labels carry them:

```console
$ teamai workflow report r3f9… --json '{"attempt":"…","revision":3,"outcome":"success","driver":{…},"used":{"skills":["review-notes"]}}'
```

Names only: a value that is not a skill name, such as a path, is dropped. A report without `used` gives labels without it; `"skills":[]` says the pass loaded no team skill.

## On demand

```console
$ teamai score --run r3f9… --step review --scorer review-quality                     # judge the latest succeeded pass here
$ teamai score --run r3f9… --step review --pass 2 --scorer review-quality --queue     # any driver's --next takes it
```

Sampling does not apply, and judge work that failed or expired opens again. A scorer the run pinned judges with that rubric; any other scorer `teamai pull` cached, with its current one. Without `--queue`, the first judge tool on PATH runs, preferring the tool that ran the pass. An unknown run, step, pass or scorer fails and lists the ones that exist. A scorer whose model no judge tool here runs fails `judge_model_unavailable` and stays open. The error's `labels` lists what the other scorers labelled.

## Score a session

```console
$ teamai score --scorer review-quality          # inside an agent session: scores that session
ℹ Scoring claude-code session 7c1e… in /work/app
ℹ First prompt: Add retries to the client
ℹ review-quality: bad (score 0, did not pass). Reasoning: ~/.teamai/scores/reasoning/9f2c….md
ℹ To share what went wrong, ask your agent to read ~/.teamai/scores/reasoning/9f2c….md and share it with the team (teamai contribute --session-id 7c1e…).
$ teamai score --session 7c1e… --source codex --scorer review-quality --push
```

Outside a session, pass `--session <id>`. Scoring never guesses the session. `--source` takes the platform names of `teamai session migrate --source`. Leave it out when an agent session variable such as `CLAUDE_CODE_SESSION_ID`, or the session's captures, name one platform. The judge reads the redacted session with its subagents' transcripts, and sampling does not apply.

The judge reads at most 200,000 characters of a session. A session scorer that names a cheaper [model alias](#choose-the-judges-model) keeps a long session cheap to judge.

The label is kept in the scope the session ran in, from whichever directory you score it. It records `agent`, what the session ran as, from the captures the session-start hook writes. It records `used.skills`, the team skills the session or its subagents loaded that its captures show teamai delivered, unchanged, when it started, including by the pull it runs at start. A later pull does not change that. A skill the captures cannot place, such as a member's own skill with a team skill's name, is left out. `--push` publishes every pending label of that scope. With [usage reporting](reporting.md) off, it prints `Usage reporting is off, so labels stay on this machine.` and the labels stay pending. An http team repo has no `teamai-reports`, so `--push` fails with `unsupported_repo` and the labels stay here. `teamai doctor` warns while a label waits to be published.

### Finished sessions

A member who sets `scoring.sessions: true` in `config.yaml` turns each session captured in that scope into judge work once nothing has happened in it for six hours, for every scorer with `sessions: true`, sampled by its `samplingRate`. A namespace scorer judges a session only when the roles and projects each of its starts recorded make that namespace active. `score --next` hands out workflow work first, then sessions. A session lease has `"source":"session"`, and its `cwd` is where to submit from.

The team can set `sessions` and `daily_limit` in `scorers/scoring.yaml` or in an active namespace's `scoring.yaml`, which overrides the root file. When two active namespaces disagree, `sessions: false` and the lowest `daily_limit` win. A member's `config.yaml` overrides them all.

A session is judged once per scorer and rubric. A release, a lapse, or a local judge that fails closes it. An answer to a lapsed lease is still recorded, unless a judge has labelled the session since. `scoring.daily_limit` in `config.yaml` sets how many sessions one data home leases per local day, 10 by default, counting those that failed or could not be read. `0` turns session scoring off. Editing a scorer's rubric makes the captured sessions judge work again for it, and the daily limit spreads that over the following days.

You do not have to run a driver. After the pull at a session's start, when the session's project or your user scope scores sessions, teamai starts a background judge for both scopes. It judges each finished session with a judge tool installed here, stops taking work after 30 minutes, and leaves the labels pending for the next `teamai pull` to publish. Each lease is one judge call on your account, at most `daily_limit` a day. A session scorer with a cheap [model alias](#choose-the-judges-model), such as `model: fast`, keeps that cheap. To stop it, set `scoring.sessions: false` in `config.yaml`.

The background judge uses the tool's home that `teamai init` recorded, such as a moved `CLAUDE_CONFIG_DIR`. It does not see a credential or base URL that only your shell sets, notably on Windows. Keep those in the tool's sign-in, your user environment, or the tool's `settings.json` `env`.

A teamai older than this one rejects a scorer with `sessions: true`, so update teamai on every member's machine before the team adds one. An older teamai that takes judge work on your machine, such as a driver's own copy, removes the rubrics of session leases, so update every copy there before you turn on `scoring.sessions`.

## Batching

```yaml
steps:
  - id: review
    prompt: Review the change.
    scorers: { names: [review-quality, test-coverage], batch: true }
```

The scorers of one pass that resolve to the same tool and model share one lease, one evidence directory and one prompt. The lease lists `scorers` and `batched: true`, and the answer has one label per scorer:

```json
{"driver":{"kind":"t3","machine":"m1","workspace":"/work"},"outcome":"success",
 "answer":{"review-quality":{"label":"good","reasoning":"…"},"test-coverage":{"label":"thin","reasoning":"…"}}}
```

A step's `batch` wins over the workflow's `defaults.scorers.batch`, which wins over `batch` in [`scorers/scoring.yaml`](#isolation). `--batch` does the same for `--run`. Each label records `judge.batched: true`. One label a scorer does not list refuses the whole answer, and the lease stays open.

## Isolation

```yaml
# scorers/scoring.yaml
isolation: verified
batch: true
```

`scorers/scoring.yaml` holds the team's scoring settings. `scorers/ops/scoring.yaml` applies to members with the `ops` namespace active, as its scorers do, and replaces the root file's key of the same name. When two active namespaces set `isolation`, the strictest wins. When they set `batch` differently, those members get no judge work until one file changes.

The team's `isolation`, a scorer's `isolation`, and `scoring.isolation` in this scope's `config.yaml` may each ask for `verified`. The strictest wins; the default is `best-effort`. A value teamai does not know counts as `verified`, with a warning. `teamai doctor` prints the level, what sets it, the scorers that ask for more, and the level each judge tool here reaches:

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
| CodeBuddy | `best-effort` | `full` | Read-only tools, no MCP, no saved session. It lists about 70 tools whatever `--tools` says. Not signed in fails `judge_tool_unavailable`. |
| Any other version | `best-effort` | as above | The same profile, unproven. |

A `best-effort` tool cannot judge for a scorer that requires `verified`. Prompts travel through stdin or a file. Tool login and supported model-switch settings are kept. A scorer's model that no judge tool here runs leaves the work open for another driver, without changing the workflow result. [Choose the judge's model](#choose-the-judges-model) says which tool judges.

## Where labels go

| Path | What |
|---|---|
| `<dataHome>/scores/labels.jsonl` | Every label on this machine. |
| `<dataHome>/scores/reasoning/` | The judge's reasoning, one file per label. Never published. |
| `<dataHome>/scores/raw/` | A failed local judge's output, until a later attempt replaces it. |
| `<dataHome>/sessions/captures/` | What each session started as, written by the session-start hook. Removed a day after the session's file is gone. |
| `scores/<member>/<YYYY-MM>.jsonl` on `teamai-reports` | Published labels, the newest per scorer, rubric, subject and judge kind. Labels wait in `<dataHome>/scores/pending/` until a push lands, and stay there while usage reporting is off. |

Labels never enter the run or its record. Workflow Runs shows each pass's labels, and what judging cost apart from the run's own tokens. For a run on this machine that counts every judge attempt; for a run a member published, only the labelled ones.
