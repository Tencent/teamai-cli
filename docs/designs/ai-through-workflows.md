# Every AI call through a workflow

> Status: In progress — #1589, #1391.

## Problem

Eleven places launch an AI tool or a judge without a workflow run:

| Site | Command that reaches it |
|---|---|
| `src/maintenance/promote.ts` `generatePromotedContent`, `inferCategory` | `recall promote`, and the dashboard on every cache expiry |
| `src/maintenance/quality-update.ts` | `recall maintenance --update-quality` |
| `src/import-local.ts` `classifyWithAI` | `import --from-claude`, `import --from-iwiki` |
| `src/import-mr.ts` | `import --from-mr`, `ci extract-mr` |
| `src/deep-enrich.ts` | `codebase --deep-enrich`, `import --from-repo`, `import --dir`, hidden `deep-enrich` |
| `src/enrich-with-ai.ts` | codebase extraction under every import of a repo or a directory |
| `src/codebase.ts` `generateCodebaseMd` | `import --from-repo` |
| `src/iwiki-dual.ts` | `import --from-iwiki --iwiki-dual` |
| `src/votes-judge.ts` | the Stop hook with `TEAMAI_UPVOTE_JUDGE=1` |
| `src/session-flow/scoring.ts` `runLocalJudge` | `score --session <id> --scorer ./draft.md` |
| `src/codebase.ts` `generateCodebaseIndex`, `lintCodebaseMd`, `applyCodebaseSuggestions` | nothing: dead code |

Each one picks its own tool, timeout, fallback and output, a team cannot change any of it, and no driver but this
process can run it.

Goal, as one rule each:

- **Generation is a workflow.** A feature that asks an AI tool for text ships as a default workflow in `workflows/`,
  and its command is a shortcut that starts it.
- **Judgment is a scorer.** Anything that judges AI work is a scorer judged by `teamai-score`.
- **Only drivers launch tools.** `teamai/launch-through-workflows` fails an import of the launcher outside
  `src/workflow/`.

## What a member sees

Nothing changes for a command a member already runs:

```text
$ teamai recall maintenance --update-quality
ℹ Found 2 entry(ies) recalled often but rarely adopted:
ℹ   - [docs] retry-policy: recalled 9x by 3 users, adopted 0x
ℹ   - [docs] helm-values: recalled 6x by 2 users, adopted 1x
ℹ
Generating AI-powered update drafts...
✔   Draft written: ~/.teamai/team-repo/docs/retry-policy.md.draft.md
✔   Draft written: ~/.teamai/team-repo/docs/helm-values.md.draft.md
Review drafts, then rename .draft.md -> .md to apply updates.
```

Behind it, a run of `teamai-draft-learning-updates` on the driver `workflows.driver` names (local when unset). `--json`
prints the run's envelope instead of the text. No shortcut grows a `--driver` flag: a member whose agent drives runs
sets it once, and the same command leaves the run for the agent's `teamai workflow next`:

```yaml
# ~/.teamai/config.yaml
workflows:
  driver: none
```

A team changes the prompt, the timeout or the model by committing a file of the same name. It runs the same
`recall maintenance` verbs, so the command prints what it printed:

```yaml
# workflows/teamai-draft-learning-updates.yaml in the team repo
schemaVersion: v1alpha1
name: teamai-draft-learning-updates
description: Draft an update for each stale learning, in our house style.
invoke: deny
private: true
steps:
  - id: stale
    command: teamai recall maintenance stale
    output:
      entries: [{ doc_id: string, path: string, type: string, recalled_count: number, upvoted_count: number, user_count: number }]
  - id: draft
    needs: [stale]
    for_each: steps.stale.outputs.entries
    continue_on_failure: true
    workflow:
      steps:
        - id: context
          command: teamai recall maintenance draft-context --path "$ENTRY" --doc-id "$DOC_ID"
          env: { ENTRY: "{{ item.path }}", DOC_ID: "{{ item.doc_id }}" }
          output: { content: string, related: string }
        - id: ask
          needs: [context]
          answer: |
            Rewrite this entry so it states what is still true today. Keep our headings: Context, Rule, Example.
            Output only the file.

            {{ steps.context.outputs.content }}
          output: { text: string }
          timeout: 120s
        - id: write
          needs: [ask]
          command: teamai recall maintenance write-draft --path "$ENTRY" --draft "$DRAFT"
          env: { ENTRY: "{{ item.path }}", DRAFT: "{{ steps.ask.outputs.text }}" }
          writes: [.teamai/]
          output: { draft: string }
  - id: report
    needs: [draft]
    if: steps.draft.outcome == 'success' || steps.draft.outcome == 'failed'
    command: teamai recall maintenance draft-report --results "$RESULTS"
    env: { RESULTS: "{{ steps.draft.results }}" }
    output: { text: string, exit_code: number }
outputs: { text: steps.report.outputs.text, exit_code: steps.report.outputs.exit_code }
```

