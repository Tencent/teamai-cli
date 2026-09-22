/**
 * Manage a long-lived teamai orphan branch through an isolated git worktree.
 *
 * Two branches are built on this: `teamai-reports` (members/sessions/votes/stats)
 * and `teamai-learnings` (learnings). They must not share a branch, a worktree
 * or a lock, and everything else about them is identical, so a spec of three
 * names is the whole difference.
 *
 * Worktree placement:
 *  - self: <business-repo>/.teamai/<dirname>
 *  - git / legacy: sibling of the clone (`<dirname(localPath)>/<dirname>`) so
 *    clone `reset --hard` cannot nest-destroy it
 *
 * Why an orphan branch + dedicated worktree?
 *  - High-frequency data must NOT pollute the default branch, so members can use
 *    the team repo with branch protection. An orphan history leaves main clean.
 *  - Writes involve `git reset --hard` / rebase. Running those on the user's
 *    active working tree (self) or nesting the worktree inside the knowledge
 *    clone (git) would destroy uncommitted work. A separate worktree confines
 *    every destructive git op to the orphan-branch checkout.
 *
 * Concurrency: the branch is shared by the whole team. Pushes race at the git
 * layer (non-fast-forward); we resolve with fetch + rebase + retry. Reports
 * never collide because each member only writes `<user>.yaml`; learnings can,
 * which is why a publish reports whether the ref actually moved.
 */
import path from 'node:path';
import fse from 'fs-extra';
import type { SimpleGit } from 'simple-git';
import { createGit, isGitRepo, commitSkippingHooks, isDedicatedRepoRoot } from './git.js';
import { acquireLock, releaseLock } from '../update.js';
import { ensureDir, writeFile, pathExists } from './fs.js';
import { log } from './logger.js';
import {
  WORKTREE_DIRNAMES,
  getBusinessRoot,
  getWorktreeDir,
  isSelfMode,
  usesBranchWorktree,
  type LocalConfig,
} from '../types.js';

/** The names that distinguish one teamai side branch from another. */
export interface BranchWorktreeSpec {
  /** Orphan branch name, e.g. 'teamai-reports'. */
  branch: string;
  /** Worktree directory name. Placement (self vs sibling) is not a spec concern. */
  worktreeDirname: string;
  /** Lock filename, resolved beside the worktree. Unique per branch. */
  lockFilename: string;
  /** Prefix for this instance's debug lines, e.g. 'reports'. */
  logTag: string;
  /** Message for the branch's first (empty tree + .gitignore) commit. */
  initCommitMessage: string;
}

/**
 * The outcome of a publish. A boolean cannot carry this: a caller that holds
 * the only durable copy of the data must drop it on `published` and keep it on
 * every other status, and `busy` is worth retrying while `failed` is worth
 * reporting to the user.
 */
export type PublishResult =
  | { status: 'published' }
  | { status: 'already-present' }
  | { status: 'busy' }
  | { status: 'failed'; reason: string };

/** True when the publish landed, i.e. the caller may drop its durable copy. */
export function isPublished(result: PublishResult): boolean {
  return result.status === 'published';
}

/**
 * Git repository that owns the worktree.
 * - self: the business repo (knowledge lives in `.teamai/` inside it)
 * - git: the dedicated team clone (`localPath` itself)
 */
function gitRoot(localConfig: LocalConfig): string {
  if (isSelfMode(localConfig)) {
    return getBusinessRoot(localConfig);
  }
  return localConfig.repo.localPath;
}

/** Path to this branch's worktree directory (see getWorktreeDir). */
function worktreePath(spec: BranchWorktreeSpec, localConfig: LocalConfig): string {
  return getWorktreeDir(localConfig, spec.worktreeDirname);
}

/** Lock file sitting beside the worktree (never inside the clone). */
function lockFilePath(spec: BranchWorktreeSpec, localConfig: LocalConfig): string {
  return path.join(path.dirname(worktreePath(spec, localConfig)), spec.lockFilename);
}

/**
 * Whether there is provably nothing left to send: the remote-tracking ref for
 * this branch exists and HEAD is not ahead of it.
 *
 * Only ever used to decide whether a worktree with nothing staged still owes
 * origin a commit. It is not a proof of delivery: `git push` updates the
 * tracking ref through the remote's FETCH refspec, and a clone made with
 * `--single-branch` (what CI checkouts and some business repos are) only
 * fetches the default branch, so a perfectly successful push of a side branch
 * leaves no tracking ref behind. Anything unreadable therefore means "push and
 * find out", never "this failed".
 */
