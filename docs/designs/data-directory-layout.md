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

## Cross-team source repository caches

Git source clones live at `~/.teamai/source-repos/<sha256(repo.trim())>/repo/`. All aliases of the same URL share this clone, revision, and pull TTL under the source lifecycle mutex, so an older alias cannot overwrite refreshed shared content. Their sibling `last-pull.json` records successful clone/pull time for the 24-hour TTL, independent of installation manifests. Failed pulls retain only that repository's cached clone and do not advance its timestamp. `source add`, `browse`, `list`, and `pull` all resolve this same repository identity. Removal retains repository caches because other installations may still use them; older alias-scoped and name-only clones are neither adopted nor deleted. URL material is hashed rather than placed directly in cache paths.

## Cross-team source installation ownership

Installation manifests live at `~/.teamai/sources/<name>/installations/<sha256([destinationRoot, teamCheckout])>.json`. The identity uses absolute paths from `resolveBaseDir(localConfig)` and `localConfig.repo.localPath`; HOME, projects, worktrees, and separate team checkouts have independent records. New records also store `destinationRoot`, `teamCheckout`, and the repository URL hash (`repositoryId`) for physical-path coordination and manual review.

Pull plans all skill destinations before copying. A different or unidentified repository owning any overlapping physical target blocks that skill; installations of the same repository may share it. Existing copies from an unchanged repository survive a newly conflicting target. A conflicted repository replacement preserves its whole previous installation; a successful replacement records only newly deployed paths and releases old destinations. Dry-run checks the same conflicts without writing skills or installation manifests. The read-only destination resolver does not opportunistically delete identical Codex copies; previously recorded paths are reconciled during ownership-checked cleanup.

Stale cleanup and `source remove` release only the current record. Files remain while another active manifest owns the same canonical path or an overlapping parent/child path, including symlinked destinations. Foreign records only veto operations; they never authorize deletion. Removal retains caches and other records. If another destination already removed the subscription from a shared `teamai.yaml`, the current destination can still run `source remove <name>` using its scoped record without rewriting YAML. If an alias was re-added for a different repository, a stale or unidentified scoped installation authorizes only local cleanup; removal preserves the replacement subscription.

Local source tags use scoped provenance. Push also excludes skills whose current physical target belongs to another installation, and fails closed for skill publication when ownership tracking cannot be read safely. Legacy name-only `installed.json` files are never adopted as root/ownership evidence or deleted. Their names are conservatively excluded from push, with a warning naming the record; this can also hold back an unrelated same-named draft. Review and back up remaining deployed copies, and archive legacy tracking only after accounting for every affected destination; then pull active subscriptions to establish scoped records. There is no automatic destructive migration.

A missing or moved consumer checkout does not prove its deployed files are abandoned. Such records remain protective, and messages identify the owning manifest; new records retain the checkout path for review. Remove an installation from its original scope before moving/deleting its checkout when possible. Existing orphan records and legacy copies require manual review before retiring ownership; automatic orphan garbage collection is not implemented.

Git source add, browse/cache refresh, pull, and removal use the same machine-local lifecycle lock, re-reading state under it. A busy operation asks for a retry instead of bypassing another live owner; dry-run only checks lock state and reads existing caches, without cloning, pulling, or updating cache timestamps. Uncached previews report that skill contents cannot yet be inspected. Skill push is also withheld when a source transaction is active.

A successful source pull records only its current destinations and releases obsolete tool paths, including when the repository URL is unchanged. A valid source config with no `publicSkills`, an empty list, or no remaining published skill directories releases the previous installation. Files still owned by another installation remain protected; a missing or unreadable source config leaves the old installation untouched. Conflict-retained copies keep their previous records.

Public skill names and recorded skill identities must already be canonical (no normalization-changing segments, repeated separators, backslashes, or trailing slash), so alternate spellings cannot bypass team-skill priority. Canonical nested names also respect local-team and builtin skill directory ownership, including ancestor/descendant conflicts. When this protection leaves previous source files in place, pull/removal retains their scoped provenance and excludes their paths from push pending manual review; it does not silently adopt them as team content. Source removal preflights all foreign ownership records and deletion targets before editing shared configuration. 

Ownership records must contain safe relative skill names and non-empty relative descendant paths, or absolute paths inside a tool's home outside the project (Hermes, OpenClaw, Copilot; #993); root-equivalent, escaping, and other absolute paths stop cleanup before configuration or files are changed.

All accepted source aliases, including `.git`, `node_modules`, and names ending in `.pyc`, participate in ownership, provenance, and push checks; resource-directory filters never hide their tracking.

If any skill in a scoped record lacks non-empty recorded destinations, pull and source removal keep the entire installation unchanged and require manual review, including for the same repository and during previews. Current tool paths cannot prove historical deployment locations, so they never authorize inferred cleanup, overwrites, or replacement claims. Review and back up the original source copies and unrelated local files before manually retiring the ambiguous record; changing tool paths or retrying `source remove` does not resolve missing history. Ambiguous scoped claims are quarantined across checkouts, so another team sharing HOME cannot publish the retained source bytes. This can temporarily hide unrelated same-named drafts until the record is reviewed; complete modern pins remain path-specific. 

Older records with non-empty concrete plain paths remain supported. An ambiguous claim in another scoped installation or an unscoped legacy record also blocks source writes and cleanup for equal, parent, or child logical names before any mutation. Its warning identifies the record to review. This conservative name guard may block otherwise separate destinations because their historical location is unknown; it never invents deletion authority. Sources with unrelated names and complete recorded foreign paths retain their normal behavior.

