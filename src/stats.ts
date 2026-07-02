import YAML from 'yaml';
import path from 'node:path';
import { readUsageEvents } from './usage-tracker.js';
import { readFileSafe } from './utils/fs.js';
import { loadLocalConfig, detectProjectConfig } from './config.js';
import type { UsageEvent, UserStats } from './types.js';

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

/**
 * CLI: Show skill usage statistics.
 * Merges local unreported events with reported team stats for a complete view.
 */
export async function showStats(): Promise<void> {
  const events = await readUsageEvents();
  const localStats = aggregateUsage(events);
  const reported = await loadReportedStats();

  const stats = mergeLocalAndReported(localStats, reported);

  if (stats.length === 0) {
    console.log('No skill usage data yet.');
    console.log('Usage tracking starts automatically via PostToolUse hook.');
    return;
  }

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
