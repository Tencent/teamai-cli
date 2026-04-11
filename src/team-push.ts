import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { createGit, pushRepoDirectly, pullRepo, resetToCleanMaster } from './utils/git.js';
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
//  [git pull latest] ── get freshest remote state ──
//      │
//      ▼
//  [read ~/.teamai/usage.jsonl] ──has events?──▶ merge stats
//      │                                           │
//      ▼                                           ▼
//  [stage pending votes from ~/.teamai/votes/]  [write stats/<user>.yaml]
//      │                                           │
//      ▼  ◄────────────────────────────────────────┘
//  [anything to push?] ──no──▶ SKIP
//      │
//      ▼
//  [git add + commit + push (5s timeout)]
//      │
//      ├──success──▶ truncate JSONL (if events existed)
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
    const filesToPush: string[] = [];

    // Reset any dirty/conflicted state and ensure we're on master before pulling.
    // Same pattern as push.ts — the team repo is a cache, safe to discard local state.
    const git = createGit(repoPath);
    await resetToCleanMaster(git);
    await pullRepo(repoPath);

    // Process usage stats if any events exist
    if (events.length > 0) {
      const newStats = aggregateUsage(events);
      const statsDir = path.join(repoPath, 'stats');
      await ensureDir(statsDir);
      const statsPath = path.join(statsDir, `${username}.yaml`);

      // See also: stats.ts mergeLocalAndReported() — same merge logic for display
      const existing = await readExistingStats(statsPath);
      const merged = mergeStats(existing, username, newStats);

      await writeFile(statsPath, YAML.stringify(merged));
      filesToPush.push(`stats/${username}.yaml`);
    }

    // Always stage pending local votes (independent of usage events)
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

    // Nothing to push — skip commit
    if (filesToPush.length === 0) {
      log.debug('No usage events or votes to report');
      return;
    }

    // Commit and push with timeout
    const commitMsg = events.length > 0
      ? `[teamai] Update usage stats for ${username}`
      : `[teamai] Update votes for ${username}`;
    const pushPromise = pushRepoDirectly(repoPath, commitMsg, filesToPush);

    const timeoutPromise = new Promise<never>((__, reject) =>
      setTimeout(() => reject(new Error('Auto-report timeout (5s)')), 5000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    // Success — truncate reported events (only if we had any)
    if (events.length > 0) {
      await truncateUsageAfterReport(events.length);
      log.debug(`Reported ${events.length} usage events to team repo`);
    } else {
      log.debug('Pushed pending votes to team repo');
    }
  } catch (e) {
    log.error(`Auto-report skipped: ${(e as Error).message}`);
  }
}
