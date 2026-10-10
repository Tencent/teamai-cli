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

1. **Did init pick this tool?** `teamai init` ends with a pull, but a project-scope
   init creates only the directories of tools named with `--agent` or picked in
   its interactive tool picker. Run without a terminal and without `--agent`, it
   creates none, and a tool's project directory appears when that tool opens a session there. Re-run
   `teamai init <repo> --agent <tool>` to add the tool and fill it now.
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
4. **Wrong scope?** Project-scope built-in hooks are written to your HOME tool
   settings (e.g. `~/.claude/settings.json`), not the project folder; the team's own
   hooks for Claude Code and Codex go to the main checkout
   (`.claude/settings.local.json`, `.codex/hooks.json`). That is intentional.
   With `sharing.gitExclude` on, Codex's team hooks run from `~/.codex/hooks.json`
   instead (one `hook-dispatch <Event> --tool codex --team-hooks` entry per event)
   while the project's `.codex/hooks.json` is tracked or holds entries of its own,
   and always in single-repo mode.
   Existing Claude/Codex main-checkout hook files count as installed targets
   even when HOME and current worktree tool roots are missing. Injection and
   pull update team hooks and restore HOME built-ins; removal clears managed
   main-checkout hooks without recreating HOME roots.
   If Git-hook installation fails after writing agent hooks, `hooks inject`,
   `init` and self-repo bootstrap still attempt Codex trust. Injection preserves
   the installation error without reporting overall success. Init reports the
   error and retains exit code 1 while completing local setup, including HTTP
   initialization. Bootstrap records the error in the debug log and continues
   local setup.
   In project scope, `teamai hooks remove` preserves other projects' gated team
   hooks in HOME, while removing the shared built-in hooks.
   If `source remove-http` reports incomplete hook removal, the HTTP source is
   disabled and the failed hooks stay on record. Fix the settings file it names,
   then repeat `source remove-http` to finish removing them.
   If removal cannot acquire the HTTP source lock, it leaves the source intact.
   Wait for sync or plugin reconciliation to finish, check directory permissions,
   then retry removal.
   If you initialized project scope but expected machine-wide resources, re-run
   with `--scope user`.
5. **Tool has no hook surface** (e.g. Gemini CLI, JoyCode): there is no auto-sync;
   run `teamai pull` manually each time.
6. **Claude Code or Codex reads a different directory** (`CLAUDE_CONFIG_DIR` or
   `CODEX_HOME` is set). `teamai doctor` reports `Claude Code root matches
   CLAUDE_CONFIG_DIR` / `Codex root matches CODEX_HOME` when the directory the
   variable names is not the one this config syncs to. Re-run
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

## "Last git hook run failed: ..." / a new worktree lacks team resources

In project scope, teamai's git hook syncs on `git worktree add` and `git pull`
through merge or a completed rebase (`post-rewrite`, including `pull.rebase=true`; on Git 2.32
and older, a fast-forward rebase with autostash syncs on `post-checkout`).
A conflicting rebase syncs only on completion; `git commit --amend` does not sync. It runs
silently and always exits 0, so its failures surface only here: `teamai doctor`
names the last one with its fix, and the next interactive `teamai pull` says it
once. The causes are a team repo fetch that failed or hit the 5 s git-pull hook
cap without the background pull finishing it, and another teamai process
holding the project's sync lock longer than the hook waits, or incomplete resource,
hook or MCP delivery. Only a complete startup sync clears the recorded failure.
Run `teamai pull`
in the checkout (after a stuck pull ends, or once the team repo is reachable);
`~/.teamai/debug.log` has the details. If doctor reports `Git hook syncs new
worktrees and git pull` as failing, follow its fix: `teamai pull` installs it.
Git older than 2.54 has no config hooks: teamai then adds a marked block to
`.git/hooks/post-checkout`, `post-merge` and `post-rewrite`, unless `core.hooksPath` is set (or a
hook there is a symlink or not an executable shell script), in which case doctor's fix says to upgrade Git
or, if the team agrees, to commit its guarded `command -v teamai ... || true`
line into the manager's post-checkout, post-merge and post-rewrite hooks.
Doctor also detects hooks disabled by name (Git 2.54+) or event (Git 2.55+)
in effective global, local or worktree config. Follow its command (`git config --local <key> true`,
or `git config --worktree --unset <key>` for a worktree setting) to enable the named hook or event, then run `teamai pull` to sync. Pull preserves
explicit disable settings, so reinstalling alone does not enable a disabled hook.
Existing hook contents and permissions stay unchanged; read/write errors propagate
from `init` and `hooks inject`, and Git-started pulls record them. An unreadable
project config prevents sync and keeps its reason in `~/.teamai/debug.log`.

