---
type: Architecture Design
title: Repository task documents and Git asset delivery
status: draft
sources:
  - resource: https://claude.com/resources/articles/the-ai-native-sdlc-playbook
    title: The AI-native SDLC playbook
  - resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md
    title: Open Knowledge Format
---

# Repository task documents and Git asset delivery

> Status: Implemented. Local CLI validation is complete; live human/Agent and Octo integration acceptance remain unverified.

TeamAI manages team AI assets and task documents in Git. Octo owns project-wide
product, architecture and deployment authority. Loop owns task identity and
collaboration. The executing Agent reads Octo through the installed CLI and an
explicit profile. This change contains no Octo API implementation or credential
storage. Skills, Rules and MCP delivery from Octo is a future source capability;
current distribution uses Git and retains the existing target-tool adapters.

## Removed responsibilities

Remove the Workflow engine, packaged workflows, leases, run execution, model
catalogs/aliases/gateway switching, Dashboard HTTP server/UI, Scorers, session
judging and historical rating readers/publishers. Remove the existing ClawPro
HTTP source, reporting, command synchronization, plugins dispatched by that
service, resource delivery and project binding. Removed commands must not run.
Old config files must not revive these functions. Old workflow runs cannot resume.

Keep native Agent model fields, tool selection for knowledge generation, model
names used in token/cost accounting, Git hosting providers, normal packages,
usage statistics, session archives, recall and reusable knowledge. Those are
independent of the removed model catalog and rating engine. Historical documents
and user transcripts are not silently deleted. Read-only legacy credential
location evidence remains solely to keep exclusions safe during uninstall;
it cannot contact a service or deliver assets.

## SDLC task artifacts

Use `intent/<workspace-id>/<task-id>/` in the business repository, including linked
worktrees and self mode. The immutable IDs bind a logical set across retries and
Agent changes. Each participating repository has its own set for a cross-repo task.
The files are `intent.md`, `spec.md`, and `plan.md`, generated only as needed.
Anthropic names these files; TeamAI chooses the directory and default types
`Intent`, `Specification`, and `Implementation Plan`. No additional task registry,
verification/delivery document or approval Markdown is required.

The Agent reads existing files before revising, links the Loop task and authority
sources, records the actual source version or reading time, and commits stages.
Team docs mirroring and member tool directories do not own this set. Only the
current task is injected; reusable learning takes the existing contribution route.
Source changes are shown for the responsible person's decision, never silently
substituted. Inaccessible necessary sources stop dependent work.

## Shared OKF implementation

`src/documents/okf.ts` reads YAML frontmatter and body, diagnoses invalid format,
preserves unknown fields and producer-defined types, and serializes metadata.
An ordinary concept requires a nonempty type. Reserved index/log files use their
own rules. Sources are objects with a resource reference; ordinary Markdown links
remain navigable. A stable lifecycle, freshness, correctness, verification event,
human confirmation and check outcome are distinct concepts.

Known legacy source strings become source objects; older usable/stale states are
preserved as legacy metadata and adapted without inventing verification. Confidence,
votes and accepted status do not establish `verified`. Body-only edits preserve
raw frontmatter; metadata changes preserve unknown values. Malformed or ambiguous
content stays available for diagnosis rather than being silently repaired.

Knowledge generation, contribution/import, wiki enrichment, review and promotion
normalize managed Markdown through the shared implementation. Search and code
recall read its metadata adapter; the search index version changes and may rebuild.
Skills and Rules keep their native schemas; promotion uses their target adapters.
Existing shared docs copying and user-edit protection remain intact.

## Independent confirmation

The bundled SDLC skill has templates and two scripts, using the same built
`documents.js` as internal code. `check.mjs` validates location, OKF, committed
content and Git references, or previews a classified knowledge migration. It
returns JSON and nonzero on failure, writes no document and judges no requirement.

`review.mjs` requests and reads reviews, accepts a human terminal response, and
checks approved prerequisites. No new top-level command is added. Product owners
confirm intent/spec; engineering owners confirm plan. The CLI records the current
TeamAI member identity, timestamp, decision, and each file's relative path,
commit and blob. It requires an interactive terminal outside recognized Agent
sessions. This is local attribution, not SSO or protection against a user who
can modify their own Git directory or process environment.

