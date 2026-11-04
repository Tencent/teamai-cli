# Judging

A run whose steps list scorers is judged on this machine when describe found the confined judge of your session's tool here and the person kept judging. Each scored pass gets its own `teamai-score` run, which TeamAI drives with this run: its command steps run in the background, and its judge is a step confined to a directory (below), from evidence only the judge reads, so a label stays independent of the session whose work it scores. Its steps show in this run's turns. Your part is the person.

| Event | What happened | Tell the person |
|---|---|---|
| `judging` | A `teamai-score` run, or a judge, started on the pass of `step` that `scorers` judge. | `step` is being scored. |
| `judged` | `scorer` labelled the pass of `step` with `label`. | the step, the scorer and the label |
| `judging-off` | Judging of this run stopped for `failure`, and nothing more of it is judged here. | `failure.message` |

A `done` action that carries `judging` has a `teamai-score` run still open. Keep running `then` until a turn has none: each `judged` event comes in one of those turns.

The person opts out of judging before the run starts, by picking a `without judging` option of the describe question. A run keeps the judging it started with.

## Judging by this session

When this machine has no verified judge of your tool, you judge the run's scored steps yourself at `best-effort` isolation: the judge step of each pass's `teamai-score` run comes to you as a confined `dispatch` (below). A run started or resumed with `--no-judge` drives no `teamai-score` run, which stays for `teamai workflow resume <run>`. On a host you answered `h4` you start no subagent: TeamAI judges in the background on your tool at `best-effort` when that tool is on PATH here, else a `judging-off` event says another driver judges the run.

Judge only what comes to you as a dispatch. A judge step a scorer requires `verified` for never does: teamai's confined judge or another driver judges it, and judging it here would downgrade verified judging to best-effort.

## Steps confined to a directory

A prompt step confined to a directory is answered from that directory alone, which an earlier step of the run wrote. Its `confined.json` says the isolation it needs. It runs where judging runs:

- With teamai's confined judge of your tool here, TeamAI runs the step in the background on that tool, as it runs a judge. The turn shows the step `started` and `settled`; there is nothing else for you to do.
- When this session judges the run, the step comes as a `dispatch` whose `needs.confined` is true. Start a fresh child for it, never one that worked another step, and give it only the prompt the Dispatch section names: it reads nothing from this session or the checkout. A step that asks for `verified` isolation never comes to you.
- On `h4`, TeamAI runs the step in the background on your tool at `best-effort` when that tool is on PATH here, as it runs a judge.
- With `--no-judge`, or on `h4` without your tool on PATH, no confined step runs here. The run waits on them in `held`, for another driver.
- A held confined step inside a step that sets `continue_on_failure`, such as a group of `teamai-score`'s `score` step, is given up at once instead: teamai cancels that step and the run goes on without its labels. Tell the person the session was not scored here.

`teamai-share-session` scores a session by running `teamai-score`, whose `judge` step is such a confined step: its turns show `score.plan`, `score.score[0].evidence` and the other steps of that run like any other.
