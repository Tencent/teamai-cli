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

## What gets committed

A committing step's brief asks for `changed`: every path the step created, edited, renamed, or deleted, relative to the place. A rename or a copy lists the path it had and the path it has.

```json
{"kind":"output","output":"Fixed the null check.","changed":["src/app.ts","src/legacy.ts"]}
```

TeamAI commits those paths and pushes the branch. A path git would commit that is not in the list fails the step with `unreported_changes`. Nothing is committed or pushed, and the file stays in the place. That is also the failure when the step ran and reported a failure of its own. A failure from before the step ran, such as a model this session cannot run, stays that failure, and the file is still not committed. A file the preparation merge staged, and that the step left as the merge wrote it, is part of that merge. It does not have to be in the list.

A host that keeps writing after `adopt` hits that. `adopt` saw a clean tree. The script then writes `.setup-out`, which git does not ignore. These host files are examples. This repository does not run them.

Paseo, `paseo.json`, `worktree.setup` sleeps and then writes the file:

```json
{
  "worktree": {
    "setup": "sleep 2; echo host > .setup-out"
  }
}
```

T3, `t3.json`, a script with `runOnWorktreeCreate` writes it as the worktree is created:

```json
{
  "scripts": [
    {
      "name": "Setup Worktree",
      "command": "echo host > .setup-out",
      "runOnWorktreeCreate": true
    }
  ]
}
```

The step fails, and `.setup-out` is still in the place:

```text
Step "fix" left .setup-out in /work/teamai-fix, which the step did not report changing, so nothing was committed or pushed. If your host's setup wrote it, make setup write only files git ignores, or wait for it to finish before adopt. Otherwise remove it, then retry the step.
```

Wait for that script to finish before `adopt`, or make it write only files git ignores. `npm install` into `node_modules/` does not fail when `.gitignore` lists `node_modules/`:

```json
{
  "worktree": {
    "setup": "npm install"
  }
}
```

The install stays in the place and is not in the commit. The child's `src/app.ts` is.

A command has no `changed` list. When the place is already dirty as the command is about to start, the command does not run and the step fails the same way. The base agent files prepare put there are not that dirt: a path that still matches them is left out, the command runs, and finish puts the branch's copies back when the command left them unchanged. A file the command itself writes while it runs is still committed. That is why the host setup has to finish before `adopt`, or write only ignored files.

## Later steps

A later step on the same branch, a command or a read-only step included, goes on in the place the last step on it finished in, while that place passes the checks: a prompt's dispatch comes with that `dir`, and no `place` action. When the place no longer passes, because your host removed it or it has changes, a `place` action asks for another.

TeamAI commits the paths a prompt step lists in `changed`, and a command step's own writes, and never removes the place. Remove it with your host once the run is done.
