# Troubleshooting & Agent-specific caveats

Load this whenever a step fails, `teamai doctor` flags something, or team
resources don't show up. It is shared by all four scenarios.

## First move: run doctor

```bash
teamai doctor
```

It checks provider config, hooks, paths, and package/plugin status. Fix what it
reports before anything else.

## "Cannot acquire lock <path>: <reason>"

The lock could not be inspected, created or reclaimed, including during a
dry-run preview. Fix the filesystem error named in
the message (permissions, a full disk, or a parent path that is a file), then
retry; waiting for another process does not fix it. Ordinary contention still
uses the command's busy/skip message. An existing permission-denied or ownerless lock
is treated as held: remove it only after confirming no teamai process uses it.

A lock whose owning process is dead blocks nothing: the next command that takes
the same lock reclaims it, and a process exiting normally removes the locks it
still holds. `teamai doctor` reports leftover lock files, and
`teamai doctor --fix` removes the ones whose owner is provably dead.

## "My skills / rules aren't showing up"

This is the #1 onboarding issue. In order:

1. **Did init pick this tool?** `teamai init` does not copy team resources. A
   workspace-scope init creates only the directories of tools named with `--agent`
   or picked in its interactive tool picker. Run without a terminal and without
   `--agent`, it creates none, and a tool's project directory appears when that
   tool opens a session there. The resources arrive on that session start, or
   when you run `teamai pull`. Re-run `teamai init <repo> --agent <tool>` to add
   the tool's directory now, then pull or open the tool to fill it.
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
4. **Wrong scope?** Workspace-scope built-in hooks are written to your HOME tool
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
   In workspace scope, `teamai hooks remove` preserves other projects' gated team
   hooks in HOME, while removing the shared built-in hooks.
   If `source remove-http` reports incomplete hook removal, the HTTP source is
   disabled and the failed hooks stay on record. Fix the settings file it names,
   then repeat `source remove-http` to finish removing them.
   If removal cannot acquire the HTTP source lock, it leaves the source intact.
   Wait for sync or plugin reconciliation to finish, check directory permissions,
   then retry removal.
   If you initialized workspace scope but expected machine-wide resources, re-run
   with `--scope user`.
5. **Tool has no hook surface** (e.g. Gemini CLI, JoyCode): there is no auto-sync;
   run `teamai pull` manually each time.
6. **Claude Code or Codex reads a different directory** (`CLAUDE_CONFIG_DIR` or
   `CODEX_HOME` is set). `teamai doctor` reports `Claude Code root matches
   CLAUDE_CONFIG_DIR` / `Codex root matches CODEX_HOME` when the directory the
   variable names is not the one this config syncs to. Re-run
   `teamai init` from a shell that has the variable exported; it records the root
   and moves the install. If the check says the value cannot be synced to (outside
   your home, or neither a plain directory in it nor one under `.config/`), fix the
   variable first. `<tool> home matches <variable>` (`XDG_CONFIG_HOME`,
   `HERMES_HOME`, `COPILOT_HOME`, ...) is the same check for the homes recorded in
   `~/.teamai/tool-homes.json`, and `<tool> home exists` fails when a recorded home
   is gone; re-run `teamai init` from the shell with the variable you want.
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
8. **`pull` says `<file> is not a tool-homes record (<reason>)`.** The file
   where teamai records moved tool homes, `~/.teamai/tool-homes.json`, cannot
   be read, so pull syncs nothing in any scope. Hook-run pulls stop the same
   way and write the line only to `~/.teamai/debug.log`; `teamai doctor`
   reports it as `tool homes record is readable`. Fix the entry the reason
   names (each home must be an absolute directory), or delete the file and
   re-run `teamai init` from a shell your tools run in.

## Path names appear in skill usage statistics

Slash-command tracking accepts a complete `/skill-name` token at the start of the prompt, followed by whitespace or the end of the prompt, and only for a skill installed for the tool. Absolute paths such as `/Volumes/External/project` and URL components are not skill invocations. Updating prevents new false counts; already recorded usage remains.

## Submodule checkouts and linked skill directories

A submodule's Git directory is an identity, not a delivery directory. Team hooks and Codex project trust use its real main checkout. An initialized submodule in a superproject worktree inherits the original submodule's configuration when it exists; run `teamai pull` there without repeating init. The first pull installs Git hooks in that clone. If the parent's hook initializes submodules, follow the admin guide's initialization-and-pull sequence before starting an AI session. With Git < 2.54 and a shared versioned `core.hooksPath`, one dispatch line in each parent hook covers its submodules.

