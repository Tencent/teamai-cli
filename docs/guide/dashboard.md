# Dashboard

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

Open `http://localhost:3721`. The sidebar is Overview, Team Execution, Team Context, and Team Improvement. The numbers are from this machine.

## Human Intervention Metrics

Each session counts three things: an interrupt mid-run (`interrupt`), a denied tool call (`toolReject`), and a correction right after the agent stops, such as "wrong" or "redo" (`correction`).

A team adds its own words in `teamai.yaml`:

```yaml
sharing:
  intervention:
    correctionKeywords: [rehazlo, "no era eso"]
```

New prompts pick this up after the next `pull`. What reaches the team is the count, not the text.

## Conversation Volume & Token Usage

A session row shows how many prompts were sent and how many tokens were used. A tool that does not report usage shows 0 tokens.

## Session Save

```bash
teamai session save
teamai session save --session-id <id>
teamai session save --push
teamai session save --push --force
```

The local copy goes to `~/.teamai/session-logs/<year-month>.md`. `--push` sends a session that had friction, or that used at least 3 different tools, to the team's `teamai-reports` branch. The prompt text stays out unless you pass `--include-prompt`.

## Session Sync & Migration

Beyond summaries, `teamai session` can move full conversation transcripts between AI tools and archive them in the team repo. Where `session save` records a privacy-scrubbed summary, these commands carry every message.

Supported platforms: `claude-code` (plus `claude-internal` / `tclaude`), `codex` (plus `codex-internal` / `tcodex`), `codebuddy` (CLI), `codebuddy-ide` (the IDE sidebar), `cursor`, and `workbuddy`. `teamai session platforms` shows which are installed locally.

```bash
teamai session platforms                                             # supported vs installed
teamai session migrate <sessionId> -s codebuddy-ide -t claude-code   # one session across tools
teamai session migrate --all -s codebuddy -t claude-code              # every session of the source (--limit to cap)
teamai session rollback <targetSessionId> --platform claude-code     # undo a migration
teamai session push --source codebuddy            # archive this directory's sessions
teamai session push --source codebuddy --all      # every workspace of that platform
teamai session pull                               # pull + re-index team sessions
teamai session list                               # this project's team sessions
teamai session list --all                         # every archived project
teamai session search <query> [--all]             # full-text search of archived content
teamai session resume <sessionName> --platform claude-code   # restore into a local tool
```

All of these accept `--dry-run` and `-v`. `migrate --push` migrates and archives in one step; `resume` prints the new session id — continue it with your tool's own resume flag.

**Confirmations.** `--all` asks for confirmation once it passes 10 sessions (push: more than 5) and refuses outright in a non-interactive run, so a script cannot silently skip the batch — pass `-y` to confirm. Migrating a platform onto itself reuses the native session id and overwrites the source transcript, so it needs `--target-cwd <dir>` (write a copy elsewhere) or `-y`. `push` also asks before archiving unredacted transcripts; `--scrub` redacts them first.

**Archive layout.** Sessions are archived under the git identity of their working directory: `sessions/repos/<repo>/<author>/` in the team repo. Sessions from non-git directories land under `_unattributed`. The archive key comes from the session's own workspace — not from where you run the command — so migrating from another directory still archives under the right project. CodeBuddy IDE sessions whose workspace cannot be resolved fall back to `_unattributed` with a warning.

**Project-level vs user-level repos.** `list` / `pull` / `resume` filter by the current directory's git remote, so a project-level team repo shows exactly that project's sessions. Pass `--repo-root <any clone>` — for example a personal repo — and use `--all` to read across every archived project.