## Generic keys this adds to the engine

Every key is generic: the engine never branches on a feature.

### `answer:` — a prompt that only answers

```yaml
- id: category
  answer: "Is this learning a skill, a rule or a doc? {{ steps.read.outputs.text }}"
  output: { category: skill | rule | doc, reason: string }
  timeout: 30s
```

- No separate workspace. The tool answers in the checkout, reserved until the answer finishes. A change to the
  checkout fails the step `read_only_dirty`, as for other read-only steps.
- The tool is chosen as the launcher chose it before: `TEAMAI_AI_TOOL`, `ai.tool` of the project, of the machine, then
  the first installed tool of the launch order. Every tool with a `call` launch runs it.
- The launched session is marked as teamai's own, so the member's hooks do not capture or judge it.

### `writes:` — the paths a command step may change

```yaml
- id: publish
  command: teamai recall maintenance promote-publish --learning "$ID" --category "$CATEGORY" --reason "$REASON" --content "$CONTENT"
  env: { ID: "{{ inputs.learning }}", CATEGORY: "{{ steps.category.outputs.category }}", … }
  # The review branch is written in a disposable worktree, under .teamai/ when the knowledge is this checkout's.
  writes: [.teamai/]
```

A change under a listed path is kept. Any other change still fails the step `read_only_dirty`.

### `steps.<id>.failure`

```yaml
- id: content
  answer: "Rewrite this learning as a {{ steps.category.outputs.category }}: …"
  continue_on_failure: true
- id: unconfigured-tool
  needs: [content]
  if: steps.content.failure.code == 'tool_unconfigured'
  end: unconfigured-tool
- id: publish
  needs: [content]
  # Any other failure publishes the learning as written: --content renders empty.
  if: steps.content.outcome == 'success' || steps.content.failure.code != 'tool_unconfigured'
  command: teamai recall maintenance promote-publish --learning "$ID" --content "$CONTENT" …
```

`failure` is `{ code, message }`, `null` for a step that did not fail. An answer step reports a tool the member names
that cannot run as `tool_unconfigured`, and the fallback must not hide it, so an `end` fails the run:
`continue_on_failure` alone would let it succeed with nothing done.

### Parallel steps

```yaml
- id: modules
  for_each: { items: steps.plan.outputs.modules, max_parallel: "{{ inputs.concurrency }}" }
```

- On the local driver, with no `workflows.max_parallel`, a `for_each` runs its items in parallel up to its own
  `max_parallel`, which may read `inputs`, and every other step runs one at a time. Other drivers already run ready
  steps side by side. Answers in the checkout run one at a time, including across `for_each` items; an answer with
  `workspace: new` reads a worktree of its own and runs beside them.
- `workflows.max_parallel`, when a member or machine sets it, caps every step on the local driver as before, and the
  open leases of a run on every driver.

### Runs with no `teamai init`

```text
$ cd ~/src/orders-api
$ teamai codebase --deep-enrich --project orders-api --output ./wiki
```

Where no config serves the directory, a shortcut's start builds one for the run: a temporary directory holding a
workspace config for the current checkout, its data home and an empty team repo. The run is driven on the local driver
in the command's process. Every process of its steps gets the config file as `TEAMAI_EPHEMERAL_CONFIG` and loads it
instead of resolving one from its directory. The directory is removed when the run ends, so the command prints no
resume or retry command, starts no drain, and leaves nothing in `~/.teamai`. `workflow start` itself still needs
`teamai init`. A shortcut may give a team repo checkout in place of the empty one, as `ci extract-mr --team-repo` does:
when it holds a `teamai.yaml`, the scope reads it where it is, and its workflows replace the defaults of the same name.

### Shortcuts

