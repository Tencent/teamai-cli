# Team Context

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

Team Context is learnings, the codebase graph, and teamwiki. `teamai recall` searches all of them.

## Knowledge Capture & Retrieval

### Contributing knowledge

When you correct the AI, deny a tool call, or the AI retries a failing command, the session ends with a reminder that offers teamai's [`teamai-share-learnings`](workflow.md#teamai-share-learnings-and-teamai-share-session) workflow:

```text
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 6 times.

Task: The payments pod restarts in a loop after deploy; find out why

Offer the person the teamai-share-learnings workflow: run `teamai workflow start --describe teamai-share-learnings --driver skill` and start it with the inputs it proposes, once the person confirms them.
```

The agent shows you what it proposes: share what the session taught, one learning or several, publish the transcript, score the session. You confirm or change it, and then it runs. What happens to each offer:

| Offer | Who decides |
|---|---|
| The learnings | You, while you work them with the agent: say what to share, each under which namespace, or that nothing is worth sharing |
| `Share these 2 learnings with the team? [...]` | The agent under the recommended start, or you when you pick "ask me at optional approvals" |
| Publishing the transcript, scrubbed | You, at the start: keep or change `publish`. Nobody asks again. An agent that starts the run with `--confirmed` can answer for you |
| Scorers | Nobody asks again: they judge the scorers you confirmed at the start |

Each session is offered this at most once. The reminder keeps its old text, "Consider running `/teamai share what this session taught me` … (or run `teamai skill get share`)", where `teamai-share-learnings` cannot run: in a session teamai launched (a workflow step or a judge), in a workflow worktree, in an unattended session, while the session drives a workflow run that is not done, and when the team's `workflows/teamai-share-learnings.yaml` sets `invoke: deny`. While recall is off there is no reminder, and pull writes no `teamai-share-learnings` skill; `/teamai-share-session` still publishes and scores the session.

Or hand in a note yourself:

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --namespace payments
```

`--namespace` must be a learnings namespace this scope's projects declare in `manifest/projects.yaml`, or its roles in `manifest/roles.yaml`. `--namespace ""` writes to the shared root `learnings/`.

[The usage report](reporting.md#what-your-sessions-delivered) counts the learning as an outcome of the session it came from (`--session-id`, else the agent's session). When teamai can tell which tool ran that session, the learning also names it as `session` in its frontmatter.

To stop the prompt, set this in `teamai.yaml`:

```yaml
sharing:
  contributeHint:
    enabled: false
```

On one machine, set `contributeHintEnabled: false` in `~/.teamai/config.yaml`, or `TEAMAI_CONTRIBUTE_HINT_DISABLED=1`.

### Importing rules and iWiki pages

```bash
teamai import --from-tools                  # the rules directory of every AI tool on this machine
teamai import --from-tools --all            # accept every item without asking
teamai import --from-iwiki 12345            # an iWiki space, or a page URL with /p/<id>; needs TAI_PAT_TOKEN
teamai import --from-tools --output ./out   # write into ./out, push nothing
```

The AI tool classifies each file as a rule, a doc or a learning, and leaves out the personal ones. Then it asks you about each of the others:

```text
Step "learnings.review[0].ask": Deploy rule (rule) from /home/alice/.claude/rules/deploy.md
Summary: Deploy only on weekdays.
Tags: ["deploy"]
accept writes it; edit writes it with your note as its title; skip leaves it out.
Options: accept, edit, skip
teamai workflow respond <run> 'learnings.review[0].ask' <option> --pass 1
Choice, followed by an optional note: edit Weekday deploys
```

An accepted item lands by its type in `rules/`, `docs/` or `learnings/` of the team repo, with that `type:` in its frontmatter, and the import commits and pushes. A file the AI tool cannot classify fails the import, and nothing is written. The review needs a terminal: inside a workflow step, or with input that is not a terminal, pass `--all`. `--from-claude` is the older name of `--from-tools`. The workflows behind these are [`teamai-import-rules` and `teamai-import-from-iwiki`](workflow.md#default-workflows); a stopped import continues with `teamai workflow resume <run>`, which replaces `--resume`.

### Searching knowledge

```bash
teamai recall "API timeout"
teamai recall --check "API timeout"
```

`--check` answers only `RELEVANT` or `NOT_RELEVANT`. A codebase hit may add a `Source freshness:` line. The statuses are in [Codebase Knowledge Graph](#codebase-knowledge-graph) below.

### Relations between assets

A rule, a doc or a learning can declare relations to other team assets in a
`related:` frontmatter block, and a local Markdown link to another asset
becomes a `REFERENCES` relation on its own:

```markdown
---
related:
  MAPS_TO: teamwiki/evidence/code/pay/modules/ledger-receipts.md
  REFERENCES: [docs/payments-overview.md, skills/release]
