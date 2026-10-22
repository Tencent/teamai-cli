# Uninstall & FAQ

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Uninstall

`teamai uninstall` removes resources TeamAI installed. Files you created stay. A user-scope uninstall keeps data for projects still registered on this machine. Uninstall each project first. Then run `teamai uninstall` outside any project to remove the remaining shared data.

In a project using a shared data partition, full uninstall removes shared hooks and registrations from every checkout before removing the partition. `uninstall --agent <tool>` removes that tool's hooks and registration only from the current checkout, unless that tool is the last one using the partition; in that case the partition and every checkout's hooks are removed. Bare-repository worktrees own their hook files independently.

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

**Q: `init` warns that member registration failed or the reports branch is busy?**

Local setup still completes. A failed registration names the cause; fix it and
re-run the same `teamai init` command to retry. If another write holds the
`teamai-reports` branch, wait for it to finish, then re-run that command.

**Q: A command says `Cannot acquire lock <path>: <reason>`?**

The lock could not be inspected, created or reclaimed, including during a
dry-run preview. Fix the filesystem error it names
(for example permissions, a full disk, or a parent path that is a file), then
retry. Waiting for another teamai process will not fix these errors. A lock held
by another process still uses the command's usual busy/skip message; an existing
lock that cannot be read due to permissions or names no owner is also treated as
held to protect it.

**Q: Lock files stay behind in `~/.teamai` after a crash?**

A lock file records the PID of the process that took it. One whose owner is
gone cannot block anything: the next command that takes the same lock reclaims
it automatically, and a process that exits normally now removes the locks it
still holds. `teamai doctor` reports any leftovers, and
`teamai doctor --fix` removes the ones whose owner is provably dead — a lock
held by a live process, or one that names no owner, is never removed.

**Q: Can user scope and workspace scope coexist?**

Yes, but workspace scope remains isolated by default. When the current working directory contains a workspace-scope config, it is active and user scope is skipped. Initialize user scope first, then initialize the workspace with `--inherit-user-scope` (or set `inheritUserScope: true` in the workspace's local config) to compose safe resources and Recall results. MCP and secrets remain workspace-only. A workspace with `inheritUserScope: true` also receives user-scope env variables unless the workspace declares the same key as a variable or a secret. Hooks are the exception: a non-self workspace scope injects the built-in hooks into HOME so `hook-dispatch` can gate on `cwd` (see the Hooks section).

**Q: `pull` says a workspace child is left out?**

A repo set up inside a workspace counts only when it uses the workspace's team repo and is not in single-repo mode. The line names the repo and the reason. Run `teamai init <team repo>` in that repo to include it, or leave it as is: it keeps working on its own. `teamai doctor` lists every child left out.

**Q: `pull` in a workspace says a skill, agent or server "differs between" two namespaces?**

Two repos inside the workspace receive an item of that name with different content, so the workspace holds it and names it: what teamai installed for it before stays, in the place the workspace's rules give it. Make the two copies equal in the team repo, or rename one. Each repo still receives its own copy.

**Q: `teamai init` says it's already initialized?**

In interactive mode, you'll be asked whether to overwrite — type `y` to confirm. You can also use `--force` to skip the confirmation:

```bash
teamai init --repo https://github.com/your-org/your-repo --force
```

**Q: After `teamai init` in a project, there is no `.claude/` (or `.cursor/`, `.codebuddy/`) directory?**

For a built-in tool, `init` without `--agent` and a non-interactive terminal does not create a tool root because you have not selected an agent. `teamai init` does not copy team skills, rules or MCP. Run `teamai init <repo> --agent claude` (or another agent ID) to create that tool's root and install its hooks. The team's resources arrive when that tool starts a session, or when you run `teamai pull`. You can also open the tool in the project. Its SessionStart hook creates the root and pulls resources.

`teamai pull` does not create missing agent roots. The exception is the first pull in an inherited submodule clone, which seeds roots from the original submodule's configuration ([project checkouts](./distribution.md#project-checkouts)). For a custom agent defined only in `teamai.yaml`'s `toolPaths`, `init --agent <id>` creates its root during git-backed init. HTTP init cannot read local `teamai.yaml` paths, so it creates roots only for installed built-in agents.

**Q: A `toolPaths` entry in `teamai.yaml` — what happens to the keys it does not name?**

The entry replaces that tool's default whole: keys you omit are *gone*, not inherited. An entry that customizes `skills` but omits `settings` leaves the tool with no settings file, so hook reconciliation silently skips it; omitting `skills` or `rules` disables that delivery on purpose. `teamai doctor` names every key a custom entry dropped that the default table provides, with the value to add back.

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
