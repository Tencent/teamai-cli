# Fixed-commit knowledge previews

[简体中文](knowledge-pack.zh-CN.md)

## 1. Scope

This is an A/B development increment toward requirement–meeting–code traceability: a TypeScript producer and a standard-library Go validator/query engine. It does **not** implement the [management backend](management-backend.md), a Web console, SSO, a resource handler, publishing, MCP, or automatic `recall` ingestion. Every generated package is an unpublished local **preview**; every relation is a candidate with unknown applicability.

A PRD is first committed to its existing documentation Git repository. The producer reads selected files at full commit IDs and generates derived objects, relations, and evidence. A Git commit is neither business approval of the PRD nor publication of knowledge. No source is edited, no branch is switched, and no commit or push is performed. Source policy references are recorded dependencies, **not** proof of permission or grants to a user.

## 2. Build a preview

Build the CLI (`npm ci --ignore-scripts && npm run build`). Create an input manifest beside your local documentation and code repositories. Replace each commit placeholder with the full 40- or 64-character commit ID from that repository; branches, tags, and abbreviated hashes are rejected.

```json
{
  "schema_version": "teamai.knowledge-input.v1",
  "project_id": "course-export",
  "sources": [
    {
      "source_id": "export-prd",
      "repo": "./documentation",
      "commit": "FULL_DOCUMENTATION_COMMIT",
      "path": "requirements/export.md",
      "kind": "requirements",
      "policy_ref": "course-documents"
    },
    {
      "source_id": "export-review",
      "repo": "./documentation",
      "commit": "FULL_DOCUMENTATION_COMMIT",
      "path": "meetings/export.srt",
      "kind": "transcript",
      "policy_ref": "course-meetings"
    },
    {
      "source_id": "export-code",
      "repo": "./application",
      "commit": "FULL_CODE_COMMIT",
      "path": "src/export.ts",
      "kind": "code",
      "policy_ref": "course-source"
    }
  ]
}
```

`repo` resolves relative to the manifest file, not the caller's working directory. It must be a locally available Git repository; the producer never clones or fetches. Each source entry selects one committed regular UTF-8 file. Symlinks, submodules, traversal paths, missing objects, and oversized inputs are rejected. The complete committed text is included for evidence checking; review the selected material before sharing an artifact. The manifest’s local repository paths and runtime authentication configuration are not copied into the package. Source text is preserved verbatim, so secrets already present in a selected file remain in its snapshot; this is not a secret-redaction tool.

```bash
node dist/index.js codebase --knowledge-manifest input.json --output out --json
node dist/index.js --dry-run codebase --knowledge-manifest input.json --output out --json
```

The first command writes `out/knowledge-pack-<package_hash>.json` and returns its path. Output is immutable: identical content can be built again, but unrelated existing files are never overwritten. Dry runs validate and build in memory without writing an output directory. A package is limited to 16 MiB and 200 selected source versions; a source file is limited to 1 MiB.

PRDs should use explicit stable identifiers, for example:

```markdown
## REQ-23: Export accessible courses

ExportService exports only courses accessible to the current user.
```

Deterministic parsing preserves numbered requirement sections, original source documents, selected useful meeting/transcript statements, and code facts from the existing extractors. Exact requirement references and unambiguous code-symbol mentions can generate candidate links. SRT evidence retains timestamps and source lines. Natural-language suggestions are not promoted to approved decisions; this increment does not perform general semantic PRD understanding or call an LLM. Consult `coverage.warnings` for unparsed, ambiguous, or excluded material. Stable explicit requirement IDs are needed for reliable continuity when text changes.

After another PRD or meeting commit, manually select the new immutable source versions and build another preview. Event-triggered rebuilds, relationship review, and formal knowledge publication remain future integration work.

## 3. Validate and query with Go

From a checkout containing Go 1.24 or later:

