# Gitea provider

> Status: In progress
> Baselines: v0.27.0 for the backport; main for review discussions.

## Background and scope

An unrecognized self-hosted Gitea remote previously selected the transport-only
Git provider. Branches could be pushed but PR creation remained manual. This
provider adds explicit instance configuration, PAT authentication, PR creation
and reviewers, repository/org operations, and PR import without changing the
core push algorithm or introducing another platform CLI.

## Data flow and ownership

```text
init URL → registry → GiteaProvider → verified login → private Git clone
push branch → createPullRequest → recover exact PR → request reviewers
import PR URL → configured-origin validation → metadata/commits/diff → MRData
shallow import → validated clone URL → one-off Basic header → Git
```

`repo-url.ts` owns instance validation and URL parsing. `gitea-api.ts` owns PAT
resolution, per-process login caching, bounded HTTP requests and Git credentials.
`org.ts` maps organization repositories; `mr-fetch.ts` maps evidence for import;
`probe.ts` performs anonymous detection; `index.ts` implements GitProvider.

The registry, provider exports/schema, init help, doctor, shallow clone/fetch,
MR dispatch, and init clone target are connected explicitly. Init must pass the
canonical remote to Gitea rather than reducing it to owner/repo, preserving SSH
transport and port. Both shallow-auth callers await login resolution.

## Instance and credential boundaries

`GITEA_URL` is required and preserves scheme, port and subpath. Optional
`TEAMAI_GITEA_HOST` is a same-host routing hint, not an alias map. HTTP inputs
are validated against origin and base-path segments before any credential is
used. SSH keeps the supplied port and requires the same hostname. Anonymous
version probing has a three-second total budget, omits credentials and rejects
redirects. A compatible response does not establish Forgejo identity.

PAT precedence is env, then a matching hostname in netrc. Interactive init uses
the existing hidden secret prompt and verifies before saving mode 0600. The
verified login is cached only per instance/token in the current process. REST
uses token auth; HTTP Git uses Basic with that login. Private team HTTP origins
persist encoded credentials for bare push; SSH origins never receive a PAT.
Shallow clones/fetches use one-off headers. Netrc is not port-scoped; token/TLS
migration must update existing origins separately. Errors redact raw and encoded
credentials and authorization headers.

The synchronous clone/org-existence contract is retained: rare synchronous API
lookups use a bounded Node child, passing the PAT over stdin instead of argv.
Init normally has already verified and cached the login before cloning.

## PR and evidence behavior

- Create uses head/base/title/body. Duplicate or ambiguous transport failure
  recovery enumerates open PRs and matches both full repository names and refs.
  Only one exact match is accepted; authorization/server errors are not retried.
- Gitea 1.27 accepts reviewers in the create body. Separate per-login requests
  are intentional: an invalid reviewer cannot prevent PR creation or discard
  other valid requests. Existing invitations are recognized; failures are visible
  warnings and independent of the returned PR URL.
- Pagination honors next links and otherwise continues to an empty page; a
  short page alone is not terminal. Cross-endpoint next links are rejected.
  Reaching a resource budget fails or reports truncation instead of silently
  claiming complete evidence.
- Required PR metadata/commits/diff failures stop import. The diff is limited
  to 50 KiB on read, with a UTF-8-safe incompleteness marker. The 0.27 backport
  does not read discussions. Main reads review summaries, inline comments and issue comments using MRFetchOptions; each retains its source ID and timestamp. Gitea exposes no reply-parent ID or authoritative source line in that contract, so comments remain independent and diff positions are not presented as line numbers. The extraction prompt labels missing resolution state explicitly and forbids inferring resolved status or agreements from missing metadata or a merged PR. A real-model draft exposed that risk during validation. Pending reviews and generated TeamAI comments are excluded; optional API failures warn and preserve other evidence.
- A private repository's 404 is ambiguous, so clone failure does not trigger
  automatic repository creation. Organization/repository creation is explicit.

## Verification

Initial unit and integration checks cover URL forms, host/port/subpath rejection,
env/netrc/TTY auth, PR duplicate recovery, reviewer partial failure, pagination,
bounded diff, SSH-origin preservation, org mapping and redaction. Tests and
real-CLI records must name the exact build before the feature is declared ready.
Live tests require an explicit opt-in and dedicated test accounts.

Local verification on 2026-10-19 used Node 22 and isolated Git 2.54:

- At main `22b3e42`, the full unit run passed 11,070 tests (25 skipped).
  After the dispatch correction, `4d23906` passed 98 focused tests plus
  typecheck, lint and build. Its full unit run is still pending.
- The Gitea directory's focused coverage at `4d23906` is 97.62% statements
  and lines, 84.41% branches and 89.36% functions (directory aggregates).
- Gitea 1.27.3 fixtures exercised packaged CLI init, private HTTP and SSH
  push, repeated PR reuse and reviewer assignment. Separate API fixtures
  checked 70 commits, 140 unique review/comment bodies, exact PR recovery,
  token revocation/rotation, anonymous public fetch and private denial.
- Forgejo 15.0.10 fixtures exercised packaged init, push, PR reuse and
  reviewer assignment. Both servers were also used for actual CLI import
  with a real Claude backend; this is a bounded compatibility sample.
- The `4d23906` package (SHA256
  `501192853b24e0fd6041074276b11d9567fab75897f1d109e999e3d8f8aa008e`)
  imported a merged Gitea PR whose repository name contains `github.com`.
  CLI and model exited 0, and all three discussion sources reached the prompt.
  The preceding package selected GitHub for that same URL and failed before AI.

Model output remains a draft requiring review: earlier runs inferred resolved
status without evidence or confused the CLI and server versions. The prompt
now guards unknown resolution state; a successful import is not proof of content
accuracy. Target-host deployment, upstream CI, release publication and actual
member acceptance remain outside these local results.

## Non-goals

Anonymous team init, SSH hostname aliases, gitea.com global mapping, Gitea Actions
templates, and CI extraction/comment commands are excluded. A credential helper
may replace embedded HTTP origins later; this provider does not redesign every
existing provider's credential storage.
