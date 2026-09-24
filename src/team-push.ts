import YAML from 'yaml';
import fs from 'node:fs';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { readEvents, aggregateSessionMetrics } from './dashboard-collector.js';
import {
  createGit,
  pushRepoDirectly,
  pullRepo,
  resetToCleanMaster,
  isDedicatedRepoRoot,
  getFileContentAtRev,
} from './utils/git.js';
import { writeFile, readFileSafe, ensureDir, pathExists, readJson, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import type { UserStats, UserInterventionStats, SessionMetrics, TokenUsage, DashboardEvent, LocalConfig } from './types.js';
import { getVotesDir, getDataHome, getTeamaiHomeDir, emptyTokenUsage, addTokenUsage, usesBranchWorktree } from './types.js';
import { getUserHome } from './utils/home.js';
import {
  aggregateDailySessions,
  computeDailyStatsDelta,
  mergeDailyStats,
  type ReportedDailySessions,
} from './session-trends.js';

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
//  [read scope usage file] ─has events?─▶ merge stats
//      │                                           │
//      ▼                                           ▼
//  [stage pending votes from scope votes dir]   [write stats/<user>.yaml]
//      │                                           │
//      ▼  ◄────────────────────────────────────────┘
//  [anything to push?] ──no──▶ SKIP
//      │
//      ▼
//  [git add + commit + push]
//      │
//      ├──success──▶ truncate JSONL (if events existed)
//      └──fail──▶ retain local events and reported snapshots
//  pull bounds its wait for the whole operation, including success bookkeeping.
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
    // Preserve session metrics across partial reports (Issue #425).
    // mergeStats only refreshes skills/username/updatedAt; callers overwrite
    // interventions/prompts/tokens when that report carries a non-empty delta.
    ...(existing?.interventions !== undefined ? { interventions: existing.interventions } : {}),
    ...(existing?.prompts !== undefined ? { prompts: existing.prompts } : {}),
    ...(existing?.tokens !== undefined ? { tokens: existing.tokens } : {}),
    ...(existing?.daily !== undefined ? { daily: existing.daily } : {}),
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

// ─── Reported snapshots, one set per scope (#786) ──────
//
//  <dataHome>/dashboard/reported-<name>.json          project scope
//  ~/.teamai/dashboard/user-reported-<name>.json      user scope
//  ~/.teamai/dashboard/reported-<name>.json           shared, written before #786
//
//  A session can record events in two scopes (a `cd` mid-session), so each
//  scope compares against what it reported itself. The first time a scope needs
//  a snapshot, it copies the shared one, so nothing an earlier release reported
//  is sent again; after that only its own file is read. No scope writes the
//  shared file any more, only an earlier release after a rollback (and a caller
//  without a scope config, which reads the whole log and reports into it).
//

type ReportedSnapshotName = 'interventions' | 'prompt-tokens' | 'daily-sessions';

/** The machine-level snapshot every scope shared before #786 (evaluated at call time for tests). */
function sharedSnapshotPath(name: ReportedSnapshotName): string {
  return path.join(getTeamaiHomeDir(), 'dashboard', `reported-${name}.json`);
}

/** A scope's own snapshot. The user scope's data home holds the shared one, hence its prefix. */
function scopeSnapshotPath(name: ReportedSnapshotName, config: LocalConfig | undefined): string {
  if (!config) return sharedSnapshotPath(name);
  const dataHome = getDataHome(config);
  const file = `reported-${name}.json`;
  if (path.resolve(dataHome) !== path.resolve(getTeamaiHomeDir())) return path.join(dataHome, 'dashboard', file);
  return path.join(dataHome, 'dashboard', `user-${file}`);
}

/** A scope's snapshot, seeded from the shared one when the scope has none yet. */
async function readSnapshot<T>(name: ReportedSnapshotName, config: LocalConfig | undefined): Promise<T | null> {
  const own = scopeSnapshotPath(name, config);
  if (!config || await pathExists(own)) return readJson<T>(own);
  const seed = await readJson<T>(sharedSnapshotPath(name));
  try {
    await writeJson(own, seed ?? {});
  } catch (e) {
    // Seeded again next time: the shared file is not written any more.
    log.debug(`Could not seed ${own}: ${(e as Error).message}`);
  }
  return seed;
}

export async function readReportedInterventions(config: LocalConfig | undefined): Promise<ReportedInterventions> {
  const parsed = await readSnapshot<ReportedInterventions>('interventions', config);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedInterventions(data: ReportedInterventions, config: LocalConfig | undefined): Promise<void> {
  try {
    await writeJson(scopeSnapshotPath('interventions', config), data);
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

export async function readReportedPromptTokens(config: LocalConfig | undefined): Promise<ReportedPromptTokens> {
  const parsed = await readSnapshot<ReportedPromptTokens>('prompt-tokens', config);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedPromptTokens(data: ReportedPromptTokens, config: LocalConfig | undefined): Promise<void> {
  try {
    await writeJson(scopeSnapshotPath('prompt-tokens', config), data);
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

async function readReportedDailySessions(config: LocalConfig | undefined): Promise<ReportedDailySessions> {
  return (await readSnapshot<ReportedDailySessions>('daily-sessions', config)) ?? {};
}

async function writeReportedDailySessions(data: ReportedDailySessions, config: LocalConfig | undefined): Promise<void> {
  await writeJson(scopeSnapshotPath('daily-sessions', config), data);
}

function hasDailyDelta(delta: ReturnType<typeof computeDailyStatsDelta>['delta']): boolean {
  return Object.values(delta).some((bucket) =>
    // sessionsSucceeded can be negative (a resumed session that later failed
    // claws back an earlier increment), so it must not be checked with the
    // same "> 0" as the other, purely monotonic counters (#473).
    bucket.sessionsEnded > 0 || bucket.sessionsSucceeded !== 0 || bucket.promptTurns > 0
    || bucket.durationMs > 0 || bucket.sessionsCorrected > 0 || bucket.pricedRequests > 0
    || bucket.costMicros > 0 || bucket.cacheReadTokens > 0 || bucket.cacheEligibleInputTokens > 0,
  );
}

/**
 * A Windows-style root: a drive letter (`C:\`, `c:/`) or a UNC share
 * (`\\server\share`). Tested per path rather than per platform, because the
 * dashboard event log is shared — a team repo can hold events pushed from
 * Windows and from Linux in the same file.
 */
const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\)/;

type ScopeRoot = { key: string; windows: boolean };

/**
 * Normalize a directory path for scope comparison.
 *
 * Both sides are native paths: `projectRoot` is stored as `path.resolve(cwd)`
 * at init time, and an event's `cwd` is whatever the AI tool put in its hook
 * payload. On Windows both use backslashes, so a literal `root + '/'` prefix
 * can never match a subdirectory, and the two sources can also disagree on the
 * case of the drive letter or of any directory along the way. Windows paths
 * therefore get their separators unified and their case folded.
 *
 * POSIX paths keep both distinctions: they are case-sensitive, and `\` is a
 * legal character in a POSIX filename, so `/work/a\b` and `/work/a/b` are two
 * different directories and must not collapse onto one key.
 *
 * The root decides which set of rules applies to both sides, so a Windows root
 * still matches a cwd the tool reported with forward slashes, and a POSIX root
 * never has a backslash rewritten underneath it.
 */
function scopeKey(dir: string, windows: boolean): string {
  if (!windows) return dir.replace(/\/+$/, '');
  return dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function scopeRoot(dir: string): ScopeRoot {
  const windows = WINDOWS_ROOT.test(dir);
  return { key: scopeKey(dir, windows), windows };
}

/** True when `cwd` is the root itself or sits below it. */
function isUnderScopeRoot(cwd: string, root: ScopeRoot): boolean {
  const key = scopeKey(cwd, root.windows);
  return key === root.key || key.startsWith(root.key + '/');
}

/**
 * The dashboard events a scope reports (#785): those recorded in it, keyed by
 * its data home. A project also owns the key of its in-repo `.teamai`, where a
 * hook recorded until migration moved the project to a partition. An event
 * written before events carried a data home belongs to the project whose root holds
 * its cwd, never to the user scope. `projectRoot` is realpath'd, but a cwd is
 * raw as the host sent it (a symlinked checkout, macOS `/tmp` vs
 * `/private/tmp`) and so is a non-git project's data home, so both are
 * realpath'd while they still exist. A caller without a scope config reads the
 * whole log.
 */
export async function filterEventsByScope(
  events: DashboardEvent[],
  config?: LocalConfig,
): Promise<DashboardEvent[]> {
  if (!config) return events;
  const realPaths = new Map<string, Promise<string>>();
  const realPath = (dir: string): Promise<string> => {
    let real = realPaths.get(dir);
    if (!real) {
      real = fs.promises.realpath(dir).catch(() => dir);
      realPaths.set(dir, real);
    }
    return real;
  };
  const keyOf = async (home: string): Promise<ScopeRoot> => scopeRoot(await realPath(home));
  const homeRoots = [await keyOf(getDataHome(config))];
  if (config.projectRoot) {
    // Unless the project is rooted at HOME, where that is the user scope's.
    const legacy = await keyOf(path.join(config.projectRoot, '.teamai'));
    if (legacy.key !== (await keyOf(path.join(getUserHome(), '.teamai'))).key) homeRoots.push(legacy);
  }
  const root = config.projectRoot ? scopeRoot(config.projectRoot) : undefined;
  const kept = await Promise.all(events.map(async (e) => {
    if (e.dataHome !== undefined) {
      const dataHome = await realPath(e.dataHome);
      return homeRoots.some((home) => scopeKey(dataHome, home.windows) === home.key);
    }
    return !!root && !!e.cwd && isUnderScopeRoot(await realPath(e.cwd), root);
  }));
  return events.filter((_, i) => kept[i]);
}

/**
 * Auto-report usage data to team repo during pull.
 * Merges new events with existing stats to preserve historical data.
 * Best-effort: silently fails on any error.
 * Resolves only after push and success bookkeeping settle. The caller may bound
 * its wait, but must keep this operation alive so late success is acknowledged.
 * Returns false when reporting was skipped or failed; true when there is no
 * pending data or the report completed successfully.
 */
export async function reportUsageToTeam(
  repoPath: string,
  username: string,
  options?: { skipTruncate?: boolean; selfConfig?: LocalConfig },
): Promise<boolean> {
  // Non-HTTP repos: stats + votes are report data → the teamai-reports orphan
  // branch (isolated worktree). We must NOT resetToCleanMaster / pullRepo /
  // pushRepoDirectly on the default branch (or, in self mode, the business
  // working tree). The dedicated writer handles the worktree + rebase race.
  const reportsConfig = options?.selfConfig;
  const useReportsBranch = !!reportsConfig && usesBranchWorktree(reportsConfig);
  let restoreStats: (() => Promise<void>) | undefined;

  // Reports-branch writes use the reports-lock, not the partition sync-lock
  // (non-reentrant; pull() already holds it). The else-branch clone reset is
  // only for callers that did not pass a config.

  try {
    // This scope's own skill usage (#748); a caller without a scope reports none.
    const events = reportsConfig ? await readUsageEvents(reportsConfig) : [];
    // This scope's own votes (#787), likewise.
    const votesDir = reportsConfig ? getVotesDir(reportsConfig) : undefined;
    const filesToPush: string[] = [];

    // Fold the local dashboard event log into per-session metrics once, then derive
    // both the intervention delta and the prompt-count/token delta from it.
    // Only the sessions recorded in this scope (#785).
    const dashboardEvents = await filterEventsByScope(await readEvents(), reportsConfig);
    const metrics = aggregateSessionMetrics(dashboardEvents);

    const currentInterventions = new Map(
      [...metrics].map(([sid, m]) => [sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction }]),
    );
    const reportedInterventions = await readReportedInterventions(reportsConfig);
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      currentInterventions,
      reportedInterventions,
    );

    const reportedPromptTokens = await readReportedPromptTokens(reportsConfig);
    const { delta: promptTokenDelta, nextReported: nextReportedPromptTokens } = computePromptTokenDelta(
      metrics,
      reportedPromptTokens,
    );
    const reportedDailySessions = await readReportedDailySessions(reportsConfig);
    const { delta: dailyDelta, nextReported: nextReportedDailySessions } = computeDailyStatsDelta(
      aggregateDailySessions(dashboardEvents),
      reportedDailySessions,
    );

    const hasUsage = events.length > 0;
    const hasInterventions = hasInterventionDelta(interventionDelta);
    const hasPromptTokens = hasPromptTokenDelta(promptTokenDelta);
    const hasDaily = hasDailyDelta(dailyDelta);

    const hasStats = hasUsage || hasInterventions || hasPromptTokens || hasDaily;
    const commitMsg = hasUsage
      ? `[teamai] Update usage stats for ${username}`
      : (hasInterventions || hasPromptTokens || hasDaily)
        ? `[teamai] Update session stats for ${username}`
        : `[teamai] Update votes for ${username}`;

    const writeReportFiles = async (writeRoot: string): Promise<void> => {
      // Process usage and/or intervention/prompt/token stats if anything is new to report.
      if (hasStats) {
        const statsDir = path.join(writeRoot, 'stats');
        await ensureDir(statsDir);
        const statsPath = path.join(statsDir, `${username}.yaml`);

        // See also: stats.ts mergeLocalAndReported() — same merge logic for display.
        // mergeStats with [] preserves existing skills while refreshing username/updatedAt,
        // and carries interventions/prompts/tokens so partial reports do not clobber them (#425).
        const existing = await readExistingStats(statsPath);
        if (useReportsBranch) {
          const previousContent = await readFileSafe(statsPath);
          // A failed push can leave an already-incremented file in the reports
          // worktree. Restore its input so a normal retry does not add it twice.
          restoreStats = () => writeFile(statsPath, previousContent ?? '');
        }
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
        if (hasDaily) {
          merged.daily = mergeDailyStats(existing?.daily, dailyDelta);
        }

        await writeFile(statsPath, YAML.stringify(merged));
        filesToPush.push(`stats/${username}.yaml`);
      }

      // Always stage pending local votes (V2 delta-aware merge)
      try {
        if (votesDir && await pathExists(votesDir)) {
          const { syncVotesToTeam } = await import('./votes.js');
          const synced = await syncVotesToTeam(writeRoot, username, votesDir);
          if (synced) {
            filesToPush.push(`votes/${username}.yaml`);
          }
        }
      } catch (e) {
        log.error(`Vote staging skipped: ${(e as Error).message}`);
      }
    };

    // Keep push and acknowledgement in the same operation. A caller timing out
    // must not abandon the success bookkeeping below.
    if (useReportsBranch && reportsConfig) {
      let hasVotes = false;
      if (!hasStats && votesDir && await pathExists(votesDir)) {
        const { hasPendingVoteDeltas } = await import('./votes.js');
        hasVotes = await hasPendingVoteDeltas(votesDir, username);
      }
      if (!hasStats && !hasVotes) {
        log.debug('No usage events or votes to report');
        return true;
      }
      const { updateReports } = await import('./utils/reports-branch.js');
      const pushed = await updateReports(reportsConfig, async (wt) => {
        filesToPush.length = 0;
        await writeReportFiles(wt);
        return filesToPush.length > 0 ? { files: [...filesToPush], message: commitMsg } : null;
      }, { pushIfUnchanged: true });
      if (!pushed) {
        log.debug('Auto-report push was not confirmed; keeping local report data');
        await restoreStats?.();
        return false;
      }
    } else {
      // The team repo is a disposable cache clone here — safe to discard local state
      // and reset to the default branch before pulling (same pattern as push.ts).
      //
      // Defense-in-depth: this whole else-branch assumes repoPath is a dedicated clone
      // ROOT with its own .git. If it is not the git top level, git commands here bubble
      // up to the nearest enclosing .git and act on the USER'S BUSINESS REPO instead —
      // reset --hard wipes their uncommitted work and checkout switches them off their
      // branch. Two known ways repoPath ends up inside the business repo:
      //   - self mode: localPath is `<businessRoot>/.teamai`
      //   - project scope: localPath is `<projectRoot>/.teamai/team-repo`, and when that
      //     dir has no dedicated .git (clone missing/incomplete) it resolves to the
      //     business repo root.
      // In either case bail out: there is no safe cache root to report into.
      const git = createGit(repoPath);
      if (!(await isDedicatedRepoRoot(repoPath))) {
        log.debug(`Skipping report: ${repoPath} is not a dedicated team-repo root (safety guard)`);
        return false;
      }
      const { isImportInProgress } = await import('./utils/import-lock.js');
      if (await isImportInProgress(repoPath)) {
        log.debug(`Skipping report: import in progress for ${repoPath} (would reset uncommitted artifacts)`);
        return false;
      }
      const yamlPath = path.join(repoPath, 'teamai.yaml');
      const workingContent = await readFileSafe(yamlPath);
      const committedContent = workingContent === null
        ? null
        : await getFileContentAtRev(repoPath, 'HEAD', 'teamai.yaml');
      const pendingTeamConfig = workingContent !== null
        && (committedContent === null || committedContent.toString() !== workingContent)
        ? workingContent
        : null;

      try {
        await resetToCleanMaster(git, repoPath);
        await pullRepo(repoPath);
      } finally {
        // `source add` and `source remove` intentionally leave teamai.yaml
        // uncommitted until `teamai push`. Auto-report must not discard those edits.
        // Keep the complete local version, matching pushCore: it remains an explicit
        // working-tree diff for review instead of being silently committed here.
        if (pendingTeamConfig !== null) {
          await writeFile(yamlPath, pendingTeamConfig);
        }
      }

      await writeReportFiles(repoPath);
      if (filesToPush.length === 0) {
        log.debug('No usage events or votes to report');
        return true;
      }
      await pushRepoDirectly(repoPath, commitMsg, filesToPush);
    }
    restoreStats = undefined;

    // Success — truncate reported usage events (only if caller allows it)
    if (hasUsage && reportsConfig && !options?.skipTruncate) {
      await truncateUsageAfterReport(events.length, reportsConfig);
      log.debug(`Reported ${events.length} usage events to team repo`);
    } else if (hasUsage) {
      log.debug(`Reported ${events.length} usage events to team repo (kept local copy)`);
    }
    // Success — advance the reported snapshots so we don't re-count.
    // Merge (not overwrite) because each scope only touches its own sessions.
    if (hasInterventions) {
      const existingIv = await readReportedInterventions(reportsConfig);
      await writeReportedInterventions({ ...existingIv, ...nextReported }, reportsConfig);
      log.debug(`Reported intervention delta (${interventionDelta.sessions} new sessions) to team repo`);
    }
    if (hasPromptTokens) {
      const existingPt = await readReportedPromptTokens(reportsConfig);
      await writeReportedPromptTokens({ ...existingPt, ...nextReportedPromptTokens }, reportsConfig);
      log.debug(`Reported prompt/token delta (${promptTokenDelta.prompts} prompts) to team repo`);
    }
    if (hasDaily) {
      const existingDaily = await readReportedDailySessions(reportsConfig);
      await writeReportedDailySessions({ ...existingDaily, ...nextReportedDailySessions }, reportsConfig);
      log.debug(`Reported daily session trends (${Object.keys(dailyDelta).length} UTC day buckets) to team repo`);
    }
    if (!hasUsage && !hasInterventions && !hasPromptTokens && !hasDaily) {
      log.debug('Pushed pending votes to team repo');
    }
    return true;
  } catch (e) {
    try {
      await restoreStats?.();
    } catch (restoreError) {
      log.error(`Could not restore report stats after failure: ${(restoreError as Error).message}`);
    }
    log.error(`Auto-report skipped: ${(e as Error).message}`);
    return false;
  }
}
