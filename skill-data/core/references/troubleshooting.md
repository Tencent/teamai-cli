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
6. **A command reports a broken manifest** (`Invalid roles manifest…`,
   `Invalid projects manifest…`, `Invalid manifests…`, or `…manifest … could not
   be read`). `pull` skips that scope on purpose, since syncing without the
   manifest would deliver every namespace it gates; `push` stops before pushing
   anything, even with `--role`; `status` lists the other resource types. The fix
   belongs in the team repo's `manifest/roles.yaml` or `manifest/projects.yaml`,
   which the error names by entry — tell the user to ask a team admin. Do not
   delete the manifest or edit the local clone to get past it.

## Permission / access denied

`init`, `pull`, or `push` failing with a permission error usually means the user
has not been granted access to the team repo on the Git platform. Have them copy
the **exact** error text to their admin, who adds them on the platform website.

## GitHub push fails

Check the team repo's default branch is `main` (not `master`). A stale `master`
default is a common cause.

## GitLab host not detected

If `init` can't confirm a self-hosted GitLab instance, set both and retry:

```bash
export GITLAB_URL=https://git.example.com
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxx   # api scope
teamai init https://git.example.com/yourgroup/yourrepo
```

## Which tools actually get hooks

`teamai hooks inject` always prints **"Hooks injected into all AI tool settings"**,
even for tools where it wrote nothing. **Do not take that line as proof.** Verify
per-tool instead:

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
