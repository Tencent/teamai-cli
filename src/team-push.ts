import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { pushRepoDirectly, pullRepo } from './utils/git.js';
import { writeFile, readFileSafe, ensureDir, pathExists, listFiles } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { UserStats } from './types.js';
import { VOTES_LOCAL_DIR } from './types.js';

// ─── Auto-report flow (during teamai pull) ─────────────
//
//  teamai pull
//      │
//      ▼
//  [pull team resources] ── existing flow ──
//      │
//      ▼
//  [reportUsageToTeam()]
//      │
//      ▼
//  [read ~/.teamai/usage.jsonl] ──missing/empty?──▶ SKIP
//      │
//      ▼
//  [git pull latest] ── get freshest remote stats ──
//      │
//      ▼
//  [read existing stats/<user>.yaml + merge with new events]
//      │
//      ▼
//  [write merged stats/<user>.yaml]
//      │
//      ▼
//  [git add + commit + push (5s timeout)]
//      │
//      ├──success──▶ truncate JSONL
//      └──fail──▶ log debug + skip (next pull retries)
//

/**
 * Read existing stats YAML for a user, returning null if not found or invalid.
 */
async function readExistingStats(statsPath: string): Promise<UserStats | null> {
  try {
    const content = await readFileSafe(statsPath);
    if (!content) return null;
    const parsed = YAML.parse(content) as UserStats;
    if (parsed?.username && parsed?.skills) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Merge new aggregated events into existing stats.
 * Counts are cumulative; lastUsed takes the more recent value.
 */
export function mergeStats(
  existing: UserStats | null,
  username: string,
  newEvents: { name: string; count: number; lastUsed: Date }[],
): UserStats {
  const skills: Record<string, { count: number; lastUsed: string }> = {};

  if (existing?.skills) {
    for (const [name, data] of Object.entries(existing.skills)) {
      skills[name] = { count: data.count, lastUsed: data.lastUsed };
    }
  }

  for (const stat of newEvents) {
    const prev = skills[stat.name];
    const newLastUsed = stat.lastUsed.toISOString();

    if (prev) {
      prev.count += stat.count;
      if (newLastUsed > prev.lastUsed) {
        prev.lastUsed = newLastUsed;
      }
    } else {
      skills[stat.name] = { count: stat.count, lastUsed: newLastUsed };
    }
  }

  return {
    username,
    updatedAt: new Date().toISOString(),
    skills,
  };
}

/**
 * Auto-report usage data to team repo during pull.
 * Merges new events with existing stats to preserve historical data.
 * Best-effort: silently fails on any error.
 * Timeout: 5 seconds max to avoid blocking session start.
 */
export async function reportUsageToTeam(
  repoPath: string,
  username: string,
): Promise<void> {
  try {
    const events = await readUsageEvents();
    if (events.length === 0) {
      log.debug('No usage events to report');
      return;
    }

    const newStats = aggregateUsage(events);

    const statsDir = path.join(repoPath, 'stats');
    await ensureDir(statsDir);
    const statsPath = path.join(statsDir, `${username}.yaml`);

    // Pull first to get the freshest remote stats before merging
    // (prevents race condition where concurrent push overwrites our merge)
    await pullRepo(repoPath);

    // See also: stats.ts mergeLocalAndReported() — same merge logic for display
    const existing = await readExistingStats(statsPath);
    const merged = mergeStats(existing, username, newStats);

    await writeFile(statsPath, YAML.stringify(merged));

    // Also stage any pending local votes
    const filesToPush: string[] = [`stats/${username}.yaml`];
    try {
      if (await pathExists(VOTES_LOCAL_DIR)) {
        const voteFiles = await listFiles(VOTES_LOCAL_DIR);
        for (const vf of voteFiles) {
          if (!vf.endsWith('.yaml') && !vf.endsWith('.yml')) continue;
          const localVotePath = path.join(VOTES_LOCAL_DIR, vf);
          const repoVotePath = path.join(repoPath, 'votes', vf);
          const content = await readFileSafe(localVotePath);
          if (content) {
            await ensureDir(path.join(repoPath, 'votes'));
            await writeFile(repoVotePath, content);
            filesToPush.push(`votes/${vf}`);
          }
        }
      }
    } catch (e) {
      log.error(`Vote staging skipped: ${(e as Error).message}`);
    }

    // Commit and push with timeout
    const pushPromise = pushRepoDirectly(
      repoPath,
      `[teamai] Update usage stats for ${username}`,
      filesToPush,
    );

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Auto-report timeout (5s)')), 5000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    // Success — truncate reported events
    await truncateUsageAfterReport(events.length);
    log.debug(`Reported ${events.length} usage events to team repo`);
  } catch (e) {
    log.error(`Auto-report skipped: ${(e as Error).message}`);
  }
}
