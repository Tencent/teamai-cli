/**
 * Publishing queued learnings: the one place that knows where a learning goes.
 *
 * `teamai contribute` writes to the durable queue and calls this. So does
 * `teamai pull`, which is what makes an offline or rejected contribution reach
 * the team later instead of being lost. A queue entry is dropped only once its
 * content is confirmed on origin, so a failure of any kind is always safe.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { SimpleGit } from 'simple-git';
import { z } from 'zod';

import { ensureDir, writeFileAtomic } from './fs.js';
import { parseFrontmatter } from './frontmatter.js';
import { createGit } from './git.js';
import { learningsBranch } from './learnings-branch.js';
import { CheckoutRefusedError, failureReason, fetchTrackingRef, type PublishResult } from './branch-worktree.js';
import { log } from './logger.js';
import {
  dropPendingLearning,
  listPendingForInstall,
  listPendingLearnings,
  readPendingForInstall,
  readPendingLearning,
  savePendingLearning,
} from './pending-learnings.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, SYNC_LOCK_FILENAME, type LocalConfig } from '../types.js';

export interface PublishQueueReport {
  /** Learnings confirmed on origin during this run, relative to `learnings/`. */
  published: string[];
  /** Learnings still queued afterwards. */
  remaining: number;
  /**
   * Why the queue did not drain, when it did not. Present only when something
   * is still queued because publishing failed, not when the queue was empty.
   */
  lastError?: string;
  /**
   * `lastError` is a checkout refusal: every pull meets it too, so the queue
   * stays until the member does what the refusal says.
   */
  refused?: true;
  /**
   * Why nothing was published at all: the install the command loaded is not
   * this queue's any more (init switched its kind, or its config moved away),
   * so the learnings stay where they are, for the install they belong to.
   */
  installChanged?: string;
}

function commitMessageFor(username: string): string {
  return `[teamai] Contribute session knowledge from ${username}`;
}

/**
 * Publish everything in the queue, as one commit. Best-effort and non-blocking:
 * it never throws, and a failure leaves every entry queued for the next run
 * rather than hammering an unreachable origin.
 */
export async function publishQueuedLearnings(
  localConfig: LocalConfig,
  username: string,
  options: { holdsSyncLock?: boolean; dryRun?: boolean } = {},
): Promise<PublishQueueReport> {
  // Publishing writes to the team clone, which `pull` and `push` guard with the
  // partition sync lock. On contention nothing is lost and nothing is forced:
  // the learnings stay queued and the run that holds the lock publishes them.
  // `pull` already holds the lock when it calls this, and the lock is not
  // reentrant, so it says so instead of deadlocking against itself.
  const syncLock = options.holdsSyncLock ? null : syncLockPath(localConfig);
  const locked = syncLock === null || await acquireLock(syncLock);
  try {
    return await publishUnderSyncLock(localConfig, username, locked, options.dryRun === true);
  } finally {
    if (syncLock && locked) await releaseLock(syncLock);
  }
}

async function publishUnderSyncLock(
  localConfig: LocalConfig,
  username: string,
  locked: boolean,
  dryRun: boolean,
): Promise<PublishQueueReport> {
  // Before the queue is read, which this adds to. Only under the sync lock:
  // two commands at once would each queue the same file.
  if (locked && !dryRun) await queueImportRemnants(localConfig);

  const listing = await listPendingForInstall(localConfig);
  switch (listing.status) {
    case 'listed':
      break;
    case 'busy':
      return {
        published: [],
        remaining: (await listPendingLearnings(localConfig)).length,
        lastError: `another teamai command holds ${listing.lockPath}`,
      };
    case 'changed':
      return {
        published: [],
        remaining: 0,
        installChanged: `this project's teamai install changed while this command ran (${listing.configPath} ${listing.cause})`,
      };
    default: {
      const unhandled: never = listing;
      throw new Error(`Unhandled queue listing: ${JSON.stringify(unhandled)}`);
    }
  }
  // What a maintenance run changed and could not publish goes first, and
  // whether or not anything is queued: rerunning maintenance finds nothing to change.
  if (locked && !dryRun) {
    const maintenance = await publishRecordedMaintenance(localConfig);
    if (maintenance.status === 'published') log.success('Published earlier maintenance changes to the learnings branch');
    else if (maintenance.status !== 'already-present') log.debug(`[learnings] recorded maintenance changes stay local: ${maintenance.status}`);
  }

  const queued = listing.queued;
  if (queued.length === 0) {
    return { published: [], remaining: 0 };
  }
  if (dryRun) return { published: [], remaining: queued.length };
  if (!locked) {
    log.debug('[learnings] a pull or push is in progress; leaving the queue for it');
    return {
      published: [],
      remaining: queued.length,
      lastError: 'another teamai pull or push is in progress',
    };
  }

  try {
    const report = await publishToLearningsBranch(localConfig, username, queued);

    for (const relPath of report.published) {
      await dropPendingLearning(localConfig, relPath);
    }
    return { ...report, remaining: queued.length - report.published.length };
  } catch (e) {
    // Never throw: a contribution is already safe in the queue, and publishing
    // it is never the reason a command fails.
    log.debug(`[learnings] publishing failed (non-blocking): ${(e as Error).message}`);
    return {
      published: [],
      remaining: queued.length,
      lastError: failureReason(e),
      refused: e instanceof CheckoutRefusedError || undefined,
    };
  }
}

