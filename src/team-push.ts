import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { readEvents, aggregateSessionInterventions } from './dashboard-collector.js';
import { createGit, pushRepoDirectly, pullRepo, resetToCleanMaster } from './utils/git.js';
import { writeFile, readFileSafe, ensureDir, pathExists, listFiles } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { UserStats, UserInterventionStats } from './types.js';
import { VOTES_LOCAL_DIR } from './types.js';

/** Snapshot of already-reported per-session intervention counts (idempotency basis). */
type ReportedInterventions = Record<string, { interrupt: number; toolReject: number; correction: number }>;

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

// ─── Human Intervention reporting (Issue #34) ──────────
//
//  events.jsonl ──aggregateSessionInterventions──▶ current per-session snapshot
//       │                                                │
//       ▼                                                ▼
//  reported-interventions.json (last reported)  ──delta──▶ merge into stats/<user>.yaml
//
//  The local reported snapshot makes reporting idempotent: re-running pull never
//  double-counts a session, since we only add the positive change since last report.
//

/** Path to the local reported-interventions snapshot (evaluated at call time for tests). */
function getReportedInterventionsPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'dashboard', 'reported-interventions.json');
}

async function readReportedInterventions(): Promise<ReportedInterventions> {
  try {
    const content = await readFileSafe(getReportedInterventionsPath());
    if (!content) return {};
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeReportedInterventions(data: ReportedInterventions): Promise<void> {
  try {
    const p = getReportedInterventionsPath();
    await ensureDir(path.dirname(p));
    await writeFile(p, JSON.stringify(data));
  } catch (e) {
    log.error(`Failed to persist reported interventions: ${(e as Error).message}`);
  }
}

/**
 * Compute the intervention delta to report: for each current session, the positive
 * change since it was last reported. A session not seen before contributes +1 to
 * `sessions`. The next snapshot keeps only sessions still present in events.jsonl
 * (already-compacted sessions are final and stay folded into the team total).
 */
export function computeInterventionDelta(
  current: Map<string, { interrupt: number; toolReject: number; correction: number }>,
  reported: ReportedInterventions,
): { delta: UserInterventionStats; nextReported: ReportedInterventions } {
  const delta: UserInterventionStats = { sessions: 0, interrupt: 0, toolReject: 0, correction: 0 };
  const nextReported: ReportedInterventions = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    if (!prev) delta.sessions += 1;
    delta.interrupt += Math.max(0, cur.interrupt - (prev?.interrupt ?? 0));
    delta.toolReject += Math.max(0, cur.toolReject - (prev?.toolReject ?? 0));
    delta.correction += Math.max(0, cur.correction - (prev?.correction ?? 0));
    nextReported[sid] = cur;
  }

  return { delta, nextReported };
}

/** Accumulate an intervention delta onto the user's existing totals. */
export function mergeInterventionStats(
  existing: UserInterventionStats | undefined,
  delta: UserInterventionStats,
): UserInterventionStats {
  return {
    sessions: (existing?.sessions ?? 0) + delta.sessions,
    interrupt: (existing?.interrupt ?? 0) + delta.interrupt,
    toolReject: (existing?.toolReject ?? 0) + delta.toolReject,
    correction: (existing?.correction ?? 0) + delta.correction,
  };
}

/** True when a delta carries any new data worth pushing. */
function hasInterventionDelta(d: UserInterventionStats): boolean {
  return d.sessions > 0 || d.interrupt > 0 || d.toolReject > 0 || d.correction > 0;
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

    // Compute the Human Intervention delta from the local dashboard event log.
    const dashboardEvents = await readEvents();
    const currentInterventions = aggregateSessionInterventions(dashboardEvents);
    const reportedInterventions = await readReportedInterventions();
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      currentInterventions,
      reportedInterventions,
    );
    const hasUsage = events.length > 0;
    const hasInterventions = hasInterventionDelta(interventionDelta);

    // Reset any dirty/conflicted state and ensure we're on the default branch before pulling.
    // Same pattern as push.ts — the team repo is a cache, safe to discard local state.
    const git = createGit(repoPath);
    await resetToCleanMaster(git, repoPath);
    await pullRepo(repoPath);

    // Process usage and/or intervention stats if there is anything new to report.
    if (hasUsage || hasInterventions) {
      const statsDir = path.join(repoPath, 'stats');
      await ensureDir(statsDir);
      const statsPath = path.join(statsDir, `${username}.yaml`);

      // See also: stats.ts mergeLocalAndReported() — same merge logic for display.
      // mergeStats with [] preserves existing skills while refreshing username/updatedAt.
      const existing = await readExistingStats(statsPath);
      const newStats = hasUsage ? aggregateUsage(events) : [];
      const merged = mergeStats(existing, username, newStats);
      if (hasInterventions) {
        merged.interventions = mergeInterventionStats(existing?.interventions, interventionDelta);
      }

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
    const commitMsg = hasUsage
      ? `[teamai] Update usage stats for ${username}`
      : hasInterventions
        ? `[teamai] Update intervention stats for ${username}`
        : `[teamai] Update votes for ${username}`;
    const pushPromise = pushRepoDirectly(repoPath, commitMsg, filesToPush);

    const timeoutPromise = new Promise<never>((__, reject) =>
      setTimeout(() => reject(new Error('Auto-report timeout (5s)')), 5000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    // Success — truncate reported usage events (only if we had any)
    if (hasUsage) {
      await truncateUsageAfterReport(events.length);
      log.debug(`Reported ${events.length} usage events to team repo`);
    }
    // Success — advance the reported-interventions snapshot so we don't re-count.
    if (hasInterventions) {
      await writeReportedInterventions(nextReported);
      log.debug(`Reported intervention delta (${interventionDelta.sessions} new sessions) to team repo`);
    }
    if (!hasUsage && !hasInterventions) {
      log.debug('Pushed pending votes to team repo');
    }
  } catch (e) {
    log.error(`Auto-report skipped: ${(e as Error).message}`);
  }
}
