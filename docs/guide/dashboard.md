# Dashboard

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

```bash
teamai dashboard
teamai dashboard --port 8080
```

Open `http://localhost:3721`. The sidebar is Overview, Team Execution, Workflow Runs, Scorers, Team Context, Resources, Distribution, and Team Improvement. The numbers are from this machine.

## Session sharing

The Overview's **Session sharing** panel says, for the selected workspace, whether its sessions are published to `teamai-reports` and scored in each [run mode](workflow.md#attended-and-unattended-runs), and why:

- Each mode's publish and scoring policy, and the setting it came from, such as `the default` or `teamai.yaml sessions.publish.unattended`. `ask` acts as `off` for now.
- The sessions captured on this machine in each mode: active, waiting for a drain, kept on this machine, waiting to be archived, and archived. A session whose file is gone is not counted. Also the step sessions of ended runs that wait to be archived.
- What waits, and the drain to run for it. A drain finishes and publishes only the sessions of its own run mode, so on an attended machine the panel names `TEAMAI_MODE=unattended teamai score --drain` for unattended sessions, or `$env:TEAMAI_MODE='unattended'; teamai score --drain` on Windows.
- The archive, `daily_limit`, the scorers that judge sessions, the enabled tools teamai reads no sessions from, and the settings problems `teamai doctor` reports.

**This machine** is the run mode of the shell that started `teamai dashboard`. The panel shows counts and setting names, never a session's text, and changes no setting. The settings are in [Sessions](sharing.md#sessions) and [Finished sessions](scorers.md#finished-sessions).

## Workflow Runs

The Workflow Runs page has three lists for the selected workspace. **Local runs** are the run files on this machine, read live: status, the leased steps, the HITL requests waiting for an answer, and whether a settled run's record reached the team. **Team-reported history** is the run records on the `teamai-reports` branch, from every member. Each row shows the workflow, driver, status, named end, duration, tokens, team revision (absent when no pushed commit held the definitions; the source hash shows either way), and the delivered pull requests.

