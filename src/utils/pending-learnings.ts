import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import { ensureDir, expandHome, listFilesRecursive, readFileSafe } from './fs.js';
import { normalizeRepoUrlForCompare, redactGitCredentials, remotesMatch } from './git.js';
import { log } from './logger.js';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, getTeamaiHomeDir, isSelfMode, LocalConfigSchema, type LocalConfig } from '../types.js';

/**
 * Durable queue of learnings a member has written but that are not published
 * yet. Every contribution lands here first, so nothing depends on the network,
 * on push rights, or on a git operation succeeding right now.
 *
 * It lives outside anything git rewrites:
 *  - git: beside the clone, where pullRepo's diverged `reset --hard` on the
 *    clone cannot reach it.
 *  - self: in the data home, outside the user's own product repo, where an
 *    untracked directory would show up in `git status` and be swept into a
 *    commit by `git add -A`. Not in the checkout's `.teamai/`: every checkout
 *    shares the queue, and a removed worktree takes its ignored files with it
 *    (#808).
 */
export function pendingLearningsDir(localConfig: LocalConfig): string {
  if (isSelfMode(localConfig)) {
    return path.join(getDataHome(localConfig), 'pending-learnings');
  }
  return path.join(path.dirname(localConfig.repo.localPath), 'pending-learnings');
}

/**
 * The lock that queue writes, the migration and init's install switch share for
 * the queue kept in `home`, the directory holding `pending-learnings/` and the
 * config that says whose queue it is. It lives under `~/.teamai/locks/`, not in
 * `home`: the migration renames a checkout's `.teamai/` away, and a lock inside
 * it would go with it, where a writer waiting on it would create the directory
 * again. A home that is gone resolves without its real path; nothing holds that
 * lock, and the writer then finds its config gone.
 */
export async function queueLockPath(home: string): Promise<string> {
  const real = await fs.promises.realpath(home).catch(() => path.resolve(home));
  const key = createHash('sha256').update(real).digest('hex').slice(0, 16);
  return path.join(getTeamaiHomeDir(), 'locks', `queue-${key}.lock`);
}

/** The directory `localConfig`'s queue is kept in, whose queue lock guards it. */
export function queueHome(localConfig: LocalConfig): string {
  return path.dirname(pendingLearningsDir(localConfig));
}

// Queue writes hold the lock for a file write; the migration holds it for a
// copy and a rename. Three seconds covers both without leaving a command stuck.
const QUEUE_LOCK_ATTEMPTS = 30;
const QUEUE_LOCK_RETRY_MS = 100;

/**
 * Take the queue lock of `home`, retrying while another command holds it.
 * `acquired` is false when it still does after the wait; the caller must
 * release `lockPath` otherwise.
 */
export async function acquireQueueLock(home: string): Promise<{ acquired: boolean; lockPath: string }> {
  const lockPath = await queueLockPath(home);
  for (let attempt = 1; ; attempt++) {
    if (await acquireLock(lockPath)) return { acquired: true, lockPath };
    if (attempt === QUEUE_LOCK_ATTEMPTS) return { acquired: false, lockPath };
    await new Promise((resolve) => setTimeout(resolve, QUEUE_LOCK_RETRY_MS));
  }
}

/** Run `fn` holding the queue lock of `home`, or report who holds it. */
export async function withQueueLock<T>(
  home: string,
  fn: () => Promise<T>,
): Promise<{ status: 'done'; value: T } | { status: 'busy'; lockPath: string }> {
  const { acquired, lockPath } = await acquireQueueLock(home);
  if (!acquired) return { status: 'busy', lockPath };
  try {
    return { status: 'done', value: await fn() };
  } finally {
    await releaseLock(lockPath);
  }
}

/**
 * Why the queue `localConfig` was loaded for is no longer its install's, or
 * null when it still is. Asked under the queue lock, since a command loads its
 * config long before it writes: the migration may have moved the config away
 * (it retired the checkout's `.teamai/`, or relocated the file), or `init`
 * pointed the project at another team repository, which would publish the
 * queue.
 */
