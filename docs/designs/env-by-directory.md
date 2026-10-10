# Team env by directory

> Status: **implemented**. Issue: [#1018](https://github.com/Tencent/teamai-cli/issues/1018).

A process started in a directory gets the team env of the scope that governs that directory, the scope `resolveConfigForDir` resolves. Nothing records a machine-wide "active project", so several projects open at once in separate windows each get their own env, and a workspace (#913) resolves like any other scope.

## Why not one block per scope

Before this, each scope wrote its own `source <env.sh>` block into the shell profile, and the profile kept the user scope's block plus at most one project block (#876). A pull in a project took over another project's block. With several project scopes on one machine, the profile followed whichever directory pulled last: the session-start pull flipped it each time a session opened in another project, and `doctor` failed in every other project. The pull also runs detached, after the agent has started, so the block it wrote never reached that session.

One block per data home would make every project live in every shell, team values of unrelated projects included.

## Contract

| Directory | Loads |
| --- | --- |
| In a project without `inheritUserScope` | the project's `env.sh` |
| In a project with `inheritUserScope: true` | the user scope's `env.sh`, then the project's (the project wins a key both define) |
| A linked worktree of a project | that project's, before the worktree has pulled |
| Anywhere else | the user scope's `env.sh` |

Secrets never come from the user scope in a project: `env.sh` holds no secret, and `teamai env exec` applies only the governing scope's.

## Mechanism

```text
pull (user scope)    ── registers ──▶ ~/.teamai/env-scopes   user <TAB> - <TAB> env.sh|- <TAB> 0 <TAB> -
pull (project scope) ── registers ──▶ ~/.teamai/env-scopes   git|dir <TAB> key <TAB> env.sh|- <TAB> inherits-user <TAB> partition
pull (any scope)     ── new stamp ──▶ ~/.teamai/env-scopes   first line, when the registry or an env.sh changes
pull (any scope)     ── writes ─────▶ ~/.teamai/env-loader.sh
                     ── one block ──▶ ${ZDOTDIR:-$HOME}/.zshenv (zsh) | .bashrc / the Git Bash chain (bash)

shell starts, or cd in an interactive shell
  └─ loader: git common dir of $PWD (or $PWD outside git) → registry line → env.sh files
             puts back what it set for the previous directory, then sources the new files
```

- The registry key is the git common directory, shared by a checkout and its worktrees, as the project partition is. Outside git it is the directory itself, as `detectProjectConfig` reads `<dir>/.teamai` only there.
- zsh reads `.zshenv` for every invocation, so the `zsh -c` a tool runs a command with gets the env of its own directory, whatever launched the tool. A `shellProfilePath` override still chooses bash's profile; zsh always uses `.zshenv` (under `$ZDOTDIR` when set), warns if the override names another zsh file, and moves an older block out of that file. bash reads no startup file for `bash -c` except the one `BASH_ENV` names, so the loader points `BASH_ENV` at itself and chains the member's original value after loading the env, in zsh as in bash.
- The loader exports the directory, the registry's stamp and the files it applied, so a child shell in the same directory does no work until a pull changes the registry or an `env.sh`. It restores whether each overridden key was unset, local to the shell, or exported; only values and markers that were exported before entry pass to child processes.
- A ZDOTDIR the CLI's environment carries is one every zsh started from it inherits, and those read `$ZDOTDIR/.zshenv`, never `~/.zshenv`, so the block goes there.
- `teamai env exec` resolves the same contract for any shell or tool: it drops values another scope's `env.sh` exported (the marker `env.sh` writes identifies them), then applies the user scope's variables when the project inherits it, then the project's. It drops the loader's exported bookkeeping and restores the member's original `BASH_ENV` (or removes it when there was none), so a `bash` the command starts does not reapply the previous directory's env over the one `env exec` applied.
- Loader resolution first unapplies the prior directory's env, so team `PATH` and `GIT_*` values cannot redirect or block registry lookup. Shell startup variables, hooks, and loader state are reserved across `env.sh`, `env exec`, MCP delivery, and session hints; reserved declarations are warned and ignored.
- Project registry rows carry their partition path so user-scope uninstall can preserve registered machine data without reopening a checkout. Rows without that association are malformed and ignored by both routing and preservation.
- `doctor` checks the contract where it is used: `This directory resolves its team env` starts the member's `$SHELL` in the directory and compares what the loader loaded with what this scope should. A shell that runs no loader passes it, with a note. The check that the profile carries the block keeps its earlier name, `Env variables injected in shell profile`, rather than the `Env loader installed` first proposed on the issue: it still checks env.yaml against env.sh too, and `doctor --json` consumers read it by name.
- A team with `injectShellProfile: false` still registers its project, with no env.sh, so its directories load neither its env nor the user scope's. A user-scope team with it registers its line with no env.sh, so the user `env.sh` loads nowhere: not outside projects, not under a project that inherits the user scope.
- A user scope last pulled by an earlier version has no registry line. Any pull, a project's too, writes it when it is missing, from the user scope's config and its team's `injectShellProfile`, as a user-scope pull would. When either cannot be read, the line says opted out and the pull warns: the user `env.sh` stays out of shells until a user-scope pull. The loader still falls back to the user `env.sh` with no line, so an opted-in user scope keeps its env in shells across the upgrade.
- User-scope uninstall unregisters its scope; the last scope also removes the loader and registry and takes out their profile block. If registered projects remain, it removes the user line and keeps each project's data directory and registry entry, including when that entry is `-`; the loader stays only while some remaining entry loads env. Home-only uninstall, when no valid configuration is found, removes all of `~/.teamai`, including registered project state, as on main (#915).
- A project without env writes no block of its own, but when a profile file already carries a teamai block, its pull installs the loader and takes out the per-scope blocks, so an older version's user block stops loading in its directories.

## Limits

- Shells other than zsh and bash (fish, PowerShell, cmd) run no loader; `teamai env exec` covers them, and `doctor` names the gap.
- With bash, a tool started outside a terminal (from a desktop app) gets nothing automatically; `teamai env exec` covers it.
- A project initialized by an earlier version is routed after its next pull; until then its directories get the user scope's env, and `doctor` says to pull there.
- With ZDOTDIR set, a login zsh whose `~/.zshenv` sets ZDOTDIR without sourcing `$ZDOTDIR/.zshenv` runs no loader itself; every zsh it starts does.
- zsh reads `.zshenv` before `.zshrc`: a key the member sets in `.zshrc` and the team also defines keeps the member's value in the shell it starts, and is not put back after a `cd` into another project and out.
- A project that inherits the user scope loads the user `env.sh` as the last user-scope pull wrote it; a project pull does not refresh it.
- A project whose env files cannot be resolved is not registered by that pull, so its directories keep what the registry had.
- The one-time notice that user env no longer loads in projects is printed by the pull that migrates the profile; when that pull is the silent session-start one, only `~/.teamai/debug.log` keeps it.
- The session-start hint names project variables and inherited user-scope variables, with project declarations taking precedence.
- Windows (Git Bash) is covered by unit tests only; CI has no Windows runner.
