---
name: sdlc
description: >-
  Develop an Octo Loop task using repository intent, spec and plan documents,
  independent human confirmation, code, checks and a PR. Also inspect and preview
  the OKF format of retained team knowledge.
---

# Task SDLC

Start in the business repository's Git worktree. Team assets may live in another
repository. Use the executing Agent's native tools for edits, Git, tests and PRs.
TeamAI provides templates, deterministic checks and independent human review;
it does not schedule Agents or execute development stages.

Collect immutable Loop workspace and task IDs, the task URL, an explicitly
selected Octo CLI profile, relevant authoritative document URLs (possibly none),
and the requested stopping point: intent, spec, plan or PR (default). Ask only for
missing inputs. Read the installed Octo skills and help before calling
`octo-cli loop`, `docs` or `drive`. Never infer Drive spaces from Loop workspace IDs.
TeamAI does not store Octo credentials or implement an Octo API client.

## Task documents

Locate this skill with `teamai skill path sdlc`. Its templates are starting points,
not mandatory additional SDLC sections. The filenames follow the
[Anthropic SDLC playbook](https://claude.com/resources/articles/the-ai-native-sdlc-playbook);
the directory layout and type names are TeamAI conventions.

Use `intent/<workspace-id>/<task-id>/` in the business worktree. Read existing
files first and revise incrementally. Keep this set across retries and Agent
changes. Cross-repository work uses the same Loop IDs in every repository.
Generate only the stages needed: `intent.md`, `spec.md`, `plan.md`. Do not seed
empty later files or add task, verification, delivery or approval Markdown files.
Task material never enters the shared docs mirror or general knowledge recall.

The types are `Intent`, `Specification`, `Implementation Plan`. Write OKF
frontmatter and normal Markdown links to the task, earlier stages and sources.
Use `sources` objects, recording the version actually read when available, or
its reading time otherwise. Never invent a source snapshot. Global product,
architecture and deployment documents remain authoritative in Octo.

Re-read relevant sources before handoff. If they changed, show the difference and
wait for the responsible person to decide whether to revise task material.
An inaccessible necessary source or ambiguous profile stops dependent work.

## Check and confirm each stage

Commit the stage, then use the packaged helpers from the business Git root.
Replace the paths and IDs below with actual values; `--stage` accepts intent,
spec or plan. JSON output has `ok`; failures exit nonzero.

```sh
node /path/to/sdlc/scripts/check.mjs --workspace <id> --task <id> --stage intent
node /path/to/sdlc/scripts/review.mjs --workspace <id> --task <id> --stage intent --request
```

The checks enforce OKF, nonempty body, safe paths and committed file versions.
They do not evaluate requirement quality. Show the returned request ID and file
versions to the product owner (intent/spec) or engineering owner (plan). The
person answers in their own interactive terminal, outside the Agent session:

```sh
node /path/to/sdlc/scripts/review.mjs --workspace <id> --task <id> --respond <request-id>
```

The helper displays paths, commit SHAs and blob IDs, takes an explicit approve,
reject or cancel, and records the configured TeamAI member identity and time.
Never answer as the Agent, supply a manufactured identity, or clear provenance
variables to bypass the check. Local attribution is not SSO or an authorization
system. A rejection or cancellation stops dependent work.

Before starting the next stage, implementing code, and delivering the PR, check
the relevant approved stage again:

```sh
node /path/to/sdlc/scripts/review.mjs --workspace <id> --task <id> --stage intent --approved
```

Intent changes invalidate spec and plan; spec changes invalidate plan. Request
and obtain fresh confirmations in order. Plan changes require plan confirmation.
Code-only commits do not invalidate unchanged document blobs. Identical retries
reuse the current request. Old answers remain immutable history, never copied
onto a new request. Pending requests cannot be answered after replacement.

Records live in the repository's Git common directory, shared by its worktrees.
Use `--history` to read the audit record for a PR or handoff. A new clone requires
fresh confirmation; copied JSON is evidence, not a new approval. Legacy workflow
runs are not executable and are never converted to approvals.

## Implement, verify and deliver

After plan approval, implement in the Agent's isolated worktree, following the
repository instructions and the approved documents. Run the actual checks the
repository and plan require. Failed or unexecuted checks are not success.
Use existing Git/hosting tools to create the PR. Include task and document links,
confirmed paths/commits/blobs, reviewer decisions and actual check results.
Retry a failed PR creation by checking for an existing PR first; keep the task
set. Stop at the requested stage and accurately report that stopping point.

Link documents and PR back to Loop only with execution-time write authorization.
Read first; if a write's outcome is unknown, inspect it before retrying. Without
permission, return the references as pending and state that no write occurred.
Do not set the task to done automatically, claim merge/deployment, or update
Octo authoritative documents. Releases and operations remain in existing systems.

## Knowledge compatibility

Shared docs, wiki and learnings are derived knowledge, using
[OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md).
Skills and Rules keep their executable native contracts. Votes, confidence,
promotion and old accepted status never establish `verified`.

The check helper accepts `--file <repo-relative-path>` for format diagnostics.
Add `--migrate --type '<owner-selected type>'` for a JSON before/after preview;
it never writes files. Review the difference in an isolated worktree before
applying it. Keep unknown fields and originals when meaning is uncertain.
`index.md` and `log.md` have reserved OKF rules. Authority migration to Octo is a
separate task. Never delete original content or Git history. Reusable task lessons
use the existing contribution process.
