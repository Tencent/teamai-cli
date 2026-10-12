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

## If hooks still do not fire

- **Git for Windows is missing.** Without it the dispatch commands degrade to a
  bare `bash`, which Windows resolves to the WSL launcher; install Git for
  Windows and run `teamai hooks inject`.
- **`teamai doctor` says `gh` is not logged in** although `gh auth status` says
  it is. `doctor` may spawn `gh` without `APPDATA`, so it cannot see the login.
  Ignore it when the other checks pass.