After ownership preflight, source pull restores Codex's verified duplicate reconciliation: an unowned configured copy is removed only when it matches both the shared copy and incoming source. Different local copies, other installations, existing tracked paths, planned destinations, and repository inputs remain protected; dry-run never reconciles files. A symbolic-link skill root is copied as concrete contents only when it resolves to a child directory inside the source repository. Outside, dangling, or looping root aliases stop before deployment; ordinary in-repository aliases and tool-destination symlinks remain supported. Previously installed skill-root links retain their record and referent for manual review; a physical pin alone does not authorize deleting the link target. This does not migrate nested file symlinks.

Push excludes modern pinned source records by actual physical path only: an unrelated same-named local skill in another agent remains a candidate. Name-only quarantine is reserved for legacy or scoped records without complete physical ownership; malformed or incomplete pin metadata still stops skill push.

New scoped records pin each deployed path to its original physical destination, recorded after the copy. Before copying, withdrawing, or removing an existing installation, TeamAI checks every recorded destination; a changed, dangling, unreadable, or otherwise unverifiable symlink stops the operation before installed files, YAML, or the manifest change. Restore the original destination and retry, or manually review the retained files and record. Other installations protect the original pinned location, not a symlink's new target. Old scoped records without physical pins can authorize only explicitly recorded plain paths; existing symlinked paths (including symlinked roots) require manual review rather than guessed historical ownership. Newly installed stable symlink paths remain supported.

Canonical nested public names such as `group/child` remain supported. Pull refuses an ambiguous parent/child directory transition (including another installation of the same repository), or two distinct skill identities targeting the same physical directory, before copying any skill or changing the installation record. The warning requires manual review: back up the retained files, use `source remove` in the affected installation(s), then pull the new publication. When a retained parent contains another source's child directory, its own provenance also remains until that child installation releases ownership; remove the child installation first, then retry removal of the parent. No automatic subtree migration is attempted. Disjoint destination moves and exact-path sharing by the same repository and skill remain supported.

Status and skill inspection identify nested source installations by their recorded physical paths, without assigning that provenance to unrelated same-named copies. If scoped provenance cannot be read, status/skill inspection warns that source labels are incomplete; a local-only label is not proof of local ownership.

Do not run source installation/removal and push concurrently. The source mutex serializes source mutations, but push does not retain it through its entire staging/publication transaction; full cross-command snapshot isolation remains a limitation.

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
checkout's own revision and tool targets all match. 

A worktree added after the
last pull therefore gets a full sync on its first pull, and two checkouts with
different tool directories no longer force a full sync on each other (#807).
The fast path also needs the entry's `gitExcludePaths`, what each writer of
the pull delivered into the checkout (the paths teamai's `delivered` git
exclude block lists, #915). An entry saved by an older CLI has none, so the
first pull after the upgrade is a full sync, whatever `sharing.gitExclude` says.
The block is the union of the `gitExcludePaths` of the live checkouts
(`liveCheckoutRecords`), less paths that hold a file outside another live
checkout's list; paths in another repository (a submodule, a nested clone, a tool
home under git) go to that repository's exclude file under `delivered/<id>`, the
partition's anchor hash. Skill writers (team, source, built-in, Codex's
`.agents/skills`, the local agent) report each file they wrote into a skill,
never its directory, which the git exclude module refuses to list, so a file
the member adds inside a delivered skill stays visible; a tracked file there
gets no line while the skill's other files keep theirs. The docs writer reports each doc file it wrote, never
an entry of the member's it kept nor a doc beneath one; with the mirror at
`<root>/.teamai/docs`, outside single-repo mode, the sync also keeps teamai's
block (`!/docs/**`) in `<root>/.teamai/.ignore` so ripgrep-based search finds
the excluded docs, and lists that file while the block is all it holds.
The `teamai-only` entry is judged anew on every pull,
fast path included, and replaces its previous list: the shared config files
teamai writes entries into (project MCP configs with no per-member place,
`.codex/hooks.json`, `.opencode/opencode.json`) that git does not track and that
hold only entries teamai's records own, so a file that takes in a member's entry
leaves the block on the next pull, which says so. On OpenCode V2 with teamai's
plugin current, the OpenCode MCP target is `.opencode/teamai-mcp.json` instead
(teamai's whole, always listed; its records carry `file`), and the pull takes
teamai's V1 entries out of the root `opencode.json` and `.opencode/opencode.json`
when git does not track them, keeping the member's entries there.
A `.codex/hooks.json` that is not teamai's alone (tracked, or holding a member's
entry; always in self mode) gets no team hooks while the flag is on: pull takes
teamai's entries out of it through its hook manifest and records the project's
Codex team hooks in `~/.teamai/codex-team-hooks.json` (machine-wide, keyed by the
main checkout, or by the checkout in self mode; locked by
`codex-team-hooks.json.lock`; a project whose directory is gone is dropped). The
same pull makes `~/.codex/hooks.json` hold one
`teamai hook-dispatch <Event> --tool codex --team-hooks` entry per event any
recorded project has hooks for, with the largest timeout, before the built-ins;
at run time it resolves the project from the hook's `cwd` and runs that
project's hooks from the index.
`state.gitExcludeFiles` records, per owner, the exclude
files holding its block. A pull nobody watches (session start, git hooks) keeps
what it could not say about the block in `<dataHome>/git-exclude-notices.json`:
its last failure to update it (cleared by the next update that succeeds) and
notices the next interactive pull says once and drops; `doctor` reads both.
`pull --dry-run` previews the block from what its writers would write, writing
nothing. A checkout whose config still loads from `<workspace>/.teamai/` (the
migration kept the legacy layout, or a dry run previews one) does not read its
member `gitExcludeEnabled`: each worktree of that layout has its own config, and
they share one exclude file, so only the team's setting or the default applies.
`uninstall` reads `state.gitExcludeFiles` before it deletes the
partition and, under the partition's sync lock, removes every teamai block
from those files once it has deleted the files they hid; `uninstall --agent`
filters the tool's paths out of every entry's `gitExcludePaths` and syncs again.
Clearing `lastPullRev` still forces a full sync, which is how exclude, tags,
roles, projects, init and bootstrap apply their changes: the pull that finds
`lastPullRev` cleared resets every other checkout's entry to an empty `rev`,
which matches no revision, so each checkout does its own full sync (an older
CLI compares `rev` too, so it also misses the fast path). A new team revision
resets nothing, since a checkout recorded at an older revision already misses
the fast path. 

