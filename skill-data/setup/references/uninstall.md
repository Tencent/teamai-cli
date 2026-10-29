# Scenario: Uninstall — remove TeamAI from this machine

The user wants to remove TeamAI. **You run the command for them** — they should not
have to type `teamai uninstall` themselves. Everything you say goes in the user's
language (global rule 1); only the commands stay verbatim.

## Step 1 — Confirm scope first (ASK — this is destructive)

Uninstalling removes hooks and synced resources from the machine and cannot be
undone with a single button, so confirm before running anything. Ask ONE question:

*"Do you want to remove TeamAI from **just this AI tool**, or from the **whole
machine** (all tools)?"*

- **Just this tool** → `--agent <tool>` (use the tool this conversation runs in,
  e.g. `claude`). Shared resources are removed only if it is the last tool using
  them. An instructions file several tools read (CodeBuddy and WorkBuddy share
  `.codebuddy/rules/teamai-context.md`) is cleaned block by block: a teamai
  block stays while a remaining tool on that file still writes it, so
  `--agent workbuddy` keeps that file while CodeBuddy is installed. The team
  rules in a project's `.codebuddy/rules` are shared the same way. A file an
  earlier release wrote the blocks to, such as the project `AGENTS.md`, loses
  its teamai blocks, since no tool reads them there now. A file teamai created
  goes with its last block; one the user had before stays, even if empty.
- **Whole machine** → no `--agent` flag. Run outside a project, it removes the
  user scope but keeps the data of each project still set up, and names them
  (`Kept the data of N project(s) still set up on this machine: ...`). Each of
  those needs `teamai uninstall` run in it; after the last one, one more
  `teamai uninstall` outside any project removes what is left in `~/.teamai`.

Reassure them (in their language): *"This only removes things from your computer.
Your team's repo on the website is untouched — you can rejoin any time with
`/teamai` and the repo URL."*

## Step 2 — Run it (you run it)

A targeted project exclusion needs the same confirmation even when there are no local files to remove. `--dry-run` and declining confirmation leave the project config unchanged.

Whole machine:

```bash
teamai uninstall
```

Just the current tool (example for Claude Code):

```bash
teamai uninstall --agent claude
```

`teamai uninstall` asks for a confirmation of its own. Let the user answer that
prompt. Only add `--force` (skips the prompt) if the user has already clearly told
you to go ahead without further confirmation:

```bash
teamai uninstall --force
```

## Step 3 — Report the result in the user's language

Tell them what was removed and remind them, in one line, how to come back:
*"Done — TeamAI has been removed from this machine. To rejoin later, run `/teamai`
and give it your team repo URL."*

## Notes

- If no valid configuration is found and TeamAI reports "home directory only," uninstall removes `~/.teamai` but keeps each project still set up (or registered in `~/.teamai/env-scopes`) and the shared files it reads, as a user-scope uninstall does.
- Project uninstall keeps the shared Claude/Codex team hooks in the main checkout
  while another checkout uses them. A targeted uninstall releases only the selected
  tool. Checkouts that exclude a tool do not retain its shared hook. Bare-repository
  worktrees remove their own hook files independently. When the main checkout has
  no install, the shared manifest and its empty `.teamai` directory are removed
  after the last team hook is removed.
- A migrated data partition is one installation shared by its checkouts. Full
  uninstall removes every checkout's shared hooks and registrations, then the
  partition. Targeted uninstall (`--agent`) removes only that tool's hooks and
  registration the current checkout uses, and keeps the other tools; when it is
  the last tool it removes the partition, so every checkout's hooks go too.
  Inherited submodule clones keep separate checkout ownership within that partition;
  full uninstall removes their recorded hooks too, preserving versioned parent hooks.
- For OpenCode, uninstall also removes the rules globs teamai added to
  `instructions` in `opencode.json`, including the relative `rules/*.md` an
  earlier release wrote in user scope. In a project it removes
  `.opencode/rules/**/*.md` from `.opencode/opencode.json` and the
  `.opencode/rules/*.md` an earlier release wrote to the root `opencode.json`,
  and deletes `.opencode/opencode.json` when nothing else is left in it.
  The user's own entries stay.
- Uninstall removes the team-rules block from the file a tool with no rules
  format reads in user scope (`~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`,
  `$DSH_HOME/AGENTS.md`, the OpenClaw workspace `AGENTS.md`,
  `~/.pi/agent/AGENTS.override.md` when present, otherwise `~/.pi/agent/AGENTS.md`, `~/.joycode/rules.txt`, `~/.config/muse/AGENTS.md`), and the file when teamai
  created it for the block alone.
