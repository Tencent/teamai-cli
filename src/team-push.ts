import YAML from 'yaml';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readUsageEvents, truncateUsageAfterReport } from './usage-tracker.js';
import { aggregateUsage } from './stats.js';
import { collectTeamRepoSkills } from './agent-skills.js';
import { BUILTIN_SKILL_NAMES } from './builtin-skills.js';
import { readEvents, aggregateSessionMetrics, dataHomeKey, memberEvents, sessionRuns } from './dashboard-collector.js';
import { RUN_MODES, type RunMode, type SessionRun } from './launch-context.js';
import { addOutcomeStats } from './outcomes.js';
import { SessionOutcomes, type FoldInput } from './session-outcomes.js';
import { writeFile, readFileSafe, ensureDir, pathExists, readJson, writeJson } from './utils/fs.js';
import { log } from './utils/logger.js';
import type {
  UserStats, UserModeStats, UserInterventionStats, SessionMetrics, TokenUsage, DashboardEvent, LocalConfig, RequestCostMetrics, UserVotesV2,
} from './types.js';
import { getVotesDir, getDataHome, getReportsDir, emptyTokenUsage, addTokenUsage, usesBranchWorktree } from './types.js';
import { filterEventsByScope, runsOfLog } from './dashboard-scope.js';
import {
  creditedPrompts, interventionsEntry, promptTokensEntry, readOwnerCredits, recordSessionOwners, reportedBeyondShared, reportedSize,
  sharedSnapshotPath, snapshotPathIn,
  type ReportedInterventions, type ReportedPromptTokens, type ReportedSegments, type ReportedSnapshotName,
  type OwnerCredit, type SessionOwnerState,
} from './session-owners.js';
import {
  aggregateDailySessions,
  computeDailyStatsDelta,
  mergeDailyStats,
  takeDailySession,
  parseDailySnapshot,
  parseRequestDaily,
  addRequestDaily,
  type DailySessionSnapshot,
  type ReportedDailySessions,
} from './session-trends.js';

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
//  [reportUsage()]
//      │
//      ▼
//  [update teamai-reports branch]
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

  // Every field this report does not refresh carries over, so a partial report
  // never drops another writer's data (#425, #1170). Callers overwrite
  // interventions/prompts/tokens/daily when that report carries a delta.
  return {
    ...existing,
    username,
    updatedAt: new Date().toISOString(),
    skills,
  };
}

/**
 * The set of skill names that may be published in stats: the team repo's
 * shared catalog plus the CLI's built-in skills (deployed by the CLI itself
 * and served via `teamai skill get`, never present in `skills/` — without
 * them, adoption of the built-in `teamai` skill would silently disappear
 * from the digest, #1056 review). The catalog is enumerated from the team
 * repo's default-branch checkout. The reports branch is an orphan branch and
 * never carries `skills/`, so the catalog must always be enumerated from the
 * main repo path, not from the worktree stats are written into (#1055).
 */
export async function teamSharedSkillNames(repoRoot: string): Promise<Set<string>> {
  const names = new Set((await collectTeamRepoSkills(repoRoot)).keys());
  for (const name of BUILTIN_SKILL_NAMES) names.add(name);
  return names;
}

/**
 * Merge usage stats into the published file, filtering new usage to skill
 * names the team actually shares (#1055). `stats/<user>.yaml` is visible to
 * everyone who pulls, so a member's local-only skills, slash-command names and
 * stray SKILL.md reads must not be published; the local `usage.jsonl` keeps
 * full fidelity. Names published before this filter existed are kept as-is:
 * they remain in the git history either way, and rewriting that history is
 * costly (maintainer call on #1056). An empty catalog (a team that shares no
 * skills) therefore only blocks new additions.
 */
