# Advanced Features

> [English](advanced.md) | [简体中文](zh-CN/advanced.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Advanced Features

### Codebase Knowledge Graph

`teamai import` parses a source code repo into a structured knowledge graph (stored under the team repo's `teamwiki/` directory), enabling structure-aware knowledge retrieval:

```bash
# Extract from a local directory
teamai import --dir /path/to/project

# Import from a remote repo
teamai import --from-repo https://github.com/org/repo

# Bulk-import all repos under an organization
teamai import --from-org myorg

# Bulk-import from an allowlist
teamai import --from-repo-list repos.yaml

# Extract learnings from a merged MR/PR
teamai import --from-mr https://github.com/org/repo/pull/123

# Incremental mode (skip unchanged files)
teamai import --from-repo https://github.com/org/repo --incremental

# Extract structure only, skip AI enrichment
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

If core graph extraction or writing fails, the import reports an error without marking the commit as synced. The next incremental run retries that commit.

For `--from-iwiki`, an MCP tool response with `isError: true` is a failed request, even when it contains text. A page whose document or metadata request fails is warned about and skipped before AI classification; successful pages still import. A failed page-tree request warns and yields no child pages.

With `--dry-run`, `--from-repo` and `--from-repo-list` read each repo's target commit with `git ls-remote`, print `Would import <owner>/<repo> at <commit>` and whether the local cache is current, and stop there: nothing is cloned or fetched into the cache, the import lock is not taken, and no AI step runs. With `--incremental` and a cache containing `LAST_SYNC`, the preview queries that cache's current branch at its configured origin, matching the real fetch/reset. Full-clone previews, including a missing cache or `LAST_SYNC`, follow remote HEAD. If the cached branch was deleted remotely, a non-pruning wildcard fetch retains its cached origin ref; incremental preview uses that retained commit too. 

Pruning, an explicit deleted-branch fetch refspec, or a missing cached origin ref still selects the full-clone fallback. Other cached-branch query failures warn and preview the full-clone fallback. With `--output`, the preview reports the same `teamwiki/evidence/code/<slug>` destination beside the output file as a real import.

`--from-mr` publishes its learning the way `teamai contribute` does by default, on the `teamai-learnings` branch: under `learnings/<namespace>/` when the active projects resolve to exactly one learnings namespace, otherwise at the shared `learnings/` root. If that fails, the learning stays queued on this machine and the next `teamai pull` publishes it; when a learnings checkout teamai refuses stopped it, no pull can until you deal with that checkout as the message says.

When the draft overlaps existing learnings, from the shared root or your active projects' namespaces, the command names them (`Possible duplicate: this learning overlaps N existing learning(s): <files>.`), with `--all` too. It is a notice only: nothing is marked or replaced. When `manifest/projects.yaml` cannot be read, the check compares the shared root only and says so.

AI-backed steps (`--deep-enrich`, knowledge enrichment) shell out to an AI coding CLI already installed on the machine instead of calling a model API directly. teamai probes `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` and uses the first one it finds. On macOS and Linux the probe runs through a login shell, so a CLI installed under `~/.nvm/` is found too. On Windows it uses the native `where`, which returns the npm shim (`%APPDATA%\npm\claude.cmd`) that Windows can actually launch — a Git Bash or WSL `bash` only reports MSYS paths such as `/c/Users/...`, which Windows cannot start.

With `--from-org --dry-run`, the CLI lists the repositories selected by this request's filters and previews the whitelist destination. It does not read an older draft, write the whitelist, clone repositories, acquire import locks or run AI enrichment. `--skip-import` previews only the whitelist entries. Normal CLI diagnostic logging still applies.

For GitHub, `--from-org` tries the organization repo list first, then the user repo list if the first request fails or returns no repos. If the fallback request fails too, the import reports the error and exits nonzero rather than treating it as an empty list. This applies to both `gh` and the direct `GITHUB_TOKEN` / `GH_TOKEN` API path; a successful empty response still means there are no repos to import.

For GitLab behind an API gateway, set `GITLAB_URL` and `GITLAB_API_PREFIX=api/gitlab` before running `teamai import --from-org https://gitlab.example.com/myorg`. Organization listing uses the configured prefix on every page; an unset or blank prefix defaults to `api/v4`.

The graph stores components, interfaces, configs, and cross-repo dependencies. `teamai recall` combines learnings with graph BM25 hits on a bounded, relevance-normalized score scale.

Dependency edges are extracted by two parallel tracks: a WASM tree-sitter **AST track** (TypeScript/JavaScript, Python, Go, Swift) that resolves imports, calls, and TS `implements` clauses to precise file-to-file edges (`code-ast`), and a regex **heuristic track** (all languages, `code-heuristic`) that also covers languages the AST track does not. AST results win on overlap. The AST parser needs no native toolchain; on load failure, extraction falls back to heuristics and records an `AST_UNAVAILABLE` gap. Set `TEAMAI_SKIP_AST=1` to force heuristic-only extraction.

```bash
# Extract code facts and the graph from a local repo (writes <repo>/teamwiki/)
teamai codebase --extract /path/to/repo --project my-service

# Incremental refresh: reuse the original repository path and project slug
teamai codebase --extract /path/to/repo --project my-service --incremental

# Generate deep knowledge docs from extracted evidence (--output is the repository root)
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# Reconcile teamwiki/product and teamwiki/docs with extracted code pages
teamai codebase --reconcile --output /path/to/repo

# Check the local graph; --output is the repository root, not teamwiki/
teamai codebase --lint --output /path/to/repo
```

Changes queued in `.teamai/pending-review.jsonl` can be inspected with `teamai review`. Preview a decision with `teamai review <id> --apply --dry-run`, `teamai review <id> --reject --dry-run`, or `teamai review --all-apply --max-risk medium --dry-run`. Apply previews validate the target and managed section just like a real apply, but leave both documents and pending items unchanged. Batch previews retain the same kind/risk filtering. Decision previews with `--json` include `dryRun: true`; `ok` means the operation passed validation, not that it was written. Remove `--dry-run` to perform the decision.

When extract finds components, it writes `teamwiki/evidence/code/<project>/_manifest.json` even if AI enrichment is skipped or produces nothing, so `--deep-enrich` can start.

Without `--project`, `<project>` is the directory's name. At the root of a checkout, the main one or a linked git worktree, it is the repo's name: the main checkout's real name (also when opened through a symlink), or a bare repo's (`repo/.bare` or `repo.git` → `repo`). Every checkout of a repo writes the same entry. `teamai import --dir` picks its slug the same way.

**Wiki by namespace.** `recall` scopes `teamwiki/evidence/code/<slug>/` the same way it scopes docs: once any role (in `manifest/roles.yaml`) or project (in `manifest/projects.yaml`) lists a codebase slug under `resources.wiki`, it reaches only the members who have it active, and an undeclared slug stays shared:

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]     # evidence/code/svc-a/ only where svc-a is active
```

The slug is whichever one `teamai codebase --project <slug>` (or `teamai import`) wrote under `evidence/code/`; it has no required relationship to the manifest's project id, so declare the one the extraction actually used. Legacy mode (no role and no `projects.yaml`) searches every codebase, as before.

### Dashboard

```bash
teamai dashboard             # Start the web dashboard (default port 3721)
teamai dashboard --port 8080
```

The sidebar contains **Overview**, **Team Execution**, **Team Context** and **Team Improvement**. Overview summarizes the three modules. Execution shows this machine's sessions, filters by repository (every worktree of a repo is one entry) and AI tool, and opens complete session details. Context contains KB Health (including author contributions and never-recalled entries); Improvement contains local trends and the original promotion/archive/quality-update maintenance commands. Commands are displayed for use in your terminal; the dashboard does not execute them.

Use the header to select English or Simplified Chinese and light, dark, or system theme. Preferences are saved in browser storage when available. User prompts, AI output, knowledge titles and commands are not translated. The standalone `/kb-report` remains available as the original complete report.

Live status is **local**, using the existing events/SSE stream with automatic reconnect and a session reconciliation poll. Recently ended sessions remain visible for the existing 30-second retention window. Knowledge reports show their local/team scope and generation time, **not a claimed team sync time or cross-member live status**. A failed refresh is labeled and any previous result is retained until a successful retry.

Workspace selection covers installed project scopes and user scope; linked worktrees share a project, and the all-workspaces view shows every local session and the startup knowledge scope. Restart the dashboard to discover newly installed scopes.

#### Human Intervention Metrics

Each session row shows the **number of human interventions**. Hover over the count or open Details for the breakdown; each of the three signal types counts once:

| Type | Meaning | Data source |
|------|------|----------|
| `interrupt` | User pressed ESC to interrupt the agent mid-execution | An interrupted turn in the transcript |
| `toolReject` | User rejected a tool call (permission deny) | A tool_result marked as rejected in the transcript |
| `correction` | Within 60s after the agent stops, the user submits a follow-up prompt containing a correction keyword ("not right" / "redo" / "wrong" / 「違う」 / 「やり直し」 / etc. — Chinese, English and Japanese built in, plus any team keywords) | The stop → prompt_submit event pattern |

> Privacy: shared intervention statistics contain counts. The local dashboard event stream can retain secret-redacted prompt summaries (capped at 200 characters) and AI output for session details; `~/.teamai/debug.log` records the same redacted prompt summary. These are not uploaded by this page.

Keywords in a space-separated script (English, Spanish, ...) must appear as a whole word, so Spanish "segundo" does not count as `undo`. Chinese and Japanese keywords match as substrings. The built-in list covers only Chinese, English and Japanese; a correction typed in any other language is not detected until the team adds its own words in `teamai.yaml`. Team words are merged with the built-in list and matched case-insensitively under the same rules:

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, deshaz, "no era eso", "otra vez"]
```

The prompt is checked when the `UserPromptSubmit` hook captures it, so a change to the team keywords applies to new prompts after the next `teamai pull`; sessions recorded earlier are not re-evaluated.

Matching normalizes both the prompt and keywords to Unicode NFC. For example, `réessaye` matches `re\u0301essaye`, where `\u0301` is a combining acute accent. Accents remain significant, so `reessaye` does not match. Normalization applies only to matching and does not change the 60-second correction window. Correction detection uses the original prompt in memory; the original is then discarded, while the locally stored summary is secret-redacted and capped at 200 characters.

Intervention data is automatically aggregated and reported to the team's `stats/<user>.yaml` during `teamai pull`, and shown in the "Session Autonomy" leaderboard of `teamai digest`, with team averages and per-person intervention rate rankings — useful for verifying whether a skill/rule reduces intervention rates after rollout. Tools without a transcript (e.g. Cursor) degrade gracefully, tracking only `correction`.

#### Conversation Volume & Token Usage

Each session row also shows two columns; Details retains secret-redacted captured prompt summaries, Markdown AI output, timestamps and the last tool:

| Column | Meaning | Data source |
|------|------|----------|
| Prompts | The **number of human conversation turns** in the session (how many prompts were sent) | Count of `UserPromptSubmit` events |
| Tokens | The session's cumulative **token usage** (hover to see input / output / cache read / cache write breakdown) | Claude Code `message.usage`, CodeBuddy `requests[].usage`, or Codex's latest session-level `token_usage_record`; legacy `event_msg.token_count` snapshots are summed once per rollout file |

> Privacy: shared turn/token metrics contain counts only. Redacted prompt summaries and output in dashboard details remain on this machine.

These two metrics are likewise aggregated into `stats/<user>.yaml` (as `prompts` and `tokens` fields) during `teamai pull`, and shown in the "Conversation Volume & Token Usage" section of `teamai digest`, with team-wide totals, bucketed token totals, and per-person token usage rankings. Tools without transcript access (e.g. Cursor) degrade gracefully: turn counts are still tracked, while tokens show as 0 / N/A.

#### Daily Session Trends & Estimated Cost

The dashboard and digest compare the latest seven UTC calendar days with the seven days before them. The dashboard cost card now uses **average known estimated cost per priced session**: sum the available priced-request costs of sessions whose first Stop falls within the period, then divide by the number of those sessions with at least one priced request. Unpriced sessions are excluded; a priced zero-cost session is included. The card reports priced-session coverage. A resumed session keeps its first-Stop cohort and adds its available costs, even if a request occurred on another day. The original `avgRequestCostMicros` API field and digest request-day accounting remain unchanged. 

A session belongs to the day of its first stop event, while each priced request belongs to its own UTC request day. Active time counts only adjacent event gaps of five minutes or less, so idle terminals do not inflate the result. A session succeeds when it ends without an error, interruption, or correction; rejected tool calls remain a separate intervention signal. Privacy-safe request details (model, token counts, estimated cost, and price-table version; no prompt or response content) stay in `~/.teamai/dashboard/requests.jsonl`, are deduplicated across repeated Stop hooks, and are removed after 90 days.

Cost is an API-equivalent estimate for recognized Claude model IDs, based on versioned public list prices and the input, output, cache-read, and cache-creation token buckets in the transcript. Cache creation uses the five-minute write rate because transcripts do not expose cache TTL. Unknown models and tools without usage details are excluded from both estimated cost and its coverage denominator. This estimate is useful for trends, but it is not an invoice or a subscription-seat charge.

Daily aggregates are added to `stats/<user>.yaml` during `teamai pull`; existing cumulative fields remain available as lifetime statistics. Resumed sessions are updated in place without double-counting completed sessions. Only aggregate counts and estimated micro-dollar totals are shared with the team repository; prompt text and per-request records stay local.

### Session Save

`teamai session save` folds the dashboard's existing per-session event stream (tool sequence, prompt turns, interventions) into a compact, privacy-scrubbed markdown summary — no LLM call, no new collection path.

```bash
teamai session save                    # record the current agent session (else the most recent) locally
teamai session save --session-id <id>  # record a specific session
teamai session save --push             # also push a "valuable" session to the team repo
teamai session save --push --force     # push even a trivial session
teamai session save --push --include-prompt  # also include the (redacted) first-ask line
```

**Local (always):** appends to `~/.teamai/session-logs/<year-month>.md`. Idempotent per session (a session already recorded that month is skipped), and logs older than 90 days are pruned automatically. Each entry names the session's repo as `Project:`, the same for every worktree of the repo, and its working directory as `Directory:`.

Monthly log reads, full-session-ID deduplication and writes run under a cross-process lock, waiting up to five seconds before reporting a retryable error. Atomic replacement keeps the file complete; a read failure preserves the existing log. Team summaries use the same transaction.

**Team (`--push`, opt-in):** commits the summary directly (no PR) to `sessions/<user>/<year-month>.md` on the `teamai-reports` branch — the exact path `teamai digest` reads, so the session shows up under **Session Highlights**. Only a **valuable** session is pushed by default: one that shows friction (an interrupt / tool-reject / correction) or substantial tool use (≥ 3 distinct tools). Trivial sessions stay local unless you pass `--force`. On a read-only (HTTP-mode) team, `--push` fails gracefully and the local log is still kept.

> Privacy: the team-pushed payload is **counts + tool names only** by default. The first-ask prompt line is opt-in via `--include-prompt`, and even then it is run through the same secret redaction (`ghp_…` → `<REDACTED:…>`) used elsewhere. Local logs keep the redacted first-ask line since they never leave your machine.

### Hooks

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

### Team Hooks Declaration

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

### Agents Resource Type

The team repo can maintain custom subagent definitions under an `agents/` directory (one `*.yaml` or legacy `*.md` file per agent). Root-level files reach every member. One level of subdirectories scopes agents by role or project, the same way `rules/<namespace>/` works:

```text
team-repo/
  agents/
    code-reviewer.md              # Team custom subagent, shared with everyone
    frontend/vr-reviewer.yaml     # Only for roles/projects whose `agents:` lists `frontend`
    .removed                      # tombstone (auto-managed by teamai remove agents <name>)
```

```yaml
# manifest/roles.yaml (manifest/projects.yaml takes the same key)
roles:
  - id: frontend
    resources:
      knowledge: [common, frontend]
      skills:    [common, frontend]
      agents:    [common, frontend]   # optional; omitted = root-level agents only
```

Every namespace that takes effect — `knowledge`, `skills` and `agents` — becomes a
directory name, so it must be a single path segment: no `/`, `\`, `:` or control
character, no trailing `.` or space, and not a Windows device name, and no two
namespaces of one resource type may differ only by case — in `manifest/roles.yaml`
exactly as in `manifest/projects.yaml`, and across the two. A role's
`learnings:` is accepted for backward compatibility and ignored at runtime
(learnings are namespaced by project, not by role), so it names no directory and
is not checked.

`teamai pull` copies these into each Tier-1 tool's `agents/` directory (e.g. `~/.claude/agents/`), flattened by file name, so two active namespaces must not define the same agent name (pull reports the collision and leaves agents as installed for that run; the other resource types still sync). An agent in an active namespace replaces a root-level agent of the same name, and the root one comes back once that namespace stops being active. Without a configured role or project every namespace syncs, so a root-level and a namespaced agent of one name collide too. `teamai pull` writes `<name>.toml` for Codex tools, `<name>.json` for Kiro, `<name>.agent.md` for Copilot, and `<name>.md` for every other tool. 

When a member changes role, agents of the namespaces that stopped being active are removed on the next pull, unless the deployed copy was edited locally, in which case it is kept with a warning. Without a configured role, every agent syncs. `teamai push` resolves the source using the same active role and project namespaces as pull. It writes edits to that source and skips ambiguous destinations with a warning; an agent with only inactive sources is also skipped. Skipped agents do not block other resources in the same push. 

A new agent is placed the way a new skill is: `--role <ns>` or `--project <id>` (that project's `agents` namespace) names the directory, and with neither flag it resolves from the primary role's `agents` namespaces. It only stays at the shared root — where every member receives it — when no namespace resolves, and push warns when that happens (see [Push local resources](./member-guide.md#push-local-resources)). Cleanup checks each tool separately, respecting YAML `targets` and legacy format support. An active same-named agent protects a deployed file only when it targets that tool and output file. `teamai remove agents <name>` records a tombstone. 

A namespaced agent can be named as `<namespace>/<name>`; a bare name that only one namespace has resolves to it, and a bare name found in several places is refused, with the qualified names listed, rather than removed from all of them. The next pull on every other machine deletes `<name>.agent.md`, `<name>.md`, `<name>.toml` and `<name>.json` from each synced tool's agents directory. That cleanup also runs when the pull finds the team repo unchanged. 

Removing a namespaced agent tombstones `<namespace>/<name>` only, so the same name in another namespace is untouched; a member's flattened `<name>` copy is cleaned, and not pushed again, when it can be that agent's copy (the namespace is active for them, or their machine placed the agent) and their directory does not still receive an agent of that name from another active namespace. A member who never had that namespace keeps their own agent of the same name. The CLI's built-in `teamai-recall` profile is deployed alongside team agents but is not uploaded by `teamai push`.

A YAML agent carries tool-specific fields under `tool_extras.<tool>`, and each tool receives only its own key: `tool_extras.claude` reaches Claude alone, `tool_extras.qoder` reaches Qoder, and Qoder CN, ZCode and OMP read `tool_extras.qoder-cn`, `tool_extras.zcode` and `tool_extras.omp`. tclaude and tcodex also receive the fields of `tool_extras.claude` and `tool_extras.codex` that `tool_extras.tclaude` and `tool_extras.tcodex` do not set. `teamai push` writes an edit back to the key that tool reads; for tclaude and tcodex it writes only the values that differ from the base tool's, and skips, with the reason, an edit that removes a field the tool inherits, since only the base tool's key can drop it.

#### Model aliases

A YAML agent can name a kind of model instead of a model: `model: strong`, `model: fast`, or an alias the team defines. The team maps each alias per tool in an optional `models/aliases.yaml`, in the tool's own model value, with an optional reasoning effort:

```yaml
# models/aliases.yaml
aliases:
  strong:
    claude: [{ model: opus, effort: high }, { model: fable }]
    codex:  { model: gpt-6-sol, effort: high }
    opencode: anthropic/claude-opus-5-5
    cursor: "claude-opus-5[effort=high]"
  fast:
    claude: haiku
    codex:  { model: gpt-6-luna, effort: low }
  reviewer:
    claude: [{ model: opus, effort: max }]
```

- `strong` and `fast` are always aliases, and TeamAI ships no models for them. A team adds its own names, which start with a lowercase letter followed by lowercase letters, digits or hyphens. Any other `model`, such as `opus`, is written as is.
- A tool entry is one option or an ordered list of them; only the first is used for now. An option is a model string or `{ model, effort }`.
- Each tool receives the model in its own model field and the effort in its own effort field, and no other tool's keys:

  | Tool | Model | Effort field |
  |---|---|---|
  | Claude, claude-internal, tclaude | as written | `effort` |
  | Codex, codex-internal, tcodex | as written | `model_reasoning_effort`, only when the mapping sets one |
  | OpenCode | as written (`provider/model`) | `variant` |
  | CodeBuddy, Qoder, Qoder CN | as written | `effort` |
  | Cursor | as written, including the bracket form `claude-opus-5[effort=high]` | none; write the effort in the brackets |
  | Copilot | the first entry, as one model string | none |
  | Kiro, WorkBuddy, JoyCode, ZCode, OMP | as written | none |

- An `effort` mapped for a tool with no effort field is dropped: the tool receives the model alone, and pull warns once, naming the alias and the tool, when it delivers an agent that uses the alias to that tool.
- claude-internal and tclaude use the `claude` entry, codex-internal and tcodex the `codex` entry, and Qoder CN the `qoder` entry, unless the alias has a key of their own. No other tool inherits an entry: Qoder, ZCode, OMP and JoyCode never receive the `claude` model.
- A tool the alias does not map gets no `model` field, so it runs the agent on its default. Without `models/aliases.yaml`, `strong` and `fast` give no model field in any tool.
- `tool_extras.<tool>.model` pins that tool to a concrete model and skips the alias, its effort included. An effort field in `tool_extras.<tool>` without a model overrides only the alias's effort, and a tool switched to a model profile does not receive it.
- A `model` that is not a string is rejected when the agent is read. A legacy `agents/<name>.md` is copied as is, so pull warns when its `model` is an alias.
- A structural error fails the whole file: YAML that does not parse, a value of the wrong type, an alias name that breaks the naming rule, an option with `effort` and no `model`, `~`, or top-level keys without `aliases:` (such as a misspelled `alias:`; an empty file, one with only comments, and an empty `aliases:` define no aliases). Until it is fixed, pull warns, naming the file, and holds every agent with a `model` field (an unreadable file may define any name) in each tool without `tool_extras.<tool>.model`: deployed copies stay, new ones are not written, and the models pull recorded for them stay as they were. Push skips those agents and says why; everything else pushes. 

  Once the file is fixed, an ordinary `teamai pull` delivers the held agents, including ones it never deployed and team changes to them that arrived meanwhile: a pull that holds an agent, on an unchanged team repo too, does not count the team revision as synced, so the next pull syncs in full. `teamai pull --dry-run` names the agents it would hold.
- Anything else this CLI does not know is dropped with a warning, and the rest of the file applies: a tool key that is not a tool teamai knows, an option field other than `model` and `effort` (the entry is used without it), and an alias named like a tool's own model alias (`opus`, `sonnet`, `haiku`, `fable`, `inherit`, `default`, `auto`, `lite`, a short best-effort list), which is ignored so that `model: opus` stays `opus`. A `gateways` key inside an alias is reserved for a later version and ignored without a warning. Pull prints each warning once, and only when it delivers an agent that uses that alias; a warning about one tool's entry, only when that tool reads the entry.
- Pull records the model and effort each agent copy received, so an ordinary `teamai pull` applies a change even when the team repo has not moved, such as the first pull after upgrading from a CLI that wrote `model: strong` as is. It rewrites only the agents whose model changed, a copy that is missing, and a copy an older CLI rendered differently that you have not changed since. A copy you edited is kept, and pull names it on each such pull with how to take the new model. When the alias an agent used is removed, pull warns that its `model` is now written as is, also where the alias gave that tool no model field.
- `default` in `models/aliases.yaml` is a model value like any other and is written as is, which is CodeBuddy's own value for its default model. `~` there is an error: leave the tool out to give it no model field.

##### Adopting aliases

Only a CLI that knows model aliases resolves them, so a team adopts them in two steps:

1. Everyone updates teamai to a version with model aliases. Nothing changes yet: an agent with a concrete model or none is written as before.
2. Then the team adds `models/aliases.yaml` and moves agents to `model: strong`, `model: fast` or its own aliases, in the team repo or by writing the alias name in a deployed copy and pushing.

An older CLI ignores `models/aliases.yaml` and writes `model: strong` into every tool as is, a model no tool knows. Its `teamai push` also reads a model changed in a deployed copy as an edit, so it can replace `model: strong` in the team's agent with a concrete model such as `opus`. TeamAI does not check versions, so updating first is the only protection. The first ordinary `teamai pull` after a member updates replaces a literal `model: strong` with what the alias resolves to.

##### Namespaced aliases

A role or project gives an alias its own meaning in `models/<ns>/aliases.yaml`, same shape, read where `<ns>` is active in `resources.models` of your roles or projects, as `models/<ns>/models.yaml` is. Legacy mode (no roles, no projects) reads `models/aliases.yaml` alone.

- A namespace alias replaces the root alias of the same name whole: a tool it does not map gets no `model` field, even when `models/aliases.yaml` maps that tool.
- The same alias in two active namespaces holds agents with a `model` field, as a structural error does, and pull names both files. Rename or remove it in one of them, or stop declaring one of the namespaces.
- A name that any aliases file in the team repo defines, root or namespace, active for you or not, is an alias. An agent whose alias only an inactive namespace defines gets no `model` field, rather than the name as written, and your local entry for that name still applies. Pull warns once per such alias when it delivers an agent that uses it, naming the files: activate the namespace if the alias should apply to you, or rename the alias if its name was meant as a concrete model, such as `gpt-5-codex`.
- For the same reason, a structural error in any aliases file of the team repo, including one in a namespace that is not active for you, holds agents with a `model` field, and pull names that file.
- Pull warnings and push drift name the file an entry comes from, such as `models/checkout/aliases.yaml`. `teamai doctor` notes an alias that agents you receive use when a namespace that is not active for you also defines it.

##### Local override

A member replaces a team entry on their own machine in `~/.teamai/models/aliases.yaml`, which has the same `aliases:` shape:

```yaml
# ~/.teamai/models/aliases.yaml
aliases:
  strong:
    codex: { model: gpt-6-astra, effort: xhigh }
  fast:
    codex: default          # Codex uses its own default for fast
```

- For each tool, the order is: `tool_extras.<tool>.model`, then your entry, then the team entry, then no model field. A tool switched to a model profile filters the result of your entry or the team entry, as described next. Your entry replaces the team's whole entry for that tool, effort included, so `codex: gpt-6-astra` gives Codex no effort even when the team maps one.
- `~` or `default` for a tool gives it no model field and no effort, whatever the team maps.
- A key is a reserved name (`strong`, `fast`) or an alias the team defines, and a value can be any model. You can map `strong` before your team has a `models/aliases.yaml`. A name that is neither has no effect, since the file serves every team on the machine.
- claude-internal and tclaude use your `claude` entry, codex-internal and tcodex your `codex` entry, and Qoder CN your `qoder` entry, unless you give them their own. Your `claude` entry wins over the team's `tclaude` entry.
- The file is one per machine: it applies in every scope (user and each project checkout) and to every team that uses the alias name.
- An ordinary `teamai pull` applies an edit to the file, even when the team repo has not moved.
- The file follows the same rules as the team file, `~` aside, with one difference: a structural error holds only the agents whose `model` is an alias, since this file can make no name an alias, and the warning names the file by its path. Agents with a concrete model are delivered and pushed as usual. An entry this CLI does not know is dropped with a warning.

##### Tools switched to a model profile

A tool you switched with `teamai models switch` sends its requests to the profile's gateway, which does not know your account's models. For an agent whose `model` is an alias, pull therefore writes only what the switch can route:

- Claude keeps a resolved `opus`, `sonnet` or `haiku`, from your entry or the team's, because the switch points each of these families at a gateway model. Any other model is dropped.
- Codex, OpenCode, CodeBuddy and WorkBuddy get no `model` field.
- No switched tool gets an effort, neither the alias's nor one set in `tool_extras.<tool>`, unless `tool_extras.<tool>` also pins a model.

No `model` field means the tool's native inheritance, not the profile's model: Codex, for example, uses `[agents].default_subagent_model` when your config sets one, otherwise the model of the session that starts the agent. `tool_extras.<tool>.model`, a concrete `model` such as `opus`, and your `~` or `default` are written as they are without a switch. The Claude and Codex variants (claude-internal, tclaude, codex-internal, tcodex) are never switched. A tool counts as switched only while its live settings path (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...) is the one the switch recorded and those settings still hold what TeamAI wrote, the same checks `teamai models restore` makes. 

While TeamAI cannot read its switch records (`~/.teamai/models/managed.json`), pull warns and holds alias agents in the five tools `models switch` supports; while it cannot read one switched tool's settings, in that tool only. An ordinary `teamai pull` after `teamai models switch` or `teamai models restore` rewrites the affected agents.

##### Push

For an agent whose `model` is an alias, each tool's `model` and the effort field the alias writes belong to the alias, not to the copy:

- A copy with the model and effort the last pull wrote, or the ones a pull would write now, is unedited. So pushing before you pull a change to `models/aliases.yaml`, your override or a switch reports nothing, and push's warning about a kept copy whose deployed version changed ignores such a change.
- Push never replaces `model: strong` with a concrete model and never writes the alias's effort into `tool_extras`. A model or effort you changed by hand in a copy is drift: push names the copy and where the value comes from, leaves the change out, and says where to make it: your override file for an entry that comes from it, your override file or the team aliases file the alias comes from (`models/aliases.yaml` or `models/<ns>/aliases.yaml`) for a team entry or an unmapped tool, `teamai models restore --agent <tool>` for a switched tool. `teamai push --dry-run` reports it too. Your other edits to that agent, such as its instructions or other fields, still push.
- To move an agent to another alias, write the alias name in a deployed copy, such as `model: fast` in place of `opus`, or `model: strong` in an agent that set `model: opus`, and push: push proposes `model: <alias>`. In a tool whose `tool_extras.<tool>.model` pins the model, the copy does not adopt an alias; a changed value there is reported as drift on that pin. Two copies that name different aliases conflict, as any two different values do.
- A new agent that exists only in a tool's directory is pushed with the model it has there, which is never turned back into an alias.

##### Checking with doctor

`teamai doctor` answers "why does Codex run this model". For each agent whose `model` is an alias, it prints a note with one line per installed tool the agent targets: the model and effort the tool receives, and in brackets the step that decided it. Agents and tools that resolve alike share a line; agents with a concrete model or none are left out, since they are written as their spec says.

```text
models: how model: strong resolves for agents implementer, planner:
    claude: opus, effort high  [team: models/aliases.yaml]
    codex: gpt-6-astra, effort xhigh  [local: /home/me/.teamai/models/aliases.yaml]
    opencode: tool default  [default: models/aliases.yaml does not map opencode]
```

| Step | Meaning |
|---|---|
| `extras` | `tool_extras.<tool>.model` pins the model; the alias is skipped |
| `switched` | the tool is switched to a model profile: Claude keeps `opus`, `sonnet` or `haiku`, other tools get no model field and pick one natively |
| `local` | your entry in `~/.teamai/models/aliases.yaml`; `tool default (chosen in <path>)` is your `~` or `default` |
| `team` | the team entry, in the file named |
| `default` | no model field: the alias does not map the tool, or no active aliases file defines it |

- A Codex-family line with a model and no effort says so: the effort of the session that starts the agent carries over.
- When the last pull deployed something else, such as before you pull an edit to your override, the line names what is deployed; an ordinary `teamai pull` updates it, and `Agents delivered to <tool>` lists the agent as `model changed since the last pull` without failing.
- Every entry an aliases file sets that this CLI drops is a note too.
- `Agent model aliases can be resolved` fails while a structural error in any aliases file (active or not, your own included), one alias in two active namespaces, or a switched tool whose settings cannot be read holds agents. It names the reason, the file and the held agents, as pull's own warning does.

### GitHub Copilot CLI

GitHub Copilot CLI is supported for its official custom-instructions, Rules, Skills, custom-agent, hooks, and MCP surfaces, plus TeamAI Docs and Env delivery:

- **Scopes.** User resources live below `$COPILOT_HOME` (default `~/.copilot`); project resources live below `<project>/.github`. TeamAI honors `COPILOT_HOME` for detection and every user-scope read or write.
- **Skills.** `teamai pull` writes user skills to `$COPILOT_HOME/skills/` and project skills to `.github/skills/`. Edits in either scope are detected by `teamai push` like other TeamAI skills.
- **Custom instructions.** TeamAI injects team culture and shared instructions into `$COPILOT_HOME/copilot-instructions.md` for user scope or `.github/copilot-instructions.md` for project scope. Marker-delimited TeamAI blocks are replaced idempotently, while text outside the markers remains user-owned. `teamai uninstall` removes only the managed blocks. With `sharing.gitExclude` on, the project blocks go to `.github/instructions/teamai-context.instructions.md` instead, and `.github/copilot-instructions.md` stays the team's (see [Where the blocks go](./team-culture.md#where-the-blocks-go)).
- **Rules.** Team rules become native `*.instructions.md` files under `$COPILOT_HOME/instructions/` or `.github/instructions/`. TeamAI derives Copilot's required `applyTo` frontmatter from the team rule's `paths`; a rule without `paths` uses `**`. On push, only the Markdown body flows back, preserving the team-owned `paths` metadata. Unknown Copilot instruction files remain user-owned and are not uploaded or deleted. Copilot CLI 1.0.89 and later also reads a project's `.claude/rules`, so with Claude enabled each project rule reaches Copilot twice; teamai still writes both copies, as it does for every tool that also reads another tool's files.
- **Custom agents.** Team agents become official `<name>.agent.md` profiles under `$COPILOT_HOME/agents/` or `.github/agents/`. TeamAI maps compatible tool names onto Copilot's primary aliases, preserves Copilot-only frontmatter through `tool_extras.copilot`, and removes only profiles that match team agents or the built-in recall profile. User-authored profiles remain untouched. See [GitHub's custom-agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
- **Team Context recall.** The built-in `teamai-recall.agent.md` profile receives only `execute`, `read`, and `search`. It invokes the existing `teamai recall` pipeline, so Copilot can retrieve learnings, codebase evidence, and teamwiki results without copying or creating a second knowledge store.
- **Docs and Env.** Team docs sync to the configured local docs directory (`~/.teamai/docs` by default, or the project-relative equivalent in project scope). Team env values sync to the scope's managed `env.sh`; launch Copilot from a shell that has sourced that file. TeamAI does not copy environment values into Copilot configuration.
- **Hooks and private telemetry.** TeamAI writes a dedicated version-1 hook file at `$COPILOT_HOME/hooks/teamai.json` or `.github/hooks/teamai.json`. It uses Copilot's VS Code-compatible PascalCase events (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, and `SessionEnd`) so hook payloads retain the snake_case fields consumed by TeamAI, and emits `bash`, `powershell`, and fallback `command` fields. Session IDs, skill usage, prompt counts, lifecycle state, and final token totals feed the local dashboard. Copilot prompt text, assistant output, transcript paths, and request metadata are never stored; if final token counters are absent, the session is still recorded without token data. 

  For resumed sessions, TeamAI records a path-free log byte boundary at SessionStart and captures a marker already present only when it is neither closed nor claimed by the previous run. Shutdown counters must link to that marker or to one written after the boundary. If a marker appears only after SessionStart and SessionEnd has no provider timestamp, its run cannot be proven and the session remains recorded without token data. The file is reconciled idempotently while preserving unrelated entries. TeamAI never edits Copilot's `settings.json`.
- **MCP.** `teamai pull` and `teamai mcp inject` merge local and remote servers into `$COPILOT_HOME/mcp-config.json` or `.github/mcp.json` using Copilot's native schema. TeamAI tracks ownership outside the Copilot file, so repeated pulls are idempotent and `mcp remove` or uninstall removes only TeamAI-owned entries. Hand-authored servers and `settings.json` remain unchanged.

Team hooks still come from the team's `hooks/hooks.yaml`: edit that source in the team repository and use the normal pull/push workflow. TeamAI does not reverse-import arbitrary native hook entries from a Copilot configuration file.

### OpenCode

[OpenCode](https://opencode.ai) is supported as a first-class tool. Because its config layout differs from the Claude family, teamai handles a few things specially:

- **Scopes.** OpenCode's user config lives under `~/.config/opencode/` while its project config lives under `<project>/.opencode/` — a different prefix from every other tool. teamai writes to the correct one per `--scope`, and only ever touches OpenCode files when OpenCode is actually installed for that scope (it never creates `~/.config/opencode/` for a non-user). Hooks are the one exception — they are always user-scoped, for the reason described below.
- **Skills** land in `.opencode/skills/` (project) or `~/.config/opencode/skills/` (user). OpenCode also reads `.claude/skills` natively, but teamai writes the OpenCode path too so an OpenCode-only user still gets them.
- **Subagents** are rendered into OpenCode's own `agents/*.md` format: frontmatter carries `description` + `mode: subagent` (plus `model` and any `tool_extras.opencode` fields such as `temperature`); the agent name comes from the filename. OpenCode does **not** read `.claude/agents`, so this native copy is required.
- **Rules** are copied into `.opencode/rules/` (or `~/.config/opencode/rules/`), but OpenCode does not auto-scan a rules directory — the files are inert until referenced. teamai therefore adds globs to the `instructions` array in `opencode.json` and removes them again when the team's last rule goes away, editing only that one key and leaving your own `instructions` entries untouched. In a project that is `.opencode/rules/**/*.md` in `.opencode/opencode.json`, beside the team instructions entry; OpenCode globs a relative entry from the session's working directory and each parent up to the worktree, so it loads the namespaced rules from anywhere in the project. 

  A pull removes the `.opencode/rules/*.md` an earlier release wrote to the root `opencode.json`, which loaded no namespaced rule, and leaves that file's other keys alone. In user scope it is the absolute `~/.config/opencode/rules/*.md` plus one glob per namespace directory a rule lands in (`~/.config/opencode/rules/<ns>/*.md`): OpenCode resolves a relative entry from the session's working directory, and globs only the file name of an absolute one, so `**` never matches. A pull replaces the relative `rules/*.md` an earlier release wrote, which loaded the project's `rules/` instead, and drops a team namespace's glob once its rules no longer reach you; a glob you added for a directory of your own stays. 

  OpenCode ignores `paths:`: it applies every rule it loads to every file. `uninstall` removes the globs, and deletes a `.opencode/opencode.json` left with nothing else in it.
- **Hooks** are delivered as an OpenCode *plugin*, not a settings-file entry — OpenCode has no `hooks` array; it auto-loads JS/TS plugins from **both** `~/.config/opencode/plugin/` and `<project>/.opencode/plugin/`. A plugin present in both dirs is loaded twice and would dispatch every event twice, so teamai keeps exactly one copy: `teamai-hooks.ts` in the user dir, which covers every project. Any project-scope copy left by an earlier layout is deleted on the next sync. This matches the other tools, whose `settings.json` hooks also live in HOME and gate on the `cwd` handed to `hook-dispatch`. The plugin subscribes to OpenCode's own events and shells out to the same `teamai hook-dispatch` entry point every other tool uses. 

  On V1, the event mapping mirrors the Claude built-in set: `session.created` → session-start, `session.idle` → stop, `chat.message` → prompt-submit, `tool.execute.after` → post-tool-use. The plugin forwards the same STDIN payload other agents send (`cwd`, `session_id`, `tool_name`, `tool_input`, `prompt`, and on post-tool-use the tool's output and status), and maps OpenCode's lowercase tool ids (`skill`, `todowrite`) back to the PascalCase matchers the handler registry expects. OpenCode cannot inject a hook's stdout back into the session, so hooks run purely for their side effects (status report / sync / update). 

  Note that OpenCode *awaits* its named hooks (`chat.message`, `tool.execute.after`), so those dispatches briefly wait on the `teamai` subprocess before the agent continues; the errors are always swallowed so a hook can never fail the session. Server-pushed agent hooks (`teamai-agent-<slug>.ts`) install into the same user plugin dir. Upvote **adoption** runs for OpenCode from the recall log, not a transcript: on V1 the plugin's `shell.env` hook sets `TEAMAI_AGENT_SESSION_ID` in the bash tool's environment, so a `teamai recall` run there joins the session its hooks carry, and a `task` call links the subagent's child session to its parent, so a doc the parent opens after a subagent's recall is upvoted. 

  The opt-in LLM-judge needs a transcript, which `session.idle` does not carry, so it does not run for OpenCode, and the "adopted team knowledge" summary is never shown, as hook stdout is discarded.

  Both built-in and server-pushed hooks support OpenCode **1.18.23** and **V2** (verified with 2.0.23). Each plugin default-exports one definition: V1 calls `server`, V2 calls `setup`. V2 maps `session.prompt` and `tool.execute.after` to the same dispatches, normalizes `shell` / `subagent` to `bash` / `task`, and uses the host's native `OPENCODE_SESSION_ID` for shell recall attribution. Lifecycle subscriptions are scoped to the plugin's directory and cancelled on unload. After upgrading TeamAI, run `teamai hooks inject` or `teamai pull` and restart OpenCode to replace old plugins that report “Plugin must export a default definition”.
- **Rules and instructions on V2.** OpenCode V2 parses `instructions` but loads none of its files, so the rule globs and the team instructions entry above reach only V1. On V2 the same `teamai-hooks.ts` plugin adds them itself: its `setup` registers a session `context` hook, and the same text on compaction, that reads `~/.config/opencode/teamai-context.md` and `~/.config/opencode/rules/**/*.md` in every directory, then walks up from the session's directory to the nearest `.opencode/` holding `teamai-context.md` or `rules/` and adds that `teamai-context.md` and every `.opencode/rules/**/*.md`, sorted by path. It reads the files on each request and does not call `teamai`. V1 delivery through `instructions` is unchanged. 

  Because the plugin carries them, `teamai hooks remove` also takes the team rules and instructions away from V2 sessions. `teamai doctor` runs `opencode --version` (missing or unreadable counts as V1); on V2 `Team rules are active in opencode` and `opencode adds the team instructions to its prompt` check that the plugin is installed as this teamai writes it, instead of checking `instructions`.
- **MCP** servers live under the `mcp` key of the shared `opencode.json` (see the MCP section above).
- **OpenCode V2 with the git exclude option on.** While `sharing.gitExclude` is on (see [Keeping Delivered Files Out of Git](./member-guide.md#keeping-delivered-files-out-of-git)), `opencode --version` reports V2 (asked once per command; missing or unreadable counts as V1), and the pull has installed teamai's plugin as this teamai writes it, nothing of teamai's goes into the project's opencode.json files. The pull writes the team MCP servers to `.opencode/teamai-mcp.json`, a file of teamai's alone, listed in the git exclude block, and written only once the git exclude block holds it when it would carry a resolved value. The plugin reads it when OpenCode opens the project (the same walk up to the nearest `.opencode/`, which now also stops at one holding only that file) and adds those servers to that project only. The pull then takes teamai's MCP servers out of the root `opencode.json` and its `instructions` entries out of `.opencode/opencode.json`, servers and entries written before an upgrade included, and deletes a file left with nothing in it. It does so only where git does not track the file, and keeps your own servers, entries and keys there: a file the team commits is left as it is, and `teamai doctor` names it under `No OpenCode V1 entries are left in shared config files`. V2 ignores those `instructions` and loads those servers a second time; remove teamai's entries yourself once nobody on the project uses V1. The pull rewrites a plugin from an older teamai before it decides, so the move happens in that same pull. Without a current plugin (it could not be written, a tool was skipped for having no shell, or after `teamai hooks remove` until the next pull reinstalls it) the pull keeps the V1 entries, since they are then all V2 gets, and `teamai doctor` says so next to the missing plugin. Back on V1, or with the option off, the next pull writes the V1 entries again and removes `.opencode/teamai-mcp.json`. This teamai's plugin differs from earlier ones, so `teamai doctor` reports the plugin out of date on V2 until the next `teamai pull` or `teamai hooks inject`, and the plugin reads the servers when OpenCode opens a project: restart OpenCode after a pull changes them.

### Pi Coding Agent

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) is supported through its documented skills, instruction, and extension surfaces:

- **Scopes.** Project skills are written to `.pi/skills/`, user-scope skills to `~/.pi/agent/skills/`. Pi reads no rules directory, so teamai writes it no rule files: the user-scope team rules are a block in `~/.pi/agent/AGENTS.md`, and in a project the TeamAI Pi extension adds the project's team rules to each run's system prompt, both without path scoping. A pull removes the unedited copies earlier releases left in `.pi/rules/` and `~/.pi/agent/rules/` and names the ones you edited.
- **Instructions.** Pi reads the project's own `AGENTS.md` (or `CLAUDE.md`); TeamAI leaves it unchanged. User-scope team instructions go to `~/.pi/agent/AGENTS.md`. In a project, the TeamAI Pi extension asks `teamai` for the member's team instructions and the project's team rules when the session starts and adds them to the system prompt of each run; Pi rebuilds that prompt for every run, so they do not pile up.
- **Hooks.** TeamAI generates one user-scoped `teamai-hooks.ts` under `~/.pi/agent/extensions/`. It maps `session_start` → session-start, `before_agent_start` → prompt-submit, and `agent_settled` → stop; `tool_execution_start` caches the tool's input, and `tool_execution_end` dispatches post-tool-use forwarding that cached input as `tool_input`, plus the result's text as `tool_response` and a `tool_status` from its error flag. Every event carries the Pi session id (`ctx.sessionManager.getSessionId()`), the same id Pi's bash tool exports as `PI_SESSION_ID`, so a `teamai recall` run there joins the session its hooks carry and upvote **adoption** runs for Pi. Pi loads both user and project extension roots, so TeamAI never creates a project copy — a second copy would double-dispatch every event, the same single-copy policy as the OMP adapter. 

  An older TeamAI-managed project copy is removed during the next sync, and injection never overwrites a same-named file that lacks the TeamAI marker. Pi has no settings file for self mode to commit, so a fresh clone still needs one `teamai init`/`pull` on that machine before Pi hooks are active there. The explicit `teamai hooks remove` command and user-scope `teamai uninstall --agent pi` delete this shared extension. Project uninstall preserves it for other projects and removes any legacy project copy; files without the TeamAI marker are never removed. `teamai hooks list` always reports this global path. 

  Pi profile overrides (`PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported for hooks — same as the OMP adapter — and the default `~/.pi/agent/` layout is used. Model profiles are separate and do read `PI_CODING_AGENT_DIR`. The shared extension remains installed after project uninstall; instruction dispatch checks the project's tool exclusion before adding its instructions.
- **Team hooks boundary.** The Pi adapter installs only the built-in lifecycle bridge. Custom team hooks and built-in hook overrides declared in `hooks/hooks.yaml` are skipped with a warning. Full team-hook and per-project ownership semantics require a separate cross-adapter design and are deferred to a follow-up PR.
- **Server-pushed agent hooks.** HTTP-source hooks are installed as `teamai-agent-<slug>.ts` extensions in the same global extension directory. Unsupported lifecycle events are skipped with a warning.
- **MCP (Pi 0.99.0+).** Supports stdio and streamable HTTP; SSE is skipped. User configuration goes to `~/.pi/agent/mcp.json`, project configuration to `.pi/mcp.json`; Pi loads project configuration only after trusting the project. The native `codemode` default is retained, without forcing direct exposure; timeout values in `mcp.yaml` are converted from milliseconds to seconds. Local exposure/enabled changes to managed entries survive unchanged team definitions but are replaced when the team definition changes; doctor compares complete entries and reports these local differences. An extension taking over `/mcp` can disable built-in MCP; remove that extension to use the built-in support.
- **Subagents.** TeamAI custom subagent files are not supported.

### Qoder

Qoder is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.qoder/skills/`, `.qoder/rules/`, and `.qoder/agents/`. Hooks and MCP servers are merged into the scope-specific `.qoder/settings.json`, preserving unrelated user settings. The paths match Qoder's user and project configuration contracts.

Rules are written in the form Qoder Desktop writes, which Qoder CLI also reads: a rule with `paths:` gets `trigger: glob` and one unquoted `glob:` line of comma-separated globs, with each `{a,b}` alternation expanded into separate globs because the line is split on every comma; a rule without `paths` gets `trigger: always_on`. Qoder publishes no schema for this frontmatter; the form comes from Desktop's rule files in `alibaba/tron-one-agent`.

Qoder CN is a separate distribution that keeps its **user** directory at `~/.qoder-cn` instead of `~/.qoder`, so it is a separate built-in target (`qoder-cn`) rather than part of `qoder`. Only the user scope differs: user-scope resources go to `~/.qoder-cn/{skills,rules,agents}` and hooks/MCP to `~/.qoder-cn/settings.json`, while project-scope resources keep Qoder's `<project>/.qoder/` layout. It reads the same Claude-compatible resource formats, so content is identical and only the user-scope root changes. Install both editions and TeamAI syncs each one to its own user directory; neither needs a symlink. 

In a project Qoder and Qoder CN both read `.qoder/rules/`, so they share one copy there: uninstalling one keeps it while the other is installed, and `doctor` checks it once, as `Rules delivered to qoder, qoder-cn`. Each edition counts as installed by its own HOME root (`~/.qoder` / `~/.qoder-cn`) or an explicit `--agent` entry, as the Trae builds do — the shared project `.qoder/` installs neither by itself.

### Kiro

Kiro is available as a built-in target. TeamAI deploys skills, rules, and subagents to `.kiro/skills/`, `.kiro/steering/`, and `.kiro/agents/`, matching [Kiro's documented layouts](https://kiro.dev/docs/skills/) for workspace skills, [steering](https://kiro.dev/docs/steering/), and custom agents. Subagents are rendered as JSON so they work with both Kiro CLI 2.x and 3.x. Each rendered agent preserves Kiro-specific fields and custom hooks, and adds a managed `hooks.agentSpawn` command that dispatches TeamAI's `session-start` event when that custom agent is activated in an interactive CLI session. 

This verified CLI 2.x hook is embedded in `.kiro/agents/*.json`, not written to the standalone `.kiro/hooks/` surface introduced for IDE 1.x and CLI 3.x; Kiro's in-memory built-in default agent cannot be modified, and `--no-interactive` does not fire `agentSpawn`. MCP servers merge into the scope-specific `.kiro/settings/mcp.json` (see the MCP section above).

Rules are steering files with Kiro's inclusion frontmatter, in `.kiro/steering/` and `~/.kiro/steering/`: a rule with `paths:` gets `inclusion: fileMatch` and `fileMatchPattern` as a list of its globs; a rule without `paths` gets `inclusion: always`. Kiro reads only the top level of a steering directory ([kirodotdev/Kiro#10448](https://github.com/kirodotdev/Kiro/issues/10448)), so a namespaced rule is written flat, as for [Oh My Pi](#oh-my-pi): `rules/fe/style.md` becomes `fe.style.md`, and `push` sends an edit of that file back to `rules/fe/style.md`. 

Push requires a delivery record for that flat copy; a personal file with the same name is neither refreshed before push nor offered as an edit of the team rule. A namespaced rule whose flat name another rule you receive also has is not written, and a file of your own with a team rule's flat name is never overwritten or removed. An older nested `<ns>/<name>.md` copy is removed once its flat copy is written, unless you edited it: then it is kept and named, since Kiro does not read it. 

Kiro's own `product.md` is not a team rule, so `pull` leaves it. Kiro CLI loads every steering file whatever its `inclusion` ([kirodotdev/Kiro#7950](https://github.com/kirodotdev/Kiro/issues/7950)), so a scoped rule is always on there. 

The Kiro IDE once ignored `fileMatch` in `~/.kiro/steering` ([kirodotdev/Kiro#9176](https://github.com/kirodotdev/Kiro/issues/9176), Kiro 0.12); a maintainer reported fixes since, and the report closed without a retest.

### Trae

Trae and Trae CN are available as built-in targets. TeamAI deploys skills to `.trae/skills/` and rules to `.trae/rules/`, matching [Trae's documented layouts](https://docs.trae.ai/ide/rules). Only the user directory differs on the CN build (`~/.trae-cn` instead of `~/.trae`, as for Qoder CN): a project keeps one shared `.trae/` for both, while a user-scope pull delivers `~/.trae/skills/` and `~/.trae/user_rules/` for the international build and `~/.trae-cn/skills/` and `~/.trae-cn/user_rules/` for the CN one — Trae names its user rules directory `user_rules`, not `rules`. Trae has no settings-based hooks surface and no subagents directory, so those resources stay unsynced and you run `teamai pull` manually, as for JoyCode. MCP servers merge into the project's `.trae/mcp.json` in the Claude `mcpServers` shape (see the MCP section of the sharing guide); both builds' targets map that one file under a single shared ownership record, so either edition's pull updates and cleans it, and a server scoped by `tools:` to one edition stays while either targets it. Trae keeps user-level MCP next to its user settings in a platform-specific directory, so no user file is written.

Each build counts as installed by its own HOME root (`~/.trae` / `~/.trae-cn`) or by an explicit `--agent` entry naming it — the shared project `.trae/` says nothing about which edition runs (as WorkBuddy is counted by `.workbuddy/`), so no half of the pair stays a "phantom sibling" that retains or resyncs the other's files. In a project both builds read the same `.trae/skills/` and `.trae/rules/`, so they share one copy of each there: uninstalling one keeps both while the other is installed.

Rules are `.md` files with Trae's frontmatter: a rule with `paths:` gets `globs: a, b` unquoted — Trae's parser takes the line as it stands and splits it on every comma — plus `alwaysApply: false`; a rule without `paths` gets `alwaysApply: true`. Trae reads rules up to three directory levels deep, so a namespaced rule keeps its `fe/style.md` shape. On `push`, only the Markdown body flows back, and a rule file there with no matching team rule is yours: `pull` leaves it and `push` never offers it as a new team rule.

### CodeBuddy and WorkBuddy

WorkBuddy runs CodeBuddy's engine, so both get rules in CodeBuddy's format: a rule with `paths:` gets `alwaysApply: false` and `paths:` as a YAML block list, one quoted glob per item; a rule without `paths` gets `alwaysApply: true`. CodeBuddy's frontmatter parser reads lines, not YAML, so the inline `paths: ["a", "b"]` a verbatim copy carried reached it as globs with the brackets in them. In a project both tools read `.codebuddy/rules/`, so that directory holds one copy of each rule for both: excluding or uninstalling one keeps the copies while the other is installed, and `doctor` checks the directory once, as `Rules delivered to codebuddy, workbuddy`. WorkBuddy counts as installed only where `.workbuddy/` exists. 

In a project that has `.workbuddy/` but no `.codebuddy/`, the shared copy creates `.codebuddy/`, so CodeBuddy then counts as installed there too and also gets skills, agents and hooks; if you do not use CodeBuddy, `teamai uninstall --agent codebuddy` removes them and keeps it excluded, and the shared rules stay for WorkBuddy. In user scope CodeBuddy reads `~/.codebuddy/rules/` and WorkBuddy `~/.workbuddy/rules/`.

> Upgrading: earlier releases wrote WorkBuddy's project rules to `.workbuddy/rules/`, which WorkBuddy never read. The next `pull` removes the copies there that still hold what teamai delivered (the directory too, once empty) and writes the rules to `.codebuddy/rules/`, even when the team repo has not moved; a copy you edited is kept and named. WorkBuddy's one-time migration copied `~/.codebuddy/rules/` into `~/.workbuddy/rules/` (it leaves `~/.workbuddy/.migrated-from-codebuddy`), team copies included. 

> A copied team rule that holds what teamai delivered (a render of the rule, or the bytes teamai recorded writing at `~/.codebuddy/rules/` under the same name) is rewritten in CodeBuddy's format while WorkBuddy still gets that rule, and removed otherwise; an edited one is kept and named, and your own rules there stay.

### ZCode

ZCode is available as a built-in target. Skills deploy to `.zcode/skills/` (ZCode also reads the central `~/.agents/skills/`, which the `agents` entry covers), and subagents deploy as Claude-style Markdown to `.zcode/agents/`. Hooks are merged into the shared `~/.zcode/cli/config.json`, preserving unrelated keys such as plugin state. Two ZCode specifics the writer handles for you:

- Config-file hooks are **disabled by default** in ZCode — TeamAI forces `hooks.enabled: true` so the entries it writes actually fire.
- On Windows, hook entries launch through a hidden **wscript VBS launcher** (`wscript.exe <teamai-hook-dispatch.vbs> <dispatch tail>`): wscript is a GUI-subsystem binary, so hook runs never flash a console window, and the launcher spools STDIN to a temp file so the payload reaches `hook-dispatch`. Timeouts are network-scale per event (180s session start, 60s stop / prompt submit, 30s post-tool-use) so a session-start dispatch carrying a repo pull is not killed mid-flight. Payloads containing multi-byte text may degrade at the launcher's ANSI-codepage spool step — identity fields are salvaged so degraded dispatches stay linked to the session; uninstall removes both the entries and the script.
- On POSIX, entries are plain `bash -lc <dispatch>` argv vectors and the launcher is not written; on both platforms the command tail is stored verbatim as the entry's last argv element, which is what managed-entry detection and the managed-hooks manifest match against.

These paths are verified against the ZCode desktop app: profiles created in its Subagents settings page land in `~/.zcode/agents/*.md`, and files placed there (e.g. by TeamAI) show up in the page's installed list. MCP servers deploy to `~/.agents/mcp.json` (user scope, Claude `mcpServers` shape — the same file ZCode's own MCP settings page reads). Project scope is not wired: ZCode stores workspace MCP under a different key (`mcp.servers` inside `.zcode/config.json`), which the Claude writer cannot emit. ZCode reads no rules directory: in user scope the team rules are a block in `~/.zcode/AGENTS.md`, which ZCode reads as its user context, without path scoping. 

In a project, teamai's `SessionStart` hook in `~/.zcode/cli/config.json` adds the project's team rules to each new session (ZCode runs no project-level hooks). ZCode drops that text when it compacts a session, so the rules come back in the next session.

### Oh My Pi

Oh My Pi (OMP) is available as a built-in target. TeamAI deploys skills, rules, and subagents to OMP's native directories — `.omp/skills/`, `.omp/rules/`, and `.omp/agents/` at project scope, and `~/.omp/agent/skills/`, `~/.omp/agent/rules/`, and `~/.omp/agent/agents/` at user scope (user-scope resources live under the agent directory `~/.omp/agent/`, a different prefix from the project one, so TeamAI switches prefixes with the scope). Team instructions go to `~/.omp/agent/RULES.md` in user scope and, in project scope, into each turn's system prompt through the extension below (see [Where the blocks go](./team-culture.md#where-the-blocks-go)), and MCP servers merge into `~/.omp/agent/mcp.json` / `<project>/.omp/mcp.json` (Claude `mcpServers` shape — see the MCP section above). 

Skills are one-level `<name>/SKILL.md` bundles and TeamAI fills in a `description` on sync, which OMP's native skill provider requires to discover a skill. These paths follow OMP's documented discovery layout (verified against OMP 18.2.5). Hooks ride OMP's extension runner: `teamai pull` writes a single generated extension to `~/.omp/agent/extensions/teamai-hooks.ts` (never a project copy — OMP auto-loads both roots and would double-dispatch every event), which forwards OMP's `session_start` / `session_stop` / `before_agent_start` / `tool_result` events to the same `teamai hook-dispatch` entry point every other agent uses, gated on the session `cwd`. In a project session it also asks for the member's team instructions at `session_start` and appends them to the system prompt in `before_agent_start`. 

Every event carries the OMP session id (`ctx.sessionManager.getSessionId()`; a subagent has its own), and `tool_result` also the tool's text output and a status from `isError`, so upvote **adoption** runs for OMP's main agent: OMP sets no session variable in its shell, so a recall joins the session of the `bash` call that ran it, and a `read` with a line selector (`x.md:50-200`, `x.md:raw`) counts as a read of the file. From OMP 18.3.2 a subagent's events also carry its `ctx.agent` id and name, so the `teamai-recall` subagent's own reads never count. 

A subagent's session file sits under its parent's, whose header names the parent session, so the extension links the two on the subagent's tool calls, and a doc the main agent opens after a subagent's recall is upvoted (verified against OMP 18.4.8). The `session_stop` handler returns nothing, so a dispatch can never force a session continuation, and there is no matcher-scoped post-tool-use pass because OMP's tool ids are lowercase (`bash`, `read`, …) and it has no `Skill` / `TodoWrite` tool. User-scope `teamai uninstall` removes the extension; project uninstall preserves it for other projects. A same-named file without the TeamAI marker is never overwritten or removed, as with Pi. 

OMP profiles (`OMP_PROFILE` / `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`), which relocate the agent directory, are not supported; the default `~/.omp/agent/` layout is used.

Rules are written in OMP's own frontmatter, in `.omp/rules/` and `~/.omp/agent/rules/`: a rule without `paths:` gets `alwaysApply: true`, so its text is in every prompt; a rule with `paths:` gets `globs` with its globs and a `description` (its first Markdown heading, or `Team rule for files matching <globs>`), so OMP lists it in the prompt's rulebook as `name (globs): description` and reads it when the work matches. OMP drops a rule with neither, which is what every verbatim copy teamai wrote before was. 

OMP reads only the top level of its rules directory, so a namespaced rule is written flat: `rules/fe/style.md` becomes `fe.style.md`, and `push` sends an edit of that file back to `rules/fe/style.md`. Push requires a delivery record for that flat copy; a personal file with the same name is neither refreshed before push nor offered as an edit of the team rule. A namespaced rule whose flat name another rule you receive also has is not written: a root rule such as `rules/fe.style.md` keeps the file, two namespaced rules both go without, and `pull` names them while `doctor` fails. 

A file of your own that has a team rule's flat name is never overwritten or removed: only the content a delivery record holds, or the exact render, makes it teamai's. A flat copy you edited after delivery is kept and named by `remove` and `uninstall`. An older nested `<ns>/<name>.md` copy is removed once its flat copy is written, with or without a delivery record (the record, or the team rule verbatim, proves it unedited). One you edited is kept and named, since OMP does not read it: copy your edit into the flat file to keep it. OMP reads `.omp/rules/` only in the directory the session starts in, so the project's rules reach a session started at the project root, not one started in a subdirectory. 

OMP also loads a project's Cursor rules (`.cursor/rules/*.mdc`, top level only) and Copilot instructions (`.github/instructions/**/*.instructions.md`) as rules, and keeps one rule per name, its own `.omp/rules` copy first (checked against OMP 18.2.1's loader). A root team rule therefore reaches OMP once with Cursor or Copilot enabled, but a namespaced one reaches it twice with Copilot: as `fe.style` from `.omp/rules` and as `style` from `.github/instructions/fe/`. OMP reads `~/.cursor/rules` only when you enable that source.

### DeepSeek Harness

DeepSeek Harness (`dsh`) is supported for TeamAI skills and shared resources. DSH's official Claude-hook bridge is a profile plugin rather than a settings-file hook surface, so when dsh's home (`$DSH_HOME`, `~/.dsh/` when it is unset) exists, `teamai init`, `teamai pull`, or `teamai hooks inject` writes a Claude-compatible hook config and a Cordis patch under `~/.teamai/dsh/`.

dsh reads no rules directory. In user scope the team rules are a block in `$DSH_HOME/AGENTS.md` (`~/.dsh/AGENTS.md` when `DSH_HOME` is unset), which dsh puts in its first request, without path scoping. As for hooks, teamai writes it only when that home exists. Skills still go to `~/.dsh/skills/`, and only while `~/.dsh/` exists, whatever `DSH_HOME` says. In a project, teamai's session-start hook adds the project's team rules, once dsh runs with the patch below. dsh runs that hook detached, so the first request can miss them, and drops them when it compacts a session.

TeamAI prints the exact absolute patch path. Add that `--patch` flag to the command that starts your DSH profile, for example `dsh tui --patch "<printed-path>"`. This is a one-time launcher opt-in; `teamai hooks remove` and `teamai uninstall` remove the TeamAI patch while preserving other hook entries in the generated config.

### JoyCode

JoyCode is available as a built-in target. Skills, rules, and subagents are deployed to `.joycode/skills/`, `.joycode/rules/`, and `.joycode/agents/`. Subagents use Markdown with YAML frontmatter.

Rules are `.mdc` files in JoyCode's own render. JoyCode reads the frontmatter line by line, not as YAML: it keeps the quotes Cursor's render puts around `globs` and splits the value on every comma, so a scoped rule in Cursor's form never applied. A rule with `paths:` gets `globs:` unquoted and comma-separated, with each `{a,b}` alternation expanded into separate globs, and `alwaysApply: false`; a rule without `paths` gets `alwaysApply: true`. Copies an older teamai wrote in Cursor's form are rewritten on the next `pull` when they still hold what teamai delivered; one you edited is kept and named, and while its `globs` are still quoted, `pull` says it applies to no file and how to fix it. `doctor` compares each copy in a project's `.joycode/rules/` with this render.

In user scope JoyCode reads no rules directory: the team rules are a block in `~/.joycode/rules.txt`, without path scoping. A pull removes the unedited `.mdc` copies earlier releases left in `~/.joycode/rules/` and names the ones you edited.

JoyCode rule cleanup is conservative: local `.mdc` and `.md` files absent from the team rule list are preserved unless an explicit team removal tombstone exists. This protects personal rules in the shared directory; an old team copy without a deletion record is retained rather than guessed to be stale.

For canonical YAML agents, push compares each local file with the corresponding tool rendering and merges only actual edits back into the original spec. Deployment `targets`, other tools' metadata, and fields absent from a tool's native format are preserved. Conflicting or unparseable edits are skipped rather than replacing the canonical agent.

**Hooks & Manual Sync**: JoyCode currently does not provide a lifecycle hooks mechanism or dedicated launcher/startup adapter (no `settings.json` hook array or `hooks.json` format). Consequently, opening JoyCode does not fire TeamAI's `SessionStart` event, and cannot trigger background `teamai pull`, usage reporting, or auto-update checks. Users working with JoyCode must run `teamai pull` manually in the terminal to synchronize team resources, and `teamai push` to contribute changes. If JoyCode adds hooks or extension lifecycle events in future releases, a dedicated hook adapter can be connected.

### Cursor

Cursor subagents deploy to `.cursor/agents/*.md` with YAML frontmatter carrying `agent_id` (the team agent's name), `description`, `tools`, and the agent's `model` when it declares one, plus any `tool_extras.cursor` fields; `reverseFromCursor` reads the same fields back, so a `pull` → `push` round-trip keeps the model.

Cursor project rules must live in `.cursor/rules/` as **`.mdc`** files with YAML frontmatter — a plain `.md` file there is silently ignored by Cursor. teamai therefore writes rules to Cursor as `<name>.mdc` (JoyCode, Copilot, Kiro, Qoder, Qoder CN, Trae, Trae CN, CodeBuddy, WorkBuddy and Oh My Pi get a format of their own, described in their sections; every other tool gets a plain `.md`), deriving the frontmatter from the team rule:

- A rule scoped with a `paths:` list becomes `globs: "<comma-joined>"` + `alwaysApply: false` (Cursor auto-attaches it when a matching file is in context). The value is quoted because a glob starting with `*` is not valid YAML unquoted.
- A rule with no `paths` (a mandatory team rule) becomes `alwaysApply: true` (applied to every Cursor chat session).

Only the markdown body crosses between the two formats; each side keeps its own frontmatter. On `pull` the Cursor frontmatter is machine-derived (the body is copied over with leading/trailing blank lines normalized), so a `pull` → `push` round-trip is not seen as a content change. On `push`, editing a rule's body in `.cursor/rules/*.mdc` and running `teamai push` sends **only that body** upstream — the team rule keeps its own `paths:` frontmatter, so the rule's scope is never silently lost.

Two things are deliberately *not* pushed from Cursor's rules directory:

- A `.mdc` file with no matching team rule. `.cursor/rules/` is also where Cursor's own *New Cursor Rule* command writes personal rules, so teamai never offers those as new team resources.
- The CLI built-in rules, which are deployed (as `.mdc` for Cursor) rather than synced.

Upgrading from an earlier version: `.cursor/rules/*.md` copies written by the old layout are inert — Cursor never read them — so `pull`, `remove`, and `uninstall` delete them alongside the `.mdc` file. A `.md` you put there yourself is left alone.

### Miscellaneous

`teamai update --dry-run` checks for a newer CLI version without installing it, refreshing hooks, acquiring the update lock or saving TeamAI's version-check state. Combining it with `--check` is also read-only.

```bash
teamai doctor          # Config diagnostics
teamai doctor --json   # Same diagnostics as JSON on stdout (CI, hooks, agents)
teamai stats           # Skill usage stats
teamai update --check  # Check for a CLI update without installing it
teamai update          # Check for and install a CLI update
teamai digest          # Generate the weekly team activity digest
teamai remove skills <name>   # Remove a resource (asks for confirmation)
teamai remove rules <name>
teamai remove agents <name>
teamai remove mcp <name>
teamai remove rules <name> --force   # Skip the prompt, for scripts and CI
```

`teamai stats` shows the current scope's skill usage and session totals, and a recall section when that scope's recall log has runs (see [Recall adoption and upvotes](./knowledge.md#recall-adoption-and-upvotes)). A plain `teamai stats` resolves legacy roles in memory without saving the config or printing dry-run migration notices. `teamai stats --dry-run` retains migration preview notices and writes nothing: it reads the reports checkout as it is, without refreshing or creating it, and says so. When the session owners file is missing, the preview uses the same inferred owners and already-reported credits in memory, including sessions split across scopes by older releases.

`teamai doctor` exits with code 0 only when every check passes, and code 1 when any check fails. Before initialization, it reports the missing configuration without assuming a Git provider. The same checks run at the end of a manual `teamai pull`, minus the provider ones and minus any check that pull already reported in its own words on that run. 

A check marked informational — currently only `No stale env blocks left behind` — still counts toward `doctor`'s exit code, but a pull does not fold its failure into `Pull finished, but N check(s) failed`: a leftover file from an earlier install is cleanup, not a sign this pull broke anything, so it is still named but on its own, gentler line.

Besides the provider, clone, config and hook checks, `doctor` verifies what reached your machine. `<tool> is installed` fails when `enabledAgents` lists a tool that nothing would be delivered to, which is the case where a pull reports success and that tool receives nothing. It asks the same resolver the sync uses, so a tool that keeps its skills somewhere other than its tool root, as OpenClaw does with its workspace directory, is judged where the sync would actually write. It reports an installed tool as passing too, so `--json` carries one entry per enabled tool either way. 

The checks at the end of a pull cover the scope that pull resolved from the current directory; run `teamai doctor` in another scope to check that one. `Skills delivered to <tool>` compares the skills your role namespaces, tag subscriptions and exclusions resolve to against what is on disk for each installed tool: it reports a skill that was never delivered separately from one that arrived unreadable — `SKILL.md` missing, its frontmatter unparseable, or its `name` not matching the directory, which keeps the agent from ever discovering it. 

A skill directory of your own at a team skill's path is listed as `not teamai's (kept by pull)` with pull's line for it, as a document of your own at a team document's path is by `Team docs delivered`. `Team docs delivered` compares the docs you receive (a docs namespace you do not have active is left out) against `sharing.docs.localDir`, which has one destination rather than one per tool; each expected document has to be a file that can be read, so a directory or a dangling link sitting on the name counts as missing. It also reports extra non-hidden local files as stale, including when the team bundle is empty. 

Hidden local files are preserved and do not fail this check, and neither does a local copy of a team doc in a namespace you do not have active: pull removes it when it is unchanged and names it when you edited it. `doctor` also prints notes, which are information rather than failed checks. Each note names a namespace skill, agent, rule, shared-instructions file, env variable, hook, MCP server or team model profile that replaces a root one here (`rules: "style" from rules/checkout/style.md replaces rules/style.md`). 

When a namespace contributes env variables, hooks, MCP servers or team model profiles, a note also counts where that type's entries come from (`env: 3 received here (2 root, 1 checkout)`). Without roles or projects, the notes name each file the team repo defines more than once instead, and each env variable, hook or MCP server name repeated in its root file.

For Oh My Pi and Kiro, `doctor` reports flat-name collisions even when every desired rule collides and no file can be written. Rename one of the rules in the team repo, then run `teamai pull`.

`Rules delivered to <tool>` and `Agents delivered to <tool>` do the same for the other two per-tool resources, and both ask the handler where an item lands rather than deriving a path: a rule's filename and content change per tool (`.md` verbatim, `.mdc` with derived `globs`/`alwaysApply` (unquoted for JoyCode), `.instructions.md` with `applyTo`, Kiro's flat `.md` with `inclusion`/`fileMatchPattern`, Qoder's `.md` with `trigger`/`glob`, Trae's `.md` with `globs`/`alwaysApply`, Oh My Pi's flat `.md` with `alwaysApply` or `globs`/`description`, CodeBuddy's `.md` with `alwaysApply`/`paths`; tools that read one copy, as CodeBuddy and WorkBuddy do in a project, get one check naming both), and an agent's destination comes from its render, with `targets:` deciding which tools are owed a copy at all. 

A delivered rule is compared with the bytes the handler renders for that tool, not merely read for the keys its tool needs: a `.mdc` whose `globs` no longer match the team rule's `paths:` applies to the wrong files while carrying a perfectly legal `alwaysApply`, and that reads here as `delivered from an older copy` — the same label as a body that drifted, because both landed successfully and are still wrong. 

An agent is compared with the bytes its render produces, so a copy left behind by an older spec — a plain pull skips a scope whose team repo has not changed, so it can sit there indefinitely — is reported as `delivered from an older spec` rather than passing as present. `Every team agent reaches a tool` names an agent that renders for no installed tool — usually a spec that does not parse, or a `targets:` list naming only tools you do not have. These two are `doctor`-only: they read every rule per tool and parse every agent, which would spend the budget the checks at the end of a pull run under.

After the last team rule is removed, `doctor` still reports team-owned OpenCode globs or inline blocks left by failed cleanup. Run `teamai pull` to remove them.

Several tools do not read a rules directory, so a per-file check cannot speak for them and each gets one of its own. `Team rules are active in opencode` checks that `opencode.json` (`.opencode/opencode.json` in a project) lists every glob the pull owns under `instructions`, and no stale one such as the relative `rules/*.md` an earlier release wrote: OpenCode does not auto-scan `.opencode/rules`, so without it every delivered `.md` is inert while the per-file check keeps passing. On OpenCode V2, which ignores `instructions`, it instead checks that teamai's plugin, which adds the rules to the prompt, is installed and current. 

In user scope, `Team rules are inlined in Hermes SOUL.md` compares the teamai-managed block of `SOUL.md` with what the team rules inline to, since Hermes reads standing instructions from that one file rather than from a directory — a deleted block, or one left on an older rule set, is a tool reading the wrong rules with nothing on disk to show for it. 

In user scope, `Team rules are inlined in <file>` (`Codex AGENTS.md`, `ZCode AGENTS.md`, `DeepSeek Harness AGENTS.md`, `OpenClaw workspace AGENTS.md`, `Pi AGENTS.md`, `JoyCode rules.txt`) compares the team-rules block of the file that tool reads with what the team rules inline to; for Codex it also fails when an `AGENTS.override.md` beside it shadows the file. In a project, `Project rules and instructions reach <tool> whole through its session hooks` fails when the teamai `SessionStart` or `SubagentStart` entry in that tool's `hooks.json` is missing or does not set `additionalContextLimit: 0`, without which Codex keeps only the start and end of a large set. 

In a project, `Project rules reach zcode through its SessionStart hook` fails when `~/.zcode/cli/config.json` has no teamai `SessionStart` entry or does not set `hooks.enabled: true`, and `Project rules reach dsh through its session-start hook` fails when the patch or the hook config under `~/.teamai/dsh/` is missing; doctor cannot see whether dsh runs with `--patch`. For Pi, `pi adds the team instructions and rules to its prompt` fails while teamai's Pi extension is missing or out of date. Codex, ZCode, DeepSeek Harness and Pi have no `Rules delivered to <tool>` check.

`MCP servers delivered to <tool>` compares each server the team's `mcp.yaml` resolves for that tool against the entry in the tool's own config, and names any the reconcile skipped with its reason. The comparison is the entry, not the name: reconciliation leaves an entry teamai does not own alone, so a server of your own under a team name holds the key while the team's definition never arrives, and a stale copy is just as undelivered. Both are reported as `not the team's definition`. An entry teamai has no record of counts as teamai's when it equals what teamai writes for that server now or at any earlier revision of the team repo, and the next pull updates it. 

An unrecorded entry under a server name the team no longer defines is teamai's when it equals what teamai wrote for that server at some revision of the team repo's history, and pull and `uninstall` remove it; any other stays as it is. Any other one is yours: pull keeps it and names it, `doctor` lists it, and the team server is not written to that file. Rename or delete it, then run `teamai pull`, to receive the team version, or let `teamai mcp inject --force` replace it; `teamai pull --force` does not. An unresolved `${VAR}` is reported here with the variable's name, which is otherwise said once during a pull and never again. 

A declared secret with no value is not a failure: doctor prints it as a note (`notes` in `--json`) with the command that sets it, and the exit code stays as it would be without it; a note also says when an entry kept for it may hold an old value, and when a key is declared as a secret and also set in `env.yaml`. An `mcp.yaml` that does not parse is not a team without MCP: it is reported as `Team MCP servers can be read` with the parse error, since it injects nothing into any tool and every run after the first is silent about it. 

Team hooks and team model profiles that cannot be resolved (a file that does not parse, a name defined twice in one file, or one name in two active namespaces) fail `Team hooks can be resolved` and `Team model profiles can be resolved` with the reason pull logs once; `teamai status` points here when it counts them as 0. 

`Env variables injected in shell profile` no longer stops at finding the marker comment: it checks that `env/env.yaml` parses and declares its variables under the `variables:` key (a plain `KEY: value` mapping parses as none, while an explicit `variables: []` is a configuration with nothing to deliver and fails nothing), that each one reached `env.sh` with the value `env.yaml` declares, or your value for this team (one set with `--from-env` is not written there) 

— a key left over from an older value exports it to every shell and MCP server until the next pull, and the comparison reads `env.sh` back through the generator's own inverse, so a multiline value quoted across several lines is matched rather than called stale — and that this scope's injected block (the one sourcing its own `env.sh`, since a profile can also carry another scope's) would actually load it — an unquoted Windows path degrades to something a POSIX shell cannot read, so `source` never runs and nothing says so. 

`No stale env blocks left behind` is a separate check: which file `pull` prefers has changed over time (Windows Git Bash's login shell reads `.bash_profile`/`.bash_login`/`.profile`, never `.bashrc`), and a pull only ever adds a block, never migrates an old one away, so a dead block from an earlier install or platform change can sit in another candidate file indefinitely. It names every such file (checking `.zshrc`, `.bashrc`, `.bash_profile`, `.bash_login` and `.profile`, current and legacy spellings alike) and points at `teamai uninstall` to remove them — separately from delivery, so a working env block never reads as broken just because an old one is still lying around.

`Codex trusts this project, so it loads its team MCP servers` is built in project scope while the project's `.codex/config.toml` holds a server this worktree's `managed-mcp.json` records for Codex: Codex loads that file only in a trusted project, and skips an untrusted one without saying so. It reads the `projects` table of the Codex user config (`~/.codex/config.toml`, or the one under `toolRoots.codex`) as Codex does, taking the first `projects."<dir>"` entry that sets a `trust_level` for the checkout, then for its main checkout, each by real path (`/private/tmp/...`, not `/tmp/...`). 

It fails, naming the file and its servers, until that entry sets `trust_level = "trusted"`, and a pull reports the failure in its closing checks too. If the check still fails after pull attempts automatic trust, change project trust in Codex or add the main-checkout entry yourself, which covers every worktree. doctor only reads that file.

`Contributed learnings are published` fails while `teamai contribute` has notes queued that could not be pushed. A manual `teamai pull` does not repeat it at the end when the pull has already said it: the pull tries to publish the queue and reports the outcome itself, with the push error that made it fail — more than this check can tell you. If the pull never got that far, because the team repo failed to refresh, the check is printed as usual.

`--json` prints the same report as one object on stdout and routes every log line to stderr, so `teamai doctor --json 2>/dev/null` parses whole. The exit code is unchanged. Each check carries the fix suggestion it prints in human mode:

```json
{
  "ok": false,
  "scope": "user",
  "checks": [
    { "name": "Team repo exists locally", "ok": true },
    {
      "name": "teamai hooks in claude settings",
      "ok": false,
      "fix": "Run `teamai hooks inject` to inject/update hooks"
    }
  ]
}
```

`scope` is `null` before initialization. `packages` is present only when the team repo declares packages, and carries the rendered report lines. `notes` appears only when there is an advisory: the namespace notes described above (an item that replaces a root one, or without roles or projects a name defined more than once) and the Codex hook trust reminder when Codex cannot be asked (no `codex` on PATH, or its app-server failed).

Auto-update runs in the Stop hook and is controlled by two tiers:

| Tier | File | Field | Value |
|------|------|------|------|
| Team default | `teamai.yaml` | `autoUpdate` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `updatePolicy` | `auto` / `prompt` / `skip` |

The user-level `updatePolicy` always takes priority over the team-level `autoUpdate`.

Self-update only reinstalls a copy that npm manages. When teamai runs from a checkout outside `node_modules`, such as one linked with `npm link`, both auto-update and `teamai update` skip the install and print a warning, because `npm install -g` would replace the link with the published package. Pull and rebuild the checkout to update it.

On Windows, the update check, installation, and hook refresh run without opening console windows.

### Usage reporting

By default, `teamai pull` commits session/usage stats into the team repo.
Pull waits up to 5 seconds for the reporting batch, then continues its other
work while reporting finishes. A late successful push still updates the local
reported snapshots. Skill usage is recorded per scope, in the data directory of
the project teamai is set up for where the session ran (or the user scope), so
each target reports only its own; a directory without teamai records none.


Dashboard sessions stay in one machine-wide `~/.teamai/dashboard/events.jsonl`,
but each event records a key of its scope's data home (a hash, not the path),
so a scope reports only the sessions recorded in it: a user-scope pull no
longer reports a project's sessions, and a project reports its Copilot sessions
and sessions started under a symlinked path. A session is reported once, whole,
by the scope it started in, even if it later moves into another project: its
Stop carries the whole transcript's totals, so a second scope would count them
again. 

Events recorded by an earlier release carry no key: the scope their
directory resolves to now reports them (a nested clone under a project resolves
to its own project or the user scope, not the enclosing project); events with
no directory, or one removed since, are reported by no one. 

Each scope also
keeps its own snapshot of what it already reported, and a session under a
reused fallback ID (Copilot's PID-based ID when it sends none) counts as new,
whichever scope reported the earlier one, while a resumed session
(`claude --resume`) keeps its ID and stays one session, reported by the scope
that first reported it wherever it is resumed; the first
report after upgrading starts from the snapshot every scope used to share, so
nothing is reported twice. A
target removes its usage events only after it confirms success; failed pushes
preserve them, up to the newest 5,000 (see below). The affected sync locks remain
held until reporting finishes, preventing another pull from racing the report.

This is best-effort reporting, not crash-safe delivery: termination between a
remote push and local acknowledgement can still cause duplicate statistics.
It does not provide durable per-target deduplication for partial multi-repo
reports. The 5-second wait limit does not cancel Git or force the CLI process
to exit while a subprocess is still running.

Teams that pull from a read-only remote (or simply don't want stat commits)
can turn this off in `teamai.yaml`:

```yaml
usageReport: false
```

Pull keeps each scope's usage file to its newest 5,000 events, dropping the
oldest after the report step. For an http source or a `usageReport: false`
team, that file is the only record `teamai stats` has, so it stays bounded
without going empty; a reporting scope whose report does not complete while
it holds more than 5,000 drops its oldest unreported events the same way. The
cap runs only after a report has removed the events it sent. Hook appends, the
report's truncate and the cap take one lock beside the usage file, so a rewrite
does not lose an event recorded while it runs. 

A hook that cannot take the lock
within ~250 ms records its event in a `*.pending-<id>.jsonl` file next to it,
which the next lock holder appends to the usage file; a rewrite that cannot take
it within ~5 s leaves the file as it is. A pending file gets no wider mode than
the usage file (owner-only while there is none). An in-workspace
`.teamai/.gitignore` ignores the lock, a rewrite's temp copy and the pending
files; `pull` and `push` add those entries to an existing single-repo one, and
the usage file's first pending file or rewrite adds them to an existing
project-scope one.

**Removing a skill another project reported into your `stats/`.** Before skill
usage was kept per scope, whichever project pulled next reported every
project's skills, so `stats/<user>.yaml` on `teamai-reports` can count a skill
that belongs to an unrelated repo. Those events recorded no directory, so
teamai cannot attribute them and never rewrites the file. Remove the entry by
hand, from a clone of your own so teamai's `reports-wt/` checkout is untouched:

```bash
git clone --branch teamai-reports --single-branch <team-repo-url> teamai-reports
cd teamai-reports
# delete the skill's entry under `skills:` in stats/<user>.yaml
git commit -am "stats: remove <skill> reported from another project"
git push origin teamai-reports
```

The next report reads the branch first, so the entry does not come back.

### Git submodules

If your team distributes skills as git submodules, opt in with `submodules: true`
in `teamai.yaml`:

```yaml
submodules: true
```

On every pull, teamai runs `git submodule update --init` so submodule-based
skills are populated at the revisions pinned by the team repo (git-repo
backends only; the full submodule history is fetched, since a shallow fetch
cannot check out older pins). Disabled by default. If the update fails, pull
logs a warning and holds back the recorded revision, so the next pull
re-syncs and retries the update instead of skipping it. Note: submodule
fetching relies on the ambient git credentials — private submodules on hosts
authenticated by per-command token injection (rather than a configured
credential helper) will not authenticate.

### Post-pull scripts

Teams often deploy more than teamai's built-in surfaces (models a client
offers, machine-local installs, a PATH shim). `scripts.postPull` in
`teamai.yaml` declares a Node entrypoint teamai runs once a pull has fully
finished, for the team repo that owns this machine's deployment — the
project scope's repo when a project is active, otherwise the user scope's
(an inherited user scope brings resources and knowledge only, not deploys):

```yaml
scripts:
  postPull:
    path: scripts/deploy.mjs
```

The path is relative to the team repo root; one that resolves outside it
(symlink included) is rejected. On the
session-start path the script runs as a child of the pull process and is
waited on under a fixed budget (`TEAMAI_POSTPULL_TIMEOUT_SEC` is exported so
the script can self-limit its heavy steps); on expiry the script is left
running rather than killed, and the next pull reconciles. An interactive
`teamai pull` launches it fire-and-forget into the terminal instead. A bad
path, a missing file or a failed spawn is a line in `~/.teamai/debug.log`
(`postPull: launched / exited / timed out`), never a failed pull.

### CI Integration

`teamai ci extract-mr --output <dir> --dry-run` refuses before provider access or artifact creation. It prints `teamai ci extract-mr --output has no --dry-run preview, nothing was run` and exits 1. Omit `--output` to preview, or omit `--dry-run` to write artifacts.

`teamai ci extract-mr` plugs into your CI pipeline, automatically extracting knowledge from every MR/PR:

```bash
# Comment mode: post suggestions as comments (runs when the MR/PR is opened/updated)
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments

# Write mode: after merge, write approved suggestions into the knowledge base
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

Workflow:

1. MR opened/updated → CI triggers `--mode comment`, extracts knowledge suggestions and posts them as MR comments
2. Reviewer reviews the comments, marking unwanted suggestions as rejected (GitHub 👎 / TGit ☝️)
3. MR merged → CI triggers `--mode write`, writing non-rejected suggestions into the team knowledge repo

If the review-status API returns a non-2xx response, write mode fails closed: the job exits without writing files, committing, or pushing to the team knowledge repo.

Comment mode also fails closed when it cannot list the existing marker comment, so a transient provider error cannot create a duplicate comment.

Ready-to-use templates, with setup notes, are in [`examples/ci/`](../../examples/ci/README.md).

### Cross-Team Skill Subscriptions

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

#### HTTP Source

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

### HTTP Contract (for backend implementers)

When using `teamai init --http <baseUrl>`, the endpoint must implement the following APIs (authenticated via `Authorization: Bearer <api-key>`):

| Endpoint | Method | Purpose |
|------|------|------|
| `{baseUrl}/api/local-agent/report` | POST | Session start: upsert agent + installed skills |
| `{baseUrl}/api/local-agent/sync` | POST | Report status + return pending skill commands |
| `{baseUrl}/api/local-agent/commands/ack` | POST | Acknowledge a single command (`{ id, status, error }`) |

`POST /api/local-agent/sync` returns pending commands:

```json
{
  "ok": true,
  "commands": [{ "id": 1, "type": "install_skill", "skill_slug": "x", "skill_version": "1.0.0", "download_url": "https://signed-url/..." }]
}
```

Removing the final HTTP prompt is acknowledged as `failed` when its target cannot be updated. The cached prompt and manifest record remain available for a retry after repairing the markers or file permissions.

The backend may push an **`apply_model_config`** task whose `cmd` is JSON. Both
the documented candidate-set shape and the legacy single-model shape are accepted.
`{"models":[...]}` is a full snapshot; a direct model object is an incremental upsert.
`max_tokens` is optional (CodeBuddy / WorkBuddy `maxOutputTokens`); omitted or `0` defaults to `4096`. Claude does not use it.

```jsonc
{ "id": 16, "type": "apply_model_config",
  "cmd": "{\"models\":[{\"provider\":\"openai\",\"model_id\":\"gpt-4o\",\"name\":\"GPT-4o\",\"base_url\":\"https://proxy.example.com/v1\",\"api_key\":\"<ProxyToken>\",\"max_tokens\":4096,\"context_window\":128000}]}" }
```

The candidate set is applied only to the agent that reported the task. CodeBuddy uses
user-level `~/.codebuddy/models.json` (`{ "models": [...] }`). WorkBuddy uses
`~/.workbuddy/models.json`; both the current `{ "models": [...] }` shape and the legacy
top-level array are accepted, and an existing file keeps its shape. A workspace-scoped
CodeBuddy or WorkBuddy task uses `<workspace>/.codebuddy/models.json`, matching the
embedded model loader. That file holds the API key, so it is always kept out of git,
whatever the git exclude setting: before writing it, teamai lists it in the `credentials`
block of the repository's `.git/info/exclude` and writes the key only once git confirms
it ignores the file (a workspace outside any git repository gets the key with no line). If
git tracks the file, a rule in a `.gitignore` re-includes it, the exclude file cannot be
written, or git cannot confirm, the key is not written and the task fails with the reason
and the fix (for a tracked file, `git rm --cached` it). A task with no models removes
teamai's entries; when nothing else is left in a file teamai created, the file is deleted,
then its line. A file teamai did not create, one git tracks, or a link stays, and so does
its line. The same happens for every workspace when `teamai source remove-http` removes the
HTTP source. teamai no longer creates
`<workspace>/.codebuddy/.gitignore`, and deletes the one an earlier version created while it
holds only its two lines. Workspace delivery is accepted only for a path
already present in the reporter's workspace bindings. User-owned entries with the same
model ID are preserved. 

Claude
gets an explicit profile at `~/.claude/teamai-models.json`
and also receives the gateway environment in `~/.claude/settings.json` when it has no
conflicting user-owned Anthropic gateway configuration. The conflict check inspects
both `settings.json` `env` and the process's shell environment (`export ANTHROPIC_*`),
so a user who runs Claude via shell env keeps their own gateway — TeamAI skips the write
and logs the skipped keys to `~/.teamai/reporter/errors.jsonl`. Protected keys are
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_CUSTOM_MODEL_OPTION{,_NAME}`, and
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. 

A shell value that matches what TeamAI
last wrote (Claude re-injects `settings.json` `env` into the hook process) is recognized
as managed, not a user conflict, so a managed gateway can still be updated or removed on
later syncs. Unsupported agents acknowledge
the task as failed instead of writing another agent's config. Symlinked user config
files remain symlinks. These files are mode `0600`. A successful write is acknowledged with
`type: "apply_model_config"`; malformed payloads are acknowledged as `failed`. Unknown
future task types are silently skipped for protocol compatibility.

The reverse direction is reported through the existing `report` call: models that
TeamAI recorded in its model manifest and can still identify by model ID and provider
on disk are sent as `user_level.models` or, for workspace-scoped deliveries, the
matching `workspaces[].models`. Normal agent-added metadata does not suppress
the report. A successful apply triggers this report immediately in the same sync run.
User-owned models are omitted because the backend cannot resolve them. The server
requires both `provider` and `model_id`. Like skills and rules, the field is omitted
entirely when nothing qualifies, because a present array is treated as a full
snapshot. 

CodeBuddy, WorkBuddy, and Claude (the `ANTHROPIC_CUSTOM_MODEL_OPTION`
gateway in `~/.claude/settings.json`) expose a discoverable model config; other tools
report nothing. Reported entries always use `source: "enterprise"`. **`api_key` is
never reported back** — the ProxyToken stays on disk.

```jsonc
{ "agent_type": "codebuddy", "local_agent_id": "...",
  "user_level": { "models": [
    { "provider": "tokenhub", "model_id": "gpt-4o", "name": "GPT-4o", "source": "enterprise" }
  ] } }
```

The HTTP contract is intended for custom integrations. End users only need the `teamai init --http` command described in [Member Onboarding](./member-guide.md#member-onboarding).
