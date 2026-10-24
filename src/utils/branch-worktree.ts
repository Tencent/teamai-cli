/**
 * Manage a long-lived teamai orphan branch through an isolated git worktree.
 *
 * Two branches are built on this: `teamai-reports` (members/sessions/votes/stats)
 * and `teamai-learnings` (learnings). They must not share a branch, a worktree
 * or a lock, and everything else about them is identical, so a spec of three
 * names is the whole difference.
 *
 * Worktree placement:
 *  - self: <dataHome>/<dirname>, in the partition, so every checkout of the
 *    business repo shares it (#808)
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
import { GitPluginError, type SimpleGit, type StatusResult } from 'simple-git';
import { createGitWithBlockTimeout, isGitRepo, commitSkippingHooks, isDedicatedRepoRoot, gitCommonDir, checkoutLocation } from './git.js';
import { acquireLock, releaseLock } from '../update.js';
import { ensureDir, writeFile, pathExists } from './fs.js';
import { isSilent, log } from './logger.js';
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
  | { status: 'failed'; reason: string; refused?: true };

/** True when the publish landed, i.e. the caller may drop its durable copy. */
export function isPublished(result: PublishResult): boolean {
  return result.status === 'published';
}

/**
 * True when origin provably holds the data: `published`, or the exact content
 * was already there (`already-present`). `busy` and `failed` are NOT delivery.
 * Callers that keep a durable local copy until delivery (the votes deltas of
 * #1027) may drop it exactly on this predicate.
 */