export function mergeStatsWithinTeamSkills(
  existing: UserStats | null,
  username: string,
  newEvents: { name: string; count: number; lastUsed: Date }[],
  teamSkills: ReadonlySet<string>,
): UserStats {
  return mergeStats(existing, username, newEvents.filter((s) => teamSkills.has(s.name)));
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
//  a snapshot, it migrates the shared entries for its retained unkeyed runs;
//  path-keyed releases already wrote scope snapshots. After that only its own
//  file is read. No scope writes the shared file any more, only an earlier
//  release after a rollback (and a caller without a scope config, which reads
//  the whole log and reports into it).
//

/** A scope's own snapshot. The user scope's data home holds the shared one, hence its prefix. */
function scopeSnapshotPath(name: ReportedSnapshotName, config: LocalConfig | undefined): string {
  return config ? snapshotPathIn(getDataHome(config), name) : sharedSnapshotPath(name);
}


/**
 * A scope's snapshot, seeded from the shared one when the scope has none yet.
 * The shared file summed every scope's runs of an ID, so they consume it in
 * the order of the whole log, and the scope keeps its own runs' shares.
 * `split` gives each run of the log its entry at its own totals and its share
 * of a bare entry, for {@link adoptBareKeys}.
 */
async function readSnapshot<T>(
  name: ReportedSnapshotName,
  config: LocalConfig | undefined,
  split: (events: DashboardEvent[]) => Promise<{ current: Record<string, T>; take: TakeReported<T> }>,
  persist = true,
  ownerState?: SessionOwnerState,
): Promise<Record<string, T> | null> {
  const own = scopeSnapshotPath(name, config);
  if (!config || await pathExists(own)) return readJson<Record<string, T>>(own);
  const shared = await readJson<Record<string, T>>(sharedSnapshotPath(name));
  const logged = await readEvents();
  const all = await runsOfLog(logged);
  const events = await filterEventsByScope(logged, config, { owners: ownerState?.owners, dryRun: !persist, suppressMigrationNotice: !persist });
  const { current, take } = await split(all);
  const adopted = adoptBareKeys(shared ?? {}, all, current, take, 'shared');
  // A tool's own session ID is one session, so its entry is copied whole, as
  // before: resumed after compaction dropped its events, it is not sent again.
  // A fallback entry is copied only as a run of this scope: an unmatched bare
  // one cannot be allowed to attach to a future reuse of its PID.
  const ownRuns = new Set(events.map((e) => e.sessionId));
  const seed: Record<string, T> = {};
  for (const [id, entry] of Object.entries(adopted)) {
    if (!id.startsWith('pid-') || ownRuns.has(id)) seed[id] = entry;
  }
  // A read-only caller (`teamai stats`) leaves the seed to the report.
  if (!persist) return seed;
  try {
    await writeJson(own, seed);
    // The seed covers what the shared file had by its last write, and a later
    // report reads that from this file's time (see droppedRollouts).
    const sharedTime = await fs.promises.stat(sharedSnapshotPath(name)).then((stat) => stat.mtime, () => undefined);
    if (sharedTime) await fs.promises.utimes(own, sharedTime, sharedTime);
  } catch (e) {
    // Seeded again next time: the shared file is not written any more.
    log.debug(`Could not seed ${own}: ${(e as Error).message}`);
  }
  return seed;
}

export async function readReportedInterventions(config: LocalConfig | undefined, persist = true, ownerState?: SessionOwnerState): Promise<ReportedInterventions> {
  const parsed = await readSnapshot('interventions', config, async (events) => ({
    current: Object.fromEntries(interventionCounts(aggregateSessionMetrics(events))),
    take: takeInterventions(await sharedCoverage(events)),
  }), persist, ownerState);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function writeReportedInterventions(data: ReportedInterventions, config: LocalConfig | undefined): Promise<void> {
  try {
    await writeJson(scopeSnapshotPath('interventions', config), data);
  } catch (e) {
    log.error(`Failed to persist reported interventions: ${(e as Error).message}`);
  }
}

/** Each session's intervention counts, the shape its snapshot entry holds. */
export function interventionCounts(metrics: Map<string, SessionMetrics>): Map<string, ReportedInterventions[string]> {
  return new Map([...metrics].map(([sid, m]) => [sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction }]));
}

/** A counter's share of what is left: up to the run's own. */
function upTo(own: number, left: number): number {
  return Math.max(0, Math.min(own, left));
}

/**
 * A run's prompt and token share of a bare entry. This snapshot decides which
 * runs of the ID that release reported: the ones its prompts and tokens reach.
 */
const takePromptTokens: TakeReported<ReportedPromptTokens[string]> = (run, entry) => {
  // Read from a snapshot file an earlier release wrote, so parsed, not trusted.
  const left = promptTokensEntry(entry);
  if (left.prompts <= 0 && !hasPromptTokenDelta({ prompts: 0, tokens: left.tokens })) return undefined;
  const taken = {
    prompts: upTo(run.prompts, left.prompts),
    tokens: {
      input: upTo(run.tokens.input, left.tokens.input),
      output: upTo(run.tokens.output, left.tokens.output),
      cacheRead: upTo(run.tokens.cacheRead, left.tokens.cacheRead),
      cacheCreation: upTo(run.tokens.cacheCreation, left.tokens.cacheCreation),
    },
  };
  return { taken, left: { prompts: left.prompts - taken.prompts, tokens: tokenDelta(left.tokens, taken.tokens) } };
};

/**
 * A run's intervention share, for the runs `covered`, the prompt-token
 * snapshot's: these counts are mostly zero, so running out says nothing.
 */
function takeInterventions(covered: (runId: string) => boolean): TakeReported<ReportedInterventions[string]> {
  return (run, entry, runId) => {
    if (!covered(runId)) return undefined;
    const left = interventionsEntry(entry);
    const taken = {
      interrupt: upTo(run.interrupt, left.interrupt),
      toolReject: upTo(run.toolReject, left.toolReject),
      correction: upTo(run.correction, left.correction),
    };
    return {
      taken,
      left: {
        interrupt: left.interrupt - taken.interrupt,
        toolReject: left.toolReject - taken.toolReject,
        correction: left.correction - taken.correction,
      },
    };
  };
}

/** The runs of the whole log (`all`) the shared prompt-token snapshot covers, for seeding. */
async function sharedCoverage(all: DashboardEvent[]): Promise<(runId: string) => boolean> {
  const shared = await readJson<ReportedPromptTokens>(sharedSnapshotPath('prompt-tokens'));
  const current = computePromptTokenDelta(aggregateSessionMetrics(all), {}).nextReported;
  const covered = adoptBareKeys(shared ?? {}, all, current, takePromptTokens, 'shared');
  return (runId) => Object.hasOwn(covered, runId);
}

/** A run's daily share, for the runs `covered`, as for interventions. */
function takeDaily(covered: (runId: string) => boolean): TakeReported<DailySessionSnapshot> {
  return (run, left, runId) => (covered(runId) ? takeDailySession(run, left) : undefined);
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

export async function readReportedPromptTokens(config: LocalConfig | undefined, persist = true, ownerState?: SessionOwnerState): Promise<ReportedPromptTokens> {
  const parsed = await readSnapshot('prompt-tokens', config, async (events) => ({
    current: computePromptTokenDelta(aggregateSessionMetrics(events), {}).nextReported,
    take: takePromptTokens,
  }), persist, ownerState);
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

/** A rollout's key in a snapshot: its transcript path, hashed. */
function segmentKey(transcript: string): string {
  return createHash('sha256').update(transcript).digest('hex').slice(0, 16);
}

/** The reported rollouts of a snapshot entry read from a file; empty when it holds none. */
function reportedSegments(entry: unknown): ReportedSegments {
  const segments: ReportedSegments = {};
  if (!entry || typeof entry !== 'object' || !('segments' in entry) || !entry.segments || typeof entry.segments !== 'object') {
    return segments;
  }
  for (const [key, segment] of Object.entries(entry.segments)) {
    const iv = interventionsEntry(segment);
    const durationMs: unknown = segment && typeof segment === 'object' && 'durationMs' in segment ? segment.durationMs : 0;
    segments[key] = {
      ...promptTokensEntry(segment), interrupt: iv.interrupt, toolReject: iv.toolReject, correction: iv.correction,
      durationMs: typeof durationMs === 'number' ? durationMs : 0,
      requestDaily: parseRequestDaily(segment && typeof segment === 'object' && 'requestDaily' in segment ? segment.requestDaily : undefined),
      failed: !!segment && typeof segment === 'object' && 'failed' in segment && segment.failed === true,
    };
  }
  return segments;
}

/** A reported rollout compaction has dropped: its key and the totals it was reported with. */
export interface DroppedRollout {
  key: string; prompts: number; tokens: TokenUsage; interrupt: number; toolReject: number; correction: number;
  durationMs: number; requestDaily: Record<string, RequestCostMetrics>; failed: boolean;
}

/**
 * The rollouts of each transcript-scoped session (Codex) that were reported and
 * that compaction has since dropped. A rollout's counters restart, so the
 * session's totals must keep what those were reported with, or a later rollout
 * is compared against them and reported late or never.
 *
 * An entry written before rollouts were kept is one total. An earlier release
 * rewrote every session in the log on each report, so that total covers the
 * rollouts that had begun by `writtenAt`, when its file was last written, as
 * far as each had got by then (`before`: the metrics of the events up to
 * `writtenAt`): those still in the log consume it in order, and what is left
 * is the dropped ones', kept as one prior rollout. A rollout begun after it is
 * new, as is what one begun before it has done since. Without `writtenAt`,
 * every rollout in the log is taken as covered, as it is now.
 */
export function droppedRollouts(
  current: Map<string, SessionMetrics>,
  promptTokens: ReportedPromptTokens,
  interventions: ReportedInterventions,
  daily: ReportedDailySessions,
  writtenAt?: number,
  before?: Map<string, SessionMetrics>,
): Map<string, DroppedRollout[]> {
  const dropped = new Map<string, DroppedRollout[]>();
  for (const [sid, cur] of current) {
    if (!cur.segments) continue;
    const prev = promptTokens[sid];
    if (prev === undefined) continue;
    const previous = reportedSegments(prev);
    const present = new Set(Object.keys(cur.segments).map(segmentKey));
    const gone: DroppedRollout[] = [];
    if (Object.keys(previous).length > 0) {
      for (const [key, segment] of Object.entries(previous)) {
        if (present.has(key)) continue;
        gone.push({
          key, prompts: segment.prompts, tokens: segment.tokens, interrupt: segment.interrupt ?? 0,
          toolReject: segment.toolReject ?? 0, correction: segment.correction ?? 0, durationMs: segment.durationMs ?? 0,
          requestDaily: segment.requestDaily ?? {}, failed: segment.failed ?? false,
        });
      }
    } else {
      const total = promptTokensEntry(prev);
      const iv = interventionsEntry(interventions[sid]);
      const day = parseDailySnapshot(daily[sid]);
      const left = {
        prompts: total.prompts, tokens: { ...total.tokens }, interrupt: iv.interrupt, toolReject: iv.toolReject,
        correction: iv.correction, durationMs: day?.durationMs ?? 0, requestDaily: { ...day?.requestDaily },
      };
      const covered = Object.values((writtenAt !== undefined && before?.get(sid)?.segments) || cur.segments)
        .filter((segment) => writtenAt === undefined || Date.parse(segment.since) <= writtenAt)
        .sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
      const take = (own: number, rest: number) => Math.max(0, Math.min(own, rest));
      for (const segment of covered) {
        for (const field of ['prompts', 'interrupt', 'toolReject', 'correction', 'durationMs'] as const) {
          left[field] -= take(segment[field], left[field]);
        }
        for (const field of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
          left.tokens[field] -= take(segment.tokens[field], left.tokens[field]);
        }
        for (const [date, request] of Object.entries(segment.requestDaily)) {
          const rest = left.requestDaily[date];
          if (!rest) continue;
          left.requestDaily[date] = {
            ...rest,
            pricedRequests: rest.pricedRequests - take(request.pricedRequests, rest.pricedRequests),
            costMicros: rest.costMicros - take(request.costMicros, rest.costMicros),
            cacheReadTokens: rest.cacheReadTokens - take(request.cacheReadTokens, rest.cacheReadTokens),
            cacheEligibleInputTokens: rest.cacheEligibleInputTokens - take(request.cacheEligibleInputTokens, rest.cacheEligibleInputTokens),
          };
        }
      }
      const anyLeft = left.prompts > 0 || left.interrupt > 0 || left.toolReject > 0 || left.correction > 0 || left.durationMs > 0
        || hasPromptTokenDelta({ prompts: 0, tokens: left.tokens })
        || Object.values(left.requestDaily).some((r) => r.pricedRequests > 0 || r.costMicros > 0);
      // What that release counted as the session's outcome stays with its part.
      if (anyLeft) gone.push({ key: 'prior', ...left, failed: day?.succeeded === 0 });
    }
    // A thread-level counter already holds every rollout's tokens.
    if (cur.tokensSpanRollouts) for (const rollout of gone) rollout.tokens = emptyTokenUsage();
    if (gone.length > 0) dropped.set(sid, gone);
  }
  return dropped;
}

/**
 * Compute the prompt-count + token delta to report: for each current session, the
 * positive change since it was last reported. Idempotent (a re-run reports nothing
 * new), and never negative if a snapshot shrinks. The next snapshot keeps only
 * sessions still present in events.jsonl (compacted sessions stay folded into totals).
 *
 * A transcript-scoped session (Codex) is reported per rollout: each rollout's
 * counters restart, and the session's total sums those still in the log plus
 * the `dropped` ones (see {@link droppedRollouts}), which the next snapshot
 * keeps, so a later rollout of the session is reported in full.
 */
export function computePromptTokenDelta(
  current: Map<string, SessionMetrics>,
  reported: ReportedPromptTokens,
  dropped: Map<string, DroppedRollout[]> = droppedRollouts(current, reported, {}, {}),
): { delta: PromptTokenDelta; nextReported: ReportedPromptTokens } {
  const delta: PromptTokenDelta = { prompts: 0, tokens: emptyTokenUsage() };
  const nextReported: ReportedPromptTokens = {};

  for (const [sid, cur] of current) {
    const prev = reported[sid];
    let prompts = cur.prompts;
    let tokens = cur.tokens;
    let segments: ReportedSegments | undefined;
    if (cur.segments) {
      segments = {};
      for (const [transcript, segment] of Object.entries(cur.segments)) {
        segments[segmentKey(transcript)] = {
          prompts: segment.prompts, tokens: { ...segment.tokens }, interrupt: segment.interrupt, toolReject: segment.toolReject,
          correction: segment.correction, durationMs: segment.durationMs, requestDaily: segment.requestDaily,
          failed: segment.error || segment.interrupt > 0 || segment.correction > 0,
        };
      }
      for (const gone of dropped.get(sid) ?? []) {
        const { key, ...totals } = gone;
        segments[key] = totals;
        prompts += gone.prompts;
        tokens = addTokenUsage(tokens, gone.tokens);
      }
    }
    delta.prompts += Math.max(0, prompts - (prev?.prompts ?? 0));
    delta.tokens = addTokenUsage(delta.tokens, tokenDelta(tokens, prev?.tokens));
    nextReported[sid] = { prompts, tokens, ...(segments ? { segments } : {}) };
  }

  return { delta, nextReported };
}

/**
 * The intervention counts and daily snapshots a report compares, with each
 * session's dropped rollouts added (see {@link droppedRollouts}): Stop counts
 * and prompts restart per rollout like the tokens do.
 */
export function withDroppedRollouts(
  interventions: Map<string, ReportedInterventions[string]>,
  daily: Map<string, DailySessionSnapshot>,
  dropped: Map<string, DroppedRollout[]>,
): { interventions: Map<string, ReportedInterventions[string]>; daily: Map<string, DailySessionSnapshot> } {
  const nextInterventions = new Map(interventions);
  const nextDaily = new Map(daily);
  for (const [sid, gone] of dropped) {
    const sum = (field: 'prompts' | 'interrupt' | 'toolReject' | 'correction' | 'durationMs') =>
      gone.reduce((total, rollout) => total + rollout[field], 0);
    const tokens = gone.reduce((total, rollout) => addTokenUsage(total, rollout.tokens), emptyTokenUsage());
    const counts = nextInterventions.get(sid);
    if (counts) {
      nextInterventions.set(sid, {
        interrupt: counts.interrupt + sum('interrupt'), toolReject: counts.toolReject + sum('toolReject'),
        correction: counts.correction + sum('correction'),
      });
    }
    const day = nextDaily.get(sid);
    if (day) {
      nextDaily.set(sid, {
        ...day,
        prompts: day.prompts + sum('prompts'),
        durationMs: day.durationMs + sum('durationMs'),
        sessionCacheReadTokens: (day.sessionCacheReadTokens ?? 0) + tokens.cacheRead,
        sessionCacheEligibleTokens: (day.sessionCacheEligibleTokens ?? 0) + tokens.input + tokens.cacheRead + tokens.cacheCreation,
        requestDaily: gone.reduce((total, rollout) => addRequestDaily(total, rollout.requestDaily), day.requestDaily),
        // A session one of whose rollouts failed or was corrected did not succeed.
        succeeded: gone.some((rollout) => rollout.failed) ? 0 : day.succeeded,
        corrected: gone.some((rollout) => rollout.correction > 0) ? 1 : day.corrected,
      });
    }
  }
  return { interventions: nextInterventions, daily: nextDaily };
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

async function readReportedDailySessions(config: LocalConfig | undefined, persist = true, ownerState?: SessionOwnerState): Promise<ReportedDailySessions> {
  return (await readSnapshot('daily-sessions', config, async (events) => ({
    current: computeDailyStatsDelta(aggregateDailySessions(events), {}).nextReported,
    take: takeDaily(await sharedCoverage(events)),
  }), persist, ownerState)) ?? {};
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
 * A session main split across scopes, crediting every part it reported. Main
 * (#795) gave each event to the scope its `dataHome` names and reported each
 * part against that scope's own snapshot, so a scope's entry may hold only its
 * part (prompts counted before any Stop carried the transcript's total). The
 * scope that owns the whole run now takes as reported the metrics of the union
 * of those parts: for each scope, the shortest prefix of its events whose own
 * metrics reach its snapshot. Only an entry that union exceeds is replaced, so a
 * run already reported past it is left alone; runs whose events name at most
 * one data home are untouched.
 */
async function creditSplitRuns(
  events: DashboardEvent[],
  reported: { interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions },
  ownerCredits?: ReadonlyMap<string, OwnerCredit>,
): Promise<{
  interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions; changed: boolean;
}> {
  const byRun = new Map<string, DashboardEvent[]>();
  for (const e of events) byRun.set(e.sessionId, [...(byRun.get(e.sessionId) ?? []), e]);
  const result = {
    interventions: { ...reported.interventions }, promptTokens: { ...reported.promptTokens }, daily: { ...reported.daily },
    changed: false,
  };
  const credits = ownerCredits ?? await readOwnerCredits();
  for (const [runId, runEvents] of byRun) {
    const homes = new Set(runEvents.flatMap((e) => (typeof e.dataHome === 'string' ? [e.dataHome] : [])));
    // Its parts' events are gone: the credit the owners file seeded from their snapshots.
    const credit = homes.size < 2 ? credits.get(runId) : undefined;
    if (credit) {
      // Placed by the transcript where it can tell what the parts overlapped.
      const transcripts = runEvents.flatMap((e) => (typeof e.transcriptPath === 'string' ? [e.transcriptPath] : []));
      const prompts = (await creditedPrompts(credit, transcripts)) ?? credit.promptTokens.prompts;
      result.changed = raiseToCredit(result, runId, {
        promptTokens: { ...credit.promptTokens, prompts },
        interventions: credit.interventions,
        daily: credit.daily ? { ...credit.daily, prompts } : undefined,
      }) || result.changed;
      continue;
    }
    if (homes.size < 2) continue;
    // Main keyed its snapshots by the session ID, before runs had their own.
    const id = runId.startsWith('pid-') ? runId.slice(0, runId.lastIndexOf('@')) : runId;
    const counted = new Set<DashboardEvent>();
    for (const home of homes) {
      const snapshot = await readJson<Record<string, unknown>>(snapshotPathIn(home, 'prompt-tokens'));
      const target = reportedSize(snapshot?.[id]);
      if (!snapshot || !Object.hasOwn(snapshot, id)) continue;
      const part = runEvents.filter((e) => e.dataHome === home);
      for (let k = 1; k <= part.length; k++) {
        const size = aggregateSessionMetrics(part.slice(0, k)).get(runId);
        const tokens = size ? size.tokens.input + size.tokens.output + size.tokens.cacheRead + size.tokens.cacheCreation : 0;
        if (k === part.length || (size && size.prompts >= target.prompts && tokens >= target.tokens)) {
          for (const e of part.slice(0, k)) counted.add(e);
          break;
        }
      }
    }
    const union = runEvents.filter((e) => counted.has(e));
    if (union.length === 0) continue;
    const metrics = aggregateSessionMetrics(union);
    const promptTokens = computePromptTokenDelta(metrics, {}).nextReported[runId];
    if (!promptTokens) continue;
    result.changed = raiseToCredit(result, runId, {
      promptTokens,
      interventions: interventionCounts(metrics).get(runId),
      daily: computeDailyStatsDelta(aggregateDailySessions(union), {}).nextReported[runId],
    }) || result.changed;
  }
  return result;
}

/**
 * Raises a run's baselines to at least `credit`, counter by counter: a part
 * may have reported more time, tokens or costs with no more prompts. Flags
 * and dates stay the run's own where it has an entry. Whether anything moved.
 */
function raiseToCredit(
  result: { interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions },
  runId: string,
  credit: {
    promptTokens: ReportedPromptTokens[string];
    interventions: ReportedInterventions[string] | undefined;
    daily: DailySessionSnapshot | undefined;
  },
): boolean {
  const before = JSON.stringify([result.promptTokens[runId], result.interventions[runId], result.daily[runId]]);
  const own = result.promptTokens[runId];
  const ownTokens = promptTokensEntry(own);
  const greater = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
    input: Math.max(a.input, b.input), output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheCreation: Math.max(a.cacheCreation, b.cacheCreation),
  });
  result.promptTokens[runId] = {
    ...own,
    prompts: Math.max(ownTokens.prompts, credit.promptTokens.prompts),
    tokens: greater(ownTokens.tokens, credit.promptTokens.tokens),
  };
  if (credit.interventions) {
    const iv = interventionsEntry(result.interventions[runId]);
    result.interventions[runId] = {
      interrupt: Math.max(iv.interrupt, credit.interventions.interrupt),
      toolReject: Math.max(iv.toolReject, credit.interventions.toolReject),
      correction: Math.max(iv.correction, credit.interventions.correction),
    };
  }
  if (credit.daily) {
    const day = parseDailySnapshot(result.daily[runId]);
    if (!day) {
      result.daily[runId] = credit.daily;
    } else {
      const requestDaily = { ...day.requestDaily };
      for (const [date, request] of Object.entries(credit.daily.requestDaily)) {
        const mine = requestDaily[date];
        requestDaily[date] = mine ? {
          ...mine,
          pricedRequests: Math.max(mine.pricedRequests, request.pricedRequests), costMicros: Math.max(mine.costMicros, request.costMicros),
          cacheReadTokens: Math.max(mine.cacheReadTokens, request.cacheReadTokens),
          cacheEligibleInputTokens: Math.max(mine.cacheEligibleInputTokens, request.cacheEligibleInputTokens),
        } : request;
      }
      result.daily[runId] = {
        ...day,
        prompts: Math.max(day.prompts, credit.daily.prompts),
        durationMs: Math.max(day.durationMs, credit.daily.durationMs),
        sessionCacheReadTokens: Math.max(day.sessionCacheReadTokens ?? 0, credit.daily.sessionCacheReadTokens ?? 0),
        sessionCacheEligibleTokens: Math.max(day.sessionCacheEligibleTokens ?? 0, credit.daily.sessionCacheEligibleTokens ?? 0),
        requestDaily,
      };
    }
  }
  return JSON.stringify([result.promptTokens[runId], result.interventions[runId], result.daily[runId]]) !== before;
}

/** The metrics of `events` up to `at`, what an entry written then saw; undefined without `at`. */
export function metricsAsOf(events: DashboardEvent[], at: number | undefined): Map<string, SessionMetrics> | undefined {
  return at === undefined ? undefined : aggregateSessionMetrics(events.filter((e) => Date.parse(e.timestamp) <= at));
}

/**
 * When the scope's prompt-token snapshot was last written, before this report
 * writes it: its own file's, else the shared one it would be seeded from. An
 * entry an earlier release left covers what that release had seen by then.
 */
export async function snapshotWrittenAt(config: LocalConfig | undefined): Promise<number | undefined> {
  const mtime = (file: string) => fs.promises.stat(file).then((stat) => stat.mtimeMs, () => undefined);
  const own = await mtime(scopeSnapshotPath('prompt-tokens', config));
  if (own === undefined) return mtime(sharedSnapshotPath('prompt-tokens'));
  // An earlier release wrote the snapshot after its push, and the team stats
  // file in this scope's reports checkout before it, after reading the log: the
  // earlier of the two is nearer what that report had read.
  const stats = config ? await mtime(path.join(getReportsDir(config), 'stats', `${config.username}.yaml`)) : undefined;
  return stats === undefined ? own : Math.min(own, stats);
}

/**
 * A scope's reported snapshots as its report and `teamai stats` compare them:
 * bare entries adopted by the runs of `events` (prompt tokens first, since they
 * decide which runs of a bare ID were reported), and a session an earlier
 * release split across scopes credited with every part. With `persist`, what
 * changed is written out at once, even with nothing to report, so the report's
 * success writes, which merge into the files, cannot bring a retired entry back.
 */
export async function reportedBaselines(
  events: DashboardEvent[],
  metrics: Map<string, SessionMetrics>,
  currentDaily: Map<string, DailySessionSnapshot>,
  config: LocalConfig | undefined,
  persist: boolean,
  ownerState?: SessionOwnerState,
): Promise<{ interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions }> {
  const adopt = async <T>(
    read: (config: LocalConfig | undefined, persist: boolean, ownerState?: SessionOwnerState) => Promise<Record<string, T>>,
    write: (data: Record<string, T>, config: LocalConfig | undefined) => Promise<void>,
    current: Record<string, T>,
    take: TakeReported<T>,
  ): Promise<Record<string, T>> => {
    const stored = await read(config, persist, ownerState);
    const adopted = adoptBareKeys(stored, events, current, take);
    if (persist && adopted !== stored) await write(adopted, config);
    return adopted;
  };
  const promptTokens = await adopt(
    readReportedPromptTokens, writeReportedPromptTokens, computePromptTokenDelta(metrics, {}).nextReported, takePromptTokens,
  );
  const covered = (runId: string) => Object.hasOwn(promptTokens, runId);
  const interventions = await adopt(
    readReportedInterventions, writeReportedInterventions, Object.fromEntries(interventionCounts(metrics)),
    takeInterventions(covered),
  );
  const daily = await adopt(
    readReportedDailySessions, writeReportedDailySessions, computeDailyStatsDelta(currentDaily, {}).nextReported,
    takeDaily(covered),
  );
  const credited = await creditSplitRuns(events, { interventions, promptTokens, daily }, ownerState?.credits);
  if (persist && credited.changed) {
    await writeReportedInterventions(credited.interventions, config);
    await writeReportedPromptTokens(credited.promptTokens, config);
    await writeReportedDailySessions(credited.daily, config);
  }
  return { interventions: credited.interventions, promptTokens: credited.promptTokens, daily: credited.daily };
}

/**
 * A run's share of what is left of a bare snapshot entry, or undefined when
 * nothing is left: that run and every later one of its ID were not reported.
 */
export type TakeReported<T> = (run: T, left: T, runId: string) => { taken: T; left: T } | undefined;

/**
 * A reported snapshot as the run IDs of {@link filterEventsByScope} read it.
 * Snapshots written before fallback runs had their own IDs are keyed by the
 * bare `pid-…` ID, holding the sum of the runs of that ID in the log at that
 * release's last report; compaction keeps or drops the runs of an ID together.
 * So the runs of that ID in `events` (the scope's, as that filter returns them)
 * consume the entry in order, each taking its share, from its totals in
 * `current`, of what is left; once nothing is left, the later runs take none
 * and are reported as new. The first run always takes one: the entry means
 * that release reported it. A run's own entry is never replaced, and the bare
 * entry is retired, so no later run of that ID reads it. Only an earlier
 * release wrote bare entries, and only for runs it recorded, so a run whose
 * first event carries a `dataHomeKey`, and every later run of its ID, takes
 * none: the entry may be another scope's run under a reused PID-fallback ID.
 * Shared snapshots also exclude path-keyed runs: that release already had
 * per-scope snapshots. A tool's own session ID keys its one run as it is, so
 * its entry needs no adoption. Returns `reported` itself when there is nothing
 * to retire; otherwise the caller persists the result.
 */
export function adoptBareKeys<T>(
  reported: Record<string, T>,
  events: Iterable<DashboardEvent>,
  current: Record<string, T>,
  take: TakeReported<T>,
  source: 'scope' | 'shared' = 'scope',
): Record<string, T> {
  const legacyRuns = new Map<string, string[]>();
  const recorded = new Set<string>();
  const seen = new Set<string>();
  for (const { sessionId: runId, dataHomeKey, dataHome } of events) {
    if (seen.has(runId) || !runId.startsWith('pid-')) continue;
    seen.add(runId);
    const id = runId.slice(0, runId.lastIndexOf('@'));
    if (recorded.has(id) || !Object.hasOwn(reported, id)) continue;
    if (typeof dataHomeKey === 'string' || (source === 'shared' && typeof dataHome === 'string')) {
      recorded.add(id);
      continue;
    }
    legacyRuns.set(id, [...(legacyRuns.get(id) ?? []), runId]);
  }
  if (legacyRuns.size === 0) return reported;
  const adopted = { ...reported };
  for (const [id, runs] of legacyRuns) {
    let left = reported[id];
    let first = true;
    for (const runId of runs) {
      if (!Object.hasOwn(current, runId)) continue;
      const share = take(current[runId], left, runId);
      if (!share) {
        if (first && !Object.hasOwn(adopted, runId)) adopted[runId] = left;
        break;
      }
      if (!Object.hasOwn(adopted, runId)) adopted[runId] = share.taken;
      left = share.left;
      first = false;
    }
    delete adopted[id];
  }
  return adopted;
}

/** What one report adds to a member's counters, in total or in one run mode. */
type UsageDelta = {
  interventions: UserInterventionStats;
  promptTokens: PromptTokenDelta;
  daily: ReturnType<typeof computeDailyStatsDelta>['delta'];
};

/**
 * The deltas of the sessions whose run mode is `mode`, against the same per-session baselines the top-level counters
 * use: a session's change counts in the mode its latest event recorded, so no turn is reported twice, and a session
 * with no recorded mode adds to neither.
 */
function modeDelta(
  mode: RunMode,
  runs: Map<string, SessionRun>,
  current: { interventions: Map<string, ReportedInterventions[string]>; metrics: Map<string, SessionMetrics>; daily: Map<string, DailySessionSnapshot> },
  reported: { interventions: ReportedInterventions; promptTokens: ReportedPromptTokens; daily: ReportedDailySessions },
  dropped: Map<string, DroppedRollout[]>,
): UsageDelta {
  const inMode = <T>(sessions: Map<string, T>) => new Map([...sessions].filter(([sid]) => runs.get(sid)?.runMode === mode));
  return {
    interventions: computeInterventionDelta(inMode(current.interventions), reported.interventions).delta,
    promptTokens: computePromptTokenDelta(inMode(current.metrics), reported.promptTokens, dropped).delta,
    daily: computeDailyStatsDelta(inMode(current.daily), reported.daily).delta,
  };
}

/** The counters `delta` changes, each as `existing` holds it with `delta` added. A counter it leaves alone is absent. */
function changedCounters(existing: UserModeStats | undefined, delta: UsageDelta): UserModeStats {
  const changed: UserModeStats = {};
  if (hasInterventionDelta(delta.interventions)) changed.interventions = mergeInterventionStats(existing?.interventions, delta.interventions);
  if (hasPromptTokenDelta(delta.promptTokens)) {
    const pt = mergePromptTokenStats(existing?.prompts, existing?.tokens, delta.promptTokens);
    changed.prompts = pt.prompts;
    changed.tokens = pt.tokens;
  }
  if (hasDailyDelta(delta.daily)) changed.daily = mergeDailyStats(existing?.daily, delta.daily);
  return changed;
}

/** What one usage report did: pushed the new counts, found none to push, or did not push them (skipped or failed). */
export type UsageReportOutcome = 'reported' | 'nothing' | 'unreported';

/**
 * Reports this scope's usage data to the team repo.
 * Merges new events with existing stats to preserve historical data.
 * Best-effort: silently fails on any error.
 * Resolves only after push and success bookkeeping settle. The caller may bound
 * its wait, but must keep this operation alive so late success is acknowledged.
 */
export async function reportUsage(
  repoPath: string,
  username: string,
  options: { skipTruncate?: boolean; selfConfig: LocalConfig; drain?: FoldInput['drain'] },
): Promise<UsageReportOutcome> {
  const reportsConfig = options.selfConfig;
  if (!usesBranchWorktree(reportsConfig)) {
    log.debug(`Skipping report for HTTP repo ${repoPath}`);
    return 'unreported';
  }
  let restoreStats: (() => Promise<void>) | undefined;

  // Reports-branch writes use the reports-lock, not the partition sync-lock
  // (non-reentrant; pull() already holds it).

  try {
    // This scope's own skill usage (#748); a caller without a scope reports none.
    const events = await readUsageEvents(reportsConfig);
    // This scope's own votes (#787), likewise.
    const votesDir = getVotesDir(reportsConfig);
    const filesToPush: string[] = [];

    // Fold the local dashboard event log into per-session metrics once, then derive
    // both the intervention delta and the prompt-count/token delta from it.
    // Only the member's own sessions recorded in this scope (#785).
    const logged = await readEvents();
    const scopedEvents = await filterEventsByScope(logged, reportsConfig);
    const dashboardEvents = memberEvents(scopedEvents);
    const metrics = aggregateSessionMetrics(dashboardEvents);

    const currentInterventions = interventionCounts(metrics);
    const currentDaily = aggregateDailySessions(dashboardEvents);
    const writtenAt = await snapshotWrittenAt(reportsConfig);
    const {
      interventions: reportedInterventions, promptTokens: reportedPromptTokens, daily: reportedDailySessions,
    } = await reportedBaselines(dashboardEvents, metrics, currentDaily, reportsConfig, true);
    const dropped = droppedRollouts(
      metrics, reportedPromptTokens, reportedInterventions, reportedDailySessions, writtenAt, metricsAsOf(dashboardEvents, writtenAt),
    );
    const effective = withDroppedRollouts(currentInterventions, currentDaily, dropped);
    const { delta: promptTokenDelta, nextReported: nextReportedPromptTokens } = computePromptTokenDelta(
      metrics,
      reportedPromptTokens,
      dropped,
    );
    const { delta: interventionDelta, nextReported } = computeInterventionDelta(
      effective.interventions,
      reportedInterventions,
    );
    const { delta: dailyDelta, nextReported: nextReportedDailySessions } = computeDailyStatsDelta(
      effective.daily,
      reportedDailySessions,
    );
    const runs = sessionRuns(dashboardEvents);
    const modeDeltas = RUN_MODES.map((mode) => [mode, modeDelta(
      mode, runs, { interventions: effective.interventions, metrics, daily: effective.daily },
      { interventions: reportedInterventions, promptTokens: reportedPromptTokens, daily: reportedDailySessions }, dropped,
    )] as const);
    // This scope's sessions, and those of its snapshots no owner claims yet
    // (a project whose data home is in its workspace, which the seed may miss).
    await recordSessionOwners([
      ...dashboardEvents.map((e) => e.sessionId),
      ...await reportedBeyondShared(reportedPromptTokens, reportedInterventions, reportedDailySessions),
    ], await dataHomeKey(getDataHome(reportsConfig)));

    // What the scope's finished sessions delivered (#1387), counted once each, with the usage this report counts for them.
    const outcomeFold = await SessionOutcomes.fold({
      config: reportsConfig, logged, scoped: scopedEvents, member: dashboardEvents,
      totals: {
        promptTokens: { ...reportedPromptTokens, ...nextReportedPromptTokens },
        interventions: { ...reportedInterventions, ...nextReported },
      },
      now: Date.now(),
      drain: options.drain,
    });

    const hasUsage = events.length > 0;
    const hasInterventions = hasInterventionDelta(interventionDelta);
    const hasPromptTokens = hasPromptTokenDelta(promptTokenDelta);
    const hasDaily = hasDailyDelta(dailyDelta);
    const hasOutcomes = outcomeFold.finished.length > 0;

    const hasStats = hasUsage || hasInterventions || hasPromptTokens || hasDaily || hasOutcomes;
    const commitMsg = hasUsage
      ? `[teamai] Update usage stats for ${username}`
      : (hasInterventions || hasPromptTokens || hasDaily || hasOutcomes)
        ? `[teamai] Update session stats for ${username}`
        : `[teamai] Update votes for ${username}`;

    const writeReportFiles = async (
      writeRoot: string,
      votesStaged: { syncedDeltas?: UserVotesV2['deltas'] },
    ): Promise<void> => {
      // The team's shared-skill catalog for the #1055 privacy filter. Always
      // enumerated from repoPath (the default-branch checkout): writeRoot may
      // be the orphan reports-branch worktree, which never carries skills/.
      const teamSkillNames = await teamSharedSkillNames(repoPath);
      // Process usage and/or intervention/prompt/token stats if anything is new to report.
      if (hasStats) {
        const statsDir = path.join(writeRoot, 'stats');
        await ensureDir(statsDir);
        const statsPath = path.join(statsDir, `${username}.yaml`);

        // See also: stats.ts mergeLocalAndReported() — same merge logic for display.
        // mergeStats with [] preserves existing skills while refreshing username/updatedAt,
        // and carries every other field so partial reports do not clobber them (#425, #1170).
        const existing = await readExistingStats(statsPath);
        const previousContent = await readFileSafe(statsPath);
        // A failed push can leave an already-incremented file in the reports
        // worktree. Restore its input so a normal retry does not add it twice.
        restoreStats = () => writeFile(statsPath, previousContent ?? '');
        const newStats = hasUsage ? aggregateUsage(events) : [];
        // #1055: new usage is filtered to names the team actually shares (plus
        // CLI built-ins); names published before this filter existed are kept
        // as-is (maintainer call on #1056). The catalog comes from the
        // default-branch repo path, never from writeRoot (the reports branch
        // is an orphan without skills/).
        const merged = mergeStatsWithinTeamSkills(existing, username, newStats, teamSkillNames);
        Object.assign(merged, changedCounters(existing ?? undefined, { interventions: interventionDelta, promptTokens: promptTokenDelta, daily: dailyDelta }));
        for (const [mode, delta] of modeDeltas) {
          const counters = { ...existing?.[mode], ...changedCounters(existing?.[mode], delta) };
          if (Object.keys(counters).length > 0) merged[mode] = counters;
        }
        if (hasOutcomes) merged.outcomes = addOutcomeStats(existing?.outcomes, outcomeFold.delta);

        await writeFile(statsPath, YAML.stringify(merged));
        filesToPush.push(`stats/${username}.yaml`);
      }

      // Always stage pending local votes (V2 delta-aware merge). Through the
      // reports branch the deltas are NOT cleared here: they are cleared by
      // confirmVotesSynced once the push is confirmed delivered (#1027), so a
      // failed push or a crash keeps them pending instead of losing the sync
      // trigger forever.
      try {
        if (await pathExists(votesDir)) {
          const { stageVotesMerge, readUserVotesFromContent } = await import('./votes.js');
          const { readReportsOriginFile } = await import('./utils/reports-branch.js');
          const origin = await readReportsOriginFile(writeRoot, `votes/${username}.yaml`);
          const staged = await stageVotesMerge(
            writeRoot,
            username,
            votesDir,
            origin === null ? null : readUserVotesFromContent(origin),
          );
          if (staged) {
            votesStaged.syncedDeltas = staged.syncedDeltas;
            filesToPush.push(`votes/${username}.yaml`);
          }
        }
      } catch (e) {
        log.error(`Vote staging skipped: ${(e as Error).message}`);
      }
    };

    // Keep push and acknowledgement in the same operation. A caller timing out
    // must not abandon the success bookkeeping below.
    let hasVotes = false;
    if (!hasStats && await pathExists(votesDir)) {
      const { hasPendingVoteDeltas } = await import('./votes.js');
      hasVotes = await hasPendingVoteDeltas(votesDir, username);
    }
    if (!hasStats && !hasVotes) {
      log.debug('No usage events or votes to report');
      return 'nothing';
    }
    const { updateReports } = await import('./utils/reports-branch.js');
    const { isPublished } = await import('./utils/branch-worktree.js');
    const votesStaged: { syncedDeltas?: UserVotesV2['deltas'] } = {};
    const result = await updateReports(reportsConfig, async (wt, { onDelivered }) => {
      filesToPush.length = 0;
      await writeReportFiles(wt, votesStaged);
      if (votesStaged.syncedDeltas) {
        // Clear the staged deltas only once origin holds them, under the
        // reports lock (see the votes-sync handler) — a busy lock, a failed
        // push, or a crash keeps them pending for the next report (#1027).
        onDelivered(() => import('./votes.js').then(({ confirmVotesSynced }) =>
          confirmVotesSynced(path.join(votesDir, `${username}.yaml`), votesStaged.syncedDeltas!)));
      }
      return { files: [...filesToPush], message: commitMsg };
    }, { pushIfUnchanged: true });
    const pushed = isPublished(result);
    if (!pushed) {
      log.debug('Auto-report push was not confirmed; keeping local report data');
      await restoreStats?.();
      return 'unreported';
    }
    restoreStats = undefined;

    // Success — truncate reported usage events (only if caller allows it)
    if (hasUsage && !options.skipTruncate) {
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
    // It also holds each rollout's totals, which any delta may have moved.
    if (hasPromptTokens || hasInterventions || hasDaily) {
      const existingPt = await readReportedPromptTokens(reportsConfig);
      await writeReportedPromptTokens({ ...existingPt, ...nextReportedPromptTokens }, reportsConfig);
      log.debug(`Reported prompt/token delta (${promptTokenDelta.prompts} prompts) to team repo`);
    }
    if (hasDaily) {
      const existingDaily = await readReportedDailySessions(reportsConfig);
      await writeReportedDailySessions({ ...existingDaily, ...nextReportedDailySessions }, reportsConfig);
      log.debug(`Reported daily session trends (${Object.keys(dailyDelta).length} UTC day buckets) to team repo`);
    }
    if (hasOutcomes) {
      await SessionOutcomes.markReported(reportsConfig, outcomeFold.finished);
      log.debug(`Reported the outcomes of ${outcomeFold.finished.length} finished sessions to team repo`);
    }
    if (!hasUsage && !hasInterventions && !hasPromptTokens && !hasDaily && !hasOutcomes) {
      log.debug('Pushed pending votes to team repo');
    }
    return 'reported';
  } catch (e) {
    try {
      await restoreStats?.();
    } catch (restoreError) {
      log.error(`Could not restore report stats after failure: ${(restoreError as Error).message}`);
    }
    log.error(`Auto-report skipped: ${(e as Error).message}`);
    return 'unreported';
  }
}