/**
 * The partition sync lock, or null when this config cannot resolve one. A
 * `scope: 'project'` config without a project root is permitted by the schema,
 * and publishing must not be the thing that crashes on it: it just runs
 * unguarded, exactly as contribute always did.
 */
function syncLockPath(localConfig: LocalConfig): string | null {
  try {
    return path.join(getDataHome(localConfig), SYNC_LOCK_FILENAME);
  } catch {
    return null;
  }
}

/**
 * How `import --from-mr` in 0.25.0 to 0.26.0-beta.3 named the learning it wrote:
 * `<YYYY-MM-DD>-<title>.md`, the title part empty when no character of it was kept.
 */
const IMPORT_REMNANT_NAME = /^\d{4}-\d{2}-\d{2}-(.*)\.md$/;

/** The merge request a learning was extracted from, from its frontmatter. */
function sourceMr(frontmatter: Record<string, unknown>): string | null {
  const mr = frontmatter.source_mr;
  return typeof mr === 'string' && mr.trim() !== '' ? mr.trim() : null;
}

/**
 * Queue what `import --from-mr` (0.25.0 to 0.26.0-beta.3) wrote into the learnings checkout and
 * never committed (#823 item 7), so the publish that follows sends it. Such a
 * file never reached the team and, in single-repo mode, keeps git from removing
 * the checkout an older teamai left in `.teamai/`.
 *
 * Only that exact shape moves: untracked, directly under `learnings/`, named
 * `<date>-<title>.md`, with `source_mr` in its frontmatter. Nothing else in the
 * checkout is touched; a learning on the branch is tracked, edited or not, so it
 * never is. One is removed instead when origin's branch or the queue already has one
 * from the same merge request (a later import of it) or with the same content. The copy is queued before the original goes, so
 * a failure leaves it where it was. Never throws.
 */
