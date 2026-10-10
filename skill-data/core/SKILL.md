---
name: core
description: >-
  TeamAI daily workflow: route a /teamai request, sync with pull and push, inspect status,
  diagnose with doctor, and reach the specialized workflows. Loaded by the teamai discovery stub.
---

# teamai — daily workflow

You are guiding a user through TeamAI. **They may not know Git.** You run the
commands; they only make choices when you ask. Follow the steps literally —
do not skip, reorder, or invent commands.

## Start here

Look at what the user typed after `/teamai`.

**If they gave NO scenario right after a TeamAI friction reminder** (the
`[teamai]` line that suggests `/teamai share what this session taught me`),
that reminder is the scenario: load `teamai skill get share` and follow it.

**If they gave NO scenario otherwise** (bare `/teamai`, or only greetings/no task):
print the menu below **exactly**, then **STOP and wait**. Take no other action —
do not run any command, do not load another skill yet.

```
teamai — Team AI Skills & Rules Sync

Usage examples (copy one to get started):

  🏗️  Admin — set up a new team repo:
      /teamai Help me set up TeamAI for my team from scratch

  🤝  Member — join an existing team:
      /teamai Help me join my team's TeamAI, repo URL is https://...

  🔧  Admin — daily management (publish & update skills, rules, MCP, env):
      /teamai I already have TeamAI set up, help me manage it

  📊  Anyone — open the team dashboard:
      /teamai Open the TeamAI dashboard

  💡  Member — share a skill with the team (just ask in plain language):
      /teamai Share this <skill-name> skill with my team

  🗑️  Anyone — remove TeamAI from this machine:
      /teamai Uninstall TeamAI
```

**If they DID describe a scenario**, match it to one row and follow what it loads.

| The user wants to…                                                    | Load this                                      |
|-----------------------------------------------------------------------|------------------------------------------------|
| Set up a team from scratch, join a team, manage one, or uninstall      | `teamai skill get setup`                       |
| Publish a skill, rule or doc they already have                         | `{SKILL_DIR}/references/contribute-member.md`  |
| Share what this session taught them                                    | `teamai skill get share`                       |
| Understand a large multi-repo codebase, build an architecture wiki     | `teamai skill get wiki`                        |
| Sync now, see differences, diagnose                                    | `teamai pull` · `teamai status` · `teamai doctor` |
| Open the team dashboard                                                | `teamai dashboard` — it starts a local server (default port 3721); give the user the URL |
| Something broke                                                        | `{SKILL_DIR}/references/troubleshooting.md`    |

If the request is ambiguous (e.g. "help me with teamai" with no direction),
ask ONE short question to pick a row, then proceed.

Sharing a session's learnings needs no menu choice: TeamAI prompts on its own at
the end of a session that produced something worth sharing, and that prompt means
`teamai skill get share`. (Only when recall is on; it is off by default. The team turns it on with
`sharing.recall.enabled: true` in `teamai.yaml`, a member with `teamai recall enable`;
while it is off, or while the teamai config cannot be loaded, `teamai skill get share`
says so and why.)

## Global rules

1. **Reply in the user's language — including every example and hand-off blurb.**
   Answer in whatever language the user used, for the whole conversation. This
   applies to **everything you write**: the invite line you give an admin to
   forward, the one-line explanations, the "what's next" summary — all of it is
   translated before you show it. *Only* commands, flags, URLs, file paths and
   code identifiers stay verbatim (never translate `teamai pull`, `--scope user`,
   `/teamai`, a repo URL).
2. **Never teach Git.** Do not mention branches, commits, clone, or push/pull of
   Git itself. TeamAI hides all of that. The user thinks in terms of "my team's
   skills", not repositories.
3. **You run the commands.** Only pause to ask the user when you need a web login,
   a value only they know, or a genuine either/or choice. Show each command before
   you run it, in one short line.
4. **Detect the current AI tool first.** TeamAI behaves differently per host. Note
   which tool this conversation is running in (Claude Code, Cursor, CodeBuddy,
   WorkBuddy, ChatGPT App, Codex, OpenCode, Kiro, Gemini CLI, …). When you reopen a
   session, use the name of **this** tool — do not assume Claude Code or Cursor.
   Some hosts need extra manual steps for hooks — see the troubleshooting
   reference ("Agent-specific caveats").