---
```

Four relations are declarable: `MAPS_TO` (this describes that teamwiki code
page), `REFERENCES` (any asset), `SUPERSEDES` and `CONFLICTS_WITH` (a rule,
doc or learning — a learning that disagrees with a rule uses
`CONFLICTS_WITH`, because `teamai contribute` publishes learnings without
review). Skills and teamwiki pages are targets only: they never declare.
The other code-graph relations (`DEPENDS_ON`, `CONTAINS`, `IMPLEMENTS`)
relate code to code and cannot be declared on an asset.

`teamai recall` prints each relation as a `Related:` line after the hit's
`File:` line — `→` for a relation from the hit, `←` for one the other asset
declares, at most 5 per hit. A `→ MAPS_TO` / `← MAPS_TO` pair can also
be derived from a rule's `paths:` glob (below), not only declared. A relation whose other end this recall
cannot see (another scope's asset, a withheld codebase's page, a target that
does not exist) prints nothing. Hits, their order and their scores do not
change. `teamai review --branch` fails a rule or doc whose `related:` block
declares something outside the table; `teamai contribute` prints the same
problems as warnings and still publishes.

### Recall adoption and upvotes

Opening a document that recall returned counts as one upvote for this session. A doc the session used without opening it, through a recall subagent's summary for example, is credited by an [adoption question](scorers.md#recall-adoption) once `recall_adoption` is on. Only eligible recalled docs can receive a vote, once per root session. You can also record it by hand:

```bash
teamai recall feedback --positive <docId>
teamai recall feedback --negative <docId>
```

Confidence, which ranks, prunes and promotes a doc, rates how often the sessions that recalled it adopted it. Reads rate every session that recalled the doc; a judge's verdicts rate the rest:

```text
pod-startup-timeouts   recalled in 10 sessions, upvoted 5 times, 2 of them by a judge, which was asked 4 times
tool  = 5 − 2 = 3            r = 3 / 10 = 0.3
judge = 2 / 4 = 0.5          ratio = 0.3 + 0.5 × (1 − 0.3) = 0.65
```

Before, the ratio was upvotes ÷ recalls, here 0.5. A votes file written before this counts one session per recall.

Local feedback affects ranking on the next index rebuild (for example, `teamai pull`), even when report uploads are disabled or fail. Rebuilds combine confirmed team votes with undelivered local votes. If the votes file is busy, that rebuild uses confirmed votes only.

Index rebuilds reuse unchanged files' parsed tokens. Changes, deletions, source selection and votes still take effect on every build. `~/.teamai/debug.log` reports how many files were reused, rebuilt or dropped. Older indexes and a different Node/ICU version trigger a full parse once.

When the log has runs, `teamai stats` lists the last 10 sessions that ran recall: their runs, the docs recalled and adopted (read, or judged adopted), and how many runs the session opened a `Related:` line's file from.

### Enabling / Disabling Recall

Recall is off until the team turns it on:

```yaml
sharing:
  recall:
    enabled: true