`push` needs that entry too: before scanning, it syncs each rule
and skill the member never edited, and "never edited" means equal to the
version at a revision *this* checkout synced, not the shared `lastPullRev`
another checkout may have moved (#812). Rules of a tool with its own rules
format (every tool in `RULE_FORMATS`, `rule-format.ts`) compare bodies against those revisions, ignoring derived frontmatter,
and render refreshed copies in the tool's native format. Rule sync uses the same tool root as the
scanner, including `COPILOT_HOME` for user-scope Copilot instructions.
It checks `isAgentExcluded` before installation detection, so retained tool
directories do not authorize writes to rules excluded by the local configuration.


For Copilot updates that only change `paths`, it compares the entire local file
with the rendered recorded versions before refreshing `applyTo`, preserving
locally edited headers rather than overwriting them on a body match alone.
Each copy it writes, in any format, is recorded in the checkout's `delivered`
(#822), so the next pull does not keep it as the member's edit.
A placed agent, which push does not
sync, is held when the team file has changed since any of those revisions, or
since it was added if one of them predates it (#823). 

That sync brings the
unedited copies up
to the team repo, so when push has refreshed the team repo it adds the
revision it synced to the entry's `pushBaseRevs`, newest first, even under
`--dry-run`, since the sync has already written the files, and even when the
sync stopped partway (it warns), since the copies it did not reach still match
an older base. If push cannot save that revision, it stops before scanning and
pushes nothing. The next push
accepts a copy at any of `pushBaseRevs` or at `rev`, so a copy the sync left
alone as edited is recognized again once the member undoes the edit, back to
whichever version a sync gave it. 

The list keeps the 20 newest revisions; a
copy at an older one reads as an edit until the checkout pulls. Push never
moves the entry's `rev`: the pull fast path reads it, and the checkout still
lacks that revision's docs and agents. A reset entry keeps its bases, `rev`
included, in `pushBaseRevs`, and the next pull in the checkout rewrites the
entry without them. 

A checkout with no entry (new, or last pulled by an older
CLI) syncs against the shared `lastPullRev`, which may be another checkout's or
cleared, so when the scan lists a team rule or skill as modified, push stops
before creating a branch and asks the member to save any edits to them and run
`teamai pull` in the checkout. A rule this machine placed (`placedRules`) is the
author's own copy and does not count; config-only pushes and new resources go
through. 

Each project checkout's full sync records its `root` in its entry,
and every full sync drops the entries whose `root` is no longer a checkout of
the repository (it has no `.git`, or `git rev-parse --git-common-dir` there
names another common directory) or is one under another key, so a deleted or
re-created worktree's entry goes with the next full sync in any checkout. It
does not read `git worktree list`, which names the git directory instead of
the main checkout in a `--separate-git-dir` repo or a submodule (#993). An
entry an older CLI wrote without `root` is kept until its checkout's own full
sync adds one, and every entry is kept when git cannot name this checkout's
common directory. 

A
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
`rev` alone. So does any pull whose docs mirror or submodule update fails, or
that holds an agent whose model cannot be resolved (#830), a cause the member
may fix without a new team revision: it leaves its revision marker for the
retry, but the skills, rules and agents it delivered are at the new revision. 

A full pull that holds skills or agents on a
namespace collision writes its revision as `rev` but keeps the entry's earlier
bases as push bases, since the held copies stay at them. Like a full pull, an
inherited pull already synced at the team's revision writes nothing (#823).
The entry's `agentModels` records, by agent stem and tool, the model, effort
and resolution step each YAML agent copy received when pull last wrote it
(#830), and for an alias step the alias name, so a removed alias is noticed
even where it gave the tool no model. A copy pull keeps as the member's edit,
or holds because its model cannot be resolved, keeps its old entry. 

The fast
path compares each agent's current resolution with it and redeploys only the
agents that differ, through the same ledger, so HOME's entry and each project
checkout's are separate; a copy the ledger keeps as the member's edit is
named, as a full sync names it, and its entry kept. A missing copy is
delivered, entry or not. An agent with no entry is also redeployed where an
alias replaces its `model`, which is what an older CLI wrote as is, and where
its copy still has the bytes `delivered` records but not the current render (an
older CLI's render, such as Claude extras in a Qoder copy). 

Without a
`delivered` entry for the copy nothing tells that render from an edit, so it
is left alone.

Rules get the same treatment for a render change (#946): when a CLI upgrade
gives a tool its own rules format (a `RuleFormat` with `previousRenders`: Kiro,
Qoder, CodeBuddy, WorkBuddy, Oh My Pi, and JoyCode, which had Cursor's render), the fast
path rewrites each rule copy that still has the bytes `delivered` records but
is not the current render, records the new bytes, and of a copy without an
entry rewrites only one that is the team rule verbatim, which is what the older
CLI wrote. A copy the member changed is kept and named when teamai would now
deliver other bytes there. 

A destination that moved (WorkBuddy's project rules,
from `.workbuddy/rules` to `.codebuddy/rules`) has no entry at its new path, so
the fast path first reclaims the old copies (`LEGACY_RULE_DIRS`), writes the
new path where it is missing, and records the change. 

The flat names of Oh My Pi
and Kiro (`RuleFormat.flat`: `<ns>/<name>.md` became `<ns>.<name>.md`, in the
same directory) work the same
way through `movedFrom`: the copy at the old path is what lets the fast path
write the new one, with or without a `delivered` file; the old copy goes while
it has the recorded bytes or, with no entry, the team rule verbatim, and is
named otherwise, since the tool does not read it.

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
     removed by hand if a crash left it, and a warning names it. 

   A lock that vanished before it could be read gets one more
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
  Read-only commands (`status`, `recall`, …) never move data. They can still read
  a valid legacy project config through the double-read fallback, but an existing
  unreadable project config is not treated as absent: scope resolution stops
  with a config error instead of falling back to another project's or the user
  scope (#899).
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
interrupted after the config moved still finishes. 

A partition `config.yaml` that
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
`contribute` and `import --from-mr` stop on it and the next run tries again. 

A partition
`config.yaml` that exists but that detection cannot read (it is empty or cannot be
opened, does not parse, does not validate, or is not `scope: project`) plans nothing:
the legacy dir holds the only config that still loads, so it stays in place (a warning
names the file) until the member fixes the partition file, and the next write command
then gets the retire-only cleanup. A partition dir with no `config.yaml` at all (say,
one moved aside by hand) plans nothing either, with a warning: the full copy replaces
the whole dir, so it would take that dir's data with it. 

The full copy's re-check under
the lock in `runMigration` applies the same rules, warning and queue included.

A readable self partition over a legacy dir that holds self knowledge (a
`teamai.yaml` with `mode: self`) plans **superseded** instead of retire-only:
another checkout ran `init --self`, and this one checked out what it committed
next to its old install, so retiring the whole dir would take the knowledge too
(#808). Its machine entries (`SUPERSEDED_ENTRIES`: state, token, the `env` file,
the team-repo clone and its `last-fetch.json` stamp, indexes, report and usage data) move to a new
`.teamai.bak[.N]` with its own `.gitignore` (`*`), as step 5 keeps a retired dir;
the knowledge stays. 

Then its queue is set aside as `pending-learnings.<old kind>`
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
  compat) until migration relocates it. 

  A `--dry-run` detection (a command that
  forwards `--dry-run` to its loader, or a read-only one such as `status`, `list`,
  `doctor` or `mcp list`, which loads this way unconditionally) previews the bootstrap
  instead (`previewSelfBootstrap`): it builds the config it would write, keeps it
  in memory, and prints `[dry-run] Would bootstrap ...` without locking, writing,
  injecting hooks or registering the member. It makes no provider auth call
  either (a stale token can send `authenticate()` into an interactive login), so
  the preview names the provider but not the username. `init` detects with
  `selfHeal: false` (in its `preAction` queue check and in `initSelfRepo`): it
  sets the project up itself, and a self-heal there would enable every tool in
  HOME before `--agent` chose them (#993).
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
├── managed-main-checkout-hooks.json           team hooks teamai wrote ungated into the main checkout's Claude Code / Codex
│                                              settings, shared by every checkout (#955; the built-in hooks stay in HOME)
│                                              project toolPaths choose the files; Claude uses settings.local.json beside its settings file
│                                              Codex records event, matcher-group position and complete rendered entry; unique definitions recover moved entries
│                                              legacy ownership matches event/matcher/command uniquely, ignoring unrecorded timeout/context options
│                                              pre-#370 Codex ownership is imported from <main>/.teamai/managed-hooks.json before reconcile/removal
│                                              an un-migrated linked worktree injects through the main checkout's copy (<main>/.teamai when the main checkout
│                                              has no install), importing then retiring the records v0.22.0 kept in each linked checkout's data home; checkouts registered in the
│                                              manifest share ownership so removal keeps the shared entries until the last checkout removes them (#373)
│                                              registration is per tool; targeted uninstall releases only that tool and keeps the remaining tools' records
│                                              discovery respects enabledAgents/disabledAgents; excluded tools do not retain another checkout's shared hook
│                                              a shared partition config registers its linked worktrees even without checkout-local configs or prior hook injection
│                                              removing a legacy Codex copy shifts surviving checkout records only after matching their full entry at the old position
│                                              uninstall of a shared partition removes the selected tool's hooks and registrations for that whole installation before deleting its authority
│                                              the synthetic main-checkout manifest and empty .teamai directory go only after the last hook record is removed
│                                              uninstall also retires selected tool records for missing hook files after their last checkout releases ownership
│                                              removal releases one Claude entry per record, so an identical copy another checkout records stays
├── teamai.lock                                packageLockDir: installed package versions (#993; an older <root>/.teamai/teamai.lock is moved here, or copied while git tracks it,
│                                              and a <root>/.teamai/.gitignore holding only `teamai.lock` is removed outside self mode)
└── workspaces/<managedMcpWorkspaceId(root)>/
    ├── root                                   the checkout's path, written by its full pulls; liveness is probed from it (#993)
    ├── managed-hooks.json                     getManagedHooksPath: team hooks teamai wrote into this checkout's own hook files (Copilot's
    │                                          .github/hooks/; every tool in self mode). Until #993 it sat in <root>/.teamai/: the first pull
    │                                          moves its Copilot records (all of them in self mode), and deletes it once empty and untracked;
    │                                          doctor names a tracked one. Other records stay there for the pre-#370 import and legacy sweep.
    │                                          Self mode with sharing.gitExclude on: Claude's records describe .claude/settings.local.json, the
    │                                          tracked settings.json keeps only the built-ins; off, they describe settings.json again (#915)
    ├── managed-main-checkout-hooks.json       bare repositories only: this workspace owns its Claude / Codex team-hook files and trust target, without sibling registrations
    ├── managed-mcp.json                       managedMcpManifestPath, one per checkout; Copilot placement is true for bare, false for keyed, absent when unproven
    ├── managed-mcp-files.json                 resolvedMcpFilesPath: project MCP configs teamai may have written a resolved ${VAR} to, and whether
    │                                          the paths earlier teamai.yaml revisions mapped were read; one of those git tracks is marked tracked (#882);
    │                                          for an HTTP team, the configs the local agent wrote a credential to
    └── search-index.json                      getProjectSearchIndexPath, one per checkout
<checkout>/.teamai/                            one per checkout: committed knowledge, knowledge-wt/
```

MCP configs and ownership must describe the same completed writes. Existing
JSON local-agent installs keep the old record until the config write succeeds;
uninstall keeps it until the entry is removed. A later manifest-write failure
restores the previous config. Reconcile keeps one snapshot per config before
any tool writes it and restores those snapshots if saving ownership or a later
config write fails. File records added by that failed run are cleaned up before
Git protection is checked against the restored configs. If restoration also
fails, the command reports both failures and keeps credential files excluded.

For an HTTP workspace without project config, the resource cache and MCP records
remain under that workspace's `.teamai/`. With git exclude enabled, `local-agent`
lists its generated `.gitignore` and the existing MCP record files by exact path.
Member files stay visible, and tracked files are never excluded.

HTTP source removal keeps `~/.teamai/local-agent/config.json` as `{disabled:true}`,
without an endpoint or credentials, so legacy config and environment fallback
cannot reconnect. Failed agent-hook removals retain `agent-hooks.json` and report
exit code 1; removal can retry without an active source. So does
`git-exclude.json` while an exclude file it records still holds a teamai block
(one removal could not write, or the line of a copy it left on disk), so the
next removal or `teamai uninstall` finds it. HTTP initialization
replaces the disabled config to enable a source again.

Sync, detached plugin reconciliation and HTTP source removal share `~/.teamai/.local-agent-sync-lock`, outside the
cache directory cleanup. A user-scope `teamai uninstall` removes the source the same way before its other steps. A sync runs a server-pushed
`uninstall_teamai` command while it holds the lock, and passes it on: that
uninstall's process, the sync's child, neither waits for the lock nor releases it. Each reloads config after acquiring the lock. Removal
waits up to 30 seconds for the current operation, disables before teardown, and
reports failure without teardown if the lock cannot be acquired. A hook sync
skips while the lock is held; plugin reconciliation waits up to 30 seconds.

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
  it.


  A queue with no `config.yaml` beside it is one an older self install left
  after its config had moved to the partition; once the project serves another
  install no plan covers it, so every migrating command sets it aside the same
  way, as the self install's. Beside a legacy `config.yaml` that cannot be read
  it stays, with a warning naming that file.
  A superseded git install's queue goes to `pending-learnings.git` the same way,
  and a git or http checkout's queue takes the same step before retire-only
  retires the rest. 

  A queue is the partition's only when both installs have the
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
  `~/.teamai/locks/queue-<first 16 hex of sha256(realpath(home))>.lock`. 

  It
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
  migration returns `busy`, and `init` exits 1 without saving the new config. 

  Locks are
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
  linked worktree works with no pull first. 

  One with uncommitted changes stays:
  the side-branch step fails with an error naming the path and the next step
  (commit or move the changes, or delete the path by hand), and the queue keeps
  the learnings until then. What `import --from-mr` in 0.25.0 to 0.26.0-beta.3 left there is not
  such a change (#823 item 7): it wrote `learnings/<YYYY-MM-DD>-<title>.md` with
  `source_mr` in the frontmatter and never committed it. 

  `publishQueuedLearnings`
  first finds the branch's one registered checkout (`git worktree list` of the
  owning repo, so the shared one or the old `.teamai/<dirname>`, never another
  repository's), and queues each untracked file of exactly that shape, directly
  under `learnings/`, into the active namespace with `contribute`'s name, then
  deletes the original. A file the branch (any namespace) or the queue
  already has, by `source_mr` or by content, is deleted without queueing. The
  branch is the tree of `origin/teamai-learnings`, fetched first, never the
  checkout's tracked files: the old checkout is never synced again, so it may
  miss a teammate's later import of the same MR, or still track one origin has
  since deleted (#823 item 21). 

  When that fetch fails, every such file stays where it is
  until a run can fetch, so a stale ref never queues a duplicate; when
  `git ls-remote` shows origin has no such branch (an offline first publish
  never pushed it), origin adds nothing and the files are queued. A file of
  that shape that cannot be read is skipped, never holding back the rest. 

  The
  queue is read under the queue lock, and only while the data home's config
  still names the install the command loaded (`readPendingForInstall`, the
  check `listPendingForInstall` makes): after `init` switched the project to
  another team repository the queue holds that install's learnings, so while it
  does, or while the lock stays busy, every such file stays where it is. It runs only under the sync lock, before the queue is listed,
  and never on a dry run, which publishes nothing from the queue either and
  `pull` reports as `Would publish N queued learning(s)` (#823 item 20); any
  other file in the checkout is left alone. 

  The error is also printed as a warning, because
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
  repository's copy is refused with `ForeignCheckoutError`. 

  A refresh that
  failed is tried once more, under the lock, and a second failure throws its
  cause: a reader never creates the checkout without the lock, which a writer
  that took it meanwhile may be creating (#823 item 15). The
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
to the owning repo's git dir. 

A gitdir without it proves nothing: git pruned the
registration, and a clone at the same path (the clone was deleted and cloned
again, as `init` does when it switches to another team repository) is not the
repository the checkout came from. That checkout, and any other path with a
`.git` (one whose repository was moved or deleted, or a `.git` directory), is refused with
the same error type, saying teamai cannot show whose it is, and is never
removed; a path with no `.git` (a partial leftover) is cleared as before. 

The
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
With `recall feedback --dry-run`, config resolution stays read-only and the
command returns after previewing the requested feedback, before any vote read,
migration, lock, or reports-checkout probe. No vote count is predicted; ordinary
diagnostic logging still applies.
Negative feedback reads the team's votes without persisting a v1 → v2 upgrade there. A successful downvote is recorded in the scope's local votes and reaches the team's reports on sync.


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
case do not count; #823 item 13). 

When `init` changes the owner with learnings
still queued, it moves the queue, under the queue lock and together with saving
the new config (above), to `pending-learnings.<previous kind>`, or
`pending-learnings.<kind>-<repo>` when only the team repository changed (`<repo>`
is the compared form of the previous remote with `/` and the like as `-`, e.g.
`pending-learnings.git-github.com-org-team-a`), beside it (the first free name,
nothing is overwritten) and says how many learnings it set aside and where;
nothing is published to the new repository or deleted. 

A previous config that
exists but cannot be read names no owner: the loaders return null for it as for
a fresh install, so `init` checks for the file, and with learnings queued moves
them to `pending-learnings.unknown` the same way, the warning naming that config;
queued or not, it drops the search indexes, as on an owner change.


When `init` is about to clone another owner's team repository where the old
install's clone was, or reuses a clone of it that an earlier `init` left there,
it settles the old install right then, before the clone or the refresh,
the same way (queue set aside, indexes dropped), and moves the old
`config.yaml` to the first free `config.yaml.previous[.<n>]` instead of saving
(#823 item 17). The save at the end still compares with the old install
loaded before the clone, finds nothing left to set aside, and writes the new
config. 

An `init` that stops in between (an unknown `--role`, a busy queue lock, a
prompt left) leaves no config naming the old team beside the new clone, so every
command asks for `teamai init`; nothing is deleted. The rerun finds no
`config.yaml`, so it reads the last `config.yaml.previous[.<n>]` for the
settings a re-init carries forward (`inheritUserScope`, agents, tool roots).
A self install whose
business repository moved to another URL (renamed or transferred) is another
owner too: `init` sets its queue aside, and the warning names the directory to
move the files back from. 

It also deletes every search index
in the data home (the root one and each `workspaces/*/`): they were built from
the other repository, and `recall` rebuilds a missing index. `uninstall` lists, before it asks,
how many unpublished learnings each queue in the data home holds, set-aside ones
included, so the member can publish or copy them first.

Every checkout keeps its `workspaces/<id>/` (search index, managed MCP and
the MCP configs it wrote a resolved value to, resource cache) in the shared data home. A full `pull` writes its
checkout's path to the directory's `root` file, then removes the directories
whose `root` is no longer a checkout of the repository, probed as for the
`lastPullByWorkspace` entries above (#993). A directory without `root` (an
older CLI's, or one contribute, recall, viz, the MCP writers or the local agent
created before its checkout's first full pull) goes only when
`git worktree list --porcelain -z` names every checkout (no non-bare entry is
the common directory) and none of them, as git prints it or realpath'd, has its
id. 

With `--separate-git-dir`, in a submodule, on git before 2.36, or when it
holds `local-agent/`, it stays until its checkout's own full pull writes
`root`. The fast path probes nothing.

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
pushes only the votes cast where it is set up. 

The old shared `~/.teamai/votes/`
is never read, and its pending deltas are not pushed. The recall log sits beside
them (#884): `<dataHome>/dashboard/recall.jsonl` in every scope (`dashboard/` is
already ignored in a workspace `.teamai/`), local and owner-only, never pushed, and pruned only by `pull` (30 days, then 5,000 lines). The dashboard stays an A2
singleton: `teamai dashboard`, `session save` and the contribute check read
across scopes; `stats --by-repo` reads only the current scope's events, as the
rest of `stats` does (#795). 

Each event instead
carries `dataHomeKey`, a hash of the realpath'd `getDataHome()` of the scope the
hook resolved (#785; a hash, so a Copilot event still stores no path), and a
scope's report keeps the sessions whose first keyed event is its own, whole: a
Stop carries the whole transcript's totals, so a session that moved scope (a `cd`
mid-session) is reported once, where it started. A tool's own session ID is one
session whatever ends it records: `claude --resume` continues it, in a new
process, and its Stop carries the whole transcript. 

A fallback ID (`pid-…`;
Copilot's is the parent PID) names one run up to its `session_end` or
`process_exit`, so a later run that reuses it is decided on its own; a second end with nothing
recorded since the first (the dashboard monitor's `process_exit` after
`SessionEnd`) belongs to the run it closed. A `session_start` on a fallback ID
(`pid-…`) whose `monitorPid` differs from its open run's begins a new run even
though nothing ended that one (a crash with no dashboard running), and that one
counts as the run closed before it; a tool's own
ID is not split this way, since Claude fires SessionStart again on resume, in a
new process, and its Stop carries the whole transcript. 

The monitor's `process_exit` also
records `processExitAfter`, the last event it observed, and closes only that
run: an exit appended after the next run of the same ID began does not end it,
and one whose run compaction dropped is ignored. A dashboard started before
that field existed writes none. A dead process records nothing more, so such
an exit followed by more events of its fallback ID before the next start did
not end the open run: it belongs to the run closed before it, however late it
was appended. A tool's own session ID is
reported and snapshotted under the ID itself, as before, so a session resumed
after compaction dropped its events still reads what its scope reported. 

The
scope that first reports it also appends the ID and its own data home key to
`~/.teamai/dashboard/session-owners.jsonl` (never a path, #666), and a session
recorded there is that scope's wherever it is resumed later, whatever the log
still holds, so another scope never reports its transcript again; the first
line for an ID wins, and the file grows by one line per such session, like the
snapshots. An earlier release kept only per-scope snapshots, so the file is
first written from them: a tool's own ID is the scope's whose snapshots show it
reported it with the greatest total (prompts, then tokens). 

They show it when the
shared snapshots (all three) hold none of it, or the scope is past their total:
that release copied the shared file into every scope it ran in, so a copy, even
the only one, shows nothing, and a tie names no owner. 

When several scopes
reported it (a session that release split per event), the owner's line also
carries the credit of their parts, applied once as its baseline: a part whose
daily entry shows it ended in a Stop holds the transcript's cumulative total, so
the greatest such part counts once, while a part with no Stop counted its own
prompts, which add; interruptions, rejections and tokens, from Stops, take the
greatest, and corrections, counted per prompt, add. 

Whether a part with no
Stop came before another's cumulative Stop, which already counts it, is read
from the session's transcript when it has one (Claude): it keeps every prompt
in order with the directory it was typed in, so the Stop covers the first
prompts and only the part's prompts after those add. With no transcript to
place them they all add, which undercounts once but never sends a prompt again. 

The scopes read are the
user scope, every partition, and a project whose data home is in its workspace
that a session still in the log leads to; each report also records the IDs of
its own snapshots that have no owner yet and show it reported them (absent from
the shared snapshot, or past its total there). 

A session none of these reach
(a project whose data home is in its workspace, with no event left in the log)
is found by its transcript: hooks record `transcriptPath` on UserPromptSubmit,
Stop and SessionEnd (not SessionStart, whose path on a resume from another
project names a file that never exists; never Copilot's), and a Claude
transcript keeps its first `cwd` when resumed elsewhere, as a Codex rollout
keeps its `session_meta` and Copilot's own session log, found by the session ID
without storing its path, its `session.start` context. 

So a tool's own session
with no owner is the scope's that directory resolves to, when that scope's
snapshots already hold it; else it is decided as before (a fork under a new ID,
a tool whose transcript records no start). 

A session main split across scopes
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
correction). 

The session's daily request costs sum its rollouts in the log. A
rollout compaction has dropped keeps those totals in the session's prompt-token,
intervention and daily sums (cache tokens from its tokens), and a failed one
keeps the session unsuccessful, so a later rollout is reported in full and does
not turn it into a success. An entry
written before rollouts were kept is one total: an earlier release rewrote every
session in the log on each report, so it covers the rollouts begun by the time
its file was last written, or, earlier, when that report wrote the team stats
file in this scope's reports checkout (after reading the log, before its push;
the snapshot came after the push). 

That is read before this report writes
anything; a seed keeps the
shared file's time, and `teamai stats`, which only reads, writes no seed). Those still in
the log consume it in order, as far as each had got by that time, what is left is the dropped rollouts', kept as one
prior rollout, and a rollout begun later is new.
Compaction also keeps a session whose tool process is still running, so a run
an exit from a dashboard before `processExitAfter` marked stopped keeps its
start, and its ID. A
fallback run is reported and snapshotted as `<id>@<first event's timestamp>`,
which does not change when compaction drops earlier runs. 

A snapshot entry keyed
by a bare fallback ID (written before) is the sum of the runs of that ID in the
log at the earlier release's last report, and compaction keeps or drops the
runs of an ID together. So the next time the scope reports, those runs consume
the entry in log order, each taking up to its own totals of what is left; once
the prompt-token entry is used up, the later runs were not reported and count
as new sessions (the interventions and daily snapshots follow the prompt-token
one, since their counts say nothing when they run out). 

A run keeps its own
success and correction flags, since the sum's are no single run's, so an
adopted run changes no status total. The first run always
takes a share, as the entry means that release reported it. The entry is then
removed, so no later run of that ID reads it. Only an earlier release wrote bare
entries, and a seeded one may be another scope's, so a run whose first event
carries `dataHomeKey` (recorded by this release), and every later run of its ID,
takes none. 

A session written before that field existed is attributed by its first
`cwd`: to the scope `resolveConfigForDir` resolves that directory to now, the
dispatcher's rule, so a nested clone under a project is not the project's; no
`cwd`, or one removed since, is no scope's. Inside git an event also carries `projectAnchor`, the repo's
main checkout, which all of its worktrees share (#809); a Copilot event, with no
`cwd`, carries none. `stats --by-repo`,
`session save` and the dashboard's Repository filter key a session by the last
anchor it recorded, else by its `cwd`, and the dashboard gives an event to the
project rooted at its anchor, so a worktree counts as its repo, also after it
is removed. 

A hook whose `cwd` no longer exists (a session that outlives its
worktree) would resolve to the user scope, or be dropped without one, so it
keeps the scope its session last recorded instead (#810): the config at that
event's `projectAnchor` (for a bare repo, at one of its worktrees that still
exists), used only while the key of its `getDataHome()` is still the recorded
`dataHomeKey`. Its events and skill uses stay with the project, and the share
reminder's gate reads the project too. A project config there that
cannot be read records nothing, and with nothing recorded to match the hook
resolves from its `cwd` as before. 

The recorded scope is read from `events.jsonl`, so it lasts as long
as the session's earlier events do (compaction keeps only active sessions),
and Copilot, whose events record no directory, has none to recover.
The snapshots of what was already reported are per scope
too (#786), because a session ID can recur in another scope (Copilot's fallback
ID is the parent PID):
`<dataHome>/dashboard/reported-*.json`, and `~/.teamai/dashboard/user-reported-*.json`
for the user scope. The first time a scope needs one it seeds it from the shared
`~/.teamai/dashboard/reported-*.json`, so nothing reported before the upgrade is
sent again; after that it reads only its own. 

That file summed every scope's
runs of an ID, so the runs of the whole log consume it in log order, whichever
scope each belongs to, and the seed keeps the shares of the scope's own runs,
under their run IDs; none goes to a run recorded
with a `dataHome` path: that release already kept per-scope snapshots, so a
shared entry under its ID is another scope's. An unmatched fallback entry is
dropped, so a later reuse of the PID cannot inherit it; a tool's own session ID
is copied whole, as before, so a session resumed after compaction dropped its
events is not sent again. 

The shared file is no longer
written, except by an earlier release after a rollback, so every scope seeds from
what the machine had reported by then, never from another scope's later report.
The seed holds a session's whole total, so a session still running at the
upgrade goes on from the reported total, as before.

Every writer that may modify `events.jsonl` — each hook's append, and a
compaction that finds the log past its threshold or side files to fold —
takes `events.jsonl.lock` beside it (#804), the pattern the usage
file took for the same lost update (#803): compaction's
read → filter → temp-file → rename cannot drop an append that lands while it
runs, and two compactions cannot interleave their rewrites. A compaction
whose log is below the threshold and holds no side files does the common
case lock-free: one read, and it returns without touching the lock, so a
state directory that is being torn down concurrently never meets a lock
creation. 

A hook append waits
up to ~250 ms, inside its foreground budget, and one that gives up records its
line in an `events.pending-<uuid>.jsonl` side file, with the file's mode, that
the next lock holder folds into the file before it writes — so an event is
late, never gone. Side files fold in their events' own time order, not
readdir's, and the compaction classifies sessions in time order too (the
order every reader rebuilds from), so a side file that outlived newer appends
cannot place an older event after them and re-mark a live session stopped.


The line carries a `pendingId`, so a fold never appends a side file twice (a
holder that died after appending it but before removing it leaves it for the
next one), two side files of identical events are both kept, and the id stays
in the raw file — a rewrite keeps it, as the usage file's does — until the
side file itself is gone, while no reader ever sees it: `readEvents` drops it.
A side file without its trailing
newline is still being written and waits for the next holder. 

A compaction
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
dead. 

teamai never auto-collects orphans (a renamed or deleted project leaves its
partition behind — a `gc` command is explicitly out of scope), so this is how a
user finds partitions safe to `rm -rf` by hand.

### Explicitly out of scope

`teamai migrate` / `gc` / `--revert` commands; cross-project shared team-repo clone.
Downgrade to an older teamai after
P1 migration is not supported (`.teamai.bak/` is the manual rollback path).

## Team secret values (#875)

A member's values for their teams' declared secrets live in `~/.teamai/secrets/`,
a class-A2 (machine-level) directory: `teams/<hash>.json`, one file per
team repo, named by the full SHA-256 hex digest (64 characters, never shortened) of the team repo URL in `~/.teamai/config.yaml` (never
`teamai.yaml`'s `repo:`), without the team name, so renaming `team:` keeps the values;


the hash covers the URL's scheme (the ssh forms count as one; https and http are two),
ssh user, host, non-default port and path (an scp-style path not starting with `/` or `~`
is in the user's home, as `ssh://host/~/path`; `ssh://host/path` is from the root), so an
scp path in the home and the `ssh://` path from the root, two ssh users' repos on one host, two
repos on one host with different ports, or repos behind http and https, get different files,
and `machine.json`, the values set with `teamai env set --global` for every team.
Every scope that uses the same team, and every worktree of it, reads the same file.


Each entry records whether it is a secret's value or the member's value for an
`env.yaml` variable (`kind`), so one is never used as the other.
It never goes to a partition or to `<dataHome>`, which in single-repo mode is inside
the business repo, and it is not `~/.teamai/env`, which is already the user scope's
env backup file. Files are written atomically with mode `0600`. Uninstalling a
project scope removes only its partition, so the values stay; uninstalling the user
scope removes `~/.teamai` and them with it. See [Team secrets](team-secrets.md#storage).

Beside each scope's `env.sh`, in `<dataHome>`, `env.sh.exports.json` records what
that `env.sh` has exported: per key, a SHA-256 of `KEY=VALUE` for the last 20
values, never a value, mode `0600`. It is machine data like `env.sh` and is
removed with it. See [Team secrets](team-secrets.md#resolution).
