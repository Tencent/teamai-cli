# Codebase Knowledge Graph

> Part of the [TeamAI CLI Usage Guide](../usage-guide.md).

---

`teamai import` parses a source code repo into a structured knowledge graph (stored under the team repo's `teamwiki/` directory), enabling structure-aware knowledge retrieval:

```bash
# Extract from a local directory
teamai import --dir /path/to/project

# Import from a remote repo
teamai import --from-repo https://github.com/org/repo

# Bulk-import all repos under an organization
teamai import --from-org myorg

# Bulk-import from an allowlist
teamai import --from-repo-list repos.yaml

# Extract learnings from a merged MR/PR
teamai import --from-mr https://github.com/org/repo/pull/123

# Incremental mode (skip unchanged files)
teamai import --from-repo https://github.com/org/repo --incremental

# Extract structure only, skip AI enrichment
teamai import --from-repo https://github.com/org/repo --skip-enrich
```

If core graph extraction or writing fails, the import reports an error without marking the commit as synced. The next incremental run retries that commit.

For `--from-iwiki`, an MCP tool response with `isError: true` is a failed request, even when it contains text. A page whose document or metadata request fails is warned about and skipped before AI classification; successful pages still import. A failed page-tree request warns and yields no child pages.

With `--dry-run`, `--from-repo` and `--from-repo-list` read each repo's target commit with `git ls-remote`, print `Would import <owner>/<repo> at <commit>` and whether the local cache is current, and stop there: nothing is cloned or fetched into the cache, the import lock is not taken, and no AI step runs. With `--incremental` and a cache containing `LAST_SYNC`, the preview queries that cache's current branch at its configured origin, matching the real fetch/reset. Full-clone previews, including a missing cache or `LAST_SYNC`, follow remote HEAD. If the cached branch was deleted remotely, a non-pruning wildcard fetch retains its cached origin ref; incremental preview uses that retained commit too. 

Pruning, an explicit deleted-branch fetch refspec, or a missing cached origin ref still selects the full-clone fallback. Other cached-branch query failures warn and preview the full-clone fallback. With `--output`, the preview reports the same `teamwiki/evidence/code/<slug>` destination beside the output file as a real import.

`--from-mr` publishes its learning the way `teamai contribute` does by default, on the `teamai-learnings` branch: under `learnings/<namespace>/` when the active projects resolve to exactly one learnings namespace, otherwise at the shared `learnings/` root. If that fails, the learning stays queued on this machine and the next `teamai pull` publishes it; when a learnings checkout teamai refuses stopped it, no pull can until you deal with that checkout as the message says.

When the draft overlaps existing learnings, from the shared root or your active projects' namespaces, the command names them (`Possible duplicate: this learning overlaps N existing learning(s): <files>.`), with `--all` too. It is a notice only: nothing is marked or replaced. When `manifest/projects.yaml` cannot be read, the check compares the shared root only and says so.

AI-backed steps (`--deep-enrich`, knowledge enrichment) shell out to an AI coding CLI already installed on the machine instead of calling a model API directly. teamai probes `claude` → `claude-internal` → `codex` → `codex-internal` → `codebuddy` → `workbuddy` → `openclaw` and uses the first one it finds. On macOS and Linux the probe runs through a login shell, so a CLI installed under `~/.nvm/` is found too. On Windows it uses the native `where`, which returns the npm shim (`%APPDATA%\npm\claude.cmd`) that Windows can actually launch — a Git Bash or WSL `bash` only reports MSYS paths such as `/c/Users/...`, which Windows cannot start.

With `--from-org --dry-run`, the CLI lists the repositories selected by this request's filters and previews the whitelist destination. It does not read an older draft, write the whitelist, clone repositories, acquire import locks or run AI enrichment. `--skip-import` previews only the whitelist entries. Normal CLI diagnostic logging still applies.

For GitHub, `--from-org` tries the organization repo list first, then the user repo list if the first request fails or returns no repos. If the fallback request fails too, the import reports the error and exits nonzero rather than treating it as an empty list. This applies to both `gh` and the direct `GITHUB_TOKEN` / `GH_TOKEN` API path; a successful empty response still means there are no repos to import.

For GitLab behind an API gateway, set `GITLAB_URL` and `GITLAB_API_PREFIX=api/gitlab` before running `teamai import --from-org https://gitlab.example.com/myorg`. Organization listing uses the configured prefix on every page; an unset or blank prefix defaults to `api/v4`.

The graph stores components, interfaces, configs, and cross-repo dependencies. `teamai recall` combines learnings with graph BM25 hits on a bounded, relevance-normalized score scale.

Dependency edges are extracted by two parallel tracks: a WASM tree-sitter **AST track** (TypeScript/JavaScript, Python, Go, Swift) that resolves imports, calls, and TS `implements` clauses to precise file-to-file edges (`code-ast`), and a regex **heuristic track** (all languages, `code-heuristic`) that also covers languages the AST track does not. AST results win on overlap. The AST parser needs no native toolchain; on load failure, extraction falls back to heuristics and records an `AST_UNAVAILABLE` gap. Set `TEAMAI_SKIP_AST=1` to force heuristic-only extraction.

```bash
# Extract code facts and the graph from a local repo (writes <repo>/teamwiki/)
teamai codebase --extract /path/to/repo --project my-service

# Incremental refresh: reuse the original repository path and project slug
teamai codebase --extract /path/to/repo --project my-service --incremental

# Generate deep knowledge docs from extracted evidence (--output is the repository root)
teamai codebase --deep-enrich --project my-service --output /path/to/repo

# Reconcile teamwiki/product and teamwiki/docs with extracted code pages
teamai codebase --reconcile --output /path/to/repo

# Check the local graph; --output is the repository root, not teamwiki/
teamai codebase --lint --output /path/to/repo
```

Changes queued in `.teamai/pending-review.jsonl` can be inspected with `teamai review`. Preview a decision with `teamai review <id> --apply --dry-run`, `teamai review <id> --reject --dry-run`, or `teamai review --all-apply --max-risk medium --dry-run`. Apply previews validate the target and managed section just like a real apply, but leave both documents and pending items unchanged. Batch previews retain the same kind/risk filtering. Decision previews with `--json` include `dryRun: true`; `ok` means the operation passed validation, not that it was written. Remove `--dry-run` to perform the decision.

When extract finds components, it writes `teamwiki/evidence/code/<project>/_manifest.json` even if AI enrichment is skipped or produces nothing, so `--deep-enrich` can start.

Without `--project`, `<project>` is the directory's name. At the root of a checkout, the main one or a linked git worktree, it is the repo's name: the main checkout's real name (also when opened through a symlink), or a bare repo's (`repo/.bare` or `repo.git` → `repo`). Every checkout of a repo writes the same entry. `teamai import --dir` picks its slug the same way.

**Wiki by namespace.** `recall` scopes `teamwiki/evidence/code/<slug>/` the same way it scopes docs: once any role (in `manifest/roles.yaml`) or project (in `manifest/projects.yaml`) lists a codebase slug under `resources.wiki`, it reaches only the members who have it active, and an undeclared slug stays shared:

```yaml
# manifest/projects.yaml
projects:
  - id: svc-a
    resources:
      wiki: [svc-a]     # evidence/code/svc-a/ only where svc-a is active
```

The slug is whichever one `teamai codebase --project <slug>` (or `teamai import`) wrote under `evidence/code/`; it has no required relationship to the manifest's project id, so declare the one the extraction actually used. Legacy mode (no role and no `projects.yaml`) searches every codebase, as before.
