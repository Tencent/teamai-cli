# Team Context

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

Team Context is learnings, the codebase graph, and teamwiki. `teamai recall` searches all of them.

## Knowledge Capture & Retrieval

### Contributing knowledge

When you correct the AI, deny a tool call, or the AI retries a failing command, the session ends with a prompt to share it:

```text
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice.

Consider running `/teamai share what this session taught me` to summarize what you learned and share it with your team (or run `teamai skill get share`).
```

Or hand in a note yourself:

```bash
teamai contribute --file /tmp/session.md
teamai contribute --file /tmp/session.md --namespace payments
```

`--namespace` must be a learnings namespace this scope's projects declare in `manifest/projects.yaml`, or its roles in `manifest/roles.yaml`. `--namespace ""` writes to the shared root `learnings/`.

To stop the prompt, set this in `teamai.yaml`:

```yaml
sharing:
  contributeHint:
    enabled: false
```

On one machine, set `contributeHintEnabled: false` in `~/.teamai/config.yaml`, or `TEAMAI_CONTRIBUTE_HINT_DISABLED=1`.

### Searching knowledge

```bash
teamai recall "API timeout"
teamai recall --check "API timeout"
```

`--check` answers only `RELEVANT` or `NOT_RELEVANT`. A codebase hit may add a `Source freshness:` line. The statuses are in [Codebase Knowledge Graph](#codebase-knowledge-graph) below.

### Recall adoption and upvotes

With `TEAMAI_UPVOTE_JUDGE=1`, the optional judge can also credit guidance used through a summary. Claude-family tools use their transcript; Codex, Muse and ZCode use the Stop payload's final reply and this session's settled recall log. Only eligible recalled docs can receive a vote, once per session.

Opening a document that recall returned counts as one upvote for this session. You can also record it by hand:

```bash
teamai recall feedback --positive <docId>
teamai recall feedback --negative <docId>
```

Local feedback affects ranking on the next index rebuild (for example, `teamai pull`), even when report uploads are disabled or fail. Rebuilds combine confirmed team votes with undelivered local votes. If the votes file is busy, that rebuild uses confirmed votes only.

Index rebuilds reuse unchanged files' parsed tokens. Changes, deletions, source selection and votes still take effect on every build. `~/.teamai/debug.log` reports how many files were reused, rebuilt or dropped. Older indexes and a different Node/ICU version trigger a full parse once.

When the log has runs, `teamai stats` lists the last 10 sessions that ran recall.

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

One machine overrides this with `recallEnabled` in `~/.teamai/config.yaml`. `TEAMAI_RECALL_DISABLED=1` forces it off. While it is off, pull does not install recall. `teamai recall` still searches.

Turning recall off does not silence the SessionStart hint for recently merged MRs. That hint points to `teamai import --from-mr`, which can capture and publish a learning before the team enables recall. It has its own switch, so a team can turn it off without touching `contributeHint`:

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

`--archive` puts aside learnings whose confidence is below 0.15. `--update-quality` writes a `.draft.md`. Rename it to `.md` when the draft is right.

Confidence is an activity score from 0 to 1, not a probability that the knowledge is correct or a task succeeded. Its upvote-to-recall ratio is capped at 1, so repeated positive feedback cannot exceed that factor's 30% weight. Recency uses the later of the last recall and the last upvote, so a fresh upvote also refreshes recency.

### Promoting Learnings

A learning can become a skill, rule, or doc when its confidence is at least 0.90, it has at least 5 upvotes, at least 2 contributors, and it has existed for at least 14 days.

Promoted skills use `skills/<learningId>/SKILL.md`, with missing `name` and `description` frontmatter filled in so tools can discover them. Rules and docs remain Markdown files in their respective directories.

```bash
teamai recall promote
teamai recall promote <learningId> --category skills
teamai recall promote <learningId> --dry-run
```

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

`--from-repo-list` runs up to 3 imports at once by default. `--concurrency <n>` sets this limit and must be a positive safe integer. Invalid values fail before the repo list is read or output is prepared.

`--from-mr` takes several MR URLs. Each draft is still confirmed on its own (or none with `--all`), the accepted learnings are published once at the end, and each repository's teamwiki is updated once. An MR that fails does not stop the rest; the run ends with a summary and exits non-zero if any failed.

When GitHub import falls back from `gh` to REST, it reads commit pages of 100, up to the [GitHub endpoint's 250-commit limit](https://docs.github.com/en/rest/pulls/pulls#list-commits-on-a-pull-request). A failed commit page fails that PR before AI extraction.

GitLab MR import reads commit pages of 50 instead of using only the first page, up to 100 pages. Each GitLab MR API request has a 30-second deadline, including reading its response body. A metadata timeout fails that MR; a commits, diff or review-threads timeout leaves out that optional data and continues. Each commit or review-thread page gets its own deadline. A later commit-page failure leaves out the whole commit list rather than passing an incomplete history to extraction.

For GitLab `--from-org`, and for GitHub `--from-org` on both the `gh` path and the REST fallback, each page of the group or organization project list has a 30-second deadline, including reading its response body. A timeout on any page fails the import before writing the whitelist or importing repositories, and neither path falls back to `/users/<org>/repos` after a page has timed out.

The extraction reads the MR's review threads along with its description, commits and diff: GitLab discussions, GitHub review comments, reviews and conversation comments, TGit notes. Each thread goes into the prompt with the file and line it is anchored to, whether it is resolved, and its notes marked as the MR author's or a reviewer's; a decision in a resolved thread outweighs the diff. teamai's own CI comments are skipped. `--no-discussions` leaves the threads out, for `teamai ci extract-mr` too. With `language: en` in `teamai.yaml` the learning is written in English; otherwise in Chinese.

If an AI-generated MR learning has a non-string `title`, the MR title is used for its summary and queued filename. Only string entries in a `tags` array are displayed. The draft content is not rewritten to repair metadata.

`--incremental` re-extracts only the files changed since the last import; each codebase keeps that baseline in its own `evidence/code/<slug>/`. A remote repo's slug is `<provider>__<owner>__<repo>`, shared by `--from-repo`, `--from-mr` and `teamai ci extract-mr`; `--dir` uses the repo name.

`--max-files` raises the cap on source files collected per repository (default 200). Files are collected key-file first; a source with more files is truncated, and the run warns with both counts instead of dropping the rest silently.

After an import, check and enrich that same `teamwiki/` with `teamai codebase`:

```bash
teamai codebase --status
teamai codebase --deep-enrich --project <slug>
teamai codebase --lint
```

Without a team repo, add `--output <dir>` to both `teamai import` and `teamai codebase`; both then use `<dir>/teamwiki/`.

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

Mark a suggestion to drop it: 👎 on GitHub and GitLab, ☝️ on TGit. Templates — GitHub Actions, GitLab CI and 智研/Coding CI — are in [`examples/ci/`](../../examples/ci/README.md).

On GitLab, comment updates search the most recently updated notes first and stop at the first matching marker. This keeps the original pipeline's comment discoverable as it is edited in place. If the marker is still missing after 20 pages and more pages remain, the command fails instead of risking a duplicate.

## Knowledge Base Health Report

```bash
teamai dashboard
```

Open Team Context, or go to `http://localhost:3721/kb-report`.
