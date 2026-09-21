# TeamAI on Windows — getting hooks to actually fire

> A practical guide for running the TeamAI CLI (`teamai`) hook wiring on
> **Windows** for every enabled agent (Claude Code, Codex, ZCode, CodeBuddy,
> Qoder, WorkBuddy, Cline, Cursor, OpenCode), plus the upstream bug that makes
> this necessary and a suggested fix for maintainers.

## TL;DR

On older TeamAI versions the hooks injected on Windows used a bare `bash`
launcher that silently crashes (the WSL `bash` ships Node 18, which can't parse
the TeamAI bundle), so the hooks were effectively dead — `|| true` hid the
failure. The same versions never wrote `codebuddy` / `workbuddy` hooks at all,
because shell detection (`fs.existsSync('/bin/sh')`) is always false on Windows.

Current `teamai` handles Windows itself, so the user-side workaround below is
only needed on an older version: hook commands launch through an absolute Git
Bash path, and each GUI tool resolves its own hook shell — WorkBuddy through its
bundled PortableGit `sh.exe`, and **CodeBuddy through cmd.exe** (`%ComSpec%`),
which every Windows install provides. Neither tool is skipped.

The durable user-side fix combines two mechanisms so hooks fire no matter what
`teamai` writes:

1. **Git Bash absolute path** in every agent settings file (works today).
2. **A WSL wrapper** that delegates to the native Windows `teamai` via
   `cmd.exe` (survives a later `teamai pull` that reverts the hooks to bare
   `bash`).

After applying both, `teamai doctor` reports the six installed tools as healthy
and every `hook-dispatch` call returns `exit=0` through both mechanisms.

---

## How TeamAI hooks work (quick recap)

`teamai hooks inject` writes a command like this into each agent's settings
file:

```json
"command": "bash -lc \"teamai hook-dispatch session-start --tool claude 2>/dev/null\" || true"
```

There are six hooks per tool: `SessionStart`, `Stop`, `PostToolUse` (three
matchers: `*`, `Skill`, `TodoWrite`), and `UserPromptSubmit`. They let the team
repo record session stats and apply shared rules/skills across agents.

---

## The problem on Windows

### Failure mode 1 — bare `bash` → WSL Node 18 crash

On Windows a bare `bash` on `PATH` resolves to the **WSL launcher**
(`C:\Windows\System32\bash.exe`). WSL's bundled Node is **v18**, but the TeamAI
bundle needs a newer Node, so every hook invocation crashes silently. Because
the command ends in `|| true`, the crash is swallowed and nothing is logged —
hooks never fire, yet `teamai doctor` still reports them as "present".

### Failure mode 2 — `hasShell()` skipped CodeBuddy / WorkBuddy

`src/builtin-hooks.ts` gates shell-dependent tools on `hasShell()`:

```ts
export function hasShell(): boolean {
  if (_hasShellCache === undefined) {
    try {
      _hasShellCache = fs.existsSync('/bin/sh');
    } catch {
      _hasShellCache = false;
    }
  }
  return _hasShellCache;
}
```

`/bin/sh` does not exist on Windows, so `hasShell()` is `false` and
`skipToolsWithoutShell()` added `codebuddy` / `workbuddy`
(`SHELL_DEPENDENT_TOOLS`) to the skip set — those two agents got **no hooks at
all** on Windows, even when everything else worked.

That skip is gone: gating now asks each tool for its own hook shell first
(`hasShellFor()` → `bundledShellFor()`). `workbuddy` resolves through the
PortableGit `sh.exe` it ships; `codebuddy` resolves through cmd.exe, because
CodeBuddy's Windows hook runner is `%ComSpec%` — it executes a hook's `command`
via `child_process.spawn(command, [], { shell: true })` — and every Windows
install provides cmd.exe. Only a tool with no resolvable shell is skipped.

---

## Root causes

1. **Bare `bash` → WSL Node 18.** Windows `PATH` resolves `bash` to the WSL
   launcher before Git Bash; WSL Node 18 can't parse the TeamAI bundle.
