import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, type BenchmarkRunInput } from '../benchmark/history.js';
import type { TrialResult } from '../benchmark/result.js';
import type { AgentObservation } from '../agent-observation.js';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { benchmarksClient } from '../dashboard/benchmarks-client.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { scorersClient } from '../dashboard/scorers-client.js';
import type { ScoreLabel } from '../scorers/label.js';
import { ScorerResults, type ViewedLabel } from '../scorers/results.js';

const messages: Record<string, string> = dashboardMessages;

const NOW = new Date('2026-10-28T12:00:00Z');
const TEAM = 'b'.repeat(40);

/** A team lead's suite: one review task, on claude and codex, each with the frontend role and the review role. */
function roleRun(results: Record<string, TrialResult>, tokens: Record<string, number> = {}): BenchmarkRunInput {
  const arms = Object.keys(results).map((name) => {
    const [tool = '', role = ''] = name.split('-');
    return { name, tool, role, source: 'team' as const, team: { kind: 'pulled' as const, revision: TEAM } };
  });
  return {
    run: 'r1', source: 'reported', username: 'lead', startedAt: '2026-10-20T09:00:00Z', outcome: 'succeeded',
    benchmark: {
      suite: { name: 'review-roles', sourceHash: 'v1' }, repetitions: 1, baselineTeamRevision: TEAM, scorers: [],
      tasks: [{ id: 'flag-unsafe-sql', startingCommit: 'a'.repeat(40), sourceHash: 't1', baseline: 'valid' }],
      arms,
      trials: arms.map(({ name }, index) => ({ task: 'flag-unsafe-sql', arm: name, repetition: 1, order: index + 1, step: `trials.r1.flag-unsafe-sql.${name}.prompt`, result: results[name] ?? 'failed',
        ...(tokens[name] ? { tokens: { input: tokens[name], output: 0, complete: true } } : {}) })),
    },
  };
}

/**
 * The Benchmarks page as the dashboard renders `runs`, with the Scorers `labels` of production, in `view` and compared by
 * `dimension`, in `language`: its HTML once every answer it asked for arrived, each query it sent, where it went, and
 * `click`, which clicks the first element an attribute names and renders the page again.
 */
async function openPage(runs: BenchmarkRunInput[], { view = 'arms', dimension = '', language = 'en', labels = [] }: { view?: string; dimension?: string; language?: 'en' | 'zh-CN'; labels?: ViewedLabel[] } = {}) {
  const history = { configured: true, ...BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }) };
  const queries: string[] = [];
  const clicks: Array<(event: { target: { closest: (selector: string) => unknown } }) => void> = [];
  const location = { hash: 'benchmarks' };
  const answer = (url: string) => {
    if (!url.startsWith('/api/scorers')) return history;
    const params = new URLSearchParams(url.split('?')[1]);
    const days = Number(params.get('window'));
    const groupBy = params.get('groupBy') === 'role' ? 'role' as const : undefined;
    return { configured: true, ...ScorerResults.of({ labels, query: { windowDays: days, ...(groupBy ? { groupBy } : {}) }, now: NOW }) };
  };
  const t = (text: string): string => (language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] ?? text : text);
  const e = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const number = (value: number): string => new Intl.NumberFormat('en').format(value);
  const scope = {
    t, e, label: (text: string) => e(t(text)), number, when: (value: string) => value,
    read: (key: string, fallback: string) => (key === 'teamai-dashboard-benchmark-view' ? view : fallback), save: () => undefined,
    apiQuery: (route: string, params: Record<string, string>) => `${route}?${new URLSearchParams(params)}`, errorPanel: (text: string) => text, render: () => undefined, page: 'benchmarks', workspaceGeneration: 0,
    fetch: async (url: string) => {
      queries.push(url);
      return { ok: true, json: async () => answer(url) };
    },
    window: { innerWidth: 1440 }, location, $: () => undefined,
    document: { addEventListener: (type: string, listener: (typeof clicks)[number]) => (type === 'click' ? clicks.push(listener) : undefined) },
  };
  const names = Object.keys(scope);
  // The dashboard client embeds the Benchmarks page after the Scorers page, in one closure.
  const page = new Function(...names, `${agentHarnessView}\n${scorersClient}\n${benchmarksClient}\nreturn { benchmarksPage, loadBenchmarks, compareBy: (key) => { benchDimension = key; } };`)(...Object.values(scope)) as {
    benchmarksPage: () => string; loadBenchmarks: () => Promise<void>; compareBy: (key: string) => void;
  };
  const settle = async () => {
    page.benchmarksPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return page.benchmarksPage();
  };
  await page.loadBenchmarks();
  page.compareBy(dimension);
  let html = await settle();
  const click = async (attribute: string) => {
    const value = new RegExp(`${attribute}="([^"]*)"`).exec(html)?.[1];
    if (value === undefined) throw new Error(`The page has no ${attribute}`);
    const dataset = { [attribute.replace(/^data-/, '').replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())]: value };
    for (const listener of clicks) listener({ target: { closest: (selector: string) => (selector === `[${attribute}]` ? { dataset } : null) } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = await settle();
    return html;
  };
  return { html, queries, location, click };
}