async function nothingLeftToPush(git: SimpleGit, spec: BranchWorktreeSpec): Promise<boolean> {
  try {
    const out = (await git.raw(['rev-list', '--count', `origin/${spec.branch}..HEAD`])).trim();
    return out === '0';
  } catch {
    return false;
  }
}

async function remoteBranchExists(spec: BranchWorktreeSpec, repoRoot: string): Promise<boolean> {
  const git = createGit(repoRoot);
  try {
    const res = await git.listRemote(['--heads', 'origin', spec.branch]);
    return typeof res === 'string' && res.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Fetch a side branch into its remote-tracking ref with an explicit refspec.
 *
 * `git fetch origin <branch>` updates only FETCH_HEAD. A clone made with
 * `--single-branch` (CI checkouts and some business repos) has a fetch refspec
 * that covers only the default branch, so plain `fetch origin <branch>` leaves
 * `refs/remotes/origin/<branch>` non-existent — and then the worktree checkout,
 * `rebase origin/<branch>` and `merge --ff-only origin/<branch>` all fail or read
 * stale. An explicit refspec creates and updates that tracking ref in every
 * clone (#706). Used by both the reports and learnings branches.
 */
async function fetchTrackingRef(git: SimpleGit, branch: string): Promise<void> {
  await git.fetch(['origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/**
 * Ensure a git worktree checked out on this branch exists.
 * Self: <knowledgeDir>/<dirname>. Independent git: sibling of the clone.
 * Idempotent. Returns the worktree absolute path.
 *
 * Cold-start cases handled:
 *  - worktree already present  → return it (readers refresh it via refreshReportsWorktree).
 *  - remote branch exists      → worktree add --no-track -b from origin/<branch>.
 *  - remote branch absent      → reuse an unpublished local branch, or create the
 *                                orphan branch locally; then first-push unless
 *                                `pushIfCreated` is false.
 */
export interface EnsureWorktreeOptions {
  /**
   * Whether a cold start may publish a newly created branch. Writers keep the
   * default; read-only callers must pass false so they materialize a local
   * view without changing origin.
   */
  pushIfCreated?: boolean;
}

async function ensureWorktree(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  options: EnsureWorktreeOptions = {},
): Promise<string> {
  if (!usesBranchWorktree(localConfig)) {
    return getWorktreeDir(localConfig, spec.worktreeDirname);
  }

  const wt = worktreePath(spec, localConfig);
  const repoRoot = gitRoot(localConfig);

  if (!isSelfMode(localConfig) && !(await isDedicatedRepoRoot(repoRoot))) {
    throw new Error(
      `Refusing to create the ${spec.branch} worktree: ${repoRoot} is not a dedicated team-repo clone root`,
    );
  }

  // Already a valid worktree — nothing to do. `isGitRepo` only checks that a
  // `.git` file/dir exists; after a sibling clone is deleted and re-cloned the
  // worktree gitdir (`<clone>/.git/worktrees/<dirname>`) is gone and git ops
  // fail with "not a git repository". Probe a real git command and fall through
  // to remove+recreate when the link is stale.
  if (await isGitRepo(wt)) {
    try {
      await createGit(wt).revparse(['--is-inside-work-tree']);
      return wt;
    } catch {
      // stale/dangling worktree link (clone was re-cloned/pruned) — recreate below.
    }
  }

  // Path exists but is not a git worktree (stale/partial) — clear it so we can recreate.
  if (await pathExists(wt)) {
    await fse.remove(wt);
  }

  await ensureDir(path.dirname(wt));
  const git = createGit(repoRoot);

  // Prune any dangling worktree registration left from a previous removal.
  try {
    await git.raw(['worktree', 'prune']);
  } catch {
    // best effort
  }

  if (await remoteBranchExists(spec, repoRoot)) {
    // Remote branch exists: fetch and check it out into the worktree.
    try {
      // Explicit refspec, not `fetch origin <branch>`: a --single-branch clone
      // would otherwise only move FETCH_HEAD, leaving origin/<branch> absent and
      // the checkout below failing (#706).
      await fetchTrackingRef(git, spec.branch);
    } catch {
      // fetch may fail offline; worktree add can still work if we have it locally
    }
    // If a local branch of the same name exists, add tracking it; otherwise create branch.
    const branches = await git.branchLocal();
    if (branches.all.includes(spec.branch)) {
      await git.raw(['worktree', 'add', wt, spec.branch]);
    } else {
      // `--no-track`, not `--track`: a --single-branch clone's `remote.origin.fetch`
      // does not cover this side branch, so `--track` errors ("cannot set up
      // tracking information; starting point 'origin/<branch>' is not a branch")
      // even once the explicit fetch above created the ref. Nothing here relies on
      // git's upstream config — every sync references `origin/<branch>` directly —
      // so branching off it without tracking is correct in every clone (#706).
      await git.raw(['worktree', 'add', wt, '--no-track', '-b', spec.branch, `origin/${spec.branch}`]);
    }
  } else {
    // Remote branch absent. A read-only cold start (or a failed first push)
    // leaves an unpublished local branch; reuse it, because creating the orphan
    // branch again fails with "a branch named '<branch>' already exists".
    const branches = await git.branchLocal();
    if (branches.all.includes(spec.branch)) {
      await git.raw(['worktree', 'add', wt, spec.branch]);
    } else {
      await createOrphanWorktree(spec, repoRoot, wt);
      await writeWorktreeGitignore(wt);
      const wtGit = createGit(wt);
      await wtGit.add(['.gitignore']);
      await commitSkippingHooks(wtGit, spec.initCommitMessage);
    }
    if (options.pushIfCreated !== false) {
      try {
        await createGit(wt).push(['-u', 'origin', spec.branch]);
      } catch (e) {
        log.debug(`[${spec.logTag}] initial push skipped: ${(e as Error).message}`);
      }
    }
  }

  return wt;
}

/**
 * Create an orphan-branch worktree. Uses the modern `--orphan` flag (git 2.42+)
 * and falls back to the detach + `checkout --orphan` dance for older git.
 */
async function createOrphanWorktree(spec: BranchWorktreeSpec, repoRoot: string, wt: string): Promise<void> {
  const git = createGit(repoRoot);
  try {
    // git 2.42+: create a worktree on a fresh orphan branch directly.
    // The branch name must be given via -b; a positional after <path> is treated
    // as a commit-ish and errors ("--orphan and commit-ish cannot be used together").
    await git.raw(['worktree', 'add', '--orphan', '-b', spec.branch, wt]);
    // The --orphan worktree may inherit the index/files from HEAD in some git
    // versions; clear tracked entries so the branch starts empty.
    const wtGit = createGit(wt);
    try {
      await wtGit.raw(['rm', '-rf', '--cached', '.']);
    } catch {
      // nothing staged — fine
    }
    await clearWorktreeFiles(wt);
  } catch {
    // Older git (<2.42): detach a worktree at HEAD, then orphan-checkout inside it.
    await git.raw(['worktree', 'add', '--detach', wt, 'HEAD']);
    const wtGit = createGit(wt);
    await wtGit.raw(['checkout', '--orphan', spec.branch]);
    try {
      await wtGit.raw(['rm', '-rf', '--cached', '.']);
    } catch {
      // nothing staged
    }
    await clearWorktreeFiles(wt);
  }
}

/** Remove all files (except .git) from a freshly-created orphan worktree. */
async function clearWorktreeFiles(wt: string): Promise<void> {
  const entries = await fse.readdir(wt);
  await Promise.all(
    entries
      .filter((e) => e !== '.git')
      .map((e) => fse.remove(path.join(wt, e))),
  );
}

/** Write a .gitignore inside the worktree so no worktree can nest-track another. */
async function writeWorktreeGitignore(wt: string): Promise<void> {
  const content = [
    '# teamai side branch — machine-local artifacts should never be tracked here',
    ...WORKTREE_DIRNAMES.map((dirname) => `${dirname}/`),
    '',
  ].join('\n');
  await writeFile(path.join(wt, '.gitignore'), content);
}

const MAX_PUSH_RETRIES = 5;

export interface BranchWrite {
  files: string[];
  message: string;
}

/** Commit `files` in an already-locked worktree and push them. */
async function commitAndPushAt(
  spec: BranchWorktreeSpec,
  wt: string,
  message: string,
  files: string[],
  options: { pushIfUnchanged?: boolean } = {},
): Promise<PublishResult> {
  const git = createGit(wt);

  await git.add(files);
  const status = await git.status();
  if (status.staged.length === 0 && !options.pushIfUnchanged && await nothingLeftToPush(git, spec)) {
    // Nothing to commit AND nothing to deliver. Those are two different things:
    // an earlier attempt may have committed exactly this content and failed to
    // push it, and a caller that reads "already present" drops the only durable
    // copy it has. Fall through to the push loop whenever that is in doubt.
    log.debug(`[${spec.logTag}] nothing to commit`);
    return { status: 'already-present' };
  }

  // A retry may reconstruct the same tree as a previously committed
  // but unconfirmed push. It still needs a push, without an empty commit.
  if (status.staged.length > 0) await commitSkippingHooks(git, message);

  // Push with fetch+rebase retry. Each member only writes <user>.yaml, so
  // rebase conflicts are effectively impossible; retries handle the pure
  // non-fast-forward race.
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      // A push that resolves is a push the remote accepted: git exits non-zero
      // when it refuses one. Do NOT re-check the remote-tracking ref here — it
      // is only updated through the remote's fetch refspec, so a `--single-branch`
      // clone would report failure for every successful side-branch push.
      await git.push(['origin', spec.branch]);
      return { status: 'published' };
    } catch (pushErr) {
      if (attempt === MAX_PUSH_RETRIES) {
        log.debug(`[${spec.logTag}] push failed after ${attempt} attempts: ${(pushErr as Error).message}`);
        return { status: 'failed', reason: (pushErr as Error).message };
      }
      try {
        await fetchTrackingRef(git, spec.branch);
        await git.rebase([`origin/${spec.branch}`]);
      } catch (rebaseErr) {
        log.debug(`[${spec.logTag}] rebase failed, retrying: ${(rebaseErr as Error).message}`);
        // Abort a half-finished rebase so the next attempt starts clean.
        try {
          await git.rebase(['--abort']);
        } catch {
          // no rebase in progress
        }
      }
    }
  }
  return { status: 'failed', reason: `push did not land after ${MAX_PUSH_RETRIES} attempts` };
}

/**
 * Commit files the caller already wrote into the worktree, then push them,
 * retrying with fetch + rebase on non-fast-forward races.
 *
 * Does NOT sync with origin first: the caller wrote before the lock was taken.
 * Merge-writers (session / votes / stats / member roster, or any writer that
 * must read the current remote state) use {@link updateImpl} instead.
 *
 * Never throws. `published` means the ref moved on origin, so a caller holding
 * the only durable copy may drop it on that status and on no other.
 */
async function commitAndPushImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  message: string,
  files: string[],
  options: { pushIfUnchanged?: boolean } = {},
): Promise<PublishResult> {
  const lockPath = lockFilePath(spec, localConfig);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    log.debug(`[${spec.logTag}] another write is in progress; skipping`);
    return { status: 'busy' };
  }

  try {
    const wt = await ensureWorktree(spec, localConfig);
    return await commitAndPushAt(spec, wt, message, files, options);
  } catch (e) {
    log.debug(`[${spec.logTag}] commitAndPush failed (non-blocking): ${(e as Error).message}`);
    return { status: 'failed', reason: (e as Error).message };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Under this branch's lock: sync the worktree with origin, run `write`, commit,
 * push. The callback does not run when the lock is busy.
 *
 * `write` receives the worktree root and returns the worktree-relative paths it
 * touched, or null when it decided there was nothing to write.
 */
async function updateImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  write: (worktree: string) => Promise<BranchWrite | null>,
  options: { pushIfUnchanged?: boolean } = {},
): Promise<PublishResult> {
  if (!usesBranchWorktree(localConfig)) {
    throw new Error(`update() needs a branch-backed repo, and ${spec.branch} has none for kind: 'http'`);
  }

  const lockPath = lockFilePath(spec, localConfig);
  if (!(await acquireLock(lockPath))) {
    log.debug(`[${spec.logTag}] another write is in progress; skipping`);
    return { status: 'busy' };
  }

  try {
    const wt = await ensureWorktree(spec, localConfig);
    try {
      await syncWorktree(spec, wt);
    } catch (e) {
      log.debug(`[${spec.logTag}] sync before write failed, writing onto the local copy: ${(e as Error).message}`);
    }

    const change = await write(wt);
    if (!change || change.files.length === 0) {
      return { status: 'already-present' };
    }
    return await commitAndPushAt(spec, wt, change.message, change.files, options);
  } catch (e) {
    log.debug(`[${spec.logTag}] update failed (non-blocking): ${(e as Error).message}`);
    return { status: 'failed', reason: (e as Error).message };
  } finally {
    await releaseLock(lockPath);
  }
}

async function gitPathExists(git: SimpleGit, gitPath: string): Promise<boolean> {
  try {
    const resolved = (await git.raw(['rev-parse', '--git-path', gitPath])).trim();
    return resolved.length > 0 && (await pathExists(resolved));
  } catch {
    return false;
  }
}

/** True while `git rebase` has not finished (as opposed to a completed rebase whose autostash conflicted). */
async function rebaseInProgress(git: SimpleGit): Promise<boolean> {
  return (await gitPathExists(git, 'rebase-merge')) || (await gitPathExists(git, 'rebase-apply'));
}

/**
 * Restore the "Stashed changes" / `--theirs` side of a stash-apply conflict
 * and leave it uncommitted. Does not read or drop `refs/stash`: worktrees of
 * the same repo share that ref, so a refresh must never clean it up.
 * Skip when a rebase is still in progress so a real commit conflict is
 * aborted by the caller instead.
 */
async function restoreConflictedFiles(spec: BranchWorktreeSpec, git: SimpleGit): Promise<void> {
  let conflicted: string[] = [];
  try {
    conflicted = (await git.status()).conflicted ?? [];
  } catch {
    return;
  }
  if (conflicted.length === 0) {
    return;
  }
  if (await rebaseInProgress(git)) {
    return;
  }

  try {
    await git.raw(['checkout', '--theirs', '--', ...conflicted]);
    await git.raw(['add', '--', ...conflicted]);
    await git.raw(['reset', 'HEAD', '--', ...conflicted]);
    log.debug(`[${spec.logTag}] restored uncommitted files after a stash-apply conflict; using the local copy`);
  } catch (e) {
    log.debug(`[${spec.logTag}] could not restore stash-apply conflicts: ${(e as Error).message}`);
    try {
      await git.raw(['reset', '--hard', 'HEAD']);
    } catch {
      // best effort: at least try not to leave conflict markers
    }
  }
}

/**
 * Snapshot dirty tracked files without touching `refs/stash` (`git stash create`
 * returns a dangling commit). `git rebase --autostash` would push onto the
 * shared stash list, which other worktrees of this repo also see.
 */
async function snapshotDirtyTree(git: SimpleGit): Promise<string | null> {
  try {
    const sha = (await git.raw(['stash', 'create'])).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function applyDirtySnapshot(spec: BranchWorktreeSpec, git: SimpleGit, sha: string): Promise<void> {
  try {
    await git.raw(['stash', 'apply', sha]);
  } catch {
    // apply conflicts leave UU paths; restoreConflictedFiles recovers them
  }
  await restoreConflictedFiles(spec, git);
}

/**
 * Bring the worktree up to date with origin. The caller holds this branch's
 * lock, so no publish runs at the same time.
 *
 *  - fetch fails (offline, or origin has no reports branch yet) → keep the local copy.
 *  - no unpushed commits → fast-forward to origin.
 *  - unpushed commits (e.g. a push that failed offline) → rebase them onto origin
 *    so the next push delivers them.
 *  - uncommitted files (a writer wrote them but has not committed yet)
 *    are carried along, never discarded; if they block the update, keep the
 *    local copy.
 *  - unpushed commits that conflict with origin (the same member wrote from
 *    another checkout) → dropped, so the worktree is not left diverged forever.
 *  - dirty + ahead: snapshot with `git stash create` (not `--autostash`), rebase,
 *    then re-apply. That object is never stored in `refs/stash`, so a concurrent
 *    `git stash` in another worktree of this repo is left alone. Stash-apply
 *    conflicts restore the original uncommitted files, never conflict markers.
 */
async function syncWorktree(spec: BranchWorktreeSpec, wt: string): Promise<void> {
  const git = createGit(wt);
  const upstream = `origin/${spec.branch}`;
  try {
    // Explicit refspec so the `merge --ff-only`/`rebase` against origin/<branch>
    // below sees fresh commits even in a --single-branch clone (#706).
    await fetchTrackingRef(git, spec.branch);
  } catch (e) {
    log.debug(`[${spec.logTag}] fetch failed, using the local copy: ${(e as Error).message}`);
    return;
  }

  await restoreConflictedFiles(spec, git);

  const dirty = !(await git.status()).isClean();
  const ahead = Number.parseInt((await git.raw(['rev-list', '--count', `${upstream}..HEAD`])).trim(), 10);

  let carried: string | null = null;
  if (dirty && ahead > 0) {
    carried = await snapshotDirtyTree(git);
    if (!carried) {
      log.debug(`[${spec.logTag}] uncommitted files block the refresh; using the local copy`);
      return;
    }
    try {
      await git.raw(['reset', '--hard', 'HEAD']);
    } catch (e) {
      log.debug(`[${spec.logTag}] could not clear the worktree for rebase; using the local copy: ${(e as Error).message}`);
      await applyDirtySnapshot(spec, git, carried);
      return;
    }
  }

  try {
    if (ahead > 0) {
      await git.rebase([upstream]);
    } else {
      await git.raw(['merge', '--ff-only', upstream]);
    }
  } catch (e) {
    if (ahead > 0) {
      try {
        await git.rebase(['--abort']);
      } catch {
        // no rebase in progress
      }
    }
    if (carried) {
      await applyDirtySnapshot(spec, git, carried);
      log.debug(`[${spec.logTag}] uncommitted files block the refresh; using the local copy: ${(e as Error).message}`);
      return;
    }
    if (dirty) {
      log.debug(`[${spec.logTag}] uncommitted files block the refresh; using the local copy: ${(e as Error).message}`);
      return;
    }
    log.debug(`[${spec.logTag}] dropping ${ahead} unpushed commit(s) that conflict with ${upstream}: ${(e as Error).message}`);
    await git.raw(['reset', '--hard', upstream]);
    return;
  }

  if (carried) {
    await applyDirtySnapshot(spec, git, carried);
  }
}

/**
 * Best-effort refresh from origin so readers see other members' latest data.
 * Read-only callers pass `pushIfCreated: false`. When a write holds the lock,
 * the local copy is used as-is. Never throws. Only ever touches the
 * orphan-branch worktree, never the active tree.
 */
async function refreshImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  options: EnsureWorktreeOptions = {},
): Promise<void> {
  if (!usesBranchWorktree(localConfig)) {
    return;
  }

  const lockPath = lockFilePath(spec, localConfig);
  let locked = false;
  try {
    locked = await acquireLock(lockPath);
    const wt = await ensureWorktree(spec, localConfig, options);
    if (!locked) {
      log.debug(`[${spec.logTag}] a write is in progress; reading the local copy`);
      return;
    }
    await syncWorktree(spec, wt);
  } catch (e) {
    log.debug(`[${spec.logTag}] refresh skipped: ${(e as Error).message}`);
  } finally {
    if (locked) {
      await releaseLock(lockPath);
    }
  }
}

/** One branch's worth of behaviour, behind one interface. */
export interface BranchWorktree {
  readonly branch: string;
  /** Pure. False only for kind: 'http', which has no git branch at all. */
  enabled(localConfig: LocalConfig): boolean;
  /** Pure. The worktree root; it may not exist yet. No I/O. */
  dir(localConfig: LocalConfig): string;
  ensure(localConfig: LocalConfig, options?: EnsureWorktreeOptions): Promise<string>;
  update(
    localConfig: LocalConfig,
    write: (worktree: string) => Promise<BranchWrite | null>,
    options?: { pushIfUnchanged?: boolean },
  ): Promise<PublishResult>;
  commitAndPush(
    localConfig: LocalConfig,
    message: string,
    files: string[],
    options?: { pushIfUnchanged?: boolean },
  ): Promise<PublishResult>;
  refresh(localConfig: LocalConfig, options?: EnsureWorktreeOptions): Promise<void>;
}

/**
 * Build the interface for one branch.
 *
 * Invariants a caller must know:
 *  - `dir` is pure and total; every other method is the only I/O.
 *  - The lock is per instance, non-blocking and non-reentrant: never call this
 *    instance's `update` / `commitAndPush` / `refresh` from inside its own
 *    `update` callback. Different instances have different locks and never
 *    block each other.
 *  - `ensure({ pushIfCreated: false })` is guaranteed not to mutate origin.
 *  - `refresh` drops unpushed local commits that conflict with origin, so the
 *    worktree is never left diverged forever. A caller whose data cannot be
 *    regenerated must keep a durable copy until a publish returns `published`.
 */
export function createBranchWorktree(spec: BranchWorktreeSpec): BranchWorktree {
  return {
    branch: spec.branch,
    enabled: (localConfig) => usesBranchWorktree(localConfig),
    dir: (localConfig) => worktreePath(spec, localConfig),
    ensure: (localConfig, options) => ensureWorktree(spec, localConfig, options),
    update: (localConfig, write, options) => updateImpl(spec, localConfig, write, options),
    commitAndPush: (localConfig, message, files, options) =>
      commitAndPushImpl(spec, localConfig, message, files, options),
    refresh: (localConfig, options) => refreshImpl(spec, localConfig, options),
  };
}
