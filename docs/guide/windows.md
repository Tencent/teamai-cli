# Windows: Getting Hooks to Fire

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

> What to check when TeamAI's agent hooks do not run on Windows.

## TL;DR

Hook commands use Git Bash by absolute path, so they do not land on WSL. WorkBuddy uses the shell it ships. ZCode uses Node. A tool with no shell is skipped. When `teamai doctor` passes, the hooks fire.

## Verify

```powershell
teamai doctor                       # every installed tool should report healthy hooks
teamai hooks list                   # the built-in hook set per tool

# run one hook by hand; exit code 0 means the dispatch works
& "C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; $LASTEXITCODE
```

What each event does is in [Core Harness](sharing.md#hooks).

## Hook folders

A [hook folder](sharing.md#hooks)'s path is written with forward slashes, and teamai adds no quotes. A home such as `C:\Users\Zoë Li` holds a space, so quote the variable:

```text
command: bash "${TEAMAI_HOOK_DIR}/scan.sh"       # bash "C:/Users/Zoë Li/.teamai/hooks/block-secrets.e246f037/scan.sh"
command: node "${TEAMAI_HOOK_DIR}/check.mjs"
command: powershell -File "${TEAMAI_HOOK_DIR}/scan.ps1"
```

Git Bash, Windows PowerShell and Node all read a forward-slash path. The command runs in the shell its tool uses, as above.

## Long paths during pull

TeamAI enables `core.longpaths` for its shared Git clients on Windows without
changing your global or repository Git configuration. A team-repo refresh
checks out paths before role filtering, so even an inactive namespace's deeply
nested skill files need long-path support. Other Git commands and tools may
still need their own long-path configuration.

If your Git configuration explicitly sets `core.longpaths=false`, some Git
versions still require changing that setting to `true`.

The first `teamai init` clone uses a separate provider path: if the team repo
already contains long paths, enable support first with `git config --global core.longpaths true`.

## If hooks still do not fire

- **Git for Windows is missing.** Without it the dispatch commands degrade to a
  bare `bash`, which Windows resolves to the WSL launcher; install Git for
  Windows and run `teamai hooks inject`.
- **`teamai doctor` says `gh` is not logged in** although `gh auth status` says
  it is. `doctor` may spawn `gh` without `APPDATA`, so it cannot see the login.
  Ignore it when the other checks pass.
