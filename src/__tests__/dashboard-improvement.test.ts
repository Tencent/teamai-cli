import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { buildImprovement } from '../dashboard/improvement.js';
import { improvementClient } from '../dashboard/improvement-client.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import type { LocalConfig } from '../types.js';

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

const paths = () => ({ statsDir: path.join(root, 'stats'), knowledgeRoot: path.join(root, 'repo'), votesDir: path.join(root, 'votes') });

function writeVotes(name: string, votes: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(path.join(root, 'votes'), { recursive: true });
  const at = '2026-10-20T10:00:00.000Z';
  fs.writeFileSync(path.join(root, 'votes', `${name}.yaml`), YAML.stringify({ version: 2, deltas: {}, votes: Object.fromEntries(Object.entries(votes).map(([doc, v]) => [doc, { last_recalled_at: at, ...v }])) }));
}

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

  it('gives each recalled doc its adoption breakdown, most recalled first, summed over members (#1391)', async () => {
    writeVotes('ana', { 'pod-startup': { recalled_count: 6, upvoted_count: 3, judge_upvoted_count: 1, judged_count: 2, recalled_session_count: 5 }, retry: { recalled_count: 2, upvoted_count: 0 } });
    writeVotes('bo', { 'pod-startup': { recalled_count: 5, upvoted_count: 2, judge_upvoted_count: 1, judged_count: 2, recalled_session_count: 5 } });

    const { adoption } = await buildImprovement(paths(), noMaintenance, 0);

    expect(adoption.docs).toEqual([
      { docId: 'pod-startup', recalledSessions: 10, toolCredits: 3, judgeCredits: 2, judged: 4, ratio: 0.65 },
      { docId: 'retry', recalledSessions: 2, toolCredits: 0, judgeCredits: 0, judged: 0, ratio: 0 },
    ]);
  });

  it('names the default scorers the team replaced, and none without a scope', async () => {
    const knowledge = path.join(root, 'repo');
    fs.mkdirSync(path.join(knowledge, 'scorers'), { recursive: true });
    fs.writeFileSync(path.join(knowledge, 'scorers', 'teamai-adoption.md'), '---\nlabels:\n  - { value: used, score: 1, description: "Used {{ doc.id }}." }\n  - { value: unused, score: 0, description: "Did not use {{ doc.id }}." }\npassingScore: 1\nsessions: true\n---\nJudge `{{ doc.id }}`.\n');
    const scope: LocalConfig = { repo: { localPath: knowledge, remote: 'local' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
    await syncScorerDefinitions(scope);

    expect((await buildImprovement({ ...paths(), scope }, noMaintenance, 0)).adoption.overriddenScorers).toEqual([{ name: 'teamai-adoption', file: 'scorers/teamai-adoption.md' }]);
    expect((await buildImprovement(paths(), noMaintenance, 0)).adoption.overriddenScorers).toEqual([]);
  });

  it('reports nothing when the stats directory does not exist', async () => {
    const data = await buildImprovement({ statsDir: path.join(root, 'missing'), knowledgeRoot: path.join(root, 'missing'), votesDir: path.join(root, 'missing') }, noMaintenance, 0);

    expect(data.members).toBe(0);
    expect(data.skills).toEqual({ teamTotal: 0, used: [], unused: [], outside: [] });
  });
});

