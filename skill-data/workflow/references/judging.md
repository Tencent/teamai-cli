# Judging

A run whose steps list scorers is judged on this machine when describe found the confined judge of your session's tool here and the person kept judging. TeamAI runs that judge in the background on each scored step's work, from evidence only the judge reads, so a label stays independent of the session whose work it scores. Your part is the person.

| Event | What happened | Tell the person |
|---|---|---|
| `judging` | A judge started on the pass of `step` that `scorers` judge. | `step` is being scored. |
| `judged` | `scorer` labelled the pass of `step` with `label`. | the step, the scorer and the label |
| `judging-off` | Judging of this run stopped for `failure`, and nothing more of it is judged here. | `failure.message` |

A `done` action that carries `judging` has a judge still open. Keep running `then` until a turn has none: each `judged` event comes in one of those turns.

The person opts out of judging before the run starts, by picking a `without judging` option of the describe question. A run keeps the judging it started with.

## Judging by this session

When `done` carries `score`, this machine has no verified judge of your tool, and you judge the run's scored steps yourself at `best-effort` isolation. A run started or resumed with `--no-judge` has no `score`, and neither has a run whose host you answered `h4`: you start no subagent, so a `judging-off` event says another driver judges it.

1. Run `score`. It answers the next `lease` of the run's judge work, or `idle` when none is left. Its `decided` lists the labels teamai gave a delivered pull request before any judge, from a failed scorer check, failed CI or a protected-path refusal. Tell the person each, with what decided it; there is nothing to judge for those.
2. Judge each lease in a fresh subagent that reads only the lease's `prompt` and its `evidence` directory, never this session or the checkout, and answers in the shape of `answer.schema`.
3. From the lease's `cwd`, run its `submit` with the subagent's answer, the `driver` of `score`, and your tool as `judge.tool`. `teamai score --help` gives the payload. Tell the person each label. When the subagent gives no answer that fits, submit `"outcome":"released"`, tell the person, and stop judging this run: the work goes back to the queue for another driver.
4. Run `score` again until it answers `idle`. Work a scorer requires `verified` for stays open for another driver.

Without `score`, never judge the run's work yourself: teamai's confined judge or another driver judges it, and judging it here would downgrade verified judging to best-effort.

## Steps confined to a directory

A prompt step confined to a directory is answered from that directory alone, which an earlier step of the run wrote. Its `confined.json` says the isolation it needs. It runs where judging runs:

- With teamai's confined judge of your tool here, TeamAI runs the step in the background on that tool, as it runs a judge. The turn shows the step `started` and `settled`; there is nothing else for you to do.
- When this session judges the run, the step comes as a `dispatch` whose `needs.confined` is true. Start a fresh child for it, never one that worked another step, and give it only the prompt the Dispatch section names: it reads nothing from this session or the checkout. A step that asks for `verified` isolation never comes to you.
- With `--no-judge` or on `h4`, no confined step runs here. The run waits on them in `held`, for another driver.
- A held confined step inside a step that sets `continue_on_failure`, such as a group of `teamai-score`'s `score` step, is given up at once instead: teamai cancels that step and the run goes on without its labels. Tell the person the session was not scored here.

`teamai-share-session` scores a session by running `teamai-score`, whose `judge` step is such a confined step: its turns show `score.plan`, `score.score[0].evidence` and the other steps of that run like any other.