2. **`hasShell()` Windows bug.** `fs.existsSync('/bin/sh')` is never true on
   Windows, which used to skip hook injection for `codebuddy` / `workbuddy`;
   the per-tool `bundledShellFor()` resolver now covers them.
3. **WSL path translation.** A WSL-side wrapper that `exec`s the Windows Node
   with a `/mnt/c/...` path gets mangled into `C:\mnt\c\...`, causing
   `MODULE_NOT_FOUND`.

---

## The fix (user-side, durable)

### Mechanism A — Git Bash absolute path in every agent settings file

Replace the bare `bash` in each hook command with Git Bash's absolute Windows
path (adjust if Git is installed elsewhere):

```json
"command": "\"C:\\Program Files\\Git\\bin\\bash.exe\" -lc \"teamai hook-dispatch session-start --tool <agent> 2>/dev/null\" || true"
```

Apply this to every agent that has hooks:

- `~/.claude/settings.json` — 6 hooks
- `~/.codex/hooks.json` — 6 hooks
- `~/.zcode/cli/config.json` — `command` field → Git Bash path; 6 hooks
- `~/.codebuddy/settings.json` — create if missing; 6 hooks
- `~/.qoder/settings.json` — create if missing; 6 hooks
- WorkBuddy / Cline / Cursor / OpenCode settings as applicable

Use a JSON-aware edit (don't hand-edit with `sed` — the double quotes must stay
escaped). Keep a `*.teamai-bak` copy of each original file so you can roll back.

### Mechanism B — WSL wrapper (durability against `teamai pull`)

`teamai pull` / `hooks inject` rewrites the agent settings back to bare `bash`.
Mechanism A gets overwritten, but a WSL wrapper keeps bare `bash` working.
Create a wrapper at your WSL home (e.g. `/home/<user>/.teamai-wsl/bin/teamai`):

```sh
#!/bin/sh
# delegate to the native Windows teamai (correct Node + paths) via cmd.exe
exec cmd.exe /c teamai "$@"
```

Prepend it to `PATH` from `~/.profile` / `~/.bashrc` under a marker:

```sh
# [teamai-wsl-fix]
export PATH="$HOME/.teamai-wsl/bin:$PATH"
```

Now a bare `bash` hook finds `teamai` → `cmd.exe` → native Windows TeamAI. The
`cmd.exe` delegation sidesteps the WSL `/mnt/c` path-translation bug entirely.
**This requires WSL to stay installed.**

### Completeness for all tools

- Add `qoder` and `codebuddy` to `enabledAgents` in `~/.teamai/config.yaml`.
- Copy the team's skills and rules from the team repo into `~/.qoder` and
  `~/.codebuddy` so those agents are fully equipped, not just hooked.

---

## Verification (all green)

```sh
teamai doctor
```

Expected: hooks present for **claude, codex, qoder, zcode, codebuddy,
workbuddy**.

Per-tool dispatch check, both ways:

```sh
# Mechanism A (Git Bash absolute path)
"C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?

# Mechanism B (bare bash via WSL wrapper)
wsl bash -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?
```

Every tool should print `0` through both mechanisms.

```text
doctor:   ✔ claude ✔ codex ✔ qoder ✔ zcode ✔ codebuddy ✔ workbuddy
dispatch (Git-Bash path): claude=0 codex=0 zcode=0 codebuddy=0 qoder=0
dispatch (bare bash/WSL): claude=0 codex=0 zcode=0 codebuddy=0 qoder=0 workbuddy=0
```

---

## Limitations / what it can't do

- **Durability depends on the WSL wrapper.** `teamai pull` reverts agent
  settings to bare `bash`; Mechanism A is overwritten, Mechanism B keeps it
  working *only while WSL is installed*. If WSL is removed, bare-`bash` hooks
  break again.
- **Requires WSL for Mechanism B.** On a machine without WSL, only Mechanism A
  (the Git-Bash absolute path currently in the files) works.
