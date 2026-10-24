# Dashboard

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

Open `http://localhost:3721`. The sidebar is Overview, Team Execution, Workflow Runs, Team Context, Resources, Distribution, and Team Improvement. The numbers are from this machine.

## Workflow Runs

The Workflow Runs page has two lists for the selected workspace. **Local runs** are the run files on this machine, read live: status, the leased steps, the HITL requests waiting for an answer, and whether a settled run's record reached the team. **Team-reported history** is the run records on the `teamai-reports` branch, from every member. Each row shows the workflow, driver, status, named end, duration, tokens, team revision (absent when no pushed commit held the definitions; the source hash shows either way), and the delivered pull requests.

The page shows what a run record publishes, plus each step's live status and the options of a waiting HITL request. Inputs, `for_each` items, outputs, prompts, HITL messages, and local paths stay in the run file. Read a HITL question where the run's driver asks it.

A waiting approve or choose request can be answered from the run's details. The answer goes through the same `respond` operation as the CLI, with channel `dashboard` and `agent: false`, so it can answer a required approval. It carries the pass the page showed: if that request was answered or replaced in the meantime, the page shows the refusal and reloads. Another website cannot send an answer. A request without an `Origin` header, such as a plain `curl`, is refused too. This marks an answer as sent from a browser; it does not stop a local script that sets the header.

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

Platforms: `claude-code`, `codex`, `codebuddy`, `codebuddy-ide`, `cursor`, `workbuddy`, and `opencode` (through the `opencode` CLI, version 2 or later; an OpenCode target workspace must exist). `teamai session platforms` lists what is installed here. CodeBuddy CLI and WorkBuddy project directory names longer than 255 UTF-8 bytes use the native 180-byte prefix and hash, so listing, reading and migration work for long workspace paths as well. On Windows, `cursor` and `workbuddy` cannot be a migrate or resume target: they list a session only once the `sqlite3` CLI registers it, so TeamAI refuses instead of writing a copy they never show.

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

A migration never overwrites. If the target workspace already has a copy of the session, from this TeamAI or an older one, `migrate` prints `already migrated as <id>` and writes nothing, so turns you added to the copy stay. To refresh a copy, delete it with `session rollback <id> --platform <tool> --cwd <workspace>` and migrate again. `session resume` follows the same rule: a session already restored into that workspace prints `already restored as <id>` and is left as it is.

For a script, `migrate <sessionId> -s <tool> -t <tool> --json` prints one line on stdout, the same `{ "data": ... }` or `{ "error": { "code", "message" } }` shape as `teamai workflow`; progress goes to stderr. `data` has the target `sessionId`, `cwd`, `reused`, and the `fidelity` report. `error.code` names the failure, such as `no_adapter` (unknown tool), `tool_unavailable` (the source or target tool is not installed, or its CLI cannot run), `not_found`, or `unreadable`, and the exit code is 1. `--json` never prompts: a missing id, `-s`, or `-t` fails with `prompt_refused`, and `--push` needs `-y` or `--scrub`.

`--dry-run` previews. `--scrub` redacts before an archive; without it, an interactive run asks and a script needs `-y`. `--all` confirms above 10 sessions (push: 5). Archives go to `sessions/repos/<repo>/<author>/` under the session's own git remote, or `_unattributed`. A session that a workflow step ran in its own worktree goes under the repository of the checkout that the worktree came from.

Session commands use the team repo clone of this project's install, else of the user install, so you need `--repo-root` only to point at another clone. With no install, they print `teamai is not set up for this directory.`, name `teamai init` and `--repo-root`, and exit 1.

When this repo is the team repo, archives live on the `teamai-reports` branch. While another teamai command writes that branch, `session push`, `session migrate --push`, and `session pull` print `Error: Another teamai command is writing teamai-reports` and exit 1 without changing the branch. `migrate --push` keeps the copy it made. Run the command again once the other one has finished.

On one machine, `session push`, `migrate --push`, and `session pull` serialize archive changes through Git publication. A second command waits up to ten seconds, then reports the lock and asks you to retry. A failed archive write removes its new pair or restores the previous transcript and metadata before returning an error; a retry reuses the session name. If rollback itself fails, the error names the retained backups for recovery.
