/**
 * archive.ts -- the team session archive as a workflow run uses it: a step continues a session another machine ran
 * from the copy that machine archived.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { knownSecrets } from '../env-resolution.js';
import { isSelfMode, type LocalConfig } from '../types.js';
import { createGit, getDefaultBranch } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { updateReports } from '../utils/reports-branch.js';
import { getAdapter } from './adapters/index.js';
import { AgentSession, noAdapter, recordedToolRoots, writeCopyOnce } from './agent-session.js';
import type { Session } from './ir.js';
import { degradeThinkingBlocks } from './migrate.js';
import { archiveBusyMessage, authorForCwd, deriveArchiveIdentity, sessionArchiveRoot } from './session-cmd-shared.js';
import { SyncManager, defaultSyncMeta, getRepoIdentity, type SessionSyncMeta } from './sync.js';

/** A session in one tool, by the id that tool gave it. */
export type ArchiveSessionRef = { platform: string; sessionId: string };

export type ArchiveRestore = { status: 'restored'; sessionId: string } | { status: 'fresh'; reason: string };

export type ArchiveDelivery<T extends ArchiveSessionRef = ArchiveSessionRef> =
  | { status: 'archived'; archived: T[]; skipped: T[] }
  | { status: 'failed'; message: string };

/** What became of one session pushed to the team session archive. `busy`: another write held teamai-reports, and nothing was written. */
export type SessionPush = { status: 'archived' } | { status: 'busy'; message: string } | { status: 'failed'; message: string };

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
 * The archive as this machine has it: the teamai-reports checkout, read as it is, since the claim that hands a run over
 * has just synced it. On a git-kind team, a session teamai-reports does not hold is read from the archive teamai kept
 * on the default branch before: origin's default branch is fetched once per archive opened, and sessions are read from a
 * temporary clone at that commit, so the member's team clone stays where it is. When the fetch fails, the team clone is
 * read as it is, and the answer says it may be older than origin.
 */
export function openSessionArchive(config: LocalConfig): SessionArchive {
  let latest: Promise<LatestArchive> | undefined;
  return {
    restore: async (source, target) => {
      const reports = sessionArchiveRoot(config);
      if (!reports) return { status: 'fresh', reason: 'This team keeps no session archive.' };
      const repoIdentity = getRepoIdentity(target.cwd);
      let archive = new SyncManager(reports);
      let entry = archive.findArchived(repoIdentity, source);
      let where = 'on teamai-reports';
      let stale = '';
      if (!entry && !isSelfMode(config)) {
        const local = config.repo.localPath;
        latest ??= fetchLatest(local);
        const fetched = await latest;
        if ('failed' in fetched) stale = ` Fetching the archive from origin failed, so ${local} was read as it is and may be older than origin: ${fetched.failed}`;
        archive = new SyncManager('root' in fetched ? fetched.root : local);
        entry = archive.findArchived(repoIdentity, source);
        where = `on teamai-reports or ${'root' in fetched ? "on origin's default branch" : `in ${local}`}`;
      }
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
      if (stale) log.warn(`The ${source.platform} session ${source.sessionId} was restored from ${config.repo.localPath}.${stale}`);
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
 * read and scrubbed of the team's secrets too, to the team session archive, where a member who continues workflow run `run` restores them. A
 * session newer than that one, which this machine cannot read, is skipped and listed. A chain with none readable fails
 * the push before anything is written. The sessions are filed under the repository of business checkout `checkout`,
 * where the run's steps ran, as its git author, on teamai-reports under its lock.
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
  const scrub = { secrets: await knownSecrets(config) };
  const read: Array<{ session: Session; meta: SessionSyncMeta }> = [];
  const archived: T[] = [];
  const skipped: T[] = [];
  for (const chain of chains) {
    const unreadable: string[] = [];
    let newest: { ref: T; session: Session; meta: SessionSyncMeta } | undefined;
    for (const ref of chain) {
      const found = await AgentSession.find(ref, { scrub, toolRootsFor: () => toolRoots });
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
  if (read.length === 0) return { status: 'archived', archived, skipped };
  const delivered = await archiveOnReports(config, read, `sync: archive ${read.length} session(s) of workflow run ${run}`);
  return delivered.status === 'archived' ? { status: 'archived', archived, skipped } : { status: 'failed', message: delivered.message };
}

/**
 * Pushes session `ref`, read from this machine's tool and scrubbed of the team's secrets too, to the team session archive on teamai-reports, under
 * its lock. It is filed under the repository of the workspace it ran in, as that workspace's git author. Never prompts.
 */
export async function pushSession(config: LocalConfig, ref: ArchiveSessionRef): Promise<SessionPush> {
  if (!sessionArchiveRoot(config)) return { status: 'failed', message: 'This team keeps no session archive.' };
  const found = await AgentSession.find(ref, { scrub: { secrets: await knownSecrets(config) } });
  if (found.status === 'failed') return { status: 'failed', message: found.failure.message };
  const { session } = found;
  const meta = defaultSyncMeta({
    platform: ref.platform,
    author: authorForCwd(session.cwd, config.username),
    cwd: session.cwd,
    sessionId: ref.sessionId,
    repoIdentity: deriveArchiveIdentity(session, ref.platform),
    title: session.title,
  }, session.createdAt);
  return archiveOnReports(config, [{ session, meta }], `sync: push 1 session(s) from ${ref.platform}`);
}

/**
 * The newest session of `chain` the archive holds: teamai-reports at `root` as it is, then on a git-kind team the
 * archive teamai kept before on the default branch, read from origin's latest commit.
 */
async function alreadyArchived<T extends ArchiveSessionRef>(
  config: LocalConfig,
  root: string,
  repoIdentity: string | null,
  chain: readonly T[],
): Promise<T | undefined> {
  const find = (archive: SyncManager) => chain.find((ref) => archive.findArchived(repoIdentity, ref));
  const kept = find(new SyncManager(root));
  if (kept || isSelfMode(config)) return kept;
  const fetched = await fetchLatest(config.repo.localPath);
  try {
    return find(new SyncManager('root' in fetched ? fetched.root : config.repo.localPath));
  } finally {
    if ('root' in fetched) await fs.rm(fetched.dir, { recursive: true, force: true });
  }
}

async function archiveOnReports(
  config: LocalConfig,
  sessions: ReadonlyArray<{ session: Session; meta: SessionSyncMeta }>,
  message: string,
): Promise<SessionPush> {
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
      return { status: 'busy', message: 'another teamai process is writing teamai-reports' };
    case 'failed':
      return { status: 'failed', message: result.reason };
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
