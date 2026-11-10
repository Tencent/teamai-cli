# Core Harness

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

## Skills

```bash
mkdir -p ~/.claude/skills/my-deploy-helper
cat > ~/.claude/skills/my-deploy-helper/SKILL.md << 'EOF'
---
name: my-deploy-helper
description: Deploy a service for the team
---
# Deploy Helper
When the user requests a deployment, follow these steps:
1. Check that the current branch is master
2. Run tests `npm test`
3. Build `npm run build`
4. Deploy `./deploy.sh`
EOF

teamai push
teamai push --role pm
```

`push` fills in `name` and `description` when the frontmatter is missing. A new skill goes to `skills/<ns>/<name>/`, where `<ns>` comes from your role or the active projects. Several choices ask which one, including an explicit shared-root choice. `--role` picks a namespace; `--shared` places new resources at the shared root for the whole team, even when namespaces exist. It cannot combine with `--role` or `--project`. Edits of resources already delivered from a namespace keep their destination. When a namespace is selected and the team has `manifest/roles.yaml` or `manifest/projects.yaml`, a role or project there must declare it.

Shared-root skills keep the existing tag-subscription delivery rules when roles or projects filter skills. `--shared` selects the publishing location.

## Rules

```bash
cat > ~/.claude/rules/code-review-guide.md << 'EOF'
# Code Review Guidelines
- All functions must have JSDoc comments
- `any` type is not allowed
EOF

teamai push
```

A rule members cannot delete goes in `teamai.yaml`:

```yaml
sharing:
  rules:
    enforced: [code-review-guide]
```

A rule you wrote yourself stays. `push` writes back only the body of a rule the team already has.

Antigravity means all three here: the CLI (`agy`), Antigravity 2.0 and Antigravity IDE read the same `~/.gemini/config` and `.agents`, so one pull serves them.

Antigravity loads only rules with a `trigger`, so pull adds one. A rule with `paths:` becomes a rule the model applies when it works on those files:

```markdown
<!-- rules/api-errors.md in the team repo -->
---
paths: ["src/api/**/*.ts"]
---
Return typed errors from API handlers.

<!-- ~/.gemini/config/rules/api-errors.md after teamai pull -->
---
trigger: model_decision
description: "Applies when reading or editing files matching src/api/**/*.ts"
---

Return typed errors from API handlers.
```

A rule without `paths:` gets `trigger: always_on`.

A rule can also declare relations to other team resources in a `related:`
frontmatter block (a doc can too; a learning declares them the same way when
it is contributed):

```markdown
---
related:
  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md
  REFERENCES: [docs/payments-overview.md]
---
```

`MAPS_TO` points at a teamwiki code page, `REFERENCES` at any resource, and
`SUPERSEDES` / `CONFLICTS_WITH` at a rule, doc or learning. `teamai recall`
prints each declared relation as a `Related:` line on the hit, and each
`paths:`-glob-derived one (knowledge guide), so a session that recalls one end
of the relation starts with the other end too.
`teamai review --branch` fails a rule or doc whose `related:` block uses a
relation outside that table; a relation that points at a resource not on the
branch is a warning, not a failure.

### Rules as folders: a deterministic skill

A directory under `rules/` that holds `RULE.md` is a rule folder. `RULE.md` is the rule. The other files are support files the rule sends the agent to:

```text
rules/api-style/
├─ RULE.md
├─ RULE.zh.md
├─ checklist.md
└─ examples/good-endpoint.ts
```

```markdown
<!-- rules/api-style/RULE.md -->
---
paths: ["src/api/**"]
---
Follow the team API style. Before adding an endpoint, read
${TEAMAI_RULE_DIR}/checklist.md and ${TEAMAI_RULE_DIR}/examples/good-endpoint.ts.
```

| | Skill | Rule folder |
|---|---|---|
| Loaded by | The model, or `/skill` / `$skill` | teamai: always, or by `paths:` |
| Manual invocation | Yes | No; the rule can point at a skill and make sure it is used |
| Support files | Yes | Yes, read only when needed |
| Context cost | The description until used | The body in every session; on tools without native rules, injected whole at SessionStart |

Keep the body short and put the detail in the folder.

