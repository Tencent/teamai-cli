# Team env by directory

> Status: **implemented**. Issue: [#1018](https://github.com/Tencent/teamai-cli/issues/1018).

A process started in a directory gets the team env of the scope that governs that directory, the scope `resolveConfigForDir` resolves. Nothing records a machine-wide "active project", so several projects open at once each get their own env.

## Why not one block per scope

Before this, each scope wrote its own `source <env.sh>` block into the shell profile, and a pull in one project replaced another project's block. The profile followed whichever directory pulled last, and `doctor` failed everywhere else. One block per data home would instead load every project's env in every shell.

## Contract

| Directory | Loads |
| --- | --- |
| A project | its `env.sh` |
| A workspace with repos set up inside it | its `env.sh`, which holds its own env plus theirs ([Workspace children](workspace-children.md)) |
| A project with `inheritUserScope: true` | the user scope's `env.sh`, then the project's; a key the project declares (variable or secret) is the project's |
| A linked worktree of a project | that project's, before the worktree has pulled |
| A project set up but not yet registered by a pull | nothing |
| Under a `.git` that git cannot read | nothing: the governing scope is unknown |
| Anywhere else | the user scope's `env.sh` |

User-scope secrets never load in a project. A team with `injectShellProfile: false` loads nothing for its scope, including the user env a project would inherit.

## Mechanism

```text
pull ── registers scope ──▶ ~/.teamai/env-scopes   (keyed by git common dir, or the dir outside git)
     ── writes ───────────▶ ~/.teamai/env-loader.sh
     ── one block ────────▶ .zshenv and the bash startup files

shell start, or cd in an interactive shell
  └─ loader: $PWD → registry row → env.sh files
             puts back the previous directory's values, then sources the new files
```

- The registry key is the git common directory, shared by a checkout and its worktrees. On Windows it is the native path in lower case; the loader prints the shell's directory in the same form.
- zsh reads `.zshenv` for every invocation, so `zsh -c` gets its directory's env. bash reads no startup file for `bash -c`, so the loader points `BASH_ENV` at itself and sources the member's own `BASH_ENV` before the team env.
- Interactive shells route on `cd`, before the member's prompt and `chpwd` hooks. Leaving a project restores each key as it was: unset, local, or exported. Inside it, a team value arrives as written whatever integer or case attribute the member's variable has; leaving puts the attribute back, except in bash before 4.2, which can't set one from a function.
- Resolution runs in the member's environment, so a team `PATH` or `GIT_*` cannot hide git from the lookup.
- `teamai env exec` and MCP delivery apply the same contract: values another scope's `env.sh` exported are dropped first.
- A pull writes `env.sh`, its backup, the profile block and the registry row as one step; on failure it puts the files back and exits non-zero. A project that cannot be resolved keeps the last pull's values.
- Names that control shell startup or the loader (`BASH_ENV`, `HOME`, `IFS`, `PROMPT_COMMAND`, `__TEAMAI_*`, ...) are reserved; team values for them are warned about and ignored.
- `doctor` starts the member's `$SHELL` in the directory and checks that the loader loads this scope's files.
- Uninstall keeps the loader, registry and project data while a registered project still needs them.

## Limits

- Only bash and zsh run the loader. fish, PowerShell, and tools started outside a shell use `teamai env exec`.
- A project initialized by an earlier version and untouched since gets the user scope's env until a teamai command saves its config or a pull runs there.
- zsh reads `.zshenv` before `.zshrc`, so a key the member sets in `.zshrc` keeps the member's value.
- Windows (Git Bash, MSYS zsh, Cygwin) is covered by unit tests only; CI has no Windows runner.