async function queueImportRemnants(localConfig: LocalConfig): Promise<void> {
  try {
    const checkout = await learningsBranch.registeredCheckout(localConfig);
    if (checkout === null) return;
    const git = createGit(checkout);
    const lsFiles = async (args: string[]): Promise<string[]> =>
      (await git.raw(['ls-files', '-z', ...args, '--', 'learnings'])).split('\0').filter(Boolean);

    const remnants: Array<{ file: string; content: string; mr: string; title?: string }> = [];
    for (const rel of await lsFiles(['--others', '--exclude-standard'])) {
      // Directly under `learnings/`: those versions wrote nothing into a namespace.
      if (rel.split('/').length !== 2) continue;
      const named = IMPORT_REMNANT_NAME.exec(path.posix.basename(rel));
      if (!named) continue;
      const file = path.join(checkout, rel);
      // One that cannot be read, such as a dangling link, must not hold back the rest on every run.
      const content = await fs.promises.readFile(file, 'utf-8').catch((e: unknown) => {
        log.debug(`[learnings] cannot read ${file}: ${failureReason(e)}`);
        return null;
      });
      if (content === null) continue;
      const { data } = parseFrontmatter(content);
      const mr = sourceMr(data);
      if (mr === null) continue;
      const title = typeof data.title === 'string' && data.title.trim() ? data.title : named[1];
      remnants.push({ file, content, mr, title: title || undefined });
    }
    if (remnants.length === 0) return;

    // What already covers a remnant: a learning on origin, in any namespace,
    // or one in the queue. Origin itself, fetched just now, not the checkout:
    // the one an older teamai left in `.teamai/` is never synced again (#823
    // item 21), so it may lack what a teammate published since, or still track
    // a copy origin has deleted, and a remnant removed against that copy is
    // lost. Without a current origin every remnant stays for a later run.
    const known = await learningsOnOrigin(git);
    if (known === null) return;
    // The queue only while it is still this install's: after init switched the
    // project to another team repository, it holds that install's learnings, and
    // a remnant removed against one of them never reached this one's repository.
    const queue = await readPendingForInstall(localConfig);
    if (queue.status !== 'read') {
      log.debug(`[learnings] leaving what an older import --from-mr left for a later run: the queue is ${queue.status}`);
      return;
    }
    for (const { relPath, content } of queue.queued) {
      known.push({ label: `the contribution queue (${relPath})`, content, mr: sourceMr(parseFrontmatter(content).data) });
    }

    const { generateFilename, resolveLearningsSubdir } = await import('../contribute.js');
    const subdir = await resolveLearningsSubdir(localConfig);
    const queued: string[] = [];
    for (const remnant of remnants) {
      const covered = known.find((k) => k.content === remnant.content || k.mr === remnant.mr);
      if (covered) {
        if (!await removeRemnant(remnant.file)) continue;
        log.warn(`Removed ${remnant.file}, which an older teamai import --from-mr left unpublished: ${covered.label} already has it.`);
        continue;
      }
      const relPath = path.posix.join(subdir, generateFilename(remnant.title));
      const saved = await savePendingLearning(localConfig, relPath, remnant.content);
      if (saved.status !== 'saved') {
        log.debug(`[learnings] could not queue ${remnant.file}: ${saved.status}`);
        break;
      }
      // Queued even when it cannot go: the next run finds the queued copy and removes it then.
      await removeRemnant(remnant.file);
      queued.push(remnant.file);
      known.push({ label: `the contribution queue (${relPath})`, content: remnant.content, mr: remnant.mr });
    }
    if (queued.length > 0) {
      log.warn(`Queued ${queued.length} learning(s) an older teamai import --from-mr left unpublished: ${queued.join(', ')}`);
    }
  } catch (e) {
    log.debug(`[learnings] could not queue what an older import --from-mr left: ${failureReason(e)}`);
  }
}

/** Whether the remnant is gone; a failure is logged and left for a later run. */
async function removeRemnant(file: string): Promise<boolean> {
  try {
    await fs.promises.rm(file, { force: true });
    return true;
  } catch (e) {
    log.debug(`[learnings] cannot remove ${file}: ${failureReason(e)}`);
    return false;
  }
}

/** A learning that already covers a remnant, and where it is. */
interface KnownLearning {
  label: string;
  content: string;
  mr: string | null;
}

/**
 * Every learning on origin's learnings branch, fetched just now. None when
 * origin has no learnings branch, as after an offline first publish. Null when
 * origin cannot be reached or read.
 */
async function learningsOnOrigin(git: SimpleGit): Promise<KnownLearning[] | null> {
  const ref = `origin/${learningsBranch.branch}`;
  try {
    try {
      await fetchTrackingRef(git, learningsBranch.branch);
    } catch (e) {
      // A fetch of a branch origin lacks fails too; ls-remote tells the two
      // apart, succeeding with no output only when origin answered without it.
      if ((await git.raw(['ls-remote', '--heads', 'origin', `refs/heads/${learningsBranch.branch}`])).trim() !== '') throw e;
      return [];
    }
    const files = (await git.raw(['ls-tree', '-r', '-z', '--name-only', ref, '--', 'learnings'])).split('\0').filter((f) => f.endsWith('.md'));
    const learnings: KnownLearning[] = [];
    for (const rel of files) {
      const content = await git.show([`${ref}:${rel}`]);
      learnings.push({ label: rel, content, mr: sourceMr(parseFrontmatter(content).data) });
    }
    return learnings;
  } catch (e) {
    log.debug(`[learnings] cannot read ${ref}; leaving what an older import --from-mr left for a later run: ${failureReason(e)}`);
    return null;
  }
}