```

```bash
teamai recall enable
teamai recall disable
teamai recall status
```

One machine overrides this with `recallEnabled` in `~/.teamai/config.yaml`. `TEAMAI_RECALL_DISABLED=1` forces it off, and `teamai recall status` names it when it does. While it is off, pull does not install recall and removes the recall agent and rule an earlier pull installed. `teamai recall` still searches. The variable changes files that every shell in the scope shares: a pull from a shell with it set removes the recall files and the CLAUDE.md recall block for the whole scope, and a pull from a shell without it puts them back.

A team can ship its own recall agent: see [Replace the recall agent](sharing.md#replace-the-recall-agent).

Turning recall off does not silence the SessionStart hint for recently merged MRs. That hint lists them and offers the default workflow [`teamai-import-from-mr`](workflow.md#default-workflows), which can capture and publish a learning before the team enables recall:

```text
[teamai:mr-hint] Found 1 recently merged MR(s) not yet imported into the team knowledge base.

After this task, offer the user to turn these MRs into learnings with the teamai-import-from-mr workflow. Its describe proposes these MRs:

- Retry flaky upload (merged: 2026-11-04) https://github.com/org/repo/pull/123

  teamai workflow start --describe teamai-import-from-mr --driver skill
```

In that session, describe proposes the MRs the hint listed, and the agent starts the workflow once you agree. In a session teamai launched, the hint names `teamai import --from-mr <url...>` instead. The hint has its own switch, so a team can turn it off without touching `contributeHint`:

```yaml
sharing:
  mrHint:
    enabled: false
```

On one machine, set `mrHintEnabled: false` in `~/.teamai/config.yaml`, or `TEAMAI_MR_HINT_DISABLED=1`.

`language` in `teamai.yaml` is `en` or `zh`. `en` makes the built-in recall rule, the TodoWrite hint, and the merged-MR hint English only. Omit it, or set `zh`, and those texts stay bilingual. The next `teamai pull` rewrites the recall rule.

### Knowledge Base Maintenance

```bash
teamai recall maintenance --prune --dry-run
teamai recall maintenance --prune --archive
teamai recall maintenance --update-quality
```

`--archive` puts aside learnings whose confidence is below 0.15. `--update-quality` writes a `.draft.md` beside each entry the team recalls often but rarely adopts. Rename it to `.md` when the draft is right; until then `teamai pull` delivers none of it. It runs the default workflow [`teamai-draft-learning-updates`](workflow.md#default-workflows), and exits 1 when an entry could not be drafted.

Digest and maintenance commands (`teamai digest`, `teamai recall maintenance`, and `teamai recall promote`) include the active learnings namespaces for the current scope alongside the shared root.

Maintenance and promotion read a learning's frontmatter `date` whether it is quoted (`date: "2026-03-28"`) or unquoted (`date: 2026-03-28`). A timestamp keeps its time when applying age thresholds.

Confidence is an activity score from 0 to 1, not a probability that the knowledge is correct or a task succeeded. Its upvote-to-recall ratio is capped at 1, so repeated positive feedback cannot exceed that factor's 30% weight. Recency uses the later of the last recall and the last upvote, so a fresh upvote also refreshes recency.

### Promoting Learnings

A learning can become a skill, rule, or doc when its confidence is at least 0.90, it has at least 5 upvotes, at least 2 contributors, and it has existed for at least 14 days.

Promoted skills use `skills/<learningId>/SKILL.md`, with missing `name` and `description` frontmatter filled in so tools can discover them. Rules and docs remain Markdown files in their respective directories.

```console
$ teamai recall promote
ℹ 1 learning(s) eligible for promotion:
ℹ   - retry-deploys (confidence: 0.94, suggested: rules)

$ teamai recall promote retry-deploys
✔ Promotion artifact pushed to branch teamai/push/alice/20261104-230453
ℹ Create a pull/merge request for teamai/push/alice/20261104-230453 to review the promoted knowledge.
✔ Promoted: retry-deploys -> rules/retry-deploys.md
✔ Published promotion marker to the learnings branch
```

Listing makes no AI call: `suggested` comes from the learning's keywords. `teamai recall promote <learningId>` runs the default workflow [`teamai-promote-learning`](workflow.md#default-workflows). The member's AI tool picks the category and says why, unless `--category skills|rules|docs` gives it, then rewrites the learning for that category. When the AI cannot answer, the keyword category and the learning as written are used. When `TEAMAI_AI_TOOL` or `ai.tool` names a tool that cannot run, the command fails and publishes nothing. `--dry-run` only prints where the entry would go, in the keyword category unless `--category` is given. A learning that is not a candidate exits 1.

Promotion pushes the new entry to a review branch. Its commit, and the PR/MR it opens when the provider supports it, say the category and why:

```text
[teamai] Promote retry-deploys to rules