```bash
cd server
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --query 'REQ-23'
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --object REQ-23 --version OBJECT_VERSION
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --object REQ-23 --version OBJECT_VERSION --relations incoming
go run ./cmd/knowledge-pack --pack ../out/knowledge-pack-HASH.json --local-preview --trace REQ-23 --version OBJECT_VERSION --depth 2 --max-nodes 100
```

Replace `HASH` with the producer's hash and `OBJECT_VERSION` with the exact version returned by search. Validation returns counts and `state: "preview"`; search returns full objects with IDs, versions, evidence references and a truncation flag. Object reads return the exact object; relation reads return versioned endpoints. Trace returns nodes, edges, evidence, and truncation information. Queries are bounded; trace supports at most three hops and 100 nodes, with a text budget.

`--local-preview` explicitly acknowledges that this executable reads material already available to the local operator. It is not an enterprise access-control boundary, offline lease, network API, or substitute for source authorization. Do not distribute these developer artifacts as officially authorized team knowledge. The engine's `Authorizer` seam checks all source-policy dependencies on each query and denies access if a decision is missing, denied, or unavailable; a real policy authority and every public download/query route still need to be integrated in the management backend.

## 4. Object versions and closed packages

The object reference is `{object_id, object_version}`. One package can contain REQ-23 from two commits. All relation endpoints and evidence must resolve inside that package. Reads never substitute a default/newer version or silently find another package. A historical object includes its own evidence and source-policy dependencies, but does not recursively pull in all historical relationships.

A manifest may specify `default_object_versions` for future navigation, but the Go object/relationship/trace commands still require an explicit version. For example, after inspecting both versions, add an evidence-backed replacement assertion:

```json
{
  "default_object_versions": {"REQ-23": "NEW_OBJECT_VERSION"},
  "assertions": [{
    "type": "SUPERSEDES",
    "from": {"object_id": "REQ-23", "object_version": "NEW_OBJECT_VERSION"},
    "to": {"object_id": "REQ-23", "object_version": "OLD_OBJECT_VERSION"},
    "evidence_refs": ["EVIDENCE_ID_FROM_PACKAGE"]
  }]
}
```

These fields are added to the input manifest. Both source versions must be selected. The assertion remains `human_assertion` / `candidate` / `unknown`: recording it does not confirm the business decision. Timestamp order alone never creates a replacement relationship. Missing endpoints, evidence, default targets, duplicate versions, incompatible endpoint types, and replacement cycles cause validation failure.

## 5. Interchange and future backend boundary

The v1 envelope is `{schema_version, package_hash, payload}`. `package_hash` is SHA-256 of the **exact UTF-8 JSON bytes** of the `payload` value, not the outer document or a reserialized Go object. The producer writes deterministic compact JSON. Reformatting the payload changes its digest; readers reject mismatches. This detects corruption, not producer authenticity or publication approval.

The payload contains source snapshots, source-policy references, exact object versions, line-based evidence, candidate relations, optional navigation defaults, and coverage warnings. The strict Go reader additionally rejects unknown fields, duplicate JSON keys, invalid encodings and trailing data. Source/object hashes and quoted source lines are checked, alongside relation and policy-dependency closure.

Before any shared service uses this format, the Go management backend must independently establish trusted source-policy dependencies, register the resource type, apply current source permissions to **all** content/blob/snapshot/query paths, and publish only via the common ChangeSet → Review → Release flow. A recorded `policy_ref` supplied by this local producer cannot establish those permissions. This module introduces no independent publication pointer or second team-management API.

## 6. Validation

```bash
npm run build
npx tsc --noEmit
npx vitest run
(cd server && go test ./...)
npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/knowledge-pack-cli.test.ts
```

The focused E2E builds a real temporary Git repository, reads old commits despite newer dirty files, verifies immutable output, then runs the Go executable against the Node artifact for exact object versions, relations, search, and trace. Agent/provider combinations exercise local configuration independence; they do not contact GitHub/GitLab or prove agent-runtime, identity-provider, or management-backend integration.
