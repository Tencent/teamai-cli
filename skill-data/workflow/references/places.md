# Places your host makes

On `h3`, your host makes the worktree a prompt step works in, and TeamAI adopts it. TeamAI owns the contract: the branch, the commit it starts from, and the checks the place must pass. Your host owns the place. A `place` action asks for the place of one step, for each `attempt`:

1. Have your host make a worktree of this repository named `name`, on branch `branch` from commit `start`. When your host takes only a starting point, make it detached at `start`: TeamAI creates `branch` there when it adopts it.
2. Run `adopt` with the worktree's absolute directory in place of `{dir}`. The slot sits inside single quotes, so write each `'` in that directory as `'\''`.
3. Act on the turn it returns:
   - A `dispatch` for the same `attempt`: start the child in that worktree, as the workflow skill's Dispatch section says. Its `dir` is the place.
   - The `place` action again, with `refused`: the place was not adopted, and `refused` says why and what to fix. Fix that place or make another, then run `adopt` again. The step keeps waiting, and a refusal costs it nothing.

Done when the turn carries a `dispatch` for the `attempt`.

When your host makes a worktree only as it starts a child there, start that child first and tell it to wait for its task. Adopt the worktree it got, then send it the dispatch's prompt as its task.

## The checks

`adopt` checks the place before it changes anything there. The place must be:

- the top directory of a worktree of the run's repository, as `git worktree add` in this checkout makes; a separate clone does not count;
- clean: no uncommitted or untracked changes;
- on `branch`, or detached at `start` while `branch` does not exist yet;
- holding `start` in its history;
- left by no setup that failed or was cut short there: remove that worktree and make it again;
- free: no other open step of the run works there.

A step that was stopped leaves its edits in its place for your host to keep or drop. Commit, stash or remove them before you adopt that place again.

## Later steps

A later step on the same branch, a command or a read-only step included, goes on in the place the last step on it finished in, while that place passes the checks: a prompt's dispatch comes with that `dir`, and no `place` action. When the place no longer passes, because your host removed it or it has changes, a `place` action asks for another.

TeamAI commits each step's work in the place and never removes it. Remove it with your host once the run is done.