Hosts that skip checkout hooks need `teamai pull` in the new checkout before the AI
tool starts. For Codex CLI 0.160.0, use `git worktree add`, run `teamai pull` there, then
launch `codex exec -C <worktree>`. Its native `codex exec --worktree` path creates
the checkout without `post-checkout`, so SessionStart sync arrives after startup
discovery.

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

For new HTTP local-agent MCP installs, a failed initial ownership-manifest write leaves the MCP config and Git exclusions unchanged. Retry the install after fixing the manifest write error. A bare Copilot entry beside `mcpServers` is removed only with a matching ownership record proving a completed bare write. Older records without that evidence preserve the bare entry. A bare ownership record cannot claim a same-named member entry under `mcpServers`: updates skip the collision, and removal leaves that keyed entry alone. An unmarked Copilot record needs a matching keyed hash that does not also match the bare entry. Completed writes record `bare: true` or `bare: false`; missing placement remains unproven, including after a failed placement-record write. Existing JSON MCP updates keep the old ownership until the config write completes; a later manifest failure restores the config. `uninstall_mcp` keeps ownership if reading or writing the config fails, and restores the entry if removing its manifest record fails. MCP reconcile also restores all configs written before an ownership-save failure. If restoration fails too, repair the named configs and ownership records before retrying; the error reports both failures, and configs still carrying credentials stay excluded from Git.

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
| Codex                 | Installed and trusted     | Codex runs only trusted hooks; teamai trusts the ones it writes through `codex app-server`, and `teamai doctor` names any Codex will not run |
| Cursor                | Installed                 | Also runs `~/.claude/settings.json`. That copy exits only when `~/.cursor/hooks.json` or the project `.cursor/hooks.json` contains `--tool cursor` |
| Copilot CLI           | Installed in self mode    | Also runs a trusted project's `.claude/settings.json`. That copy exits only when `.github/hooks/teamai.json` contains `--tool copilot`. `COPILOT_CLI` alone does not skip |
| CodeBuddy / WorkBuddy | Installed                 | Claude-format hooks in their own `settings.json`                    |

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

Codex runs a non-managed hook only once it is **trusted**. `teamai init`, `pull`
and `teamai hooks inject` trust the hooks they write (and, in a project, the main
checkout, or the current worktree for a bare repository) through `codex app-server`.
Trust written by a session-start pull applies from the next Codex session. `teamai doctor` names any teamai hook Codex will not
run. Then: run `teamai pull`; if `codex` is not on PATH or `codexTrustEnabled: false`
is set in `config.yaml`, guide the user to trust the teamai hooks in Codex `/hooks`,
then reopen a session. A new linked worktree gets the team hooks from its second
Codex session (the first creates its `.codex/`). Member hooks with the same command
are preserved and remain untouched by automatic trust. Codex ownership uses the
recorded event, position and complete entry. A moved entry is recovered only by a
unique full-definition match. Legacy records recover only a unique event, matcher
and command match; `timeout` and `additionalContextLimit` were not recorded.
Pre-#370 project Codex ownership is imported from the main checkout's
`.teamai/managed-hooks.json` before reconciliation or direct removal.
An unrecorded entry equal to teamai's entry for exactly one team hook (current or
any earlier team-repo revision) is adopted, so a lost manifest adds no second copy.
Other unrecorded copies are preserved; pull and doctor name the ambiguous ones.
Project hook paths follow `toolPaths`;
Claude uses `settings.local.json` beside its configured settings file. A custom
Codex path that Codex does not load is reported as `not loaded` by doctor.

### Cursor

Cursor writes hooks to `~/.cursor/hooks.json` and also runs `~/.claude/settings.json`. `hook-dispatch --tool claude` and team hook commands written for `claude` exit only when `CURSOR_VERSION` is set and `~/.cursor/hooks.json` or `$CURSOR_PROJECT_DIR/.cursor/hooks.json` contains `--tool cursor`. A setup with only Claude has no second copy, so those hooks still run inside Cursor. Claude Code does not set `CURSOR_VERSION`. An already installed team hook picks up the guard on the next `teamai pull` or `teamai hooks inject`. If `teamai hooks list` shows Cursor without hooks, run `teamai pull` at the start of the session.