Requests and answers are immutable JSON files in
`<git-common-dir>/teamai/document-reviews/<workspace>/<task>/`, serialized under
one lock. A request captures cumulative documents and upstream request IDs.
Identical pending/approved content retries reuse a request. A later request
invalidates older responses; a rejected/cancelled request stays in history.
Confirmation rechecks the file versions under the lock. Every dependent handoff
checks them again. Intent changes invalidate spec and plan; spec changes invalidate
plan; plan changes invalidate implementation's handoff. Code-only commits retain
confirmations for unchanged blobs. Upstream reconfirmation requires downstream
reconfirmation even when the downstream Markdown bytes are unchanged.

Worktrees share records. `--history` supplies evidence for PRs and handoff. A new
clone requires fresh confirmations; the CLI does not import Workflow snapshots or transfer approvals between clones. This replaces Workflow snapshot handoff, which is removed.
No old approval identity or version is manufactured.

## Execution and delivery

The Agent owns stage progression, native worktree creation, code implementation,
repository checks and PR creation. TeamAI offers no scheduler, model router,
release executor or operations daemon. The skill checks approvals before dependent
work and PR delivery. Failed/unexecuted checks stay failures. The PR names source
references, file versions, confirmation summary and checks actually performed.
A PR retry checks whether creation already succeeded before repeating it.

A requested stopping point may be intent, spec, plan or PR. The result states that
point precisely. It implies neither merge nor deployment, authority publication
nor automatic Loop completion. Loop writes need task-time authorization; absent
permission produces pending references. Octo authority migration is a separate
reviewed task. Existing read-only Octo evidence proves no write capability.

## MCP and existing credentials

Project MCP files receiving resolved variables are written only after Git confirms
exclusion, normally in clone-local `.git/info/exclude`. Already tracked files,
negative ignore patterns and unreadable/unwritable exclusions prevent writes.
Links are checked at their actual targets. Tool-local placements outside the
worktree do not need project exclusions. Never embed plaintext credentials in
team-owned MCP definitions: use variable/secret references. Protection is not a
blanket claim that all manually authored MCP text is safe.

Removing HTTP/model delivery does not remove exclusions protecting existing
credentials. The compatibility reader can locate old files but cannot write model
settings, fetch remote instructions or start HTTP synchronization.

## Shared-state readers and writers

| State | Writers | Readers | Ownership |
| --- | --- | --- | --- |
| Task Markdown | Executing Agent, human editors | Checker, review guard, current task Agent | Business repository Git history |
| Review request/answer files | Review helper under per-task lock | Review helper, audit history | Git common directory; immutable request IDs |
| Knowledge Markdown | Contribution/import/generation/promotion and editors | Shared OKF adapter, search, recall | Existing team Git stores |
| Search index | Index builder | Knowledge search | Rebuildable cache, never authority |
| Tool assets and ownership manifests | Existing Git pull/push and target adapters | Sync, doctor, uninstall | Preserve member edits |
| MCP configs/exclusion records | MCP reconcile and Git exclude helpers | Doctor, sync, uninstall | Verify ignore before resolved-value writes |
| Legacy credential records | Earlier CLI versions only | Legacy exclusion protection | Read-only; no distribution capability |
| Usage events and report baselines | Hook capture, usage/outcome reporting | Digest, usage reports, session completion | Existing telemetry only; no rating readers or writers |
| Captured sessions and publication receipts | Capture hooks, session commands, automatic publication | Archive commands, completion check, publication deduplication | Existing scrubbed session archive; no Workflow step or score publication |
| Team/member configuration | Init, source and settings commands, editors | Config loader, Git sync, native adapters | Removed fields cannot start removed features |

## Acceptance

Cover valid/invalid OKF, reserved files, unknown metadata, source conversion and
no fabricated verification; separate team/business roots and worktrees; dirty
files, changed versions, old requests, rejection/cancellation, downstream invalidation
and audit history; removed command rejection and inert old settings; native asset
contracts and knowledge recall; Git-source MCP exclusion and failure behavior.

Build, type check, lint and relevant tests must pass. Run one representative built
CLI task-document flow plus real CLI MCP protection checks. Unit-test fixture
answers do not count as a live person's approval. Unexecuted live Agent, Octo writes,
provider matrix and remote delivery acceptance must be identified explicitly.
