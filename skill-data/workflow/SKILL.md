---
name: workflow
description: Drive a team workflow from this coding session. Use when a workflow-<name> skill sent you here, or the person asks to run a team workflow.
---

# Drive a team workflow

## Your role

You orchestrate. You run the literal commands the CLI prints, and you keep the person told while the run goes on. Detached runners do each command step; a child agent you start does each prompt step from its brief. Step work belongs to them: yours is the literals and the person. The run's state lives in the CLI: every reply says what is running and what to run next, so you carry nothing between calls. Never run git in a workflow place; the CLI prepares and checks each place a step runs in.

## Start

Run `teamai workflow start --describe <name> --driver skill` with the workflow name from the skill that sent you. Where this machine runs teamai through `npx teamai-cli`, use that in its place; every literal the CLI prints after this already does.

Act on `data.describe.ask.kind`:

- `start`: run `ask.start`.
- `ask`: put `ask.question.text` and each entry of `ask.question.inputs` to the person in one message. In the `start` of the option they pick, replace `{inputs}` with their answers as one JSON object, and run it.
- `local`: tell the person `ask.reason` and give them `ask.start` for their own terminal. It is theirs to run.

When `data.describe.judging.kind` is `elsewhere`, tell the person `judging.reason`: the scored steps are not judged on this machine.

Done when a reply carries `data.turn` with a `run` id.

## The loop

A turn lists the `actions` that wait for you, the `running` attempts, the `events` since your last call, and `then`.

1. Act on each action by its `kind`: `choose`, `person`, `stop`, `dispatch` or `done`, as their sections say.
2. Tell the person in one line what the events say: a step started, settled with its outcome, or stopped with its `why`, or a gate was `answered`. For `judging`, `judged` and `judging-off`, follow `references/judging.md`.
3. Run `then.run` of the newest turn you have:
   - `poll`: in the background when your host can, so you stay free to talk with the person; otherwise in the foreground. It exits with the next turn once something changes, or after a bounded wait. Keep one poll of the run going at a time.
   - `wake`: in the foreground. Work waits for you, and the turn it returns carries it.
4. Repeat with that turn.

Done when a turn has no `then`.

When you have lost the last turn, after a compaction or in a new session, run `teamai workflow next <run> --driver skill` once for the current one.

## Choose

A `choose` action asks for one answer, and `about` says what it is for:

- `host`: comes once per run that has prompt steps. Follow `reference`: it says which option fits your host and how to run it.
- `gate`: an optional approval or choice at `step`. `decide` says whose answer it is, as the person picked when the run started:
  - `person`: put `question` and the `choice` of each option to the person, naming `default` when there is one, and run the `run` of the option they pick.
  - `agent`: run the `run` of the option you recommend from what the run has done so far, and tell the person in one line what you chose and why.

The action stays in every turn until it is answered. Done when you ran the `run` of one option.

## Person

A `person` action is a required approval at `step`. Only the person answers it, from their own terminal or teamai dashboard, so your part is the handover:

1. Tell the person `say` and `message`.
2. Show them every literal in `run`, for them to run in their own terminal. Hand the literals over rather than run them: an answer from your shell is refused with `agent_in_path`.
3. Go on with `then`. The run moves on once they answer.

Done when the person has `message` and the literals.

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

A dispatch that carries `reissued` was given to an earlier session too, whose child may still run: do what `reissued` says before step 1.

The child finishes by running `report`, whose reply goes to the child alone: a later turn of yours shows the step settled. When a child ended and `running` still lists its attempt as `dispatched`, run that entry's `report` yourself, then go on with `then` of your newest turn.

Done when every `dispatch` in the turn is acked.

## Done

The `done` action carries the `outcome`, and the `failure` when there is one. Tell the person the outcome; for a failure, its message and the step it names. The steps are over. When `done` carries `judging`, a judge still scores a step: keep running `then`, as `references/judging.md` says.

## Errors

A reply with `error` carries `code`, `message` and `next`. When `next` is a literal, run it, except for `orchestrator_active`. When it is null, tell the person `message`: only they can act on it.

`agent_in_path` means an answer only the person can give came from your session. Hand the person the command `message` names, for their own terminal.

`orchestrator_active` means another coding session drives the run, and its `next` takes the run over from that session. Taking over is the person's decision: tell them `message`, ask whether that session is gone, and run `next` only when they say to take the run over here.