- A shortcut prints the run's `outputs.text` and exits with `outputs.exit_code`; `--json` prints the envelope.
- The engine keeps each step's progress lines; the local driver prints them as they come, other drivers read them. A
  line keeps its stream: what a verb would print on stdout in a terminal (`log.info`, `success`, `warn`) is marked in
  its stderr, which the local driver reads as the step's progress, and the shortcut prints it on stdout; an unmarked
  line, such as `log.error` or a spinner's, stays on stderr.
- A shortcut of a released command starts as the CLI, so a coding agent that ran `teamai import --dir` before still
  can. Inside a workflow attempt, it drives its private run in the step's own process.
- `--dry-run` either stops before the start, or passes `dry_run: true` to a workflow whose write steps check it. A
  shortcut whose run then writes nothing (`preview`) loads the member's config read-only, as `--dry-run` does.
- A shortcut names its run only when it stops driving it before it ends, interrupted or waiting on a person:
  `Run <id> is still open. Continue it with: teamai workflow resume <id>`. A run that ended prints no run line.
- A private shortcut run starts no drain, and neither does a shortcut inside a workflow step, private or not.

## Workflows

```text
workflow                               invoke   what it composes
teamai-codebase-enrich                 deny     enrich modules → domain summary
teamai-codebase-deep-enrich            deny     component docs (5 at once) → architecture → G5
teamai-import-from-repo                deny     for each repo or dir: scan → codebase.md → enrich → deep-enrich → write
teamai-import-from-mr                  ask      for each MR: extract → choose → publish        (mr-hint offers it)
teamai-import-rules                    deny     rule dirs of every tool → teamai-import-learnings → push
teamai-import-from-iwiki               deny     fetch → teamai-import-learnings → push → dual sections
teamai-import-learnings                deny     classify (3 at once) → choose per item → write accepted by type
teamai-ci-extract-mr                   deny     teamai-import-from-mr → comment | write → enrich → deep-enrich
teamai-promote-learning                ask      category → content → publish teamai/push/… → mark promoted
teamai-draft-learning-updates          deny     for each stale entry: draft
teamai-try-scorer                      deny     teamai-score on the session and on its control → report
teamai-new-scorer                      ask      draft with the person → teamai-try-scorer → approve → pull request
teamai-share-learnings-from-sessions   ask      session list --finished --all → choose per session → teamai-share-learnings each, unpublished
```

Each command keeps its name, flags, output and exit code:

| Command | Workflow |
|---|---|
| `import --from-repo`, `--from-repo-list`, `--from-org`, `--dir` | `teamai-import-from-repo` |
| `import --from-mr` | `teamai-import-from-mr` |
| `import --from-tools` (`--from-claude` is its alias) | `teamai-import-rules` |
| `import --from-iwiki` | `teamai-import-from-iwiki` |
| `ci extract-mr` | `teamai-ci-extract-mr` |
| `codebase --deep-enrich`, hidden `deep-enrich` | `teamai-codebase-deep-enrich` |
| `recall promote <id>` | `teamai-promote-learning` |
| `recall maintenance --update-quality` | `teamai-draft-learning-updates` |
| `score --session <id> --scorer ./draft.md` | `teamai-try-scorer` |

`recall promote` without an id and the dashboard list candidates with no AI call: their suggested category comes
from keywords, and the AI chooses inside `teamai-promote-learning`.

## Judgment

### Recall adoption as a default scorer

`votes-judge` is removed. Each finished session that recalled documents it never opened gets one generated question
per such document, as skill routing does:

```text
session 7c1e…  recalled: pod-startup-timeouts, helm-values, retry-policy
opened by a tool call  → helm-values                      credited, no judge
teamai:adoption:3f9a1c (pod-startup-timeouts)  → adopted   upvote, judged_count +1
teamai:adoption:b27e04 (retry-policy)          → ignored   judged_count +1
```

```yaml
# scorers/scoring.yaml in the team repo
recall_adoption: true
```

```yaml
# ~/.teamai/projects/<project>/config.yaml, one member
scoring:
  recall_adoption: true
  sessions: { attended: auto }
```

`TEAMAI_UPVOTE_JUDGE=1` still works: it reads as the member setting above, and `teamai doctor` says so. A machine's
`~/.teamai/config.yaml` can turn adoption off, never on.

### Default scorers a team replaces

teamai ships `scorers/teamai-routing.md` and `scorers/teamai-adoption.md`. A team file of the same name replaces one:

```markdown
---
# scorers/teamai-adoption.md in the team repo
labels:
  - { value: adopted, score: 1, description: "The final reply used {{ doc.id }} to decide or to write code." }
  - { value: ignored, score: 0, description: "Nothing in the final reply depends on {{ doc.id }}." }
passingScore: 1
sessions: true
---
Judge only {{ doc.id }}. Its text is in recalled/{{ doc.file }} in the evidence.
```

Pull rejects a replacement that reads a variable the default does not offer (`doc.id`, `doc.path`, `doc.file` for
adoption; `skill.name` for routing), and the default runs.

### Confidence

```text
upvoted_count          total, as before (tool + judge + manual)   ← every reader keeps reading it
judge_upvoted_count    upvotes from adoption labels
judged_count           sessions in which the document was judged
recalled_session_count sessions that recalled it

tool   = upvoted_count − judge_upvoted_count
r      = min(1, tool / max(1, recalled_session_count))
ratio  = r + (judged_count > 0 ? judge_upvoted_count / judged_count : 0) × (1 − r)
```

| Document | recalled sessions | tool | judged | judge | ratio before | ratio now |
|---|---|---|---|---|---|---|
| `helm-values` | 10 | 6 | 3 | 1 | 0.70 | 0.73 |
| `retry-policy` | 10 | 0 | 2 | 2 | 0.20 | 1.00 |
| `pod-startup` | 10 | 0 | 0 | 0 | 0.00 | 0.00 |

A document that is judged in a session is credited once, however often the session is judged again, and a later
tool-call credit of the same session is blocked. The local votes file stores the session/document identities with
the counter mutations under one lock; the recall journal is a retry and reporting projection. Those identities
survive journal retention and vote synchronization.

### Trying and writing a scorer

```text
$ teamai score --session 7c1e --source claude-code --scorer ./scorers/answers-cite-sources.md
answers-cite-sources   cited      score 1   passed   "Every claim links the file it read."
control                uncited    score 0            the rubric fails a session that did nothing
```

`teamai-new-scorer` drafts the rubric with the person, tries it on a real session with `teamai-try-scorer`, and
proposes `scorers/<name>.md` to the team as a pull request.

## Fixes folded in

| Fix | Where |
|---|---|
| An import that writes teamwiki takes an exclusive lock per wiki root | `utils/import-lock.ts` |
| A failed classification fails the import instead of importing nothing | `import-local.ts` |
| `--update-quality` finds skills and reports entries it could not draft | `maintenance/quality-update.ts` |
| An imported rule or doc lands in its directory (`type:` is written) | `import-local.ts` |
| `--from-org` exits 1 when a repository fails | `import-org.ts` |
| "Branch pushed" only after a push | `import-codebase.ts` |
| `ci extract-mr` calls the GitHub API `GITHUB_API_URL` names: comment, reactions, git user | `ci/mr-comment.ts`, `ci/read-rejections.ts`, `ci/extract-mr.ts` |
| `ci extract-mr --write-mode pending-review` says it has no effect | `ci/extract-mr.ts` |
| The CI examples check out the merge commit with its parent (`fetch-depth: 2`) | `examples/ci/README.md` |
| `recall promote <missing id>` exits 1 on both paths | `index.ts`, `maintenance/promotion-publish.ts` |
| Two imported items of one title on one day keep their own files | `import-local.ts` |
| `import --from-tools` leaves out the rules teamai delivered, by the delivered-copies ledger | `import-local.ts` |

## Behaviour that changes

- Confidence uses the estimator above, so prune and promote may pick other documents.
- The per-item review of `import --from-tools` and `--from-iwiki` is the driver's choice prompt, `accept`, `edit` or
  `skip` with an optional note; the options and their order stay, and `edit` takes the note as the title. It needs a
  terminal: inside a workflow step or with piped input, the import is refused before any AI call and says to pass
  `--all`. `--resume` is refused with the `teamai workflow resume <run>` that replaces it, and no
  `~/.teamai/import-session.json` is written.
- `import --from-tools` scans the user rules directory of every tool in `TOOLS`, `.mdc` included; `--from-claude` is
  its hidden alias. The commit says `Import from local: tool rules`. No `teamai init` is refused before any AI call,
  and an `--output` import names each file it wrote by its absolute path. `--iwiki-dual` asks for the sections from
  the pages it already fetched, once the import is pushed.
