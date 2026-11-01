import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildImprovement } from '../dashboard/improvement.js';
import { improvementClient } from '../dashboard/improvement-client.js';

const noMaintenance = { promote: [], prune: [], stale: [] };
let root: string;

function writeStats(name: string, body: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(root, 'stats', `${name}.yaml`), YAML.stringify({ username: name, ...body }));
}

function writeSkill(namespace: string, name: string): void {
  fs.mkdirSync(path.join(root, 'repo', 'skills', namespace, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'repo', 'skills', namespace, name, 'SKILL.md'), `# ${name}\n`);
}

const paths = () => ({ statsDir: path.join(root, 'stats'), knowledgeRoot: path.join(root, 'repo') });

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-improvement-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the Improvement Center payload', () => {
  it('sums every member\'s published days, ending at the newest day anyone published', async () => {
    writeStats('ana', {
      updatedAt: '2026-10-23T01:00:00.000Z',
      daily: {
        '2026-10-22': { sessionsEnded: 3, sessionsSucceeded: 2, sessionsCorrected: 1, promptTurns: 9, costMicros: 1_500_000 },
        '2026-10-20': { sessionsEnded: 1, sessionsSucceeded: 1, promptTurns: 2 },
      },
    });
    writeStats('bo', {
      updatedAt: '2026-10-21T08:00:00.000Z',
      daily: { '2026-10-20': { sessionsEnded: 2, sessionsSucceeded: 2, promptTurns: 4, costMicros: 500_000 } },
    });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.window).toEqual({ days: 30, from: '2026-09-23', to: '2026-10-22', latestStats: '2026-10-23T01:00:00.000Z' });
    expect(data.members).toBe(2);
    expect(data.daily).toHaveLength(180);
    expect(data.daily.at(-1)).toMatchObject({ date: '2026-10-22', ended: 3, succeeded: 2, corrected: 1, prompts: 9, costMicros: 1_500_000, members: 1 });
    expect(data.daily.find((d) => d.date === '2026-10-20')).toMatchObject({ ended: 3, prompts: 6, costMicros: 500_000, members: 2 });
  });

  it('adds up friction across members without naming anyone', async () => {
    writeStats('ana', { interventions: { sessions: 10, interrupt: 2, toolReject: 1, correction: 3 } });
    writeStats('bo', { interventions: { sessions: 5, interrupt: 1, toolReject: 0, correction: 0 } });
    writeStats('cy', {});
    writeStats('dee', { interventions: { sessions: 0, interrupt: 7, toolReject: 7, correction: 7 } });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.friction).toEqual({ members: 2, sessions: 15, interrupt: 3, toolReject: 1, correction: 3 });
    expect(JSON.stringify(data)).not.toContain('"ana"');
  });

  it('ends the window at the newest day with any activity, not only ended sessions', async () => {
    writeStats('ana', { daily: {
      '2026-10-22': { sessionsEnded: 1 },
      '2026-10-23': { sessionsEnded: 0, promptTurns: 4, costMicros: 900_000 },
      '2026-10-24': { sessionsEnded: 0, priceVersion: 'v1' },
      'not-a-day': { sessionsEnded: 9 },
      '2026-99-99': { sessionsEnded: 9 },
    } });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.window.to).toBe('2026-10-23');
    expect(data.daily.at(-1)).toMatchObject({ date: '2026-10-23', ended: 0, prompts: 4, costMicros: 900_000, members: 0 });
  });

  it('ranks skills by members, then recency, because the published count is all-time', async () => {
    writeSkill('tencent', 'old-heavy');
    writeSkill('tencent', 'recent-light');
    writeStats('ana', { daily: { '2026-10-22': { sessionsEnded: 1 } }, skills: {
      'old-heavy': { count: 900, lastUsed: '2026-10-01T03:00:00.000Z' },
      'recent-light': { count: 2, lastUsed: '2026-10-22T03:00:00.000Z' },
    } });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.skills.used.map((s) => s.name)).toEqual(['recent-light', 'old-heavy']);
  });

  it('splits team skills into used and unused, and lists skills several members use outside the team repo', async () => {
    writeSkill('tencent', 'tgit');
    writeSkill('tencent', 'cls-log');
    writeStats('ana', {
      daily: { '2026-10-22': { sessionsEnded: 1 } },
      skills: {
        tgit: { count: 4, lastUsed: '2026-10-22T03:00:00.000Z' },
        goal: { count: 2, lastUsed: '2026-10-21T03:00:00.000Z' },
        Users: { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
        'a/b': { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
        teamai: { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
        solo: { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
      },
    });
    writeStats('bo', {
      skills: {
        tgit: { count: 1, lastUsed: '2026-10-10T03:00:00.000Z' },
        goal: { count: 5, lastUsed: '2026-10-20T03:00:00.000Z' },
        'cls-log': { count: 7, lastUsed: '2026-08-01T03:00:00.000Z' },
        Users: { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
        'a/b': { count: 9, lastUsed: '2026-10-21T03:00:00.000Z' },
        teamai: { count: 1, lastUsed: '2026-10-21T03:00:00.000Z' },
      },
    });

    const data = await buildImprovement(paths(), noMaintenance, 0);

    expect(data.skills.teamTotal).toBe(2);
    expect(data.skills.used).toEqual([{ name: 'tgit', namespace: 'tencent', uses: 5, users: 2, lastUsed: '2026-10-22T03:00:00.000Z' }]);
    // cls-log was last used before the 30-day window.
    expect(data.skills.unused.map((s) => s.name)).toEqual(['cls-log']);
    // Not listed: path segments the tracker recorded, the built-in teamai skill, and a one-person skill.
    expect(data.skills.outside.map((s) => s.name)).toEqual(['goal']);
  });

  it('passes the maintenance candidates through, and is empty when nothing has been published', async () => {
    const data = await buildImprovement(paths(), {
      promote: [{ docId: 'retry', title: 'Retry with backoff', suggestedCategory: 'skills', confidence: 0.95, upvotedCount: 6, userCount: 3 }],
      prune: [{ filename: 'old.md', confidence: 0.1, lastActivity: '2026-01-01', reason: 'inactive' }],
      stale: [],
    }, 4);

    expect(data.members).toBe(0);
    expect(data.daily.every((d) => d.ended === 0)).toBe(true);
    expect(data.maintenance).toEqual({
      promote: [{ docId: 'retry', title: 'Retry with backoff', category: 'skills', confidence: 0.95, upvoted: 6, users: 3 }],
      prune: [{ name: 'old.md', confidence: 0.1, lastActivity: '2026-01-01', reason: 'inactive' }],
      stale: [],
      silent: 4,
    });
  });

  it('reports nothing when the stats directory does not exist', async () => {
    const data = await buildImprovement({ statsDir: path.join(root, 'missing'), knowledgeRoot: path.join(root, 'missing') }, noMaintenance, 0);

    expect(data.members).toBe(0);
    expect(data.skills).toEqual({ teamTotal: 0, used: [], unused: [], outside: [] });
  });
});

describe('the Improvement Center page', () => {
  const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const renderPage = (kb: unknown, range = '30'): string => new Function(
    't', 'e', 'label', 'number', 'when', 'read', 'save', 'kb', 'kbError', 'source', 'errorPanel', 'link', 'trendPanel', 'language', 'render', 'document',
    `${improvementClient}\nreturn improvement();`,
  )(
    (x: string) => x, e, (x: string) => e(x), String, String, (key: string, d: string) => (key.endsWith('-range') ? range : d), () => undefined, kb, null, () => '', () => '', () => '', () => '', 'en', () => undefined,
    { addEventListener: () => undefined, querySelectorAll: () => [] },
  ) as string;
  const day = (date: string, over: Record<string, number> = {}) => ({ date, ended: 0, succeeded: 0, corrected: 0, prompts: 0, durationMs: 0, costMicros: 0, priced: 0, cacheRead: 0, cacheEligible: 0, members: 0, ...over });
  const days = (n: number, over: (i: number) => Record<string, number>) => Array.from({ length: n }, (_, i) => day(new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), over(i)));
  const payload = (daily: unknown[], skills = {}) => ({ improvement: {
    window: { days: 30, from: '2026-01-01', to: '2026-01-30', latestStats: null }, members: 1, daily,
    friction: { members: 0, sessions: 0, interrupt: 0, toolReject: 0, correction: 0 },
    skills: { teamTotal: 0, used: [], unused: [], outside: [], ...skills },
    maintenance: { promote: [], prune: [], stale: [], silent: 0 },
  } });

  it('escapes a skill name everywhere it renders, including the expansion attribute', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const used = Array.from({ length: 9 }, (_, i) => ({ name: i ? `s${i}` : evil, uses: 1, users: 1, lastUsed: null }));

    const html = renderPage(payload(days(1, () => ({})), { teamTotal: 9, used }));

    expect(html).not.toContain('<img src=x');
    expect(html).toContain('data-imp-key="more-used"');
  });

  it('falls back to the plain maintenance report when the payload is missing', () => {
    expect(renderPage({ improvement: null, maintenance: '<p>plain report</p>' })).toContain('<p>plain report</p>');
  });

  it('compares cost per day, not per session, so more sessions alone never lower it', () => {
    const daily = days(14, (i) => ({ ended: 10, costMicros: i < 7 ? 1_000_000 : 2_000_000 }));
    const html = renderPage(payload(daily), '7');

    expect(html).toContain('Known cost per day rose $1.00 → $2.00');
    expect(html).not.toContain('Cost per session');
  });

  it('does not compare against a prior period with too few sessions', () => {
    const html = renderPage(payload(days(14, (i) => ({ ended: i < 7 ? 1 : 10, costMicros: i < 7 ? 1 : 2_000_000 }))), '7');

    expect(html).toContain('Too few sessions in prior period to compare');
    expect(html).not.toContain('Known cost per day rose');
  });

  it('keeps cents on the cost axis for small and fractional amounts', () => {
    const small = renderPage(payload(days(1, () => ({ costMicros: 800_000 }))));
    const fractional = renderPage(payload(days(1, () => ({ costMicros: 9_000_000 }))));

    expect(small).toContain('>$0.20</text>');
    expect(fractional).toContain('>$2.50</text>');
  });

  it('labels the skill count as all-time', () => {
    const used = [{ name: 'a', uses: 1, users: 1, lastUsed: null }];
    expect(renderPage(payload(days(1, () => ({})), { teamTotal: 1, used }))).toContain('All-time uses');
  });
});
