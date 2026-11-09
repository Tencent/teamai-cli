/**
 * The team commit a cached definition came from (#1163): present only when that commit holds the cached sources byte for
 * byte and a remote-tracking ref of the team repo reaches it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createGit, getHeadCommit } from './git.js';

/** The team repo's checked-out commit and its top level, when the team remote reaches that commit. */
export interface ReachableRevision {
  repositoryRoot: string;
  revision: string;
}

const TEAM_REMOTE_REFS = 'refs/remotes/origin/';

async function isTeamRemoteRevision(root: string, revision: string): Promise<boolean> {
  try {
    const refs = await createGit(root).raw([
      'for-each-ref', `--contains=${revision}`, '--format=%(refname)', TEAM_REMOTE_REFS,
    ]);

    return refs.trim() !== '';
  } catch {
    return false;
  }
}

/** The checked-out commit, only when the team remote can reach it. */
export async function remotelyReachableRevision(root: string): Promise<ReachableRevision | undefined> {
  try {
    const revision = await getHeadCommit(root);

    if (!revision || !await isTeamRemoteRevision(root, revision)) return undefined;

    return {
      repositoryRoot: await fs.realpath((await createGit(root).revparse(['--show-toplevel'])).trim()),
      revision,
    };
  } catch {
    return undefined;
  }
}

export async function withoutStaleTeamRevision<T extends { teamRevision?: string }>(root: string, cached: T | null): Promise<T | null> {
  if (!cached?.teamRevision || await isTeamRemoteRevision(root, cached.teamRevision)) return cached;
  const next = { ...cached };
  delete next.teamRevision;

  return next;
}

/**
 * Whether `revision` stores every source byte exactly as the cache read it. A source with `readsCrlfAsLf`, a file of a
 * workflow folder, was read with CRLF as LF, so the stored file is compared read the same way.
 */
export async function revisionHoldsSources(
  knowledgeRoot: string,
  reachable: ReachableRevision | undefined,
  sources: Array<{ path: string; content: string; readsCrlfAsLf?: boolean }>,
): Promise<boolean> {
  if (!reachable) return false;
  const git = createGit(knowledgeRoot);

  try {
    for (const source of sources) {
      const absolute = path.resolve(knowledgeRoot, source.path);
      const relative = path.relative(reachable.repositoryRoot, await fs.realpath(absolute)).split(path.sep).join('/');

      if (relative === '..' || relative.startsWith('../')) return false;

      const stored = await git.show([`${reachable.revision}:${relative}`]);

      if ((source.readsCrlfAsLf ? stored.replace(/\r\n/g, '\n') : stored) !== source.content) return false;
    }

    return true;
  } catch {
    return false;
  }
}
