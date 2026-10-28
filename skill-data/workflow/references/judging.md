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

1. Run `score`. It answers the next `lease` of the run's judge work, or `idle` when none is left.
2. Judge each lease in a fresh subagent that reads only the lease's `prompt` and its `evidence` directory, never this session or the checkout, and answers in the shape of `answer.schema`.
3. From the lease's `cwd`, run its `submit` with the subagent's answer, the `driver` of `score`, and your tool as `judge.tool`. `teamai score --help` gives the payload. Tell the person each label. When the subagent gives no answer that fits, submit `"outcome":"released"`, tell the person, and stop judging this run: the work goes back to the queue for another driver.
4. Run `score` again until it answers `idle`. Work a scorer requires `verified` for stays open for another driver.

Without `score`, never judge the run's work yourself: teamai's confined judge or another driver judges it, and judging it here would downgrade verified judging to best-effort.
