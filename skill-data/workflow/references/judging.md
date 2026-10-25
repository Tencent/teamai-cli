# Judging

A run whose steps list scorers is judged on this machine when describe found the confined judge of your session's tool here and the person kept judging. TeamAI runs that judge in the background on each scored step's work, from evidence only the judge reads, so a label stays independent of the session whose work it scores. Your part is the person.

| Event | What happened | Tell the person |
|---|---|---|
| `judging` | A judge started on the pass of `step` that `scorers` judge. | `step` is being scored. |
| `judged` | `scorer` labelled the pass of `step` with `label`. | the step, the scorer and the label |
| `judging-off` | Judging of this run stopped for `failure`, and nothing more of it is judged here. | `failure.message` |

A `done` action that carries `judging` has a judge still open. Keep running `then` until a turn has none: each `judged` event comes in one of those turns.

The person opts out of judging before the run starts, by picking a `without judging` option of the describe question. A run keeps the judging it started with.