- The name is the path, as for a rule file: `rules/api-style/` is `api-style`, and `rules/fe/api-style/` is `fe/api-style`. Each tool gets `api-style.md` in its rules directory.
- `RULE.zh.md` or `RULE.en.md` holds the body for that `language`. The frontmatter of `RULE.md` applies to every language; pull warns about frontmatter in a variant and ignores it.
- In a workspace, pull copies the folder to `.teamai/delivered/rules/api-style/` in each worktree, which git ignores, and puts its path, with forward slashes, in place of `${TEAMAI_RULE_DIR}`. Every tool reads the folder there: Claude Code gets the absolute path, and a tool that reads nothing outside the project gets `.teamai/delivered/rules/api-style`, from the project root. A pull in one worktree leaves the other worktrees' folders as they were.
- A user-scope rule has no worktree, so pull copies it to `~/.teamai/rules/api-style/` and names that path. For Claude Code, pull adds the directory to `permissions.additionalDirectories` in `~/.claude/settings.json`, after your own entries, and uninstall takes it out. Pull warns once for each other tool that may ask before it reads there. The "Rule folder files" column of [Tool support](tool-support.md#user-scope) says which tool gets which.
- Edit a rule folder in the team repo. Push proposes nothing from its delivered copies.
- A file the team removes from the folder stays in the delivered copy until the rule goes, because a rule copy you edited may still name it. A path can't be both a file and a directory: when the team turns `details/` into a file `details`, or back, the new version takes the path and pull names the file that went.

Before you commit a rule folder, have every member upgrade. An older teamai reads each file in `rules/api-style/` as its own always-on rule (`api-style/RULE`, `api-style/RULE.zh`, `api-style/checklist`), or skips the folder.

teamai's recall rule is the folder [`rules/teamai-recall/`](https://github.com/Tencent/teamai-cli/tree/main/rules/teamai-recall). A team replaces it with its own `rules/teamai-recall/` at the root of the team repo. The folder's README lists the files and the lines each must keep. Pull refuses a replacement that drops one or holds a link, names the file, and keeps teamai's. `teamai review --branch` fails such a replacement before you merge it.

## Agents

`agents/<name>.yaml`. `name` matches the filename. Commit it, or run `teamai push` after editing the copy in a tool.

```yaml
# agents/code-reviewer.yaml
name: code-reviewer
description: Review a change before it is pushed
instructions: |
  Read the diff and comment on correctness, tests, and risks.
tools: [Read, Grep]
targets: [claude, cursor]
```

Leave `targets` out to send the agent to every installed tool. An agent for one role goes in `agents/<namespace>/`, declared under `resources.agents`.

```bash
teamai push
teamai push --role frontend
teamai remove agents code-reviewer
```

### Replace the recall agent

While [recall](knowledge.md#enabling--disabling-recall) is on, teamai installs its own `teamai-recall` agent. A team agent with that name replaces it, the way a team workflow replaces a [default workflow](workflow.md#default-workflows). Put it in `agents/` for everyone, or in `agents/<namespace>/` for one role:

```yaml
# agents/frontend/teamai-recall.yaml
name: teamai-recall
description: Search the team knowledge base for a frontend task and return doc_ids
tools: [Bash, Read, Grep, Glob]
instructions: |
  Run `teamai recall --caller teamai-recall "<task>"` and read the top three hits.
  For each component the task names, grep src/design-system/ and its Storybook stories.
  Return at most ten lines: doc_ids, file paths, and the one rule that applies.
```

Keep `--caller teamai-recall` on each `teamai recall` call, as teamai's agent does: it is how the docs the agent opens are credited to recall.

```console
# a member with the frontend role
$ teamai pull
✔ [workspace] Synced 1 agents
$ head -3 .claude/agents/teamai-recall.md
---
name: teamai-recall
description: Search the team knowledge base for a frontend task and return doc_ids

# a member with the backend role keeps teamai's
$ head -3 .claude/agents/teamai-recall.md
---
name: teamai-recall
description: >-
```

Once the team file exists, edit the copy in a tool and run `teamai push`, as for any team agent. An edit to teamai's own copy is never pushed, so the first version goes into the team repo as a commit. Delete the file, and the next `pull` puts teamai's agent back. While recall is off, pull installs neither.

`pull` writes each tool's own format into that tool's agents directory: `<name>.toml` for the Codex family, `<name>.agent.md` for Copilot, `<name>.json` for Kiro, and `<name>.md` for the rest. Trae and Trae CN load `.trae/agents` only while the Beta setting "Enable Subagents Directory" is on, and accept only their own model ids, so their copy leaves out the agent's `model`. Trae CN's user copy in `~/.trae-cn/agents` takes one an alias or `tool_extras.trae-cn` gives it. A project's `.trae/agents` is read by both editions, so it never gets a `model`, and it takes the other keys of both `tool_extras.trae` and `tool_extras.trae-cn`; an agent whose two editions give one key different values is skipped there, with a warning naming the key. `push` refuses an edit to that file that changes or removes a key the other edition gives.

Antigravity's copy keeps no team `model` (agy skips an agent whose model it does not know), only one an alias maps for agy, and lists agy's own names for the agent's tools: `tools: [Bash, Read]` becomes `run_command`, `view_file` and `read_file`. Without them an agy subagent has no shell. In a project, `.agents/agents` is agy's, so Muse Code gets no copy there while agy is installed. The CLI and Antigravity 2.0 run the agent as a subagent; Antigravity IDE has none, so its model can only hand the work to `agy --agent <name>` when the CLI is installed.

In self mode, your root copy of an agent placed in a namespace is pushed to the placed file. Changing it from `.md` to `.yaml` retires the original file, even while your checkout is behind its own merged PR. Either way, TeamAI compares the placed file with the blob your last merged push delivered there. If the team edited it since, the push stops and prints a `teamai push --carried <path>@<blob>` command. Carry that edit into your root copy, then run it. The option accepts only that version, so a plain retry or a later team edit stops the push again. An agent deleted by the team is not re-added from your root copy. An older placement record without a blob catches a team edit only while your checkout is behind it, until your first edit through it merges and records its blob.

### Model aliases

A name such as `model: strong` is mapped per tool in `models/aliases.yaml`:

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex: { model: gpt-6-sol, effort: high }
  fast:
    claude: haiku
```

An alias starts with a lowercase letter, then lowercase letters, digits, or `-`. A namespace that needs its own mapping uses `models/<ns>/aliases.yaml`.

## Env, hooks and MCP servers by namespace

The root file reaches everyone. A namespace declared under `resources:` reaches only members who have it active, and replaces the root entry of the same name.

```text
env/env.yaml              hooks/hooks.yaml              mcp/mcp.yaml
env/<ns>/env.yaml         hooks/<ns>/hooks.yaml         mcp/<ns>/mcp.yaml
```

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      env: [checkout]
      hooks: [checkout]
      mcp: [checkout]
```

## Env (environment variables)

```bash
teamai env add API_ENDPOINT https://api.example.com --description "Team API endpoint"
teamai env add API_ENDPOINT https://checkout.internal --project checkout
teamai env add GITHUB_TOKEN --secret -d "GitHub token with repo scope" --url https://github.com/settings/tokens
teamai push
```

```yaml
# env/env.yaml
variables:
  - key: API_ENDPOINT
    value: https://api.example.com
    description: Team API endpoint
```

```yaml
# env/secrets.yaml
secrets:
  - key: GITHUB_TOKEN
    description: GitHub token with repo scope
    url: https://github.com/settings/tokens
```

Secret values stay off the repo. On each machine:

```bash
teamai env set GITHUB_TOKEN
teamai env exec -- gh pr create
```

### Shell environment by directory

A shell gets the team env of the directory it starts in, so several projects open at once each get their own. `teamai pull` adds one block to your shell profile (`.zshenv` for zsh, the bash startup files for bash). An interactive shell switches env on `cd` and puts your own values back when you leave a project.

- In a project: the project's env. With `inheritUserScope: true`, the user scope's variables load too, but a key the project declares stays the project's, and user-scope secrets never load.
- In a workspace with repos set up inside it: its own env plus theirs. A key two of them set differently is held: the value installed before stays, and `pull` names it.
- In a project no pull has registered yet: nothing, until you pull there.
- Anywhere else: the user scope's env.
- Where git cannot read the repository (git missing, a broken `.git`, `safe.directory`): nothing.

`injectShellProfile: false` turns this off for that team's scope.

Limits:

- Only bash and zsh load env by directory. In fish, PowerShell, or a tool that does not start one of them, run commands through `teamai env exec --`.
- Team env cannot set names that control the shell or the loader, such as `BASH_ENV`, `HOME`, `IFS`, `PROMPT_COMMAND`, or names starting `__TEAMAI_`. Pull warns and ignores them.
- `teamai doctor` checks that a shell in this directory loads this scope's env.

## Hooks

`teamai init` installs these built-in hooks:

| Event | What it does |
|-------|----------------|
| `SessionStart` | Pull team resources and record the session start |
| `PostToolUse` | Record skill use. After a `TodoWrite` call, remind the agent to use `teamai-recall` while recall is on |
| `UserPromptSubmit` | Record the prompt |
| `Stop` | Check for a CLI update and record the session end |

On macOS and Linux, a tool call or a prompt waits for teamai only when it may have something to print: a `TodoWrite` call, which runs in full to find out whether the reminder applies (with recall off it does not, and nothing is printed), or a prompt with a hint left for it or on a machine that syncs over HTTP. Otherwise the hook starts a background process and returns, and that process records the event. `~/.teamai/debug.log` shows which happened:

```text
2026-11-09T09:14:02.118Z [DEBUG] [hook-dispatch] post-tool-use/claude fast path
2026-11-09T09:14:02.161Z [DEBUG] [hook-dispatch] post-tool-use/claude background: 16ms total, 5 handlers, slowest dashboard-report=15ms | dashboard-report=15ms(ok) local-agent-sync=13ms(ok) recall-attribution=12ms(ok) skill-use=9ms(ok) new-checkout=8ms(ok)
2026-11-09T09:14:09.530Z [DEBUG] [hook-dispatch] prompt-submit/claude fast path
2026-11-09T09:14:09.571Z [DEBUG] [hook-dispatch] prompt-submit/claude background: 13ms total, 2 handlers, slowest dashboard-report=13ms | dashboard-report=13ms(ok) skill-mention=12ms(ok)
```

In a folder outside every teamai scope, the background process stops at `[hook-dispatch] post-tool-use/claude no scope`.

```bash
teamai hooks list
teamai hooks inject --dry-run
teamai hooks inject
teamai hooks remove
```

Only tools that are already installed are touched.

Commit a team hook as a folder: `HOOK.yaml` beside the script it runs. The directory name is the hook's id: lowercase letters, digits, and `-`.

```text
hooks/block-secrets/
├─ HOOK.yaml
└─ scan.sh
```

```yaml
# hooks/block-secrets/HOOK.yaml
description: Scan for secrets before a commit
event: PreToolUse
matcher: Bash
command: bash "${TEAMAI_HOOK_DIR}/scan.sh"
timeout: 15
```

Pull copies the folder and puts its path, with forward slashes, in place of `${TEAMAI_HOOK_DIR}`. teamai adds no quotes, so quote the variable as the command needs. The directory name is the hook's id and a version taken from the folder's files, `HOOK.yaml` included (`e246f037` below), so it changes whenever a file does, and the files of a version never change. Every checkout of one commit gives the same version: a file counts as git stores it, so line endings, encoding and the executable bit on disk make no difference, and a file git ignores (such as `__pycache__/`) is neither counted nor copied. A new or edited file counts as it is on disk. Pull refuses a folder that holds a git submodule or a repository of its own, whose files are not the team repo's: commit them to the team repo instead. A tool whose configuration pull could not rewrite, or one the member excluded, keeps running the files it was written with, and that directory goes once no entry runs it:

| Where the team is | The folder lands in |
|---|---|
| User scope | `~/.teamai/hooks/block-secrets.e246f037/` |
| Workspace with a team repo | `~/.teamai/projects/<slug>/hooks/block-secrets.e246f037/`, one for every worktree, as every worktree runs the same hook entries |
| Self mode | `.teamai/delivered/hooks/block-secrets.e246f037/` in each worktree, which git ignores |

In self mode, Claude Code's command reads `"$CLAUDE_PROJECT_DIR/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"`, so `.claude/settings.json` is the same in every worktree. Editing only a script gives the folder a new version too, so pull rewrites that path in `.claude/settings.json`: a team that commits the file commits that change with it. Other tools get the worktree's absolute path, so their project file differs from one worktree to the next. Cursor's `.cursor/hooks.json`, for example:

```text
~/work/shop/.cursor/hooks.json         bash "/Users/ana/work/shop/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"
~/work/shop-hotfix/.cursor/hooks.json  bash "/Users/ana/work/shop-hotfix/.teamai/delivered/hooks/block-secrets.e246f037/scan.sh"
```

Once a worktree is removed, the next pull of another worktree, or `teamai doctor --fix`, removes the entries it left in HOME. `HOOK.yaml` takes the keys of a `hooks.yaml` entry except `id`, `roles` and `projects`. A hook for one namespace goes in `hooks/<ns>/<id>/`.

Short hooks can stay in `hooks/hooks.yaml`, as a list of the same keys with an `id`. `${TEAMAI_HOOK_DIR}` works only in a folder: in `hooks.yaml` it stops team hooks for the run, as an id that is both a `hooks.yaml` entry and a folder does. `teamai review --branch` fails a branch with either, or with a `HOOK.yaml` that does not parse. `builtin` belongs only in the root file. Use it to turn a built-in hook off, or to change its timeout.

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before a commit
    event: PreToolUse
    matcher: Bash
    command: bash ~/.teamai/team-scripts/scan-secret.sh
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]   # no TodoWrite reminder
  overrides:
    Hook dispatch stop: { timeout: 30 }
```

Every tool call runs one `PostToolUse` entry, `Hook dispatch post-tool-use wildcard`, and the `TodoWrite` reminder runs in it. On macOS and Linux, with Claude Code 2.1.119 or later, `~/.claude/settings.json` holds that key as two entries: one Claude Code does not wait for, for every tool but `TodoWrite`, and one for `TodoWrite`, so its reminder reaches the agent in the same turn. Below 2.1.119, or when the version cannot be read, the single entry starts teamai through `~/.teamai/bin/teamai`, and the login shell, which loads your profile and the team env, runs only in the background process; without that file it runs as before. The `UserPromptSubmit` entry in `~/.claude/settings.json` starts teamai the same way, at any version, and a prompt is still answered in the login shell until teamai has seen from there that this session's directory does not sync over HTTP. A `.claude/settings.json` in the repository keeps the single entry. `~/.codex/hooks.json` keeps the single entry: when every Codex build teamai finds, `codex` on PATH and the desktop app's, is 0.148.0 or later, Codex does not wait for it; otherwise it starts teamai through `~/.teamai/bin/teamai` as above, and the `UserPromptSubmit` entry there does so at any version. The hook files of `claude-internal` and `tclaude`, and of `codex-internal` and `tcodex`, take the form their original's takes below those versions, at any version. On Windows these files keep the single waited entry. After you upgrade or downgrade either tool across these versions, the next session start or `teamai pull` rewrites the entry. Disabling the key or setting its timeout applies to both. Listing `Hook dispatch post-tool-use TodoWrite` under `disabled` still turns the reminder off. A timeout for that key does nothing, and `teamai doctor` says so.

A hook for one project goes in `hooks/<ns>/hooks.yaml`.

Four hooks a team can share. A hook reads Claude Code's JSON payload on stdin.

```yaml
hooks:
  # Refuse a force push, and say what to run instead.
  - id: no-force-push
    description: Refuse git push --force
    event: PreToolUse
    matcher: Bash
    command: >-
      jq -r '.tool_input.command' | grep -Eq 'git push.* (-f|--force)( |$)'
      && { echo 'Use git push --force-with-lease' >&2; exit 2; } || true

  # Migrations that shipped are append-only.
  - id: no-migration-edits
    description: Keep shipped migrations unchanged
    event: PreToolUse
    matcher: Edit|Write
    command: >-
      jq -r '.tool_input.file_path // empty' | grep -q '/db/migrations/'
      && { echo 'Add a new migration instead: make migration name=...' >&2; exit 2; } || true

  # Tell every session about the release freeze.
  - id: release-freeze
    description: Announce the release freeze
    event: SessionStart
    command: echo 'Release freeze until Friday 18:00 UTC. Only hotfix/* branches merge to main.'

  # Format what the agent wrote.
  - id: format-on-write
    description: Run Prettier on edited files
    event: PostToolUse
    matcher: Edit|Write
    command: >-
      f=$(jq -r '.tool_input.file_path // empty');
      [ -n "$f" ] && npx --no-install prettier --write "$f" >/dev/null 2>&1; true
```

What a hook can do depends on its event. Every tool that runs the event does this much. Claude Code does more, such as refusing a prompt when a `UserPromptSubmit` hook exits 2:

| Event | Exit 2 (reason on stderr) | Stdout |
|-------|---------------------------|--------|
| `PreToolUse` | Blocks the tool call | — |
| `SessionStart`, `UserPromptSubmit` | — | Added to the agent's context |
| `PostToolUse`, `Stop` | — | — |

`teamai hooks list` shows where each team hook runs:

```text
  [no-force-push] PreToolUse [Bash]  →  jq -r '.tool_input.command' | grep -Eq 'git push.* (-f|--force)( |$)' && { echo 'Use git push --force-with-lease' >&2; exit 2; } || true  (tools: all)  from root
      runs in: claude, omp, opencode
      not in: cursor (no PreToolUse hook there)
```

OpenCode, Oh My Pi, Pi, OpenClaw, Kiro, Hermes, and Antigravity have no Claude Code hook file. Their hooks run through teamai, with Claude Code's payload and tool names (`matcher: Bash` matches OpenCode's `bash` and Hermes's `terminal`). There:

- Only `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` run. Pull warns about a team hook on any other event.
- `UserPromptSubmit` adds context but cannot block the prompt.
- Oh My Pi waits 25 seconds for a `PreToolUse` hook. A slower hook does not block the call. Hermes stops any hook after 300 seconds.
- OpenClaw and Hermes run `SessionStart` on the session's first prompt. OpenCode, Oh My Pi, and Pi build the system prompt for each request, so they run `SessionStart` again before each request after the first, so what it prints follows a change a `UserPromptSubmit` hook made (a `/ponytail lite` that sets a level shows on the next turn).
- OpenClaw loads teamai's plugin from `plugins.load.paths` in `openclaw.json`. If `plugins.allow` leaves it out, pull warns and the hooks do not run.
- teamai reads `openclaw.json` as OpenClaw does, comments included, so a workspace set there is followed. teamai writes that file only while it is plain JSON. In a commented file it adds nothing, and pull prints the line to add by hand:

  ```json5
  // ~/.openclaw/openclaw.json
  {
    agents: { defaults: { workspace: "~/work/team-ws" } }, // teamai writes AGENTS.md here
    plugins: { load: { paths: ["/Users/ana/.openclaw/teamai/teamai-team-hooks.mjs"] } }, // add by hand
  }
  ```

```yaml
sharing:
  hooks:
    autoApply: false          # pull only prints a hint; run teamai hooks inject
    requireTeamScripts: true  # command must run from its hook folder or ~/.teamai/team-scripts/
```

`requireTeamScripts` keeps a folder hook whose `command`, as written, names `${TEAMAI_HOOK_DIR}`, and any command under `~/.teamai/team-scripts/`. It drops the rest, such as `curl … | sh`. It checks where a script comes from, the reviewed team repo. It is not a sandbox: the script runs with your permissions.

Turn team hooks off on this machine with `TEAMAI_HOOKS_DISABLED=1`.

Antigravity runs them too, in the CLI, Antigravity 2.0 and Antigravity IDE alike, through teamai's own hook in `~/.gemini/config/hooks.json`. A hook gets the Claude Code payload (`tool_name: Bash`, `tool_input.command`), and exit 2 blocks the call, so one hook serves both tools:

```yaml
hooks:
  - id: block-rm-rf
    description: Block recursive deletes
    event: PreToolUse
    matcher: Bash
    command: 'grep -q "rm -rf" && { echo "rm -rf is blocked; run git clean -n first." >&2; exit 2; } || exit 0'
    tools: [claude, agy]
```

agy then refuses the command with `tool call denied by pre-tool hook: rm -rf is blocked; run git clean -n first.`

### Default hooks

teamai's own hints keep their thresholds and texts in hook folders. A folder of the same name at the root of the team repo replaces one. To remind only after longer sessions, in the team's words:

```bash
cp -r "$(npm root -g)/teamai-cli/hooks/teamai-friction-reminder" hooks/
```

```yaml
# hooks/teamai-friction-reminder/HOOK.yaml
description: Remind after longer sessions only
with:
  min_tools: 30
```

```markdown
<!-- hooks/teamai-friction-reminder/problem.md -->
[acme] This session hit a snag. If the fix is not in the runbook yet, write it down.
```

After `teamai pull`, the reminder waits for 30 tool calls and opens with that line.

| Folder | What it holds |
|---|---|
| `teamai-friction-reminder` | The Stop reminder to share what a session taught: thresholds, score weights, texts |
| `teamai-mr-hint` | The offer, looked for at session start, to import recently merged MRs: how far back, how many, texts |
| `teamai-todowrite-hint` | The suggestion to search team knowledge once a task is planned |
| `teamai-env-hint` | The session-start note naming the scope's team env variables and secrets |
| `teamai-package-hint` | The session-start note that the team's package declarations changed |

- `HOOK.yaml` holds `description` and `with:`. A key left out of `with:` keeps teamai's value.
- A text is `<text>.md`, with `{{ name }}` variables. With `language: en` or `zh`, `<text>.en.md` or `<text>.zh.md` is used when the folder has it.
- Each folder's `README.md` lists its parameters with their ranges, the variables each text offers, and the settings that turn it off. Those settings stay where they were, such as `sharing.contributeHint.enabled`.

Pull refuses a replacement that sets a value out of range or a key the default does not take, reads a variable a text does not offer, leaves a text out, or has a `command`, and keeps teamai's folder in force:

```text
hooks/teamai-friction-reminder/ is refused, and teamai's default stays in force until it is fixed: HOOK.yaml: with.min_tools must be a whole number from 1 to 1000
```

A replacement replaces for the whole team, so pull refuses one in a namespace, such as `hooks/payments/teamai-friction-reminder/`. `teamai review --branch` fails a replacement pull refuses before you merge it.

## MCP servers

Commit a server the team writes as a folder: `MCP.yaml` beside the files it runs. The directory name is the server's name: letters, digits, `-` and `_`.

```text
mcp/jira-lite/
├─ MCP.yaml
├─ server.py
└─ queries.sql
```

```yaml
# mcp/jira-lite/MCP.yaml
description: Read-only Jira lookups for the team
transport: stdio
command: uv
args: ["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]
requires: [uv]
```

```python
# mcp/jira-lite/server.py
# /// script
# dependencies = ["mcp==1.2.0", "httpx==0.27.2"]
# ///
```

Pull copies the folder and puts its path, with forward slashes, in place of `${TEAMAI_MCP_DIR}` in `command`, `args` and `env`. teamai adds no quotes. The directory name is the server's name and a version taken from the folder's files, `MCP.yaml` included (`1702782c` below), so it changes whenever a file does, and the files of a version never change. Every checkout of one commit gives the same version, as for hooks. A tool whose MCP file pull could not rewrite, or one the member excluded, keeps starting the files it was written with, even when a team value its `args` take changes, and that directory goes once no MCP file names it:

| Where the team is | The folder lands in |
|---|---|
| User scope | `~/.teamai/mcp/jira-lite.1702782c/` |
| Workspace, with a team repo or in self mode | `.teamai/delivered/mcp/jira-lite.1702782c/` in each worktree, which git ignores |

Claude Code does not expand `$CLAUDE_PROJECT_DIR` in `.mcp.json`, so each tool's MCP file holds the worktree's absolute path and differs from one worktree to the next. A pull in one worktree leaves the servers of the others as they were.

`MCP.yaml` takes the keys of an `mcp.yaml` server except `name`, `roles` and `projects`, with `transport: stdio` only: a URL server carries no files, so `http` and `sse` servers stay in `mcp.yaml`. A server for one namespace goes in `mcp/<ns>/<name>/`. `${TEAMAI_MCP_DIR}` works only in a folder. In `mcp.yaml` it stops team MCP for the run and keeps what is installed, as a name that is both an `mcp.yaml` server and a folder does. `teamai review --branch` fails a branch with either, or with an `MCP.yaml` pull cannot read.

teamai installs no dependencies. A folder ships them one of three ways:

| Pattern | `command` and `args` | The folder holds |
|---|---|---|
| PEP 723 script | `uv`, `["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]` | `server.py`, its pinned dependencies in its header |
| One bundled `.mjs` | `node`, `["${TEAMAI_MCP_DIR}/server.mjs"]` | `server.mjs`, built with its dependencies inside |
| A pinned runner | `npx`, `["-y", "@acme/jira-mcp@1.4.0", "--config", "${TEAMAI_MCP_DIR}/config.json"]`, or `uvx` with `jira-mcp==1.4.0` | configuration and data files only |

`requires` names the runners a member needs on PATH. A member who lacks one does not get the server, and `teamai mcp inject` names the missing runner. With `sharing.mcp.allowedCommands` set, list the runner there, since it is the server's `command`:

```yaml
# teamai.yaml
sharing:
  mcp:
    allowedCommands: [uv, node, npx]
```

Upgrade every member before you commit a server folder. A teamai that cannot read MCP folders skips them, so its members do not get the server.

Servers that run a published package or a URL can stay in `mcp/mcp.yaml`. Muse may save stdio servers without `type`. Pull and removal compare that form without rewriting personal servers or unchanged managed entries when another server changes.

```yaml
# mcp/mcp.yaml
servers:
  - name: gpu-analysis
    description: GPU inventory and pricing
    transport: http
    url: https://example.com/api/mcp
    headers:
      Authorization: Bearer ${GPU_ANALYSIS_TOKEN}
    timeout: 600000
  - name: local-formatter
    transport: stdio
    command: npx
    args: ["-y", "@acme/formatter-mcp"]
    env:
      FORMATTER_MODE: strict
    requires: [npx]
    tools: [claude, cursor]
```

Write secrets as `${VAR}` and declare the key in `env/secrets.yaml`. A server for one project goes in `mcp/<ns>/mcp.yaml`.

OpenCode's `opencode.json`, Cursor's `mcp.json` and `hooks.json`, CodeBuddy's settings and MCP files, Qoder's `settings.json` and Pi's `models.json` may hold comments, since those tools read them so. teamai reads them the same way and edits only its own entries: your lines and comments stay as you wrote them. Here is `~/.config/opencode/opencode.json` after a pull of the `local-formatter` server above:

```jsonc
{
  "mcp": {
    "notes": { "type": "local", "command": ["notes-mcp"], "enabled": false }, // off until the API key arrives
    "local-formatter": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@acme/formatter-mcp"
      ],
      "enabled": true
    },
  },
}
```

When the team drops `local-formatter`, the next pull takes its lines out and leaves `notes` and its comment as they are. Claude Code, Codex, Muse and the other tools reject a commented file, so teamai does too: pull warns that the file does not parse and changes nothing in it.

For stdio servers, `env` keys stay literal in Codex's TOML: `HTTP.PROXY` is one variable, and names such as `ProgramFiles(x86)` are quoted automatically.

Codex MCP table headers can use bare, single-quoted or double-quoted `mcp_servers` keys, including on sub-tables. Quoting does not change which server teamai updates or protects as the member's own.

ZCode servers use `mcp.servers` in `~/.zcode/cli/config.json` or the project's `.zcode/config.json`. This follows the 3.16.2 source; 3.15.1 is not certified. Pull moves only unchanged teamai entries out of `~/.agents/mcp.json`. Doctor names other servers there because the desktop app stops reading that fallback once the native config has servers.

Antigravity takes user servers in `~/.gemini/config/mcp_config.json`. It reads a project's servers only from a plugin, so teamai writes them as one:

```text
.agents/plugins/teamai/plugin.json       {"name": "teamai"}
.agents/plugins/teamai/mcp_config.json   {"mcpServers": {"github": {"url": "https://api.githubcopilot.com/mcp/", "headers": {...}}}}
```

agy takes stdio and HTTP servers, with no `type`; pull skips an `sse` server for agy with a warning. `agy mcp list` shows only the user file's servers; a plugin's appear in a session.

WorkBuddy uses the first existing user file in `.mcp.json` and `mcp.json` under its live root (`.workbuddy/` or `.workbuddy-ai/`, see below), then `~/.codebuddy.json`. `CODEBUDDY_CONFIG_DIR` moves the last file. A project uses `.mcp.json`, or `mcp.json` when only that exists. With `sharing.gitExclude` on, its servers use `projects[<project path>].mcpServers` in `.codebuddy.json`. These paths follow the CodeBuddy 2.168.0 engine; WorkBuddy's launcher binding is not certified. Pull removes only unchanged teamai entries from the former `.workbuddy/mcp.json` project file.

WorkBuddy's user files go to the data root of whichever app launched last — `.workbuddy/`, or `.workbuddy-ai/` for WorkBuddy AI, the international edition — read from each root's `last-launch.json`: skills, rules, team instructions, agents and the MCP file. Presence decides nothing on its own, because uninstalling either app leaves its root behind; with no record on either side the old rule holds, where a present `.workbuddy-ai/` moves the paths. Project scope moves skills only, a team's `userScope` override keeps the destination it names, `settings.json` and hooks stay in `.workbuddy/`, and `teamai doctor` takes the live root as the install proof.

When a tool's home or configured MCP path moves, pull leaves old copies in place and names them once. Remove them after no tool reads them. Doctor reports unread mappings, moved files, and project MCP that is read only from a session started at the project root. Internal builds with an unknown MCP channel get a note instead of a guessed config.

In a workspace with repos set up inside it, Claude Code, CodeBuddy, and WorkBuddy get the servers through their local scope, not the project's MCP file, so a session in one of those repos does not load them. In self mode, or while tclaude or Muse Code reads that file, Claude Code's servers stay in it, and such a session does load them.

```bash
teamai mcp list
teamai mcp inject
teamai mcp remove
```

`mcp inject` and `mcp remove` exit with code 1 when a tool's config cannot be read or parsed, including with `--dry-run`. This includes invalid TOML in Codex's `config.toml`; a leading UTF-8 BOM is accepted. Other tools may still be updated; the command lists those changes and reports that the operation is incomplete. Fix the config named in the warning, then rerun the command. The unreadable config and its ownership records are kept for the retry. `uninstall` also preserves the records and exits 1 until the config is repaired.

Muse reordering JSON object keys does not make a managed server a personal edit. Removal compares its recorded content, including nested objects, while preserving real command, argument or environment changes. Older records without that content fingerprint need a matching original definition in team Git history; if that proof is unavailable, removal keeps the server and warns.

## Models

Commit `models/models.yaml` yourself. The key stays on each machine. A catalog for one project goes in `models/<ns>/models.yaml`.

```yaml
profiles:
  - id: tokenhub
    name: Tencent TokenHub
    base_url: https://tokenhub.tencentmaas.com
    api_key: ${API_KEY}
    model_groups:
      - protocols: [anthropic, openai-chat-completions]
        models:
          - glm-5.3
          - deepseek-v4-flash
```

```bash
teamai models switch tokenhub
```

## Propose a file from a workflow step

A step with `workspace: { team: { branch } }` runs in a fresh clone of the team repo, and `deliver: pr` proposes what it changed there as one pull request. This workflow proposes one scorer file, byte for byte:

```yaml
schemaVersion: v1alpha1
name: propose-scorer
description: Propose one scorer file to the team as a pull request, on a branch of its own.
inputs: { file: string, name: string }
steps:
  - id: propose
    workspace: { team: { branch: "teamai/scorers/{{ inputs.name }}" } }
    deliver: pr
    command: mkdir -p scorers && cp "$FILE" "scorers/$NAME.md"
    env: { FILE: "{{ inputs.file }}", NAME: "{{ inputs.name }}" }
```

```text
teamai workflow start propose-scorer --driver local --inputs '{"file":"/tmp/review.md","name":"review"}'
  first run                        opens "propose-scorer: scorers/review.md" from teamai/scorers/review
  /tmp/review.md edited, run again updates that pull request
  bytes main already has           pushes nothing and opens no pull request
  name "../review"                 fails before any clone: git cannot name the branch
```

The commit must be one `teamai pull` would take; [The team workspace](workflow.md#the-team-workspace) lists what is refused. [teamai-session-to-task](benchmarks.md#turn-a-session-into-a-task) proposes the task file it drafts this way.

## Packages

```bash
teamai packages install typescript
teamai packages install code-review@claude-plugins-official
teamai push
```

```yaml
packages:
  npm:
    - name: typescript
      version: "*"
  claude:
    marketplaces:
      - name: claude-plugins-official
        repo: anthropics/claude-plugins-official
    plugins:
      - name: code-review@claude-plugins-official
```

After pull, run `teamai packages`.

## Sessions

Unattended runs now publish their sessions by default. In CI, on a cloud VM or in a hosted job, [`teamai score --drain`](scorers.md#drain-before-an-unattended-job-ends) archives, through a `teamai-finished-sessions` run, the sessions this machine captured as unattended, and the step sessions of the workflow runs driven here, scrubbed, on `teamai-reports`. The local driver runs it at the end of an unattended run. To keep the old behavior, set `unattended: off`:

```yaml
# teamai.yaml
sessions: { publish: { unattended: off } }
```

`sessions.publish` takes `off`, `ask` or `auto` for each run mode. These are the defaults, written out:

```yaml
# teamai.yaml
sessions:
  publish: { attended: ask, unattended: auto }
```

Attended `ask` proposes publishing when the friction reminder offers [`teamai-share-learnings`](workflow.md#teamai-share-learnings-and-teamai-share-session), and the person confirms it once, at the start. An agent that starts the run with `--confirmed` can confirm it for them, and teamai cannot check that they did. Otherwise a person's sessions are archived only by a command such as `teamai session push`. Unattended `ask` acts as `off`, since nobody is there to confirm. Attended `auto` archives a session once nothing has happened in it for six hours, in the [`teamai-finished-sessions`](scorers.md#teamai-finished-sessions) run a session start begins, which also judges finished sessions. A session pushed by hand before it finished is archived again once something happened in it after that push. Publishing always scrubs, which also rewrites local paths ([what a scrubbed session keeps](dashboard.md#what-a-scrubbed-session-keeps)). An HTTP team keeps no session archive, so there `sessions.publish` acts as `off`, and `teamai doctor` says so.

A member's `config.yaml` wins, one mode at a time. A mode it does not name falls through to `teamai.yaml`:

```yaml
# config.yaml
sessions:
  publish: { attended: ask }   # attended only; unattended still follows the team
```

`teamai doctor` reports a value that is not `off`, `ask` or `auto`, with its file and key, and teamai ignores it, so that mode falls to the next level. `teamai review --branch` fails a branch whose `teamai.yaml` has such a value. [Finished sessions](scorers.md#finished-sessions) covers `sessions` in `scorers/scoring.yaml`, which decides whether sessions are judged.

## Docs

Put files in the team repo's `docs/`. Members receive them on `pull`. To limit a directory, declare it under `resources.docs`:

```yaml
# manifest/projects.yaml
projects:
  - id: checkout
    resources:
      docs: [checkout]
```

In self mode, pushing an edited skill from a checkout behind the default branch stops with exit 2 if it would overwrite an upstream file. The check covers the whole skill directory, including references and deletions, even when your edit is in another file. Merge the default branch, reconcile the skill, and retry; a copy that already contains the upstream changes can be pushed.

If the team recreates a retired agent at its old namespace, edit that namespace source directly; the old flattened copy remains a backup. Deleting the retired root copy does not make its remaining tool copies new agents. Editing or converting a placed agent also checks the last delivered blob after the checkout has caught up with the default branch.

## Reserved folder names

A directory that holds its type's marker, at any depth, is a folder: one resource, and every file in it is that resource's. A skill is the same, `skills/<name>/SKILL.md`.

| Directory | Marker | This release |
|---|---|---|
| `workflows/` | `WORKFLOW.yaml` | Reads it: [workflow folders](workflow.md#workflow-folders) |
| `hooks/` | `HOOK.yaml` | Reads it: [hooks](#hooks) |
| `rules/` | `RULE.md` | Reads it: [rules as folders](#rules-as-folders-a-deterministic-skill) |
| `mcp/` | `MCP.yaml` | Reads it: [MCP servers](#mcp-servers) |
| `benchmarks/` | `SUITE.yaml` | Reads it: [suites](benchmarks.md#write-a-suite) |
| `scorers/` | `SCORER.md` | Skips it |
| `agents/` | `AGENT.md` | Skips it |

A scorer or agent folder is skipped whole, and the rest of the team repo pulls as usual:

```text
agents/
├── code-reviewer.yaml          delivered: agent "code-reviewer"
└── reviewer/
    ├── AGENT.md                skipped: agents/reviewer/ is an agent folder
    └── checklist.md            skipped
scorers/
└── strict/
    └── SCORER.md               skipped: scorers/strict/ is a scorer folder
rules/
├── style.md                    delivered: rule "style"
└── api-style/
    ├── RULE.md                 delivered: rule "api-style"
    └── checklist.md            delivered with the folder
```

Pull says so once per folder. A pull a hook starts writes the same lines to `~/.teamai/debug.log`:

```console
$ teamai pull
⚠ agents/reviewer/ is an agent folder, which this teamai cannot read yet; it was skipped. Run teamai update.
⚠ scorers/strict/ is a scorer folder, which this teamai cannot read yet; it was skipped. Run teamai update.
✔ [user] Synced 2 rule(s)
```

`teamai status`, `teamai doctor`, `teamai review --branch` and the dashboard list the same folders. Push leaves them alone, and the team declares nothing.

The name must match exactly. `rules/lint/rule.md` is still the rule `lint/rule`, on macOS and Windows too.

A repo that already has a marker name, such as `rules/onboarding/RULE.md`, got it as the rule `onboarding/RULE`. From this release `rules/onboarding/` is one rule folder, `onboarding`, and its other `.md` files are its files. Pull removes the copies it delivered of them and says so once:

```console
⚠ rules/onboarding/ holds RULE.md, so it is one folder, and db.md in it is one of its files, no longer read on its own.
```

To keep them separate rules, rename the marker:

```bash
git mv rules/onboarding/RULE.md rules/onboarding/overview.md
git commit -m "rules: rename onboarding/RULE.md, a reserved folder marker"
```

Before a team commits a folder, every member should upgrade. A release that cannot read a type skips its folders, and one older than these names reads each file in `rules/api-style/` as its own always-on rule.