async function renderPage(runs: BenchmarkRunInput[], options: { view?: string; dimension?: string; language?: 'en' | 'zh-CN'; labels?: ViewedLabel[] } = {}): Promise<string> {
  return (await openPage(runs, options)).html;
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the Benchmarks page of a suite that compares roles', () => {
  const runs = [roleRun({ 'claude-frontend': 'failed', 'claude-review': 'passed', 'codex-frontend': 'failed', 'codex-review': 'passed' })];

  it("names each arm's role beside its name, and in every bar and point title", async () => {
    const html = await renderPage(runs);

    expect(text(html)).toContain('claude-review review role claude');
    expect(text(html)).toContain('codex-frontend frontend role codex');
    expect(html).toContain('title="claude-review (review role · claude): 100% (1/1)');
    expect(html).toContain('<title>codex-frontend (frontend role · codex) · 2026-10-20T09:00:00Z');
  });

  it('compares the two roles on each tool by role, and the two tools only within one role', async () => {
    const byRole = text(await renderPage(runs, { view: 'compare', dimension: 'role' }));
    const toolHtml = await renderPage(runs, { view: 'compare', dimension: 'tool' });
    const byTool = text(toolHtml);

    expect(byRole).toContain('Compare by Tool Role');
    // One direction everywhere: the arm the difference is measured from, then the other.
    expect(byRole).toContain('frontend role → review role +100 pp');
    expect(byRole).toContain('frontend role → review role claude');
    expect(byRole).toContain('frontend role → review role codex');
    expect(byTool).toContain('claude → codex frontend role');
    expect(byTool).toContain('claude → codex review role');
    expect(toolHtml.match(/<button class="forest-row/g)).toHaveLength(2);
    // The pair the page opens on names the role both of its arms ran with.
    expect(byTool).toContain('Each task · claude → codex · frontend role');
  });

  it("shows each arm's role on its own line under its name in the run legend too", async () => {
    const html = await renderPage(runs);
    const legend = html.split('<div class="legend">')[1] ?? '';

    expect(legend).toMatch(/^<span class="arm-label"><i class="swatch"[^>]*><\/i><span data-verbatim>claude-frontend<\/span><span class="arm-role" data-verbatim>frontend role<\/span>/);
  });

  it('names the two roles at the ends of the cost arrow, and says what it compares by when that is the only choice', async () => {
    const html = await renderPage([roleRun({ 'claude-frontend': 'passed', 'claude-review': 'passed' }, { 'claude-frontend': 1200, 'claude-review': 1000 })], { view: 'compare' });
    const arrow = html.split('<g class="arrow active"')[1]?.split('</g>')[0] ?? '';

    expect([...arrow.matchAll(/<text class="point-label[^"]*"[^>]*>([^<]*)<\/text>/g)].map(([, name]) => name)).toEqual(['frontend role', 'review role']);
    expect(html).not.toContain('data-bench-dimension');
    expect(text(html)).toContain('Compare by Role frontend role → review role 0 pp');
  });

  it("puts each role's production pass rate from Scorers beside its arms, and opens Scorers on that role", async () => {
    const ranAs = (stepRole: string): AgentObservation => ({
      v: 1, tool: { name: 'claude' }, model: { reported: 'claude-sonnet-5-5' }, teamai: '1.0.0', driver: 'local',
      team: { revision: TEAM, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], stepRole } },
    });
    const judged = (runId: string, step: string, passed: boolean, stepRole: string): ViewedLabel => {
      const label: ScoreLabel = {
        scorer: 'review-quality', rubric: { sourceHash: 'rubric-1', teamRevision: TEAM }, label: passed ? 'thorough' : 'missed-defect', score: passed ? 1 : 0, passed,
        judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-judge-1' }, isolation: 'verified', access: 'read' },
        scoredAt: '2026-10-27T10:00:00.000Z', source: 'workflow', subject: { runId, step, pass: 1 }, agent: ranAs(stepRole),
      };
      return { label, author: 'bob', agent: label.agent };
    };
    const labels = [judged('r0000000000000007', 'review', true, 'review'), judged('r0000000000000008', 'review', false, 'review'), judged('r0000000000000008', 'plan', false, 'spec')];
    const { html, click, queries, location } = await openPage(runs, { labels });
    const bars = (html.split('<div class="arm-bars">')[1] ?? '').split('<div class="arm-bar" ');
    const production = (arm: string) => text(bars.find((bar) => bar.includes(`<span data-verbatim>${arm}</span>`))?.split(/<div class="arm-production"[^>]*>/)[1]?.split('</div>')[0] ?? '').trim();

    expect(production('claude-review')).toBe('In production: 50% 1/2 · review-quality · 30 days Scorers ↗');
    expect(production('codex-review')).toBe('In production: 50% 1/2 · review-quality · 30 days Scorers ↗');
    expect(production('claude-frontend')).toBe('In production: no labels for this role · 30 days');

    await click('data-bench-production');
    // The query the Scorers page sends for the group it opens on.
    const opened = new URLSearchParams(queries.map((query) => query.split('?')[1]).find((query) => new URLSearchParams(query).has('group')));
    expect(location.hash).toBe('scorers');
    expect([opened.get('window'), opened.get('groupBy'), opened.get('group')]).toEqual(['30', 'role', JSON.stringify(['value', 'review', null, false])]);
  });

  it('labels a role in Chinese, keeping the role id as written', async () => {
    const html = await renderPage(runs, { view: 'compare', dimension: 'role', language: 'zh-CN' });

    expect(text(html)).toContain('review 角色');
    expect(text(html)).toContain('角色');
  });
});
