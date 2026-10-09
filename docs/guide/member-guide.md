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
teamai init https://github.com/your-org/your-repo
# Done! AI tools now automatically have access to team resources
```

**User-scoped teams:**

```bash
npm install -g teamai-cli
teamai init https://github.com/your-org/your-repo --scope user
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
those commands. 

Older releases copied the whole tree into every agent directory, where it
went stale between pulls; `teamai pull` removes those leftovers, keeping a copy of every
removed file under `~/.teamai/removed-skills/`, one directory per pull (until `teamai uninstall`,
which removes `~/.teamai/` and this archive with it). Only files whose content a release shipped
are removed: a packaged file you edited, or a skill of your own under one of the old names, is
yours and stays. A directory that also holds a file of your own is kept, with only the
packaged files removed, and named in the pull output. 

`share` is served only while recall is
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

*(Note: Automatic sync on session start requires an agent that supports lifecycle hooks, such as [CC], Codex, GitHub Copilot CLI, Cursor, CodeBuddy, WorkBuddy, Qoder, ZCode, Kiro, OpenCode, Oh My Pi, Pi, Hermes, OpenClaw, or DeepSeek Harness. Kiro runs the hook when a TeamAI-rendered custom agent is activated in an interactive CLI session; its in-memory built-in default agent is not writable, and non-interactive mode does not fire `agentSpawn`. For tools without a teamai-writable hooks surface such as JoyCode, Trae or Gemini CLI, run `teamai pull` manually.)*

If you need to sync immediately, you can run it manually:

```bash
teamai pull              # Manual pull
teamai pull --dry-run    # Dry run, no actual changes
```

A command with no `--dry-run` preview, such as `teamai init`, `teamai hooks remove`, `teamai models add` / `configure` / `remove`, `teamai bind-project` or `teamai codebase --extract`, refuses the flag: it prints `teamai <command> has no --dry-run preview, nothing was run` and exits 1.

`remove`, `roles init/add/remove/update`, `projects add/update/remove`, and `import --from-repo/--from-repo-list` support `--dry-run`. Remote import sources take precedence over lower-priority iWiki or Claude flags. `digest`, `import --from-claude`, and `import --from-iwiki` have no safe preview and refuse it. Previews for `stats`, `recall <query>`, `import --from-org`, `--from-mr`, `--dir`, and `recall feedback` remain available.

A manual `teamai pull` ends by running the `teamai doctor` checks and printing each one that failed, with its fix — including whether the skills it just reported syncing are readable on disk for every enabled tool. It prints nothing when they all pass, and the exit code is unchanged. The SessionStart hook path and `--dry-run` run no checks at all, so session startup stays as fast as before. Provider checks (`gh`/`gf` authentication) are left to `teamai doctor`: the pull just used the provider.

**Pull keeps a skill, rule or agent you changed.** For each checkout, pull records what it wrote at each skill, rule and agent path. On a full sync, a copy that no longer matches that record is kept, and pull names it, while the copies of other tools still update. A skill counts as one copy: a change to any of its team files keeps the whole skill, and files only you added do not count. If the team version has not changed, pull prints ``Kept <path>: you changed it since teamai delivered it. 

Share it with `teamai push`, or delete it and run `teamai pull --force` to get the team version back.`` If it has, whether the team changed it or your [local model alias override](./advanced.md#local-override) did, pull warns and asks you to merge that change into your copy before you push it, and `teamai push` warns about that copy too, since the SessionStart pull runs silently. `--force` keeps these copies too, and `--dry-run` prints `Would keep <path>` for each. 

When the team removes an item, a copy you changed stays, and pull names it; a file of yours at that path that holds no team version stays too, and pull names it as not teamai's (``Kept <path>: it is not teamai's (...), so pull left it.``). A skill, rule or agent pull has no record of (before your first full pull with this version, in a new worktree, in a checkout restored from a backup or copied, which gives `.git` a new identity, or one you wrote yourself) is teamai's only when it holds what teamai delivers for that resource at some revision of the team repo's history; pull then updates or removes it as before. 

A skill directory is teamai's only when every file in it is, so one file of your own in it makes the whole directory yours. Anything else there is yours: pull neither writes nor deletes it. Where teamai delivers a team skill, rule or agent, pull names it with ``Kept <path>: it is not teamai's (no delivery record, and it matches no team version of <resource>). 

Rename or delete it, then run teamai pull, to receive the team version.``, or with the lines above when another checkout record shows teamai wrote that path, as after a restore; `teamai doctor` lists it as `not teamai's (kept by pull)` with the same line, and every pull syncs in full until it is gone. A file of a name the team never had is left alone. `teamai remove` applies the same checks to the rules it refreshes, but records nothing; installs from the local agent still rewrite the team rules without them. An older CLI that saves state drops the record.

**Codex and `.agents/skills`.** Codex also reads the shared `.agents/skills/` (`~/.agents/skills/` in user scope), which other tools and you write to as well. teamai delivers a team skill there only when the copy already there is teamai's by the rule above. Any other copy is yours and stays untouched: the team skill goes to `.codex/skills/<name>/` instead, and every full sync prints ``Codex skill conflict for <name>: .agents/skills/<name> is not teamai's, so it was left alone; the team skill is in .codex/skills/<name>. 

