# The host question

The host question asks how this coding session starts a child agent, and so how many prompt steps the run hands out at once, and whether the session can judge the run in a fresh subagent. Every child works from its brief in the `dir` its dispatch names. When your host starts its children in a sandbox, a container or a VM, read `sandbox.md` beside this file first.

1. Find the most specialized way your host has to start a child agent, in this order:
   1. App orchestration tools: a tool of the app you run in that starts a child task or thread with a prompt and a model.
   2. Team agents: agents your host starts by name, such as the files in `.claude/agents/`.
   3. Native subagents: the host's own subagent tool.
   4. None: your host starts no child, or its children cannot run teamai.
2. Pick the first option whose row fits that way:

   | Option | Pick it when that way | Children at once |
   |---|---|---|
   | `h3` | makes a worktree of its own for each child to work in, as T3 worktree tasks, Claude Code agent teams with worktrees and Codex worktrees do | up to the run's `--parallel` |
   | `h1` | runs several children in the background while you keep working | up to the run's `--parallel` |
   | `h2` | runs one child at a time, or only in the foreground | one |
   | `h4` | is none: you work each prompt step yourself | none: you work one step at a time |

   On `h3`, a step that commits to a branch first comes as a `place` action: your host makes the worktree, TeamAI checks and adopts it, and then the step's dispatch comes. `places.md` beside this file says how.

   On `h4`, you work each prompt step yourself, one at a time, in the checkout. A step that is not interactive only reads there: TeamAI fails it when it leaves a file changed. A step that works in a worktree is the person's to run from their own terminal: once nothing else is open, a `person` action with `why: handoff` hands the run to them.

3. Run the option's `run`.

Done when the turn it returns has no `choose` action.

When your host cannot run the commands a turn prints, tell the person: this session cannot drive the run, and `teamai workflow cancel <run>` ends the run.