async function installChanged(localConfig: LocalConfig): Promise<{ configPath: string; cause: string } | null> {
  const configPath = path.join(expandHome(getDataHome(localConfig)), 'config.yaml');
  const content = await readFileSafe(configPath);
  if (content === null) return { configPath, cause: 'is gone' };
  let raw: unknown;
  try {
    raw = YAML.parse(content);
  } catch {
    return { configPath, cause: 'cannot be read' };
  }
  const parsed = LocalConfigSchema.safeParse(raw);
  if (!parsed.success) return { configPath, cause: 'cannot be read' };
  const now = queueOwner(parsed.data);
  const loaded = queueOwner(localConfig);
  if (now.kind !== loaded.kind) return { configPath, cause: `now names a ${now.kind} install, not ${loaded.kind}` };
  if (!sameQueueOwner(now, loaded)) {
    return { configPath, cause: `now names ${redactGitCredentials(now.remote)}, not ${redactGitCredentials(loaded.remote)}` };
  }
  return null;
}

/**
 * Where a queued learning went, or why it was not saved: another command held
 * the queue lock for the whole wait, or the install this command loaded was
 * migrated or switched to another team repository while it waited.
 */
export type QueueWrite =
  | { status: 'saved'; path: string }
  | { status: 'busy'; lockPath: string }
  | { status: 'changed'; configPath: string; cause: string };

