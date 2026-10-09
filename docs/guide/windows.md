# Windows: Getting Hooks to Fire

> [English](windows.md) | [简体中文](zh-CN/windows.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

> What to check when TeamAI's agent hooks do not run on Windows, and why older
> releases needed a manual workaround. Current `teamai-cli` handles Windows on
> its own; the fix for an older install is `npm update -g teamai-cli`.

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

The hook set per tool, and what each event does, is in the [Usage Guide](advanced.md#hooks).

## If hooks still do not fire

- **Git for Windows is missing.** Without it the dispatch commands degrade to a
  bare `bash`, which Windows resolves to the WSL launcher; install Git for
  Windows and run `teamai hooks inject`.
- **Old teamai-cli.** Releases before the Git Bash resolver wrote bare `bash`
  commands and skipped CodeBuddy / WorkBuddy entirely (see below). Upgrade and
  run `teamai hooks inject`; you do not need the WSL wrapper or the hand-edited
  settings files that older guides described, and `teamai pull` will not revert
  the commands.
- **`teamai doctor` says `gh` is not logged in** although `gh auth status` says
  it is. `doctor` may spawn `gh` without `APPDATA`, so it cannot see the login.
  Ignore it when the other checks pass.

## What went wrong on older releases

1. **Bare `bash` → WSL Node 18.** Windows `PATH` resolves `bash` to the WSL
   launcher (`C:\Windows\System32\bash.exe`) before Git Bash. WSL's bundled Node
   is v18, which cannot parse the teamai bundle, so every hook crashed silently;
   the trailing `|| true` swallowed the error and `doctor` still reported the
   hooks as present.
2. **`hasShell()` skipped CodeBuddy / WorkBuddy.** Shell detection was
   `fs.existsSync('/bin/sh')`, which is never true on Windows, so those two
   tools received no hooks at all. Gating now asks each tool for its own hook
   shell (`hasShellFor()` → `bundledShellFor()`).
3. **WSL path translation.** A WSL-side wrapper that `exec`s the Windows Node
   with a `/mnt/c/...` path gets mangled into `C:\mnt\c\...`
   (`MODULE_NOT_FOUND`). This is why the old WSL-wrapper workaround delegated
   through `cmd.exe`.

Current `teamai-cli` fixes all three. macOS and Linux were not affected.
