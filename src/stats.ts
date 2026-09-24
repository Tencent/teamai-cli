import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents } from './usage-tracker.js';
import { readFileSafe } from './utils/fs.js';
import { resolveConfigForDir } from './config.js';
import { readEvents, aggregateSessionMetrics } from './dashboard-collector.js';
import { totalTokens, addTokenUsage, emptyTokenUsage } from './types.js';
import { attributeByRepo, timeAnalytics, renderHourSparkline } from './session-analytics.js';
import { formatTokenCount } from './digest.js';
import type { UsageEvent, UserStats, TokenUsage, SessionMetrics, LocalConfig } from './types.js';

interface SkillStats {
  name: string;
  count: number;
  lastUsed: Date;
}

/**
 * Aggregate usage events by skill name.
 */
export function aggregateUsage(events: UsageEvent[]): SkillStats[] {
  const map = new Map<string, SkillStats>();

  for (const event of events) {
    const existing = map.get(event.skill);
    const timestamp = new Date(event.timestamp);

    if (existing) {
      existing.count += 1;
      if (timestamp > existing.lastUsed) {
        existing.lastUsed = timestamp;
      }
    } else {
      map.set(event.skill, {
        name: event.skill,
        count: 1,
        lastUsed: timestamp,
      });
    }
  }

  // Sort by count descending
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/**
 * Read the user's reported stats from the team repo.
 * Returns null if not found.
 */
async function loadReportedStats(): Promise<UserStats | null> {
  try {
    const config = await resolveConfigForDir();
    if (!config) return null;
    // Non-HTTP: stats live on the teamai-reports orphan branch worktree.
    // Leftover stats/ on the default-branch clone is ignored. Read-only: never
    // publish a missing reports branch.
    let statsRoot = config.repo.localPath;
    const { usesBranchWorktree } = await import('./types.js');
    if (usesBranchWorktree(config)) {
      const { ensureReportsWorktree } = await import('./utils/reports-branch.js');
      statsRoot = await ensureReportsWorktree(config, { pushIfCreated: false });
    }
    const statsPath = path.join(statsRoot, 'stats', `${config.username}.yaml`);
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
 * Merge local unreported events with reported team stats into a unified view.
 * See also: team-push.ts mergeStats() — same merge logic for auto-report.
 */
function mergeLocalAndReported(localStats: SkillStats[], reported: UserStats | null): SkillStats[] {
  const map = new Map<string, SkillStats>();

  if (reported?.skills) {
    for (const [name, data] of Object.entries(reported.skills)) {
      map.set(name, {
        name,
        count: data.count,
        lastUsed: new Date(data.lastUsed),
      });
    }
  }

  for (const stat of localStats) {
    const existing = map.get(stat.name);
    if (existing) {
      existing.count += stat.count;
      if (stat.lastUsed > existing.lastUsed) {
        existing.lastUsed = stat.lastUsed;
      }
    } else {
      map.set(stat.name, { ...stat });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/**
 * Format relative time for display (e.g., "2h ago", "yesterday").
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toISOString().slice(0, 10);
}

interface AggregatedDashboardStats {
  sessions: number;
  prompts: number;
  tokens: TokenUsage;
  interrupt: number;
  toolReject: number;
  correction: number;
}

function aggregateDashboardStats(metrics: Map<string, SessionMetrics>): AggregatedDashboardStats {
  let prompts = 0, interrupt = 0, toolReject = 0, correction = 0;
  let tokens = emptyTokenUsage();
  for (const m of metrics.values()) {
    prompts += m.prompts;
    interrupt += m.interrupt;
    toolReject += m.toolReject;
    correction += m.correction;
    tokens = addTokenUsage(tokens, m.tokens);
  }
  return { sessions: metrics.size, prompts, tokens, interrupt, toolReject, correction };
}

/**
 * The local dashboard metrics this scope has NOT reported yet: the same
 * per-session delta `teamai pull` pushes, so the displayed total is
 * reported + unreported rather than reported + everything.
 *
 * The caller passes the scope's own metrics, already filtered the way the
 * report path filters them.
 */
async function unreportedDashboardStats(
  metrics: Map<string, SessionMetrics>,
  config: LocalConfig,
): Promise<AggregatedDashboardStats> {
  const {
    computeInterventionDelta, computePromptTokenDelta, readReportedInterventions, readReportedPromptTokens,
  } = await import('./team-push.js');
  // The scope's own snapshots, the ones its report compares against (#786).
  const interventions = await readReportedInterventions(config);
  const promptTokens = await readReportedPromptTokens(config);

  const interventionDelta = computeInterventionDelta(
    new Map([...metrics].map(([sid, m]) => [sid, { interrupt: m.interrupt, toolReject: m.toolReject, correction: m.correction }])),
    interventions,
  );
  const promptTokenDelta = computePromptTokenDelta(metrics, promptTokens);

  return {
    sessions: interventionDelta.delta.sessions,
    prompts: promptTokenDelta.delta.prompts,
    tokens: promptTokenDelta.delta.tokens,
    interrupt: interventionDelta.delta.interrupt,
    toolReject: interventionDelta.delta.toolReject,
    correction: interventionDelta.delta.correction,
  };
}

/**
 * Combine the scope's reported team totals with the local sessions it has not
 * reported yet.
 *
 * `local` must already be the UNREPORTED delta for this scope, not the whole
 * machine's metrics: reported sessions stay in events.jsonl until compaction,
 * so adding the full local aggregate on top of the reported totals counted
 * every one of them twice, and mixed in sessions belonging to other projects.
 */
function mergeDashboardAndReported(
  local: AggregatedDashboardStats,
  reported: UserStats | null,
): AggregatedDashboardStats {
  const merged = { ...local };
  if (reported?.interventions) {
    merged.sessions += reported.interventions.sessions;
    merged.interrupt += reported.interventions.interrupt;
    merged.toolReject += reported.interventions.toolReject;
    merged.correction += reported.interventions.correction;
  }
  if (reported?.prompts) merged.prompts += reported.prompts;
  if (reported?.tokens) merged.tokens = addTokenUsage(merged.tokens, reported.tokens);
  return merged;
}

export interface ShowStatsOptions {
  /** Add a per-repo usage breakdown. */
  byRepo?: boolean;
  /** Add a time-of-day activity breakdown. */
  byTime?: boolean;
}

/**
 * CLI: Show skill usage and session/token statistics.
 * Merges local unreported events with reported team stats for a complete view.
 */
export async function showStats(options: ShowStatsOptions = {}): Promise<void> {
  // The same scope loadReportedStats reads, so local and reported totals match;
  // a directory without teamai has no usage of its own (#748).
  const config = await resolveConfigForDir();
  const events = config ? await readUsageEvents(config) : [];
  const localStats = aggregateUsage(events);
  const reported = await loadReportedStats();
  const stats = mergeLocalAndReported(localStats, reported);

  // Dashboard metrics follow the same scope rules `pull` reports with, so what
  // is shown can agree with what the team holds: this scope's own sessions only,
  // and only the part of them not already reported (reported sessions stay in
  // events.jsonl until compaction, so counting the full local aggregate would
  // count each one twice and pull in other projects' sessions). Same filter,
  // same scope config as the report path (#785).
  const { filterEventsByScope } = await import('./team-push.js');
  const scopedEvents = await filterEventsByScope(await readEvents(), config ?? undefined);
  const metricsMap = aggregateSessionMetrics(scopedEvents);
  // Only subtract what the team already holds. Two guards, because a scope's
  // snapshot is first seeded from the machine-wide one, so it can name sessions
  // this team file never received:
  //
  //  - `reported` null (no stats file, an unreadable one, a reports worktree
  //    that is not there): the snapshot says nothing about what the team
  //    holds, and subtracting it would hide sessions the member can see.
  //  - `reported` present but empty: the team has received nothing yet, so a
  //    snapshot entry cannot describe something it holds. Subtracting anyway
  //    undercounts — down to "No usage data yet." with sessions on disk.
  //
  // Snapshots are written under the same lock as the team file, so a non-empty
  // team total is what licenses trusting the snapshot.
  const teamHasReported = !!reported && (
    (reported.interventions?.sessions ?? 0) > 0
    || (reported.prompts ?? 0) > 0
    || totalTokens(reported.tokens ?? emptyTokenUsage()) > 0
  );
  const localDashboard = config && teamHasReported
    ? await unreportedDashboardStats(metricsMap, config)
    : aggregateDashboardStats(metricsMap);
  const dashboard = mergeDashboardAndReported(localDashboard, reported);
  const hasDashboardData =
    dashboard.sessions > 0 || dashboard.prompts > 0 || totalTokens(dashboard.tokens) > 0;

  // The optional breakdowns read the scope's own event log, which is a
  // different question from the headline: the headline adds this machine's
  // unreported sessions to totals that already include other machines and
  // sessions compaction has since dropped, so the two are not expected to
  // match number for number. What must hold is that the breakdown sees the
  // same SCOPE — hence the shared filter — and never another project's rows.
  const dashboardEvents = scopedEvents;

  if (stats.length === 0 && !hasDashboardData) {
    console.log('No usage data yet.');
    console.log('Usage tracking starts automatically via hooks.');
    return;
  }

  // ─── Skill usage section ───
  if (stats.length > 0) {
    console.log('');
    console.log('Skill Usage Statistics:');
    console.log('');

    const maxNameLen = Math.max(...stats.map((s) => s.name.length), 4);
    const maxCountLen = Math.max(...stats.map((s) => String(s.count).length), 4);

    for (const stat of stats) {
      const name = stat.name.padEnd(maxNameLen);
      const count = String(stat.count).padStart(maxCountLen);
      const recency = formatRelativeTime(stat.lastUsed);
      console.log(`  ${name}  ${count} uses   last: ${recency}`);
    }

    const totalEvents = stats.reduce((sum, s) => sum + s.count, 0);
    console.log('');
    console.log(`Total: ${totalEvents} events across ${stats.length} skill(s)`);
    if (events.length > 0) {
      console.log(`  (${events.length} pending upload)`);
    }
  }

  // ─── Session & usage section ───
  if (hasDashboardData) {
    console.log('');
    console.log('Session & Usage Statistics:');
    console.log('');
    console.log(`  Sessions:           ${dashboard.sessions}`);
    console.log(`  Conversation turns: ${dashboard.prompts}`);

    const total = totalTokens(dashboard.tokens);
    if (total > 0) {
      console.log(`  Tokens (total):     ${formatTokenCount(total)}`);
      console.log(`    Input:            ${formatTokenCount(dashboard.tokens.input)}`);
      console.log(`    Output:           ${formatTokenCount(dashboard.tokens.output)}`);
      if (dashboard.tokens.cacheRead > 0) {
        console.log(`    Cache read:       ${formatTokenCount(dashboard.tokens.cacheRead)}`);
      }
      if (dashboard.tokens.cacheCreation > 0) {
        console.log(`    Cache creation:   ${formatTokenCount(dashboard.tokens.cacheCreation)}`);
      }
    }

    const totalInterventions = dashboard.interrupt + dashboard.toolReject + dashboard.correction;
    if (totalInterventions > 0) {
      console.log('');
      console.log(`  Interventions:      ${totalInterventions}`);
      if (dashboard.interrupt > 0) console.log(`    Interrupts:       ${dashboard.interrupt}`);
      if (dashboard.toolReject > 0) console.log(`    Tool rejects:     ${dashboard.toolReject}`);
      if (dashboard.correction > 0) console.log(`    Corrections:      ${dashboard.correction}`);
    }
  }

  // ─── Per-repo breakdown (--by-repo) ───
  if (options.byRepo) {
    const repos = attributeByRepo(dashboardEvents);
    if (repos.length > 0) {
      console.log('');
      console.log('By Repo (local event log):');
      console.log('');
      const TOP_N = 15;
      const maxLen = Math.max(...repos.slice(0, TOP_N).map((r) => r.repo.length), 4);
      for (const r of repos.slice(0, TOP_N)) {
        const name = r.repo.padEnd(maxLen);
        const tok = totalTokens(r.tokens);
        const parts = [`${r.sessions} sess`, `${r.prompts} turns`, `${r.tools} tools`];
        if (tok > 0) parts.push(`${formatTokenCount(tok)} tok`);
        if (r.interventions > 0) parts.push(`${r.interventions} intv`);
        console.log(`  ${name}  ${parts.join(', ')}`);
      }
      if (repos.length > TOP_N) {
        console.log(`  … and ${repos.length - TOP_N} more`);
      }
    }
  }

  // ─── Time-of-day patterns (--by-time) ───
  if (options.byTime) {
    const ta = timeAnalytics(dashboardEvents);
    if (ta.totalEvents > 0) {
      console.log('');
      console.log('Activity by Hour (local event log):');
      console.log('');
      console.log(`  00h ${renderHourSparkline(ta.byHour)} 23h`);
      console.log(`  Peak hour:    ${String(ta.peakHour).padStart(2, '0')}:00`);
      console.log(`  Active time:  ${ta.activeMinutes} min`);
      console.log(`  Night owl:    ${(ta.nightOwlRatio * 100).toFixed(0)}% of activity before 6am`);
    }
  }
}