Codex now sees two skills named <name>.`` When a skill stops being delivered (a role or project switch, a tag you unsubscribe, a skill the team removes), pull removes teamai's copy from `.agents/skills/<name>/` as from `.codex/skills/<name>/`; a copy there you changed, or one that is not teamai's, stays and is named. In every tool's skills directory, `teamai remove skills <name>` and `teamai uninstall` delete only teamai's copy (on the checkout's record, or a team version by the history) and name each skill of yours they leave: ``Kept <path>: it is not teamai's (no delivery record, and it matches no team version of skills/<name>), so <command> left it.``

> Project scope is isolated by default. When the current working directory belongs to a project that has been initialized in project scope (its partition under `~/.teamai/projects/<slug>/`, or a legacy in-repo `.teamai/config.yaml`), `pull` processes that project and skips user scope unless the local config has `inheritUserScope: true`; in that case it first refreshes the safe user-resource channel. Without a project config in the current directory, `pull` processes user scope. User `env`, MCP definitions, sources, reporting, and writes remain isolated in project mode. 

> Hooks are the one exception: a project scope's built-in hooks are injected into your **HOME** tool settings (`~/.claude/settings.json`, …), not `<projectRoot>`, because they gate on the `cwd` handed to `hook-dispatch` and `~/.claude` always exists so the "installed tool" gate passes (see the Hooks section). The team's own hooks (`hooks/hooks.yaml`) for Claude Code and Codex go to the main checkout instead, ungated (`<main checkout>/.claude/settings.local.json`, `<main checkout>/.codex/hooks.json`), so every worktree of the project shares one copy. With `sharing.gitExclude` on, the Codex ones run from `~/.codex/hooks.json` instead while `<main checkout>/.codex/hooks.json` holds anything that is not teamai's (see [Keeping Delivered Files Out of Git](#keeping-delivered-files-out-of-git)). These paths follow the project `toolPaths`; Claude uses `settings.local.json` beside its configured settings file. 

> For a bare repository, each worktree keeps its own copy because there is no main checkout; other tools keep them in HOME, run only when the `cwd` is inside the project. In a directory with no teamai config (no project config and no user scope), the team hooks do nothing: no reminders, and no session or skill usage is recorded; only machine-level work runs (the CLI update check, the session-start pull, the local agent, and package hints a pull stashed). For the team hooks and skill usage, a project config that exists but cannot be read counts as none, never as the user scope or as a lower-priority project config (such as a legacy `.teamai/config.yaml`) behind it. 

> `pull` follows the same rule: it syncs no scope there, prints ``Nothing was synced: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` and exits 1 (with `--silent`, it prints nothing and still exits 1); a session start there runs no pull, seeds no agent directory and stashes no package hint. A hook whose `cwd` was deleted (a session that outlives its worktree) keeps the scope its session last recorded, so the session's last events and skill uses stay with the project, and its share reminder follows the project's settings, instead of the user scope's. 

> This needs the session's earlier events in the local event log, which compaction trims to active sessions, and does not cover Copilot, whose events record no directory. Self single-repo mode keeps its hooks in the business repo so they travel on clone; with `sharing.gitExclude` on, the team's Claude Code hooks go to each checkout's own `.claude/settings.local.json` instead, and its Codex hooks run from `~/.codex/hooks.json` (see [Keeping Delivered Files Out of Git](#keeping-delivered-files-out-of-git)).

With role-based skills enabled, `pull`'s skill sync source becomes the contents of `skills/<namespace>/`, expanded according to `primaryRole + additionalRoles` and flattened into each local AI tool's skills directory. `rules/<namespace>/` and `claudemd/<namespace>/` follow the `knowledge` namespaces, and a `docs/<namespace>/` follows the `docs` namespaces once one is declared (see [Docs](./sharing.md#docs)); `agents/<namespace>/` follows the role's `agents` namespaces (see [Agents Resource Type](./advanced.md#agents-resource-type)). `learnings/` at the root is shared with everyone, while `learnings/<project-id>/` subdirectories sync only for the directory's active projects (see [Multi-project](./admin-setup.md#multi-project-project-as-a-dimension-orthogonal-to-role)).

**A namespace item replaces the root item of the same name.** With a role or project configured, an item in an active namespace is delivered instead of the root item that has the same name. The whole item is replaced; nothing is merged:

- A skill replaces the root skill of the same directory name, including a root skill you receive through a tag. The install removes the files of the version it replaces. Files that no team version of the skill has stay.
- An agent replaces the root agent of the same file stem.
- A rule replaces the root rule of the same first-level file name: `rules/<ns>/<name>.md` replaces `rules/<name>.md`, in Hermes' `SOUL.md` block and the rules a session-start hook or Pi's extension adds too. Deeper paths such as `rules/<ns>/<dir>/<name>.md` replace nothing, and neither does a namespace rule your tag subscriptions leave out. 

  In rule directories you share with rules of your own (every tool with a rules format of its own except Cursor: JoyCode, Copilot, Kiro, Qoder, Trae, CodeBuddy, WorkBuddy and Oh My Pi), the replaced root rule's copy is removed only while it is what teamai delivered (the current root rule, or the one of your last pull); an edited copy stays, and each pull names it, since the tool loads it beside the namespace rule.
- A `claudemd/<ns>/<name>.md` file replaces `claudemd/<name>.md` in the managed block.

When the namespace stops being active, the next pull delivers the root item again. If two active namespaces define the same skill or agent name, they compete for one installed file, so pull reports an error that names both files, does not update that type in that run, and keeps what is installed (for skills, recall keeps the ones it had indexed too); the other resource types still sync. Two active namespaces with the same rule or shared-instructions name are both delivered, because each keeps its own place (`rules/<ns>/` locally, its own section of the block); only the root one gives way. 

`push` writes an edit of a replaced item back to its namespace, never to the root, and recall indexes the skills and rules you receive rather than every one in the repo. A replacement that cannot be used replaces nothing: a skill directory without `SKILL.md` is not delivered and pull names it, and while an agent file does not parse the agent it would replace stays installed. `teamai doctor` lists each replacement as a note. Without roles or projects nothing changes: every namespace is delivered beside the root, and `doctor` lists each name the team repo defines more than once.

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

After a successful install, TeamAI writes a local snapshot to `teamai.lock` in the scope's data home (`~/.teamai/projects/<slug>/` for a project, `~/.teamai/` for user scope), never in the working tree. A `.teamai/teamai.lock` an older release wrote is moved there on the next install or session start, and the `.teamai/.gitignore` it created to hide it is removed. One your repository tracks stays where it is (moving it would leave a deletion in `git status`): teamai reads it there until it has its own copy in the data home, and `teamai doctor` names it with the command to stop tracking it, `git rm --cached .teamai/teamai.lock`. 

The lock records installed versions and the declaration hash used by the SessionStart hint; it is not stored in the team repository. In user scope, machine-wide npm tools and Claude plugins are acknowledged once, while project npm dependencies are acknowledged separately for each working directory so installing in one repository cannot silence another repository's hint.

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

Before scanning, `push` refreshes unedited old rule copies from the team repo. For a tool with a rules format of its own (Cursor `.mdc`, JoyCode's own `.mdc`, Copilot `.instructions.md`, Kiro steering, the Trae rules, and the Qoder, CodeBuddy, WorkBuddy and Oh My Pi rules), it compares Markdown bodies independently of the generated header and renders updates in that tool's format. Local body edits are preserved. For Copilot this applies to project rules and user rules under `COPILOT_HOME`. Each copy it refreshes is recorded as delivered, so the next `teamai pull` still updates it instead of keeping it as your change. 

A new file in one of those tools' rules directories is your own rule in that tool's format, so `push` never offers it; to share a new team rule, write it as a plain `.md` in `.claude/rules/` (scoped with `paths:` if needed) and push that.

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
- `teamai remove rules <name>` accepts the bare name the author's copy carries as well as the published `<namespace>/<name>`; it reports which one it resolved to, and removes both the namespaced team file and the author's copy at the rules root. If the team repo cannot be refreshed first, or this machine's placement records cannot be updated and saved, `remove` stops with exit 1 and removes nothing, because either can resolve the name to the wrong files. `--dry-run` only fetches: it resolves names against the contents a real pull would use on the clone's checked-out branch (or origin's default branch in self mode), and saves no records. Clone previews fetch the configured upstream first, including differently named branches or remotes. 

  If that pull cannot fast-forward or has no upstream, they fetch origin/current-branch to model the real reset fallback. A local-only branch is refused for removal when neither refresh can succeed. In clone mode, a failed fetch stops the preview with the same refusal and exit 1 as a real removal. A clone with uncommitted changes is refused with exit 1; commit or stash them before previewing. Dirty business files do not block self-mode previews.
- A local agent is an edit of the team agent it was delivered from: one in an active namespace first, then one this machine placed, then the shared-root agent either of them replaces. Only when none exists does `--role`/`--project` decide, and the agent is new in that namespace; if that namespace already holds an agent of that name, the agent is skipped rather than written over it, as a rule would be. Two active agents of one name stay ambiguous and are skipped, flag or not. The same agent name may exist in several namespaces, so a copy in an inactive one you did not name never blocks publishing yours. 

  A placed agent that changed on the team since this checkout last synced it is held, because agents have no pre-push sync. Pull keeps your changed copy, so save your edit, delete the copy, run `teamai pull --force`, reapply the edit and push again. In single-repo mode, a root copy under `.teamai/` that matches an older version of the file it was placed at is held too: nothing refreshes it, so it is an old copy rather than an edit
- A new resource is never placed on top of one that is already there. If the resolved namespace already holds that name, the push stops and names the file: pull and edit the existing copy, rename yours, or pick another namespace with `--role <ns>`
- An agent whose namespace is not active here stays editable through its placement record, and `pull` delivers it for the same reason, so your copy tracks the team file. It replaces a shared-root agent of the same name, as an active namespace's agent would. An active namespace holding that name wins: that agent is the one deployed here
- A resource awaiting review in an open PR keeps that PR's destination — unless this push names a namespace other than the one recorded (the shared root counts as one), in which case the flag decides, the open PR is left untouched, and the collision is reported
- If the team repo cannot be refreshed at the start of a push, `--project` stops instead of placing by a possibly stale `manifest/projects.yaml`; so does any new resource placed without `--role`, because its destination comes from that clone (`manifest/roles.yaml`, its absence, or the namespaces the repo already has). Fix the pull and retry, or name the namespace with `--role <ns>`. `push` also stops, and pushes nothing, when this machine's placement records cannot be updated and saved
- A placement record is written only once the pushed file has landed on the default branch, so a PR closed without merging leaves none behind, whatever became of its branch. It is dropped again when the team deletes that file. Without roles or projects it is also dropped when a shared-root file of the same name appears (your root copy then follows that file, and `pull` warns). With a role or project, the placed resource replaces that shared-root one here instead, and the record stays. `push`, `pull` and `remove` settle this before they read the records. 

  `teamai remove` itself leaves the record alone: its deletion reaches the default branch only when its PR merges, and until then a retried `remove` still resolves the bare name to the namespaced file. If the file reached the default branch with content other than what you pushed (for example a reviewer changed the PR before a squash merge), it is not recorded, and push says so once; run `teamai pull` and edit that file as the team file it now is
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

The `--namespaces` list is applied to `knowledge`, `skills` and `agents` alike. The commands above automatically push a branch and create an MR; the change takes effect team-wide once merged. With `--dry-run`, `teamai roles init/add/update/remove` and `teamai projects add/update/remove` fetch and read the manifest a real pull would use on the clone's checked-out branch (or origin's default branch in single-repo mode); they do not pull the team repo or, in single-repo mode, create a worktree, so commits you have not pushed stay. If fetching fails, these manifest previews warn and use the unchanged clone checkout, or the last fetched default-branch copy in single-repo mode, matching a real edit's warn-and-proceed policy. 

For these commands, clone previews refuse uncommitted changes with exit 1 and ask you to commit or stash them, since a real pull can retain local manifest edits. Dirty business files do not block self-mode previews. A clean clone preview retains an ahead branch, advances a behind branch, and uses origin/current-branch after divergence, matching the real pull. `roles init --dry-run` checks for an existing manifest and asks for overwrite confirmation inside that temporary checkout. In clone mode, real `roles init` pulls once before checking for an existing manifest and asking questions. It does not pull again before writing.

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
| Claude (`claude`, `codebuddy`, `workbuddy`) | user scope: `settings.json`; project scope: `.claude/settings.local.json` | `attribution.commit` / `attribution.pr` set to `""` | user **or** project (follows the active scope); in project scope only `claude`, through its member-local file | Deterministic |
| Codex (`codex`) | `~/.codex/config.toml` | `commit_attribution = ""` | user only | Best-effort — only takes effect when `[features].codex_git_commit = true`, which teamai does not force |
| Cursor | `~/.cursor/cli-config.json` | `attribution.attributeCommitsToAgent = false` | user only | Best-effort — a [known upstream bug](https://forum.cursor.com/t/local-executor-ignores-cli-config-attribution-opt-out-forcing-co-authored-by-trailer/167722) can cause the local executor to ignore this |

Semantics:

- **Write-only, never delete.** Once teamai has written a value, dropping the team policy later leaves that value untouched — teamai never restores a trailer it stripped. To re-enable, set the intent back to `true` explicitly (which removes teamai's override so the tool's own default returns).
- **Idempotent.** teamai records what it last wrote per file (in `state.json` under `coAuthorManaged`) and skips a write when nothing would change.
- **Only installed tools are touched**, and existing keys/comments in each config file are preserved (key-level surgery, not regenerate-from-scratch).
- **Shared project files stay untouched.** The choice is per member, and a project's `.claude/settings.json` is often tracked, so in project scope teamai writes only Claude's member-local `.claude/settings.local.json` and leaves the other Claude-family tools to user scope. Releases before this fix wrote the shared project `settings.json`; the next `pull` removes that `attribution` only when it is exactly teamai's `{"commit": "", "pr": ""}` and teamai recorded writing it there, deleting just that key. Commit the change if the file is tracked. 

  While neither the team nor you has a co-author choice, the next `pull` moves that value from `.claude/settings.json` to `.claude/settings.local.json` under the same conditions, so your trailer setting stays as it was (a value you already set in `settings.local.json` is kept); other Claude-family tools' shared settings files are left as they are until a choice exists.

Restart your AI tool session after a `pull` for the change to take effect.

---

## Keeping Delivered Files Out of Git

In project scope, `teamai pull` writes the team's resources into the business repo's tool folders (`.claude/skills/<name>/`, `.cursor/rules/`, `.github/agents/`, and so on), where `git status` shows them and one `git add -A` commits them. With this option on, teamai lists each path it delivered in a block it owns in the clone's `.git/info/exclude`:

```
# [teamai:delivered:start]
/.claude/agents/reviewer.md
/.claude/rules/fe/style.md
/.claude/rules/teamai-context.md
/.claude/settings.local.json
/.claude/skills/code-review/SKILL.md
# [teamai:delivered:end]
```

That file is local to your clone, shared by its worktrees, and never committed. teamai never changes `.gitignore` or the git index.

What the block lists:

- skills one file per line, never the skill's directory, so a file of your own added to a delivered skill stays visible and addable: team, role, project and source skills, the CLI's `teamai` skill, Codex's copies in `.agents/skills/<name>/` and Copilot's in `.github/skills/<name>/`; an entry of yours of the other type inside a delivered skill (a file where the team has a directory, or the reverse) is not listed, nor is anything under it, so it stays visible;
- rules one file per line, never a directory, so a file of your own beside them stays visible: namespace subdirectories (`.cursor/rules/fe/style.mdc`), flattened names (`.kiro/steering/fe.style.md`) and `.github/instructions/**/*.instructions.md` included;
- agents, and the `teamai-recall` rule and agent;
- your `teamai-context` files (`.claude/rules/teamai-context.md`, `.cursor/rules/teamai-context.mdc`, `.codebuddy/rules/teamai-context.md`, `.opencode/teamai-context.md`, `.github/instructions/teamai-context.instructions.md`);
- Copilot's `.github/hooks/teamai.json`, and `.claude/settings.local.json` while teamai has an entry in it (the team's hooks, or the co-author setting), whatever else it holds;
- the team docs pull mirrored into `sharing.docs.localDir`, one line per doc, never the directory, so a file of your own there stays visible, and so does a doc you edited from the next pull that syncs the docs (a team change, or `pull --force`); nothing in or under an entry of yours that pull keeps there (a directory or a link at a doc's path) is listed. With the mirror at its default `.teamai/docs/`, also `.teamai/.ignore` (see below);
- on OpenCode V2, `.opencode/teamai-mcp.json`, the file teamai's plugin reads the team MCP servers from (see [OpenCode](./advanced.md#opencode));
- a shared config file that holds nothing but teamai's entries, while git does not track it: the project MCP configs `.cursor/mcp.json`, `.github/mcp.json`, `.codex/config.toml`, `.kiro/settings/mcp.json`, `.omp/mcp.json`, `.pi/mcp.json`, `.workbuddy/mcp.json` and, on OpenCode V1, the root `opencode.json`; `.codex/hooks.json`; and, on OpenCode V1, `.opencode/opencode.json`. Nothing but teamai's means every server, team hook or `instructions` entry in it is teamai's, and it has no other top-level key (`$schema` counts as one). An entry teamai has no record of counts as teamai's when it equals what teamai writes for a team server or hook, now or at an earlier team version, so a file written before you upgraded, or after its records were lost, is listed too; the `instructions` entries of `.opencode/opencode.json` have no record and count when they equal the ones teamai writes.

`.mcp.json` (Claude's while tclaude is installed and enabled; in a single-repo team it is listed while it holds only teamai's servers) and Qoder's `.qoder/settings.json` are not listed. With the option on, teamai writes Claude's and CodeBuddy's project MCP servers to their local scopes, in `~/.claude.json` and `.codebuddy.json`, instead of `.mcp.json` (see [MCP servers](./sharing.md#mcp-servers)), and no longer writes into `.github/copilot-instructions.md`: Copilot gets the blocks from `.github/instructions/teamai-context.instructions.md` instead (see [Where the blocks go](./team-culture.md#where-the-blocks-go)), and the next pull removes teamai's blocks from the team's file. Turning the option off moves them back on the next pull.

Your AI tools still load excluded skills, rules and agents: only git ignores them. A search that follows git's ignore rules (ripgrep, most editors' search, an agent's search tool) skips them, so open an excluded file by its path; `teamai skill path <name>` prints where a CLI built-in skill lives.

The team docs stay searchable. With the mirror at its default `.teamai/docs/`, the pull keeps a block of teamai's in `.teamai/.ignore`, a file ripgrep reads and git does not, re-including the docs for ripgrep-based search (the grep tools of Claude Code, Cursor, Copilot and OpenCode, Codex's file search):

```
# [teamai:delivered:start]
!/docs/**
# [teamai:delivered:end]
```

- Lines of your own in `.teamai/.ignore` stay as you wrote them. The file is listed in the `delivered` block only while teamai's block is all it holds; with lines of yours, git shows it. A `.teamai/.ignore` your repository tracks is left as committed.
- The block is there only while the option is on and the docs are delivered to `.teamai/docs/`. Turning the option off, single-repo mode (whose `.teamai/` is the team's, never kept out of git) and `teamai uninstall` remove it, and the file when nothing else is in it.
- A docs directory set elsewhere (`sharing.docs.localDir`) gets no `.ignore`: its docs are listed, and a search that follows git's ignore rules skips them. So does a search that skips hidden directories, and any search while an ignore rule of yours covers `.teamai/` as a whole. Search the docs directory by its path then: `sharing.docs.localDir`, or `.teamai/docs/` by default, as `teamai pull --help` says.

The option is controlled by the same two-tier pattern as recall:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.gitExclude.enabled` | `true` / `false` (default `false`). `teamai init` writes `true` into the `teamai.yaml` it creates for a new team (git and single-repo mode); joining or re-running `init` never changes it |
| Member override | the project's `config.yaml` (`~/.teamai/projects/<slug>/config.yaml`) | `gitExcludeEnabled` | `true` / `false`, edited by hand; takes priority over the team default |

- A change takes effect on the next `teamai pull`, the session-start one included, also when that pull finds the team repo unchanged ("Already synced"): no `--force` needed. In single-repo mode, an uncommitted edit of `.teamai/teamai.yaml` counts too.
- Only what teamai wrote, or confirmed as its own, in this checkout is listed. A file of your own at a path teamai would deliver (pull keeps it and names it) stays visible and addable. So does a copy pull keeps because you changed it, and a copy teamai no longer delivers but left on disk, such as a source skill once the team removes its last source.
- A shared config file stops being teamai's alone as soon as it holds anything else: a server, hook or `instructions` entry of yours, or another top-level key. The next pull, the session-start one included, takes its line out, so git sees your entry, and says ``<path> now holds entries teamai does not own, so git can see it.`` Take your entries out and a later pull lists the file again. `.codex/hooks.json` is handled as in the next item. An MCP config holding a value teamai resolved stays in the `mcp-exclude` block whatever else it holds (see [MCP servers](./sharing.md#mcp-servers)), so git still does not see it and pull says nothing.
- While git cannot say whether it tracks such a file (a broken index, a git error), the file keeps the line the last pull gave it, and the pull fails with ``git could not say whether it tracks <path>: <error>.`` A background pull keeps that failure for the next interactive pull and `doctor`.
- Codex team hooks: while `.codex/hooks.json` holds anything that is not teamai's (your repository tracks it, or it holds a hook of yours or another top-level key), teamai writes no team hook into it. The team's Codex hooks run instead from one entry per event in `~/.codex/hooks.json`, `teamai hook-dispatch <Event> --tool codex --team-hooks`, beside the built-in ones. It runs the team hooks of the project the Codex session's working directory belongs to, as Codex would: matchers, each hook's own timeout (a hook still running then is stopped), its output on stdout, and its exit code 2 with its message, which blocks. In another directory it runs nothing. The entry's timeout is the largest team hook timeout for that event, counting Codex's 600-second default for a hook that sets none. The switch happens on the pull that sees the change: it takes teamai's entries, recorded or not, out of the file, so no team hook runs twice; once the file is gone, or holds only teamai's entries again, the next pull writes them back into it. teamai trusts these entries in Codex; they name no project, so the trust holds as worktrees come and go. `teamai uninstall` removes the project's team hooks from them, and the entries no other project needs.
- Known limit: such a file stays untracked. If a teammate commits a file at the same path and you run `git pull`, git overwrites your excluded copy without asking. teamai's entries come back on your next `teamai pull`, merged into the now-tracked file, but entries you added since the last teamai run are lost.
- One block serves every worktree of the clone: it lists what each live checkout's last pull delivered there, so a pull in one worktree keeps another's lines, also in a `git init --separate-git-dir` repo and in a project that is a submodule. A worktree you remove or prune loses its lines on the next pull in any checkout.
- A path that holds a file of your own in another checkout (one teamai did not deliver there) gets no line, because the line would hide that file too: pull names the path, and git shows it in every checkout. Your own `.claude/settings.local.json` in a linked worktree does not count. A file one checkout tracks and another got untracked from teamai stays listed; git still shows changes to the tracked one.
- A tool folder that is a submodule or a nested clone (say `.claude` added with `git submodule add`), and a tool home kept in git (Hermes's `~/.hermes/skills`), get their lines in that repository's own `.git/info/exclude`, in a block named after the project (`# [teamai:delivered/<id>:start]`). The superproject no longer shows the submodule modified, and projects sharing a tool home each manage only their own block.
- A role or project switch drops the old selection's lines on the next pull. A copy pull did not rewrite but still owns (an agent held for its model, hooks whose team file does not parse) stays listed.
- A delivered copy your repository tracks gets no line (a line does nothing for it); in a skill, that is the tracked file alone, and the skill's other delivered files keep their lines. Pull never deletes it, whatever the setting: when teamai stops delivering it (a role or project switch, the team or a source removing it), the pull keeps it rather than leave a deletion in `git status`, and names it each time it would remove it: ``Kept <path>: this repository tracks it, so teamai does not delete it. Run `git rm -r <path>` and commit if the repository no longer needs it.`` teamai never deletes a file git tracks. A layout migration that now writes the resource elsewhere (a Cursor rule's old `.md` copy, for example) keeps the tracked old copy and adds: ``The resource now lives at <new path>, and the tool may load both until the repository removes this copy.`` `teamai remove`, `teamai source remove` and `teamai uninstall` remove everything else and name each tracked path the same way; the uninstall summary lists them under `Kept (tracked)`.
- Turned off, the next pull removes the project's `delivered` blocks and nothing else: your own lines and teamai's other blocks (such as the MCP one, see [MCP servers](./sharing.md#mcp-servers)) stay.
- While the team's `teamai.yaml` is missing or does not validate and you set no `gitExcludeEnabled`, the setting is unknown, not off: pull leaves the `delivered` blocks as they are and fails with ``teamai could not read sharing.gitExclude from the team's teamai.yaml (<path>), so it left its delivered git exclude blocks as they were. …``, and `teamai doctor` fails with the same line, naming the source `team config unreadable`. Fix or restore `teamai.yaml`, or set `gitExcludeEnabled`, then run `teamai pull`. HTTP mode has no team setting: there your `gitExcludeEnabled`, or the default, decides.
- teamai records what each pull delivered into a checkout whatever the setting, so the first pull after upgrading from a release that kept no such record is a full sync, never "Already synced".
- A pull that cannot update the block (the exclude file is not writable or not readable, or another teamai command holds it) leaves it as it was and warns; fix the cause and run `teamai pull` again. A delivered path that a rule of yours re-includes (a `!` line in a `.gitignore`) fails the pull too, which names the path and the rule as `teamai doctor` does: ``git still sees <path>: `<rule>` (<file>:<line>) re-includes it. Remove that rule.`` A pull skipped because another pull or push holds the project's sync lock leaves it too; the holder, or the next pull, updates it.
- A pull nobody watches (the session-start pull, the pulls teamai's git hooks run) cannot warn, so it keeps what it had to say in the project's data home (`git-exclude-notices.json`, apart from the git hook's own failure record): its last failure to update a block, replaced by each failed update and cleared by the next update that succeeds, and its notices (a path no git exclude line can name, a path another checkout's own file leaves visible, a shared config file that now holds your entries). The next `teamai pull` you run says them once, the failure first (``A background pull (<time>) could not keep teamai's git exclude blocks up to date: …``), then drops the notices; a busy exclude file is simply retried by that pull. `teamai doctor` shows both until then.

**Checking the blocks.** `teamai doctor` says whether the option is on and where that comes from (the team's `teamai.yaml`, your `gitExcludeEnabled`, or the default), and names an un-migrated layout whose data still sits in the project's `.teamai/` (when the migration keeps it there, for example because the partition directory exists without its `config.yaml`). Such a checkout does not read its own `gitExcludeEnabled`, since each worktree there has its own config while they share one exclude file: the team's setting or the default applies until a pull migrates the data. Its git calls are batched: one `git ls-files --others` per exclude file, then `git check-ignore -v` only for the paths git still offers.

- Off, it says how many delivered resources git sees: ``Delivered team resources are visible to git: N untracked (first 5: …)``, with the two ways to turn the option on. Only `doctor` says this; a pull never does.
- On, these checks fail, and an interactive pull reports them too: a delivered path not listed, or listed but still seen by git (naming the rule that re-includes it, such as a `!` line in a `.gitignore`); an exclude file that cannot be read; a damaged block (a start or end marker without its pair, a block written twice); a path another checkout's own file leaves visible; the last failure of a background pull.
- Information only, never a failure: a delivered path your repository tracks (``Run `git rm -r --cached <path>` there and commit``), stale lines the next pull drops, a copy pull keeps because your repository tracks it, a file pull keeps where the team removed a doc, and a background pull's notices. Each is named with the line pull itself prints.

**Previewing.** `teamai pull --dry-run` prints one line per block: ``[dry-run] Would list N path(s) and drop M in teamai's delivered git exclude block in <file>``, or, with the option off, ``[dry-run] Would remove teamai's delivered git exclude block from <file> (sharing.gitExclude is off)``. N counts the lines the block would hold: what this pull would write plus every other live checkout's list. The preview writes nothing: no exclude file, no `info/` directory, no lock file. Hook and co-author files are previewed as they hold teamai's entries now.

**Uninstalling.** `teamai uninstall` removes teamai's blocks once it has deleted the files they hid, and `uninstall --agent <tool>` drops only that tool's lines; see [Uninstall](./faq.md#uninstall).

**HTTP mode.** The skills and rules the local agent installs in a project, and the teamai-owned file its project prompts go to for each tool they reached (`.claude/rules/teamai-context.md`, `.codebuddy/rules/teamai-context.md`, `.opencode/teamai-context.md`, Copilot's `.github/instructions/teamai-context.instructions.md`), get a block of their own, `# [teamai:local-agent:start]`, one line per installed file (a file you add to an installed skill stays visible), in the exclude file of the repository each one lands in, while that project's option is on: `gitExcludeEnabled` in the project's `config.yaml`, else in `~/.teamai/config.yaml` (an HTTP team has no `teamai.yaml` setting).

- The agent updates the block at the end of every session start, from its records and each project's option, so turning the option on or off takes effect at the next session start with nothing new installed. Its other runs (on each prompt, tool call and stop) update it only after installing or removing a skill, rule or prompt in a project, or when its records or a `config.yaml` changed since its last update. It records the exclude files it wrote in `~/.teamai/local-agent/git-exclude.json`. A checkout that no longer exists contributes no lines. A pull never removes this block.
- When the agent cannot update the block (an exclude file not writable, git failing), it keeps the failure in `~/.teamai/local-agent/git-exclude-notices.json` until an update succeeds: the next interactive `teamai pull` prints it once, prefixed `A local agent sync (<time>)`, and `teamai doctor` fails `Last local agent sync could not keep its git exclude block up to date` until then. A project the agent installed into that follows a git-mode config whose team `teamai.yaml` cannot be read, with no `gitExcludeEnabled` set, keeps the lines it has, and the agent records that as a failure naming the file to fix; meanwhile each install or uninstall there fails, writes nothing, and names the project, the unreadable file, and both ways out: fix or restore that `teamai.yaml`, or set `gitExcludeEnabled` in the project's `config.yaml`.
- Prompts (`CLAUDE.md` fragments) stay in the agent's cache and are not listed.
- In a workspace with no project config, the agent keeps that cache in the workspace's `.teamai/`, hidden by a `.teamai/.gitignore` it writes; the block lists that file too, while it is as the agent wrote it. A `.teamai/.gitignore` you already had there stays yours and visible (the agent only adds `local-agent/` to it). Removing the agent (`teamai source remove-http`, a user-scope `teamai uninstall`) removes the cache and that file (unless you committed it), and their line. The block also lists the workspace's `managed-local-mcp.json` and its per-worktree `managed-mcp.json` and `managed-mcp-files.json` while those files exist. Tracked files and your own files remain visible.
- A file of your own at a path the agent would install to is kept, and the install fails with ``Kept <path>: it is not teamai's (not in the local agent's records). Rename or delete it; the local agent installs <slug> on its next sync.`` A copy equal to the download is taken over as the agent's.
- A project's `teamai uninstall` removes that project's lines only: the agent still serves your other workspaces, so their lines stay, in another repository and in an exclude file the project shares with a linked worktree alike. Uninstalling the user scope, which removes the agent, removes the block from every exclude file it recorded; so does `teamai source remove-http` once it has uninstalled each resource.
- Removing a skill or rule, by the agent's own uninstall, `teamai uninstall` or `teamai source remove-http`, removes the copy the agent installed for each tool (for an entry an earlier release recorded without its tools: each tool's copy), and only the files still equal to what the agent writes there from its cache. A file you added inside a skill, a copy you edited, and a file git tracks stay, each named. The line of a copy left on disk stays until the file is gone. A block the removal cannot write (a read-only exclude file) stays recorded, so the next `teamai source remove-http` or `teamai uninstall` removes it.
- A model API key the agent writes to a project's `.codebuddy/models.json` is listed in a `# [teamai:credentials:start]` block whatever the option and whatever another of teamai's blocks already lists, and is not written where git would commit it (see [HTTP Contract](./advanced.md#http-contract-for-backend-implementers), `apply_model_config`). Those exclude files are recorded in the same `git-exclude.json`.

**Single-repo mode.** While the setting is on:

- The built-in hooks stay in the committed tool settings (`.claude/settings.json`), so a fresh clone still has them. The team's Claude Code hooks (`.teamai/hooks/hooks.yaml`) go to each checkout's own `.claude/settings.local.json`, which is listed, so a pull no longer changes the committed settings. The first pull after the setting is turned on removes the team hooks from `.claude/settings.json` once: commit that change. Turned off, the next pull puts them back into `.claude/settings.json` and deletes `.claude/settings.local.json` when nothing else is left in it.
- `teamai init .` lists the hook files it wrote, such as Copilot's `.github/hooks/teamai.json`, before it ends.
- `.teamai/` is never listed: it is the team's committed knowledge. The copies a pull delivers from it into tool folders are listed as in any project.
- The committed `.codex/hooks.json` holds the built-ins, so the team's Codex hooks run from `~/.codex/hooks.json`, as for a `.codex/hooks.json` a repository tracks (see above), and a pull no longer changes the committed file. The first pull after the setting is turned on removes the team hooks from `.codex/hooks.json` once: commit that change. Turned off, the next pull puts them back. The file stays visible to git.
- `.cursor/hooks.json` and `.codebuddy/settings.json` keep the team hooks next to the built-ins, visible to git.

**The `git add -A` window.** A pull lists what it delivered once its last step has run, so a path it has just written is visible to git until that pull ends. Commands that deliver outside a pull (`teamai recall on|off`, `teamai hooks inject`, `teamai mcp inject`) do not update the block: the next pull lists what they wrote. Don't run `git add -A` (or an IDE's commit-all) while a pull runs, or between those commands and the next pull.
