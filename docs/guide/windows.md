# Windows: Getting Hooks to Fire

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

> What to check when TeamAI's agent hooks do not run on Windows.

## TL;DR

On Windows, the hook commands teamai writes into each agent's settings reference
**Git Bash by absolute path** (standard install locations first, then the
`HKLM\SOFTWARE\GitForWindows` registry key), so they never resolve to the WSL
`bash.exe` launcher. Each GUI tool resolves its own hook shell: WorkBuddy uses
the PortableGit `sh.exe` it ships, CodeBuddy the Git Bash it requires on Windows.
Only a tool with no resolvable shell is skipped. ZCode hooks launch through a
`wscript.exe` launcher and need no bash at all.

If Git for Windows is installed and `teamai doctor` passes, hooks fire. Read on
only if they do not.

## Verify

```powershell
teamai doctor                       # every installed tool should report healthy hooks
teamai hooks list                   # the built-in hook set per tool

# run one hook by hand; exit code 0 means the dispatch works
& "C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; $LASTEXITCODE
```

The hook set per tool, and what each event does, is in the [Usage Guide](hooks.md#hooks).

## If hooks still do not fire

- **Git for Windows is missing.** Without it the dispatch commands degrade to a
  bare `bash`, which Windows resolves to the WSL launcher; install Git for
  Windows and run `teamai hooks inject`.
- **`teamai doctor` says `gh` is not logged in** although `gh auth status` says
  it is. `doctor` may spawn `gh` without `APPDATA`, so it cannot see the login.
  Ignore it when the other checks pass.
