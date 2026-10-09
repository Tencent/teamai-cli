# Member Guide

> [English](member-guide.md) | [简体中文](zh-CN/member-guide.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Member Onboarding

Once the admin shares the team repo URL with members:

**Project-scoped teams (default):**

```bash
npm install -g teamai-cli
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo
# Done! AI tools now automatically have access to team resources
```

**User-scoped teams:**

```bash
npm install -g teamai-cli
teamai init https://github.com/yourorg/yourrepo --scope user
```

**Plain Git, no platform token (`--provider git`):**

When the team repo is on a platform whose provider needs a token (for example self-hosted GitLab and `GITLAB_TOKEN`), a member who never needs the CLI to open PRs/MRs can use their existing Git authentication (SSH key or credential helper) instead:

```bash
teamai init https://gitlab.example.com/yourgroup/yourrepo --provider git
```

- `--provider` skips auto-detection and uses the named provider: `tgit`, `github`, `cnb`, `gitlab`, `gitcode`, or `git`. `git` runs no platform login or token check.
- The choice is saved in this machine's local config only. An existing `teamai.yaml` is not changed, so other members keep the team's provider. When `init` creates a new `teamai.yaml`, `--provider git` still records the provider `init` would detect without it. If the host is a self-hosted GitLab that is not configured, `init` stops and asks for `GITLAB_URL` rather than record `git` as the team default.
- `--provider gitlab` on a self-hosted instance still needs `GITLAB_URL` or `TEAMAI_GITLAB_HOST` (and `GITLAB_TOKEN`). Without either `init` stops, because the GitLab API would otherwise target gitlab.com.
- `pull` works as usual. `push` pushes the branch but cannot open a PR/MR, so open it on the Git host yourself; the command exits non-zero because that step did not run.
- Re-running `teamai init` without `--provider` returns to auto-detection.

**HTTP mode (read-only consumer):**

For users or agents that don't need git access and only consume skills/rules:

```bash
teamai init --http https://your-team-host/api --token <api-key>
```

- Read-only mode: `push` / `contribute` / `remove` are not available, and `import --from-mr` cannot publish its learning (`--dry-run` and `--output` still work).
- No git clone required — skills/rules are delivered via a report/sync/ack lifecycle on a per-session basis.
- Supported agents automatically report their installed skill state at session start, and pull install/update/uninstall commands managed by the server.
- OpenClaw HTTP prompts create `AGENTS.md` in an existing resolved user workspace when the file is absent; existing personal text is preserved.
- The API key is stored with `0600` permissions, or can be passed via the `TEAMAI_API_TOKEN` environment variable.

**Verify:**

```bash
teamai status                       # View status
teamai members                      # View team members
teamai list                         # All resource types (skills|rules|docs|env|agents|hooks|mcp) + local skills
teamai list mcp                     # Only team MCP servers
teamai list --source repo           # Team repo only
teamai list --source local          # Skills under each installed agent
teamai list --agent claude --verbose
teamai list env --reveal            # Show env values in plaintext (default: masked)

teamai skill                        # teamai list skills --source all, then the CLI-served built-in catalog
teamai skill show hai-deploy-test   # View a single skill's source / contributor / install locations / description summary

teamai skill list --json            # The built-in skills the installed CLI serves, machine-readable
teamai skill get core               # Print a built-in workflow: core | setup | wiki | share
teamai skill get wiki --full        # ...with its references and templates appended
teamai skill path wiki              # The packaged directory, for the scripts a skill ships
```

#### Built-in skills are versioned with the CLI

The built-in workflows (`core`, `setup`, `wiki`, `share`) ship inside the npm package
and are printed by the installed binary with `teamai skill get`, so what an agent reads
always matches the CLI version it is running — `npm i -g teamai-cli@latest` is the
update, with no pull needed for the content to be current. Agents receive a single file
from the CLI, `~/.<tool>/skills/teamai/SKILL.md` (or wherever that tool keeps team skills: OpenClaw's
workspace, `HERMES_HOME`), a small discovery stub that points at
those commands. Older releases copied the whole tree into every agent directory, where it
went stale between pulls; `teamai pull` removes those leftovers, keeping a copy of every
removed file under `~/.teamai/removed-skills/`, one directory per pull (until `teamai uninstall`,
which removes `~/.teamai/` and this archive with it). Only files whose content a release shipped
are removed: a packaged file you edited, or a skill of your own under one of the old names, is
yours and stays. A directory that also holds a file of your own is kept, with only the
packaged files removed, and named in the pull output. `share` is served only while recall is
on (off by default; `sharing.recall.enabled: true` in `teamai.yaml` for the team, or
`teamai recall enable` for one machine): until then `teamai skill get share` refuses and says so.
It also refuses on a read-only HTTP source, where `teamai contribute` cannot write, and when a
teamai config exists but cannot be loaded (the refusal says what failed: for a file that does not parse, which file and where; for one that fails validation, which field and why),
since recall and the source are then unknown. The legacy names still
resolve: `teamai skill get team-wiki-codebase` serves `wiki`.

---

## Day-to-Day Use

### Auto-sync

`teamai init` already injected Hooks into your AI tools and ended with a pull, so your first session has the team's skills, rules and MCP servers. **`teamai pull` runs automatically every time you start an AI session** — no manual action needed. In project scope, that SessionStart hook first creates the current agent's project root (e.g. `<project>/.claude` when Claude Code opens the repo) if it is missing, then pulls.

*(Note: Automatic sync on session start requires an agent that supports lifecycle hooks, such as [CC], Codex, GitHub Copilot CLI, Cursor, CodeBuddy, WorkBuddy, Qoder, ZCode, Kiro, OpenCode, Oh My Pi, Pi, Hermes, OpenClaw, or DeepSeek Harness. Kiro runs the hook when a TeamAI-rendered custom agent is activated in an interactive CLI session; its in-memory built-in default agent is not writable, and non-interactive mode does not fire `agentSpawn`. For tools without a teamai-writable hooks surface such as JoyCode or Gemini CLI, run `teamai pull` manually.)*

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

A command with no `--dry-run` preview, such as `teamai init`, `teamai hooks remove`, `teamai models add` / `configure` / `remove`, `teamai bind-project` or `teamai codebase --extract`, refuses the flag: it prints `teamai <command> has no --dry-run preview, nothing was run` and exits 1.

`remove`, `roles init/add/remove/update`, `projects add/update/remove`, and `import --from-repo/--from-repo-list` support `--dry-run`. Remote import sources take precedence over lower-priority iWiki or Claude flags. `digest`, `import --from-claude`, and `import --from-iwiki` have no safe preview and refuse it. Previews for `stats`, `recall <query>`, `import --from-org`, `--from-mr`, `--dir`, and `recall feedback` remain available.

A manual `teamai pull` ends by running the `teamai doctor` checks and printing each one that failed, with its fix — including whether the skills it just reported syncing are readable on disk for every enabled tool. It prints nothing when they all pass, and the exit code is unchanged. The SessionStart hook path and `--dry-run` run no checks at all, so session startup stays as fast as before. Provider checks (`gh`/`gf` authentication) are left to `teamai doctor`: the pull just used the provider.

**Pull keeps a skill, rule or agent you changed.** For each checkout, pull records what it wrote at each skill, rule and agent path. On a full sync, a copy that no longer matches that record is kept, and pull names it, while the copies of other tools still update. A skill counts as one copy: a change to any of its team files keeps the whole skill, and files only you added do not count. If the team version has not changed, pull prints ``Kept <path>: you changed it since teamai delivered it. Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.`` If it has, whether the team changed it or your [local model alias override](./advanced.md#local-override) did, pull warns and asks you to merge that change into your copy before you push it, and `teamai push` warns about that copy too, since the SessionStart pull runs silently. `--force` keeps these copies too, and `--dry-run` prints `Would keep <path>` for each. When the team removes an item, a copy you changed stays, and pull names it. There is no record before your first full pull with this version, so that pull overwrites as earlier versions did, and your changes are protected from then on. The same goes for a new worktree's first pull, and for a copy teamai never delivered to that path. `teamai remove` and installs from the local agent still rewrite the team rules without this check. An older CLI that saves state drops the record.

> Project scope is isolated by default. When the current working directory belongs to a project that has been initialized in project scope (its partition under `~/.teamai/projects/<slug>/`, or a legacy in-repo `.teamai/config.yaml`), `pull` processes that project and skips user scope unless the local config has `inheritUserScope: true`; in that case it first refreshes the safe user-resource channel. Without a project config in the current directory, `pull` processes user scope. User `env`, MCP definitions, sources, reporting, and writes remain isolated in project mode. Hooks are the one exception: a project scope's built-in hooks are injected into your **HOME** tool settings (`~/.claude/settings.json`, …), not `<projectRoot>`, because they gate on the `cwd` handed to `hook-dispatch` and `~/.claude` always exists so the "installed tool" gate passes (see the Hooks section). The team's own hooks (`hooks/hooks.yaml`) for Claude Code and Codex go to the main checkout instead, ungated (`<main checkout>/.claude/settings.local.json`, `<main checkout>/.codex/hooks.json`), so every worktree of the project shares one copy. These paths follow the project `toolPaths`; Claude uses `settings.local.json` beside its configured settings file. For a bare repository, each worktree keeps its own copy because there is no main checkout; other tools keep them in HOME, run only when the `cwd` is inside the project. In a directory with no teamai config (no project config and no user scope), the team hooks do nothing: no reminders, and no session or skill usage is recorded; only machine-level work runs (the CLI update check, the session-start pull, the local agent, and package hints a pull stashed). For the team hooks and skill usage, a project config that exists but cannot be read counts as none, never as the user scope or as a lower-priority project config (such as a legacy `.teamai/config.yaml`) behind it. `pull` follows the same rule: it syncs no scope there, prints ``Nothing was synced: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` and exits 1 (with `--silent`, it prints nothing and still exits 1); a session start there runs no pull, seeds no agent directory and stashes no package hint. A hook whose `cwd` was deleted (a session that outlives its worktree) keeps the scope its session last recorded, so the session's last events and skill uses stay with the project, and its share reminder follows the project's settings, instead of the user scope's. This needs the session's earlier events in the local event log, which compaction trims to active sessions, and does not cover Copilot, whose events record no directory. Self single-repo mode keeps its hooks in the business repo so they travel on clone.

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/<namespace>/` and `claudemd/<namespace>/` follow the `knowledge` namespaces, and a `docs/<namespace>/` follows the `docs` namespaces once one is declared (see [Docs](./sharing.md#docs)); `agents/<namespace>/` follows the role's `agents` namespaces (see [Agents Resource Type](./advanced.md#agents-resource-type)). `learnings/` at the root is shared with everyone, while `learnings/<project-id>/` subdirectories sync only for the directory's active projects (see [Multi-project](./admin-setup.md#multi-project-project-as-a-dimension-orthogonal-to-role)).

**A namespace item replaces the root item of the same name.** With a role or project configured, an item in an active namespace is delivered instead of the root item that has the same name. The whole item is replaced; nothing is merged:

- A skill replaces the root skill of the same directory name, including a root skill you receive through a tag. The install removes the files of the version it replaces. Files that no team version of the skill has stay.
- An agent replaces the root agent of the same file stem.
- A rule replaces the root rule of the same first-level file name: `rules/<ns>/<name>.md` replaces `rules/<name>.md`, in Hermes' `SOUL.md` block and the rules a session-start hook or Pi's extension adds too. Deeper paths such as `rules/<ns>/<dir>/<name>.md` replace nothing, and neither does a namespace rule your tag subscriptions leave out. In rule directories you share with rules of your own (every tool with a rules format of its own except Cursor: JoyCode, Copilot, Kiro, Qoder, CodeBuddy, WorkBuddy and Oh My Pi), the replaced root rule's copy is removed only while it is what teamai delivered (the current root rule, or the one of your last pull); an edited copy stays, and each pull names it, since the tool loads it beside the namespace rule.
- A `claudemd/<ns>/<name>.md` file replaces `claudemd/<name>.md` in the managed block.

When the namespace stops being active, the next pull delivers the root item again. If two active namespaces define the same skill or agent name, they compete for one installed file, so pull reports an error that names both files, does not update that type in that run, and keeps what is installed (for skills, recall keeps the ones it had indexed too); the other resource types still sync. Two active namespaces with the same rule or shared-instructions name are both delivered, because each keeps its own place (`rules/<ns>/` locally, its own section of the block); only the root one gives way. `push` writes an edit of a replaced item back to its namespace, never to the root, and recall indexes the skills and rules you receive rather than every one in the repo. A replacement that cannot be used replaces nothing: a skill directory without `SKILL.md` is not delivered and pull names it, and while an agent file does not parse the agent it would replace stays installed. `teamai doctor` lists each replacement as a note. Without roles or projects nothing changes: every namespace is delivered beside the root, and `doctor` lists each name the team repo defines more than once.

Put shared content that a project may need to override at the root, not in a namespace every role activates. A root item gives way to an active namespace; a namespace item never does. For example, keep the company's `rules/code-style.md` at the root, and a checkout project that needs different conventions adds `rules/checkout/code-style.md`. Members with `checkout` active get the project's version, and everyone else keeps the shared one. Had the shared rule lived in `rules/common/code-style.md`, a checkout member would receive both.

### Team packages

`teamai packages` lets a team declare and restore npm packages and Claude Code plugins through the existing team repository. TeamAI invokes the native `npm` and `claude plugin` CLIs; it does not distribute package contents itself.

**Admin operations:**

Passing a target installs it and adds its declaration to the team repo's `teamai.yaml`:

```bash
# npm package (project dependency by default)
teamai packages install typescript

# Unscoped name@version is ambiguous with plugin@marketplace; identify npm explicitly
teamai packages install typescript@5.9.2 --npm

# Global npm CLI from a specific registry
teamai packages install eslint@latest --global \
  --registry https://registry.npmjs.org/

# Claude plugin
teamai packages install code-review@claude-plugins-official

# Share the updated teamai.yaml through the normal review flow
teamai push
```

An npm target accepts `name` or `name@version`. Because an unscoped `name@value` can also mean `plugin@marketplace`, use `--npm` when the suffix is not a declared or registered Claude marketplace. Scoped npm names (`@scope/name`), bare names, `--global`, and `--registry` already identify npm unambiguously and do not probe the Claude CLI. Local npm packages require a `package.json` in the current directory; use `--global` for machine-wide CLI tools. `--registry` is saved with that package declaration and must be an HTTP(S) URL without embedded credentials. Keep registry authentication in npm configuration or environment variables.

A Claude plugin target uses `plugin@marketplace`. The official `claude-plugins-official` marketplace is resolved automatically; another marketplace must already be registered with Claude Code so TeamAI can record its source. Use `--claude` to make the intended ecosystem explicit and get a marketplace-specific error when it is unavailable. Ambiguous targets fail without running either package manager. `--global` and `--registry` apply only to npm targets.

**Member operations:**

The existing SessionStart hook runs `teamai pull`. When the `packages` declaration changes, it asks the member to review `teamai.yaml` and install explicitly; it never runs third-party package or plugin code automatically. Pull remains detached so network latency cannot block the IDE. If a declaration arrives after the SessionStart output window, TeamAI safely queues the same notice for the next UserPromptSubmit in that session.

```bash
teamai packages             # Install every team declaration
teamai packages --dry-run   # Preview native commands without installing or writing files
teamai doctor              # Check runtimes, declared package/marketplace/plugin status, and what actually landed on disk; exits 1 when any check fails
```

After a successful install, TeamAI writes a local snapshot to `teamai.lock` under the active scope's `.teamai` directory. The lock records installed versions and the declaration hash used by the SessionStart hint; it is not stored in the team repository. In user scope, machine-wide npm tools and Claude plugins are acknowledged once, while project npm dependencies are acknowledged separately for each working directory so installing in one repository cannot silence another repository's hint.

**Declaration format:**

`teamai packages install <target>` manages this section automatically:

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
    - name: eslint
      version: latest
      global: true
      registry: https://registry.npmjs.org/
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

- `npm[].version` defaults to `*`; `global` defaults to `false`.
- `claude.marketplaces` maps marketplace names to their repositories.
- Each Claude plugin must use `plugin@marketplace`, and that marketplace must be declared.
- Unknown or misspelled keys inside `packages` are rejected before install or push.
- Package declarations apply to the whole team; role and project filters do not change the package set.

### Excluding skills you don't need

If a skill shared by the team doesn't suit you, you can exclude it locally only — no need to modify the team repo, and it won't affect other members:

```bash
teamai skill exclude add using-superpowers --dry-run # Preview without changing config or pull state
teamai skill exclude add using-superpowers
teamai pull                    # Remove it from local AI tools
teamai skill exclude list

teamai skill exclude remove using-superpowers --dry-run # Preview without changing config or pull state
teamai skill exclude remove using-superpowers
teamai pull                    # Re-sync
```

The exclusion list is stored in the `config.yaml` of the current user or project scope:

```yaml
excludedSkills:
  - using-superpowers
```

Exclusion rules take effect after role and tag filtering. When running `teamai pull`, excluded skills are not synced, and any copies previously installed by `pull` are cleaned up. `teamai doctor` checks the resulting set against what is on disk, and asks nothing of an excluded skill.

### Push local resources

Before scanning, `push` refreshes unedited old rule copies from the team repo. For a tool with a rules format of its own (Cursor `.mdc`, JoyCode's own `.mdc`, Copilot `.instructions.md`, Kiro steering, and the Qoder, CodeBuddy, WorkBuddy and Oh My Pi rules), it compares Markdown bodies independently of the generated header and renders updates in that tool's format. Local body edits are preserved. For Copilot this applies to project rules and user rules under `COPILOT_HOME`. Each copy it refreshes is recorded as delivered, so the next `teamai pull` still updates it instead of keeping it as your change. A new file in one of those tools' rules directories is your own rule in that tool's format, so `push` never offers it; to share a new team rule, write it as a plain `.md` in `.claude/rules/` (scoped with `paths:` if needed) and push that.

When only the team's `paths` change, `push` also refreshes Copilot's `applyTo` if the local file still matches a recorded version's generated copy. A locally edited header is preserved in this case.

Rule pre-sync skips tools excluded by `enabledAgents` or `disabledAgents`, even if their configuration directories still exist.

```bash
teamai push          # Scan for new/modified resources, create an MR
teamai push --all    # Skip confirmation, push directly
teamai push --role pm  # Push into the pm namespace (skills/pm/, rules/pm/, agents/pm/)
teamai push --branch feature/gitee-destination  # Use an explicit destination branch
```

`--branch` names the branch that receives a new push; an existing open PR is always updated on its recorded branch. TeamAI refuses to start a push when the team-repo clone has user changes (modified, staged, untracked, or conflicted files); TeamAI-owned `teamai.yaml`, the env files `teamai env add` edited, and sync-lock state are handled separately. Commit or stash other local changes first.

**Namespace selection (new resources):** When pushing a new skill, rule or agent, the CLI automatically detects available namespaces and offers an interactive choice:

```
Which namespace should new skills be pushed to?
  1. common
  2. hai
  3. pm
Choose namespace [1-3] (default: 1 = common):
```

- Each resource type resolves from its own axis: skills from the `skills` namespaces, rules from `knowledge`, agents from `agents`. A push that carries several types asks once per axis
- If `primaryRole` is set, the list of available namespaces is expanded from the manifest
- If `primaryRole` is not set, the team repo's directory structure is scanned automatically for skills; a new rule or agent stays at the shared root
- A single namespace is auto-selected; use `--role <id>` to choose one explicitly
- Modifying an existing resource automatically keeps its original namespace
- The chosen destination is printed for each resource, e.g. `[rules] my-rule → rules/pm/my-rule.md`
- A roles manifest that exists but cannot answer stops the push instead of falling back to the shared root. One that is missing the configured role: fix `manifest/roles.yaml`, run `teamai roles set <role>`, or pass `--role <ns>`. One that cannot be read or parsed, or is empty, stops the push at its scan (exit 2), before `--role` is consulted, because the scan needs the manifest to tell which namespaces are yours: fix `manifest/roles.yaml` first. A team with no `manifest/roles.yaml` at all keeps the pre-manifest behavior
- `teamai push --dry-run` resolves the same destinations and stops on the same unresolvable namespace, so it never reports a push as viable that the real command refuses
- When several namespaces could take a new resource and there is no terminal to ask on (CI, a hook, `TEAMAI_NONINTERACTIVE`), push stops with exit 2, lists them, and asks for `--role <ns>`
- `--role`/`--project` places new resources only. An edit of a shared-root rule or agent stays at the shared root, and push says so
- A placed resource stays maintainable from the machine that published it. While its PR is open, the open-PR record routes a later edit of the author's own copy back to that PR; once the file is on the default branch, `state.json` records where push put it, so the edit goes back to the same file, and an agent published into a namespace this directory has not activated is still editable rather than skipped as having no active source
- `teamai remove rules <name>` accepts the bare name the author's copy carries as well as the published `<namespace>/<name>`; it reports which one it resolved to, and removes both the namespaced team file and the author's copy at the rules root. If the team repo cannot be refreshed first, or this machine's placement records cannot be updated and saved, `remove` stops with exit 1 and removes nothing, because either can resolve the name to the wrong files. `--dry-run` only fetches: it resolves names against the contents a real pull would use on the clone's checked-out branch (or origin's default branch in self mode), and saves no records. Clone previews fetch the configured upstream first, including differently named branches or remotes. If that pull cannot fast-forward or has no upstream, they fetch origin/current-branch to model the real reset fallback. A local-only branch is refused for removal when neither refresh can succeed. In clone mode, a failed fetch stops the preview with the same refusal and exit 1 as a real removal. A clone with uncommitted changes is refused with exit 1; commit or stash them before previewing. Dirty business files do not block self-mode previews.
- A local agent is an edit of the team agent it was delivered from: one in an active namespace first, then one this machine placed, then the shared-root agent either of them replaces. Only when none exists does `--role`/`--project` decide, and the agent is new in that namespace; if that namespace already holds an agent of that name, the agent is skipped rather than written over it, as a rule would be. Two active agents of one name stay ambiguous and are skipped, flag or not. The same agent name may exist in several namespaces, so a copy in an inactive one you did not name never blocks publishing yours. A placed agent that changed on the team since this checkout last synced it is held, because agents have no pre-push sync. Pull keeps your changed copy, so save your edit, delete the copy, run `teamai pull --force`, reapply the edit and push again. In single-repo mode, a root copy under `.teamai/` that matches an older version of the file it was placed at is held too: nothing refreshes it, so it is an old copy rather than an edit
- A new resource is never placed on top of one that is already there. If the resolved namespace already holds that name, the push stops and names the file: pull and edit the existing copy, rename yours, or pick another namespace with `--role <ns>`
- An agent whose namespace is not active here stays editable through its placement record, and `pull` delivers it for the same reason, so your copy tracks the team file. It replaces a shared-root agent of the same name, as an active namespace's agent would. An active namespace holding that name wins: that agent is the one deployed here
- A resource awaiting review in an open PR keeps that PR's destination — unless this push names a namespace other than the one recorded (the shared root counts as one), in which case the flag decides, the open PR is left untouched, and the collision is reported
- If the team repo cannot be refreshed at the start of a push, `--project` stops instead of placing by a possibly stale `manifest/projects.yaml`; so does any new resource placed without `--role`, because its destination comes from that clone (`manifest/roles.yaml`, its absence, or the namespaces the repo already has). Fix the pull and retry, or name the namespace with `--role <ns>`. `push` also stops, and pushes nothing, when this machine's placement records cannot be updated and saved
- A placement record is written only once the pushed file has landed on the default branch, so a PR closed without merging leaves none behind, whatever became of its branch. It is dropped again when the team deletes that file. Without roles or projects it is also dropped when a shared-root file of the same name appears (your root copy then follows that file, and `pull` warns). With a role or project, the placed resource replaces that shared-root one here instead, and the record stays. `push`, `pull` and `remove` settle this before they read the records. `teamai remove` itself leaves the record alone: its deletion reaches the default branch only when its PR merges, and until then a retried `remove` still resolves the bare name to the namespaced file. If the file reached the default branch with content other than what you pushed (for example a reviewer changed the PR before a squash merge), it is not recorded, and push says so once; run `teamai pull` and edit that file as the team file it now is
- Your own copy of a rule you published into a namespace stays at the rules root. When that namespace is active here, `pull` updates that copy instead of writing a second one under `rules/<namespace>/`; when it is not, `pull` leaves it alone. With a role or project configured, a shared-root rule of the same name is not delivered onto that copy: your placed rule replaces it. It is swept only once the team file it was placed at is gone

**Updating an open PR instead of duplicating it:** If a resource is already waiting in an unmerged PR, re-running `teamai push` on it updates that existing PR in place (by force-pushing its branch) rather than opening a duplicate. Keep the resource selected to update its PR; deselect it to leave the PR untouched. Unrelated resources selected in the same run go into their own new PR. Once the PR merges (or its branch is removed from the remote), the record is cleared and the next push opens a fresh PR as usual.

**Automatic YAML frontmatter completion:** When pushing, the CLI automatically checks valid mapping-style `SKILL.md` frontmatter and fills in `name`/`description` if missing. Malformed or scalar frontmatter is left unchanged with a warning and must be fixed manually.

### Check status

```bash
teamai status        # Current scope, last sync time, resource stats
teamai status --all  # List every project data partition under ~/.teamai/projects
```

Under `Team resources`, `skills` counts the team repo entries shown by
`teamai list skills --source repo`: both flat skills (`skills/<name>/SKILL.md`)
and skills inside namespaces (`skills/<namespace>/<name>/SKILL.md`). Namespace
directories and modules bundled inside a skill are not counted separately. For
example, six skills under `skills/ai/` plus `skills/officecli/` count as seven.

`docs` counts files recursively under `docs/`, excluding hidden files and hidden
directories. Documents stored only in subdirectories are also discovered and
synced by `pull`. Learnings are not included in this resource summary; they are
shared at the root or selected by active projects, not by roles.

`--all` enumerates every project's machine-data partition and flags each as
**active** (project still on disk), **ORPHAN** (project moved/deleted — its
partition is safe to `rm -rf`), or **unknown** (no `anchor` file, so it cannot be
confirmed orphaned — never recommended for deletion). The ORPHAN verdict rests
only on the anchor, so a partition is never flagged for deletion on a hunch. teamai
never garbage-collects orphans automatically, so this is how you find partitions to
delete by hand.

### Role management

Roles control which skills, namespaced rules and namespaced agents each member sees. Admins define roles via `manifest/roles.yaml`; once a member selects their role, `pull` syncs skills from the matching namespace. Active tag subscriptions may additionally sync explicitly matching skills from other namespaces, but untagged skills in inactive namespaces are not included.

**Admin operations:**

```bash
# Initialize (interactively create the manifest)
teamai roles init

# Add a role
teamai roles add devops --namespaces common,infra -d "Infrastructure team"

# Update a role (add/remove namespaces, change description)
teamai roles update hai --add-namespaces infra
teamai roles update hai --remove-namespaces legacy -d "New description"

# Remove a role
teamai roles remove devops

# Preview changes
teamai roles add test --namespaces common,test --dry-run
```

The `--namespaces` list is applied to `knowledge`, `skills` and `agents` alike. The commands above automatically push a branch and create an MR; the change takes effect team-wide once merged. With `--dry-run`, `teamai roles init/add/update/remove` and `teamai projects add/update/remove` fetch and read the manifest a real pull would use on the clone's checked-out branch (or origin's default branch in single-repo mode); they do not pull the team repo or, in single-repo mode, create a worktree, so commits you have not pushed stay. If fetching fails, these manifest previews warn and use the unchanged clone checkout, or the last fetched default-branch copy in single-repo mode, matching a real edit's warn-and-proceed policy. For these commands, clone previews refuse uncommitted changes with exit 1 and ask you to commit or stash them, since a real pull can retain local manifest edits. Dirty business files do not block self-mode previews. A clean clone preview retains an ahead branch, advances a behind branch, and uses origin/current-branch after divergence, matching the real pull. `roles init --dry-run` checks for an existing manifest and asks for overwrite confirmation inside that temporary checkout. In clone mode, real `roles init` pulls once before checking for an existing manifest and asking questions. It does not pull again before writing.

**Member operations:**

```bash
# View available roles
teamai roles list

# Choose your own role
teamai roles set hai
teamai roles set hai --add pm    # Primary role hai + additional role pm

# Sync resources for the new role
teamai pull
```

> **Safe degradation:** If an admin removes a role that a member is still configured with, `pull` won't error out — it falls back to a full sync and prints a warning prompting the member to choose a new role.

### Tag subscriptions

Tags let members subscribe to selected skills and rules outside their role's default namespaces.

```bash
teamai tags list
teamai tags subscribe frontend testing
teamai tags unsubscribe testing
```

Admins can manage resource tags with `teamai tags add` and `teamai tags remove`. Run `teamai pull` after changing your subscriptions; it does a full sync even when the team repo has not changed, so newly matched resources are installed and unsubscribed ones are removed. The checks at the end of that pull verify the newly matched skills reached every enabled tool.

---

## Commit Co-Author Attribution

AI coding tools stamp a `Co-Authored-By:` / attribution trailer on the commits they make. Teams that prefer a clean history can turn this off for everyone; individual members can still override it on their own machine. `teamai pull` applies the resolved intent to each installed tool's own config file.

The feature is controlled by the same two-tier pattern as recall:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.coAuthor.enabled` | `true` = keep the trailer / `false` = strip it. Omit the block entirely for "no opinion" (teamai touches nothing) |
| User override | `~/.teamai/config.yaml` | `coAuthorEnabled` | `true` / `false`, takes priority over the team default |

Per tool family, the trailer maps to a different setting:

| Tool family | File | Setting written | Scope | Reliability |
|------|------|------|------|------|
| Claude (`claude`, `codebuddy`, `workbuddy`) | `settings.json` | `attribution.commit` / `attribution.pr` set to `""` | user **or** project (follows the active scope) | Deterministic |
| Codex (`codex`) | `~/.codex/config.toml` | `commit_attribution = ""` | user only | Best-effort — only takes effect when `[features].codex_git_commit = true`, which teamai does not force |
| Cursor | `~/.cursor/cli-config.json` | `attribution.attributeCommitsToAgent = false` | user only | Best-effort — a [known upstream bug](https://forum.cursor.com/t/local-executor-ignores-cli-config-attribution-opt-out-forcing-co-authored-by-trailer/167722) can cause the local executor to ignore this |

Semantics:

- **Write-only, never delete.** Once teamai has written a value, dropping the team policy later leaves that value untouched — teamai never restores a trailer it stripped. To re-enable, set the intent back to `true` explicitly (which removes teamai's override so the tool's own default returns).
- **Idempotent.** teamai records what it last wrote per file (in `state.json` under `coAuthorManaged`) and skips a write when nothing would change.
- **Only installed tools are touched**, and existing keys/comments in each config file are preserved (key-level surgery, not regenerate-from-scratch).

Restart your AI tool session after a `pull` for the change to take effect.