Both team skills and the built-in stub accept root-directory links within the same checkout and repository. Links outside it or into child repositories are rejected. Individual skill links, tracked skills, edited stubs and unrelated files stay. Remove a kept stub to receive the packaged one.

Pull removes proven TeamAI hook entries left in a Git directory. Older releases did not record file creation or project trust ownership: empty legacy files and unrecorded Codex grants stay. Remove a grant manually only after checking that it is not the member's choice.

## "Last git hook run failed: ..." / a new worktree lacks team resources

In workspace scope, teamai's git hook syncs on `git worktree add` and `git pull`
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

Hosts that skip checkout hooks (Claude Code's `EnterWorktree`, Codex CLI's worktrees) get
the same delivery from teamai's own session start and tool hooks, in the background, the first
time they run in a checkout with no delivery record. What the tool reads at startup is read
before that delivery lands: for Codex CLI 0.160.0, use `git worktree add`, run `teamai pull` there, then
launch `codex exec -C <worktree>`.

## "KEY is not set. Run `teamai env set KEY`"

`pull`, `teamai mcp list`, `teamai env list`, `teamai doctor` and
`teamai env exec` (on stderr) print this for a secret the team declares in
`env/secrets.yaml` that has no value on this machine, naming the MCP servers
that need it and where to get one. It is a note, not a failure: `doctor` exits
as it would without it. The value is the user's: ask them to run
`teamai env set KEY` in their own terminal (it prompts without echo). That
updates MCP servers for the current scope. Run `teamai pull` afterwards only
to update `env.sh`, and only when the key is an env variable. A CLI run through
`teamai env exec` gets the value on its next run. Never ask for the value in
chat or pipe one to `teamai env set --stdin`. A note that an entry "may hold an
old" value means an earlier write left it, and it stays until `teamai env set`
or `teamai pull` finds the value.

`KEY reads VAR, which is not set` means the user's value for KEY is a
reference to VAR (`--from-env`) and VAR is unset in this environment. Ask the
user whether to set VAR in their shell or replace the reference with the
command in the line; do not choose for them.

Muse may omit `type` when saving a stdio server. Pull and removal compare that form separately from the document they write, so a change to one server leaves personal servers and unchanged managed entries as saved.

Muse key reordering alone is not a user edit. Removal uses a content fingerprint for new records; a legacy record needs a matching original rendered hash and value from team Git history. Without that proof it keeps the server and warns. Real command, args, env or header edits remain personal.

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

## "Workspace child <path> is left out" / "<item> differs between ..."

`pull` in a workspace prints these; `teamai doctor` repeats the first.

- **Left out**: that repo uses another team repo, is in single-repo mode, or
  its config cannot be read. The line gives the reason. To include it, run
  `teamai init <this workspace's team repo>` in it; otherwise it keeps working
  on its own and nothing needs doing.
- **Differs between**: two repos inside the workspace receive an item of that
  name with different content, so the workspace holds it: what teamai
  installed for it before stays, in the place the workspace's rules give it. Tell the user to make the two copies equal in the team repo or
  rename one. Each repo still receives its own copy.

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