Category: rules

It states what the team always does after a 502, so it reads as a rule.
```

With the `git` provider, open the review request yourself using the printed branch name. The learning is marked as promoted only after the entry is pushed; merge the review request before teammates pull it. If the push fails, the learning stays eligible for retry. If a review request is closed without merging, delete its branch and the learning is offered for promotion again. Existing target files are never overwritten.

## Codebase Knowledge Graph

`teamai import` writes a source repo into the team repo's `teamwiki/`. `teamai recall` searches it too. Every source lands in the same place, `<team repo>/teamwiki/evidence/code/<slug>/`; the source directory itself gets no `teamwiki/`.

```bash
teamai import --dir /path/to/project
teamai import --dir /path/to/project --incremental
teamai import --dir /path/to/project --max-files 1000
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg
teamai import --from-repo-list repos.yaml
teamai import --from-mr https://github.com/org/repo/pull/123
teamai import --from-mr https://github.com/org/repo/pull/123 https://github.com/org/repo/pull/124
teamai import --from-repo https://github.com/org/repo --incremental
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

`--from-repo-list` runs up to 3 imports at once by default. `--concurrency <n>` sets this limit and must be a positive safe integer. Invalid values fail before the repo list is read or output is prepared. On your machine their AI calls run side by side, while extracting and publishing take turns.

