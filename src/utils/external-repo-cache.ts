import path from 'node:path';
import { pullRepo } from './git.js';
import { detectProvider, getProvider } from '../providers/index.js';
import { log, spinner } from './logger.js';
import { pathExists, ensureDir } from './fs.js';

/**
 * Generic "external read-only repo mirror" primitives shared by every teamai
 * feature that mirrors someone else's git repo onto the local machine without
 * ever writing back to it: cross-team `sources` (source.ts) and the DSH Team
 * Context adapter (team-context.ts). Both need the same two things — clone-
 * or-pull with a TTL, and a name-set diff for tombstone-style cleanup — so
 * those are the only two primitives here. Everything entity-specific (what a
 * "skill" is, collision policy, manifest shape) stays in the caller.
 *
 * Not to be confused with `repo-cache.ts` (import command's LAST_SYNC cache
 * for `teamai import`), which is an unrelated, pre-existing cache keyed by
 * provider/owner/repo for a different feature.
 */

/**
 * Ensure `repoDir` holds a git clone of `repoUrl`, refreshed via the git
 * provider abstraction (so provider auth — token, credential helper, SSH
 * agent — is used the same way it is for team-repo and source-repo clones).
 *
 * - `repoDir` absent → clone. Failure → returns null (caller cannot proceed).
 * - `repoDir` present → pull only when `force` or the TTL (measured from
 *   `lastPulledAt`) has elapsed; otherwise a no-op. A pull failure does NOT
 *   fail the call — the existing clone is still usable, so this returns
 *   `{ pulled: false }` and logs a warning (matches the pre-existing
 *   `ensureSourceRepo` behavior: prefer a stale cache over no cache).
 *
 * Never deletes or resets `repoDir` itself — that stays the caller's call
 * (e.g. tombstone cleanup of deployed *content*, not of the cache clone).
 */
export async function ensureRepoCache(
  repoDir: string,
  repoUrl: string,
  lastPulledAt: string | null,
  options: { force?: boolean; ttlMs: number; label: string },
): Promise<{ pulled: boolean } | null> {
  const { force = false, ttlMs, label } = options;

  if (await pathExists(repoDir)) {
    if (!force && lastPulledAt) {
      const elapsed = Date.now() - new Date(lastPulledAt).getTime();
      if (elapsed <= ttlMs) {
        log.debug(`[${label}] Within pull TTL, skipping git pull`);
        return { pulled: false };
      }
    }

    try {
      const result = await pullRepo(repoDir);
      log.debug(`[${label}] Git pull: ${result}`);
      return { pulled: true };
    } catch (e) {
      log.warn(`[${label}] Pull failed: ${(e as Error).message}`);
      return { pulled: false };
    }
  }

  // First time: clone via the provider so its configured authentication path
  // (token, credential helper, or SSH agent) is used.
  try {
    await ensureDir(path.dirname(repoDir));
    const cloneSpin = spinner(`[${label}] Cloning...`).start();

    const providerName = detectProvider(repoUrl);
    const provider = getProvider(providerName);
    const repoInfo = provider.parseRepoInput(repoUrl);
    const cloneTarget = provider.name === 'git'
      ? repoInfo.httpsUrl
      : `${repoInfo.owner}/${repoInfo.repo}`;
    provider.cloneRepo(cloneTarget, repoDir);

    cloneSpin.succeed(`[${label}] Cloned`);
    return { pulled: true };
  } catch (e) {
    log.warn(`[${label}] Clone failed: ${(e as Error).message}`);
    return null;
  }
}

/** Set-diff result: names newly present, names no longer present, unchanged. */
export interface NameSetDiff {
  added: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Diff two name sets (e.g. "previously deployed" vs "currently resolved
 * upstream"). Used to drive tombstone-style local cleanup: `removed` is what
 * the caller should delete locally, `added`/`unchanged` is what should exist.
 */
export function diffNameSets(previous: Iterable<string>, current: Iterable<string>): NameSetDiff {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  const added: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];

  for (const name of currentSet) {
    if (previousSet.has(name)) unchanged.push(name);
    else added.push(name);
  }
  for (const name of previousSet) {
    if (!currentSet.has(name)) removed.push(name);
  }

  return { added, removed, unchanged };
}
