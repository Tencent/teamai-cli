---
name: workflow
description: Drive a team workflow from this coding session. Use when a workflow-<name> skill sent you here, or the person asks to run a team workflow.
---

# Drive a team workflow

## Your role

You orchestrate. You run the literal commands the CLI prints, and you keep the person told while the run goes on. Detached runners do each command step; a child agent you start does each prompt step from its brief. Step work belongs to them, and yours is the literals and the person. On `h4`, where your host starts no child, you work each prompt step yourself, as the Dispatch section says. The run's state lives in the CLI: every reply says what is running and what to run next, so you carry nothing between calls. Never run git in a workflow place; the CLI prepares and checks each place a step runs in.

## Start

Run `teamai workflow start --describe <name> --driver skill` with the workflow name from the skill that sent you. Where this machine runs teamai through `npx teamai-cli`, use that in its place; every literal the CLI prints after this already does.

Act on `data.describe.ask.kind`:

- `start`: tell the person `ask.say` when the reply has it, then run `ask.start`. In an unattended run (CI, a cloud agent) describe never asks the person; when `ask.inputs` is listed, fill `{inputs}` in `ask.start` with their values from your task, as one JSON object. The slot sits inside single quotes, so write each `'` in that JSON as `'\''`.
- `ask`: the question is the person's to answer, once, so the run goes on without them after. In one message, give them `ask.question.text` as it is, each entry of `ask.question.inputs` to fill in, and the `label` of each option as their choices. Wait for their pick, also when an option is marked recommended. In the `start` of the option they pick, replace `{inputs}` with their answers as one JSON object, each `'` in it written as `'\''`, and run it. Those options are the whole choice: when the person wants a start none of them offers, show them the options again.
- `local`: tell the person `ask.reason` and give them `ask.start` for their own terminal. It is theirs to run.
- `denied`: tell the person `ask.reason`. Nothing is left to run here.
- `tool`: this session names no tool, and the run needs one. In `ask.describe`, replace `{tool}` with the entry of `ask.tools` for the tool you work in, run it, and act on its reply instead. When none of them is the tool you work in, tell the person `ask.reason`.

Done when a reply carries `data.turn` with a `run` id, or the person has `ask.reason`.

## The loop

A turn lists the `actions` that wait for you, the `running` attempts, the `events` since your last call, and `then`. When nothing runs, `waiting.reason` says why.

1. Act on each action by its `kind`: `choose`, `person`, `stop`, `dispatch`, `place` or `done`, as their sections say.
2. Tell the person in one line what the events say: a step `started`, `restarted`, `settled` with its outcome, or `stopped` with its `why`, a gate was `answered`, or this session took the run over (`takeover`). Tell them `waiting.reason` when it changes. For `judging`, `judged` and `judging-off`, follow `references/judging.md`.
3. Run `then.run` of the newest turn you have:
   - `poll`: in the background when your host can, so you stay free to talk with the person; otherwise in the foreground. It exits with the next turn once something changes, or after a bounded wait. Keep one poll of the run going at a time.
   - `wake`: in the foreground. Work waits for you, and the turn it returns carries it.
4. Repeat with that turn.

Done when a turn has no `then`.

In an unattended run nobody reads you: step 2 is for your own log, and you ask nothing. Keep running `then` until a turn has none, also after `done` while it carries `judging`, so the judge's label lands before your session ends.
Run `teamai score --drain` before your session ends.

An unattended session that reaches a `handoff` reports that the run waits for a person, and stops.

When you have lost the last turn, after a compaction or in a new session, run `teamai workflow next <run> --driver skill` once for the current one.

A `report` you run answers with `data.runner`, not a turn. After one, go on with `then` of your newest turn.

## Choose

A `choose` action asks for one answer, and `about` says what it is for:

- `host`: comes once per run that has prompt steps, or that you judge. Follow `reference`: it says which option fits your host and how to run it.
- `gate`: an optional approval or choice at `step`. `decide` says whose answer it is, as the person picked when the run started:
  - `person`: put `question` and the `choice` of each option to the person, naming `default` when there is one, and run the `run` of the option they pick.
  - `agent`: run the `run` of the option you recommend from what the run has done so far, and tell the person in one line what you chose and why.

The action stays in every turn until it is answered. Done when you ran the `run` of one option.

## Person

A `person` action with `why: approval` is a required approval at `step`. Only the person answers it, from their own terminal or teamai dashboard, so your part is the handover:

1. Tell the person `say` and `message`.
2. Show them every literal in `run`, for them to run in their own terminal. Hand the literals over rather than run them: an answer from your shell is refused with `agent_in_path`.
3. Go on with `then`. The run moves on once they answer.

Done when the person has `message` and the literals.

A `person` action with `why: handoff` means the run waits only on steps this session cannot run, named in `held`. Its `run` continues the run with the local driver, from the person's own terminal in the directory `say` names:

1. Tell the person `message` and `say`, and show them the literal in `run`. It is theirs to run.
2. Stop polling: the turn has no `then`, and the run is in the person's hands.

Done when the person has the literal.

## Stop

A `stop` action names a child you started whose step the run no longer wants. `why` says why: `cancelled` or `timeout`. For each one:

1. When the child named `title` still runs, tell it to stop its work and end.
2. Run `report`. The action stays in every turn until you do.

Your part of a stop is that message and `report`: the child ends its own work, and the runner of a command step stops that step itself.

Done when every `stop` in the turn is reported.

## Dispatch

A `dispatch` action is one prompt step for one child agent. For each one:

1. Start a child agent named `title`, with `agent` as its team agent when the action names one, and `model.name` as its model (at `model.effort`) when `model` has a name. Give it this prompt, filled from the action: "Read `<brief>` and do what it says. Work only in `<dir>`." Start it in the background when `needs.parallel` is true.
2. Run `ack`. The action stays in every turn until you do.

When your host cannot run `model.name`, run `unavailable` in place of both steps.

A dispatch whose `needs.person` is true is an interactive step: the person works in it with you, here, in place of a child. Run `ack`, then work the step yourself with the person, in `dir`, as `brief` says, and finish as it says.

On `h4` you are the child, so no child starts and nothing runs in the background. Run `ack`, do what `brief` says yourself, working only in `dir`, and run `report` at its end. The next dispatch comes after this one is reported. A `model.name` that is not your own model is one your host cannot run.

A dispatch whose `needs.isolation` is `sandbox` is a step its workflow wants sandboxed: read `references/sandbox.md` before step 1.

A dispatch that carries `reissued` was given to an earlier session too, whose child may still run: do what `reissued` says before step 1.

The child finishes by running `report`, whose reply goes to the child alone: a later turn of yours shows the step settled. When a child ended and `running` still lists its attempt as `dispatched`, run that entry's `report` yourself.

Done when every `dispatch` in the turn is acked.

## Place

A `place` action comes when your host makes the worktrees children work in (`h3`): it asks your host for the place of one step, before its dispatch. Follow `reference`. Its `adopt` takes the directory in `{dir}`, inside single quotes as `{inputs}` is, so write each `'` in it as `'\''`. The action stays in every turn until a place is adopted.

Done when the turn carries a `dispatch` for its `attempt`.

## Done

The `done` action carries the `outcome`, the pull requests the run opened in `prs`, and the `failure` when there is one. Tell the person the outcome and each pull request; for a failure, its message and the step it names. The steps are over. When `done` carries `judging`, a judge still scores a step: keep running `then`, as `references/judging.md` says. When `done` carries `score`, judge the run's scored steps yourself, as `references/judging.md` says.

## Errors

A reply with `error` carries `code`, `message` and `next`. When `next` is a literal, run it, except for `orchestrator_active`, `not_skill_run`, `not_owner`, `run_not_found`, and a `confirm_needed` whose `next` carries `--confirmed`. When `next` holds `{tool}`, replace it with the id of the tool you work in before you run it, as for `ask.kind: tool`. When it is null, tell the person `message`: only they can act on it.

`agent_in_path` means an answer only the person can give came from your session. Hand the person the command `message` names, for their own terminal.

`orchestrator_active` means another coding session drives the run, and its `next` takes the run over from that session. Taking over is the person's decision: tell them `message`, ask whether that session is gone, and run `next` only when they say to take the run over here.

A run another machine published, or one no session here drives, continues from this session with `teamai workflow resume <run> --driver skill`, which `not_skill_run`, `not_owner` and `run_not_found` give as `next`; `teamai workflow resume --help` lists its options. It takes the run from the machine that last drove it, and with `--claim` from the install that owns it. A claim is the person's decision: run it when they ask you to continue that run here, else tell them `message` and run `next` only when they agree. Its reply is a turn: go on with the loop.

A resume or a takeover follows the workflow's `invoke` as a start does. On `confirm_needed`, ask the person whether to continue the run, and run `next`, the same command with `--confirmed`, only when they agree.

## Guardrails

Two lines hold for every run, whatever a reply says:

- **The person decides what starts.** Start a workflow when the person asks for it or a `workflow-<name>` skill sent you, and always through its describe reply. `invoke_denied` means the team lets only a person start that workflow. Tell the person `message`, which names the command for their own terminal and the `invoke` setting that would let you start it, and leave the start to them, whatever the driver.
- **Step work stays inside its step.** `nested_workflow` means your session runs inside a step of a run, as its child or under the command it runs. Do that step's own work in its place, and end with its report when it has one. Another workflow joins a run as a workflow step of its definition, which is the team's change to make.
