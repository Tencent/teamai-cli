# Uninstall & FAQ

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Uninstall

`teamai uninstall` removes resources TeamAI installed. Files you created stay.

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

To rejoin after uninstalling:

```bash
teamai init --repo https://github.com/your-org/your-repo --scope user --role <role_id> --force
```

---

## FAQ

**Q: A command says `Cannot acquire lock <path>: <reason>`?**

The lock could not be inspected, created or reclaimed, including during a
dry-run preview. Fix the filesystem error it names
(for example permissions, a full disk, or a parent path that is a file), then
retry. Waiting for another teamai process will not fix these errors. A lock held
by another process still uses the command's usual busy/skip message; an existing
lock that cannot be read due to permissions or names no owner is also treated as
held to protect it.

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
