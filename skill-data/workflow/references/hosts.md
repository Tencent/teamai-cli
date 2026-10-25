# The host question

The host question asks how this coding session starts a child agent, and so how many prompt steps the run hands out at once. Every child works from its brief in the `dir` its dispatch names.

1. Find the most specialized way your host has to start a child agent, in this order:
   1. App orchestration tools: a tool of the app you run in that starts a child task or thread with a prompt and a model.
   2. Team agents: agents your host starts by name, such as the files in `.claude/agents/`.
   3. Native subagents: the host's own subagent tool.
2. Pick the first option whose row fits that way:

   | Option | Pick it when that way | Children at once |
   |---|---|---|
   | `h3` | makes a worktree of its own for each child to work in, as T3 worktree tasks, Claude Code agent teams with worktrees and Codex worktrees do | up to the run's `--parallel` |
   | `h1` | runs several children in the background while you keep working | up to the run's `--parallel` |
   | `h2` | runs one child at a time, or only in the foreground | one |

   On `h3`, a step that commits to a branch first comes as a `place` action: your host makes the worktree, and TeamAI adopts it before the step's dispatch comes.

3. Run the option's `run`.

Done when the turn it returns has no `choose` action.

When your host has none of the three ways, tell the person: this session cannot start the run's prompt steps, and `teamai workflow cancel <run>` ends the run.
