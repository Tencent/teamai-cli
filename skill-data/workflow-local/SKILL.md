---
name: workflow-local
description: Run a team workflow unattended with the local driver. Use in CI or a cloud agent, when a describe reply routed the run to the local driver, or to continue a run on this machine without a coding session.
---

# Run a team workflow unattended

The local driver runs a whole run in one process on this machine: each command step as a process, each prompt step through a headless tool. Nobody is asked anything while it runs, so every answer the run needs is decided before it starts.

## When

- A CI job or a cloud agent runs the workflow.
- `teamai workflow start --describe <name> --driver skill` answered `ask.kind: local`: a coding session cannot run some step, and `ask.reason` says which.
- A run continues on this machine without a coding session: after a retry, an answer, a stopped driver, or a session that handed it over.

## Run it

1. Run `teamai workflow start <name> --describe` and read the inputs it lists.
2. Start the run: `teamai workflow start <name> --driver local`, with the inputs as one JSON object in `--inputs`. `teamai workflow start --help` lists the other options, such as answering optional approvals and picking the prompt tool.
3. To continue a run that stopped, run `teamai workflow resume <run>`.

The command exits when the run ends: 0 when it succeeded, 1 when it failed or was cancelled. Done when it has exited and the outcome, the failing step's message and the pull requests the run opened are reported where the person reads them: the job log, or your reply.

## Approvals

Without a terminal, nobody answers a gate during the run:

- A required approval fails its step `hitl_required`, and so does the run.
- With `--auto-approve`, or the member's `workflows.auto_approve`, an optional approval is answered yes and a choice takes its default.
- Without either, an optional approval is skipped, and a choice fails `hitl_required`.

## From an agent session

A coding agent's session may start or continue only a workflow whose `invoke` allows it, with `start` or `resume`. `invoke: allow` goes on. `invoke: ask` goes on once the person agreed, with `--confirmed`, and never in an unattended run (CI or a cloud agent), where it answers `unattended_denied`. `invoke: deny`, the default, answers `invoke_denied`. Tell the person the `message`, which names the command for their own terminal.

Inside a workflow step, every `teamai workflow` command that changes a run answers `nested_workflow`. Do the step's own work there instead.

## Env and secrets

A step gets the team env keys its `requires.env` lists, and no other team key. A key with no value on this machine fails the step `missing_env` before it runs, and the message says how to give it a value: the `teamai env set` command for a key the team declares, the environment for one it does not. A CI job exports each secret under its key name instead. TeamAI masks the value of every key in `env/secrets.yaml` in run files and output.

## CI

When you set up a CI job that starts a run, or one that takes the runs members offer, read `references/ci.md`.