/** What a command that could not queue its learning tells the member. */
export function queueWriteRefusal(result: Exclude<QueueWrite, { status: 'saved' }>): string {
  switch (result.status) {
    case 'busy':
      return `Another teamai command is moving this project's queued learnings (${result.lockPath} is held). ` +
        'Nothing was saved. Run this again when it finishes.';
    case 'changed':
      return `This project's teamai install changed while this command ran (${result.configPath} ${result.cause}). ` +
        'Nothing was saved. Run this again.';
    default: {
      const unhandled: never = result;
      throw new Error(`Unhandled queue write: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Write a learning into the queue.
 *
 * @param relPath - Learning path RELATIVE to `learnings/` (e.g.
 *   `alpha-notes/foo-2026-01-01-ab12cd.md` for a project-namespaced learning, or
 *   `foo-....md` for a shared-root one). The namespace subdirectory is preserved
 *   here and when publishing, so a project contribution is never downgraded to a
 *   shared-root learning.
 */
export async function savePendingLearning(
  localConfig: LocalConfig,
  relPath: string,
  content: string,
): Promise<QueueWrite> {
  // Only the write is locked: the publish that follows takes the sync and
  // learnings locks, and no queue lock is held while waiting for another.
  const locked = await withQueueLock(queueHome(localConfig), async (): Promise<QueueWrite> => {
    const changed = await installChanged(localConfig);
    if (changed) return { status: 'changed', ...changed };
    const dest = path.join(pendingLearningsDir(localConfig), relPath);
    await ensureDir(path.dirname(dest));
    await fs.promises.writeFile(dest, content, 'utf-8');
    return { status: 'saved', path: dest };
  });
  return locked.status === 'done' ? locked.value : locked;
}

/**
 * The queue, as listPendingLearnings lists it, when it is still the queue of
 * the install `localConfig` was loaded from. A publish runs long after the
 * command loaded its config; had init switched the install meanwhile, the queue
 * would hold what the new install queued, and this one would publish it to the
 * previous repository. Listed under the queue lock, so nothing the switch
 * leaves in the queue is on the list.
 */
export async function listPendingForInstall(
  localConfig: LocalConfig,
): Promise<
  | { status: 'listed'; queued: string[] }
  | { status: 'busy'; lockPath: string }
  | { status: 'changed'; configPath: string; cause: string }
> {
  const locked = await withQueueLock(queueHome(localConfig), async () => {
    const changed = await installChanged(localConfig);
    if (changed) return { status: 'changed' as const, ...changed };
    return { status: 'listed' as const, queued: await listPendingLearnings(localConfig) };
  });
  return locked.status === 'done' ? locked.value : locked;
}

/**
 * Every queued learning's content, when the queue is still the install's that
 * `localConfig` was loaded from, as listPendingForInstall decides it. Read under
 * the queue lock, so no learning another install queued after a switch is read
 * as this one's. Unreadable entries are left out.
 */
export async function readPendingForInstall(
  localConfig: LocalConfig,
): Promise<
  | { status: 'read'; queued: Array<{ relPath: string; content: string }> }
  | { status: 'busy'; lockPath: string }
  | { status: 'changed'; configPath: string; cause: string }
> {
  const locked = await withQueueLock(queueHome(localConfig), async () => {
    const changed = await installChanged(localConfig);
    if (changed) return { status: 'changed' as const, ...changed };
    const queued: Array<{ relPath: string; content: string }> = [];
    for (const relPath of await listPendingLearnings(localConfig)) {
      const content = await readPendingLearning(localConfig, relPath);
      if (content !== null) queued.push({ relPath, content });
    }
    return { status: 'read' as const, queued };
  });
  return locked.status === 'done' ? locked.value : locked;
}

/**
 * Every queued learning, as paths relative to `learnings/`, oldest entries
 * included. Hidden files and anything that is not Markdown are ignored, so a
 * stray editor swap file never reaches the team repo.
 */
export async function listPendingLearnings(localConfig: LocalConfig): Promise<string[]> {
  return queuedLearningFiles(pendingLearningsDir(localConfig));
}

async function queuedLearningFiles(dir: string): Promise<string[]> {
  try {
    return (await listFilesRecursive(dir))
      .filter((relPath) => relPath.endsWith('.md'))
      .filter((relPath) => !relPath.split('/').some((segment) => segment.startsWith('.')));
  } catch {
    return [];
  }
}

/** Read one queued learning, or null when it is unreadable. */
export async function readPendingLearning(
  localConfig: LocalConfig,
  relPath: string,
): Promise<string | null> {
  try {
    return await fs.promises.readFile(path.join(pendingLearningsDir(localConfig), relPath), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Forget a queued learning. Only ever called once its content is confirmed on
 * origin: this copy is the only one that survives a worktree reset.
 */
export async function dropPendingLearning(
  localConfig: LocalConfig,
  relPath: string,
): Promise<void> {
  await fs.promises.rm(path.join(pendingLearningsDir(localConfig), relPath), { force: true });
}

/** The kind an install publishes to; a config written before `kind` existed is git. */
export function installKind(localConfig: LocalConfig): string {
  return localConfig.repo.kind ?? 'git';
}

/**
 * Whose queue it is: the kind and the team repository the install publishes
 * to (#823 item 13). Two installs of one team repository share it however its
 * URL is written; any other install would publish it to the wrong repository.
 */
export type QueueOwner = { kind: string; remote: string };

export function queueOwner(localConfig: LocalConfig): QueueOwner {
  return { kind: installKind(localConfig), remote: localConfig.repo.remote };
}

/** Same kind and team repository, ignoring credentials, protocol, `.git` and case (remotesMatch). */
export function sameQueueOwner(a: QueueOwner, b: QueueOwner): boolean {
  return a.kind === b.kind && remotesMatch(a.remote, b.remote);
}

/** How many learnings `dir` queues: its `.md` files, none under a dot segment. */
export async function countQueued(dir: string): Promise<number> {
  return (await queuedLearningFiles(dir)).length;
}

/**
 * Set a queue aside when a re-init switches the install to another kind (git
 * and self mode share the partition's `pending-learnings/`, #808) or another
 * team repository (#823 item 13): its learnings were written for the previous
 * install's repository, and the new one would publish them to its own. They
 * move to `pending-learnings.<kind>`, or `pending-learnings.<kind>-<repo>` for
 * another repository of the same kind, beside it (a free name, nothing is
 * overwritten or deleted) and the member is told how many and where. `save`
 * writes the new config. Returns the directory the queue moved to, or null
 * when nothing moved.
 */
export async function setAsideQueueOnModeSwitch(
  previous: LocalConfig | null,
  next: LocalConfig,
  save: () => Promise<void>,
): Promise<{ status: 'switched'; aside: string | null } | { status: 'busy'; lockPath: string }> {
  // The loaders return null both for a fresh install and for a config that
  // exists but cannot be read: that one names no owner, and the new install
  // would publish its queue to its own repository.
  const unreadable = path.join(queueHome(next), 'config.yaml');
  if (!previous && !fs.existsSync(unreadable)) {
    await save();
    return { status: 'switched', aside: null };
  }
  if (previous && sameQueueOwner(queueOwner(previous), queueOwner(next))) {
    await save();
    return { status: 'switched', aside: null };
  }
  // A command that loaded the previous config and queues meanwhile would put
  // its learning into the queue the new install publishes: it waits, then
  // finds the new install (savePendingLearning).
  const dir = previous ? pendingLearningsDir(previous) : pendingLearningsDir(next);
  const locked = await withQueueLock(queueHome(next), async () => {
    const aside = path.resolve(dir) === path.resolve(pendingLearningsDir(next))
      ? await setAside(dir, next, previous ? queueOwner(previous) : { unreadable })
      : null;
    await save();
    return aside;
  });
  return locked.status === 'done' ? { status: 'switched', aside: locked.value } : locked;
}

/**
 * Set aside the queue an older `from` install kept in a checkout's `.teamai/`
 * (#808), when the partition it would move into now serves `next`, another
 * install: `init` switched the project from another checkout, and `next` would
 * publish those learnings to its own repository. As a mode switch does.
 */
export async function setAsideCheckoutQueue(queue: string, next: LocalConfig, from: QueueOwner): Promise<string | null> {
  return setAside(queue, next, from);
}

/** Whose queue is set aside: a known install, or one whose config at `unreadable` cannot be read. */
type PreviousOwner = QueueOwner | { unreadable: string };

async function setAside(queue: string, next: LocalConfig, from: PreviousOwner): Promise<string | null> {
  const queued = await countQueued(queue);
  if (queued === 0) return null;
  const live = pendingLearningsDir(next);
  // Another kind is named by its kind, as before; another repository of the
  // same kind by that repository too, or the name would not tell them apart.
  // A config nothing can read names no owner.
  const repo = 'unreadable' in from ? '' : normalizeRepoUrlForCompare(from.remote).replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = 'unreadable' in from ? 'unknown'
    : from.kind === installKind(next) && repo ? `${from.kind}-${repo}` : from.kind;
  let aside = `${live}.${suffix}`;
  for (let n = 1; fs.existsSync(aside); n++) aside = `${live}.${suffix}.${n}`;
  // A checkout's queue may sit on another filesystem than the data home.
  await fse.move(queue, aside);
  const settle = `Nothing was deleted. If they belong here, move the files into ${live}; ` +
    'otherwise contribute them again from an install of that repository.';
  log.warn('unreadable' in from
    ? `Set aside ${queued} queued learning(s) in ${aside}: the previous install's config at ${from.unreadable} ` +
      `could not be read, so nothing says which repository they were written for, and this ` +
      `${installKind(next)} install would publish them to its own. ${settle}`
    : `Set aside ${queued} queued learning(s) from the previous ${from.kind} install in ${aside}: ` +
      `they were written for ${redactGitCredentials(from.remote) || 'that install\'s repository'}, and this ` +
      `${installKind(next)} install would publish them to its own. ${settle}`);
  return aside;
}

/**
 * Every queue in a data home with the learnings it holds: the live
 * `pending-learnings/` and any set aside by a mode switch. For telling the
 * member what deleting that data home would lose. The user one holds the
 * project partitions (`projects/<slug>/`), so their queues are listed too.
 */
export async function listQueuesIn(dataHome: string): Promise<Array<{ dir: string; count: number }>> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dataHome);
  } catch {
    return [];
  }
  const queues = [];
  for (const name of names.sort()) {
    if (name !== 'pending-learnings' && !name.startsWith('pending-learnings.')) continue;
    const dir = path.join(dataHome, name);
    const count = await countQueued(dir);
    if (count > 0) queues.push({ dir, count });
  }
  if (names.includes('projects')) {
    const projects = path.join(dataHome, 'projects');
    const slugs = await fs.promises.readdir(projects).catch(() => []);
    for (const slug of slugs.sort()) queues.push(...await listQueuesIn(path.join(projects, slug)));
  }
  return queues;
}
