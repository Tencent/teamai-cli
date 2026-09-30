# Troubleshooting & Agent-specific caveats

Load this whenever a step fails, `teamai doctor` flags something, or team
resources don't show up. It is shared by all four scenarios.

## First move: run doctor

```bash
teamai doctor
```

It checks provider config, hooks, paths, and package/plugin status. Fix what it
reports before anything else.

## "My skills / rules aren't showing up"

This is the #1 onboarding issue. In order:

1. **Open a fresh session.** Resources sync on **session start** via a hook, not
   at init time. An empty skills folder right after `teamai init` is normal.
2. **Sync manually to confirm:**
   ```bash
   teamai pull
   teamai list        # do the team skills appear now?
   ```
3. **Check the hook is installed** (`teamai doctor` reports this). If missing,
   re-inject and reopen the tool:
   ```bash
   teamai hooks inject
   ```
4. **Wrong scope?** Project-scope hooks are written to your HOME tool settings
   (e.g. `~/.claude/settings.json`), not the project folder — that is intentional.
   If you initialized project scope but expected machine-wide resources, re-run
   with `--scope user`.
5. **Tool has no hook surface** (e.g. Gemini CLI, JoyCode): there is no auto-sync;
   run `teamai pull` manually each time.
6. **Claude Code reads a different directory** (`CLAUDE_CONFIG_DIR` is set).
   `teamai doctor` reports `Claude Code root matches CLAUDE_CONFIG_DIR` when the
   directory the variable names is not the one this config syncs to. Re-run
   `teamai init` from a shell that has the variable exported; it records the root
   and moves the install. If the check says the value cannot be synced to (outside
   your home, or nested deeper than `~/.config/<name>`), fix the variable first.
6. **A command reports a broken manifest** (`Invalid roles manifest…`,
   `Invalid projects manifest…`, `Invalid manifests…`, or `…manifest … could not
   be read`). `pull` skips that scope on purpose, since syncing without the
   manifest would deliver every namespace it gates; `push` stops before pushing
   anything, even with `--role`; `status` lists the other resource types. The fix
   belongs in the team repo's `manifest/roles.yaml` or `manifest/projects.yaml`,
   which the error names by entry — tell the user to ask a team admin. Do not
   delete the manifest or edit the local clone to get past it.
   `recall` still searches learnings and warns once (`Recall indexed learnings
   only…` or `Recall indexed the shared learnings only…`): what it names is
   missing from results until the manifest is fixed and `teamai pull` rebuilds
   the index, so do not report that the team has none of it. If recall also says
   `Recall skips the older index at <path>…`, the smaller index could not be
   written and that scope was not searched at all: resolve the error it names
   (for example a read-only file or a full disk), then fix the manifest and pull.
7. **`pull` says `Nothing was synced: <file>: <reason>`.** The project's teamai
   config exists but cannot be read, so no scope syncs there, not even the user
   scope, and the session-start hook syncs nothing either. Show the user the
   file and the reason; `teamai doctor` checks another config and can pass
   here. Moving it aside and re-running `teamai init` replaces their settings
   for that project: do it only with their consent.
   `recall` refuses the same way with `Nothing was searched: <file>: <reason>`:
   no team knowledge was searched, so do not report that the team has none.

## "KEY is not set. Run `teamai env set KEY`"

`pull`, `teamai mcp list`, `teamai env list`, `teamai doctor` and
`teamai env exec` (on stderr) print this for a secret the team declares in
`env/secrets.yaml` that has no value on this machine, naming the MCP servers
that need it and where to get one. It is a note, not a failure: `doctor` exits
as it would without it. The value is the user's: ask them to run
`teamai env set KEY` in their own terminal (it prompts without echo), then
`teamai pull` to update the MCP servers; a CLI run through `teamai env exec`
gets it on its next run. Never ask for the value in chat or pipe one to
`teamai env set --stdin`. A note that an entry "may hold an old" value means an earlier pull wrote
it and it stays until a pull finds the value.

`KEY reads VAR, which is not set` means the user's value for KEY is a
reference to VAR (`--from-env`) and VAR is unset in this environment. Ask the
user whether to set VAR in their shell or replace the reference with the
command in the line; do not choose for them.

## "Did not write <tool>'s MCP servers to <file>" / `withheld:`

`pull` prints this, and `teamai mcp list` (`withheld:`) and `teamai doctor`
report it, when a project MCP config would get a resolved `${VAR}` value that
git would commit: the file could not be kept out of git first. It is left as
it was, and an entry an earlier pull wrote stays. The line names the reason and the
fix. For `git already tracks <file>`, tell the user: `git rm --cached <file>`
(the file stays on disk), commit that, and rotate the token if the file was
ever committed with it; then `teamai pull`. Do not run `git rm` or commit for
them. For an exclude file that is not writable, one another teamai command
held, or a git error, relay the fix the line gives.

