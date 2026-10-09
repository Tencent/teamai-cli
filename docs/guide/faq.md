# Uninstall & FAQ

> [English](faq.md) | [简体中文](zh-CN/faq.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Uninstall

`teamai uninstall` intelligently cleans up all teamai-managed resources, **preserving anything you created yourself**.

A targeted project exclusion also requires confirmation or `--force`, even when there are no local files to remove. `--dry-run` and a declined confirmation leave the project config unchanged.

```bash
# Preview every managed path that will be removed (no actual changes)
teamai uninstall --dry-run

# Interactive confirmation
teamai uninstall

# Skip confirmation and uninstall directly (for scripts/CI)
teamai uninstall --force

# Uninstall only one tool's resources (mirrors `init --agent`)
teamai uninstall --agent claude
```

What gets removed:
- TeamAI-managed model settings are restored first when ownership is still intact
- teamai hooks in AI tool settings. A settings file that does not parse is left as it is and named; teamai's data directory, which holds the record of the hooks in it, then stays too, the uninstall reports itself incomplete (exit code 1), and the tool is excluded, so the hooks left in place sync nothing back; `teamai uninstall` run again after you fix the file removes them. `teamai source remove-http` also preserves failed agent-hook records, disables the HTTP source, and exits with code 1.
- An HTTP source (`init --http`), in a user-scope uninstall, removed as `teamai source remove-http` removes it: the uninstall waits up to 30 seconds for an active HTTP sync or plugin reconciliation, and when it cannot acquire that lock, exits with code 1 before removing anything
- The teamai blocks (culture, shared instructions, recall) in each tool's instruction file, and the files an earlier release wrote them to (your own content is preserved; a `teamai-context` file teamai wrote is removed whole, and OpenCode's `instructions` entry for it goes too when teamai added it, even when your own text keeps the file or the file is gone; an entry you listed yourself stays)
- The team-rules block in the file a tool with no rules format reads in user scope (`~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`, `$DSH_HOME/AGENTS.md`, the OpenClaw workspace `AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/.joycode/rules.txt`), and the file when teamai created it for the block alone
- Team-synced skills, including OpenClaw workspace skills (your own skills are preserved). A directory two builds share in a project — `.trae/skills/` for Trae and Trae CN, `.qoder/skills/` for Qoder and Qoder CN — stays while the other of them is still installed
- Team-synced rules, including the copies older releases left in `.codex/rules/`, a project's `.workbuddy/rules/` and `.pi/rules/`, `.openclaw/rules/`, `~/.pi/agent/rules/` and `~/.joycode/rules/`, also of rules the team has since removed. A copy in a project's `.codebuddy/rules/` stays while the other of CodeBuddy and WorkBuddy is still installed. Cleanup follows the recorded `toolRoots` location and the publisher's local filenames. A copy there you edited is kept and named in a warning. A removed rule's copy is deleted only if it matches its recorded delivery hash; without that record, it is kept and named too. Codex's `*.rules` files are kept
- Team-synced custom agents and CLI built-in agents (your own agents are preserved)
- The env block in your shell profile — every candidate file (`.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`) carrying a block that sources this scope's own `env.sh` is cleaned, not only the one file `pull` would choose today; a block sourcing a different scope's `env.sh` is left alone
- In a project, teamai's git hook: the `hook.teamai-post-checkout`, `hook.teamai-post-merge` and `hook.teamai-post-rewrite` entries in the repository's git config, and the marked block in `.git/hooks/post-checkout`, `post-merge` and `post-rewrite` (a script left with only its shebang, the one teamai created, is deleted). Other hooks are kept
- In a project, teamai's git exclude blocks, once the files they hid are deleted: the `delivered` block in the project's `.git/info/exclude`, the `delivered/<id>` block in another repository (a tool folder that is a nested clone or a submodule, a tool home kept in git), the HTTP local agent's lines for this project (the agent keeps serving your other workspaces; a user-scope uninstall removes its `local-agent` block in every exclude file it recorded, another repository's too), and any other teamai block in those files, so a file you later create at one of those paths is visible to git. Your own lines stay, and so does another project's block in a repository they share. A line for an MCP config teamai cannot prove free of a resolved value stays, with a warning (see [MCP servers](./sharing.md#mcp-servers)), judged in every checkout of the repository; so does a `credentials` line while the models file it names still holds an API key, in any checkout of that repository. An incomplete uninstall keeps the line of every file still on disk, for the retry to remove. A read-only exclude file (or one another teamai command holds past a short wait) is left as it is, with a warning listing the lines to delete by hand; teamai's data directory, which records that file, then stays, and the uninstall reports itself incomplete (exit code 1), so running it again once the file is writable removes the block. One whose repository is gone is skipped
- teamai's docs search whitelist block in each checkout's `.teamai/.ignore`, and the file when nothing else is in it (see [Keeping Delivered Files Out of Git](./member-guide.md#keeping-delivered-files-out-of-git)).
- The team docs in the docs directory (`sharing.docs.localDir`): each file, or link, that holds a version of that doc from the team repo's history. Anything else there stays and is named (`Kept <path>: it is not teamai's ... so uninstall left it.`): a file at a removed doc's path or at one the team never had, a directory or a link of yours. The directories holding it stay too, inside `~/.teamai/` as well. While the team repo's history cannot be read, the docs directory stays whole
- The `~/.teamai/` directory. When uninstall finds no configuration (run outside every project, with no user-scope one, as on a machine set up only with `init --http`), it removes this directory and the HTTP source, and first teamai's git exclude lines from every exclude file its records name, but the line of a file it leaves on disk, which stays and is named, and the MCP servers the local agent recorded in Claude's and CodeBuddy's local scopes (`~/.claude.json`, `.codebuddy.json`), only those still as teamai wrote them: a copy you changed stays, named, and so do your own servers. While a file holding teamai's servers cannot be read or written (it does not parse, say), the directory stays with their records, the uninstall reports itself incomplete (exit code 1) and names the file; run it again once the file is fixed

In a workspace without project config, run `teamai uninstall --force` in that workspace to remove the local-scope MCP servers recorded in its `.teamai/managed-local-mcp.json`. Uninstall reads this workspace's records with or without user config. If a tool config cannot be read or written, it keeps the records, names the file, and exits 1. Repair that file and repeat the command in the same workspace. It does not scan other unconfigured workspaces.

A project uninstall keeps and names any recorded MCP server you changed since teamai wrote it, in `.mcp.json` or the tool's local scope. Your own servers stay too.

A skill, rule or agent copy git tracks is never deleted: uninstall names it with the `git rm -r <path>` that removes it from the repository, and its summary lists it under `Kept (tracked)`.

Uninstall deletes the copies in the checkout it runs in. Another worktree's copies stay on disk and, once the blocks are gone, git shows them there. `--dry-run` lists the blocks it would remove under `Git exclude blocks (teamai's):`, one line per owner and file. Like a pull, uninstall holds the project's sync lock while it works, so a background pull cannot write a block back; when another pull or push holds it past a short wait, uninstall changes nothing and exits 1: run it again once that finishes.

### Uninstall a single tool (`--agent <tool>`)

`--agent <tool>` removes only that tool's teamai resources (hooks, team instruction blocks, skills, rules, team-synced custom agents, and built-in agents). The tool name is a key of `toolPaths` (e.g. `claude`, `codex`, `codebuddy`) and is matched case-insensitively. An unknown tool name aborts without deleting anything, lists the available tools, and exits with a non-zero status.

An instructions file several tools map is cleaned per block: a teamai block stays while a remaining tool on that file still writes it. The common case is `.codebuddy/rules/teamai-context.md`, which CodeBuddy and WorkBuddy share: `--agent workbuddy` keeps it while CodeBuddy is installed. The same retention keeps a shared skills directory (`.trae/skills/`, `.qoder/skills/`) and a shared rule copy (`.trae/rules/`, `.qoder/rules/`) while the sibling build is still installed. With both builds of a pair installed the plan can then be empty — every resource shared and kept — and the uninstall still records the exclusion, like the global-channel tools above. A file an earlier release wrote the blocks to, such as the project `AGENTS.md`, is read by no tool now, so its teamai blocks go and your own text stays. A file teamai created goes with its last block; an instructions file you had before stays, even an empty one. A configured `claudemd` remains a member file even when its basename is `teamai-context.md`.

In a project, the tool's lines leave the `delivered` git exclude blocks: uninstall drops the paths under the tool's folders (each `toolPaths` entry's top folder, and `.agents/skills` for Codex) from every checkout's list, then updates the blocks. A path another tool still in use reads keeps its line (WorkBuddy's `.codebuddy/rules`), and so does a path still on disk after an incomplete uninstall. The tool's copies in other worktrees stay on disk, visible to git.

Shared resources (the env block, docs directory, and `~/.teamai/`) are removed **only when the target itself has teamai resources AND is the last tool still using teamai** — otherwise they are kept for the remaining tools. Targeting a tool with no local resources leaves shared resources in place, even if it is the only tool. Project uninstall still records the exclusion for Pi, Oh My Pi, Hermes, OpenCode and the Codex family, whose instruction channels are global.

An enabled, installed Pi, Oh My Pi, Hermes or project Codex keeps the project state in use through its global delivery channel, even without a project-local tool directory. Uninstalling another tool preserves that state so the remaining tool can still deliver this project's instructions.

If removing an OpenCode entry added by teamai fails, uninstall exits with an error and keeps the shared data directory and ownership record, even when OpenCode is the last tool. Repair the config or its permissions, then retry the same uninstall command.

Project uninstall keeps Pi's and Oh My Pi's global extensions, Hermes' global plugin and configuration, OpenCode's user plugin (which also carries V2's rules and instructions), the Codex family's user-level hooks and server-pushed agent hooks, which the user scope, the HTTP agent or another project on this machine may use, and names them in its summary. When none uses them, run `teamai hooks remove` in the project before uninstalling: it removes them. Targeted project Codex uninstall keeps the project config to record its exclusion and removes only project-owned resources and legacy hook copies. A targeted uninstall excludes the tool in this project's config when that config survives. User-scope uninstall removes these global delivery channels.

The exclusion is durable: `uninstall --agent <tool>` drops the tool from `enabledAgents` and records it in `disabledAgents`, so a later `pull` (or another tool's session-start hook) will not resurrect its skills, rules, agents, team instruction blocks, or hooks. Retained global adapters also skip HTTP sync, cached HTTP prompt injection and the session-start pull for that excluded tool. Running `init --agent <tool>` again clears the exclusion and re-enables sync for that tool.

The same `enabledAgents` whitelist (from `init --agent`) also gates CLI built-in skills/rules/agents and team instruction blocks: an already-installed tool outside the list is neither written to nor deleted from, even if its root directory already exists. `teamai remove` respects the same whitelist for agents, rules, and skills, `teamai push` reads no rules or agents from a tool outside it, and `teamai pull` / `teamai mcp inject` respect it for MCP servers. Editing `enabledAgents` without `init` still invalidates the last-pull skip cache for newly added tools.

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/your-org/your-repo --scope user --role <role_id> --force
```

---

## FAQ

**Q: Can user scope and project scope coexist?**

Yes, but project scope remains isolated by default. When the current working directory contains a project-scope config, it is active and user scope is skipped. Initialize user scope first, then initialize the project with `--inherit-user-scope` (or set `inheritUserScope: true` in the project's local config) to compose safe resources and Recall results. Executable and control-plane configuration (`env`, MCP) remains project-only; hooks are the exception — a non-self project scope injects the built-in hooks into HOME so `hook-dispatch` can gate on `cwd` (see the Hooks section).

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo https://github.com/your-org/your-repo --force
```

**Q: After `teamai init` in a project, there is no `.claude/` (or `.cursor/`, `.codebuddy/`) directory?**

That is expected for a built-in tool when `init` ran without `--agent` and without a terminal (no picker): it does not know which agent you will open. Run `teamai init <repo> --agent claude` (or `cursor`, `codebuddy`, …) to create that tool's root and fill it before init exits, or open the tool in the project: the SessionStart hook creates that tool's project root and then pulls. A bare `teamai pull` will not create missing agent roots. The exception is a custom agent defined only in `teamai.yaml`'s `toolPaths` (not one of the built-in tools) — `init --agent <id>` creates that agent's root itself, since nothing else ever would. 

This only works for git-backed init (default or `--self`): an HTTP init (`--http`) never clones a local `teamai.yaml`, so it has no custom paths to seed from and only ever creates roots for built-in tools that are already installed.

**Q: Hooks aren't firing automatically?**

```bash
teamai doctor        # Diagnose
teamai hooks inject --dry-run # Preview first
teamai hooks inject  # Re-inject
```

**Q: `push` says "no new resources detected"?**

`push` only detects new or modified resources. If nothing changed, there's nothing to push.

**Q: How do I delete resources that were already pushed?**

```bash
teamai remove skills <name>
teamai remove rules <name>
```

---

> **Repo**: https://github.com/Tencent/teamai-cli
> **Feedback**: file an Issue in the repo
