import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents } from './usage-tracker.js';
import { readFileSafe } from './utils/fs.js';
import { loadLocalConfig, detectProjectConfig } from './config.js';
import { readEvents, aggregateSessionMetrics } from './dashboard-collector.js';
import { totalTokens, addTokenUsage, emptyTokenUsage } from './types.js';
import { attributeByRepo, timeAnalytics, renderHourSparkline } from './session-analytics.js';
import { formatTokenCount } from './digest.js';
import type { UsageEvent, UserStats, TokenUsage, SessionMetrics } from './types.js';

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
    const config = await detectProjectConfig() ?? await loadLocalConfig();
    if (!config) return null;
    const statsPath = path.join(config.repo.localPath, 'stats', `${config.username}.yaml`);
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
  const events = await readUsageEvents();
  const localStats = aggregateUsage(events);
  const reported = await loadReportedStats();
  const stats = mergeLocalAndReported(localStats, reported);

  const dashboardEvents = await readEvents();
  const metricsMap = aggregateSessionMetrics(dashboardEvents);
  const localDashboard = aggregateDashboardStats(metricsMap);
  const dashboard = mergeDashboardAndReported(localDashboard, reported);
  const hasDashboardData =
    dashboard.sessions > 0 || dashboard.prompts > 0 || totalTokens(dashboard.tokens) > 0;

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
      console.log('By Repo:');
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
      console.log('Activity by Hour (local time):');
      console.log('');
      console.log(`  00h ${renderHourSparkline(ta.byHour)} 23h`);
      console.log(`  Peak hour:    ${String(ta.peakHour).padStart(2, '0')}:00`);
      console.log(`  Active time:  ${ta.activeMinutes} min`);
      console.log(`  Night owl:    ${(ta.nightOwlRatio * 100).toFixed(0)}% of activity before 6am`);
    }
  }
}
