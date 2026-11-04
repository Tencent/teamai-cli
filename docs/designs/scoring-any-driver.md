# Scoring on any driver

> Status: Implemented — follow-up to #1700.

## Problem

`teamai-score` and the workflows that run it (`teamai-share-session`, `teamai-share-learnings`,
`teamai-finished-sessions`) assume the local driver and this machine's PATH in several places:

| Where | What it assumes |
|---|---|
| `hook-handlers.ts` | finished sessions are always resumed with `--driver local` |
| `score-drain.ts` | the drain calls `runLocalDriver` directly |
| `score-commands.ts` | `teamai score` defaults to `local` |
| `protocol.ts` `judgingOf` | describe decides judging from this machine's PATH |
| `score-labels.ts` `stageJudge` | a label a check, CI or protected stage decided needs a judge tool on PATH, or it is lost |
| `score-plan.ts` | judge groups are formed by the tool this machine's PATH resolves |
| `session-share.ts` | the share offer drops verified scorers when no tool is installed |

And the skill driver cannot record a label at all: its session subagent judge reports no confined run, so
`teamai score label` fails `judge_failed` ("The judge step recorded no confined run, so what judged is unknown.").

Goal: every driver can run the judging workflows by itself, at least best-effort. `local` is only the default driver.

## Design

### Judging on the skill driver

```
skill driver, judge step leased
  host h1-h3  -> subagent judges, best-effort, read access   -> its result carries a confined run record
  host h4     -> background runner runs the session tool headless, best-effort,
                 when the tool is a confined tool and its executable is on PATH
                 (else judging off, naming who can judge)
  any host    -> session tool reaches verified -> background runner judges at verified (unchanged)
```

- The confined run record comes from the attempt's dispatch, which records the tool when the child is dispatched.
- A takeover that changes the session tool releases the open confined attempts; the next `next` leases them again
  under the new tool.
- The PATH probe lives in the skill driver, which passes its real confined offers to describe. Describe decides the
  judging line from the offers it is given:
  `"<scorers> need a verified judge, which this session's driver does not offer; their runs stay open for a driver that does."`

### The engine checks a confined report against its lease

The lease keeps the `ConfinedLease` (level, tools) it was granted with. A report is accepted when its tool is one of
the lease's tools and its isolation is at least the lease's level (the level is a minimum: a local judge may reach
`verified` on a `best-effort` lease). A success that names no confined run, or a mismatch, fails the step with a
structured failure. A lease granted before this
change has no stored terms and is not checked. A best-effort judge never reports `verified`.

### Default driver

```yaml
# teamai.yaml (team), ~/.teamai/config.yaml (member), or the workspace/self overlay (member, per project)
workflows:
  driver: acme-sandbox
```

| Precedence | Source |
|---|---|
| 1 | `--driver` |
| 2 | member, project (workspace/self overlay) |
| 3 | member, user (machine config) |
| 4 | team (`teamai.yaml`) |
| 5 | `local` |

- Names: `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Reserved: `local`, `none`, `skill`, `fleet`. Config checks the format only; a
  bad value is warned about and skipped, as `workflows.retention` is.
- `skill` is valid for `--driver` but not as a default: it needs a session, and an agent cannot drive
  `teamai-score` or `teamai-finished-sessions` (`invoke: deny`).
- Any other valid name is a driver definition a member, the team or teamai provides. Until definitions are resolved,
  an explicit `--driver <name>` is refused with `unsupported_driver`.
- `none` as a default leaves the run unassigned, as `--driver none` does today.
- `workflow start` and `workflow resume` without `--driver` do not read the key: they keep starting unassigned, which
  external drivers rely on.

The finished-sessions hook, `teamai score --drain` and `teamai score` decide through one function:

```
parseDriver(name) -> local | skill | none | { external: name }
drivesHere(config, name) -> Promise<boolean>        // local: yes; anything else: no, until definitions are resolved
driveByDefault(config) -> Promise<{ kind: drive | awaits, driver: name } | { kind: unassigned }>   // unassigned: none
driveRun(config, run, name)                         // workflow-drive.ts: the one way start, --drain and score drive a run; the hook passes --driver <name>
```

The `awaits` line is built in one place. A driver that takes a lease of the run clears `awaits`; one that asks and is
given none leaves it. A later drain that finds the run still open says who has it: the driver it awaits, none while it
is left to any driver, or a driver that took it.

When this machine does not drive the default, the run starts unassigned with `awaits: { driver }` in its run state,
which every machine sees, and the command prints:

```
<run> waits for driver acme-sandbox, which this machine does not run. To drive it here: teamai workflow resume <run> --driver local
```

### Marks and lapses

| Root run ended with | Mark |
|---|---|
| a judge attempt that ran for the mark's scorer (stopped, cancelled, failed, or running at the end) | one more lapse, as today |
| no judge attempt that ran for it (never leased, or only released) | `lapsed`, same count |
| a missing or unreadable root run | one more lapse, as today |

Whether a judge ran is asked of the scorer, not of the group the mark was planned in: a scorer already labelled leaves
the judged group smaller. A mark keeps the time it first opened across restarts. Restarts that count no lapse stop 14
days after it, by when the mark is read, and a named request starts the window again. Such a restart spends no daily-limit slot: its `open` line carries a marker
that both the limit check and the day's count skip.

### Labels a stage decided

```diff
 judge:
   { kind: model, tool, model, isolation, access, usage }   # a model judged
   { kind: human }                                         # hand label