/**
 * Publish whatever maintenance just changed in the learnings worktree, and
 * whatever an earlier run changed and could not publish.
 *
 * Pruning, promotion and confidence write-backs used to mutate a checkout
 * nothing pushes, so their result reached no teammate and the next realign
 * could undo it. They now write into the worktree, and this is what makes the
 * change leave the machine. The files are changed before the branch lock is
 * taken, and a rerun finds nothing left to change, so each run records what it
 * changed first and the record goes only once origin has it: a busy lock or a
 * failed push leaves it for the next publish, contributions and pulls included.
 */
export async function publishLearningsMaintenance(
  localConfig: LocalConfig,
  message: string,
  changed: readonly string[],
): Promise<PublishResult> {
  const checkout = learningsBranch.dir(localConfig);
  const inCheckout = changed
    .map((file) => path.relative(checkout, file))
    .filter((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (inCheckout.length < changed.length) {
    log.debug(`[learnings] maintenance changed files outside ${checkout}; not publishing those`);
  }
  if (!learningsBranch.enabled(localConfig)) {
    // kind: 'http' has no branch to retry against.
    return inCheckout.length === 0 ? { status: 'already-present' } : commitMaintenance(localConfig, message, inCheckout);
  }
  if (inCheckout.length > 0) {
    try {
      await recordMaintenance(checkout, { message, files: inCheckout });
    } catch (e) {
      log.debug(`[learnings] cannot record maintenance changes for a retry: ${failureReason(e)}`);
      return commitMaintenance(localConfig, message, inCheckout);
    }
  }
  return publishRecordedMaintenance(localConfig);
}

/** What one maintenance run changed, relative to the learnings checkout. */
const MaintenanceRecord = z.object({ message: z.string(), files: z.array(z.string()) });
type MaintenanceRecord = z.infer<typeof MaintenanceRecord>;

/**
 * Where maintenance records wait: in the checkout's own git directory, which
 * git never shows or commits and which goes with the checkout, and with the
 * changes they describe. One file per run, so a publish removes only what it read.
 */
async function maintenanceRecordsDir(checkout: string): Promise<string> {
  const gitPath = (await createGit(checkout).raw(['rev-parse', '--git-path', 'teamai-maintenance'])).trim();
  return path.resolve(checkout, gitPath);
}

async function recordMaintenance(checkout: string, record: MaintenanceRecord): Promise<void> {
  const dir = await maintenanceRecordsDir(checkout);
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}.json`;
  // Atomic: a record cut short by a crash would otherwise be read on every publish.
  await writeFileAtomic(path.join(dir, name), JSON.stringify(record));
}

/** Publish every recorded maintenance change, dropping the records once origin has them. Never throws. */
async function publishRecordedMaintenance(localConfig: LocalConfig): Promise<PublishResult> {
  const checkout = learningsBranch.dir(localConfig);
  try {
    if (!fs.existsSync(checkout)) return { status: 'already-present' };
    const dir = await maintenanceRecordsDir(checkout);
    const records: Array<MaintenanceRecord & { file: string }> = [];
    // `.json` only: an interrupted atomic write leaves a `.tmp` copy beside them.
    for (const name of (await fs.promises.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'))) {
      const file = path.join(dir, name);
      let text: string;
      try {
        text = await fs.promises.readFile(file, 'utf-8');
      } catch (e) {
        // A failed read says nothing about the record: keep it for a later publish.
        log.warn(`Cannot read maintenance record ${file} (${failureReason(e)}); it stays for the next publish.`);
        continue;
      }
      let problem: string;
      try {
        const parsed = MaintenanceRecord.safeParse(JSON.parse(text));
        if (parsed.success) {
          records.push({ ...parsed.data, file });
          continue;
        }
        problem = 'not a maintenance record';
      } catch (e) {
        problem = failureReason(e);
      }
      // Read and malformed, so no later publish can use it either, and it must
      // not hold back the others on every one.
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      log.warn(
        `Removed unreadable maintenance record ${file} (${problem}). A maintenance change it described ` +
          `that is not on the learnings branch stays uncommitted in ${checkout}; check with git -C "${checkout}" status.`,
      );
    }
    if (records.length === 0) return { status: 'already-present' };
    const message = records.length === 1 ? records[0].message : `[teamai] Publish ${records.length} learnings maintenance runs`;
    const result = await commitMaintenance(localConfig, message, [...new Set(records.flatMap((r) => r.files))]);
    if (result.status === 'published' || result.status === 'already-present') {
      for (const record of records) await fs.promises.rm(record.file, { force: true });
    }
    return result;
  } catch (e) {
    return { status: 'failed', reason: failureReason(e) };
  }
}

/**
 * Commit and push `files`, relative to the learnings checkout. Also pushes what
 * an earlier attempt committed, when none of them is left to stage.
 */
async function commitMaintenance(localConfig: LocalConfig, message: string, inCheckout: string[]): Promise<PublishResult> {
  // Only the files maintenance wrote or removed, never all of `learnings/`: the
  // checkout may hold files nobody committed, such as a learning an older
  // import --from-mr left there, and they would ride along in this commit (#823).
  const checkout = learningsBranch.dir(localConfig);
  // A removed file git does not track has nothing to stage, and naming it would
  // fail the whole `git add`, publishing nothing of this run: one it never
  // tracked, or one an earlier attempt already committed the removal of.
  const removed = inCheckout.filter((rel) => !fs.existsSync(path.join(checkout, rel)));
  let tracked = new Set<string>();
  if (removed.length > 0) {
    try {
      tracked = new Set((await createGit(checkout).raw(['--literal-pathspecs', 'ls-files', '-z', '--', ...removed])).split('\0').filter(Boolean));
    } catch (e) {
      // Not a checkout git can read, such as an HTTP install's cache: the same
      // non-fatal result commitAndPush gives, never a throw after the removal.
      return { status: 'failed', reason: failureReason(e) };
    }
  }
  const files = inCheckout.filter((rel) => !removed.includes(rel) || tracked.has(rel.split(path.sep).join('/')));
  // kind: 'http' has no branch an earlier attempt could have committed to.
  if (files.length === 0 && !learningsBranch.enabled(localConfig)) return { status: 'already-present' };
  // `commitAndPush`, not `update`: maintenance already wrote into the worktree
  // before this call, and `update` syncs with origin first, which can carry
  // those uncommitted files into a rebase or leave them behind.
  return learningsBranch.commitAndPush(localConfig, message, files);
}

/**
 * Write every queued learning into the `teamai-learnings` worktree and push it.
 *
 * One path for every git-backed repo: an independent clone and a single-repo
 * business repo differ only in where the worktree sits. Nothing touches the
 * default branch, so a member needs no write access to it, and nothing touches
 * the user's active working tree either.
 */
async function publishToLearningsBranch(
  localConfig: LocalConfig,
  username: string,
  queued: string[],
): Promise<Omit<PublishQueueReport, 'remaining'>> {
  const published: string[] = [];
  // An entry nobody can read will be skipped again on every run. Naming it is
  // the difference between "1 learning is not published" forever with no
  // reason, and something the member can act on.
  const unreadable: string[] = [];

  const result = await learningsBranch.update(localConfig, async (worktree) => {
    const files: string[] = [];
    for (const relPath of queued) {
      const content = await readPendingLearning(localConfig, relPath);
      if (content === null) {
        log.debug(`[learnings] skipping unreadable queue entry ${relPath}`);
        unreadable.push(relPath);
        continue;
      }
      const destAbs = path.join(worktree, 'learnings', relPath);
      await ensureDir(path.dirname(destAbs));
      await fs.promises.writeFile(destAbs, content, 'utf-8');
      files.push(path.posix.join('learnings', relPath.split(path.sep).join('/')));
      published.push(relPath);
    }
    if (files.length === 0) return null;
    return { files, message: commitMessageFor(username) };
  });

  const unreadableReason = unreadable.length > 0
    ? `cannot read ${unreadable.join(', ')} in the contribution queue`
    : undefined;

  switch (result.status) {
    case 'published':
      return { published, lastError: unreadableReason };
    case 'already-present':
      // The branch already carries exactly this content: an earlier run pushed
      // it and could not confirm. Dropping the queue entry now is safe.
      return { published, lastError: unreadableReason };
    case 'busy':
      return { published: [], lastError: 'another teamai write is in progress' };
    case 'failed':
      return { published: [], lastError: result.reason, refused: result.refused };
  }
}
