# Design: teamai data directory layout — global home + per-project partitioning

> Status: **P0 + P1 + P2 + P3 implemented** (issue #374 complete). P1 shipped as PRs #397 / #402 /
> #406 / #414 / #417 (partition routing) and #439 (P1-3 auto-migration). P2 (self
> mode slimming, #455) and P3 (constant functionization + `status --all`) are below.

## Problem

teamai's machine-local data currently lives inside the business repository. In a
real checkout `<repo>/.teamai/` measured **18 MB** — a team-repo clone (12 MB),
downloaded skill resources (4.1 MB), a search index (1.8 MB), plus config, state,
`env`, `token`, and docs. This causes three concrete problems:

- **Workspace residue.** Machine data pollutes the business repo working tree.
- **Worktree / subdirectory blindness.** teamai only looked at the cwd's own
  `.teamai/config.yaml`, so running from a subdirectory found nothing, and a git
  worktree (which does not carry gitignored `.teamai/`) had no config at all.
- **Cross-project mixing.** Global singletons under `~/.teamai/`
  (`dashboard`, `sessions`, `votes`, `usage.jsonl`, ...) are hardcoded to one
  location, so multiple projects' data is indistinguishable.

The end goal (P1+) is to move machine-local data to `~/.teamai/projects/<slug>/`
so the business workspace has **zero residue**, partitioned per project.

## The two anchors (the core model)

A git worktree has two distinct "roots", and teamai needs both:

```
projectAnchor  = first entry of `git worktree list --porcelain` (the main worktree)
                 → the MAIN checkout, SHARED by the repo and all its worktrees.
                 → the stable per-project identity; P1 keys machine data under
                   ~/.teamai/projects/<slug(projectAnchor)>/ by it.

workspaceRoot  = `git rev-parse --show-toplevel`
                 → the CURRENT checkout, DISTINCT per worktree.
                 → where project-scope AI-tool resources (skills/rules/agents,
                   tool config, CLAUDE.md) must be written.
```

They are equal for a plain (non-worktree) repository.

**Why resources must go to `workspaceRoot`, not `projectAnchor`:** every AI tool
(Claude, Codex, CodeBuddy, OpenCode) discovers project resources by scanning up
from the launch directory to the *current* repository root. None of them follows
`git-common-dir` back to the main checkout, and gitignored files do not appear in
a fresh worktree. So resources have to land in the worktree the user is actually
working in.

### Why the main worktree, not `git-common-dir` (verified)

`projectAnchor` uses the first entry of `git worktree list --porcelain` rather than
`dirname(git rev-parse --git-common-dir)`. Two traps make the git-common-dir route
wrong:

- With `git init --separate-git-dir`, the common dir lives outside the checkout
  (e.g. `gitdirs/proj.git`), so its parent is a shared `gitdirs/` — **colliding**
  across unrelated repos, and not the workspace either.
- `--git-common-dir` alone returns a **relative** path (`.git`) in the main repo
  (only absolute inside a worktree), so it needs `--path-format=absolute` (git
  ≥ 2.31) just to be usable — and still hits the collision above.

`git worktree list --porcelain` lists the main worktree first, and every linked
worktree reports the same first entry, giving a shared-yet-distinct identity in all
cases. Both anchors are `realpath`-normalized so a symlinked prefix (macOS `/tmp` →
`/private/tmp`) does not make one checkout look like two.

### Partition naming (#546 + adoption)

`slug(anchor) = <safe-path>-<sha256(normalized anchor) first 16 hex>` — the whole
anchor path made filesystem-safe (leading separator dropped, separators and other
unsafe chars → `-`), so the directory name reads back to its project, mirroring
Claude Code's `~/.claude/projects/` naming: `/Users/x/Project/app` →
`Users-x-Project-app-<hash>`. The trailing hash is what guarantees uniqueness
(a `/`→`-` escape alone is not injective: `/x/my-proj` and `/x/my/proj` would
collide and silently merge two projects' plaintext env), and the prefix is
length-bounded so a deep path can never overflow `NAME_MAX`. The per-partition
`anchor` file stays the authoritative reverse lookup.

Because #546 changed the prefix without changing the hash, partitions written by
older teamai (`<safe-basename>-<hash>`) are **adopted, not stranded**: every seam
that resolves "this project's partition" (detection, init, migration) goes through
`resolvePartitionDir`, which computes the anchor's exact legacy name and ATOMICALLY
RENAMES the directory into the current name (same-parent metadata move — no data
copied, an interruption leaves either name intact). A partition that cannot be
renamed (read-only home) keeps serving under its legacy name; an authoritative
current-format partition is never clobbered by a leftover legacy one. `status
--all` never renames (read-only) — it reports a legacy-named partition as
`active (legacy name; renamed automatically on next command)` instead of corrupt.

The rename alone is not enough: `repo.localPath` is stored in config.yaml as an
ABSOLUTE path to the team-repo clone (`<oldPartition>/team-repo`), so adoption
also rebases it onto the new directory — otherwise `pull` would read the team
config from a now-gone path and silently skip the sync (exit 0, "Team config not
found"). The rewrite is idempotent (a modern install's localPath already sits in
the canonical dir and is left untouched; an external clone outside the partition
is left untouched) and self-healing (it finishes an adoption that crashed between
the rename and the config rewrite) — the same `repo.localPath` rebase that
`migrate.ts` applies when moving a legacy `.teamai/` into a partition.

The rewrite is ATOMIC (same-dir temp file + rename, via `writeFileAtomic`). By
this point the legacy source has already been renamed away, so config.yaml is the
partition's only copy; a plain overwrite that failed partway (ENOSPC, EFBIG, a
crash mid-write) would truncate it with no way back. rename(2) is atomic, so a
failed write removes the temp file and leaves the original config.yaml intact —
the next command retries the (idempotent) rebase and converges.

## P0 (this PR) — atomic lock + anchor split

P0 is deliberately **structural**: it establishes the primitive and fixes
discovery, WITHOUT relocating any data. The physical layout
(`<projectRoot>/.teamai/`, `getTeamaiHome()`) is unchanged, and the 61
`resolveBaseDir()` call sites are untouched — their divergence from the data home
is a P1 concern. This keeps P0 independently reviewable (issue R7).

1. **Atomic locking** — `src/update.ts` `acquireLock()` / `releaseLock()`.
   The old lock was check-then-write (`pathExists` → `writeFile`): two racing
   processes could both observe "no lock" and both succeed, and `releaseLock()`
   unconditionally deleted the file — including a lock another process later
   acquired. Rewritten to:
   - Acquire with an atomic exclusive create: the payload is written to a private
     temp file and hard-linked to the lock name (`link` fails with `EEXIST` like
     `O_CREAT|O_EXCL`), so the lock never exists without its content (#760); a
     filesystem without hard links falls back to `writeFile(path, payload, { flag: 'wx' })`.
     Payload is JSON `{ pid, startedAt, owner }` with a random `owner` token.
   - On `EEXIST`, reclaim only a **stale** lock: one whose owner is provably gone
     (`process.kill(pid,0)` fails with `ESRCH`). The reclaim is **serialized behind an
     atomically-created reclaim sentinel** and finished with an atomic rename-into-place,
     so concurrent reclaimers cannot each end up believing they hold the lock; a live
     holder returns "busy". Anything that cannot name a dead owner is held (#760): a
     lock that cannot be read (`EACCES`), an empty or partly written one (the `wx`
     fallback and older teamai open the file before writing), and a pid owned by another
     user (`EPERM`). A lock that names no owner, or cannot be read, stays until
     removed by hand if a crash left it, and a warning names it. A lock that vanished before it could be read gets one more
     exclusive create instead (a third process may already have re-created it).
   - Migration skips the locks' transient artifacts (`<lock>.<uuid>.tmp`, `.sentinel`
     and its temps, `.new-<uuid>`) along with the locks themselves.
   - `releaseLock()` returns early when this process holds no owner token for the
     path, and otherwise deletes only when the on-disk `owner` still matches the token
     this process recorded — never another process's lock.
   - Back-compatible with legacy plain-integer PID lock files.
   The three call sites (`update.ts`, `bootstrap.ts`, `utils/reports-branch.ts`)
   keep their signatures and all benefit.

2. **Anchor primitive** — `src/utils/git.ts` `resolveAnchors(cwd?)`.
   Returns `{ workspaceRoot, projectAnchor }`, or `null` outside a git repo (callers
   fall back to cwd-based behavior).

3. **Subdirectory / worktree-aware discovery** — `src/config.ts`
   `detectProjectConfig()`. When the cwd has no `.teamai/config.yaml`, it retries at
   the git `workspaceRoot`, so teamai runs from any subdirectory and resolves a
   worktree's `projectRoot` to that worktree.

4. **Semantics** — `resolveBaseDir()` (`src/types.ts`) documented to return the
   *workspace root*; behavior unchanged.

### P0 acceptance (verified end-to-end with the real CLI)

- Concurrent `acquireLock` on one path → exactly one winner; stale locks reclaimed;
  non-owner release is a no-op (`src/__tests__/lock-atomic.test.ts`).
- `resolveAnchors` on a real repo + real `git worktree add`: shared anchor, distinct
  workspace (`src/__tests__/anchors.test.ts`).
- Real CLI: `status`/`pull` from a nested subdirectory detect **project** scope and
  deploy to the repo root; run inside a worktree, resources land in the worktree and
  the main checkout is untouched (`src/__tests__/detect-subdir.test.ts` + manual run).

## P1-3 — automatic migration (implemented)

An install created before partitioning keeps its machine data in the business repo
at `<workspaceRoot>/.teamai/`. P1-2 routed NEW installs to the partition and reads
old installs through a legacy fallback; P1-3 moves a real legacy `.teamai/` INTO the
partition on the next write command, so the workspace ends up with zero residue.

**Trigger** (`src/migrate.ts`, wired into the global `preAction` hook in `index.ts`):
- Only `init` / `pull` / `push`. Read-only commands (`status`, `recall`, …) keep using
  the double-read fallback and never move data.
- `hook-dispatch` is excluded outright (via `TEAMAI_HOOK_SUBCOMMANDS`): it is a
  high-frequency silent path and must never move 12 MB.
- `--dry-run` (the existing global flag) previews without writing.

**Gate** (`planMigration`, deliberately NOT `detectProjectConfig` — that
short-circuits on an existing partition and runs the self-heal bootstrap as a side
effect, both of which would mask the raw legacy state). Act iff:
- in a git repo (the partition only exists for git repos), AND
- `<workspaceRoot>/.teamai/config.yaml` exists, AND
- the legacy config is `scope: project` (user data never lives under `.teamai/`), AND
- the legacy config is NOT `kind: self` — **self mode is a hard no-op**: its `.teamai/`
  is team knowledge committed to main, and `init --self` already retires any partition,
  so moving it would break "knowledge on main".

The plan's **mode** then depends on the partition: a full copy when
`<partition>/config.yaml` does not exist yet, or **retire-only** when it does (a prior
run built the partition but was interrupted before retiring the source — see Interrupt
recovery). retire-only never re-copies onto the authoritative partition; it only cleans
up the leftover legacy dir.

**Steps** (`runMigration`) — copy → verify → atomic rename, so an interruption never
leaves data half-in-both-places:

```
0. Acquire <legacyDir>/.sync-lock (the exact lock an un-migrated pull/push contends
   on, since their getDataHome still resolves to the legacy dir pre-migration).
   Contention → skip this attempt (idempotent; the next write command retries).
1. Copy legacyDir → <partition>.staging  (raw fse.copy, NOT copyDir — copyDir filters
   out `.git` and would corrupt the team-repo clone). Skip reports-wt/learnings-wt/knowledge-wt
   (disposable worktrees with absolute gitdirs — rebuilt on demand) and lock files.
2. Verify staging: config.yaml parses; if the source has team-repo/.git the copy must
   too; every migratable top-level entry is present. Failure → discard staging, abort,
   source untouched.
3. Atomic switch: fse.rename(staging → partition)  (same-filesystem, atomic).
4. Write <partition>/anchor with the projectAnchor path — the slug's readable
   prefix is lossy (path chars folded, length-bounded) and its hash is one-way,
   so this file is the authoritative reverse lookup; it lives off the workspace.
5. Release the lock, then retire the source:
   a. Drop a self-contained `.gitignore` (`*`) INTO legacyDir first. An old
      install's `.teamai/` was often protected only by a repo-root rule matching
      `.teamai/`, which does NOT match `.teamai.bak/` — so without this the rename
      would expose the plaintext env/token to the next `git add`. Written before
      the rename so the credentials are never in a non-ignored directory.
   b. Rename legacyDir → the first FREE `.teamai.bak[.N]` name. An existing backup
      (a prior migration's, or the user's own) is NEVER removed — it may hold
      irreplaceable data — so we pick `.teamai.bak`, else `.teamai.bak.1`, …
   The backup is NEVER auto-deleted: it is the manual rollback path.
```

Interrupt recovery: staging is a separate sibling dir, so a crash before step 3 leaves
the partition absent and the source intact — a rerun discards `.staging/` and starts
clean. A crash between steps 3 and 5 leaves the partition built with the legacy dir
still present; the next write command's `planMigration` sees "partition exists AND
legacy lingers" and returns a **retire-only** plan that finishes the job — it retires
the leftover legacy dir to `.teamai.bak/` WITHOUT re-copying onto the now-authoritative
partition. This closes the gap where the legacy dir (including its plaintext `env`)
would otherwise linger in the workspace forever, breaking the zero-residue guarantee.

The staged team-repo clone is smoke-checked (`git rev-parse HEAD`) before the rename,
so a partial/corrupt copy aborts with the source untouched rather than promoting a
broken clone. If a write command's migration fails, teamai prints a clean error and
exits non-zero (the source is intact, so a rerun retries safely) instead of surfacing
a raw async-hook rejection.

**Downgrade is not supported** — an older teamai treats a partitioned install as
uninitialized; `.teamai.bak/` is the manual rollback. Flag prominently in release notes.

## P2 — self (single-repo) mode slimming (implemented)

Before P2, self mode kept its class-A1 machine data (config, state, env backup,
search index, managed-mcp, the per-worktree resource cache) inside the business
repo at `<repo>/.teamai/`, alongside the class-B team knowledge that is committed
to main. A hand-maintained `.gitignore` blacklist kept `git status` clean — a
fragile arrangement (the per-worktree `workspaces/` tree and the user-scope
`managed-mcp.json` were, in fact, never listed, so a self repo running MCP
reconcile or the local agent leaked them into the working tree).

P2 physically relocates the A1 data to the partition `~/.teamai/projects/<slug>/`,
leaving `.teamai/` with only class-B knowledge. The lever is the same as non-self
installs: attach a partition `dataHome` to the self LocalConfig, and every
`getDataHome()`-based write follows.

**Invariant:** `getKnowledgeDir` / `repo.localPath` stay `<repo>/.teamai` — that is
the class-B knowledge anchor, committed to main, and the ~230 `path.join(localPath,
…)` call sites do not change. `reports-wt/`, `learnings-wt/` and `knowledge-wt/`
stay in the repo too (git worktrees must live in the same repo; they anchor on
`localPath`, not `getDataHome`). Learnings themselves left the default branch in
issue #485: new ones are written to `learnings-wt/` (the `teamai-learnings`
branch) and queued in `pending-learnings/` until they are published, while the
learnings already on main are read from where they are.

- **init** (`initSelfRepo`): resolves the partition up front, attaches it as
  `dataHome`, and writes config/state there. The pre-P2 "retire the stale
  partition" step is gone — self now USES the partition, so there is nothing to
  retire.
- **bootstrap** (teammate fresh clone, `bootstrapSelfRepo`): the "already
  initialized" check and the config write both target the partition (with a legacy
  fallback so a pre-P2 install is still recognized).
