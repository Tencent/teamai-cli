/**
 * archive.ts -- the team session archive as a workflow run uses it: a step continues a session another machine ran
 * from the copy that machine archived.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSelfMode, type LocalConfig } from '../types.js';
import { createGit, getDefaultBranch } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { updateReports } from '../utils/reports-branch.js';
import { getAdapter } from './adapters/index.js';
import { AgentSession, noAdapter, recordedToolRoots, writeCopyOnce } from './agent-session.js';
import type { Session } from './ir.js';
import { degradeThinkingBlocks } from './migrate.js';
import { archiveBusyMessage, authorForCwd, pushArchive, sessionArchiveRoot } from './session-cmd-shared.js';
import { SyncManager, defaultSyncMeta, getRepoIdentity, type SessionSyncMeta } from './sync.js';

/** A session in one tool, by the id that tool gave it. */
export type ArchiveSessionRef = { platform: string; sessionId: string };

export type ArchiveRestore = { status: 'restored'; sessionId: string } | { status: 'fresh'; reason: string };

export type ArchiveDelivery<T extends ArchiveSessionRef = ArchiveSessionRef> =
  | { status: 'archived'; archived: T[]; skipped: T[] }
  | { status: 'failed'; message: string };

type Delivered = { status: 'archived' } | { status: 'failed'; message: string };

/** The team session archive as one workflow driver run restores sessions from it. */
export type SessionArchive = {
  /**
   * Writes the copy of `source` the archive holds into the tool of `target.platform`, in workspace `target.cwd`, and
   * returns the id it has there. The copy is written once: a later restore finds it and writes nothing, so turns added
   * to it stay. The archive is never repaired.
   */
  restore(source: ArchiveSessionRef, target: { platform: string; cwd: string }): Promise<ArchiveRestore>;
  /** Removes what the restores left on disk. Called once no restore is running. */
  close(): Promise<void>;
};

/**
 * The archive as origin has it. On a git-kind team, origin's default branch is fetched once per archive opened, and
 * sessions are read from a temporary clone at that commit, so a session archived again under the same id restores as it
 * was last archived, and the member's team clone stays where it is. When the fetch fails, the team clone is read as it
 * is, and the answer says it may be older than origin. The reports checkout of self mode is read as it is, since the
 * claim that hands a run over has just synced it.
 */
export function openSessionArchive(config: LocalConfig): SessionArchive {
  let latest: Promise<LatestArchive> | undefined;
  return {
    restore: async (source, target) => {
      const local = sessionArchiveRoot(config);
      if (!local) return { status: 'fresh', reason: 'This team keeps no session archive.' };
      let root = local;
      let stale = '';
      if (!isSelfMode(config)) {
        latest ??= fetchLatest(local);
        const fetched = await latest;
        if ('root' in fetched) root = fetched.root;
        else stale = ` Fetching the archive from origin failed, so ${local} was read as it is and may be older than origin: ${fetched.failed}`;
      }
      const where = root === local ? `in ${local}` : 'on origin';
      const repoIdentity = getRepoIdentity(target.cwd);
      const archive = new SyncManager(root);
      const entry = archive.findArchived(repoIdentity, source);
      if (!entry) return { status: 'fresh', reason: `The team session archive ${where} has no ${source.platform} session ${source.sessionId}.${stale}` };
      let session;
      try {
        ({ session } = archive.loadSession(repoIdentity, entry.sessionName, entry.author));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { status: 'fresh', reason: `The archived ${source.platform} session ${source.sessionId} could not be read: ${message}` };
      }
      const refused = noAdapter(target.platform, 'write');
      if (refused) return { status: 'fresh', reason: refused.message };
      const adapter = getAdapter(target.platform, await recordedToolRoots(target.cwd));
      if (!adapter.isReady()) {
        return { status: 'fresh', reason: `${target.platform} is not installed or its session storage directory was not found.` };
      }
      const written = await writeCopyOnce(adapter, {
        session: degradeThinkingBlocks({ ...session, cwd: target.cwd }, target.platform),
        sourcePlatform: source.platform,
        cwd: target.cwd,
      });
      if (written.status !== 'done') return { status: 'fresh', reason: written.failure.message };
      if (stale) log.warn(`The ${source.platform} session ${source.sessionId} was restored from ${local}.${stale}`);
      return { status: 'restored', sessionId: written.sessionId };
    },
    close: async () => {
      const fetched = await latest;
      if (fetched && 'root' in fetched) await fs.rm(fetched.dir, { recursive: true, force: true });
    },
  };
}

type LatestArchive = { dir: string; root: string } | { failed: string };

/**
 * Fetches origin's default branch into team clone `teamClone`'s remote-tracking ref, as loading a workflow at a team
 * commit does, and checks that commit out in a temporary clone sharing its objects. Neither the clone's branch nor its
 * files move.
 */
