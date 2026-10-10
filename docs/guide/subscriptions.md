# Cross-team skill subscriptions

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

`teamai source` lets you subscribe to other teams' public skill repos, automatically fetching the latest skills on `pull`:

```bash
# Add a subscription source
teamai source add https://github.com/other-team/teamai-public.git --name other-team

# List subscriptions
teamai source list

# Browse a subscription's skills
teamai source browse other-team

# Remove a subscription (also cleans up its skills)
teamai source remove other-team
```

A subscription source's skills are automatically synced locally on `teamai pull`, coexisting with the team's own skills. `teamai source add`/`remove` updates the active scope's team repo immediately, so local `list`, `browse`, and `pull` commands use the change before it is committed. The subscription itself is stored in the `sources` field of that repo's `teamai.yaml`. Run `teamai push` to open a PR with the config change; once it merges, every teammate's `teamai pull` picks up the new source automatically.

Source skills land where the team's own skills land, and only in tools that are enabled.

A file of yours at a subscribed skill's path is kept and named, not overwritten. `source remove` cleans only this install. Caches, the lock, and the cases where pull refuses to delete a file are in [Cross-team source installation ownership](../designs/data-directory-layout.md#cross-team-source-installation-ownership).

A source only shares the skills it opts in via a `publicSkills` list in its own `teamai.yaml`. If the repo has no `teamai.yaml`, or declares no `publicSkills`, `teamai source add` succeeds but warns that the source will sync **0 skills** — the source team has to publish a `publicSkills` list before anything flows through.

## HTTP Source

In addition to a git subscription source, you can attach an HTTP source on top of an existing git main repo — useful for server-managed skill delivery:

```bash
# Attach an HTTP source (the git main repo is unaffected)
teamai source add-http https://your-team-host/api --token <api-key>

# View it (shown under "HTTP source")
teamai source list

# Detach and uninstall its resources
teamai source remove-http
```

An HTTP source reports status and pulls skill commands via hook dispatch. A hook sync skips while another HTTP source operation holds the lock; a later hook event retries. Only one HTTP source is supported per install. If the main repo is already in HTTP mode (`init --http`), `add-http` is unavailable (the main repo already occupies the HTTP config).

`source remove-http` waits up to 30 seconds for an active HTTP sync or plugin reconciliation to finish. If it cannot acquire the shared lock, it exits with code 1 without starting teardown; retry after the active operation finishes and check the directory permissions. Once it holds the lock, it disables the source before teardown and clears the endpoint, credentials and caches, keeping a disabled config so legacy settings or environment variables cannot reconnect. If a hook cannot be removed, its record stays and the command exits with code 1. Fix the settings file it names, then run the command again. `source add-http` or `init --http` enables a source again.

The API a custom backend implements for `teamai init --http` is the [HTTP contract](./http-contract.md).
