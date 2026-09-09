# Design: teamai data directory layout — global home + per-project partitioning

> Status: **P0 + P1 implemented** (issue #374). P1 shipped as PRs #397 / #402 /
> #406 / #414 / #417 (partition routing) and the P1-3 auto-migration below.
> P2–P3 are follow-up phases, tracked below.

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
   - Acquire with an atomic exclusive create (`writeFile(path, payload, { flag: 'wx' })`
     = `O_CREAT|O_EXCL`); payload is JSON `{ pid, startedAt, owner }` with a random
     `owner` token.
   - On `EEXIST`, reclaim only a **stale** lock (dead pid via `process.kill(pid,0)`,
     or unparseable content). The reclaim is **serialized behind an atomically-created
     reclaim sentinel** and finished with an atomic rename-into-place, so concurrent
     reclaimers cannot each end up believing they hold the lock; a live holder returns
     "busy".
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
   out `.git` and would corrupt the team-repo clone). Skip reports-wt/knowledge-wt
   (disposable worktrees with absolute gitdirs — rebuilt on demand) and lock files.
2. Verify staging: config.yaml parses; if the source has team-repo/.git the copy must
   too; every migratable top-level entry is present. Failure → discard staging, abort,
   source untouched.
3. Atomic switch: fse.rename(staging → partition)  (same-filesystem, atomic).
4. Write <partition>/anchor with the projectAnchor path — the slug is a one-way
   sha256, so this file is the only reverse lookup; it lives off the workspace.
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

## Follow-up phases (not in this PR)

- **P2** — self (single-repo) mode slimming: only team knowledge (class B) stays in
  the repo.
- **P3** — functionize module-load-time path constants (so tests that swap `$HOME`
  at runtime take effect), then assign A1/A2 ownership per the data-classification
  table. `status --all` across partitions.

### Explicitly out of scope

`teamai migrate` / `gc` / `--revert` commands; cross-project shared team-repo clone.
Downgrade to an older teamai after
P1 migration is not supported (`.teamai.bak/` is the manual rollback path).