- **detection seam** (the delicate part): on a fresh clone the partition config
  does not exist yet, so partition-first misses. The legacy branch runs the
  self-heal bootstrap — which now writes the config into the PARTITION — then reads
  it back FROM the partition (`selfHealAndReadPartition`). A pre-P2 install whose
  config still sits in `<repo>/.teamai` is read via the legacy branch (double-read
  compat) until migration relocates it.
- **migration** (`migrate.ts`, `mode: 'self'`): self CANNOT use the git-mode whole
  directory copy→rename (that would carry the knowledge off and rename `.teamai` to
  `.bak`, breaking "knowledge on main"). Instead it selectively relocates the A1
  whitelist (config.yaml, state.json, env.local, env.sh, search-index.json,
  managed-mcp.json, workspaces/) entry-by-entry, destination-first (copy to the
  partition, then delete the source), leaving class-B knowledge and the worktrees
  untouched and never renaming `.teamai/`. self `repo.localPath` is NOT rebased —
  it must keep pointing at the in-repo knowledge.

Acceptance: after slimming, `git status` is clean (the A1 data is physically gone,
not merely ignored) and a teammate's fresh clone bootstraps into the partition.

## P3 — constant functionization + `status --all` (implemented)

**Functionization.** A handful of top-level path constants were computed once at
module import: `export const TEAMAI_HOME = path.join(getUserHome(), '.teamai')` and
its derivatives (config/state/token/update-lock/session-logs/learnings/votes/
search-index). Because they froze at import, a test that later swapped `HOME` never
saw the new value — so `HOME`-based isolation silently failed (tests worked around
it with `vi.resetModules()` or `vi.mock('../types.js')`). P3 converts them to
call-time getters (`getTeamaiHomeDir()`, `getUserVotesDir()`, `getSessionLogsDir()`,
…), matching the existing `getUserHome()` / `getDataHome()` pattern, so isolation
just works. Seven consts that already had runtime getters and no live consumers
(`TEAMAI_SOURCES_DIR`, `TEAMAI_USAGE_PATH`, `TEAMAI_KNOWN_SKILLS_PATH`,
`TEAMAI_PUSHIGNORE_PATH`, `CONTRIBUTE_SESSIONS_DIR`, `DASHBOARD_EVENTS_DIR/PATH`)
were removed.

