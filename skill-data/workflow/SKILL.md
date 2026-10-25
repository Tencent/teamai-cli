---
name: workflow
description: Drive a team workflow from this coding session. Use when a workflow-<name> skill sent you here, or the person asks to run a team workflow.
---

# Drive a team workflow

## Your role

You orchestrate. You run the literal commands the CLI prints, detached runners do each step and report it, and you keep the person told while the run goes on. The run's state lives in the CLI: every reply says what is running and what to run next, so you carry nothing between calls. Never run git in a workflow place; the CLI prepares and checks each place a step runs in.

## Start

Run `teamai workflow start --describe <name> --driver skill` with the workflow name from the skill that sent you. Where this machine runs teamai through `npx teamai-cli`, use that in its place; every literal the CLI prints after this already does.

Act on `data.describe.ask.kind`:

- `start`: run `ask.start`.
- `ask`: put `ask.question.text` and each entry of `ask.question.inputs` to the person in one message. In the `start` of the option they pick, replace `{inputs}` with their answers as one JSON object, and run it.
- `local`: tell the person `ask.reason` and give them `ask.start` for their own terminal. It is theirs to run.

Done when a reply carries `data.turn` with a `run` id.

## The loop

A turn lists the `running` attempts, the `events` since your last call, and `then`.

1. Tell the person in one line what the events say: a step started, or settled with its outcome.
2. Run `then.run` in the background when your host can, so you stay free to talk with the person; otherwise run it in the foreground. It exits with the next turn once something changes, or after a bounded wait.
3. Repeat with that turn.

Done when a turn has `status: done`.

When you have lost the last turn, after a compaction for instance, run `teamai workflow next <run> --driver skill` once for the current one.

## Done

The `done` action carries the `outcome`, and the `failure` when there is one. Tell the person the outcome; for a failure, its message and the step it names. The run is over.

## Errors

A reply with `error` carries `code`, `message` and `next`. When `next` is a literal, run it. When it is null, tell the person `message`: only they can act on it.
