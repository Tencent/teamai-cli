# Take a step from a fleet

A fleet member runs a step that another install's run offered to a pool. You are one when the person asks you to take fleet work, or when this session started with a message such as `teamai workflow resume --next --pool <pool>`: the run's owner woke a member for an offer nobody had claimed.

1. Work in a checkout of the business repository the offer is for: the repository your start message names, or the person's checkout. `teamai workflow resume --help` says what `--next --pool` takes and what it skips.
2. Run `teamai workflow resume --next --pool <pool>` once, with the pool your message or the person names. It claims one attempt, runs its step on this machine and pushes the work for the owner.
3. Act on its last line:
   - `data.ran`: tell the person the `run`, the `step` and its `exit_code`.
   - `data.cancelled`: the owner cancelled the attempt meanwhile. Tell the person.
   - `data.idle`: there was nothing for this machine to take. Another member claimed it first, the step needs what this machine lacks (the log says what), or the offer is of a run whose record this machine's data home holds, which is its owner's. Tell the person, and stop.
   - `error`: tell the person `message`.

Done after one call. Run it again only when the person asks for more work. Never edit the attempt's record or its ref yourself: the CLI writes them. `teamai workflow resume` with no run id lists the attempts out on a fleet.
