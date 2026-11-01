// Improvement Center payload: read-only aggregates over the stats members publish to
// teamai-reports, the team repo's skills and the KB maintenance candidates.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BUILTIN_SKILL_NAMES, LEGACY_BUILTIN_SKILL_NAMES } from '../builtin-skills.js';

const WINDOW_DAYS = 30;
const HISTORY_DAYS = 180;
const LIST_LIMIT = 200;
// Skill keys the usage tracker can record from a path segment rather than a skill name.
const NOT_SKILLS = new Set(['Users', 'users', 'root', 'home', 'data', 'tmp', 'private', 'var', 'opt']);

export interface DayPoint { date: string; ended: number; succeeded: number; corrected: number; prompts: number; durationMs: number; costMicros: number; priced: number; cacheRead: number; cacheEligible: number; members: number }
/** `uses` is the all-time count members published; stats carry no per-day skill counts. */
export interface SkillUse { name: string; namespace?: string; uses: number; users: number; lastUsed: string | null }

export interface ImprovementData {
  window: { days: number; from: string; to: string; latestStats: string | null };
  members: number;
  daily: DayPoint[];
  friction: { members: number; sessions: number; interrupt: number; toolReject: number; correction: number };
  skills: { teamTotal: number; used: SkillUse[]; unused: SkillUse[]; outside: SkillUse[] };
  maintenance: {
    promote: Array<{ docId: string; title: string; category: string; confidence: number; upvoted: number; users: number }>;
    prune: Array<{ name: string; confidence: number; lastActivity: string; reason: string }>;
    stale: Array<{ docId: string; type: string; recalled: number; upvoted: number; users: number }>;
    silent: number;
  };
}

interface StatsFile {
  username?: string;
  updatedAt?: string;
  skills?: Record<string, { count?: number; lastUsed?: string }>;
  interventions?: { sessions?: number; interrupt?: number; toolReject?: number; correction?: number };
  daily?: Record<string, Record<string, unknown>>;
}

interface MaintenanceInput {
  promote: Array<{ docId: string; title: string; suggestedCategory: string; confidence: number; upvotedCount: number; userCount: number }>;
  prune: Array<{ filename: string; confidence: number; lastActivity: string; reason: string }>;
  stale: Array<{ docId: string; type: string; recalledCount: number; upvotedCount: number; userCount: number }>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const isDay = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
// A published day counts once any counter on it is positive: a day with prompts or cost but no ended session is still data.
const hasActivity = (v: unknown): boolean => !!v && typeof v === 'object' && Object.values(v as Record<string, unknown>).some((x) => num(x) > 0);

async function readStats(statsDir: string): Promise<StatsFile[]> {
  let names: string[];
  try { names = await fs.promises.readdir(statsDir); } catch { return []; }
  const out: StatsFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.yaml'))) {
    try {
      const parsed = YAML.parse(await fs.promises.readFile(path.join(statsDir, name), 'utf-8')) as StatsFile | null;
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch { /* one unreadable member file does not hide the rest */ }
  }
  return out;
}

async function teamSkills(knowledgeRoot: string): Promise<Map<string, string>> {
  const skills = new Map<string, string>();
  const root = path.join(knowledgeRoot, 'skills');
  let namespaces: fs.Dirent[];
  try { namespaces = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return skills; }
  for (const ns of namespaces.filter((d) => d.isDirectory() && !d.name.startsWith('.'))) {
    if (fs.existsSync(path.join(root, ns.name, 'SKILL.md'))) { skills.set(ns.name, ''); continue; }
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(path.join(root, ns.name), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && fs.existsSync(path.join(root, ns.name, e.name, 'SKILL.md'))) skills.set(e.name, ns.name);
    }
  }
  return skills;
}

/**
 * Aggregate the team's published daily stats for the last 180 days, enough for a 90-day view
 * against the 90 before it; skill adoption uses the last 30. The window ends at the newest day
 * any member published activity for, not at "now", so a team that has not pushed lately still shows its days.
 */