export function isDelivered(result: PublishResult): boolean {
  return result.status === 'published' || result.status === 'already-present';
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

/** Whether origin has the branch; null when git could not ask it. */
async function remoteBranchExists(spec: BranchWorktreeSpec, repoRoot: string): Promise<boolean | null> {
  const git = createGitWithBlockTimeout(repoRoot);
  try {
    const res = await git.listRemote(['--heads', 'origin', spec.branch]);
    return typeof res === 'string' && res.trim().length > 0;
  } catch {
    return null;
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
 *
 * `--progress`: on a pipe git prints nothing until it finishes, and the block
 * timeout kills a silent git, so a slow fetch of a large branch that is still
 * moving data would be killed with a stalled one.
 */
export async function fetchTrackingRef(git: SimpleGit, branch: string): Promise<void> {
  await git.fetch(['--progress', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/**
 * Ensure a git worktree checked out on this branch exists.
 * Self: <dataHome>/<dirname>. Independent git: sibling of the clone.
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
  return (await openWorktree(spec, localConfig, options)).wt;
}

/**
 * {@link ensureWorktree}, and whether the checkout matches origin already:
 * created just now from a fetch this call made, pushed by it, or created while
 * origin has no such branch. A sync right after would only repeat that fetch.
 */
async function openWorktree(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  options: EnsureWorktreeOptions = {},
): Promise<{ wt: string; current: boolean }> {
  if (!usesBranchWorktree(localConfig)) {
    return { wt: getWorktreeDir(localConfig, spec.worktreeDirname), current: false };
  }

  const wt = worktreePath(spec, localConfig);
  const repoRoot = gitRoot(localConfig);

  if (!isSelfMode(localConfig) && !(await isDedicatedRepoRoot(repoRoot))) {
    throw new Error(
      `Refusing to create the ${spec.branch} worktree: ${repoRoot} is not a dedicated team-repo clone root`,
    );
  }

  // Already a valid worktree — nothing to do. `isGitRepo` only checks that a
  // `.git` file/dir exists, so probe a real git command. A checkout git cannot
  // open is removed and recreated only while this repo still registers it;
  // after the clone is deleted and cloned again its registration
  // (`<clone>/.git/worktrees/<dirname>`) is gone, and it is refused and kept.
  if (await isGitRepo(wt)) {
    // A stale/dangling worktree link is recreated below if this repo registers it.
    if (await gitOpensCheckout(wt)) {
      await refuseForeignCheckout(spec, wt, repoRoot);
      return { wt, current: false };
    }
    await refuseUnprovenCheckout(spec, wt, repoRoot);
  }

  // Path exists but is not a git worktree (stale/partial) — clear it so we can recreate.
  if (await pathExists(wt)) {
    await fse.remove(wt);
  }

  await ensureDir(path.dirname(wt));
  const git = createGitWithBlockTimeout(repoRoot);

  // Whether origin has the branch depends on none of the local steps below, so
  // it is asked while they run. Self mode asks after removing old checkouts: a
  // refusal there stops before origin is asked.
  let onOriginAnswer = isSelfMode(localConfig)
    ? null
    : remoteBranchExists(spec, repoRoot);

  // Prune any dangling worktree registration left from a previous removal.
  try {
    await git.raw(['worktree', 'prune']);
  } catch {
    // best effort
  }
  if (isSelfMode(localConfig)) {
    await removeOldCheckoutsInDotTeamai(spec, git, wt);
    onOriginAnswer = remoteBranchExists(spec, repoRoot);
  }

  // Local branches only, which the fetch below does not change.
  const branches = await git.branchLocal();
  const onOrigin = await onOriginAnswer;
  if (onOrigin !== null && onOrigin) {
    // Remote branch exists: fetch and check it out into the worktree.
    let fetched = false;
    try {
      // Explicit refspec, not `fetch origin <branch>`: a --single-branch clone
      // would otherwise only move FETCH_HEAD, leaving origin/<branch> absent and
      // the checkout below failing (#706).
      await fetchTrackingRef(git, spec.branch);
      fetched = true;
    } catch {
      // fetch may fail offline; worktree add can still work if we have it locally
    }
    // If a local branch of the same name exists, add tracking it; otherwise create branch.
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
      return { wt, current: fetched };
    }
  } else {
    // Remote branch absent. A read-only cold start (or a failed first push)
    // leaves an unpublished local branch; reuse it, because creating the orphan
    // branch again fails with "a branch named '<branch>' already exists".
    if (branches.all.includes(spec.branch)) {
      await git.raw(['worktree', 'add', wt, spec.branch]);
    } else {
      await createOrphanWorktree(spec, repoRoot, wt);
      await writeWorktreeGitignore(wt);
      const wtGit = createGitWithBlockTimeout(wt);
      await wtGit.add(['.gitignore']);
      await commitSkippingHooks(wtGit, spec.initCommitMessage, undefined, { identityFallback: true });
    }
    if (options.pushIfCreated !== false) {
      try {
        // `--progress` keeps a slow upload alive under the block timeout, as in fetchTrackingRef.
        await createGitWithBlockTimeout(wt).push(['--progress', '-u', 'origin', spec.branch]);
        return { wt, current: true };
      } catch (e) {
        log.debug(`[${spec.logTag}] initial push skipped: ${(e as Error).message}`);
      }
    } else if (onOrigin === false) {
      // Origin said just now it has no such branch: nothing to sync from.
      return { wt, current: true };
    }
  }

  return { wt, current: false };
}

/**
 * Self mode used to check this branch out in each checkout's own `.teamai/`
 * (#808). Git checks a branch out in one worktree only, so a checkout left
 * there by an older teamai blocks the shared one at `wt`, from every checkout
 * of the repo. Remove it the way a member would: without --force, so a checkout
 * with uncommitted changes stays, and the member is told what to do with them.
 * Its commits are on the branch, which the new checkout reuses.
 */
async function removeOldCheckoutsInDotTeamai(spec: BranchWorktreeSpec, git: SimpleGit, wt: string): Promise<void> {
  const oldSuffix = `${path.sep}${path.join('.teamai', spec.worktreeDirname)}`;
  for (const checkout of await checkoutsOfBranch(spec, git)) {
    // resolve: git prints forward slashes on Windows too.
    if (!path.resolve(checkout).endsWith(oldSuffix) || path.resolve(checkout) === path.resolve(wt)) continue;
    try {
      await git.raw(['worktree', 'remove', checkout]);
      log.debug(`[${spec.logTag}] removed the old checkout at ${checkout}`);
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0];
      refuse(new CheckoutRefusedError(
        `${checkout} still has ${spec.branch} checked out, and git will not remove it (${reason}). ` +
          `teamai now keeps that checkout at ${wt}, shared by every checkout of this repo. ` +
          `Commit or move the uncommitted changes in ${checkout} (or unlock it, if git says it is locked), ` +
          'or delete it by hand, which loses those uncommitted changes, then run the command again.',
        `an old ${spec.branch} checkout is in the way; see the warning above`,
      ));
    }
  }
}

/** The checkouts of this branch the repository behind `git` registers (git allows one). */
async function checkoutsOfBranch(spec: BranchWorktreeSpec, git: SimpleGit): Promise<string[]> {
  const listing = await git.raw(['worktree', 'list', '--porcelain']);
  const checkouts: string[] = [];
  for (const entry of listing.split('\n\n')) {
    const lines = entry.split('\n');
    const checkout = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
    if (checkout !== undefined && branch === `refs/heads/${spec.branch}`) checkouts.push(checkout);
  }
  return checkouts;
}

/**
 * Where this repository has the branch checked out, wherever that is: the
 * shared checkout, or one an older teamai left in a checkout's `.teamai/`.
 * Null when it has none, or no branch worktrees at all. Never another
 * repository's checkout, since it is this repository's own registration.
 */
async function registeredCheckoutImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<string | null> {
  if (!usesBranchWorktree(localConfig)) return null;
  const [checkout] = await checkoutsOfBranch(spec, createGitWithBlockTimeout(gitRoot(localConfig)));
  return checkout ?? null;
}

/** Whether the managed path is registered to this repository for this branch. */
async function ownsCheckoutImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<boolean> {
  if (!usesBranchWorktree(localConfig)) return false;
  const wt = worktreePath(spec, localConfig);
  if (!(await pathExists(wt))) return false;
  const registered = await registeredCheckoutImpl(spec, localConfig);
  return registered !== null && (await fse.realpath(registered)) === (await fse.realpath(wt));
}

/**
 * Remove this repository's side-branch checkout before its dedicated clone is
 * replaced. Push first so a clean checkout with local-only commits is not
 * silently discarded; dirty or unprovable checkouts are left untouched.
 */
async function retireImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  whileLocked: () => Promise<void> = async () => {},
): Promise<void> {
  if (!usesBranchWorktree(localConfig)) return;
  await withLockImpl(spec, localConfig, async () => {
    await retireWhileLockedImpl(spec, localConfig);
    await whileLocked();
  });
}

/** Retire one checkout after its writer lock has already been acquired. */
async function retireWhileLockedImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<void> {
  const wt = worktreePath(spec, localConfig);
    if (await pathExists(wt)) {
      await checkOwnerImpl(spec, localConfig);
      const registered = await registeredCheckoutImpl(spec, localConfig);
      if (registered === null || (await fse.realpath(registered)) !== (await fse.realpath(wt))) {
        throw new ForeignCheckoutError(
          `${wt} exists but is not registered to ${gitRoot(localConfig)} as its ${spec.branch} checkout. ` +
            'teamai left it and the current clone unchanged. Move it aside, or delete it if it holds nothing you need, ' +
            'then run init again.',
          `the ${spec.branch} checkout cannot be shown to belong to this repository; see the warning above`,
        );
      }

      const wtGit = createGitWithBlockTimeout(wt);
      if (!(await wtGit.status()).isClean()) {
        throw new CheckoutRefusedError(
          `${wt} has uncommitted changes, so teamai left it and the current clone unchanged. ` +
            'Commit or move those changes, then run init again.',
          `the ${spec.branch} checkout has uncommitted changes; see the warning above`,
        );
      }

      const remoteExists = await remoteBranchExists(spec, wt);
      if (remoteExists === null) {
        throw new CheckoutRefusedError(
          `Could not inspect origin/${spec.branch} before replacing the clone. ` +
            'The checkout and current clone were left unchanged; restore network access, then run init again.',
          `the ${spec.branch} checkout could not be compared with origin; see the warning above`,
        );
      }

      let localOnly = 1;
      let remoteOnly = 0;
      if (remoteExists) {
        await fetchTrackingRef(wtGit, spec.branch);
        [localOnly, remoteOnly] = (await wtGit.raw([
          'rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${spec.branch}`,
        ])).trim().split(/\s+/).map(Number);
      }

      if (localOnly > 0 && remoteOnly > 0) {
        throw new CheckoutRefusedError(
          `${wt} and origin/${spec.branch} have diverged, so teamai left the checkout and current clone unchanged. ` +
            'Reconcile and push the branch, then run init again.',
          `the ${spec.branch} checkout has diverged from origin; see the warning above`,
        );
      }

      if (localOnly > 0) {
        try {
          await wtGit.push(['--progress', 'origin', `HEAD:refs/heads/${spec.branch}`]);
        } catch (e) {
          throw new CheckoutRefusedError(
            `Could not preserve ${wt} on origin before replacing the clone (${failureReason(e).trim()}). ` +
              'The checkout and current clone were left unchanged; push its commits or restore network access, then run init again.',
            `the ${spec.branch} checkout could not be pushed; see the warning above`,
          );
        }
      }

      await createGitWithBlockTimeout(gitRoot(localConfig)).raw(['worktree', 'remove', wt]);
      log.info(`Retired ${spec.branch} checkout at ${wt}`);
    }
}

/** Run while holding this branch's writer lock. */
async function withLockImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig, action: () => Promise<void>): Promise<void> {
  const wt = worktreePath(spec, localConfig);
  const lockPath = lockFilePath(spec, localConfig);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    throw new CheckoutRefusedError(
      `${wt} is being written (${lockPath} is held), so teamai left it and the current clone unchanged. ` +
        'Run init again when that command finishes.',
      `the ${spec.branch} checkout is busy; see the warning above`,
    );
  }
  try {
    await action();
  } finally {
    await releaseLock(lockPath);
  }
}

/** Whether this repository owns a side checkout with uncommitted changes. */
async function dirtyImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<boolean> {
  if (!usesBranchWorktree(localConfig)) return false;
  const wt = worktreePath(spec, localConfig);
  if (!(await pathExists(wt))) return false;
  await checkOwnerImpl(spec, localConfig);
  const registered = await registeredCheckoutImpl(spec, localConfig);
  if (registered === null || (await fse.realpath(registered)) !== (await fse.realpath(wt))) return false;
  return !(await createGitWithBlockTimeout(wt).status()).isClean();
}

/**
 * Self and git mode keep this checkout at the same path in the partition
 * (#808), so after a project switches mode, the checkout there may belong to
 * the other repository: using it would publish to the wrong remote. Refuse it,
 * and never remove it: it is the other install's.
 */
async function refuseForeignCheckout(spec: BranchWorktreeSpec, wt: string, repoRoot: string): Promise<void> {
  const [owner, expected] = await Promise.all([commonDir(wt), commonDir(repoRoot)]);
  if (owner === expected) return;
  refuseCheckoutOf(spec, wt, repoRoot, owner);
}

/**
 * A checkout git cannot open is this repo's only when its files lead to the
 * repo's git dir through a live registration, which ensure recreates. Refuse
 * any other, and never remove it: its `.git` may lead to a repository that was
 * moved, deleted or cloned again (init reclones another team repo at the same
 * path), so its uncommitted files may be another install's.
 */
async function refuseUnprovenCheckout(spec: BranchWorktreeSpec, wt: string, repoRoot: string): Promise<void> {
  const [owner, expected] = await Promise.all([commonDirFromFiles(wt), commonDirFromFiles(repoRoot)]);
  if (owner !== null && owner === expected) return;
  refuseCheckoutOf(spec, wt, repoRoot, expected === null ? null : owner);
}

/** Refuse the checkout at `wt`: another repository's (`owner`), or one whose repository is unknown (null). */
function refuseCheckoutOf(spec: BranchWorktreeSpec, wt: string, repoRoot: string, owner: string | null): never {
  if (owner === null) {
    refuse(new ForeignCheckoutError(
      `${wt} is a ${spec.branch} checkout teamai cannot show to be ${repoRoot}'s: git cannot open it, ` +
        'and its .git does not lead to a registration in that repository (the repository it came from may ' +
        'have been moved, deleted, or cloned again). ' +
        'teamai will not use or remove it. Move it aside, or delete it if it holds nothing you need, ' +
        'then run the command again.',
      `the ${spec.branch} checkout cannot be shown to belong to this repository; see the warning above`,
    ));
  }
  const ownerRepo = path.basename(owner) === '.git' ? path.dirname(owner) : owner;
  refuse(new ForeignCheckoutError(
    `${wt} is a ${spec.branch} checkout of ${ownerRepo}, not of ${repoRoot}, left by an install in another mode. ` +
      `teamai will not use or remove it. Remove it with \`git -C ${ownerRepo} worktree remove ${wt}\`, ` +
      'then run the command again.',
    `the ${spec.branch} checkout belongs to another repository; see the warning above`,
  ));
}

/**
 * A side-branch checkout teamai will not use until the member acts. `message`
 * says what and how, and is warned once (see refuse); `summary` is the short
 * reason a caller quotes, so the long one is not printed twice.
 */
export class CheckoutRefusedError extends Error {
  override name = 'CheckoutRefusedError';
  constructor(message: string, readonly summary: string) {
    super(message);
  }
}

/** The reason a failed side-branch write reports: short for a refusal that was warned, whole otherwise. */
export function failureReason(e: unknown): string {
  if (e instanceof CheckoutRefusedError && warnedRefusals.has(e.message)) return e.summary;
  return e instanceof Error ? e.message : String(e);
}

/** A failed write; `refused` when a checkout refusal stopped it, which every retry meets until the member acts. */
function failedWith(e: unknown): PublishResult {
  return { status: 'failed', reason: failureReason(e), refused: e instanceof CheckoutRefusedError || undefined };
}

/**
 * The side-branch checkout belongs to another repository, or cannot be shown
 * to belong to this one (see refuseCheckoutOf). Unlike other side-branch
 * failures it is not best-effort: every path under the checkout may be another
 * install's, so a caller must not read or write them.
 */
export class ForeignCheckoutError extends CheckoutRefusedError {
  override name = 'ForeignCheckoutError';
}

/**
 * Refuse the checkout when one exists and is not provably this repository's;
 * no checkout, or a stale one this repository still registers, passes (ensure
 * recreates it).
 * For callers that read the checkout's paths without ensuring it, such as an
 * index build.
 */
async function checkOwnerImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<void> {
  if (!usesBranchWorktree(localConfig)) return;
  const wt = worktreePath(spec, localConfig);
  if (!(await isGitRepo(wt))) return;
  if (!(await gitOpensCheckout(wt))) {
    await refuseUnprovenCheckout(spec, wt, gitRoot(localConfig));
    return;
  }
  await refuseForeignCheckout(spec, wt, gitRoot(localConfig));
}

/**
 * Whether git opens `wt` as a checkout. Where it sits, already asked this run
 * and still the same repository on disk, answers without starting git.
 */
async function gitOpensCheckout(wt: string): Promise<boolean> {
  if (await checkoutLocation(wt) !== null) return true;
  return createGitWithBlockTimeout(wt).revparse(['--is-inside-work-tree']).then(() => true, () => false);
}

/** The repository's shared git directory, resolved: every worktree of one repo agrees on it. */
async function commonDir(dir: string): Promise<string> {
  // Asked once per directory and run: ensure and the index build both check every checkout.
  const found = await gitCommonDir(dir);
  if (found !== null) return found;
  // Asked again for git's own error, which the refusal shows.
  const out = (await createGitWithBlockTimeout(dir).revparse(['--git-common-dir'])).trim();
  return fse.realpath(path.resolve(dir, out));
}

/**
 * The same shared git directory, read from the files git writes instead of
 * from a git process: a `.git` directory is it; a `.git` file names the
 * worktree's gitdir, whose `commondir` leads to it. A linked worktree's gitdir
 * (`<common>/worktrees/<name>`) without that file proves nothing: its
 * registration is gone, and a repository cloned again at `<common>`'s path is
 * not the one that checkout came from. Null when it cannot be read that way.
 */
async function commonDirFromFiles(dir: string): Promise<string | null> {
  const dotGit = path.join(dir, '.git');
  try {
    if ((await fse.stat(dotGit)).isDirectory()) return await fse.realpath(dotGit);
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fse.readFile(dotGit, 'utf-8'));
    if (!pointer) return null;
    const gitDir = path.resolve(dir, pointer[1].trim());
    const common = await fse.readFile(path.join(gitDir, 'commondir'), 'utf-8').catch(() => null);
    if (common !== null) return await fse.realpath(path.resolve(gitDir, common.trim()));
    if (path.basename(path.dirname(gitDir)) === 'worktrees') return null;
    return await fse.realpath(gitDir);
  } catch {
    return null;
  }
}

