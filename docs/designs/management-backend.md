# Management backend design

[简体中文](management-backend.zh-CN.md)

Status: proposed design for [#341](https://github.com/Tencent/teamai-cli/issues/341).
This document describes future behavior. It adds no Go service, Web console, CLI
option, or change to the current Git or ClawPro HTTP implementation. The issue's
first deliverable is this design and its Chinese counterpart; implementation
requires the decisions and acceptance gates below.

## 1. Scope and current implementation

The reference is main commit `3f7fa1dedbccac1416fe329bdd308bb45de30b0e`.
The backend must cover both published resources and member-generated data, with
no Git installation, credentials, repository URL, or contribution workflow exposed
to ordinary users.

[ResourceHandler](../../src/resources/base.ts) defines scan, copy, diff and remove
operations for seven [registered handlers](../../src/resources/index.ts).
[Pull](../../src/pull.ts) also resolves namespaces, compiles culture/instructions,
reconciles hooks/MCP, maintains recall indexes and reports activity.
[Push](../../src/push.ts) prepares isolated changes and review requests;
[remove](../../src/remove.ts) currently exposes skills, rules, agents and MCP.
The backend's wider resource model must not falsely imply every current CLI
handler already supports every write operation.

The current [local agent](../../src/local-agent.ts) uses
`/api/projects/mine`, `/api/local-agent/report`, `/api/local-agent/sync`,
`/api/local-agent/commands/ack` and `/api/local-agent/get-config`. It delivers
commands/resources and manages workspace bindings, rather than materializing a
complete versioned team repository. These routes remain a separate compatibility
adapter; they are not aliases for the new API. The provider abstraction proposed
in [#469](https://github.com/Tencent/teamai-cli/pull/469) can host a future management
adapter if accepted; this design does not assume that PR has landed.

The [data-directory design](data-directory-layout.md) distinguishes a local
workspace partition from a logical project. The [multi-project design](multi-project-management.md)
uses project and role selectors to choose resource namespaces. Neither local
selection nor a namespace name is an authorization grant.

## 2. Capability mapping

Every imported item records its original path and source revision for audit.
The published-resource plane contains reviewed, immutable content; the reporting
plane accepts identity-bound events with separate retention and write permissions.

| Current data | Current path / behavior | Proposed backend mapping |
| --- | --- | --- |
| `teamai.yaml` | Configuration, sharing policy, tool paths and reviewers (`src/config.ts`, `src/types.ts`) | Versioned policy/configuration records; reviewed changes generate a compatibility view |
| `skills/` | SkillsHandler, namespaces and marketplace metadata | Resource bundles with immutable files, dependencies and generated marketplace views |
| `rules/` | RulesHandler and enforced-rule selection | Versioned rules with separately enforced policy constraints |
| `docs/` | DocsHandler and indexed documentation | Versioned documents, authorized materialization and recall indexing |
| `env/env.yaml` | EnvHandler, local overrides and environment injection | Non-secret templates plus secret references; secret resolution has separate authorization |
| `agents/` | AgentsHandler and tool-format conversion | Versioned agent definitions rendered through the existing tool adapters |
| `hooks/hooks.yaml` | HooksHandler plus hook reconciliation; no general per-item push | Reviewed declarative hooks, client consent and typed validation |
| `mcp/mcp.yaml` | McpHandler plus MCP reconciliation; direct YAML editing for contributions | Reviewed server definitions, transport policy and secret references |
| `learnings/` | `src/contribute.ts`, project namespaces and `src/utils/search-index.ts` | Learning drafts, approved content versions, namespace ACLs and local recall indexes |
| `culture.md` | `compileCulture` in `src/pull.ts` | Versioned organization/team context with a derived client view |
| `claudemd/` | `compileClaudemd` and recall/instruction injection in `src/pull.ts` | Versioned instructions, selected only from authorized namespaces |
| `tags.yaml` | Tag discovery and local subscriptions | Versioned taxonomy and user subscriptions, distinct from access control |
| `manifest/roles.yaml` | `src/roles.ts` resource selectors | Compatibility view for role/resource selection; backend RBAC remains separate |
| `manifest/projects.yaml` | `src/projects.ts` logical project namespaces | Stable project IDs mapped to authorized namespaces; preserve role/project union semantics |
| `sources` / `publicSkills` | `src/source.ts` subscriptions, priorities and install manifests | Audited source references pinned to authorized resource versions and ownership records |
| `members/` | Registration and member metadata | User/Membership/Device records; clients cannot grant themselves membership |
| `stats/` | `src/team-push.ts` cumulative usage/session aggregates | Deduplicated UsageEvent revisions and derived aggregates with acknowledged cursors |
| `votes/` | `src/votes.ts` and delta-aware report merge | Identity-bound vote records/events with deterministic retry handling |
| `sessions/` | `src/save-session.ts` summaries and export; local session events | Policy-limited session revisions, consent, redaction and separate retention |
| `<type>/.removed` | ResourceHandler tombstones and local cleanup | Versioned delete operations, tombstones and ownership-safe removal |

The import audit must enumerate unknown files rather than silently dropping them.
Unknown types are retained as opaque, non-executable attachments pending an
administrator's classification. Secrets are never imported as ordinary resources.

| Existing command | Future management adapter |
| --- | --- |
| `teamai init` | Authenticate, enroll device, select authorized projects and bind workspace |
| `teamai pull` | Fetch an authorized snapshot/delta, materialize, reconcile and index |
| `teamai push` | Scan local resources, upload verified blobs and submit a change set for review |
| `teamai contribute` | Submit a learning draft with source/session attribution; preserve offline drafts |
| `teamai remove` | Prepare explicit reviewed deletes; local cleanup follows published tombstones |
| `teamai team-push` | Send authenticated usage/vote/session revisions; advance cursors after durable acknowledgement |
| `teamai recall` | Search only the active binding's authorized local indexes and queue votes |
| `teamai source` | Manage authorized source subscriptions through reviewed configuration and capability checks |

These are future mappings for existing commands, not newly available commands or
flags. Initialization can reuse the existing interactive entry point; exact option
spelling remains a CLI design decision. Administrative import may use Git on the
server side, but member onboarding and normal operation must never require it.

## 3. Domain model and authorization

`Organization -> Team -> Project` is the administrative hierarchy. Each project
has a stable opaque ID independent of its display name, filesystem path or
existing namespace selector. A user can belong to multiple organizations.
`WorkspaceBinding` connects an authenticated user and device to a local workspace
identifier plus one or more authorized project IDs. The CLI keeps the absolute
path locally; the server normally receives an opaque workspace ID and display label.

The core records are `Organization`, `Team`, `Project`, `User`, `Role`,
`Membership`, `Device`, `WorkspaceBinding`, `Resource`, `ResourceVersion`,
`Revision`, `ChangeSet`, `Review`, `Release`, `Learning`, `Vote`,
`UsageEvent`, `Session` and `AuditEvent`. Every tenant-owned row and blob reference
carries organization ID. Foreign keys and repository queries include that ID;
a guessed resource ID never bypasses project authorization.

Authorization is separate from the existing role/resource selector. Proposed
permissions are `project:read`, `resource:write`, `review:decide`,
`release:publish`, `membership:manage`, `telemetry:write`, `audit:read`, `organization:manage`, `project:manage`,
`identity:manage` and `secret:read`.
A contributor cannot approve their own change; publishing requires a separate
publisher permission and valid approvals for the exact content digest. An
organization administrator receives project authority only through explicit policy.
Device and service credentials have narrower project scopes than their owners.

For each authorized project, effective resources resolve from organization to
team to project, then permitted user preferences. A key is
`(resource_type, canonical_name)`, not a filename alone. Higher-level enforced
policy, forbidden transports and secret access cannot be weakened by a user
override. A tombstone at a more specific level masks the inherited key; removing
that tombstone restores the inherited version.

Role and logical-project selectors still select a union of authorized namespaces.
They do not override each other. When two selected projects contribute different
versions of the same key at equal specificity, synchronization reports a conflict
and keeps the previous snapshot. The user must choose an explicit binding-level
source preference approved by policy; iteration order must not decide. Cross-project
reuse pins an authorized source `ResourceVersion`, not a mutable latest reference.
A source permission change invalidates affected bindings and prevents new reads.

## 4. Four end-to-end journeys

**J1: first enterprise login.** An administrator configures a trusted identity
provider and organization/group mapping. A new user chooses enterprise sign-in in
the console or CLI, completes the company login, and is mapped by
`(issuer, subject)` to a stable internal user. Organization membership is provisioned
only from administrator-approved mappings. The interface shows permitted teams
and projects, or a clear access-request state; it never asks for a repository.

**J2: first project for a non-Git user.** An administrator creates a project,
publishes its initial resources, and issues an expiring, single-use enrollment
code restricted to that project. The member installs the CLI and opens its init
flow. A browser authorizes the device, or another device opens the verification
page for a displayed short code. The code does not itself grant a bearer token:
the signed-in user's identity and requested project access must still match.
After confirmation, the CLI saves a device credential in OS-protected storage,
binds the current workspace, verifies the first snapshot, and invokes the existing
resource handlers. The result shows project, revision and sync status, with no Git
concepts. Expired codes can be reissued; denied enrollment does not create a binding.

**J3: multiple projects.** A member joins a second permitted project through the
same flow and chooses its workspace or adds it to an existing binding. Selection
and synchronization state are isolated per binding. Switching workspaces activates
the relevant project set; switching projects within a binding previews resources
to add, replace or remove. Same-name conflicts follow section 3. An unavailable
project cannot silently replace another project's cache with an empty snapshot.
Leaving a project revokes the binding and removes only its unchanged managed
resources, retaining personal modifications as conflicts. Device unlink and
uninstall revoke credentials and clear local credentials, indexes and managed
state without deleting unrelated user files. If offline, local cleanup completes
and remote revocation remains visibly pending until submitted or done in the console.

**J4: administrator publishes across projects.** An administrator prepares a
change set for several projects in the same organization, sees effective-resource
diffs and affected members, and submits it. Reviewers approve the exact versions;
a publisher validates permissions and every expected project head again. One
database transaction creates an immutable release and updates all target heads.
Any stale head, missing approval or failed authorization rejects the whole release.
Clients observe either the previous or the new release manifest, never a mixture.
A rollback publishes a new release referencing selected previous versions, with
the same authorization and review rules. Cross-organization atomic publishing is
outside this design.

Across all journeys, retries preserve operation IDs, permissions are checked
server-side, and a login-service outage never becomes anonymous access. Ordinary
users see actions such as join, submit, review, publish and restore, not branches,
commits, merges or conflict markers.

## 5. State machines and version semantics

`Revision` is an opaque server-issued identifier for an immutable manifest.
Clients compare equality, not ordering or Git SHA semantics. `ResourceVersion`
identifies immutable bytes with a SHA-256 content digest. A `Release` groups
project revisions; changing a project head always creates an audit event.

```text
ChangeSet: DRAFT -> IN_REVIEW -> APPROVED -> PUBLISHED
           IN_REVIEW -> CHANGES_REQUESTED -> DRAFT
           IN_REVIEW -> REJECTED
           DRAFT | IN_REVIEW | APPROVED -> CANCELLED
Project:   ACTIVE -> ARCHIVED -> ACTIVE
           ARCHIVED -> DELETION_PENDING -> DELETED
Device:    PENDING -> ACTIVE -> REVOKED
Enrollment: PENDING -> APPROVED | DENIED | EXPIRED
Binding:   ACTIVE -> SUSPENDED -> ACTIVE
           ACTIVE | SUSPENDED -> REVOKED
Sync:      IDLE -> DOWNLOADED -> APPLYING -> APPLIED
           APPLYING -> PARTIAL -> APPLYING
           DOWNLOADED | APPLYING | PARTIAL -> BLOCKED_AUTHORIZATION
```

Editing after submission creates a new draft digest and invalidates previous
approvals. Failed publication leaves the approved change set unpublished and
returns a recoverable conflict; it does not partially apply resource operations.
A publisher may not reuse approvals after changing content or target heads.
Archived projects remain readable under policy but reject writes and enrollment.
Deletion first revokes bindings and records tombstones; retention/purge is a
separate audited administrative operation.

Snapshots contain the exact resolved project revisions, resource origins, version
IDs, hashes, byte lengths, policy version and tombstones. The manifest itself is
signed by a deployment key trusted during enrollment. Blob hashes verify bytes;
the signature and authorization verify who may supply and receive those bytes.
Rollback and source reuse retain referenced blobs until no retained release,
review, draft or binding needs them.

## 6. Versioned API contract

The proposed resource API starts at `/v1`. It uses HTTPS, JSON, server-generated
request IDs, explicit permission checks and opaque IDs. Authentication endpoints
follow their selected protocol rather than wrapping OAuth errors in a custom
resource error. No endpoint accepts a shell command to execute on a member device.

| Method | Proposed route | Semantics |
| --- | --- | --- |
| GET | `/v1/capabilities` | Discover versions, operations, resource types and limits |
| GET | `/v1/auth/authorize; /v1/auth/callback` | Browser authorization and validated callback |
| POST | `/v1/auth/device/authorizations` | Start device flow; bounded polling and user approval |
| POST | `/v1/auth/token` | Authorization-code/device grant or refresh; rotate refresh credentials |
| POST | `/v1/auth/revocations` | Revoke own credential/device session or authorized administrative target |
| POST | `/v1/enrollments` | Administrator issues a single-use project enrollment intent |
| POST | `/v1/enrollments/{id}/decisions` | Authenticated approval/denial bound to identity and requested scopes |
| GET, POST | `/v1/organizations; /v1/organizations/{id}/teams` | List authorized hierarchy or administer it with explicit organization authority |
| GET, POST | `/v1/teams/{id}/projects` | List or create projects subject to team/organization policy |
| GET, PATCH, DELETE | `/v1/projects/{id}` | Read, archive/restore, or request audited deletion; conditional mutations |
| GET | `/v1/projects/{id}/members` | List authorized project membership |
| PUT, DELETE | `/v1/projects/{id}/members/{user_id}` | Grant/revoke membership with membership management authority |
| GET, PATCH, DELETE | `/v1/devices/{id}` | Inspect own/authorized device, update label or revoke it |
| POST | `/v1/bindings` | Bind the authenticated device to permitted projects |
| GET, PATCH, DELETE | `/v1/bindings/{id}` | Read/change project selection or revoke binding with conditional updates |
| GET | `/v1/bindings/{id}/snapshot` | Return one signed effective manifest and authorized blob references |
| GET | `/v1/bindings/{id}/changes` | Delta since an authorized cursor, including tombstones |
| GET | `/v1/projects/{id}/resources` | Paginated resource/version/origin metadata |
| GET | `/v1/resource-versions/{id}/content` | Authorized immutable content or a narrowly scoped download URL |
| POST | `/v1/blobs` | Stage bounded binary content; verify declared bytes and hash |
| POST | `/v1/change-sets` | Create a draft with pinned project heads and explicit operations |
| PATCH | `/v1/change-sets/{id}` | Edit a draft with If-Match; invalidate obsolete reviews |
| POST | `/v1/change-sets/{id}/submit` | Validate and freeze a digest for review |
| POST | `/v1/change-sets/{id}/reviews` | Record approve/request-changes/reject for an exact digest |
| POST | `/v1/releases` | Publish an approved change set atomically across its projects |
| POST | `/v1/releases/{id}/rollback` | Prepare a reviewed restoring change set; never rewrite old revisions |
| GET | `/v1/projects/{id}/releases` | Paginated immutable history and diffs |
| POST | `/v1/projects/{id}/learnings` | Create a reviewable learning draft, not an unreviewed release |
| POST | `/v1/reports/events` | Deduplicate usage, vote and session revisions from the authenticated device |
| POST | `/v1/secret-resolutions` | Online-only, audited resolution for an authorized device and resource |
| GET | `/v1/operations/{id}` | Query the client-generated operation ID under the same authorization, including after a lost response |
| GET | `/v1/audit/events` | Paginated tenant/project audit under audit:read |

All tenant/resource reads re-check membership, including blob downloads, cursor
continuations, audit queries and operation status. Blob URLs are short-lived,
scoped to the authorized version and organization, and never disclose storage
credentials. The backend verifies staged uploads before allowing references in a
change set. The session-report endpoint does not provide resource-write authority.

A change-set creation request identifies expected project revisions and explicit
operations; deletion is a first-class operation rather than omission:

```json
{
  "client_operation_id": "op_client_001",
  "projects": [{"project_id": "prj_a", "base_revision": "rev_a_24"}],
  "operations": [
    {"op": "put", "project_id": "prj_a", "type": "skills",
     "name": "release-check", "blob_id": "blob_verified_1"},
    {"op": "delete", "project_id": "prj_a", "type": "rules",
     "name": "retired-rule"}
  ]
}
```

**Concurrency.** Mutable records return strong `ETag` values. Updates require
`If-Match`; missing conditions return `428 PRECONDITION_REQUIRED` and stale
conditions return `412 REVISION_MISMATCH`. A change set also pins each target
project's base revision. Publishing validates those revisions inside the same
transaction that changes all heads. Clients fetch the new diff and ask the user
to resolve conflicting resource edits; they never silently overwrite.

**Idempotency.** Resource mutations generate and persist `client_operation_id`
before their first request and use the same value as `Idempotency-Key`. This
does not add a custom header requirement to OAuth protocol endpoints. IDs are
scoped to organization, principal, method, route and target. The server stores
the request digest and durable operation/outcome record in the state-changing
transaction; its proposed 24-hour HTTP response cache is only a retry optimization.
A repeated ID with different content returns `409 IDEMPOTENCY_CONFLICT`.

`GET /v1/operations/{id}` accepts that client-generated ID, so reconciliation
works even when the first response, including every server-generated ID, was lost.
Clients retry the original ID or query it, never inventing a new ID merely because
of a timeout or cache expiry. Terminal operation IDs and outcome references remain
queryable beyond the response-cache lifetime. If outcome retention later expires,
a compact expired-ID marker remains and returns `410 OPERATION_HISTORY_EXPIRED`.
The client keeps the pending intent, checks resource revisions/audit evidence and
requires an explicit reconciled decision before creating a genuinely new operation.
Unknown or expired history is not proof that the earlier write never happened.

**Pagination and bounds.** List endpoints return `items` and `next_cursor`.
A signed cursor binds principal, organization, filters and snapshot revision;
its proposed lifetime is 24 hours. Permission changes are still checked on every
page. Defaults are 50 entries, maximum 200. Provisional limits are 100 operations
per change set, 32 MiB per blob and 1 GiB expanded snapshot size; count, path length,
nesting and compression-ratio bounds are also enforced. Deployment owners must
confirm these limits before P1, and the CLI discovers them rather than hard-coding
different values. Large operations are staged, then atomically published.

**Resource errors.** Responses contain `error.code`, bounded `error.message`,
`request_id` and optional structured conflicting resource IDs. Stable codes
include `AUTH_REQUIRED` (401), `ACCESS_DENIED` (403),
`NOT_FOUND` (404, also for hidden cross-tenant objects),
`CURSOR_EXPIRED`, `OPERATION_HISTORY_EXPIRED` or `EVENT_WINDOW_EXPIRED` (410), `PAYLOAD_TOO_LARGE` (413),
`VALIDATION_FAILED` (422), `RATE_LIMITED` (429) and
`IDENTITY_UNAVAILABLE` (503). Retries honor `Retry-After` with jitter.
Validation errors never echo secrets, filesystem paths or upstream stack traces.

**Compatibility.** Capability discovery reports protocol version, supported
resource types, writable operations, client-version range and limits. Unsupported
major versions stop before mutation. Unknown optional response fields are ignored;
unknown operations or required resource types fail explicitly. A client with an
expired delta cursor downloads a full authorized snapshot rather than guessing
which deletions were missed.

## 7. Identity and enterprise integration

The default adapter uses OIDC for sign-in and authorization-code flow with PKCE
for browser-capable clients. Headless clients use the
[OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628);
they respect pending, slow-down, denied and expired responses. A short code is
one-time, time-limited and rate-limited, and its approval page shows the device,
organization, project and requested scopes.

The Go `IdentityProvider` boundary normalizes provider authentication into
`issuer`, `subject`, verified claims and credential expiry. A separate identity
service resolves these to `UserID` and approved organization memberships.
Domain modules receive only an internal principal and an authorization decision.
A non-standard corporate adapter must validate the corporate signature/session,
audience and lifetime before normalization; it cannot assert arbitrary internal
user IDs or roles. Raw corporate tokens stay inside the adapter.

An administrator configures group-to-role rules with explicit precedence and
deny rules. First login provisions a stable user only after validating the issuer;
email is a display/contact attribute, never the identity key. Group changes and
user disable events update a membership/authentication version, revoke refresh
tokens and invalidate active device sessions. Polling reconciliation catches
missed events and produces an auditable discrepancy report.

Proposed access-token lifetime is five minutes; refresh tokens rotate, are stored
hashed server-side, and reuse revokes their token family. Devices have individual
revocation and last-seen records. Service accounts are separate principals with
project-limited scopes and rotation; they cannot use interactive enrollment codes.
Credentials are stored outside workspace files and never embedded in enrollment
commands, logs or snapshots.

New authentication, enrollment, refresh and writes fail closed if the identity
service cannot validate them. Previously authorized, non-secret cached resources
may be used only until a proposed 15-minute authorization lease expires. Secret
fetches and fresh privileged operations always require online authorization.
Offline revocation cannot erase information already read; documentation and
acceptance tests must acknowledge this limit. Removing local materialized content
on the next successful revocation check is best effort, not a claim of remote erasure.

## 8. CLI synchronization and contribution flow

The management adapter materializes a complete verified snapshot into an immutable
cache directory per binding/revision, with a compatible resource tree. It must
introduce an explicit backend capability/schema extension; it must not pretend to
be `repo.kind: git` or overload the existing ClawPro `repo.kind: http`.

A sync downloads and verifies the complete manifest, blobs, authorized origins
and delete set in staging. Atomically promoting this immutable cache sets
`downloaded_revision`, not `applied_revision`. Local tool configuration files and
recall indexes span multiple handlers and filesystems; they are not one atomic
transaction and may temporarily contain a mixture while application runs.

Before touching a destination, persist an apply journal under the workspace lock:
binding, target revision, operation ID, destination, expected previous hash,
desired hash/delete, and per-step state. Adapters must expose idempotent per-target
operations before joining this flow. Each step checks the actual destination hash,
uses atomic replacement where supported, then records completion. After a crash
between the write and journal update, a matching desired hash acknowledges the
already-completed step. A different unowned/user-modified hash becomes a conflict;
it is never silently overwritten.

A failed handler/index rebuild records `PARTIAL` and retains the journal.
`applied_revision` and the active recall-index pointer advance only after every
target operation and index rebuild succeeds. Until then the CLI reports partial
application, including pending/conflicting targets, and does not claim sync success.
The previous index may remain usable only while its authorization lease is valid.
Restart resumes the journal and rechecks authorization before each sensitive step;
revocation moves it to `BLOCKED_AUTHORIZATION`. Whole-workspace rollback is not
promised. Download failures leave the previous applied state unchanged.

Symlinks, absolute paths, traversal segments, Windows drive/UNC paths, reserved
names and case-insensitive name collisions are rejected before writing.

Materialized `teamai.yaml`, `manifest/roles.yaml` and `manifest/projects.yaml`
are compatibility views derived from authorized server records, not authority
supplied by an arbitrary resource blob. Binding context supplies `dataHome` and
`projectRoot` without requiring `git rev-parse`. Self mode and ordinary Git
sources retain their existing behavior.

For push, handlers scan local candidates and prepare files in a temporary tree;
a manifest diff becomes uploaded blobs plus a change set. Publishing is never an
implicit side effect of local copying. Unsupported handler writes are presented as
console editing until explicitly implemented. Hooks and MCP still require current
client policy and user consent; resource delivery is not permission to execute a
remote command.

The ownership ledger records provider, binding, resource ID/version, destination
and last-applied hash. Removal or project switching deletes only owned content
that still matches that hash, preserving personal changes and reporting conflicts.
Multiple providers must share an ownership/arbitration layer before automatic
fallback is offered. There is no promise that removing an HTTP provider can restore
another provider's content until that layer is implemented.

Telemetry persists `event_id` and per-device sequence numbers before enqueueing.
Its deduplication ledger is separate from the HTTP response cache and covers the
advertised maximum offline window plus the retry window. After ledger compaction,
expired event IDs/closed sequence windows are rejected with
`410 EVENT_WINDOW_EXPIRED` and reconciled explicitly; the CLI must not relabel
old events with new IDs. Durable acknowledgements identify accepted event revisions,
so retries cannot silently double count. Corrections to a resumed session refer to
the original event/session and replace its revision rather than incrementing
successful-session totals again. Learning submissions are reviewable content;
votes and usage events cannot edit published resources. Offline queues are bounded,
encrypted where sensitive, observable to the user, and discarded only after an
acknowledged commit or explicit user choice.

## 9. Go monorepo and storage boundaries

Start with one deployable Go service and one transaction boundary:

```text
server/
  go.mod
  cmd/teamai-server/
  internal/
    identity/
    organizations/
    projects/
    resources/
    changesets/
    reviews/
    sync/
    telemetry/
    audit/
    platform/
  migrations/
  api/
  tests/
```

`platform` supplies HTTP middleware, configuration, clock, IDs and database
plumbing. Domain packages depend on narrow interfaces: `MetadataRepository`,
`BlobStore`, `TransactionManager`, `EventPublisher`,
`IdentityProvider` and `AuditSink`. Cross-domain workflows run through application
services; handlers do not reach directly into another module's tables.

The proposed reference deployment uses PostgreSQL metadata and an S3-compatible
blob store. A transaction updates revisions, approvals, project heads, idempotency
results and an audit/outbox record together. Blob upload precedes publication;
unreferenced staged blobs expire. Outbox dispatch may retry, but duplicated events
cannot produce a second release. Storage substitutions must pass the same
concurrency, durability and isolation tests; in-memory adapters are test fixtures,
not a production persistence claim.

`server/api` will contain OpenAPI and compatibility fixtures after the design is
accepted. `server/tests` will exercise real database/blob adapters plus a fake
identity provider. No server directory or dependency is introduced by this design PR.

## 10. Security and operations

Tenant and project authorization apply to every read/write path, export, source
subscription, blob fetch and report. Secret values live in a separate encrypted
secret service and are resolved only for an authorized device at delivery time.
Audit and telemetry redact secrets and content by default. Existing env resources
become templates and secret references, not public plaintext secrets.

Uploads enforce type-specific validation, byte/count limits, safe archive paths
and content integrity. Source imports allow only approved HTTPS origins, forbid
private-network redirects unless explicitly configured for that tenant, and run
under bounded service credentials. Server-supplied executable plugins or arbitrary
commands are outside the new API. User-authored hooks/MCP may execute locally only
through the existing explicit trust and consent controls.

Rate limits cover principal, device, organization and expensive operations, with
bounded queues and backpressure. Audit failures prevent privileged state changes
unless an atomic durable outbox record can be committed; telemetry outages do not
make unrelated resource reads fail. Metrics cover authorization failures, publication
latency, sync lag, queue age and blob errors without resource content or unbounded
user/project labels. Logs and traces carry request/operation IDs.

Backups include metadata, referenced immutable blobs and encrypted key material.
Restore tests verify referential integrity and replay the outbox without duplicate
releases. Garbage collection preserves all retained releases/drafts and active
sync leases. Tombstone retention must exceed supported offline/delta windows;
after that window clients must obtain full snapshots. Proposed retention periods,
RPO/RTO, key rotation and regional residency remain explicit deployment decisions.

## 11. Phased implementation and acceptance

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| P0 | This bilingual design; resolve section 12 decisions | Capability map, four journeys and protocol semantics reviewed |
| P1 | Identity, organization/project membership, schema and contracts | Tenant isolation, device flow, token revocation and concurrency tests pass |
| P2 | Read-only snapshots, materialization, binding isolation and recall | A clean machine without Git completes J1/J2/J3 resource reads and offline recovery |
| P3 | All resource writes, review, publication, rollback and source references | Exact-digest approvals, atomic cross-project release and ownership-safe removal pass |
| P4 | Learnings, votes, usage/session reporting and administrative import | Idempotent replay, session correction, full capability round-trip and audited import pass |
| P5 | Web console, operations hardening and pilot migration | J4 through the console, restore exercise and deployment security review pass |

P2 is a read-only pilot, not full replacement of Git. All mapped capabilities must
pass before advertising complete Git-free management. The order may be adjusted
only with explicit revised dependencies and acceptance evidence.

| ID | Required acceptance evidence |
| --- | --- |
| A01 | For every row in section 2: import/read/change/review/publish/delete/restore or an explicitly applicable reporting lifecycle; no silently omitted paths |
| A02 | J1: OIDC and a non-standard corporate adapter create the same internal principal shape; forged issuer/group mappings fail |
| A03 | J2: browser and headless enrollment on a machine with Git unavailable; expired/reused/denied codes do not bind |
| A04 | J3: two organizations, multiple projects and workspaces; unauthorized resources never enter manifests, caches, recall indexes or blob responses |
| A05 | J4: two-project release concurrent with a membership/head change; all heads change together or none change |
| A06 | Modify content after approval, replay an idempotency key with a new body, and submit stale ETags; each operation fails with its specified code |
| A07 | Interrupt download, cache promotion, each target write, journal acknowledgement and index rebuild; downloaded/applied revisions stay distinct, PARTIAL is visible, and hash-checked recovery never overwrites personal edits |
| A08 | Revoke users/groups/devices during login, refresh and sync; enforce online checks and the documented offline lease bound |
| A09 | Malformed archives, invalid hashes/signatures, secret-bearing logs and cross-tenant cursor/blob access are rejected |
| A10 | Remove/switch/uninstall with personal edits and overlapping sources; preserve unowned files and surface conflicts |
| A11 | Lose the first mutation response and replay after the 24-hour response cache expires; recover by client operation ID. Replay/correct telemetry across the supported offline window without double counting; expired history/events require explicit reconciliation |
| A12 | Restore a backup, rotate keys and replay the outbox; retained releases remain reproducible and no duplicate release appears |
| A13 | English/Chinese headings, API names, state machines, phases and acceptance IDs remain equivalent |

## 12. Open decisions and non-goals

Before implementation, maintainers must approve: reference storage/deployment;
SSO providers and group synchronization mechanism; tenancy administrator powers;
resource override policy and cross-project source preference; review quorum and
emergency rollback rules; secret delivery/storage; all size/time/retention limits;
identity outage/offline lease policy; signed-manifest key distribution; migration
ownership and compatibility with the pending provider abstraction.

Explicit non-goals for this PR are a Go service, Web console, CLI behavior change,
a claim of production OAuth/security certification, and edits to the usage guide
that describes current behavior. Microservices, cross-organization atomic releases,
arbitrary remote execution, Git-history emulation for end users and transparent
offline revocation are not required to deliver this design.

HTTP conditional-request semantics follow [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110);
device authorization follows [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628).
Implementation must validate these contracts with independent clients rather than
only models defined by the service itself.
