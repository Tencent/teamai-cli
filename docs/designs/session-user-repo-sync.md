# Design: Session User-Repo Sync — cross-project consumption and correctness fixes

> Status: Approved · Branch: `feat/session-user-repo` · Phasing: M1 → M2 → M3 (one PR each)

## Problem

`teamai session` commands store sessions in a team repo under `sessions/repos/<repoIdentity>/<author>/`.
Project-level repos (repo cloned inside the project) form a closed loop: push reads only the
project cwd, and list/pull/resume filter by the project's `git remote` identity. User-level repos
(the clone lives anywhere, e.g. under `~/.teamai/`) can already **receive** sessions from any
directory — but nothing can **consume** them back across projects, and several correctness bugs
undermine the whole flow.

| # | Problem | Evidence |
|---|---------|----------|
| P1 | `session search --all` never searches other projects: the loop body is dead code, and `listRepos()` returns encoded dir names with no decoder — although each repo's `_index.json` stores the canonical identity | `session-cmd.ts:494-517`, `sync.ts:108-110`, `sync.ts:451-457` |
| P2 | `list` / `pull` / `resume` have no cross-project view; `_unattributed` sessions are invisible from any git directory | `session-cmd.ts:410-474`, `sync.ts:234-239` |
| P3 | `migrate --push` archives under the cwd where the command ran, not the session's native project | `session-cmd.ts:301-324` |
| P4 | `migrate --push` re-reads "the N most recent" target sessions, which can push unrelated pre-existing sessions instead of the migrated ones | `session-cmd.ts:306-307` |
| P5 | `push` is single-cwd only; no cross-directory batch | `session-cmd.ts:344-390` |
| P6 | 14 Chinese user-facing strings violate the English-output rule (3 console + 11 throw) | `session-cmd.ts:279,562-563,573`; `codex.ts:240`, `sync.ts:372/375/408/417`, `claude-code.ts:379`, `codebuddy-ide.ts:172/307`, `codebuddy.ts:263`, `workbuddy.ts:264`, `cursor.ts:229` |
| P7 | Meta lies: `fidelityScore` hardcoded 1.0; `createdAt` records push time, breaking search time-decay ordering | `session-cmd.ts:323`, `sync.ts:168` vs `search.ts:104-111` |
| P8 | Repeated pushes of one session create `xxx` and `xxx_1` duplicates; no dedup key | `sync.ts:329-330` |
| P9 | `resume` in the wrong directory throws an uncaught Chinese error with no hint the session lives under another identity | `session-cmd.ts:455-474`, `sync.ts:408` |
| P10 | `gitCommit` returns HEAD even when nothing was committed → "✓ Pushed N" on empty pushes | `sync.ts:546-549` |

Additional aggravator for P3: when `codebuddy-ide` `readSession` falls back to a global search and
finds a conversation from another workspace, it silently rewrites `session.cwd` to the passed-in
project path (`codebuddy-ide.ts:163-170,223`) — the archive key is wrong *deterministically*,
not just incidentally.

## Solution

### Key invariant

**A session's archive key (repoIdentity) is derived from the session's own native cwd whenever
that cwd is knowable, never from the directory where the CLI happened to run.** When the native
cwd is unknowable (codebuddy-ide without an explicit path), warn and fall back to `_unattributed`.

Native-cwd knowability per adapter:

| Adapter | Source | Effort |
|---------|--------|--------|
| codex | `session_meta.payload.cwd` — real absolute path | none |
| workbuddy | `meta.json` cwd | none |
| claude-code | each JSONL record carries `cwd`; adapter must read the first record | small |
| codebuddy CLI | each record carries `cwd` (written by `writeSession`) | small |
| cursor | same pattern as claude-code | small |
| codebuddy-ide | workspace dir = md5(cwd), irreversible | impossible — caller must pass real cwd, else `_unattributed` + warning |

### Data model (no schema changes)

`SessionSyncMeta.origin` gains reliable values: `repoIdentity` from native cwd (fallback:
caller-provided, then `_unattributed`), `createdAt` from `session.createdAt` (not push time),
`fidelityScore` from the migration preview score. Dedup key = `origin.sessionId` + author:
re-pushing updates the existing entry instead of generating `_1` suffixes.

### Entry points

- `session list --all` / `session pull --all` — iterate every repo dir via `_index.json` canonical
  identities plus `_unattributed`.
- `session search --all` — replace the dead loop with the same cross-repo iteration.
- `session push --all` — `--source` stays required; enumerates every workspace directory of that
  one platform (bounded blast radius, consistent with `status --all`). Confirmation list when
  more than 5 sessions would be pushed; `-y` skips.
- `migrate --push` — re-read exactly the `result.targetSessionId`s recorded during the migration
  loop; archive under the session's native identity.