- Uninstall cleans legacy Codex rule copies at the recorded `toolRoots`
  location, including publishers' bare local filenames, and the copies earlier
  releases left in a project's `.workbuddy/rules` and `.pi/rules`, in
  `.openclaw/rules`, `~/.pi/agent/rules` and `~/.joycode/rules`. It keeps
  edited copies and names them.
  For a rule the team has
  removed, it deletes the copy only if its hash matches the recorded delivery.
  Without that record, it keeps the copy and names it in a warning. Save any
  changes you need, then delete the copy manually.
- A skill directory, rule or agent at a team resource's name goes only when it
  is teamai's (on the delivery record, or a team version by the history). The
  user's own file or skill of that name stays, and uninstall names it in a
  warning.
- A copy git tracks is never deleted: uninstall names it and lists it in its
  summary under `Kept (tracked)`. If the repository no longer needs it, have
  the user run `git rm -r <path>` and commit.
- If the output kept the data of projects still set up, list them and say that
  TeamAI stays in those projects until `teamai uninstall` is run in each.
- If an OpenCode config entry cannot be removed, repair its config or permissions
  and retry the same uninstall command. Uninstall reports failure and keeps
  its ownership record and shared data directory, even for the last tool.
- Project uninstall keeps the global Pi and Oh My Pi extensions, Hermes
  plugin and config, OpenCode's user plugin, Antigravity's `teamai` hook in
  `~/.gemini/config/hooks.json`, and the Codex family's user-level hooks, which the user
  scope or another project may use, and names them. If none
  does, run `teamai hooks remove` in the project first: it removes them.
  Targeted project Codex uninstall keeps project config and records its
  exclusion, even without local resources. Legacy project hook copies go.
  User-scope uninstall removes these global channels, the Hermes and Oh My
  Pi ones from every home and profile teamai wrote.
  The retained adapters respect project exclusions. An excluded tool does not download its
  resources again on the next session start.
- An enabled, installed Pi, Oh My Pi, Hermes or project Codex also keeps the
  project's shared state in use without a local tool directory. Uninstalling
  another tool preserves that state and the remaining tool's instructions.
- Do **not** delete the team repo on the Git platform — uninstall never touches it,
  and neither should you.
- If the user only wants to stop auto-sync for one tool but keep TeamAI otherwise,
  that is the `--agent <tool>` form, not a full uninstall.
- In a project, uninstall also removes teamai's git hook: the
  `hook.teamai-post-checkout`, `hook.teamai-post-merge` and `hook.teamai-post-rewrite` entries in the repo's git
  config and the `# >>> teamai git hook` block in `.git/hooks/post-checkout`,
  `post-merge` and `post-rewrite`. Other hooks stay; a script left with only its shebang is deleted.
- In a project, uninstall removes delivered Git exclusion blocks only after removing their owned files. User lines and other projects' blocks stay. A failed removal keeps its ownership records and exclusion lines for a retry. `--agent <tool>` removes only that tool's owned resources.
- Legacy HTTP delivery no longer runs. Its remaining copies and exclusion records are preserved when ownership cannot be proven. Uninstall does not silently delete those files or expose possible credentials. Review the named files before removing them manually.
- A `credentials` line stays, with a warning, while the models file it names
  still holds an API key in any checkout of that repository. MCP lines
  (the `# [teamai:mcp-exclude:start]` block) go only for MCP configs it proves
  hold no resolved `${VAR}` value, judged in every checkout of the repository
  (the main checkout of a `--separate-git-dir` repo or a submodule too), after
  removing teamai's servers from each. A line names the path a write lands in: for a config
  under a symlinked directory, the link's target (`/config/mcp.json` for
  `.cursor/` linking to `config/`); for a config that is itself a symlink, its
  target, in that target's repository. For one it cannot prove clean (including one written
  under a `toolPaths` mapping since changed, at the built-in location of a tool
  the team dropped or moved that no other tool maps, or in a nested repository's
  linked worktree, that still holds servers, and one written for a tool since moved
  (or at its built-in location) that another tool maps, holding a server that tool
  did not write) it keeps the line
  and warns, naming the file and why: have the user remove teamai's servers from
  that file, then delete the line (with the last one, the block's markers). Do not
  delete a kept line while its file still holds a token.
