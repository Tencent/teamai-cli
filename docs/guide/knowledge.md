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

`--namespace` must be a learnings namespace this scope declares in `manifest/projects.yaml`.

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

Opening a document that recall returned counts as one upvote for this session. You can also record it by hand:

```bash
teamai recall feedback --positive <docId>
teamai recall feedback --negative <docId>
```

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

`language` in `teamai.yaml` is `en` or `zh`. `en` makes the built-in recall rule, the TodoWrite hint, and the merged-MR hint English only. Omit it, or set `zh`, and those texts stay bilingual. The next `teamai pull` rewrites the recall rule.

### Knowledge Base Maintenance

```bash
teamai recall maintenance --prune --dry-run
teamai recall maintenance --prune --archive
teamai recall maintenance --update-quality
```

`--archive` puts aside learnings whose confidence is below 0.15. `--update-quality` writes a `.draft.md`. Rename it to `.md` when the draft is right.

### Promoting Learnings

A learning can become a skill, rule, or doc when its confidence is at least 0.90, it has at least 5 upvotes, at least 2 contributors, and it has existed for at least 14 days.

```bash
teamai recall promote
teamai recall promote <learningId> --category skills
teamai recall promote <learningId> --dry-run
```

## Codebase Knowledge Graph

`teamai import` writes a source repo into the team repo's `teamwiki/`. `teamai recall` searches it too.

```bash
teamai import --dir /path/to/project
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg
teamai import --from-repo-list repos.yaml
teamai import --from-mr https://github.com/org/repo/pull/123
teamai import --from-repo https://github.com/org/repo --incremental
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

After the first import, refresh and check with `teamai codebase`:

```bash
teamai codebase --extract /path/to/repo --project my-service
teamai codebase --extract /path/to/repo --project my-service --incremental
teamai codebase --deep-enrich --project my-service --output /path/to/repo
teamai codebase --lint --output /path/to/repo
```

`--output` is the repository root. `--project` becomes `teamwiki/evidence/code/<slug>/`.

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
teamai ci extract-mr --url "$MR_URL" --mode write --team-repo ./team-repo --individual-comments
```

Mark a suggestion to drop it: 👎 on GitHub, ☝️ on TGit. Templates are in [`examples/ci/`](../../examples/ci/README.md).

## Knowledge Base Health Report

```bash
teamai dashboard
```

Open Team Context, or go to `http://localhost:3721/kb-report`.