describe('the Improvement Center page', () => {
  const e = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const renderPage = (kb: unknown, range = '30', tab?: string): string => new Function(
    't', 'e', 'label', 'number', 'when', 'read', 'save', 'kb', 'kbError', 'source', 'errorPanel', 'link', 'trendPanel', 'language', 'render', 'document',
    `${improvementClient}\nreturn improvement();`,
  )(
    (x: string) => x, e, (x: string) => e(x), String, String, (key: string, d: string) => (key.endsWith('-range') ? range : key.endsWith('-tab') ? tab ?? d : d), () => undefined, kb, null, () => '', () => '', () => '', () => '', 'en', () => undefined,
    { addEventListener: () => undefined, querySelectorAll: () => [] },
  ) as string;
  const day = (date: string, over: Record<string, number> = {}) => ({ date, ended: 0, succeeded: 0, corrected: 0, prompts: 0, durationMs: 0, costMicros: 0, priced: 0, cacheRead: 0, cacheEligible: 0, members: 0, ...over });
  const days = (n: number, over: (i: number) => Record<string, number>) => Array.from({ length: n }, (_, i) => day(new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), over(i)));
  const payload = (daily: unknown[], skills = {}) => ({ improvement: {
    window: { days: 30, from: '2026-01-01', to: '2026-01-30', latestStats: null }, members: 1, daily,
    friction: { members: 0, sessions: 0, interrupt: 0, toolReject: 0, correction: 0 },
    skills: { teamTotal: 0, used: [], unused: [], outside: [], ...skills },
    maintenance: { promote: [], prune: [], stale: [], silent: 0 },
    adoption: { docs: [], overriddenScorers: [] },
  } });
  const adopting = (adoption: unknown, maintenance: unknown = { promote: [], prune: [], stale: [], silent: 0 }) => ({ improvement: { ...payload(days(1, () => ({}))).improvement, adoption, maintenance } });
  const pod = { docId: 'pod-startup', recalledSessions: 10, toolCredits: 3, judgeCredits: 2, judged: 4, ratio: 0.65 };

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

  it('offers each promote candidate as a command that lets the AI choose its category', () => {
    const promote = [{ docId: 'retry', title: 'Retry with backoff', category: 'skills', confidence: 0.95, upvoted: 6, users: 3 }];
    const html = renderPage({ improvement: { ...payload(days(1, () => ({}))).improvement, maintenance: { promote, prune: [], stale: [], silent: 0 } } }, '30', 'promote');

    expect(html).toContain('data-copy="teamai recall promote retry"');
    expect(html).toContain('<td data-label="Category">skills</td>');
    expect(html).not.toContain('--category');
  });

  it('shows each doc\'s reads, judge verdicts, recalled sessions and adoption ratio, and the default scorers the team replaced (#1391)', () => {
    const html = renderPage(adopting({ docs: [pod, { ...pod, docId: '<b>evil</b>' }], overriddenScorers: [{ name: 'teamai-adoption', file: 'scorers/teamai-adoption.md' }] }));
    const row = html.slice(html.indexOf('<tr data-adoption="pod-startup">'), html.indexOf('</tr>', html.indexOf('<tr data-adoption="pod-startup">')));

    expect(row).toContain('<td data-label="Recalled sessions">10</td>');
    expect(row).toContain('<td data-label="Read">3</td>');
    expect(row).toContain('<td data-label="Judged adopted">2 / 4</td>');
    expect(row).toContain('<td data-label="Adoption">65%</td>');
    expect(html).toContain('teamai-adoption</code> <small>scorers/teamai-adoption.md</small>');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('says the team runs teamai\'s default scorers, and that no session recalled a doc yet', () => {
    const html = renderPage(adopting({ docs: [], overriddenScorers: [] }));

    expect(html).toContain('Your team runs teamai&#39;s default scorers.');
    expect(html).toContain('No session recalled a team doc yet.');
  });

  it('gives each maintenance candidate its adoption evidence', () => {
    const promote = [{ docId: 'pod-startup', title: 'Pod startup', category: 'docs', confidence: 0.92, upvoted: 5, users: 2 }];
    const html = renderPage(adopting({ docs: [pod], overriddenScorers: [] }, { promote, prune: [], stale: [], silent: 0 }), '30', 'promote');

    expect(html).toContain('<td data-label="Adoption">65% · 3 read · 2 / 4 judged</td>');
  });

  it('labels every maintenance cell, so a narrow screen can show each candidate as a card with its Copy button', () => {
    const promote = [{ docId: 'retry', title: 'Retry with backoff', category: 'skills', confidence: 0.95, upvoted: 6, users: 3 }];
    const prune = [{ name: 'old.md', confidence: 0.1, lastActivity: '2026-01-01', reason: 'inactive' }];
    const stale = [{ docId: 'tired', type: 'doc', recalled: 9, upvoted: 0, users: 2 }];
    const tables = ['promote', 'prune', 'stale'].map((tab) => {
      const html = renderPage(adopting({ docs: [], overriddenScorers: [] }, { promote, prune, stale, silent: 0 }), '30', tab);
      return html.slice(html.indexOf('<div class="imp-scroll">'), html.indexOf('</table>', html.indexOf('<div class="imp-scroll">')));
    });

    for (const table of tables) {
      expect(table).toContain('<table class="maint-table">');
      expect(table).not.toMatch(/<td>/);
    }
    expect(tables[0]).toContain('<td data-label="Category">skills</td>');
    expect(tables[0]).toContain('<td data-label="Command"><button class="link copy" data-copy="teamai recall promote retry">');
  });

  it('has a zh-CN translation for every message the adoption panel shows', () => {
    const asked = new Set<string>();
    const html = new Function(
      't', 'e', 'label', 'number', 'when', 'read', 'save', 'kb', 'kbError', 'source', 'errorPanel', 'link', 'trendPanel', 'language', 'render', 'document',
      `${improvementClient}\nreturn improvement();`,
    )((x: string) => { asked.add(x); return x; }, e, (x: string) => { asked.add(x); return e(x); }, String, String, (_key: string, d: string) => d, () => undefined, adopting({ docs: [pod], overriddenScorers: [{ name: 'teamai-adoption', file: 'scorers/teamai-adoption.md' }] }), null, () => '', () => '', () => '', () => '', 'en', () => undefined, { addEventListener: () => undefined, querySelectorAll: () => [] }) as string;
    expect(html).toContain('id="imp-adoption"');
    expect([...asked].filter((message) => !(message in dashboardMessages))).toEqual([]);
  });

  it('labels the skill count as all-time', () => {
    const used = [{ name: 'a', uses: 1, users: 1, lastUsed: null }];
    expect(renderPage(payload(days(1, () => ({})), { teamTotal: 1, used }))).toContain('All-time uses');
  });
});