+  { kind: stage }                                         # check, ci or protected decided; decidedBy says which
```

`kind: stage` requires a stage `decidedBy`. Labels already written with `kind: model` and a stage `decidedBy` stay
valid and are read as stage-decided (`isStageDecider`), and keyed the same way so a pass is not counted twice. Results
group by scorer and decider, not by tool name.

### Judge groups and the judge tool

Scorers share one judge call by model, stages and preferred tool only. The tool is chosen when the judge step is
leased, from the driver's confined offers, in this order of preference:

```yaml
# scorers/review-quality.md frontmatter
model: strong        # unchanged: an alias of models/aliases.yaml, resolved per tool
tool: codex          # new, optional: preferred judge tool
```

1. the scorer's `tool`, when the driver offers it (any well-formed name; an unknown one is warned about, not refused);
2. the tool the scored pass ran in;
3. the driver's offers, in its order.

`tool` is a preference: a driver that does not offer it judges with another tool it offers.

### Share offer

The share offer no longer filters out verified scorers: a verified-only session would get `scorers: []` and no run
another driver could judge. The `judge: here | driver` input is removed from `teamai-share-session`,
`teamai-share-learnings` and `teamai-finished-sessions`.

### Retrying a step after its run ended

`$TEAMAI_RUN_DIR` is removed when a run ends. Retrying `score[0].label` after it failed then read a directory that no
longer exists. A retry also runs again the steps whose output fields the retried step uses in its templates (not reads
that appear only in `if`) when those fields hold a path inside the run directory that no longer exists, in its own
workflow or one around it. When that step is in a workflow around it, the `workflow` step that holds the retried step
runs again after it, whether it is still running or not, so its steps read the path only once it is written again. It
checks each path, so a second retry still finds what a step run since did not bring back.
`workflow retry` prints what else it runs.

```
workflow retry <run> score[0].label     # after the run ended
  runs again: score[0].evidence, score[0].check, score[0].ci, score[0].protected, score[0].judge, score[0].label, ...
```

### Judge answer shape

The `teamai-score` judge prompt asks for the answer object while the confined schema wraps it in `answer`; a judge
whose tool does not enforce the schema follows the prompt and fails. The prompt and the schema are made to agree, and the prompt names the evidence directory only through
`{{ steps.evidence.outputs.dir }}`, the same expression as `workspace.confined`.

## Breaking changes against v0.29.0

- New label judge kind `stage`: earlier versions skip those label lines.
- `judge` is no longer an input of `teamai-share-session` and `teamai-share-learnings`; a team file that passes it
  fails to parse until it drops it.

## Out of scope

- Drivers on another machine: a lease hands out a local directory, and the score steps read this machine's data home.
- Agents driving `teamai-score` or `teamai-finished-sessions`: they stay `invoke: deny`.
- Resolving driver definitions by name; this design only leaves the seams (`parseDriver`, `drivesHere`, `awaits`).
- Judges that call a model API instead of an agent tool. They fit as a judge tool (a tool whose confined profile is a
  request, access `answer`) that a driver offers in `can.confined`; nothing here assumes the judge is a CLI, and a
  label takes `access` from the confined run record rather than from the tool's profile.
