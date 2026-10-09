# Team Knowledge

> [English](knowledge.md) | [简体中文](zh-CN/knowledge.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

## Knowledge Capture & Retrieval

This is Team Context plus the start of Team Improvement: capture what a session actually learned, then let the next agent find it.

### Contributing knowledge

The AI tracks your coding sessions via Hooks. When a session ends (the Stop hook), the system scores it by **friction** — whether you interrupted or corrected the AI, denied a tool call, or the AI had to retry failing tools. A long-but-routine session (many tool calls, no friction) won't trigger; only a session where you actually hit a problem does. If it qualifies, the AI automatically reminds you:

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

The reminder lists the non-zero friction signals that triggered it. When the first task is available, it also includes a redacted, single-line task summary so you can decide whether the session is worth sharing. Using the built-in `share` workflow (`teamai skill get share`), the AI will automatically summarize the session's learnings and contribute them to the team knowledge base. Each session is prompted at most once.

For the Codex family (`codex`, `codex-internal`, `tcodex`), the Stop hook saves contribution and knowledge-reference reminders for the next UserPromptSubmit in the same session. It does not force an extra agent turn. Contribution reminders are delivered once and discarded if you contribute before the next prompt.

You can also specify a file manually:

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --scope project
teamai contribute --file /tmp/session.md --namespace payments
```

`--namespace` accepts only the selected scope's active learnings namespaces from
`manifest/projects.yaml`, which can differ from project ids. An unavailable or
unsafe namespace is rejected before the learning is queued. Without the flag,
the default above is unchanged; when several namespaces are active the command
lists them and explains how to choose one. `--dry-run` previews the selected
path without writing, and an offline contribution keeps that path when retried.

#### Turning the hint off

Teams that route knowledge sharing through their own review flow (for example, a personal retrospective that opens ordinary PRs) can switch the hint off without touching the rest of the Stop hook — update checks, votes sync, and dashboard reporting keep running. Same two-tier pattern as recall:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.contributeHint.enabled` | `true` (default) / `false` |
| User override | `~/.teamai/config.yaml` | `contributeHintEnabled` | `true` / `false`, takes priority over the team default |
| Environment variable | shell | `TEAMAI_CONTRIBUTE_HINT_DISABLED=1` | Force-disables the hint (emergency kill switch) |

Only the nudge is affected: friction scoring, `teamai contribute --file`, and `/teamai` keep working when invoked manually.

The reminder is also withheld while recall is off (the default until `sharing.recall.enabled: true` in `teamai.yaml`, or `teamai recall enable` on one machine): it points at the `share` workflow, and `teamai skill get share` refuses until recall is on. It never appears on a read-only HTTP source, or while a teamai config exists but cannot be loaded, where `share` refuses too, nor in a directory where teamai is not set up, although `teamai skill get share` still serves there.

### Searching knowledge

```bash
teamai recall "API timeout"
teamai recall "GPU out of memory"
```

- Supports mixed-language search
- Searches the project scope when the current working directory contains its config; with `inheritUserScope: true`, searches project first and user second, labeling results `[project]`/`[user]`. Otherwise searches user scope
- For the same resource type and filename, the project entry wins; different resource types with the same filename remain separate
- Each search is a run, and its id follows the result count on the region's first line: `--- [teamai:recall:start] --- (2 results) run=<id>`. A search with no hits prints it at the end of its one line: `No matching learnings found for "<query>". run=<id>`. An active-scope doc the session opens after the run is upvoted, as [Recall adoption and upvotes](#recall-adoption-and-upvotes) describes. Inherited user hits remain read-only while the project is active
- In a project whose config exists but cannot be read, recall searches and records nothing, neither the user scope nor a lower-priority project config (such as a legacy `.teamai/config.yaml`) behind it: it prints ``Nothing was searched: <file>: <reason>. Fix the file, or move it aside and run `teamai init` to write a new one.`` and exits 1, with `--check` too, which prints no verdict. The recall subagent relays that line instead of reporting no knowledge. With no config at all, recall still says no learnings are available and exits 0
- When recall builds its index (none yet, or an older format) and a team manifest cannot be read, it still indexes the learnings, only the shared root when `manifest/projects.yaml` is the broken file, and says once what it left out, for example: ``Recall indexed learnings only: <cause>. Docs, rules and skills stay out of recall until the team manifest is fixed and `teamai pull` rebuilds the index; `teamai doctor` shows the problem.`` A skills collision with no earlier index to keep skills from is named the same way. 

  If that smaller index cannot be written over an older one, recall searches nothing in that scope rather than the older index, which would return what the warning left out, and says so: ``Recall could not build the <scope> search index: <cause>. Recall skips the older index at <path>…``. Any other build failure is shown with its cause instead of "No learnings available"
- A lightweight relevance precheck is available via `teamai recall --check "<keywords>"`, which prints `RELEVANT score=<n> threshold=<n>` or `NOT_RELEVANT score=<n> threshold=<n>` without reading files or upvoting — the recall subagent uses it to skip retrieval on unrelated tasks. For a `RELEVANT` top hit it also reports `matched=`/`missing=` — the query terms that hit its title/tags and those that did not
- `RELEVANT` means a hit cleared the score threshold, i.e. reading files is worth the cost — it does not mean the knowledge base covers your subject. Use the `matched=`/`missing=` terms (and the `Matched:`/`Missing:` lines on full results) to make that judgement: a hit missing all your distinctive terms is topically adjacent, not an answer

### Recall adoption and upvotes

Manual feedback uses `teamai recall feedback --positive <docId>` or `--negative <docId>` in the current scope. Add the global `--dry-run` before or after the command to preview the requested feedback without changing votes or migrating config or vote files. The preview validates the scope's config but does not check whether a negative vote can reduce the count; ordinary diagnostic logging still applies.

Recall counts every doc it returns (`recalled_count`). A returned doc is **adopted**, and upvoted once (`upvoted_count`), when the session that ran the recall opens it within 24 hours after the run. Adoption means opening the doc: when the `teamai-recall` subagent summarizes a doc and the main agent works from that summary alone, nothing is opened and no vote follows. Only the opt-in judge (`TEAMAI_UPVOTE_JUDGE=1`, see [Enabling / Disabling Recall](#enabling--disabling-recall)) can credit that use.

**The recall log.** Each run goes to the active scope's local recall log, `<data home>/dashboard/recall.jsonl`, which is owner-only and never pushed. The run holds the agent session from the environment and, for each returned doc, its id, scope and printed `File:` path; a search with no hits is recorded too. The PostToolUse hook adds the shell call that ran `teamai recall` and each read of a file under the team knowledge roots. The log never holds the query, the prompt, tool output or file content. 

`teamai pull` prunes it: lines older than 30 days go, then the oldest beyond 5,000, but never a read from the last 24 hours that has not voted yet, nor what it needs to vote. `--check`, `--dry-run` and `TEAMAI_RECALL_DISABLED=1` record nothing, in this log or in the session's recall quality cache that `contribute-check` reads. A `--dry-run` that has to build the index (none yet, or an older format) searches it in memory and does not save it. It keeps searching the existing index if the same rebuild shrink guard would reject a real rebuild.

**Which session owns a run.** A run belongs to the session whose shell call ran `teamai recall` itself, so when one agent runs another (Claude running `codex exec`), the inner agent's session gets it; a call that only prints a recall's output does not count. With no such call, the run belongs to the session in the environment only when a single agent session was set there; otherwise it never votes.

**What counts as opening a doc.** The opened path must be the path the run printed.

- The agent's file-read tool (`Read`, `read`, `view`, `read_file`, `ReadFile`).
- One reader command, alone or at the head of a pipeline: `cat`, `bat`, `less`, `more`, `head`, `tail`, `nl`, `sed -n` printing lines, or PowerShell's `Get-Content`, `gc`, `type` and `cat` with a positional path, `-Path` or `-LiteralPath`; `gc` and `type` count only in the agent's PowerShell tool or when every path is a Windows path (a drive letter or a `\`), since in a POSIX shell `type` is a builtin that reads nothing. A command with `;`, `&&`, `||` or `&` is not a read. 

  When the agent reports no status, as Codex's shell does, only a reader alone counts, and output that holds nothing but the command's own errors (`cat: x.md: Permission denied`) or the shell's (`bash: line 1: head: command not found`) is a failed read, and a file such an error names (`cat: x.md: …`) is not read, while the command's other files still are.
- A search whose output shows the file's lines: a line that starts with the file's path and `:<line>:` (or `:` alone, in `grep` and `rg` output without line numbers and in OpenCode's per-file header), or, when the file was the only thing searched, output with a line other than the search tool's no-match or summary line (`No files found`, `No matches found`, `Found N matches`) (`grep`, `rg`, `ag`, `ack` or `git grep`, under the same rules as a reader command, or a search tool such as `Grep` in content mode).
- Not a listing (`Glob`, `ls`, `find`, `rg --files`, `grep -l`, a search tool's file list), a count (`grep -c`, count mode), or a failed read.
- On Windows a path counts however it is written: either drive-letter case, `\` or `/`, or Git Bash's `/c/…` for `C:\…`.

**Subagents.** When the `teamai-recall` subagent ran the recall, its own reads never count; reads by the main agent or any other subagent in the session do. The subagent marks its runs with the internal `--caller teamai-recall` flag, and Claude Code, and OMP from 18.3.2, also name it in their hooks. Whether a later read by the main agent reaches the subagent's run depends on the agent: see the table below.

**When the vote lands.** The Stop hook joins runs and reads, and upvotes each adopted doc once per session; an agent that shows hook output prints `[teamai] Adopted team knowledge this session: <ids>`. A subagent that reads after the session's last Stop is credited at its SubagentStop (Claude Code, Codex, CodeBuddy and Qoder), which pushes nothing so the main agent never waits on git: the next Stop or pull pushes the vote. Copilot CLI's SessionEnd credits and pushes as Stop does, so a session whose last turn fired no Stop still votes, but it prints nothing. 

`teamai pull` also credits any read still pending, such as one no later hook fired for, or one whose Stop found the votes file busy. A session resumed the next day that opens the doc again adds no vote unless it recalls the doc again.

**Per agent.** *Direct recall*: the main agent runs `teamai recall`, then opens a doc. *Subagent path*: the `teamai-recall` subagent runs the recall, then the main agent, or another subagent, opens the doc.

| Agent | Direct recall | Subagent path |
|-------|---------------|---------------|
| Claude Code | Yes | Yes |
| Codex | Yes | Yes, from Codex 0.134, whose hooks name the subagent |
| CodeBuddy, WorkBuddy | Yes (unverified) | Yes, from CodeBuddy 2.103.1, whose hooks inside a subagent carry the main session (unverified on WorkBuddy) |
| Qoder | Yes | Yes (unverified) |
| Copilot CLI | Yes | No: the subagent has a session of its own, and no hook links it to its parent |
| Cursor | Yes | No: as for Copilot CLI |
| OpenCode | Yes | Yes: the `task` call links the subagent's session to its parent |
| OMP | Yes, settled only by the claim of its `bash` call | Yes: the subagent's session file sits under its parent's, whose session header links the two sessions (verified against OMP 18.4.8) |
| Pi | Yes | None: TeamAI deploys no subagent to Pi |
| ZCode | Yes | No: ZCode runs no hooks inside a subagent |
| OpenClaw, Hermes, Kiro, JoyCode, Trae | No: no PostToolUse hook | No |

*Unverified*: built and tested from the agent's documented or source-read hook payloads, not yet checked in a live session.

**Known limits.**

- **Cursor, Copilot CLI and ZCode subagents.** A recall run in a subagent never credits the main agent's reads: Cursor and Copilot CLI give the subagent its own session with no link to the parent, and ZCode runs no hooks in it. A recall the main agent runs itself does vote.
- **OMP.** The subagent path needs the main session's file on disk: when it has none (`--no-session`), the subagent is not linked to its parent and gives no adoption. OMP sets no session variable in its shell, so a run settles only through the claim of the `bash` call that ran it: when OMP moves a large output into an artifact, the `run=` line and the vote are lost, and an OMP started from a Claude Code shell records its run under the Claude session until that claim corrects it.
- **Searches not counted.** OMP's `grep` (a markdown tree) and Cursor's `Grep` add no evidence; opening the doc still counts. ZCode prints `Grep` lines relative to its working directory, so a ZCode search run from a directory inside the team repo is not counted.
- **No PostToolUse hook.** OpenClaw, Hermes, Kiro and JoyCode record their recalls but no reads, so these recalls never vote.
- **Older CLIs.** A member on an older TeamAI still votes from the session transcript, and that path keys a skill, a doc in a subdirectory or a wiki page by its file's basename (`SKILL`, `setup`) rather than the id recall prints (`retry`, `common/setup`), so those votes miss the doc. Top-level learnings and docs are unaffected, and upgrading ends it.

**In `teamai stats`.** When the current scope's recall log has runs, `teamai stats` adds a recall section after the skill usage, with the 10 sessions that recalled most recently, newest first:

```text
Recall (last 10 sessions):

  session   agent   runs  recalled  adopted
  3f2a9c1e  claude     3         3        1
  a41d07b2  codex      1         2        0
```

`session` is the first 8 characters of the agent session id; a subagent's own session (OpenCode's task tool) counts under the session that started it. `agent` comes from the session's newest run that names one: the agent whose hook claimed the run, else the one its environment named; it is `-` when no run names one. `runs` counts the runs that belong to the session, a search with no hits included; a run whose session is ambiguous and never confirmed is left out, and `--check` is no run. `recalled` counts the distinct docs those runs returned, and `adopted` the docs already upvoted from them: a read still waiting for the session's Stop is not counted yet. 

Without runs in the log the output is unchanged.

### Enabling / Disabling Recall

The Recall feature is controlled by a two-tier configuration — admins set the team default, and members can override it locally:

| Tier | Config file | Field | Description |
|------|----------|------|------|
| Team default | `teamai.yaml` | `sharing.recall.enabled` | `true` / `false` (default `false`) |
| User override | `~/.teamai/config.yaml` | `recallEnabled` | `true` / `false`, takes priority over the team default |
| Environment variable | shell | `TEAMAI_RECALL_DISABLED=1` | Force-disables all recall hooks (emergency kill switch) |
| Environment variable | shell | `TEAMAI_UPVOTE_JUDGE=1` | Opt-in: on a git-team session a background pass asks your local signed-in CLI whether the latest reply substantively used each recalled doc not yet upvoted for the session, and upvotes that subset. A doc already in the session's upvote ledger (the session opened it, or an earlier judge pass upvoted it) is never sent to the judge, so a doc is upvoted at most once per session; a doc the judge turned down is judged again on a later turn; an inherited user-scope doc is not upvoted while a project is active. Off by default; runs detached (no added latency) and uses your CLI subscription |

```bash
teamai recall enable     # Enable recall, deploy the subagent and rules
teamai recall disable    # Disable recall, remove the subagent and rules
teamai recall status     # View the current effective status (team default + user override)
```

Append `--dry-run` to `enable` or `disable` to preview the config and managed-artifact changes without writing them.

When disabled, `teamai pull` skips deploying the recall subagent and the TodoWrite reminder hook, and removes the recall block from the team instructions. Manually running `teamai recall <query>` to search is not affected by this switch.

### Knowledge Base Maintenance

Over time, some learnings accumulate low confidence scores (nobody upvoted them) or become stale. `teamai recall maintenance` keeps the knowledge base healthy:

Flags are listed in [`commands.md`](../../skill-data/core/references/commands.md) and `teamai recall maintenance --help`.

```bash
# Preview stale entries without changing anything
teamai recall maintenance --prune --dry-run

# Archive low-confidence learnings (confidence < 0.15)
teamai recall maintenance --prune --archive

# Rewrite confidence scores to frontmatter based on current votes
teamai recall maintenance --confidence-writeback

# Find stale entries and generate update drafts
teamai recall maintenance --update-quality
```

After `--update-quality`, review the generated `.draft.md` files and rename them to `.md` to apply the updates.

While another teamai command holds the learnings or reports checkout's lock, `recall maintenance` and `recall promote` exit 1 without writing anything (`The learnings checkout is locked: …`). Run them again when that command finishes.

Maintenance and promote publish only the learnings they changed. A file in the learnings checkout that nobody committed stays out of their commit. When the publish cannot run or push (`Maintenance changes stay local for now: …`), the next `teamai pull` or `contribute` publishes the change, even with no learning queued. A learning edited by hand after that run is not published as part of it: the edit stays uncommitted, and a warning names the file. A file someone staged in the checkout stays staged across the publish; when origin changed it too and it can no longer be staged as it was, it keeps its content as an unstaged change, and a warning names it.

### Promoting Learnings

When a learning reaches maturity, promote it to formal team knowledge (a skill, rule, or doc). Promotion criteria: confidence ≥ 0.90, ≥ 5 upvotes, ≥ 2 distinct contributors, age ≥ 14 days.

```bash
# List all promotion candidates
teamai recall promote

# Promote a specific learning (AI rewrites it into the target format)
teamai recall promote <learningId>

# Promote to a specific category
teamai recall promote <learningId> --category skills

# Preview what would happen without writing files
teamai recall promote <learningId> --dry-run
```

Options are listed in [`commands.md`](../../skill-data/core/references/commands.md) and `teamai recall promote --help`.

---

## Knowledge Base Health Report

The dashboard includes a built-in **KB Health** report page showing your team knowledge base's usage and health, covering everything captured by `teamai recall` votes, learnings, docs, rules, and skills.

```bash
# Start the dashboard, then open "Team Context" (KB Health) or "Team Improvement" (maintenance)
teamai dashboard

# The report is served directly at:
#   http://localhost:3721/kb-report
```

The report aggregates your local `~/.teamai` knowledge base (or the configured team repo) and renders on demand — no flags to pass.

### What the Report Shows

| Section | Description |
|---------|-------------|
| **Overview cards** | Total entries, total recalls, overall coverage %, contributors |
| **Coverage by type** | Breakdown of recall coverage across skills, rules, docs, learnings |
| **Top recalled** | Ranked list of most frequently recalled entries |
| **Silent entries** | Entries that have never been recalled — candidates for pruning or rewriting |
| **Last-recall month** | Each entry counts once in its latest recall month, not monthly recall volume |
| **Author contributions** | Per-contributor entry counts and recall share |
| **Maintenance console** | Three action zones: entries ready to promote, entries suggested for archiving, and stale entries needing updates — each with a copyable command |

### Typical Workflow

```
Open the dashboard → Team Improvement
   ↓
Review the Maintenance Console
   ↓
Promote mature learnings:
   teamai recall promote <learningId>
   ↓
Archive low-value entries:
   teamai recall maintenance --prune --archive
   ↓
Update stale docs/rules/skills:
   teamai recall maintenance --update-quality
   (review .draft.md → rename to .md)
   ↓
teamai push   # share the cleaned-up knowledge base with the team
```