export async function buildImprovement(
  paths: { statsDir: string; knowledgeRoot: string },
  maintenance: MaintenanceInput,
  silent: number,
): Promise<ImprovementData> {
  const files = await readStats(paths.statsDir);
  let latest = '';
  let latestStats: string | null = null;
  for (const f of files) {
    for (const [day, v] of Object.entries(f.daily ?? {})) if (isDay(day) && hasActivity(v) && day > latest) latest = day;
    if (f.updatedAt && (!latestStats || f.updatedAt > latestStats)) latestStats = f.updatedAt;
  }
  const end = latest ? new Date(latest + 'T00:00:00Z') : new Date(isoDay(new Date()) + 'T00:00:00Z');
  const from = new Date(end.getTime() - (WINDOW_DAYS - 1) * 86400000);
  const historyFrom = new Date(end.getTime() - (HISTORY_DAYS - 1) * 86400000);
  const [toDay, fromDay, historyDay] = [isoDay(end), isoDay(from), isoDay(historyFrom)];

  const byDay = new Map<string, DayPoint>();
  for (let t = historyFrom.getTime(); t <= end.getTime(); t += 86400000) {
    const d = isoDay(new Date(t));
    byDay.set(d, { date: d, ended: 0, succeeded: 0, corrected: 0, prompts: 0, durationMs: 0, costMicros: 0, priced: 0, cacheRead: 0, cacheEligible: 0, members: 0 });
  }
  const friction = { members: 0, sessions: 0, interrupt: 0, toolReject: 0, correction: 0 };
  const usage = new Map<string, { uses: number; users: Set<string>; lastUsed: string }>();

  for (const f of files) {
    const user = f.username ?? '';
    for (const [day, v] of Object.entries(f.daily ?? {})) {
      if (!v || typeof v !== 'object' || day < historyDay || day > toDay) continue;
      const p = byDay.get(day);
      if (!p) continue;
      p.ended += num(v.sessionsEnded);
      p.succeeded += num(v.sessionsSucceeded);
      p.corrected += num(v.sessionsCorrected);
      p.prompts += num(v.promptTurns);
      p.durationMs += num(v.durationMs);
      p.costMicros += num(v.costMicros);
      p.priced += num(v.pricedRequests);
      p.cacheRead += num(v.cacheReadTokens);
      p.cacheEligible += num(v.cacheEligibleInputTokens);
      if (num(v.sessionsEnded) > 0) p.members += 1;
    }
    if (f.interventions && num(f.interventions.sessions) > 0) {
      friction.members += 1;
      friction.sessions += num(f.interventions.sessions);
      friction.interrupt += num(f.interventions.interrupt);
      friction.toolReject += num(f.interventions.toolReject);
      friction.correction += num(f.interventions.correction);
    }
    for (const [name, s] of Object.entries(f.skills ?? {})) {
      const last = String(s?.lastUsed ?? '');
      if (!last || last.slice(0, 10) < fromDay || NOT_SKILLS.has(name) || name.includes('/')) continue;
      const u = usage.get(name) ?? { uses: 0, users: new Set<string>(), lastUsed: '' };
      u.uses += num(s.count);
      u.users.add(user);
      if (last > u.lastUsed) u.lastUsed = last;
      usage.set(name, u);
    }
  }

  const team = await teamSkills(paths.knowledgeRoot);
  const toUse = (name: string): SkillUse => {
    const u = usage.get(name);
    return { name, ...(team.has(name) && team.get(name) ? { namespace: team.get(name) } : {}), uses: u?.uses ?? 0, users: u?.users.size ?? 0, lastUsed: u?.lastUsed || null };
  };
  // Uses are all-time, so recency (not the cumulative count) breaks ties after member count.
  const byUse = (a: SkillUse, b: SkillUse) => b.users - a.users || (b.lastUsed ?? '').localeCompare(a.lastUsed ?? '') || a.name.localeCompare(b.name);
  // Since #1055 push only publishes team-repo skills and the CLI built-ins, so a name outside the repo is a
  // built-in (not team content), or a skill published before that filter or since removed from the repo.
  const builtin = (n: string) => BUILTIN_SKILL_NAMES.has(n) || LEGACY_BUILTIN_SKILL_NAMES.has(n);
  const teamNames = [...team.keys()];

  return {
    window: { days: WINDOW_DAYS, from: fromDay, to: toDay, latestStats },
    members: files.length,
    daily: [...byDay.values()],
    friction,
    skills: {
      teamTotal: team.size,
      used: teamNames.filter((n) => usage.has(n)).map(toUse).sort(byUse),
      unused: teamNames.filter((n) => !usage.has(n)).map(toUse).sort((a, b) => (a.namespace ?? '').localeCompare(b.namespace ?? '') || a.name.localeCompare(b.name)),
      outside: [...usage.keys()].filter((n) => !team.has(n) && !builtin(n) && (usage.get(n)?.users.size ?? 0) >= 2).map(toUse).sort(byUse),
    },
    maintenance: {
      promote: maintenance.promote.slice(0, LIST_LIMIT).map((c) => ({ docId: c.docId, title: c.title, category: c.suggestedCategory, confidence: c.confidence, upvoted: c.upvotedCount, users: c.userCount })),
      prune: maintenance.prune.slice(0, LIST_LIMIT).map((c) => ({ name: c.filename, confidence: c.confidence, lastActivity: c.lastActivity, reason: c.reason })),
      stale: maintenance.stale.slice(0, LIST_LIMIT).map((c) => ({ docId: c.docId, type: c.type, recalled: c.recalledCount, upvoted: c.upvotedCount, users: c.userCount })),
      silent,
    },
  };
}
