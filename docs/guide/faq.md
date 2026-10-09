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
- teamai hooks in AI tool settings
- The teamai blocks (culture, shared instructions, recall) in each tool's instruction file, and the files an earlier release wrote them to (your own content is preserved; a `teamai-context` file teamai wrote is removed whole, and OpenCode's `instructions` entry for it goes too when teamai added it, even when your own text keeps the file or the file is gone; an entry you listed yourself stays)
- The team-rules block in the file a tool with no rules format reads in user scope (`~/.codex/AGENTS.md`, `~/.zcode/AGENTS.md`, `$DSH_HOME/AGENTS.md`, the OpenClaw workspace `AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/.joycode/rules.txt`), and the file when teamai created it for the block alone
- Team-synced skills, including OpenClaw workspace skills (your own skills are preserved)
- Team-synced rules, including the copies older releases left in `.codex/rules/`, a project's `.workbuddy/rules/` and `.pi/rules/`, `.openclaw/rules/`, `~/.pi/agent/rules/` and `~/.joycode/rules/`, also of rules the team has since removed. A copy in a project's `.codebuddy/rules/` stays while the other of CodeBuddy and WorkBuddy is still installed. Cleanup follows the recorded `toolRoots` location and the publisher's local filenames. A copy there you edited is kept and named in a warning. A removed rule's copy is deleted only if it matches its recorded delivery hash; without that record, it is kept and named too. Codex's `*.rules` files are kept
- Team-synced custom agents and CLI built-in agents (your own agents are preserved)
- The env block in your shell profile — every candidate file (`.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login`, `.profile`) carrying a block that sources this scope's own `env.sh` is cleaned, not only the one file `pull` would choose today; a block sourcing a different scope's `env.sh` is left alone
- In a project, teamai's git hook: the `hook.teamai-post-checkout`, `hook.teamai-post-merge` and `hook.teamai-post-rewrite` entries in the repository's git config, and the marked block in `.git/hooks/post-checkout`, `post-merge` and `post-rewrite` (a script left with only its shebang, the one teamai created, is deleted). Other hooks are kept
- The `~/.teamai/` directory

### Uninstall a single tool (`--agent <tool>`)

`--agent <tool>` removes only that tool's teamai resources (hooks, team instruction blocks, skills, rules, team-synced custom agents, and built-in agents). The tool name is a key of `toolPaths` (e.g. `claude`, `codex`, `codebuddy`) and is matched case-insensitively. An unknown tool name aborts without deleting anything, lists the available tools, and exits with a non-zero status.

An instructions file several tools map is cleaned per block: a teamai block stays while a remaining tool on that file still writes it. The common case is `.codebuddy/rules/teamai-context.md`, which CodeBuddy and WorkBuddy share: `--agent workbuddy` keeps it while CodeBuddy is installed. A file an earlier release wrote the blocks to, such as the project `AGENTS.md`, is read by no tool now, so its teamai blocks go and your own text stays. A file teamai created goes with its last block; an instructions file you had before stays, even an empty one. A configured `claudemd` remains a member file even when its basename is `teamai-context.md`.

Shared resources (the env block, docs directory, and `~/.teamai/`) are removed **only when the target itself has teamai resources AND is the last tool still using teamai** — otherwise they are kept for the remaining tools. Targeting a tool with no local resources leaves shared resources in place, even if it is the only tool. Project uninstall still records the exclusion for Pi, Oh My Pi, Hermes and the Codex family, whose instruction channels are global.

An enabled, installed Pi, Oh My Pi, Hermes or project Codex keeps the project state in use through its global delivery channel, even without a project-local tool directory. Uninstalling another tool preserves that state so the remaining tool can still deliver this project's instructions.

If removing an OpenCode entry added by teamai fails, uninstall exits with an error and keeps the shared data directory and ownership record, even when OpenCode is the last tool. Repair the config or its permissions, then retry the same uninstall command.

Project uninstall keeps Pi's and Oh My Pi's global extensions, Hermes' global plugin and configuration, the Codex family's user-level hooks and server-pushed agent hooks, which the user scope, the HTTP agent or another project on this machine may use, and names them in its summary. When none uses them, run `teamai hooks remove` in the project before uninstalling: it removes them. Targeted project Codex uninstall keeps the project config to record its exclusion and removes only project-owned resources and legacy hook copies. A targeted uninstall excludes the tool in this project's config when that config survives. User-scope uninstall removes these global delivery channels.

The exclusion is durable: `uninstall --agent <tool>` drops the tool from `enabledAgents` and records it in `disabledAgents`, so a later `pull` (or another tool's session-start hook) will not resurrect its skills, rules, agents, team instruction blocks, or hooks. Retained global adapters also skip HTTP sync and cached HTTP prompt injection for that excluded tool. Running `init --agent <tool>` again clears the exclusion and re-enables sync for that tool.

The same `enabledAgents` whitelist (from `init --agent`) also gates CLI built-in skills/rules/agents and team instruction blocks: an already-installed tool outside the list is neither written to nor deleted from, even if its root directory already exists. `teamai remove` respects the same whitelist for agents, rules, and skills, `teamai push` reads no rules or agents from a tool outside it, and `teamai pull` / `teamai mcp inject` respect it for MCP servers. Editing `enabledAgents` without `init` still invalidates the last-pull skip cache for newly added tools.

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --scope user --role <role_id> --force
```

---

## FAQ

**Q: Can user scope and project scope coexist?**

Yes, but project scope remains isolated by default. When the current working directory contains a project-scope config, it is active and user scope is skipped. Initialize user scope first, then initialize the project with `--inherit-user-scope` (or set `inheritUserScope: true` in the project's local config) to compose safe resources and Recall results. Executable and control-plane configuration (`env`, MCP) remains project-only; hooks are the exception — a non-self project scope injects the built-in hooks into HOME so `hook-dispatch` can gate on `cwd` (see the Hooks section).

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo https://github.com/yourorg/yourrepo --force
```

**Q: After `teamai init` in a project, there is no `.claude/` (or `.cursor/`, `.codebuddy/`) directory?**

That is expected for a built-in tool when `init` ran without `--agent` and without a terminal (no picker): it does not know which agent you will open. Run `teamai init <repo> --agent claude` (or `cursor`, `codebuddy`, …) to create that tool's root and fill it before init exits, or open the tool in the project: the SessionStart hook creates that tool's project root and then pulls. A bare `teamai pull` will not create missing agent roots. The exception is a custom agent defined only in `teamai.yaml`'s `toolPaths` (not one of the built-in tools) — `init --agent <id>` creates that agent's root itself, since nothing else ever would. This only works for git-backed init (default or `--self`): an HTTP init (`--http`) never clones a local `teamai.yaml`, so it has no custom paths to seed from and only ever creates roots for built-in tools that are already installed.

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