/**
 * Whether the checkout there is not provably this repository's, judged from
 * git's files alone, for paths that must not start a git process (hooks). No
 * checkout (no `.git`) is not judged foreign; one whose `.git`, or the repo's
 * git dir, cannot be read is.
 */
async function isForeignByFilesImpl(spec: BranchWorktreeSpec, localConfig: LocalConfig): Promise<boolean> {
  if (!usesBranchWorktree(localConfig)) return false;
  const wt = worktreePath(spec, localConfig);
  if (!(await pathExists(path.join(wt, '.git')))) return false;
  const [owner, expected] = await Promise.all([commonDirFromFiles(wt), commonDirFromFiles(gitRoot(localConfig))]);
  return owner === null || owner !== expected;
}

/**
 * Fail with a message the member acts on. Callers that treat a side-branch
 * failure as non-fatal only log it at debug, so it is warned here too, once
 * per process however often a command retries. A silent run (a hook, the task
 * list of `import --from-mr`) prints nothing, so its refusal is not counted as
 * warned and failureReason gives the whole message.
 */
const warnedRefusals = new Set<string>();
function refuse(error: Error): never {
  if (!isSilent() && !warnedRefusals.has(error.message)) {
    warnedRefusals.add(error.message);
    log.warn(error.message);
  }
  throw error;
}

