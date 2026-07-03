import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { readEvents, aggregateSessionMetrics } from './dashboard-collector.js';
import { createGit, pushRepoDirectly, pullRepo, resetToCleanMaster } from './utils/git.js';
import { writeFile, readFileSafe, ensureDir, pathExists, listFiles, readJson, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { UserStats, UserInterventionStats, SessionMetrics, TokenUsage, DashboardEvent } from './types.js';
import { VOTES_LOCAL_DIR, emptyTokenUsage, addTokenUsage } from './types.js';

/** Snapshot of already-reported per-session intervention counts (idempotency basis). */
type ReportedInterventions = Record<string, { interrupt: number; toolReject: number; correction: number }>;

/** Snapshot of already-reported per-session prompt counts + token usage (idempotency basis). */
type ReportedPromptTokens = Record<string, { prompts: number; tokens: TokenUsage }>;

/** Cumulative delta for conversation-turn count + token usage (Issue #75). */
interface PromptTokenDelta {
  prompts: number;
  tokens: TokenUsage;
}

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
  const parsed = await readJson<ReportedInterventions>(getReportedInterventionsPath());
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedInterventions(data: ReportedInterventions): Promise<void> {
  try {
    await writeJson(getReportedInterventionsPath(), data);
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

// ─── Conversation-turn + token reporting (Issue #75) ───
//
//  events.jsonl ──aggregateSessionMetrics──▶ current per-session {prompts, tokens}
//       │                                              │
//       ▼                                              ▼
//  reported-prompt-tokens.json (last reported)  ──delta──▶ merge into stats/<user>.yaml
//
//  Separate snapshot from interventions so each metric stays independently idempotent.
//

/** Path to the local prompt/token reported snapshot (evaluated at call time for tests). */
function getReportedPromptTokensPath(): string {
  return path.join(process.env.HOME ?? '', '.teamai', 'dashboard', 'reported-prompt-tokens.json');
}

async function readReportedPromptTokens(): Promise<ReportedPromptTokens> {
  try {
    const content = await readFileSafe(getReportedPromptTokensPath());
    if (!content) return {};
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeReportedPromptTokens(data: ReportedPromptTokens): Promise<void> {
  try {
    const p = getReportedPromptTokensPath();
    await ensureDir(path.dirname(p));
    await writeFile(p, JSON.stringify(data));
  } catch (e) {
    log.error(`Failed to persist reported prompt/token snapshot: ${(e as Error).message}`);
  }
}

/** Field-by-field positive token delta (never negative if a snapshot shrinks). */
function tokenDelta(cur: TokenUsage, prev: TokenUsage | undefined): TokenUsage {
  return {
    input: Math.max(0, cur.input - (prev?.input ?? 0)),
    output: Math.max(0, cur.output - (prev?.output ?? 0)),
    cacheRead: Math.max(0, cur.cacheRead - (prev?.cacheRead ?? 0)),
    cacheCreation: Math.max(0, cur.cacheCreation - (prev?.cacheCreation ?? 0)),
  };
}

/**
 * Compute the prompt-count + token delta to report: for each current session, the
 * positive change since it was last reported. Idempotent (a re-run reports nothing
 * new), and never negative if a snapshot shrinks. The next snapshot keeps only
 * sessions still present in events.jsonl (compacted sessions stay folded into totals).
 */
export function computePromptTokenDelta(
  current: Map<string, SessionMetrics>,
  reported: ReportedPromptTokens,
): { delta: PromptTokenDelta; nextReported: ReportedPromptTokens } {
  const delta: PromptTokenDelta = { prompts: 0, tokens: emptyTokenUsage() };
  const nextReported: ReportedPromptTokens = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    delta.prompts += Math.max(0, cur.prompts - (prev?.prompts ?? 0));
    delta.tokens = addTokenUsage(delta.tokens, tokenDelta(cur.tokens, prev?.tokens));
    nextReported[sid] = { prompts: cur.prompts, tokens: cur.tokens };
  }

  return { delta, nextReported };
}

/** Accumulate a prompt/token delta onto the user's existing totals. */
export function mergePromptTokenStats(
  existingPrompts: number | undefined,
  existingTokens: TokenUsage | undefined,
  delta: PromptTokenDelta,
): { prompts: number; tokens: TokenUsage } {
  return {
    prompts: (existingPrompts ?? 0) + delta.prompts,
    tokens: addTokenUsage(existingTokens, delta.tokens),
  };
}

/** True when a prompt/token delta carries any new data worth pushing. */
function hasPromptTokenDelta(d: PromptTokenDelta): boolean {
  return d.prompts > 0 || d.tokens.input > 0 || d.tokens.output > 0
    || d.tokens.cacheRead > 0 || d.tokens.cacheCreation > 0;
}

/**
 * Filter dashboard events by scope:
 * - projectRoot set: keep only events whose cwd is under that root.
 * - excludeProjectRoots set: exclude events whose cwd is under any listed root.
 * - Neither: return all events (backward-compatible).
 */
export function filterEventsByScope(
  events: DashboardEvent[],
  opts?: { projectRoot?: string; excludeProjectRoots?: string[] },
): DashboardEvent[] {
  if (!opts) return events;
  if (opts.projectRoot) {
    const root = opts.projectRoot.replace(/\/$/, '');
    const prefix = root + '/';
    return events.filter((e) => e.cwd === root || e.cwd?.startsWith(prefix));
  }
  if (opts.excludeProjectRoots && opts.excludeProjectRoots.length > 0) {
    const normalized = opts.excludeProjectRoots.map((r) => r.replace(/\/$/, ''));
    const prefixes = normalized.map((r) => r + '/');
    return events.filter((e) => {
      if (!e.cwd) return true;
      return !normalized.some((r, i) => e.cwd === r || e.cwd!.startsWith(prefixes[i]));
    });
  }
  return events;
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
  options?: { skipTruncate?: boolean; projectRoot?: string; excludeProjectRoots?: string[] },
): Promise<void> {
  try {
    const events = await readUsageEvents();
    const filesToPush: string[] = [];

    // Fold the local dashboard event log into per-session metrics once, then derive
    // both the intervention delta and the prompt-count/token delta from it.
    // Filter by scope so project repos only receive project sessions and vice versa.
    const allDashboardEvents = await readEvents();
    const dashboardEvents = filterEventsByScope(allDashboardEvents, options);
    const metrics = aggregateSessionMetrics(dashboardEvents);

    const currentInterventions = new Map(
      [...metrics].map(([sid, m]) => [sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction }]),
    );
    const reportedInterventions = await readReportedInterventions();
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      currentInterventions,
      reportedInterventions,
    );

    const reportedPromptTokens = await readReportedPromptTokens();
    const { delta: promptTokenDelta, nextReported: nextReportedPromptTokens } = computePromptTokenDelta(
      metrics,
      reportedPromptTokens,
    );

    const hasUsage = events.length > 0;
    const hasInterventions = hasInterventionDelta(interventionDelta);
    const hasPromptTokens = hasPromptTokenDelta(promptTokenDelta);

    // Reset any dirty/conflicted state and ensure we're on the default branch before pulling.
    // Same pattern as push.ts — the team repo is a cache, safe to discard local state.
    const git = createGit(repoPath);
    await resetToCleanMaster(git, repoPath);
    await pullRepo(repoPath);

    // Process usage and/or intervention/prompt/token stats if anything is new to report.
    if (hasUsage || hasInterventions || hasPromptTokens) {
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
      if (hasPromptTokens) {
        const pt = mergePromptTokenStats(existing?.prompts, existing?.tokens, promptTokenDelta);
        merged.prompts = pt.prompts;
        merged.tokens = pt.tokens;
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
      : (hasInterventions || hasPromptTokens)
        ? `[teamai] Update session stats for ${username}`
        : `[teamai] Update votes for ${username}`;
    const pushPromise = pushRepoDirectly(repoPath, commitMsg, filesToPush);

    const timeoutPromise = new Promise<never>((__, reject) =>
      setTimeout(() => reject(new Error('Auto-report timeout (5s)')), 5000),
    );

    await Promise.race([pushPromise, timeoutPromise]);

    // Success — truncate reported usage events (only if caller allows it)
    if (hasUsage && !options?.skipTruncate) {
      await truncateUsageAfterReport(events.length);
      log.debug(`Reported ${events.length} usage events to team repo`);
    } else if (hasUsage) {
      log.debug(`Reported ${events.length} usage events to team repo (kept local copy)`);
    }
    // Success — advance the reported snapshots so we don't re-count.
    // Merge (not overwrite) because each scope only touches its own sessions.
    if (hasInterventions) {
      const existingIv = await readReportedInterventions();
      await writeReportedInterventions({ ...existingIv, ...nextReported });
      log.debug(`Reported intervention delta (${interventionDelta.sessions} new sessions) to team repo`);
    }
    if (hasPromptTokens) {
      const existingPt = await readReportedPromptTokens();
      await writeReportedPromptTokens({ ...existingPt, ...nextReportedPromptTokens });
      log.debug(`Reported prompt/token delta (${promptTokenDelta.prompts} prompts) to team repo`);
    }
    if (!hasUsage && !hasInterventions && !hasPromptTokens) {
      log.debug('Pushed pending votes to team repo');
    }
  } catch (e) {
    log.error(`Auto-report skipped: ${(e as Error).message}`);
  }
}