5. **Team env: run the CLI through `teamai env exec`; the user types secret values.**
   When the team delivers env variables or secrets (the session-start context
   lists them; `teamai env list` shows them), run the CLIs that use them through
   `teamai env exec -- <command>`, `--` first, so they get this directory's team
   values: the shell you run commands in may carry another project's. It is for
   CLIs, not for starting an agent: a secret named like a model profile's
   (`ANTHROPIC_*`) overrides it.
   When a secret is missing, ask the user to run `teamai env set KEY` in their
   own terminal. Never ask for a value in chat, pass one to `--stdin` or
   `--secret`, read the files under `~/.teamai/secrets/`, or print one
   (`teamai env exec -- env` and `printenv` do). Declaring a secret with
   `teamai env add KEY --secret` takes no value, so you can run it.

## Daily commands

```bash
teamai pull        # Sync team resources into local AI tools now
teamai push        # Publish your local skills/rules/docs to the team
teamai status      # Show local vs team differences
teamai doctor      # Diagnose configuration and hook problems
teamai list        # List resources (skills|rules|docs|env|agents|hooks|mcp)
teamai recall <q>  # Search what the team has already learned
teamai env exec -- <cmd>  # Run a CLI with this directory's team env and secrets
```

Every other command, every flag, and the flags `--help` hides live in the
generated reference below. Read it instead of guessing a flag.

`teamai pull` mirrors the non-hidden docs you receive into `sharing.docs.localDir`,
removing teamai's copies of documents the team removed; the user's own files there
stay, and an edited doc of a docs namespace you left is kept and named. Preview
with `--dry-run`.

`teamai pull` keeps a skill, rule or agent copy the user changed since teamai
delivered it, `--force` included, and names it (`Kept <path>: ...`). To share
the change, `teamai push`; when pull says the version teamai would deploy has
changed since, or push says so for that copy, merge that change into the copy first, or the push replaces it. To take the team version instead, delete
the copy and run `teamai pull --force`. A skill, rule, agent or docs-mirror
file that teamai has no record of (first pull after upgrading, a new or restored
checkout, the user's own) is teamai's only if it holds a team version from the team repo's
history (a skill: every file in it); any other is kept as the user's
(`Kept <path>: it is not teamai's ...`): rename or delete it, then `teamai pull`,
to receive the team version.

In project scope, `init` and `pull` also install a git hook in the repository's
local git config (`hook.teamai-post-checkout`, `hook.teamai-post-merge`, `hook.teamai-post-rewrite`; Git
2.54+; older Git without `core.hooksPath` gets a marked block in `.git/hooks/`
scripts, and with it `teamai doctor` advises), beside any `core.hooksPath` manager or `.git/hooks` script. When a
worktree is created by `git worktree add` or an app that runs checkout hooks, it creates the project roots
of `enabledAgents` (else the ones the main checkout has) and pulls into it before
the command returns, from the team clone as last fetched when that was within
24 h; a full pull then runs in the background. A branch switch does nothing.
After `git pull` (merge or a completed rebase) it fetches the team repo (5 s cap, then the background pull) and
delivers; in single-repo mode it delivers what `git pull` brought, offline. It prints nothing and always
exits 0; a failure inside it is recorded, and `teamai doctor` names it (`Last git
hook run failed: ...`) with its fix, as does the next interactive `teamai pull`, once.
`teamai doctor` also reports whether the hooks are installed and enabled, with a
reactivation command when Git disables a hook or event. Pull preserves explicit
disablement. A conflicting rebase syncs only on completion; commit amend does not sync.
`pull --dry-run` says when it would install or update the hook, writing nothing;
`teamai uninstall` removes only teamai's hook entries and blocks. For hosts that
skip checkout hooks, prepare the worktree before launch; see the new-worktree
section in `references/troubleshooting.md`.

A team agent (`agents/<name>.yaml`) can set `model: strong`, `model: fast`, or an
alias the team defines, instead of one tool's model. The team maps each alias per
tool in `models/aliases.yaml`, in that tool's own model value, with an optional effort:

```yaml
aliases:
  strong:
    claude: { model: opus, effort: high }
    codex:  { model: gpt-6-sol, effort: high }
```

`teamai pull` writes the mapped model into each tool's agent file, with the effort
in that tool's own field: `effort` for the Claude family, CodeBuddy, Qoder and Qoder CN,
`model_reasoning_effort` for the Codex family, `variant` for OpenCode. Cursor takes
effort inside its model string (`claude-opus-5[effort=high]`); Copilot, Kiro, WorkBuddy,
JoyCode, ZCode and OMP take none, and pull warns and drops an effort mapped for them.
Qoder CN uses the `qoder` entry; only the Claude and Codex variants and Qoder CN inherit
an entry, so never expect a `claude` model in Qoder or ZCode. A tool the alias does
not map gets no `model` and uses its default; a concrete model such as `opus` is
written as is; `tool_extras.<tool>.model` pins one tool and skips the alias. Suggest
YAML agents: a legacy `agents/<name>.md` is copied as is, so its alias is not resolved.
Before a team adds its first alias, every member updates teamai: an older CLI writes
`model: strong` literally, and its push can replace the alias with a concrete model.

A member overrides an entry on their machine in `~/.teamai/models/aliases.yaml`
(same `aliases:` shape). For one tool it replaces the team's whole entry, effort
included, and `~` or `default` gives that tool no model and no effort. Order per
tool: extras model, local entry, team entry, no model. Keys must be `strong`, `fast`
or a team alias; other names do nothing. One file serves every scope and every team
with that alias name. An ordinary `teamai pull` applies an edit. In the team file,
`default` is a literal model value and `~` is an error.

A role or project redefines an alias in `models/<ns>/aliases.yaml`, read where `<ns>`
is in `resources.models`, like `models/<ns>/models.yaml`. The namespace alias replaces
the root alias whole (a tool it does not map gets no `model`); the same alias in two
active namespaces holds alias agents, as a structural error does. A name defined in any
aliases file of the team repo, active or not, is an alias: with no active definition it
gives no `model`, and pull warns once per such alias. `teamai doctor` notes an agent's
alias defined in an inactive namespace; to use it, add `models: [<ns>]` to the role's or
project's resources, or rename the alias if it was meant as a concrete model id.

A structural error in any aliases file, active or not (bad YAML, a wrong type, a bad alias
name, an effort without a model, `~` in a team file, keys but no top-level `aliases:`)
holds every agent with a `model`; one
in the local file holds only agents whose `model` is an alias. Pull keeps
their copies and push skips them until the file its warning names is fixed; then an
ordinary `teamai pull` delivers them. An unknown
tool key, an unknown option field, or an alias named like `opus` or `inherit` is only
dropped, with a warning when an agent uses that alias; `gateways` is ignored.

On a tool switched with `teamai models switch`, alias agents get no effort (not even a
`tool_extras.<tool>` one, unless the extras also pin a `model`), and
Claude keeps only `opus`, `sonnet` or `haiku` (the switch routes those to the gateway)
while Codex, OpenCode, CodeBuddy and WorkBuddy get no `model`. No `model` means the
tool's native inheritance (for Codex, `[agents].default_subagent_model` or the parent's
model), not the profile's model. Variants such as tclaude are never switched. An ordinary
`teamai pull` after `models switch` or `models restore` rewrites the affected agents.