**Functionization ≠ project-scoping.** All of these are class-A2 (machine-level):
the getters still return `~/.teamai/...`, unchanged. The project-scoped equivalents
already route through `getDataHome()`. Skill usage moved there too (#748):
`usage.jsonl` lives in each scope's `getDataHome()`, because one shared file let a
project's report carry every project's skills. The user scope records in
`~/.teamai/user-usage.jsonl`, not that old shared `~/.teamai/usage.jsonl`, which
an earlier release still writes after a rollback; the shared file is never
read. The dashboard is likewise an A2 singleton
(events carry `cwd`/`sessionId`); "two projects' events don't mix" is satisfied by
`getEventsPath()` reading `HOME` at call time, not by per-project dirs.

**`anchor` on save.** Previously only migration wrote a partition's `anchor`
reverse-lookup file, so freshly-init'd partitions had none. `saveLocalConfigForScope`
now writes it whenever the config lands in a partition (via the shared
`writeAnchorFile`), so every partition can be resolved back to its project.

**`status --all`.** Extends the existing `status` command with an `--all` flag that
enumerates every partition under `~/.teamai/projects/` and marks each
active / ORPHAN (project path gone → safe to delete) / unknown / corrupt. The
verdict rests **only on the `anchor` file** — the shared project anchor the
partition is keyed by. The config's businessRepoRoot/projectRoot is read purely as
a display fallback: it is a persisted *workspace* path that may point at a linked
worktree, so its disappearance does not prove the shared partition is orphaned. A
partition with no anchor (e.g. one written before anchor-on-save) is therefore
`unknown`, never ORPHAN — we never recommend deleting data we cannot confirm is
dead. teamai never auto-collects orphans (a renamed or deleted project leaves its
partition behind — a `gc` command is explicitly out of scope), so this is how a
user finds partitions safe to `rm -rf` by hand.

### Explicitly out of scope

`teamai migrate` / `gc` / `--revert` commands; cross-project shared team-repo clone.
Downgrade to an older teamai after
P1 migration is not supported (`.teamai.bak/` is the manual rollback path).