For a GitLab deployed at a sub-path, include that path in `GITLAB_URL`, for
example `https://git.example.com/gitlab`. MR import keeps it in the API base
and removes it from the project id. An MR outside that instance path is refused.

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
| Copilot CLI           | Installed                 | Built-ins use `$COPILOT_HOME/hooks/teamai.json` (default `~/.copilot/hooks/teamai.json`); self mode keeps them in the project. Claude built-ins exit for a valid, enabled version-1 file, global or project, with a `--tool copilot` command; self mode checks only the project directory. A Claude team hook exits only when a valid, enabled project version-1 file delivers the same command to Copilot for the same event and matcher. `COPILOT_CLI` alone does not skip |
| CodeBuddy / WorkBuddy | Installed                 | Claude-format hooks in their own `settings.json`; none on a WorkBuddy with only `.workbuddy-ai/` (see WorkBuddy below) |

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
checkout, or the current worktree when Git cannot locate a main checkout) through `codex app-server`.
Trust written by a session-start pull applies from the next Codex session. `teamai doctor` names any teamai hook Codex will not
run. Then: run `teamai pull`; if teamai finds no Codex (neither `codex` on PATH nor
the desktop app's bundled one) or `codexTrustEnabled: false`
is set in `config.yaml`, guide the user to trust the teamai hooks in Codex `/hooks`,
then reopen a session. When pull or doctor says `Codex builds disagree:`, teamai trusted
with the newest build and the older one skips the hooks it hashes differently: have the
user update or remove the older build it names, then run `teamai pull`. A new linked worktree gets the team hooks from its second
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

Built-in hooks use `$COPILOT_HOME/hooks/teamai.json` (default `~/.copilot/hooks/teamai.json`) for normal project installs. Custom team hooks stay in `.github/hooks/teamai.json`; self mode keeps built-ins there too. The next `init`, `pull`, or `hooks inject` migrates each project’s generated built-ins, preserving unrelated hooks. Self sessions skip the global copy. Otherwise each event runs once among the copies a session loaded (global files under any name, or a legacy project command a running host still holds): the first copy claims the event under `~/.teamai/copilot-hook-claims/` and the others exit. A payload without a `timestamp`, or a claim that cannot be written, runs every loaded copy. A cached copy stops once no enabled JSON file Copilot loads holds its built-in: a global copy checks `$COPILOT_HOME/hooks/`, and a legacy project copy checks that directory and its project’s `.github/hooks/`. Hook dispatch uses the working directory’s project config, including its `builtin.disabled`; `builtin.overrides` timeouts do not apply to the shared file. A custom hooks filename keeps its name in `$COPILOT_HOME/hooks/`. Project uninstall preserves the shared global hooks; `hooks remove` removes the built-ins from every JSON file in `$COPILOT_HOME/hooks/`, including filenames other projects configured.

Copilot CLI runs a trusted project's `.claude/settings.json` as well as its own `.github/hooks/teamai.json`. `hook-dispatch --tool claude` exits only when `COPILOT_PROJECT_DIR` is set and a valid version-1 hook file without `disableAllHooks`, in the project or global hook directory, has a command containing `--tool copilot`; self mode checks only the project directory. A team hook command written for `claude` exits only when an active version-1 JSON file in `$COPILOT_PROJECT_DIR/.github/hooks/` holds the same command for the same event and matcher, so a hook the project sends only to Claude, or to Copilot for another event or matcher, keeps running. `COPILOT_CLI` is not a signal: Copilot sets it on every subprocess, including a Claude session started from its shell. Copilot does not run `~/.claude/settings.json`. Re-run `teamai pull` or `teamai hooks inject` so an already installed team hook picks up the guard.

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

Skip this on WorkBuddy 5.7+ with only `~/.workbuddy-ai/`. teamai does not know yet
where 5.7 reads hooks, so it writes none, and `teamai doctor` names them under
`workbuddy receives ...`. Do not hand-register a hook there; sync with `teamai pull`.

### Muse Code

Hooks go in the `hooks` block of `~/.config/muse/settings.json` (`$XDG_CONFIG_HOME/muse/settings.json` when that is set), which Muse runs in every workspace; a project's `.muse/hooks.json` runs only once the workspace is trusted. Muse starts each hook with an emptied environment, so a variable set only on the command that launched `muse` (such as `TEAMAI_HOOKS_DISABLED=1 muse`) does not reach the hook. The hook command runs `bash -lc`, so export it in `~/.bash_profile` or `~/.profile` instead.

### Tools without a writable hook surface

Gemini CLI, JoyCode, and similar tools have no TeamAI-writable hook surface —
there is no auto-sync. Tell the user to run `teamai pull` manually at the start of
each session.

## "A recalled doc got no upvote"

A recalled doc is upvoted once per session when the session that ran the recall
opens it within 24 hours: a file read, a reader command (`cat`, `sed -n`, …), or
a search whose output shows its lines. Listing the doc does not count, and
neither does working from the recall subagent's summary alone; only the opt-in
judge (`TEAMAI_UPVOTE_JUDGE=1`) credits that. For Codex, Muse and ZCode it uses the Stop payload's final reply and this session's settled recall log; a Claude transcript is not required. `teamai stats` shows each recent
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

Pending votes reach the team repo's `teamai-reports` branch on the next Stop or
`teamai pull`. A push that fails — offline, no write access, a crashed run —
keeps the deltas pending; the next session re-sends them, and each delta is
added to the team totals exactly once.

Index rebuilds (including `teamai pull`) use confirmed team votes plus pending
local votes, even when reporting is disabled or a push fails. A busy votes lock
makes that rebuild use confirmed counts only; it does not wait for the lock.

Manual `teamai recall feedback --positive <docId>` adds an upvote without adding
a recall. Confidence caps the upvote-to-recall ratio at 1: more feedback cannot
exceed that factor's 30% weight. Recency uses the later of the last recall and
the last upvote, so a fresh upvote also refreshes recency. This is an activity score,
not proof of knowledge correctness or task success.

## OpenCode V2 rejects the hooks plugin

If OpenCode reports “Plugin must export a default definition”, upgrade TeamAI,
run `teamai hooks inject` or `teamai pull`, and restart OpenCode. The generated
built-in and enterprise plugins support both OpenCode 1.18.23 (`server`) and V2
(`setup`). V1 shell recall uses `TEAMAI_AGENT_SESSION_ID`; V2 supplies its native
`OPENCODE_SESSION_ID`.

## Still stuck

- Re-run the failing command with `-v` / `--verbose` for detail.
- `teamai status` shows exactly how local differs from the team repo.
- If status shows `auto-report: pending since <time>`, report data is still
  local after an unconfirmed push. Run `teamai pull --verbose` to retry and
  see the cause. A successful report, or a pull after reporting is disabled,
  clears the notice. Disabling reporting keeps the local data.
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
text already in it. When the server sends no workspace and `openclaw.json` is
not plain JSON, OpenClaw is skipped and the ACK names that reason; the ACK
fails only when no tool received the prompt. Make the file plain JSON, then
retry.

OpenCode registration saves ownership before activating a new config entry.
If the state write fails, repair the state directory's permissions and retry
`teamai pull`; the entry is not activated without its removal ownership.
If the config write fails, ownership stays available for retry. Entries the
member already listed are never claimed.

CodeBuddy CLI and WorkBuddy use compressed project directory names above 255 UTF-8 bytes (a code-point-safe 180-byte prefix plus the native hash). Session listing, reading and migration follow those names; do not rename the native directories manually.

## GitHub MR/PR import API error

When import falls back from `gh` to the REST API, a failed metadata, commits,
or diff request stops before AI extraction and names the HTTP status and
response body. Check PR visibility and authentication for 404/403, the rate
limit for 429, or retry a temporary server failure. The error page is not a diff.

## Session archive publication is busy or failed

Session archive writers (`session push`, `migrate --push`, and `session pull`) wait up to ten seconds for another publication on the same machine. If busy, retry once it finishes. A failed save removes the new pair or restores the previous pair; a rollback failure names the retained backups. Remote push failures still keep the local commit.

## OpenCode hooks cannot start the CLI

If OpenCode hooks stopped after moving or reinstalling Node or TeamAI, run `teamai hooks inject` or `teamai pull` and restart OpenCode. The plugin records the installed Node and CLI paths so it also works without `teamai` on the service PATH. Doctor accepts those live paths when another installation with the same handler inspects the plugin; invalid saved launcher files or a changed handler still fail the check.

## ZCode registered hooks but missing project rules

Doctor checks the serialized rules reply against the user config `hooks.maxOutputBytes` (default 32768), counting UTF-8 bytes and JSON escaping. Other session hints make the complete stdout larger. Shorten the rules or raise the positive integer byte cap enough for the whole reply, then start a new session; registration alone does not prove the rules fit.

## Pi user instructions with an override file

Pi reads `AGENTS.override.md` before `AGENTS.md` in the same directory. In user scope, pull writes rules and instruction blocks into the existing override and strips only TeamAI blocks from the older configured file. Personal text in both files is preserved, including on uninstall. Without an override, the configured user file remains the target.

## A file blocks skill delivery

When a file occupies a tool skills directory, doctor fails the directory check even if delivery skipped that tool. Move the file aside and run `teamai pull`. Uninstall keeps the blocking file and cleans the other managed resources.

## Kiro default-agent synchronization

Kiro CLI V3 uses the generated user hook `~/.kiro/hooks/teamai.json`, independently of custom agents. Missing or edited hooks appear in doctor; reinject after moving aside a same-named personal file. User uninstall removes the managed file, project uninstall keeps it, and personal hook files remain. Upgrade Kiro 2.x to V3 for this lifecycle integration.

## Placed agent edits and format changes behind the default branch

An edit of the root copy overwrites the agent this machine placed, and a `.md`/`.yaml` conversion may retire it after its merge is proven. If the team changed the placed file since this machine's last merged push, the push stops and prints a `teamai push --carried <path>@<blob>` command: update the checkout, carry its changes into the root copy, then run it. The option accepts only that version, so a plain retry or a later team change stops again. If the team deleted it, the remaining root copy is not a new agent to publish. Older records without a delivered blob catch a team change only while the checkout is behind it, until the first edit pushed through them merges and records its blob. Until then, compare with the team file before editing or converting.

A recreated namespace source can be edited directly; the retired flattened copy is kept as a backup. Retired tool copies do not become new agents when the root copy is removed. The retirement warning names the former source so the member can restore it before pushing edits.

## Hermes hooks after moving Node or TeamAI

The generated status script and instructions plugin capture the installed Node executable and TeamAI entry. After moving or reinstalling either, run `teamai pull` or `teamai hooks inject`, then restart Hermes.
