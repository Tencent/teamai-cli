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