/**
 * Create an orphan-branch worktree. Uses the modern `--orphan` flag (git 2.42+)
 * and falls back to the detach + `checkout --orphan` dance for older git.
 */
async function createOrphanWorktree(spec: BranchWorktreeSpec, repoRoot: string, wt: string): Promise<void> {
  const git = createGitWithBlockTimeout(repoRoot);
  try {
    // git 2.42+: create a worktree on a fresh orphan branch directly.
    // The branch name must be given via -b; a positional after <path> is treated
    // as a commit-ish and errors ("--orphan and commit-ish cannot be used together").
    await git.raw(['worktree', 'add', '--orphan', '-b', spec.branch, wt]);
    // The --orphan worktree may inherit the index/files from HEAD in some git
    // versions; clear tracked entries so the branch starts empty.
    const wtGit = createGitWithBlockTimeout(wt);
    try {
      await wtGit.raw(['rm', '-rf', '--cached', '.']);
    } catch {
      // nothing staged — fine
    }
    await clearWorktreeFiles(wt);
  } catch {
    // Older git (<2.42): detach a worktree at HEAD, then orphan-checkout inside it.
    await git.raw(['worktree', 'add', '--detach', wt, 'HEAD']);
    const wtGit = createGitWithBlockTimeout(wt);
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
// Init pushes are non-blocking (init completes and writes local config + skills
// regardless); a failed push is retried on the next init. Bounding retries to 1
// during init prevents a stuck remote from holding init for 5× the timeout via
// the push/fetch/rebase retry loop.
const INIT_PUSH_MAX_RETRIES = 1;

export interface BranchWrite {
  files: string[];
  message: string;
}

/** Options threaded through commitAndPushAt and its callers. */
export interface BranchPushOptions {
  pushIfUnchanged?: boolean;
  /** Push once, with no fetch + rebase retry (init pushes). */
  initPush?: boolean;
}

/** Commit `files` in an already-locked worktree and push them. */
async function commitAndPushAt(
  spec: BranchWorktreeSpec,
  wt: string,
  message: string,
  files: string[],
  options: BranchPushOptions = {},
): Promise<PublishResult> {
  const git = createGitWithBlockTimeout(wt);

  // Literal: a filename with `[` or `*` would otherwise stage whatever it matches as a pattern.
  await git.raw(['--literal-pathspecs', 'add', '--', ...files]);
  // Only `files`: the checkout may hold a file someone else staged, and it must
  // neither count as a change nor ride along in this commit. No paths would be the whole index.
  const staged = files.length === 0
    ? 0
    : (await git.raw(['--literal-pathspecs', 'diff', '--cached', '--no-renames', '--name-only', '-z', '--', ...files]))
      .split('\0').filter(Boolean).length;
  if (staged === 0 && !options.pushIfUnchanged && await nothingLeftToPush(git, spec)) {
    // Nothing to commit AND nothing to deliver. Those are two different things:
    // an earlier attempt may have committed exactly this content and failed to
    // push it, and a caller that reads "already present" drops the only durable
    // copy it has. Fall through to the push loop whenever that is in doubt.
    log.debug(`[${spec.logTag}] nothing to commit`);
    return { status: 'already-present' };
  }

  // A retry may reconstruct the same tree as a previously committed
  // but unconfirmed push. It still needs a push, without an empty commit.
  if (staged > 0) await commitSkippingHooks(git, message, files, { identityFallback: true });

  // Push with fetch+rebase retry. Each member only writes <user>.yaml, so
  // rebase conflicts are effectively impossible; retries handle the pure
  // non-fast-forward race.
  const maxRetries = options.initPush ? INIT_PUSH_MAX_RETRIES : MAX_PUSH_RETRIES;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // A push that resolves is a push the remote accepted: git exits non-zero
      // when it refuses one. Do NOT re-check the remote-tracking ref here — it
      // is only updated through the remote's fetch refspec, so a `--single-branch`
      // clone would report failure for every successful side-branch push.
      const trackingRef = `refs/remotes/origin/${spec.branch}`;
      const before = await git.revparse(['--verify', trackingRef]).then(r => r.trim()).catch(() => '');
      const sent = (await git.revparse([`refs/heads/${spec.branch}`])).trim();
      await git.push(['--progress', 'origin', spec.branch]);
      // A narrow fetch refspec does not update this ref on push. Record only
      // the commit actually accepted by origin, never an unpushed worktree HEAD.
      // Compare-and-swap preserves a newer concurrent fetch (and a normal push
      // may already have updated the ref). Failure cannot undo delivery.
      await git.raw(['update-ref', trackingRef, sent, before || '0'.repeat(sent.length)])
        .catch(() => { /* Another updater owns the newer tracking snapshot. */ });
      return { status: 'published' };
    } catch (pushErr) {
      // Killed by the block timeout: origin stopped answering, which no
      // fetch + rebase fixes, and each retry would wait on it again.
      const stalled = pushErr instanceof GitPluginError && pushErr.plugin === 'timeout';
      if (attempt === maxRetries || stalled) {
        log.debug(`[${spec.logTag}] push failed after ${attempt} attempts: ${(pushErr as Error).message}`);
        return { status: 'failed', reason: (pushErr as Error).message };
      }
      // The commit took only `files`: anything else staged or modified would
      // make git refuse to rebase, on this attempt and every later one.
      let carried: string | null = null;
      try {
        await fetchTrackingRef(git, spec.branch);
        carried = await snapshotDirtyTree(spec, git);
        if (carried) await git.raw(['reset', '--hard', 'HEAD']);
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
      if (carried) await applyDirtySnapshot(spec, git, carried);
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
  options: BranchPushOptions = {},
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
    return failedWith(e);
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Handed to an `update()` write callback as its second argument.
 */
export interface BranchWriteContext {
  /**
   * Register work that must run only after the publish is DELIVERED (see
   * {@link isDelivered}) and still under the branch lock, before any other
   * writer can enter. The one user today: clearing the local vote deltas a
   * stage wrote into the worktree — running that clear outside the lock lets a
   * concurrent sync stage the same deltas between this publish and the clear,
   * adding them twice (#1027). Never runs on `busy`/`failed`, and an exception
   * in it is logged, never failing the already-confirmed publish.
   */
  onDelivered(fn: () => Promise<void>): void;
}

/**
 * Under this branch's lock: sync the worktree with origin, run `write`, commit,
 * push. The callback does not run when the lock is busy.
 *
 * `write` receives the worktree root (plus a context to register
 * `onDelivered` work) and returns the worktree-relative paths it touched, or
 * null when it decided there was nothing to write and nothing to push.
 */
async function updateImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  write: (worktree: string, ctx: BranchWriteContext) => Promise<BranchWrite | null>,
  options: BranchPushOptions & EnsureWorktreeOptions = {},
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
    const { wt, current } = await openWorktree(spec, localConfig, options);
    try {
      if (!current) await syncWorktree(spec, wt);
    } catch (e) {
      log.debug(`[${spec.logTag}] sync before write failed, writing onto the local copy: ${(e as Error).message}`);
    }

    let delivered: (() => Promise<void>) | undefined;
    const change = await write(wt, {
      onDelivered: (fn) => {
        if (!delivered) delivered = fn;
      },
    });
    // null writes and pushes nothing, so a read or a refusal under the lock stays without effect on origin. An empty
    // list still asks commitAndPushAt, which pushes a commit an earlier attempt left unpushed.
    const result: PublishResult = change === null
      ? { status: 'already-present' }
      : await commitAndPushAt(spec, wt, change.message, change.files, options);
    if (delivered && isDelivered(result)) {
      try {
        await delivered();
      } catch (e) {
        log.debug(`[${spec.logTag}] onDelivered hook failed (deltas stay pending): ${(e as Error).message}`);
      }
    }
    return result;
  } catch (e) {
    log.debug(`[${spec.logTag}] update failed (non-blocking): ${(e as Error).message}`);
    return failedWith(e);
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
 * aborted by the caller instead. Returns the status it read when it changed
 * nothing, or null.
 */
async function restoreConflictedFiles(spec: BranchWorktreeSpec, git: SimpleGit): Promise<StatusResult | null> {
  let status: StatusResult;
  try {
    status = await git.status();
  } catch {
    return null;
  }
  const conflicted = status.conflicted ?? [];
  if (conflicted.length === 0) {
    return status;
  }
  if (await rebaseInProgress(git)) {
    return status;
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
  return null;
}

/**
 * Snapshot dirty tracked files without touching `refs/stash` (`git stash create`
 * returns a dangling commit). `git rebase --autostash` would push onto the
 * shared stash list, which other worktrees of this repo also see.
 */
async function snapshotDirtyTree(spec: BranchWorktreeSpec, git: SimpleGit): Promise<string | null> {
  try {
    const sha = (await git.raw(['stash', 'create'])).trim();
    // In debug.log, so a run killed before the snapshot is applied again can be recovered by hand.
    if (sha.length > 0) log.debug(`[${spec.logTag}] uncommitted files saved as ${sha}; git stash apply --index ${sha} restores them`);
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

async function applyDirtySnapshot(spec: BranchWorktreeSpec, git: SimpleGit, sha: string): Promise<void> {
  try {
    // `--index` keeps what was staged staged. It refuses, touching nothing,
    // when the staged changes no longer apply; then restore the files alone.
    await git.raw(['stash', 'apply', '--index', sha]);
    return;
  } catch {
    try {
      await git.raw(['stash', 'apply', sha]);
    } catch {
      // apply conflicts leave unmerged paths; restoreConflictsFromSnapshot resolves them
    }
  }
  const conflicted = await restoreConflictsFromSnapshot(spec, git, sha);
  if (conflicted !== null) await restageSnapshotIndex(spec, git, sha, conflicted);
}

/**
 * Resolve each stash-apply conflict to the snapshot's own copy of the path,
 * left unstaged: its file, or no file where the snapshot had removed it (the
 * version that removes is origin's, which HEAD holds). Unlike
 * restoreConflictedFiles this needs no `--theirs` side, which a removal lacks,
 * and on failure it resets nothing: it names the snapshot to restore from.
 * Returns the conflicted paths, or null when they could not be resolved.
 */
async function restoreConflictsFromSnapshot(spec: BranchWorktreeSpec, git: SimpleGit, sha: string): Promise<string[] | null> {
  let conflicted: string[] = [];
  try {
    conflicted = (await git.status()).conflicted ?? [];
    if (conflicted.length === 0) return [];
    const inSnapshot = new Set((await git.raw(['--literal-pathspecs', 'ls-tree', '-z', '--name-only', sha, '--', ...conflicted])).split('\0').filter(Boolean));
    const kept = conflicted.filter((p) => inSnapshot.has(p));
    const removed = conflicted.filter((p) => !inSnapshot.has(p));
    if (kept.length > 0) await git.raw(['--literal-pathspecs', 'checkout', sha, '--', ...kept]);
    if (removed.length > 0) await git.raw(['--literal-pathspecs', 'rm', '-q', '-f', '--', ...removed]);
    await git.raw(['--literal-pathspecs', 'reset', '-q', 'HEAD', '--', ...conflicted]);
    return conflicted;
  } catch (e) {
    const wt = await git.raw(['rev-parse', '--show-toplevel']).then((out) => out.trim(), () => spec.worktreeDirname);
    log.warn(
      `Could not restore uncommitted files in ${wt} after updating from origin (${failureReason(e)})` +
        (conflicted.length > 0 ? `; ${conflicted.join(', ')} may hold conflict markers` : '') +
        `. Nothing was discarded: commit ${sha} holds them as they were; read one with git -C "${wt}" show ${sha}:<file>, ` +
        `or run git -C "${wt}" stash apply --index ${sha} once the conflicts are cleared.`,
    );
    return null;
  }
}

/** A tree entry, as `ls-tree` prints it. */
type TreeEntry = { mode: string; id: string };

/**
 * After a plain `stash apply`, put back what the snapshot had staged, and only
 * where that is provably the same staging:
 *  - origin did not change the path: its staged entry is restored as it was,
 *    so a file staged in part stays staged in part;
 *  - origin changed it, the apply merged without a conflict, and the file holds
 *    exactly what was staged: staged again.
 * Anything else stays unstaged, its content untouched, and is named in a
 * warning: staging a conflicted path again would stage a revert of origin's change.
 */
async function restageSnapshotIndex(spec: BranchWorktreeSpec, git: SimpleGit, sha: string, conflicted: readonly string[]): Promise<void> {
  let wt: string;
  let paths: string[];
  let base: Map<string, TreeEntry>;
  let staged: Map<string, TreeEntry>;
  let head: Map<string, TreeEntry>;
  try {
    wt = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    // A `stash create` commit: first parent is HEAD at the time, second parent is the index.
    paths = (await git.raw(['diff', '--name-only', '--no-renames', '-z', `${sha}^1`, `${sha}^2`])).split('\0').filter(Boolean);
    if (paths.length === 0) return;
    const entries = async (rev: string): Promise<Map<string, TreeEntry>> => {
      const listing = await git.raw(['--literal-pathspecs', 'ls-tree', '-z', rev, '--', ...paths]);
      // `<mode> <type> <id>\t<path>`
      return new Map(listing.split('\0').filter(Boolean).map((line) => {
        const [meta, p] = line.split('\t');
        const [mode, , id] = meta.split(' ');
        return [p, { mode, id }];
      }));
    };
    base = await entries(`${sha}^1`);
    staged = await entries(`${sha}^2`);
    head = await entries('HEAD');
  } catch (e) {
    log.warn(
      `Could not tell which files were staged before updating from origin (${failureReason(e)}); ` +
        `a staged change may now be unstaged, its content kept. git stash apply --index ${sha} in that checkout restores the staging.`,
    );
    return;
  }

  const stage = async (p: string, entry: TreeEntry | undefined, exact: boolean): Promise<void> => {
    if (entry === undefined) await git.raw(['update-index', '--force-remove', '--', p]);
    else if (exact) await git.raw(['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.id},${p}`]);
    else await git.raw(['--literal-pathspecs', 'add', '--', p]);
  };
  const sameEntry = (a: TreeEntry | undefined, b: TreeEntry | undefined): boolean => a?.mode === b?.mode && a?.id === b?.id;

  const unstaged: string[] = [];
  for (const p of paths) {
    const entry = staged.get(p);
    try {
      if (sameEntry(head.get(p), base.get(p))) {
        await stage(p, entry, true);
        continue;
      }
      const abs = path.join(wt, p);
      const current = (await pathExists(abs)) ? (await git.raw(['hash-object', '--', abs])).trim() : undefined;
      if (conflicted.includes(p) || current !== entry?.id) unstaged.push(p);
      else await stage(p, entry, false);
    } catch (e) {
      log.debug(`[${spec.logTag}] cannot stage ${p} again: ${failureReason(e)}`);
      unstaged.push(p);
    }
  }
  if (unstaged.length > 0) {
    log.warn(
      `Origin changed files that were staged in ${wt}: ${unstaged.join(', ')}. They keep your content, unstaged. ` +
        `Compare them with origin's version using git -C "${wt}" diff HEAD, then stage what you mean to keep.`,
    );
  }
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
  const git = createGitWithBlockTimeout(wt);
  const upstream = `origin/${spec.branch}`;
  try {
    // Explicit refspec so the `merge --ff-only`/`rebase` against origin/<branch>
    // below sees fresh commits even in a --single-branch clone (#706).
    await fetchTrackingRef(git, spec.branch);
  } catch (e) {
    log.debug(`[${spec.logTag}] fetch failed, using the local copy: ${(e as Error).message}`);
    return;
  }

  // Counted while conflicted files are restored, which never moves HEAD; the
  // restore finishes first, so a failed count never leaves it writing unlocked.
  const counting = git.raw(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
  counting.catch(() => undefined);
  const status = await restoreConflictedFiles(spec, git) ?? await git.status();
  const counts = await counting;
  const dirty = !status.isClean();
  const [behind, ahead] = counts.trim().split(/\s+/).map((count) => Number.parseInt(count, 10));
  // Already at origin's commit: nothing to fast-forward or rebase, uncommitted files stay as they are.
  if (behind === 0 && ahead === 0) return;

  let carried: string | null = null;
  if (dirty && ahead > 0) {
    carried = await snapshotDirtyTree(spec, git);
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
 * Read-only callers pass `pushIfCreated: false`. When the lock cannot be taken
 * (a write holds it, or it cannot be created), nothing is checked or touched
 * and the result is busy: a reader uses the local copy as-is, and a missing one
 * is left to that write. A caller that
 * rewrites the checkout must stop instead: it may be another repository's, or
 * still being created. Failed, with the cause, when the checkout could not be
 * created or synced: a reader uses what is there, and a caller that rewrites
 * it stops, as the checkout may not exist. Throws only CheckoutRefusedError,
 * when teamai will not use the checkout until the member acts. Only ever
 * touches the orphan-branch worktree, never the active tree.
 */
async function refreshImpl(
  spec: BranchWorktreeSpec,
  localConfig: LocalConfig,
  options: EnsureWorktreeOptions = {},
): Promise<RefreshResult> {
  if (!usesBranchWorktree(localConfig)) {
    return { status: 'done' };
  }

  const lockPath = lockFilePath(spec, localConfig);
  let locked = false;
  try {
    locked = await acquireLock(lockPath);
    if (!locked) {
      // Every checkout of a self-mode repo shares this path (#808): the holder
      // may be creating it right now.
      log.debug(`[${spec.logTag}] a write is in progress; reading the local copy`);
      return { status: 'busy', lockPath };
    }
    const { wt, current } = await openWorktree(spec, localConfig, options);
    if (!current) await syncWorktree(spec, wt);
  } catch (e) {
    // A refused checkout throws: the caller's paths are under it, or under the
    // checkout it keeps from being created.
    if (e instanceof CheckoutRefusedError) throw e;
    return { status: 'failed', reason: failureReason(e).trim() };
  } finally {
    if (locked) {
      await releaseLock(lockPath);
    }
  }
  return { status: 'done' };
}

/** What a refresh did; busy names the lock it could not take, failed why the checkout is not ready. */
export type RefreshResult =
  | { status: 'done' }
  | { status: 'busy'; lockPath: string }
  | { status: 'failed'; reason: string };

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
    write: (worktree: string, ctx: BranchWriteContext) => Promise<BranchWrite | null>,
    options?: BranchPushOptions & EnsureWorktreeOptions,
  ): Promise<PublishResult>;
  commitAndPush(
    localConfig: LocalConfig,
    message: string,
    files: string[],
    options?: BranchPushOptions,
  ): Promise<PublishResult>;
  refresh(localConfig: LocalConfig, options?: EnsureWorktreeOptions): Promise<RefreshResult>;
  /** Throws ForeignCheckoutError when the checkout there is not provably this repository's; creates nothing. */
  checkOwner(localConfig: LocalConfig): Promise<void>;
  /** True when the checkout there is not provably this repository's; reads git's files, runs no git. */
  isForeignByFiles(localConfig: LocalConfig): Promise<boolean>;
  /** Where this repository has the branch checked out, the old `.teamai/` place included; creates nothing. */
  registeredCheckout(localConfig: LocalConfig): Promise<string | null>;
  /** Whether the managed checkout path is registered to this repository. */
  ownsCheckout(localConfig: LocalConfig): Promise<boolean>;
  /** Whether this repository owns a side checkout with uncommitted changes. */
  isDirty(localConfig: LocalConfig): Promise<boolean>;
  /** Run an action while holding this branch's writer lock. */
  withLock(localConfig: LocalConfig, action: () => Promise<void>): Promise<void>;
  /** Retire this checkout while its writer lock is already held. */
  retireWhileLocked(localConfig: LocalConfig): Promise<void>;
  /** Push and remove this owned checkout, holding its writer lock through the optional replacement callback. */
  retire(localConfig: LocalConfig, whileLocked?: () => Promise<void>): Promise<void>;
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
    checkOwner: (localConfig) => checkOwnerImpl(spec, localConfig),
    isForeignByFiles: (localConfig) => isForeignByFilesImpl(spec, localConfig),
    registeredCheckout: (localConfig) => registeredCheckoutImpl(spec, localConfig),
    ownsCheckout: (localConfig) => ownsCheckoutImpl(spec, localConfig),
    isDirty: (localConfig) => dirtyImpl(spec, localConfig),
    withLock: (localConfig, action) => withLockImpl(spec, localConfig, action),
    retireWhileLocked: (localConfig) => retireWhileLockedImpl(spec, localConfig),
    retire: (localConfig, whileLocked) => retireImpl(spec, localConfig, whileLocked),
  };
}
