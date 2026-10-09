# Dashboard

> [English](dashboard.md) | [简体中文](zh-CN/dashboard.md)

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai dashboard             # Start the web dashboard (default port 3721)
teamai dashboard --port 8080
```

The sidebar contains **Overview**, **Team Execution**, **Team Context** and **Team Improvement**. Overview summarizes the three modules. Execution shows this machine's sessions, filters by repository (every worktree of a repo is one entry) and AI tool, and opens complete session details. Context contains KB Health (including author contributions and never-recalled entries); Improvement contains local trends and the original promotion/archive/quality-update maintenance commands. Commands are displayed for use in your terminal; the dashboard does not execute them.

Use the header to select English or Simplified Chinese and light, dark, or system theme. Preferences are saved in browser storage when available. User prompts, AI output, knowledge titles and commands are not translated. The standalone `/kb-report` remains available as the original complete report.

Live status is **local**, using the existing events/SSE stream with automatic reconnect and a session reconciliation poll. Recently ended sessions remain visible for the existing 30-second retention window. Knowledge reports show their local/team scope and generation time, **not a claimed team sync time or cross-member live status**. A failed refresh is labeled and any previous result is retained until a successful retry.

Workspace selection covers installed project scopes and user scope; linked worktrees share a project, and the all-workspaces view shows every local session and the startup knowledge scope. Restart the dashboard to discover newly installed scopes.

## Human Intervention Metrics

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

## Conversation Volume & Token Usage

Each session row also shows two columns; Details retains secret-redacted captured prompt summaries, Markdown AI output, timestamps and the last tool:

| Column | Meaning | Data source |
|------|------|----------|
| Prompts | The **number of human conversation turns** in the session (how many prompts were sent) | Count of `UserPromptSubmit` events |
| Tokens | The session's cumulative **token usage** (hover to see input / output / cache read / cache write breakdown) | Claude Code `message.usage`, CodeBuddy `requests[].usage`, or Codex's latest session-level `token_usage_record`; legacy `event_msg.token_count` snapshots are summed once per rollout file |

> Privacy: shared turn/token metrics contain counts only. Redacted prompt summaries and output in dashboard details remain on this machine.

These two metrics are likewise aggregated into `stats/<user>.yaml` (as `prompts` and `tokens` fields) during `teamai pull`, and shown in the "Conversation Volume & Token Usage" section of `teamai digest`, with team-wide totals, bucketed token totals, and per-person token usage rankings. Tools without transcript access (e.g. Cursor) degrade gracefully: turn counts are still tracked, while tokens show as 0 / N/A.

## Daily Session Trends & Estimated Cost

The dashboard and digest compare the latest seven UTC calendar days with the seven days before them. The dashboard cost card now uses **average known estimated cost per priced session**: sum the available priced-request costs of sessions whose first Stop falls within the period, then divide by the number of those sessions with at least one priced request. Unpriced sessions are excluded; a priced zero-cost session is included. The card reports priced-session coverage. A resumed session keeps its first-Stop cohort and adds its available costs, even if a request occurred on another day. The original `avgRequestCostMicros` API field and digest request-day accounting remain unchanged. 

A session belongs to the day of its first stop event, while each priced request belongs to its own UTC request day. Active time counts only adjacent event gaps of five minutes or less, so idle terminals do not inflate the result. A session succeeds when it ends without an error, interruption, or correction; rejected tool calls remain a separate intervention signal. Privacy-safe request details (model, token counts, estimated cost, and price-table version; no prompt or response content) stay in `~/.teamai/dashboard/requests.jsonl`, are deduplicated across repeated Stop hooks, and are removed after 90 days.

Cost is an API-equivalent estimate for recognized Claude model IDs, based on versioned public list prices and the input, output, cache-read, and cache-creation token buckets in the transcript. Cache creation uses the five-minute write rate because transcripts do not expose cache TTL. Unknown models and tools without usage details are excluded from both estimated cost and its coverage denominator. This estimate is useful for trends, but it is not an invoice or a subscription-seat charge.

Daily aggregates are added to `stats/<user>.yaml` during `teamai pull`; existing cumulative fields remain available as lifetime statistics. Resumed sessions are updated in place without double-counting completed sessions. Only aggregate counts and estimated micro-dollar totals are shared with the team repository; prompt text and per-request records stay local.

## Session Save

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