**Handed-off runs** are the running runs someone [published](workflow.md#continue-a-run-on-another-machine), with the command that takes each one:

| Row | What it needs | Next step |
|---|---|---|
| `release` · Offered · alice | Needs a person: only a person can answer the approval at ship | `teamai workflow resume <run> --claim`, run by a person |
| `ship-issue` · Offered · alice | Nothing: a runner can finish it | `teamai workflow resume --next`, in a checkout of that repository |
| `release-docs` · Offered · alice | A runner needs: env `SIGNING_KEY`, a tool for notes. Not on this machine: sign requires env SIGNING_KEY, which has no value here → Set it in the environment, or declare it in the team repo (teamai env add SIGNING_KEY --secret) | `teamai workflow resume --next`, in a checkout of that repository |
| `nightly-report` · Held · bob | — | `teamai workflow resume <run> --claim` takes it over from bob |

On the install that offered a run, the next step is `teamai workflow resume <run>` instead, which takes it back there. A local run that is offered, or that another install now holds, says so under its status. **A runner needs** (**Their machine needs** on a run that needs a person) lists the `requires.env` keys and prompt steps of the steps left: set those up on the runner, as [its job](workflow.md#take-offered-runs-from-ci) does. **Not on this machine** is what this machine lacks of them, as `teamai workflow resume` lists it as `cannot run here`. The status line counts the offered runs and the ones that need a person. The page claims nothing: the command runs a driver on the machine that takes the run.

The page shows what a run record publishes, plus each step's live status and the options of a waiting HITL request. Inputs, `for_each` items, outputs, prompts, HITL messages, and local paths stay in the run file. Read a HITL question where the run's driver asks it. A run's details show what each pass delivered: the commits on its branch, the pull request delivered for it, and the learnings `teamai contribute` recorded inside its attempt.

A waiting approve or choose request can be answered from the run's details. The answer goes through the same `respond` operation as the CLI, with channel `dashboard` and `agent: false`, so it can answer a required approval. A dashboard started inside an agent session records `agent: true`, as an answer from that shell would, and cannot answer a required approval. It carries the pass the page showed: if that request was answered or replaced in the meantime, the page shows the refusal and reloads. Another website cannot send an answer. A request without an `Origin` header, such as a plain `curl`, is refused too. This marks an answer as sent from a browser; it does not stop a local script that sets the header.

## Scorers

The Scorers page shows the pass rate of every [scorer](scorers.md) that has labels, from `scores/<member>/<YYYY-MM>.jsonl` on `teamai-reports` and from this machine's label store. It answers two questions: is a scorer's pass rate moving, and does it differ by tool, model, team revision or definition.

**One measurement at a time.** A measurement fixes the scorer, the rubric version (`rubric.sourceHash`, with its `teamRevision` when it has one), the source (`workflow` or `session`), the run mode, and the judge (a hand label, or the judge's tool and recorded model). Labels that differ in any of these are never counted together. A scorer opens on a model judge's measurement when it has one, even when members hand-labelled more sessions, and on its newest rubric whose labels carry a `teamRevision`, so an uncommitted draft does not become the default. The other measurements are listed above the numbers. Labels without a run mode are counted under `Not recorded`.

**What it shows:**

- The pass rate over a window of 7, 30, 90 or 180 days, with the label count, passed and failed. The window is about when labels were scored, not when the work happened. A label rescored later counts once, when it was rescored.
- A weekly trend. A week with no labels is drawn as a gap, not 0%.
- **Labels by value**: how many labels of the measurement stored each value, with the score it stood for, highest score first. The counts add up to the label count, so a scorer with more than two values keeps what told its failures apart, and precision or recall can be read from them. Values are shown as the labels stored them.
- Pass or fail as each label stored it. Changing a scorer's `passingScore` does not change past results.
- **Group by** tool, model, team revision, agent definition, the role, project or tag the team assets were delivered for, fingerprint, or a team skill the work used. A label that lists two skills counts under both. Model groups keep a model the tool reported apart from one that was only requested. A label that did not record that part is `Not recorded`. A workflow label is grouped by the agent of the pass it judged, read from the run's record. A run recorded before agents were observed gives only its definition.
- **Split at team commit.** Give a commit of the team repo. A label is after it when its team revision contains the commit, checked with `git merge-base --is-ancestor` in this machine's team clone. A label with no team revision, or one this clone does not have, is `Not recorded`. The split also applies inside each group, so you can compare the sessions that loaded a skill before and after the commit that changed it.
- **Failing labels**, newest first: author, scored time, platform and the skills used. The page lists 25 at a time, up to 1,000; **Show more** lists the next ones. Select a group to list only its failing labels. A session pushed to the team archive shows `teamai session resume <name> --platform <platform>`. A workflow label opens its run.
- **Friction reminder**, for a session measurement: the sessions the friction reminder fired on and those it did not, with how many have a label of this measurement and how many of those passed. It covers your own sessions that started on this machine in the window, at most the last 30 days, because the reminder state is only kept on this machine. A project workspace covers its own sessions. The user scope workspace covers the sessions that started outside every project workspace on this machine. The pass rate is over labelled sessions only. A session with no reminder state here is `Not recorded`. When a session's state file is removed a day after its last write, teamai keeps whether its reminder fired for 30 days.

**Judge agreement with hand labels**, for a session measurement. A [hand label](scorers.md#label-a-session-by-hand) is a member's own reading of a session. The panel shows whether to trust the judge's pass rate:

```text
Judge agreement with hand labels   13 hand-labelled sessions
JUDGE                            LABELS  PAIRED  AGREE  AGREEMENT  JUDGE PASSED, HUMAN FAILED  JUDGE FAILED, HUMAN PASSED
claude-code / claude-sonnet-4-5  23      8       6      75%        1                           1
codex / gpt-5.1-codex            12      3       1      33%        2                           0
Hand label                       13

Where they disagree
HAND LABEL         BY     JUDGE SAID   JUDGE                            SCORED      OPEN
missed-bug failed  bob    good passed  claude-code / claude-sonnet-4-5  10/27/2026  Not pushed to the team archive
partial failed     alice  good passed  codex / gpt-5.1-codex            10/26/2026  teamai session resume claude-code_add-a-timeout-to-the-webhook-client_20261026 --platform claude-code
```

Here the Codex judge passed two sessions the team failed, so its pass rate reads high. Open those sessions, then sharpen the rubric's prompt or its label descriptions.

- Each judge label of the rubric in the window pairs with the newest hand label of its session, whoever gave it and whenever. A hand label pairs only while the rubric lists its value: in the scorer `teamai pull` cached, or in the scorer file at the team revision the rubric's labels carry in this machine's team clone. So after a prompt edit, the new rubric's judge labels pair with the hand labels already given.
- Agreement is on pass or fail. **Judge passed, human failed** means the judge is more lenient than members, **judge failed, human passed** that it is stricter.
- **Where they disagree** lists each disagreement, newest first.
- The scorer table's **Agrees with hand labels** column shows the same for each scorer's default measurement.

Labels from benchmark runs are left out. The page reads labels and recorded configuration only. It never reads or shows a judge's reasoning, a prompt, a transcript, a diff, or a session's own id.

Labels from sessions and workflow runs show how the tools did on the work that came along. To compare tools, models or team assets on the same tasks, run a benchmark.

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

The 7-day trends count only your own sessions: a session teamai launched, such as a workflow step, is left out. Below them, the sessions that ended in the last 7 days are split by [run mode](workflow.md#attended-and-unattended-runs): attended, unattended, and `not recorded` for sessions recorded before modes were. See [Usage reporting](reporting.md#your-sessions-by-run-mode).

## Session Outcomes

The Overview's **What finished sessions delivered** panel shows the sessions the usage report counted in the last 30 days for the selected workspace: the share that delivered a commit, pull request or learning, the rows per run mode and outcome with tokens and interventions per session (see [Usage reporting](reporting.md#what-your-sessions-delivered)), and the latest sessions with their commits, pull request links and learnings.

A session row and its details show the learnings `teamai contribute` recorded for it. Its commits and pull request are counted 6 hours after it goes quiet, after the row has left the list, so they show in the panel. These ids, shas and links stay on this machine.

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
teamai session push --session <id> --source claude-code    # exactly that session, scrubbed
teamai session pull
teamai session list                                        # --all: every project
teamai session search <query>
teamai session resume <name> --platform claude-code
```

A migration never overwrites. If the target workspace already has a copy of the session, from this TeamAI or an older one, `migrate` prints `already migrated as <id>` and writes nothing, so turns you added to the copy stay. To refresh a copy, delete it with `session rollback <id> --platform <tool> --cwd <workspace>` and migrate again. `session resume` follows the same rule: a session already restored into that workspace prints `already restored as <id>` and is left as it is.

For a script, `migrate <sessionId> -s <tool> -t <tool> --json` prints one line on stdout, the same `{ "data": ... }` or `{ "error": { "code", "message" } }` shape as `teamai workflow`; progress goes to stderr. `data` has the target `sessionId`, `cwd`, `reused`, and the `fidelity` report. `error.code` names the failure, such as `no_adapter` (unknown tool), `tool_unavailable` (the source or target tool is not installed, or its CLI cannot run), `not_found`, or `unreadable`, and the exit code is 1. `--json` never prompts: a missing id, `-s`, or `-t` fails with `prompt_refused`, and `--push` needs `-y` or `--scrub`.

`--dry-run` previews. `--scrub` redacts before an archive; without it, an interactive run asks and a script needs `-y`. `--all` confirms above 10 sessions (push: 5). `push --session <id>` pushes exactly that session of `--source`, from any workspace, always scrubbed and without a prompt. Archives go to `sessions/repos/<repo>/<author>/` on the team repo's `teamai-reports` branch, under the session's own git remote, or `_unattributed`. A session that a workflow step ran in its own worktree goes under the repository of the checkout that the worktree came from.

Session commands use the team repo clone of this project's install, else of the user install, so you need `--repo-root` only to point at another clone. With no install, they print `teamai is not set up for this directory.`, name `teamai init` and `--repo-root`, and exit 1.

Sessions archived on the default branch by an older teamai stay readable there. `session list`, `search` and `pull` read both places, `teamai-reports` first, and list a session in both once. `session resume` reads `teamai-reports`, then the old archive. teamai 0.28.0 and earlier read only the default branch, so upgrade every member to see the sessions teammates archive on `teamai-reports`. An unattended job archives its own sessions with `teamai score --drain` ([Sessions](sharing.md#sessions)).

While another teamai command writes `teamai-reports`, `session push`, `session migrate --push`, and `session pull` print `Error: Another teamai command is writing teamai-reports` and exit 1 without changing the branch. `migrate --push` keeps the copy it made. Run the command again once the other one has finished.

On one machine, `session push`, `migrate --push`, and `session pull` serialize archive changes through Git publication. A second command waits up to ten seconds, then reports the lock and asks you to retry. A failed archive write removes its new pair or restores the previous transcript and metadata before returning an error; a retry reuses the session name. If rollback itself fails, the error names the retained backups for recovery.