async function fetchLatest(teamClone: string): Promise<LatestArchive> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-sessions-'));
  try {
    const git = createGit(teamClone);
    const branch = await getDefaultBranch(teamClone);
    await git.raw(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const commit = (await git.raw(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
    const root = path.join(dir, 'team');
    await git.raw(['clone', '--quiet', '--shared', '--no-checkout', teamClone, root]);
    await createGit(root).raw(['checkout', '--quiet', '--detach', commit]);
    return { dir, root };
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    return { failed: error instanceof Error ? error.message.trim() : String(error) };
  }
}

/**
 * Pushes, for each chain of `chains` (its sessions newest first), the newest session this machine's tools can read,
 * read and scrubbed, to the team session archive, where a member who continues workflow run `run` restores them. A
 * session newer than that one, which this machine cannot read, is skipped and listed. A chain with none readable fails
 * the push before anything is written. The sessions are filed under the repository of business checkout `checkout`,
 * where the run's steps ran, as its git author. In self mode the archive is on teamai-reports and written under its lock.
 */
export async function archiveSessions<T extends ArchiveSessionRef>(
  config: LocalConfig,
  chains: readonly (readonly T[])[],
  { run, checkout }: { run: string; checkout: string },
): Promise<ArchiveDelivery<T>> {
  const root = sessionArchiveRoot(config);
  if (!root) return { status: 'failed', message: 'This team keeps no session archive.' };
  const toolRoots = recordedToolRoots(checkout);
  const repoIdentity = getRepoIdentity(checkout);
  const author = authorForCwd(checkout, config.username);
  const read: Array<{ session: Session; meta: SessionSyncMeta }> = [];
  const archived: T[] = [];
  const skipped: T[] = [];
  for (const chain of chains) {
    const unreadable: string[] = [];
    let newest: { ref: T; session: Session; meta: SessionSyncMeta } | undefined;
    for (const ref of chain) {
      const found = await AgentSession.find(ref, { scrub: true, toolRootsFor: () => toolRoots });
      if (found.status === 'failed') {
        skipped.push(ref);
        unreadable.push(`The ${ref.platform} session ${ref.sessionId} could not be read: ${found.failure.message}`);
        continue;
      }
      const { session } = found;
      const meta = defaultSyncMeta({
        platform: ref.platform, author, cwd: session.cwd || checkout, sessionId: ref.sessionId, repoIdentity, title: session.title,
      }, session.createdAt);
      newest = { ref, session, meta };
      break;
    }
    if (!newest) {
      // A session another machine already archived still reaches whoever claims the run next.
      const kept = await alreadyArchived(config, root, repoIdentity, chain);
      if (!kept) return { status: 'failed', message: unreadable.join(' ') };
      skipped.splice(skipped.indexOf(kept), 1);
      archived.push(kept);
      continue;
    }
    archived.push(newest.ref);
    read.push({ session: newest.session, meta: newest.meta });
  }
  const outcome = (delivered: Delivered): ArchiveDelivery<T> => (delivered.status === 'archived' ? { ...delivered, archived, skipped } : delivered);
  if (read.length === 0) return outcome({ status: 'archived' });
  const message = `sync: archive ${read.length} session(s) of workflow run ${run}`;
  if (isSelfMode(config)) return outcome(await archiveOnReports(config, read, message));
  const archive = new SyncManager(root);
  const unsaved = await saveAll(archive, root, read);
  if (unsaved) return { status: 'failed', message: unsaved };
  let commit;
  try {
    commit = archive.gitCommit(message);
  } catch (error) {
    commit = { status: 'failed' as const, reason: error instanceof Error ? error.message : String(error) };
  }
  if (commit.status === 'failed') return { status: 'failed', message: `Committing the sessions in ${root} failed: ${commit.reason}` };
  const pushed = await pushArchive(archive, root);
  if (pushed.status === 'failed') {
    return { status: 'failed', message: `The sessions were committed in ${root} but not pushed: ${pushed.reason}` };
  }
  return outcome({ status: 'archived' });
}

/** The newest session of `chain` the archive at `root` holds, read on a git-kind team from origin's latest commit. */
async function alreadyArchived<T extends ArchiveSessionRef>(
  config: LocalConfig,
  root: string,
  repoIdentity: string | null,
  chain: readonly T[],
): Promise<T | undefined> {
  const fetched = isSelfMode(config) ? undefined : await fetchLatest(root);
  try {
    const archive = new SyncManager(fetched && 'root' in fetched ? fetched.root : root);
    return chain.find((ref) => archive.findArchived(repoIdentity, ref));
  } finally {
    if (fetched && 'root' in fetched) await fs.rm(fetched.dir, { recursive: true, force: true });
  }
}

async function archiveOnReports(
  config: LocalConfig,
  sessions: ReadonlyArray<{ session: Session; meta: SessionSyncMeta }>,
  message: string,
): Promise<Delivered> {
  let unsaved: string | undefined;
  const result = await updateReports(config, async (worktree) => {
    const archive = new SyncManager(worktree);
    unsaved = await saveAll(archive, worktree, sessions);
    return unsaved ? null : { files: archive.writtenFiles(), message };
  });
  if (unsaved) return { status: 'failed', message: unsaved };
  switch (result.status) {
    case 'published':
    case 'already-present':
      return { status: 'archived' };
    case 'busy':
      return { status: 'failed', message: 'Another teamai process is writing teamai-reports.' };
    case 'failed':
      return { status: 'failed', message: `Writing teamai-reports failed: ${result.reason}` };
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/** Saves each session into `archive`, or says why one could not be saved. */
async function saveAll(
  archive: SyncManager,
  root: string,
  sessions: ReadonlyArray<{ session: Session; meta: SessionSyncMeta }>,
): Promise<string | undefined> {
  for (const { session, meta } of sessions) {
    try {
      const saved = await archive.saveSession(session, meta);
      if (saved.status === 'busy') return archiveBusyMessage(root, saved.lockPath);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}