- `resume` failure — append a hint: the session may be archived under another project; try
  `session search --all` or `--cwd <project path>`.

Deliberately **not** done: new top-level commands (Occam's razor — every change extends an
existing command's options); branch/MR flow for session push (current behavior pushes the
current branch; aligning with `teamai push`'s branch+MR flow is a separate discussion).

## Affected surface

**New** (this PR series):
- `docs/designs/session-user-repo-sync.md` — this document
- `src/__tests__/session-sync.test.ts` — SyncManager: index, encoding, archive layout, dedup, cross-repo listing
- `src/__tests__/session-cmd.test.ts` — command layer: search --all, push --all, archive key, English output

**Modified**:
- `src/session-flow/sync.ts` — native-identity validation, dedup, `listAllRepoIdentities()`, cross-repo `listSessionsAcrossRepos()`, empty-commit detection
- `src/session-flow/session-cmd.ts` — `--all` options, precise re-read, resume hint, English strings
- `src/session-flow/adapters/claude-code.ts`, `codebuddy.ts`, `cursor.ts` — read native cwd from first record; English errors
- `src/session-flow/adapters/codebuddy-ide.ts`, `codex.ts`, `workbuddy.ts` — no silent cwd rewrite; English errors
- `docs/usage-guide.md` / `docs/usage-guide.zh-CN.md` — new `### Session Sync & Migration` section between Session Save and Hooks (+ both TOCs)
- `README.md` / `README.zh-CN.md` — Sessions row and command cheat-sheet
- `CHANGELOG.md`

## Phasing

| Phase | Scope | PR |
|-------|-------|-----|
| M1 correctness | P3 P4 P6 P7 P9 P10 (small fixes, no API change) | 1 |
| M2 user-repo capability | P1 P2 P5 P8 + SyncManager cross-repo API + archive-key rework | 1 |
| M3 tests & docs | both test files, six doc touchpoints, real-CLI E2E report | 1 |

M1 and M2 are independent in code but share the same branch; M3 lands last and validates both.

## Out of scope

- Branch/MR flow for session push (separate discussion)
- Streaming/lazy loading for search (known limitation: full sessions are read into memory; recorded, not fixed)
- SessionSave/`teamai session save` (different system — digest summaries)

## Known limitations (QA sweep, recorded — not fixed by design)

Verified by `src/__tests__/fidelity-sweep.test.ts` (roundtrip matrix, kept as the fidelity
regression suite):

- **fidelityScore is a proxy metric.** It only measures IR-block-level degradations. Content
  deformation (dropped empty messages, timestamp collapse, sessionId regeneration, title
  drift, message splitting in codex) is invisible to it. Do not treat 100% as "byte-perfect".
- **codex message splitting**: `[thinking, text, tool_call]` assistant turns are written as
  separate codex response_items and read back as more messages than went in.
- **Empty-content messages** are dropped by several adapters' writers/readers (semantic
  choice per adapter; unifying would change existing behavior).
- **sessionId is platform-native.** v4 (claude-code), v7 (codex), 32-hex (codebuddy-ide)
  each regenerate on write; a cross-platform chain therefore accumulates one archive per
  platform. The session id you resume with is always the target platform's.
- **claude-code flattenDag** drops sidechain branches and can promote orphan nodes early;
  fork branches interleave into the main timeline.
- **cursor has no stored title** — the title is derived from the first real user text;
  sessions whose only real content is tool output may title from that snippet.
- **codex has no on-disk title mechanism** — roundtrip titles degrade to `Session <ts>`.

## End-to-end test plan (real CLI, per AGENTS.md — type-check/unit tests don't count)

1. `node dist/index.js session platforms` — all 6 platforms listed, `codebuddy` and `codebuddy-ide` both `✓ installed`
2. In a non-git temp dir: `session push --source codebuddy --repo-root <user-repo>` — session lands under `sessions/_unattributed/`, output is English
3. In the user repo: `session list --all` — the unattributed session is visible; `session list` (no flag) — not visible (current-project filter intact)
4. `session search --all <keyword>` — matches sessions from at least two different repoIdentity dirs
5. From project A: `session migrate <B-session-id> -s codebuddy-ide -t claude-code --push` — archive lands under B's identity (check meta.json), fidelityScore equals preview score, no `_1` duplicate on re-push
6. Re-run step 5 push — same entry updated, no duplicate file
7. `session resume` in a wrong project dir — error is English and mentions `search --all` / `--cwd`
8. Empty repo push (`session push --source codebuddy` with no local sessions) — prints "No sessions found", never "✓ Pushed"
9. `npx vitest run src/__tests__/session-sync.test.ts src/__tests__/session-cmd.test.ts` — all green
10. `npx vitest run` — no new failures vs. the pre-change baseline