- A failed classification and an `--update-quality` entry that could not be drafted exit 1.
- Imported rules and docs land in `rules/` and `docs/` instead of `learnings/`; the classifier has no skill type.
- In a team repo, `codebase --deep-enrich` asks for each component doc once, with no sequential retry of the batch,
  names each failed step with its retry command, and `--json` prints the run envelope. Its run publishes the docs in a
  `publish` step (input `publish`), so a run finished with `workflow resume` publishes them too. The hidden `deep-enrich` holds
  the import lock. A teamwiki outside a team repo (`--output`, a hidden `--wiki-root`) is written by the same
  workflow, with no `teamai init` needed, and the hidden `deep-enrich` prints the result line there too. A failure
  several steps share, such as a tool that cannot run, is said once with the step ids.
- `import --dir`, `--from-repo`, `--from-repo-list` and `--from-org` extract each source before any AI call, so the
  `AI enrich:` line follows the extract summary, and its `Output:` is a directory of the run. A batch says its
  repositories in the order their steps run, names a failed one with `import failed: <url>` after the failing step's
  own error, and prints its `Batch import complete` line plainly. The deep-enrich retry names the absolute `--output`
  directory. Each line a step says keeps the stream it had, so the pull request lines stay on stderr.
  An `--output` teamwiki takes the import lock too. The lock file is under `~/.teamai/locks`, in no checkout. Each
  step that writes the teamwiki takes the lock as well (`whileTeamwikiLocked`) and records its run's
  `$TEAMAI_RUN_DIR` in it, so the run holds the lock between its steps until it ends, also after it stopped and while
  `workflow resume` continues it; under the command's own hold, which its steps inherit, a step goes on. A run with no
  `teamai init` cannot be resumed, so its steps record no run and the lock lasts only while a process of it does.
- `import --from-mr` drafts every MR before the review, which is the driver's choice prompt as for `--from-tools`
  (`edit` takes the note as the title) instead of `Accept learning? [Y/n]`, and is refused the same way without a
  terminal. The prompt always has the review-thread guidance and a `Review threads (N):` section. The `AI analysis`
  spinner and the task list are gone: publishing says `Learning published` or `Published N learnings`, and the
  teamwiki lines `Incremental teamwiki update skipped: …` and `Push changes via MR skipped: …` are plain. A failed MR of
  several is named `  failed: <url>` after its step's own error, and a single one names the failed step with its retry
  command. `--output` paths are absolute, and `--dry-run` drafts each MR in a run that neither reviews nor publishes.
- `ci extract-mr` drafts through `teamai-import-from-mr`, so its `AI analysis` spinner is gone, `--output` is said by
  its absolute path, and an MR it cannot read also names the failed step. The review threads leave out a comment
  `ci extract-mr` posted by its signature line, so the extraction no longer takes `--comment-marker`. A run with no
  `teamai init` takes `--team-repo`'s `teamai.yaml` and workflows.
- `session list --finished --all` lists every finished session of this machine from the last `--within` (7 days by
  default) that no learning was contributed from, whatever the session policies say, with when it was last active and
  its first prompt, redacted; any run may list them. It was refused before. `session show <id> --source <platform>`
  prints a session, redacted as `teamai score evidence` reads it, so an agent can share learnings from a session that is
  not its own; the share skill says so.
- The session-start MR hint offers `teamai-import-from-mr` with each MR's URL, and describe proposes those MRs to the
  session the hint listed them in. Where a hook may not offer the workflow, such as in a session teamai launched, the
  hint names `import --from-mr` as before.

## Test seams

| Seam | What it catches | What it misses |
|---|---|---|
| The real CLI, through `npm run test:e2e` | a shortcut's output, flags and exit code | which step produced it |
| `inProcessClient` start / next / report | each generic key, on any driver | the tool process |
| `parseWorkflow` | diagnostics of the new keys | runtime |
| The local driver with a fake tool on `PATH` | the `answer` tool ladder, the hook marker | other drivers |
| Domain verbs | each feature's own behaviour | the workflow around it |
| `computeConfidence`, `mergeDeltas`, `incrementUpvoted` | the estimator, delta sync, dedupe | the scorer that feeds them |
| `teamai score plan` / `write` | adoption questions, credit, retry | the judge |
| Pull of a team scorer | default scorer replacement and its diagnostics | judging with it |
| `ruleHarness` | the launcher ban | — |
| The dashboard in a browser, at 390, 768 and 1440 px | candidates, adoption and confidence panels | — |
