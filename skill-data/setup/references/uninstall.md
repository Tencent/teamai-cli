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
- **Whole machine** → no `--agent` flag.

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

- Project uninstall keeps the shared Claude/Codex team hooks in the main checkout
  while another checkout uses them. A targeted uninstall releases only the selected
  tool. Checkouts that exclude a tool do not retain its shared hook. Bare-repository
  worktrees remove their own hook files independently. When the main checkout has
  no install, the shared manifest and its empty `.teamai` directory are removed
  after the last team hook is removed.
- A migrated data partition is one installation shared by its checkouts. Uninstall
  removes the selected tools' shared hooks and registrations for that installation.
  Full uninstall removes the partition; targeted uninstall keeps the other tools.
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
  `~/.pi/agent/AGENTS.md`, `~/.joycode/rules.txt`), and the file when teamai
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
- If an OpenCode config entry cannot be removed, repair its config or permissions
  and retry the same uninstall command. Uninstall reports failure and keeps
  its ownership record and shared data directory, even for the last tool.
- Project uninstall keeps the global Pi and Oh My Pi extensions, Hermes
  plugin and config, OpenCode's user plugin, and the Codex family's
  user-level hooks, which the user
  scope, the HTTP agent or another project may use, and names them. If none
  does, run `teamai hooks remove` in the project first: it removes them.
  Targeted project Codex uninstall keeps project config and records its
  exclusion, even without local resources. Legacy project hook copies go.
  User-scope uninstall removes these global channels.
  The retained adapters respect project exclusions, including cached HTTP
  prompt injection and HTTP sync. An excluded tool does not download its
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
- In a project, uninstall also takes teamai's blocks out of `.git/info/exclude`
  once it has deleted the files they hid: the `delivered` block, the
  `delivered/<id>` block it keeps in another repository (a tool folder that is
  a nested clone or submodule, a tool home kept in git), the HTTP local
  agent's lines for this project (it keeps serving the other workspaces; a
  user-scope uninstall removes its `local-agent` block in every exclude file it
  recorded), and every other `# [teamai:…]` block in those files. A file the user creates later at one of
  those paths is visible to git. Their own lines stay, and so does another
  project's block in a shared repository. A read-only exclude file is left as
  it is, and the warning lists the lines to delete by hand; the uninstall is
  then incomplete (exit 1) and keeps its records, so rerunning it once the
  file is writable removes the block. Copies in other
  worktrees stay on disk and become visible there. `--agent <tool>` drops only
  that tool's lines (`.agents/skills` too for Codex) from every worktree,
  keeping a path another tool in use reads. `--dry-run` lists the blocks under
  `Git exclude blocks (teamai's):`. An incomplete uninstall keeps the line of
  every file still on disk until the retry. With no configuration found (a
  machine set up only with `init --http`, uninstall run outside its projects),
  uninstall removes `~/.teamai/` and the HTTP source, and first teamai's lines
  from every exclude file its records name, but the line of a file it leaves on
  disk (named), and the local agent's MCP servers in Claude's and CodeBuddy's
  local scopes that are still as it wrote them (a changed copy stays, named).
  If such a file does not parse, `~/.teamai/` and the records stay and it exits
  1, naming the file: fix it and rerun. `teamai source remove-http` leaves
  those servers but keeps their records, for this uninstall to remove. In a workspace with no project config, run uninstall there: it also reads that workspace's `.teamai/managed-local-mcp.json`, with or without user config. A failed removal keeps those records and exits 1; repair the named file and retry in the same workspace. It does not scan other unconfigured workspaces. The local agent's skills and rules go only as far as they are
  still what it installed: a file the user added inside a skill, an edited
  copy, and a tracked file stay, named. If another pull or push holds the
  project's sync lock, uninstall changes nothing and exits 1: run it again.
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