### Copilot CLI

In self mode, teamai writes hooks into the project, and Copilot CLI runs a trusted project's `.claude/settings.json` as well as its own `.github/hooks/teamai.json`. `hook-dispatch --tool claude` and team hook commands written for `claude` exit only when `COPILOT_PROJECT_DIR` is set and that file contains `--tool copilot`. `COPILOT_CLI` is not a signal: Copilot sets it on every subprocess, including a Claude session started from its shell. Copilot does not run `~/.claude/settings.json`, so this duplicate does not happen outside self mode. Re-run `teamai pull` or `teamai hooks inject` so an already installed team hook picks up the guard.

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

## "A recalled doc got no upvote"

A recalled doc is upvoted once per session when the session that ran the recall
opens it within 24 hours: a file read, a reader command (`cat`, `sed -n`, …), or
a search whose output shows its lines. Listing the doc does not count, and
neither does working from the recall subagent's summary alone; only the opt-in
judge (`TEAMAI_UPVOTE_JUDGE=1`) credits that. `teamai stats` shows each recent
session's runs, recalled docs and adopted docs. Per agent:

- **Claude Code, Codex (0.134+), CodeBuddy (2.103.1+), WorkBuddy, Qoder,
  OpenCode, OMP**: both a recall the main agent runs and one the
  `teamai-recall` subagent runs are credited when the main agent opens the doc.
  On OMP the subagent's recall needs the main session's file on disk, so a
  `--no-session` run credits only the main agent's own recalls.
- **Cursor, Copilot CLI, ZCode, Pi**: only a recall the main agent runs
  itself. A subagent's recall is not linked to the main session, and Pi has no
  TeamAI subagent.
- **OpenClaw, Hermes, Kiro, JoyCode, Trae**: no PostToolUse hook, so recalls never
  vote.

A read after the session's last Stop is credited at SubagentStop, at Copilot CLI's
SessionEnd, or at the next `teamai pull`.

## OpenCode V2 rejects the hooks plugin

If OpenCode reports “Plugin must export a default definition”, upgrade TeamAI,
run `teamai hooks inject` or `teamai pull`, and restart OpenCode. The generated
built-in and enterprise plugins support both OpenCode 1.18.23 (`server`) and V2
(`setup`). V1 shell recall uses `TEAMAI_AGENT_SESSION_ID`; V2 supplies its native
`OPENCODE_SESSION_ID`.

## Still stuck

- Re-run the failing command with `-v` / `--verbose` for detail.
- `teamai status` shows exactly how local differs from the team repo.
- Report unexpected behavior at https://github.com/Tencent/teamai-cli/issues
  with the agent name, platform, and the step that failed.

## "Pull left an instruction file unchanged"

If pull reports incomplete TeamAI markers, it keeps the entire file unchanged.
Fix the named block so it has exactly one start marker followed by one end
marker, then run `teamai pull` again. Other files can still sync successfully.

Pull keeps retired instruction blocks until every installed tool that wrote the
file has a working replacement. Repair the named target, extension or plugin
and run `teamai pull` again. Excluded tools' current and retired files stay
unchanged and are excluded from doctor's stale-instruction check.
When a native project file retains a TeamAI block, the session hook skips that
block, including cached HTTP prompts, until cleanup succeeds. Other blocks
still reach the hook. Doctor reports malformed markers in retired files;
repair them before retrying pull.
If a block's source cannot be resolved, its old block stays even when other
blocks sync. Repair the source and pull again to complete its migration.
HTTP prompt commands verify earlier deliveries against the current prompt
before cleaning shared instructions. Older destination contents do not count;
culture and recall stay because HTTP prompt commands do not replace them.
An HTTP prompt sync that cannot clean retired blocks reports a failed ACK and
keeps its previous cache and manifest for the server's retry.
OpenClaw HTTP prompts require an existing resolved user workspace, but not an
existing `AGENTS.md`: the prompt sync creates that file and preserves personal
text already in it.

OpenCode registration saves ownership before activating a new config entry.
If the state write fails, repair the state directory's permissions and retry
`teamai pull`; the entry is not activated without its removal ownership.
If the config write fails, ownership stays available for retry. Entries the
member already listed are never claimed.