- **Does not patch older TeamAI versions.** The upstream `hasShell()` skip and
  the bare-`bash` default are fixed in current `teamai-cli`; `npm update
  teamai-cli` picks the fixes up and the workaround can then be dropped.
- **macOS / Linux need no fix.** There, bare `bash` already resolves to the
  system Node and works natively.
- **`teamai doctor` `gh` check can be a false negative.** It may spawn `gh`
  without `APPDATA`, so it can't see your login even though `gh auth status`
  shows you as logged in. Ignore it if your other checks pass.
- **Backup files remain.** `*.teamai-bak` copies of the edited agent settings
  are kept as rollback safety.

---

## Suggested upstream fix (for maintainers)

Two small changes would make Windows work out of the box — both have since
shipped in `teamai-cli`, so this section is kept for context:

### 1. Make `hasShell()` Windows-aware

On Windows, `/bin/sh` is absent but a usable POSIX shell is provided by Git for
Windows (`sh.exe` / `bash.exe`) or WSL. `hasShell()` should detect that instead
of always returning `false`:

```ts
export function hasShell(): boolean {
  if (_hasShellCache === undefined) {
    try {
      if (process.platform === 'win32') {
        // Git for Windows ships sh.exe/bash.exe; WSL also provides bash.
        // Hooks are launched via `bash -lc ...`, so any of these counts.
        const candidates = [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
          'C:\\Windows\\System32\\bash.exe',
        ];
        _hasShellCache = candidates.some((p) => fs.existsSync(p)) ||
          whichBash() !== null;
      } else {
        _hasShellCache = fs.existsSync('/bin/sh');
      }
    } catch {
      _hasShellCache = false;
    }
  }
  return _hasShellCache;
}
```

Current `teamai` achieves this through `hasShellFor()` → `bundledShellFor()`, so
`codebuddy` / `workbuddy` hooks are injected on Windows today.

### 2. Default the dispatch command to an absolute Git Bash path on Windows

`getDispatchCommand()` hard-codes `bash -lc "..."`. On Windows that resolves to
WSL's Node 18 and crashes. Prefer the Git Bash absolute path (or the bundled
PortableGit `sh.exe`) when `process.platform === 'win32'`.

Both changes are backward compatible: macOS/Linux keep `/bin/sh`, and Windows
users stop needing the manual workaround above.

---

## Troubleshooting

```sh
teamai doctor

# per tool, both ways:
"C:\Program Files\Git\bin\bash.exe" -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?
wsl bash -lc "teamai hook-dispatch session-start --tool claude 2>/dev/null"; echo $?

# if a tool's hooks stop firing:
#   1. confirm the wrapper exists:   ls ~/.teamai-wsl/bin/teamai
#   2. confirm PATH export in ~/.profile (marker # [teamai-wsl-fix])
#   3. otherwise re-apply Mechanism A (Git-Bash absolute path in the agent settings)
```

---

## Files changed (typical user-side layout)

| File | Change |
|------|--------|
| `~/.claude/settings.json` | hook commands → Git Bash absolute path (backup: `*.teamai-bak`) |
| `~/.codex/hooks.json` | hook commands → Git Bash absolute path (backup: `*.teamai-bak`) |
| `~/.zcode/cli/config.json` | `command` field → Git Bash path (backup: `*.teamai-bak`) |
| `~/.codebuddy/settings.json` | created with 6 hooks (if missing) |
| `~/.qoder/settings.json` | created with 6 hooks (if missing) |
| `~/.teamai/config.yaml` | `enabledAgents` += `qoder`, `codebuddy` |
| `~/.qoder/{skills,rules}`, `~/.codebuddy/{skills,rules}` | team resources copied |
| `~/.teamai-wsl/bin/teamai` (Win) + `<wsl-home>/.teamai-wsl/bin/teamai` (WSL) | durability wrapper |
| `~/.profile`, `~/.bashrc` | PATH export (marker `# [teamai-wsl-fix]`) |
