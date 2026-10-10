# Hooks

> [English](hooks.md) | [简体中文](zh-CN/hooks.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

Hooks automatically injected by `teamai init`:

| Hook Event | Action |
|-----------|------|
| `SessionStart` | Seed the current agent's project root (project scope), then auto pull + report session start |
| `PostToolUse` | Skill tracking + knowledge contribution detection + dashboard reporting |
| `UserPromptSubmit` | Slash command tracking |
| `Stop` | CLI update check + report session end |

```bash
teamai hooks list      # Show effective built-in and team hooks
teamai hooks inject --dry-run # Preview without changing settings or managed-hook records
teamai hooks inject    # Re-inject
teamai hooks remove    # Remove
```

`hooks list` prints the built-in set per tool, because the set is not universal: Copilot also gets `SessionEnd`, Claude Code, Codex, CodeBuddy and Qoder also get `SubagentStop`, the Codex family also gets `SubagentStart` (the project's team rules and instructions for a spawned subagent), OMP's extension covers four events without the `Skill` / `TodoWrite` matchers, OpenClaw maps only `SessionStart` + `UserPromptSubmit`, and Hermes only `SessionStart`. Tools the hook pipeline installs nothing for (e.g. JoyCode) are omitted, and so is Kiro — its `SessionStart` command is embedded as `hooks.agentSpawn` by the agent sync, so it exists only for the agents you actually synced.

The inject and remove commands only touch tools you actually have installed (i.e. whose `~/.<tool>/` root directory already exists). They never create root directories for tools listed in `toolPaths` but not installed. Existing Claude/Codex main-checkout hook files also count as installed targets when the HOME and current worktree tool roots are missing. Injection and pull update those team hooks and restore HOME built-ins; removal clears the managed main-checkout hooks without recreating HOME roots.

`hooks inject`, `init` and self-repo bootstrap still attempt to trust the written Codex hooks if Git-hook installation fails. Injection preserves the installation error and does not report overall success. Init reports the error and keeps exit code 1 while completing local setup, including HTTP initialization. Bootstrap records that error in the debug log and continues local setup.

In non-self project scope, `hooks remove` removes this checkout's gated team hooks from HOME and releases its Claude/Codex team-hook ownership in the main checkout. The shared team hooks remain until the last checkout removes them. `uninstall --agent <tool>` releases only that tool's ownership. Checkouts that exclude a tool do not retain its shared hook. For a migrated shared data partition, uninstall removes the selected tools' shared hooks across the repository; full uninstall also removes that partition. Worktrees of bare repositories remove their own Claude/Codex team-hook files independently. Other projects' gated team hooks stay in HOME; shared built-in hooks are removed.

> **OpenClaw** — teamai's hook is a workspace hook, `<workspace>/hooks/teamai-status-report`. It runs `session-start` on `command:new`, `command:reset`, `session:auto-reset` and `gateway:startup`, and `prompt-submit` on `message:received`, with the event's workspace as the hook's `cwd`. OpenClaw loads a workspace hook only when `openclaw.json` enables its entry, so init, pull and `hooks inject` add `hooks.internal.entries.teamai-status-report.enabled: true`, and `hooks remove` and uninstall take it out. 

> When OpenClaw loads every hook it discovers (`hooks.internal.enabled: true` with no named entries), that first entry would turn discovery into an allowlist and stop your other hooks, so teamai leaves the config alone and warns; it does the same when you switched the hook or internal hooks off, or when `openclaw.json` is not plain JSON. Run `openclaw hooks enable teamai-status-report` to enable it yourself. Earlier teamai versions set `hooks.internal.enabled: true` themselves when `OPENCLAW_STATE_DIR` was set, so such a machine sees this warning until you do. A server-pushed agent hook lands in `<state dir>/hooks/<slug>` and gets its own entry, `teamai-agent-<slug>`. 

> The workspace and config are found the way OpenClaw finds them: `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR` or `OPENCLAW_PROFILE` (`~/.openclaw-<profile>`), then `agents.defaults.workspace`, `OPENCLAW_WORKSPACE_DIR`, or `<state dir>/workspace`. `doctor` fails `OpenClaw hook enabled` while the entry is missing or off.

On Windows, the built-in hook dispatch commands that shell out through bash (e.g. Claude, Codex, Cursor, Copilot CLI) reference Git Bash by absolute path — standard install locations first, then the `HKLM\SOFTWARE\GitForWindows` registry as fallback — so they never resolve to the WSL `bash.exe` launcher; if Git Bash cannot be found they degrade to bare `bash`.

Cursor also loads `~/.claude/settings.json`, and Copilot CLI loads a trusted project's `.claude/settings.json` (self mode writes hooks there; Copilot does not load `~/.claude/settings.json`). `hook-dispatch --tool claude` exits only when that other host's own teamai hooks are on disk: `~/.cursor/hooks.json` or `$CURSOR_PROJECT_DIR/.cursor/hooks.json` contains `--tool cursor`, or `$COPILOT_PROJECT_DIR/.github/hooks/teamai.json` contains `--tool copilot`. Team hook commands written for `claude` use the same check. A setup with only Claude keeps running inside Cursor, because there is no second copy. `COPILOT_CLI` is not a signal: Copilot sets it on every subprocess, including a Claude session started from its shell. Claude Code sets neither `CURSOR_VERSION` nor `COPILOT_PROJECT_DIR`. 

Run `teamai pull` or `teamai hooks inject` again so an already installed team hook picks up the guard.

> **Codex hook trust** — Codex (the OpenAI / ChatGPT Codex app, tool id `codex`) runs a non-managed hook only once it is trusted, and skips an untrusted or changed one without a word; it reads a project's `.codex/` only when the project is trusted. So after every write of a Codex hooks file (`init`, every `pull` including the session-start one, `teamai hooks inject`) teamai trusts exactly the hooks it wrote, through `codex app-server` — the same call Codex's `/hooks` trust prompt makes. Your own hooks in the same file are left alone, even when their commands equal a team hook; only an entry equal to the whole entry teamai writes counts as teamai's (see below). 

> Codex ownership records include the event, position and complete generated entry; trust selects that exact Codex key. If unrelated entries move it, teamai recovers ownership only when the complete definition matches uniquely. Legacy manifests recorded only event, matcher and command, so a unique match on those fields recovers ownership even with `timeout` or `additionalContextLimit`. For pre-#370 project Codex hooks, teamai imports ownership from the main checkout's `.teamai/managed-hooks.json` before reconciling the same file with the new manifest, including direct removal. 

> An entry no record claims that equals teamai's entry for exactly one team hook, as the team repo defines it now or at any earlier revision, is teamai's: a lost manifest no longer adds a second copy of each team hook (the same holds for the marked entries in `.claude/settings.local.json`). Any other unrecorded entry is preserved; one that equals more than one team hook, or a marked Claude entry that equals none, is also named by pull and listed by `teamai doctor`. In a project, teamai also trusts the main checkout when Codex has to read teamai's hooks or MCP servers from its `.codex/`; for a bare repository, teamai writes and trusts the current worktree instead. 

> A project you marked untrusted in Codex stays so, and teamai says so. Trust written by a session-start pull applies from the next Codex session: the running one already loaded its hooks. A linked worktree reads the main checkout's `.codex/hooks.json` only once it has a `.codex/` directory. The post-checkout preparation creates that directory and runs pull before the first session for selected Codex tools. Hosts that skip checkout hooks must finish that preparation before starting Codex. If only SessionStart creates the directory, the team hooks load from the next Codex session; built-in hooks live in `~/.codex/hooks.json` and run from the first. To trust them yourself, set `codexTrustEnabled: false` in `config.yaml`. 

> `init` and `hooks inject` print a reminder to trust them in `/hooks` or Settings → Hooks when `codex` is absent or its app-server fails. An interactive pull warns on app-server failure and stays quiet when `codex` is absent; silent pulls record the result in the debug log. `teamai doctor` asks Codex which teamai hooks it will not run and names them. The entries that run a project's team hooks from `~/.codex/hooks.json` (see [Keeping Delivered Files Out of Git](./member-guide.md#keeping-delivered-files-out-of-git)) are trusted the same way.

## Team Hooks Declaration

A team can declare custom hooks in the repo's `hooks/hooks.yaml`, and per namespace in `hooks/<ns>/hooks.yaml` (see [Env, hooks and MCP servers by namespace](./sharing.md#env-hooks-and-mcp-servers-by-namespace)); `teamai pull` automatically distributes them to supported hook adapters. `builtin:` is read from `hooks/hooks.yaml` only. Pi is currently limited to TeamAI's built-in lifecycle bridge: custom hooks and built-in overrides from this file are not applied to Pi.

```yaml
hooks:
  - id: block-secret
    description: Scan for secrets before commit
    event: PreToolUse
    matcher: Bash
    command: 'bash -lc "~/.teamai/team-scripts/scan-secret.sh" || true'
    timeout: 15
    tools: [claude, cursor]

builtin:
  disabled: [Hook dispatch post-tool-use TodoWrite]
  overrides:
    Hook dispatch stop: { timeout: 20 }
```

| Field | Description |
|------|------|
| `id` | Unique identifier, `^[a-z0-9-]+$` |
| `event` | Claude PascalCase event name (shared across tools) |
| `matcher` | Optional tool matcher |
| `tools` | Optional list of target tools (default = all tools that support hooks) |
| `roles` | Deprecated: use `hooks/<ns>/hooks.yaml`. Still filters by role id for one minor release, with a warning naming the target file |
| `builtin.disabled` | List of disabled built-in hooks |
| `builtin.overrides` | Only the `timeout` of a built-in hook can be overridden |

Security governance:
- `sharing.hooks.autoApply: false` (`teamai.yaml`): on pull, only prompts — requires manually confirming with `teamai hooks inject`
- `sharing.hooks.requireTeamScripts: true`: rejects any hook whose command isn't under `~/.teamai/team-scripts/`
- `TEAMAI_HOOKS_DISABLED=1`: disables all team hooks locally (built-in hooks are unaffected)
