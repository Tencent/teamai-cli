# Dashboard

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

Open `http://localhost:3721`. The sidebar is Overview, Team Execution, Team Context, Resources, and Team Improvement. The numbers are from this machine.

## Resources

The Resources page lists every rule in the team repo for the selected workspace: its name, namespace, description, and whether `pull` delivers it there. Root rules reach everyone; namespaced rules follow the active knowledge namespaces, and a root rule is marked replaced when an active namespace rule of the same name stands for it. Rules left out by tag subscriptions are marked too.

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

`teamai session` moves a full transcript between tools, or archives it in the team repo. `session save` remains the scrubbed summary.

Platforms: `claude-code`, `codex`, `codebuddy`, `codebuddy-ide`, `cursor`, `workbuddy`. `teamai session platforms` lists what is installed here.

```bash
teamai session migrate <sessionId> -s codebuddy-ide -t claude-code
teamai session migrate --all -s codebuddy -t claude-code   # --limit caps it
teamai session rollback <id> --platform claude-code
teamai session push --source codebuddy                     # --all: every workspace
teamai session pull
teamai session list                                        # --all: every project
teamai session search <query>
teamai session resume <name> --platform claude-code
```

`--dry-run` previews. `--scrub` redacts before an archive; without it, an interactive run asks and a script needs `-y`. `--all` confirms above 10 sessions (push: 5). Archives go to `sessions/repos/<repo>/<author>/` under the session's own git remote, or `_unattributed`.
