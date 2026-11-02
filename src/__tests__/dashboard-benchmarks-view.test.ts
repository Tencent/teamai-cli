import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, type BenchmarkRunInput } from '../benchmark/history.js';
import type { TrialResult } from '../benchmark/result.js';
import { benchmarksClient } from '../dashboard/benchmarks-client.js';
import { dashboardMessages } from '../dashboard/locales.js';

const messages: Record<string, string> = dashboardMessages;

const NOW = new Date('2026-10-28T12:00:00Z');
const TEAM = 'b'.repeat(40);

/** A team lead's suite: one review task, on claude and codex, each with the frontend role and the review role. */
function roleRun(results: Record<string, TrialResult>): BenchmarkRunInput {
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
      trials: arms.map(({ name }, index) => ({ task: 'flag-unsafe-sql', arm: name, repetition: 1, order: index + 1, step: `trials.r1.flag-unsafe-sql.${name}.prompt`, result: results[name] ?? 'failed' })),
    },
  };
}

/** The Benchmarks page as the dashboard renders `runs`, in `view` and compared by `dimension`, in `language`. */
async function renderPage(runs: BenchmarkRunInput[], { view = 'arms', dimension = '', language = 'en' }: { view?: string; dimension?: string; language?: 'en' | 'zh-CN' } = {}): Promise<string> {
  const history = { configured: true, ...BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }) };
  const t = (text: string): string => (language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] ?? text : text);
  const e = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const number = (value: number): string => new Intl.NumberFormat('en').format(value);
  const scope = {
    t, e, label: (text: string) => e(t(text)), number, when: (value: string) => value,
    read: (key: string, fallback: string) => (key === 'teamai-dashboard-benchmark-view' ? view : fallback), save: () => undefined,
    apiQuery: (route: string) => route, errorPanel: (text: string) => text, render: () => undefined, page: 'benchmarks', workspaceGeneration: 0,
    pct: (rate: number | null) => (rate == null ? '—' : `${number(Math.round(rate * 100))}%`), short: (hash: string) => e(String(hash || '').slice(0, 7)),
    sparkline: () => '', meter: () => '', kpiCard: (title: string, value: string, note: string) => `<div class="kpi">${title} ${value} ${note}</div>`,
    fetch: async () => ({ ok: true, json: async () => history }),
    window: { innerWidth: 1440 }, document: { addEventListener: () => undefined },
  };
  const names = Object.keys(scope);
  const page = new Function(...names, `${benchmarksClient}\nreturn { benchmarksPage, loadBenchmarks, compareBy: (key) => { benchDimension = key; } };`)(...Object.values(scope)) as {
    benchmarksPage: () => string; loadBenchmarks: () => Promise<void>; compareBy: (key: string) => void;
  };
  await page.loadBenchmarks();
  page.compareBy(dimension);
  return page.benchmarksPage();
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
    expect(byRole).toContain('review role against frontend role +100 pp');
    expect(byRole).toContain('frontend role → review role claude');
    expect(byRole).toContain('frontend role → review role codex');
    expect(byTool).toContain('claude → codex frontend role');
    expect(byTool).toContain('claude → codex review role');
    expect(toolHtml.match(/<button class="forest-row/g)).toHaveLength(2);
    // The pair the page opens on names the role both of its arms ran with.
    expect(byTool).toContain('Each task · claude → codex · frontend role');
  });

  it('labels a role in Chinese, keeping the role id as written', async () => {
    const html = await renderPage(runs, { view: 'compare', dimension: 'role', language: 'zh-CN' });

    expect(text(html)).toContain('review 角色');
    expect(text(html)).toContain('角色');
  });
});