## Permission / access denied

`init`, `pull`, or `push` failing with a permission error usually means the user
has not been granted access to the team repo on the Git platform. Have them copy
the **exact** error text to their admin, who adds them on the platform website.

## GitHub push fails

Check the team repo's default branch is `main` (not `master`). A stale `master`
default is a common cause.

## GitLab host not detected

If `init` can't confirm a self-hosted GitLab instance, set both and retry. Use a
short-lived `api`-scope token via a no-echo prompt (not a literal `export`, which
lands in shell history), and `unset GITLAB_TOKEN` afterward:

```bash
export GITLAB_URL=https://git.example.com
read -rs GITLAB_TOKEN && export GITLAB_TOKEN   # paste when prompted; api scope
teamai init https://git.example.com/yourgroup/yourrepo
```

A member who only syncs and never needs the CLI to open merge requests can skip
both: `teamai init <url> --provider git` uses their existing Git authentication.

## Which tools actually get hooks

`teamai hooks inject` prints **"Hooks injected into all AI tool settings"** even
for tools where it wrote nothing. **Do not take that line as proof.** (When the
team hooks cannot be resolved it exits 1 with the reason instead: the built-in
hooks are installed, the team hooks are left as they were.) Verify per-tool
instead:

```bash
teamai doctor          # flags tools whose hooks are missing
teamai hooks list      # per-tool status + the settings file it checked
```

What you will typically see, and why (this is expected CLI behaviour, **not** a
broken machine):

| Tool                  | Hooks status              | Why                                                                 |
|-----------------------|---------------------------|---------------------------------------------------------------------|
| Claude Code (`claude`)| Installed                 | Fully supported — this is the main, working path                    |
| Codex                 | Written but **trust-gated** or skipped | Codex gates non-managed hooks behind an explicit trust step; `teamai doctor` prints a reminder to trust them |
| Cursor                | Often not written         | Uses its own hook mechanism; broader CLI support is still pending   |
| CodeBuddy / WorkBuddy | Skipped **by design**     | They only accept versioned plugins (`plugin@version`); teamai writes raw entries into a `hooks` field, which they don't take |

Practical rule: if you set up with `--agent claude`, expect **only** Claude to show
hooks installed. A tool you are not using, or one that is not a supported hook
target, showing "missing" is normal — the Claude path is intact. For a tool where
hooks did not land but you do use it, run `teamai pull` manually each session, and
see the caveats below.

## Agent-specific caveats

Different AI hosts handle the hooks that TeamAI injects differently. When this
conversation runs in one of these, proactively walk the user through the extra
step — do not assume auto-sync just works.

### Codex

Codex gates non-managed hooks behind an explicit **trust** step. `teamai init` /
`teamai hooks inject` may write the hooks, but Codex won't run them until the user
trusts them (`teamai doctor` prints a reminder when it detects this). Guide the
user to trust the teamai hooks in Codex, then reopen a session. Until then, run
`teamai pull` manually.

### Cursor

Cursor uses its own hook mechanism and may not receive teamai's hooks yet. If
`teamai hooks list` shows Cursor without hooks, treat it as a manual-sync tool: run
`teamai pull` at the start of each session.

### ChatGPT App

Hooks injected by `teamai init` are **untrusted by default** in the sandbox. The
user must **manually trust the hooks in ChatGPT's settings** before they run.
Guide them to the settings, have them trust/enable the TeamAI hooks, then reopen a
session and verify with `teamai pull` + `teamai list`.

### WorkBuddy

The sandbox **does not add hooks automatically** after `teamai init`. The user
must **manually edit the config file to register the hook** so auto-sync works.
Walk them through opening the tool's config and adding the TeamAI session-start
hook entry; if unsure of the exact config, run `teamai doctor` and `teamai hooks list`
to see what should be present, then have them replicate it. Until then, they can
sync with a manual `teamai pull`.

### Tools without a writable hook surface

Gemini CLI, JoyCode, and similar tools have no TeamAI-writable hook surface —
there is no auto-sync. Tell the user to run `teamai pull` manually at the start of
each session.

## Still stuck

- Re-run the failing command with `-v` / `--verbose` for detail.
- `teamai status` shows exactly how local differs from the team repo.
- Report unexpected behavior at https://github.com/Tencent/teamai-cli/issues
  with the agent name, platform, and the step that failed.