On push, an alias agent's model and alias effort are never read as edits: a copy that
matches the last pull or the current mapping is unedited, and a hand-edited model or
effort is reported as drift and not pushed (other edits still push), with where to change
it: the member's override file, the team aliases file the alias comes from, or `teamai models
restore --agent <tool>` for a switched tool. Writing an alias name in a deployed copy (`model: fast`)
and pushing proposes `model: <alias>`, except in a tool whose `tool_extras.<tool>.model` pins it,
where a changed value is drift on that pin. Never tell a user to push a concrete model over an alias.

To answer "why does this tool run this model", run `teamai doctor`. Each alias agent gets
a note with one line per tool: the model and effort it receives, then `[step: source]`.
`extras` = `tool_extras.<tool>.model`; `switched` = the tool runs a model profile;
`local` = the member's override (`tool default (chosen in <path>)` is their `~`/`default`);
`team` = the team file named; `default` = no model field (alias unmapped for that tool, or
no active file defines it). A Codex line with no effort means the session's effort carries
over. A line naming what "the last pull deployed" is fixed by an ordinary `teamai pull`.
The failing check `Agent model aliases can be resolved` names why agents are held (broken
aliases file, namespace conflict, unreadable switched-tool settings) and which file to fix.

## References

In the files below, `{SKILL_DIR}` is the directory `teamai skill path core` prints; a reference file you open on its own writes that directory as `SKILL_DIR` in braces.

| File | When to load it |
|---|---|
| `{SKILL_DIR}/references/commands.md` | Before using any command not in the daily list, or any flag. Generated from the CLI's own command table, so it cannot drift. |
| `{SKILL_DIR}/references/troubleshooting.md` | A command fails, a hook does not fire, a host needs manual steps, or a recalled doc got no upvote. |
| `{SKILL_DIR}/references/contribute-member.md` | A member wants to publish a skill, rule or doc they already have. Any member can, not just admins. |

`teamai skill get core --full` prints this skill with all three references
appended. Load a single file above when you only need one.
