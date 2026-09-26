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

**What that means for "already synced".** `state.json` sits in the shared
partition, so its `lastPullRev` and `lastPullTargets` say what the *project* last
synced, not what this checkout holds. A project-scope `pull` also records both per
checkout in `lastPullByWorkspace`, keyed by `managedMcpWorkspaceId(workspaceRoot)`
plus the inode and birth time of the checkout's `.git` entry (new each time a
worktree is created, so a worktree re-created at the same path gets its own key),
and takes the unchanged-repo fast path only when the shared `lastPullRev` and this
checkout's own revision and tool targets all match. A worktree added after the
last pull therefore gets a full sync on its first pull, and two checkouts with
different tool directories no longer force a full sync on each other (#807).
Clearing `lastPullRev` still forces a full sync, which is how exclude, tags,
roles, projects, init and bootstrap apply their changes: the pull that finds
`lastPullRev` cleared resets every other checkout's entry to an empty `rev`,
which matches no revision, so each checkout does its own full sync (an older
CLI compares `rev` too, so it also misses the fast path). A new team revision
resets nothing, since a checkout recorded at an older revision already misses
the fast path. `push` needs that entry too: before scanning, it syncs each rule
and skill the member never edited, and "never edited" means equal to the
version at a revision *this* checkout synced, not the shared `lastPullRev`
another checkout may have moved (#812). A placed agent, which push does not
sync, is held when the team file has changed since any of those revisions, or
since it was added if one of them predates it (#823). That sync brings the
unedited copies up
to the team repo, so when push has refreshed the team repo it adds the
revision it synced to the entry's `pushBaseRevs`, newest first, even under
`--dry-run`, since the sync has already written the files, and even when the
sync stopped partway (it warns), since the copies it did not reach still match
an older base. If push cannot save that revision, it stops before scanning and
pushes nothing. The next push
accepts a copy at any of `pushBaseRevs` or at `rev`, so a copy the sync left
alone as edited is recognized again once the member undoes the edit, back to
whichever version a sync gave it. The list keeps the 20 newest revisions; a
copy at an older one reads as an edit until the checkout pulls. Push never
moves the entry's `rev`: the pull fast path reads it, and the checkout still
lacks that revision's docs and agents. A reset entry keeps its bases, `rev`
included, in `pushBaseRevs`, and the next pull in the checkout rewrites the
entry without them. A checkout with no entry (new, or last pulled by an older
CLI) syncs against the shared `lastPullRev`, which may be another checkout's or
cleared, so when the scan lists a team rule or skill as modified, push stops
before creating a branch and asks the member to save any edits to them and run
`teamai pull` in the checkout. A rule this machine placed (`placedRules`) is the
author's own copy and does not count; config-only pushes and new resources go
through. Every full sync keeps only the
entries of checkouts `git worktree list` still reports, so a deleted or
re-created worktree's entry goes with the next full sync in any checkout. A
state.json written before this field has no entry, so each checkout does one
full sync after the upgrade. The user scope's pull records its one checkout,
HOME, the same way, for push's bases alone: its fast path still reads the
shared fields, and an install with no entry yet (upgraded, and not fully
synced since) compares with `lastPullRev` and `lastInheritedPullRev`, which
only HOME's pulls move and either of which may have run last, so push does not
stop there; its first push creates the entry from `lastPullRev`, with
`lastInheritedPullRev` as a push base, and adds the revision its sync reached.
A project pull that inherits the user scope (`inheritUserScope`) moves HOME's
skills, rules and agents too, so it adds its revision to that entry's push
bases, creating the entry the same way if there is none, and leaves the entry's
`rev` alone. So does any pull whose docs mirror or submodule update fails: it
leaves its revision marker for the retry, but the skills, rules and agents it
delivered are at the new revision. A full pull that holds skills or agents on a
namespace collision writes its revision as `rev` but keeps the entry's earlier
bases as push bases, since the held copies stay at them. Like a full pull, an
inherited pull already synced at the team's revision writes nothing (#823).

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
A `--dry-run` detection adopts nothing: `resolvePartitionDir(anchor, { dryRun })`
returns the directory that holds the data now (the legacy name, where adoption
would rename it) and rewrites no config.

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
- Only `init` / `pull` / `push` / `contribute`, and `import --from-mr`: the
  commands that write, and the two that queue learnings, which an unmigrated
  checkout would keep in its own `.teamai/` (#808). `import`'s other modes leave
  the queue alone, and `import --cache-status --json` prints only its JSON.
  `contribute --scope user` (the user install's queue) and `import --from-mr
  --output` (drafts only) do not write this project's queue, so they do not
  migrate either.
  Read-only commands (`status`, `recall`, …) keep using the double-read fallback
  and never move data.
- `hook-dispatch` is excluded outright (via `TEAMAI_HOOK_SUBCOMMANDS`): it is a
  high-frequency silent path and must never move 12 MB.
- `--dry-run` (the existing global flag) previews without writing.

**Gate** (`planMigration`, deliberately NOT `detectProjectConfig` — that
short-circuits on an existing partition and runs the self-heal bootstrap as a side
effect, both of which would mask the raw legacy state). Act iff:
- in a git repo (the partition only exists for git repos), AND
- `<workspaceRoot>/.teamai/config.yaml` exists (self mode falls back to the
  partition's, see below), AND
- the legacy config is `scope: project` (user data never lives under `.teamai/`).

A `kind: self` config plans **mode `self`** whenever any entry the self migration
takes out (the machine data, the old queue, the old shared search index) is still
in the checkout's `.teamai/`. That `.teamai/` is team knowledge committed to main,
so it is never copied whole or renamed: the self migration moves only those
entries into the partition (see P2 below). Self mode reads its scope and kind
from the partition's `config.yaml` when the checkout's is gone, so a relocation
interrupted after the config moved still finishes. A partition `config.yaml` that
exists but that detection cannot read plans nothing, with a warning naming the
file, as for the other kinds below: the checkout's config is the only one that
still loads, and nothing leaves the checkout until the member fixes that file.

For any other kind, the plan's **mode** then depends on the partition: a full copy when
`<partition>/config.yaml` does not exist yet, or **retire-only** when it exists and
detection can read it (a prior run built the partition but was interrupted before
retiring the source — see Interrupt recovery). retire-only never re-copies onto the
authoritative partition; it only cleans up the leftover legacy dir, after settling
its queue by the partition's config (settleCheckoutQueue, below): into the partition
queue, or set aside, never into `.teamai.bak`, which a removed linked worktree takes
with it. A queue that cannot move keeps the legacy dir (`'skipped'`), so
`contribute` and `import --from-mr` stop on it and the next run tries again. A partition
`config.yaml` that exists but that detection cannot read (it is empty or cannot be
opened, does not parse, does not validate, or is not `scope: project`) plans nothing:
the legacy dir holds the only config that still loads, so it stays in place (a warning
names the file) until the member fixes the partition file, and the next write command
then gets the retire-only cleanup. A partition dir with no `config.yaml` at all (say,
one moved aside by hand) plans nothing either, with a warning: the full copy replaces
the whole dir, so it would take that dir's data with it. The full copy's re-check under
the lock in `runMigration` applies the same rules, warning and queue included.

A readable self partition over a legacy dir that holds self knowledge (a
`teamai.yaml` with `mode: self`) plans **superseded** instead of retire-only:
another checkout ran `init --self`, and this one checked out what it committed
next to its old install, so retiring the whole dir would take the knowledge too
(#808). Its machine entries (`SUPERSEDED_ENTRIES`: state, token, the `env` file,
the team-repo clone, indexes, report and usage data) move to a new
`.teamai.bak[.N]` with its own `.gitignore` (`*`), as step 5 keeps a retired dir;
the knowledge stays. Then its queue is set aside as `pending-learnings.<old kind>`
(settleCheckoutQueue, below), and only then does `config.yaml` follow: it is what
tells the next run the queue is the old install's. A learning still queued at that
point (a `contribute` from a teamai older than the queue lock, below, running
beside the migration) keeps it in place (`'skipped'`), as retire-only keeps its dir. A move that fails partway leaves it in
place too. Either way the next run plans superseded again and moves what is left
(into the next free `.teamai.bak.N`). With the legacy config
gone, the next run plans the self branch, which finds nothing left to move.

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
still present; the next write command's `planMigration` sees "readable partition AND
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
…)` call sites do not change. Learnings themselves left the default branch in
issue #485: new ones are written to `learnings-wt/` (the `teamai-learnings`
branch) and queued in `pending-learnings/` until they are published, while the
learnings already on main are read from where they are. Where those two live is
in "Self mode and linked worktrees (#808)" below; only the disposable
`knowledge-wt/` (a detached checkout for knowledge PRs, removed after each use)
stays in the checkout's `.teamai/`.

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
  compat) until migration relocates it. A `--dry-run` detection
  (`roles set`, `tags subscribe`, `tags unsubscribe`) previews the bootstrap
  instead (`previewSelfBootstrap`): it builds the config it would write, keeps it
  in memory, and prints `[dry-run] Would bootstrap ...` without locking, writing,
  injecting hooks or registering the member. It makes no provider auth call
  either (a stale token can send `authenticate()` into an interactive login), so
  the preview names the provider but not the username.
- **migration** (`migrate.ts`, `mode: 'self'`): self CANNOT use the git-mode whole
  directory copy→rename (that would carry the knowledge off and rename `.teamai` to
  `.bak`, breaking "knowledge on main"). Instead it selectively relocates the A1
  whitelist (config.yaml, state.json, env.local, env.sh, managed-mcp.json,
  workspaces/) entry-by-entry, destination-first (copy to the
  partition, then delete the source), leaving class-B knowledge and the worktrees
  untouched and never renaming `.teamai/`. self `repo.localPath` is NOT rebased —
  it must keep pointing at the in-repo knowledge. It also drains the checkout's
  queue (`pending-learnings/`, see #808 below), and deletes the old shared
  `search-index.json` instead of moving it: self mode keeps one index per
  checkout under `workspaces/<id>/` and rebuilds it.

Acceptance: after slimming, `git status` is clean (the A1 data is physically gone,
not merely ignored) and a teammate's fresh clone bootstraps into the partition.

### Self mode and linked worktrees (#808)

Git checks a branch out in one worktree only. Self mode used to derive the
`teamai-learnings` and `teamai-reports` checkouts, and the queue, from
`localPath`, which is re-anchored to each checkout's `.teamai/`. So the first
checkout to create a side-branch checkout owned the branch, every other checkout
of the repo failed with `'teamai-learnings' is already used by worktree`, and a
learning queued in a linked worktree was deleted with it (its `.teamai/` is
ignored, so a plain `git worktree remove` takes it). The partition is shared by
every checkout, so that is where they live now:

```text
~/.teamai/projects/<slug>/                     one per project, every checkout
├── learnings-wt/                              getWorktreeDir → <dataHome>/<dirname>
├── reports-wt/                                (the side-branch locks sit beside them)
├── pending-learnings/                         pendingLearningsDir → <dataHome>/pending-learnings
└── workspaces/<managedMcpWorkspaceId(root)>/
    └── search-index.json                      getProjectSearchIndexPath, one per checkout
<checkout>/.teamai/                            one per checkout: committed knowledge, knowledge-wt/
```

`git worktree add` takes a path outside the repo, and the owning repo is still
the business repo, whose refs every checkout shares. The search index is keyed
per checkout, like managed MCP, because each checkout indexes its own branch's
docs, rules and skills; a shared index served whichever checkout rebuilt it last,
with paths into that checkout. The learnings they index are shared, though, so
when `contribute` or `pull` rebuilds one checkout's index it deletes the other
checkouts' `workspaces/*/search-index.json` in the partition, and each rebuilds
from its own roots on its next `recall`. Git and http mode keep their paths:
their checkouts and queue already sat beside the shared clone.

Upgrading from the per-checkout layout:

- **Queue.** The self migration (`init` / `pull` / `push` / `contribute` /
  `import --from-mr`, above) moves each
  file of `<checkout>/.teamai/pending-learnings/` into the partition queue,
  atomically, never overwriting: a file with the same content there is the one
  already moved, and one with different content stays in place with a warning.
  The partition's config decides, not the checkout's: after `init` switched the
  project to another kind from another checkout, a checkout that has not
  migrated still says `kind: self`, and its queue would publish to the new
  repository. It is set aside instead, as a mode switch does (below), to
  `pending-learnings.self` beside the partition queue, with a warning naming
  it; `contribute` and `import --from-mr` take the same step before they queue.
  A queue with no `config.yaml` beside it is one an older self install left
  after its config had moved to the partition; once the project serves another
  install no plan covers it, so every migrating command sets it aside the same
  way, as the self install's. Beside a legacy `config.yaml` that cannot be read
  it stays, with a warning naming that file.
  A superseded git install's queue goes to `pending-learnings.git` the same way,
  and a git or http checkout's queue takes the same step before retire-only
  retires the rest. A queue is the partition's only when both installs have the
  same kind and team repository (#823 item 13, below): a checkout's git install
  of another team repository has its queue set aside as
  `pending-learnings.git-<repo>`. While the partition config cannot be read, the self
  migration keeps everything in the checkout, queue included, with a warning.
  Likewise, whenever a learning is still in the checkout's queue once it was
  settled (the queue lock was busy, or one was queued meanwhile), the self
  migration relocates nothing and reports `skipped`, keeping `config.yaml`, as
  retire-only and superseded do: the next run settles it.
  It runs per checkout; the old directory is the "not done yet" marker.
  After the migration, `contribute` and `import --from-mr` stop with exit code 1
  and save nothing whenever a learning queued now would still be kept in the
  checkout's `.teamai/` (`queueKeptInCheckout`): the migration stood down on the
  checkout's busy `.teamai/.sync-lock`, the data home is still that directory
  because the partition has no config detection can read, or an old queue there
  could not move. The message names the cause and the next step. `init`
  (except `--scope user`) stops the same way, before it writes anything: it
  would set the project up and leave that queue for `git worktree remove` to
  delete. A linked worktree that only ever contributes or imports does not
  take a learning with it when removed.
- **Queue lock (#823 item 11).** A command loads its config long before it
  queues, and in between the migration can move that config (it retires the
  checkout's `.teamai/`, or relocates `config.yaml`) or `init` can switch the
  project's kind or team repository. Queue writes (`savePendingLearning`, which `contribute` and
  `import --from-mr` both use), the migration and the kind switch therefore
  share one lock per queue home, the directory holding `pending-learnings/`:
  `~/.teamai/locks/queue-<first 16 hex of sha256(realpath(home))>.lock`. It
  lives outside the home because the migration renames a checkout's
  `.teamai/`, and a writer waiting on a lock inside it would create the
  directory again; the sync lock is not reused because git pulls hold it for
  their whole run. A write holds the lock only around the file write: under
  it, it re-reads `<dataHome>/config.yaml` and saves nothing when that file is
  gone, cannot be read or names another kind or team repository (`changed`).
  The migration holds
  the checkout's lock from after its sync lock to the end, through the rename
  or the last `config.yaml` move; `settleCheckoutQueue` holds the partition's
  around reading its install and moving the queue; `init` holds it around setting
  the queue aside and saving the new config. The publish lists the queue under
  the same lock and check, so a command whose install changed publishes
  nothing: the learnings stay for the install they were written for. Waits
  are bounded (30 x 100 ms): a write then exits 1 with `Another teamai command
  is moving this project's queued learnings (...). Nothing was saved.`, the
  migration returns `busy`, and `init` exits 1 without saving the new config. Locks are
  taken in the order sync lock, checkout queue lock, partition queue lock, and
  a queue write holds no other lock. A teamai older than this takes no queue
  lock, so its `contribute` beside a migration can still leave a learning in
  `.teamai.bak`.
- **Old checkouts.** Registrations are shared by every checkout, and one left in
  any checkout's `.teamai/` blocks the shared one from all of them, so the
  migration cannot wait for a pull in the right checkout. `ensureWorktree`
  handles it on its cold path, just before `git worktree add`: for every
  registration of the same branch at a path ending in `/.teamai/<dirname>`, it
  runs `git worktree remove` without `--force`. A clean one goes (its commits
  are on the branch, which the new checkout reuses), so a `contribute` in a
  linked worktree works with no pull first. One with uncommitted changes stays:
  the side-branch step fails with an error naming the path and the next step
  (commit or move the changes, or delete the path by hand), and the queue keeps
  the learnings until then. The error is also printed as a warning, because
  several callers treat a side-branch failure as non-fatal and log it at debug
  only; a silent (hook) run prints nothing. `refresh` does not swallow it:
  `recall maintenance` and `recall promote` stop with exit code 1 and write
  nothing, since the shared checkout they would write into does not exist and
  the next publish would clear what they wrote there as a stale directory. Any
  other failure to create or sync the checkout (`git worktree add` refusing a
  branch checked out at a path teamai does not know, say) makes `refresh`
  return `failed` with the cause: readers use what is there, and maintenance
  and promote stop the same way, naming the cause.
- **Lock.** Every checkout of the repo now shares each side-branch checkout
  and its lock. A `refresh` that cannot take the lock (held, or not creatable)
  checks nothing and never creates, prunes or removes a checkout, which may be
  the holder's work in progress; it returns `busy` with the lock path, and a
  reader (`members`, `projects members`, `digest`, `pull`, `stats` and `viz`,
  through `readableReportsWorktree`) uses the local copy and never ensures it,
  after the same ownership probe as `indexableVotesDir` (below): another
  repository's copy is refused with `ForeignCheckoutError`. The
  checkout there may be another repository's, or not created yet, so
  `recall maintenance` and `recall promote` stop with exit code 1 and write
  nothing when either the reports lock (they rank by its votes) or the
  learnings lock is taken; the error names the lock and says to run the command
  again, or to check that the partition is writable.

A git-mode install keeps the same checkouts and queue at the same partition
paths (beside `<partition>/team-repo`), so after a project switches mode the
checkout there may belong to the other repository. `ensureWorktree` accepts an
existing checkout only when its `git rev-parse --git-common-dir`, resolved,
matches the owning repo's. Otherwise it fails with an error naming the checkout,
the repository it belongs to and the command that removes it
(`git -C <owner> worktree remove <checkout>`); it never removes it itself. A
checkout git cannot open (`rev-parse` fails) is recreated only while the owning
repo still registers it: its `.git` file names a gitdir whose `commondir` leads
to the owning repo's git dir. A gitdir without it proves nothing: git pruned the
registration, and a clone at the same path (the clone was deleted and cloned
again, as `init` does when it switches to another team repository) is not the
repository the checkout came from. That checkout, and any other path with a
`.git` (one whose repository was moved or deleted, or a `.git` directory), is refused with
the same error type, saying teamai cannot show whose it is, and is never
removed; a path with no `.git` (a partial leftover) is cleared as before. The
refusal is a `ForeignCheckoutError`, which `refresh` does not swallow either,
because every path under the checkout is the other install's:
`recall maintenance` and `recall promote` stop with exit code 1 instead of
rewriting that team's learnings, and `members` and `projects members` stop the
same way on another repository's reports checkout. Every search-index build
(`pull`, `contribute`, and `recall` when it has no index) builds from
`indexableLearningsRoots`, which probes ownership and leaves out only that
checkout's learnings: the queue, docs, rules, skills and older learnings stay
recallable, and a plain `recall` runs no git. `digest` and the dashboard (`viz`:
its throwaway index and its promotion and prune candidates) use the same roots.
Those builds, and the reports checkout `teamai recall feedback --negative` counts
the team's upvotes from, take the votes directory from `indexableVotesDir`,
which runs the same probe on the reports checkout: another repository's votes
are left out, so no learning of this project carries that team's hotness.
The recall hook's vote judge, which starts no git process, reads the same answer
from git's files: the checkout's `.git` file names its gitdir, whose `commondir`
leads to the owning repository's git dir, compared (realpath'd) with this
project's. When they differ, or either cannot be read (a gitdir without
`commondir` included), the checkout's roots
leave the judge's allowed read roots; a path with no `.git` is judged as before.

The queue is the same partition directory in both modes, and its learnings were
written for the previous install's repository. A queue's owner is its install's
kind and team repository (`repo.remote`, compared as `remotesMatch` compares
remotes: credentials, protocol, scp or URL form, a trailing `.git` or `/` and
case do not count; #823 item 13). When `init` changes the owner with learnings
still queued, it moves the queue, under the queue lock and together with saving
the new config (above), to `pending-learnings.<previous kind>`, or
`pending-learnings.<kind>-<repo>` when only the team repository changed (`<repo>`
is the compared form of the previous remote with `/` and the like as `-`, e.g.
`pending-learnings.git-github.com-org-team-a`), beside it (the first free name,
nothing is overwritten) and says how many learnings it set aside and where;
nothing is published to the new repository or deleted. A previous config that
exists but cannot be read names no owner: the loaders return null for it as for
a fresh install, so `init` checks for the file, and with learnings queued moves
them to `pending-learnings.unknown` the same way, the warning naming that config;
queued or not, it drops the search indexes, as on an owner change.
A self install whose
business repository moved to another URL (renamed or transferred) is another
owner too: `init` sets its queue aside, and the warning names the directory to
move the files back from. It also deletes every search index
in the data home (the root one and each `workspaces/*/`): they were built from
the other repository, and `recall` rebuilds a missing index. `uninstall` lists, before it asks,
how many unpublished learnings each queue in the data home holds, set-aside ones
included, so the member can publish or copy them first.

Every checkout keeps its `workspaces/<id>/` (search index, managed MCP,
resource cache) in the shared data home. A full `pull` removes those of
checkouts `git worktree list` no longer shows; the fast path does not list
worktrees.

`import --from-mr` queues its learning in `pendingLearningsDir` and publishes
it as `contribute` does (#823), so in self mode it lands in the partition queue
and needs no checkout before the extraction. Its possible-duplicate check reads
the queue and `indexableLearningsRoots`, with the active project namespaces,
never another repository's checkout.

The self migration that moves queued learnings into the partition drops every
checkout's `workspaces/*/search-index.json`: none of them has the moved
learnings, and `recall` rebuilds a missing index. It drops them whenever a
learning ends up in the partition queue, including one an interrupted run had
already moved there, so a retry after a crash does not leave them stale.

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
the getters still return `~/.teamai/...`, unchanged, except
`getUserVotesDir()` (below). The project-scoped equivalents
already route through `getDataHome()`. Skill usage moved there too (#748):
`usage.jsonl` lives in each scope's `getDataHome()`, because one shared file let a
project's report carry every project's skills. The user scope records in
`~/.teamai/user-usage.jsonl`, not that old shared `~/.teamai/usage.jsonl`, which
an earlier release still writes after a rollback; the shared file is never
read. Local votes followed for the same reason (#787): `<dataHome>/votes/`, and
`~/.teamai/user-votes/` (`getUserVotesDir()`) for the user scope, so a scope
pushes only the votes cast where it is set up. The old shared `~/.teamai/votes/`
is never read, and its pending deltas are not pushed. The dashboard stays an A2
singleton: `teamai dashboard`, `session save` and the contribute check read
across scopes; `stats --by-repo` reads only the current scope's events, as the
rest of `stats` does (#795). Each event instead
carries `dataHomeKey`, a hash of the realpath'd `getDataHome()` of the scope the
hook resolved (#785; a hash, so a Copilot event still stores no path), and a
scope's report keeps the sessions whose first keyed event is its own, whole: a
Stop carries the whole transcript's totals, so a session that moved scope (a `cd`
mid-session) is reported once, where it started. A tool's own session ID is one
session whatever ends it records: `claude --resume` continues it, in a new
process, and its Stop carries the whole transcript. A fallback ID (`pid-…`;
Copilot's is the parent PID) names one run up to its `session_end` or
`process_exit`, so a later run that reuses it is decided on its own; a second end with nothing
recorded since the first (the dashboard monitor's `process_exit` after
`SessionEnd`) belongs to the run it closed. A `session_start` on a fallback ID
(`pid-…`) whose `monitorPid` differs from its open run's begins a new run even
though nothing ended that one (a crash with no dashboard running), and that one
counts as the run closed before it; a tool's own
ID is not split this way, since Claude fires SessionStart again on resume, in a
new process, and its Stop carries the whole transcript. The monitor's `process_exit` also
records `processExitAfter`, the last event it observed, and closes only that
run: an exit appended after the next run of the same ID began does not end it,
and one whose run compaction dropped is ignored. A dashboard started before
that field existed writes none. A dead process records nothing more, so such
an exit followed by more events of its fallback ID before the next start did
not end the open run: it belongs to the run closed before it, however late it
was appended. A tool's own session ID is
reported and snapshotted under the ID itself, as before, so a session resumed
after compaction dropped its events still reads what its scope reported. The
scope that first reports it also appends the ID and its own data home key to
`~/.teamai/dashboard/session-owners.jsonl` (never a path, #666), and a session
recorded there is that scope's wherever it is resumed later, whatever the log
still holds, so another scope never reports its transcript again; the first
line for an ID wins, and the file grows by one line per such session, like the
snapshots. An earlier release kept only per-scope snapshots, so the file is
first written from them: a tool's own ID is the scope's whose snapshots show it
reported it with the greatest total (prompts, then tokens). They show it when the
shared snapshots (all three) hold none of it, or the scope is past their total:
that release copied the shared file into every scope it ran in, so a copy, even
the only one, shows nothing, and a tie names no owner. When several scopes
reported it (a session that release split per event), the owner's line also
carries the credit of their parts, applied once as its baseline: a part whose
daily entry shows it ended in a Stop holds the transcript's cumulative total, so
the greatest such part counts once, while a part with no Stop counted its own
prompts, which add; interruptions, rejections and tokens, from Stops, take the
greatest, and corrections, counted per prompt, add. Whether a part with no
Stop came before another's cumulative Stop, which already counts it, is read
from the session's transcript when it has one (Claude): it keeps every prompt
in order with the directory it was typed in, so the Stop covers the first
prompts and only the part's prompts after those add. With no transcript to
place them they all add, which undercounts once but never sends a prompt again. The scopes read are the
user scope, every partition, and a project whose data home is in its workspace
that a session still in the log leads to; each report also records the IDs of
its own snapshots that have no owner yet and show it reported them (absent from
the shared snapshot, or past its total there). A session none of these reach
(a project whose data home is in its workspace, with no event left in the log)
is found by its transcript: hooks record `transcriptPath` on UserPromptSubmit,
Stop and SessionEnd (not SessionStart, whose path on a resume from another
project names a file that never exists; never Copilot's), and a Claude
transcript keeps its first `cwd` when resumed elsewhere, as a Codex rollout
keeps its `session_meta` and Copilot's own session log, found by the session ID
without storing its path, its `session.start` context. So a tool's own session
with no owner is the scope's that directory resolves to, when that scope's
snapshots already hold it; else it is decided as before (a fork under a new ID,
a tool whose transcript records no start). A session main split across scopes
per event, whose events are still in the log with each part's `dataHome`, is
credited once with every part reported: for each scope, the shortest prefix of
its events whose metrics reach its snapshot, and the owner's entry is raised,
counter by counter, to at least the metrics of their union (a part may have
reported more time, tokens or costs with no more prompts), so parts counted before
any Stop carried the transcript's total are neither lost nor sent twice.
A Codex session (any Codex variant: `codex`, `codex-internal`, `tcodex`) is kept
per rollout, with or without a token record, and when
its tokens come from a thread-level counter that already spans rollouts (then
no rollout holds tokens of its own, nor does the prior rollout an entry from
before leaves); a rollout's prompts are its Stop's count or
else its submits. A
rollout's counters restart, and compaction drops its events, so its prompt-token
entry holds each rollout's reported prompts, tokens, interruptions, rejections,
corrections, active time and request costs under a hash of the rollout's path,
written with any delta, and whether it failed (an error, an interruption or a
correction). The session's daily request costs sum its rollouts in the log. A
rollout compaction has dropped keeps those totals in the session's prompt-token,
intervention and daily sums (cache tokens from its tokens), and a failed one
keeps the session unsuccessful, so a later rollout is reported in full and does
not turn it into a success. An entry
written before rollouts were kept is one total: an earlier release rewrote every
session in the log on each report, so it covers the rollouts begun by the time
its file was last written, or, earlier, when that report wrote the team stats
file in this scope's reports checkout (after reading the log, before its push;
the snapshot came after the push). That is read before this report writes
anything; a seed keeps the
shared file's time, and `teamai stats`, which only reads, writes no seed). Those still in
the log consume it in order, as far as each had got by that time, what is left is the dropped rollouts', kept as one
prior rollout, and a rollout begun later is new.
Compaction also keeps a session whose tool process is still running, so a run
an exit from a dashboard before `processExitAfter` marked stopped keeps its
start, and its ID. A
fallback run is reported and snapshotted as `<id>@<first event's timestamp>`,
which does not change when compaction drops earlier runs. A snapshot entry keyed
by a bare fallback ID (written before) is the sum of the runs of that ID in the
log at the earlier release's last report, and compaction keeps or drops the
runs of an ID together. So the next time the scope reports, those runs consume
the entry in log order, each taking up to its own totals of what is left; once
the prompt-token entry is used up, the later runs were not reported and count
as new sessions (the interventions and daily snapshots follow the prompt-token
one, since their counts say nothing when they run out). A run keeps its own
success and correction flags, since the sum's are no single run's, so an
adopted run changes no status total. The first run always
takes a share, as the entry means that release reported it. The entry is then
removed, so no later run of that ID reads it. Only an earlier release wrote bare
entries, and a seeded one may be another scope's, so a run whose first event
carries `dataHomeKey` (recorded by this release), and every later run of its ID,
takes none. A session written before that field existed is attributed by its first
`cwd`: to the scope `resolveConfigForDir` resolves that directory to now, the
dispatcher's rule, so a nested clone under a project is not the project's; no
`cwd`, or one removed since, is no scope's. Inside git an event also carries `projectAnchor`, the repo's
main checkout, which all of its worktrees share (#809); a Copilot event, with no
`cwd`, carries none. `stats --by-repo`,
`session save` and the dashboard's Repository filter key a session by the last
anchor it recorded, else by its `cwd`, and the dashboard gives an event to the
project rooted at its anchor, so a worktree counts as its repo, also after it
is removed. A hook whose `cwd` no longer exists (a session that outlives its
worktree) would resolve to the user scope, or be dropped without one, so it
keeps the scope its session last recorded instead (#810): the config at that
event's `projectAnchor` (for a bare repo, at one of its worktrees that still
exists), used only while the key of its `getDataHome()` is still the recorded
`dataHomeKey`. Its events and skill uses stay with the project, and the share
reminder's gate reads the project too. A project config there that
cannot be read records nothing, and with nothing recorded to match the hook
resolves from its `cwd` as before. The recorded scope is read from `events.jsonl`, so it lasts as long
as the session's earlier events do (compaction keeps only active sessions),
and Copilot, whose events record no directory, has none to recover.
The snapshots of what was already reported are per scope
too (#786), because a session ID can recur in another scope (Copilot's fallback
ID is the parent PID):
`<dataHome>/dashboard/reported-*.json`, and `~/.teamai/dashboard/user-reported-*.json`
for the user scope. The first time a scope needs one it seeds it from the shared
`~/.teamai/dashboard/reported-*.json`, so nothing reported before the upgrade is
sent again; after that it reads only its own. That file summed every scope's
runs of an ID, so the runs of the whole log consume it in log order, whichever
scope each belongs to, and the seed keeps the shares of the scope's own runs,
under their run IDs; none goes to a run recorded
with a `dataHome` path: that release already kept per-scope snapshots, so a
shared entry under its ID is another scope's. An unmatched fallback entry is
dropped, so a later reuse of the PID cannot inherit it; a tool's own session ID
is copied whole, as before, so a session resumed after compaction dropped its
events is not sent again. The shared file is no longer
written, except by an earlier release after a rollback, so every scope seeds from
what the machine had reported by then, never from another scope's later report.
The seed holds a session's whole total, so a session still running at the
upgrade goes on from the reported total, as before.

Every writer of `events.jsonl` — each hook's append and the periodic
compaction — takes `events.jsonl.lock` beside it (#804), the pattern the usage
file took for the same lost update (#803): compaction's
read → filter → temp-file → rename cannot drop an append that lands while it
runs, and two compactions cannot interleave their rewrites. A hook append waits
up to ~250 ms, inside its foreground budget, and one that gives up records its
line in an `events.pending-<uuid>.jsonl` side file, with the file's mode, that
the next lock holder folds into the file before it writes — so an event is
late, never gone. The line carries a `pendingId`, so a fold never appends a
side file twice (a holder that died after appending it but before removing it
leaves it for the next one), two side files of identical events are both kept,
and no reader and no compacted file keeps the id: `readEventsRaw` drops it, and
a compaction rewrites the line without it. A side file without its trailing
newline is still being written and waits for the next holder. A compaction
waits up to ~5 s for a peer's rewrite, and skips — leaving the file as it is
for the next compaction — when a live holder outlasts the wait; a lock whose
owner is gone is reclaimed, and a rewrite's temp copy left by a killed
compaction (`events.jsonl.<pid>.<hex>.tmp`) is removed by the next one. The
side files and the lock live in `~/.teamai/dashboard/` beside the log, which
no repository tracks, so nothing needs adding to a workspace `.gitignore`.

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