`--dir`, `--from-repo`, `--from-repo-list` and `--from-org` run the default workflow [`teamai-import-from-repo`](workflow.md#default-workflows). Each source is extracted with no AI, your AI tool describes its modules and writes its deep docs, and the indexes are rebuilt and published once for the whole batch. A repository that fails does not stop the others: the batch names it and exits 1. While one import writes a `teamwiki/`, another import into it is refused; run it again once the first has finished. An import that stopped, which you can continue with `teamai workflow resume`, keeps the lock until its run ends, so another import is refused with the `teamai workflow resume <run>` and `teamai workflow cancel <run>` commands that end it.

`--from-mr` runs the default workflow [`teamai-import-from-mr`](workflow.md#default-workflows). Your AI tool drafts a learning from each MR first, then you review each draft on its own:

```text
Step "review[0].ask": Retry budget per route from https://github.com/org/repo/pull/123
Tags: ["retry","gateway"]
Overlapping learnings: []
Draft: ~/.teamai/workflows/runs/<run>/scratch/mr-…/learning.md
accept publishes it; edit publishes it with your note as its title; skip leaves it out.
Options: accept, edit, skip
Choice, followed by an optional note: edit Cap gateway retries
```

`--all` accepts every draft without asking. The review needs a terminal: with piped input or inside a workflow step, the import is refused before any AI call and says to pass `--all`. The accepted learnings are published once at the end, and each repository's teamwiki is updated once. An MR that fails does not stop the rest; the run ends with a summary and exits non-zero if any failed.

GitHub import reads commit pages of 100 when `gh pr view` reaches its 100-commit limit, or when import falls back to REST, up to the [GitHub endpoint's 250-commit limit](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request). A failed `gh` commit page triggers REST fallback. If REST cannot read the PR, import exits 1 before AI extraction and writes no learning for that PR. This changes the exit code for a full `gh pr view` result whose later commits cannot be read: it used to exit 0 with only the first 100 headlines. Scripts must handle the failure and retry after fixing access or request failures.

GitLab MR import reads commit pages of 50 instead of using only the first page, up to 100 pages. Each GitLab MR API request has a 30-second deadline, including reading its response body. A metadata timeout fails that MR; a commits, diff or review-threads timeout leaves out that optional data and continues. Each commit or review-thread page gets its own deadline. A later commit-page failure leaves out the whole commit list rather than passing an incomplete history to extraction.

For GitLab `--from-org`, and for GitHub `--from-org` on both the `gh` path and the REST fallback, each page of the group or organization project list has a 30-second deadline, including reading its response body. A timeout on any page fails the import before writing the whitelist or importing repositories, and neither path falls back to `/users/<org>/repos` after a page has timed out.

The extraction reads the MR's review threads along with its description, commits and diff: GitLab discussions, GitHub review comments, reviews and conversation comments, TGit notes. Each thread goes into the prompt with the file and line it is anchored to, whether it is resolved, and its notes marked as the MR author's or a reviewer's; a decision in a resolved thread outweighs the diff. teamai's own CI comments are skipped. `--no-discussions` leaves the threads out, for `teamai ci extract-mr` too. With `language: en` in `teamai.yaml` the learning is written in English; otherwise in Chinese.

If an AI-generated MR learning has a non-string `title`, the MR title is used for its summary and queued filename. Only string entries in a `tags` array are displayed. The draft content is not rewritten to repair metadata.

`--incremental` re-extracts only the files changed since the last import; each codebase keeps that baseline in its own `evidence/code/<slug>/`. A remote repo's slug is `<provider>__<owner>__<repo>`, shared by `--from-repo`, `--from-mr` and `teamai ci extract-mr`. `--dir` uses it too when the checkout's `origin` names the repo; otherwise it uses the repo or directory name, and refuses to replace evidence there that another remote repo, another directory of the same repo, or another checkout without an `origin` published. A checkout without an `origin` whose name another such checkout already holds gets `<name>-<hash8>`; the import prints the slug it used as `project:`.

`--max-files` raises the cap on source files collected per repository (default 200). Files are collected key-file first; a source with more files is truncated, and the run warns with both counts instead of dropping the rest silently.

After an import, check and enrich that same `teamwiki/` with `teamai codebase`:

```bash
teamai codebase --status
teamai codebase --deep-enrich --project <slug>
teamai codebase --lint
```

Without a team repo, add `--output <dir>` to both `teamai import` and `teamai codebase`; both then use `<dir>/teamwiki/`.

`--deep-enrich` runs the default workflow [`teamai-codebase-deep-enrich`](workflow.md#default-workflows). Your AI tool writes a design doc for each component, five at a time, then the architecture overview and the scenario diagrams. The graph docs need no AI. A doc the tool could not write is named, the others are kept, and the command exits 1. Run it again, or retry the step it names, to write only what is missing. When `TEAMAI_AI_TOOL` or `ai.tool` names a tool that cannot run, it fails and writes nothing. With `--output` and no `teamai init`, the run uses a config of its own that it removes when it ends, so it names no step to retry: run the command again.

```text
$ teamai codebase --deep-enrich --project orders-api
ℹ deep-enrich[orders-api]: Phase 1 — Generating 3 component design docs
⚠ deep-enrich[orders-api]: Skipping component billing: AI call failed (tool: claude): Authentication failed
...
✔ Pushed to team knowledge repo (https://git.example.com/acme/team-ai.git)
Deep enrichment incomplete: project=orders-api, missing component docs: billing
✖ Step "components[1].ask" failed with tool_failed: AI call failed (tool: claude): Authentication failed
ℹ Retry it with teamai workflow retry r3f2a9c41d07b6e15 'components[1].ask', then continue the run with teamai workflow resume r3f2a9c41d07b6e15
```

In a team repo, `--reconcile` commits and pushes the graph it updates. It leaves your `teamwiki/product/` pages as they are, and pushes nothing when the graph did not change:

```text
$ teamai codebase --reconcile
Reconciliation complete: mappings=3, gaps=1, conflicts=0
✔ Pushed to team knowledge repo (https://git.example.com/acme/team-ai.git)
```

`--dry-run` writes nothing and additionally prints relation candidates: team rules and docs matched against the code pages by the key terms they share, proposed as `related:` declarations for you to copy into the asset's frontmatter and land in an ordinary PR (`review --branch` checks it). A candidate shows in recall only once it has been merged into the asset:

```text
$ teamai codebase --reconcile --dry-run
Reconciliation complete: mappings=0, gaps=1, conflicts=0

Relation candidates (copy the ones you accept into the asset's related:)
  docs/payments-overview.md  MAPS_TO  teamwiki/evidence/code/pay/modules/ledger-receipts.md   term "LedgerReceipts", confidence 0.9
```

A rule's `paths:` globs also derive relations without anyone writing them: when a glob matches the `source:` files of a code page of exactly one codebase, recall shows the same `Related: → MAPS_TO` / `← MAPS_TO` pair as a declared one. A glob matching pages of two codebases is ambiguous (globs are repository-relative) and gives no edge.

`import` also runs this deep enrich with your AI tool. When it cannot finish, the evidence is still published, but `import` exits 1 and prints the command that resumes it. In a team repo that is the same import, which publishes the docs it adds:

```text
$ teamai import --dir ./orders-api
...
⚠ deep-enrich[orders-api]: incomplete — missing component docs: billing, architecture: true
...
✔ Pushed to team knowledge repo (https://git.example.com/acme/team-ai.git)
✔ Local directory orders-api import complete
⚠ Deep enrich incomplete: orders-api. Run `teamai codebase --deep-enrich --project orders-api` to retry.
$ echo $?
1
```

A `--from-repo-list` or `--from-org` batch prints one line for each repo that did not finish:

```text
⚠ Deep enrich incomplete: github__acme__billing. Run `teamai codebase --deep-enrich --project github__acme__billing` to retry.
```

With `--output`, the retry is `teamai codebase --deep-enrich` on that directory:

```text
$ cd /work && teamai import --dir ./orders-api --output ./wiki
...
⚠ Deep enrich incomplete: orders-api. Run `teamai codebase --deep-enrich --project orders-api --output /work/wiki` to retry.
```

A job that needs only the extraction, with no AI tool on the runner, skips the AI step and exits 0:

```bash
teamai import --from-repo https://github.com/acme/orders-api --skip-enrich
```

`teamai codebase --extract` is removed; use `teamai import --dir`.

AI subprocess failures report stderr when available, otherwise stdout, otherwise the exit code or termination signal. An OpenClaw provider failure printed on stdout therefore remains visible during deep enrichment instead of an empty `AI call failed:` message.

A recall hit may add `Source freshness:`: `current` matches the last scan, `stale` changed, `missing` is gone, `unknown` could not be checked. `current` does not mean the written knowledge is correct.

Limit one codebase to some members:

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]
```

`svc-a` is the slug used at extract time. It does not have to match the project id.

## CI integration

Extract knowledge from a merge request. Comment when it opens. After it merges, write the suggestions that were not rejected into the team repo.

```bash
teamai ci extract-mr --url "$MR_URL" --mode comment --individual-comments
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ../team-repo --individual-comments
```

Write mode runs in the merged source checkout. Its code knowledge goes through the same path as `teamai import --dir . --incremental`, into `<team-repo>/teamwiki/evidence/code/<provider>__<owner>__<repo>/`, re-extracting only the changed files. Clone the team repo outside the checkout: otherwise its files would be extracted as source, so this step is skipped.

The command starts the default workflow `teamai-ci-extract-mr`: `teamai-import-from-mr` drafts the learning, then its steps comment, write and push it. A CI job needs no `teamai init`; the run lives in a temporary scope, which takes a `--team-repo` that has a `teamai.yaml` as its team repo, so that repo's `language` and `workflows/` apply. Check out the merge commit with its parent (`fetch-depth: 2`), so git can tell which files changed. GitHub calls go to `GITHUB_API_URL` when it is set. `--write-mode pending-review` has no effect and says so.

Mark a suggestion to drop it: 👎 on GitHub and GitLab, ☝️ on TGit. Templates — GitHub Actions, GitLab CI and 智研/Coding CI — are in [`examples/ci/`](../../examples/ci/README.md).

On GitLab, comment updates search the most recently updated notes first and stop at the first matching marker. This keeps the original pipeline's comment discoverable as it is edited in place. If the marker is still missing after 20 pages and more pages remain, the command fails instead of risking a duplicate.

## Knowledge Base Health Report

```bash
teamai dashboard
```

Open the Knowledge Base page, or go to `http://localhost:3721/kb-report`.
