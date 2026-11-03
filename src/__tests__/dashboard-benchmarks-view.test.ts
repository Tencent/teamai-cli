import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, type BenchmarkRunInput } from '../benchmark/history.js';
import type { TrialResult } from '../benchmark/result.js';
import type { AgentObservation } from '../agent-observation.js';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { benchmarksClient } from '../dashboard/benchmarks-client.js';
import { chartFitView } from '../dashboard/chart-fit-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { dashboardStyles } from '../dashboard/styles.js';
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
 * `click`, which clicks the first element an attribute names and renders the page again, and `resize`, which lays every
 * chart out in a box `boxWidth` px wide, as the browser does once the page is in a window `width` px wide, lets the page measure
 * it, and renders the page again.
 */
async function openPage(runs: BenchmarkRunInput[], { view = 'arms', dimension = '', language = 'en', labels = [], width = 1440, teamDiffs = {} }: { view?: string; dimension?: string; language?: 'en' | 'zh-CN'; labels?: ViewedLabel[]; width?: number; teamDiffs?: Record<string, { files: Array<{ path: string; added: number; removed: number }>; more: number }> } = {}) {
  const history = { configured: true, ...BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }), teamDiffs };
  const queries: string[] = [];
  const clicks: Array<(event: { target: { closest: (selector: string) => unknown } }) => void> = [];
  const location = { hash: 'benchmarks' };
  const moved: string[] = [];
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
    window: { innerWidth: width }, location,
    // Each element of the page, recording where the page scrolled and what it focused.
    $: (id: string) => ({ scrollIntoView: () => moved.push(`scrolled to ${id}`), focus: () => moved.push(`focused ${id}`) }),
    document: {
      addEventListener: (type: string, listener: (typeof clicks)[number]) => (type === 'click' ? clicks.push(listener) : undefined),
      // Each chart the page drew, laid out in a box `box` px wide.
      querySelectorAll: () => [...html.matchAll(/<svg data-chart="([^"]+)" viewBox="0 0 (\d+) /g)].map(([, chart, drawn]) => ({
        dataset: { chart }, viewBox: { baseVal: { width: Number(drawn) } }, getBoundingClientRect: () => ({ width: box }),
      })),
    },
  };
  const names = Object.keys(scope);
  // The dashboard client embeds the Benchmarks page after the Scorers page, in one closure.
  const page = new Function(...names, `${agentHarnessView}\n${chartFitView}\n${scorersClient}\n${benchmarksClient}\nreturn { benchmarksPage, loadBenchmarks, fitCharts: () => fitCharts(), compareBy: (key) => { benchDimension = key; }, openBenchmarks: (to) => openBenchmarks(to) };`)(...Object.values(scope)) as {
    benchmarksPage: () => string; loadBenchmarks: () => Promise<void>; fitCharts: () => void; compareBy: (key: string) => void; openBenchmarks: (to: { suite: string; arm: string }) => void;
  };
  let html = '', box = 0;
  const settle = async () => {
    page.benchmarksPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return page.benchmarksPage();
  };
  await page.loadBenchmarks();
  page.compareBy(dimension);
  html = await settle();
  const click = async (attribute: string) => {
    const value = new RegExp(`${attribute}="([^"]*)"`).exec(html)?.[1];
    if (value === undefined) throw new Error(`The page has no ${attribute}`);
    const dataset = { [attribute.replace(/^data-/, '').replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())]: value };
    for (const listener of clicks) listener({ target: { closest: (selector: string) => (selector === `[${attribute}]` ? { dataset } : null) } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = await settle();
    return html;
  };
  const resize = (boxWidth: number) => {
    box = boxWidth;
    page.fitCharts();
    html = page.benchmarksPage();
    return html;
  };
  /** Opens the page as another page links to an arm of a suite, and renders it once its runs arrived. */
  const open = async (to: { suite: string; arm: string }) => {
    page.openBenchmarks(to);
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = await settle();
    return html;
  };
  return { html, queries, location, moved, click, resize, open };
}

async function renderPage(runs: BenchmarkRunInput[], options: Parameters<typeof openPage>[1] = {}): Promise<string> {
  return (await openPage(runs, options)).html;
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('the Benchmarks page of a suite with covered assets (#1605)', () => {
  /** A suite whose fix task covers skill auth-tokens and rule rules/auth.md: a pulled arm, and one without exactly the skill. */
  function coveredRun(): BenchmarkRunInput {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: TEAM } },
      { name: 'no-tokens', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/auth-tokens'] as [string, ...string[]], revision: TEAM } },
    ];
    const trial = (task: string, arm: string, order: number, result: TrialResult, used?: Record<string, 'loaded' | 'unknown'>, routing?: Record<string, 'fit' | 'idle' | 'extra' | 'missed' | 'unknown'>) => ({ task, arm, repetition: 1, order, step: `trials.r1.${task}.${arm}.prompt`, result, ...(used ? { used } : {}), ...(routing ? { routing } : {}) });

    return {
      run: 'r1', source: 'reported', username: 'lead', startedAt: '2026-10-20T09:00:00Z', outcome: 'succeeded',
      benchmark: {
        suite: { name: 'fix-auth', sourceHash: 'v1' }, repetitions: 1, baselineTeamRevision: TEAM, scorers: [{ name: 'teamai:routing:auth-tokens', rubric: { sourceHash: 'r1' } }],
        tasks: [
          { id: 'expired-token', startingCommit: 'a'.repeat(40), sourceHash: 't1', baseline: 'valid', covers: ['rules/auth.md', 'skills/auth-tokens'], coversSkills: [null, 'auth-tokens'] },
          { id: 'login-copy', startingCommit: 'a'.repeat(40), sourceHash: 't2', baseline: 'valid' },
        ],
        arms,
        trials: [
          trial('expired-token', 'pulled', 1, 'passed', { 'auth-tokens': 'loaded' }, { 'auth-tokens': 'fit' }),
          trial('login-copy', 'pulled', 2, 'failed'),
          // The without-arm reports no routing: the asset is absent by design, not misrouted.
          trial('expired-token', 'no-tokens', 3, 'failed'),
          trial('login-copy', 'no-tokens', 4, 'failed'),
        ],
      },
    };
  }

  it('shows the asset effect tables under the pair, and links the skill to its routing scorer', async () => {
    const html = await renderPage([coveredRun()], { view: 'compare' });

    expect(html).toContain('asset-effect');
    expect(text(html)).toContain('skills/auth-tokens · no-tokens → pulled · claude');
    expect(text(html)).toContain('expired-token yes 0/1 1/1 1/1 fit');
    expect(text(html)).toContain('rules/auth.md · pulled · claude');
    expect(text(html)).toContain('tasks that cover it');
    expect(text(html)).toContain('passed when loaded 1/1 · passed when not loaded -');
    expect(html).toContain('href="#scorers"');
    expect(html).toContain('teamai:routing:auth-tokens');
  });

  it('shows a covered asset\'s rows on Compare when no two arms compare, with every routing count and the namespaced routing link', async () => {
    const run = coveredRun();
    const values = ['fit', 'missed', 'fit'] as const;

    run.benchmark.repetitions = 3;
    run.benchmark.scorers = [{ name: 'teamai:routing:dev:auth-tokens', rubric: { sourceHash: 'r1' } }];
    run.benchmark.tasks = run.benchmark.tasks.map((task) => (task.covers ? { ...task, covers: ['skills/dev/auth-tokens'], coversSkills: ['auth-tokens'] } : task));
    run.benchmark.arms = run.benchmark.arms.filter(({ name }) => name === 'pulled');
    run.benchmark.trials = values.map((value, index) => ({
      task: 'expired-token', arm: 'pulled', repetition: index + 1, order: index + 1, step: `trials.r${index + 1}.expired-token.pulled.prompt`, result: 'passed' as const,
      ...(value === 'fit' ? { used: { 'auth-tokens': 'loaded' as const } } : {}), routing: { 'auth-tokens': value },
    }));
    const html = await renderPage([run], { view: 'compare' });

    expect(text(html)).toContain('skills/dev/auth-tokens · pulled · claude');
    expect(text(html)).toContain('expired-token yes - 3/3 2/3 fit, 1 missed');
    expect(html).toContain('teamai:routing:dev:auth-tokens');
  });

  it('keeps every asset label in zh-CN too', async () => {
    const zh = text(await renderPage([coveredRun()], { view: 'compare', language: 'zh-CN' }));

    expect(zh).toContain('资产效果');
    expect(zh).toContain('未观察');
    expect(zh).toContain('加载时通过 1/1 · 未加载时通过 -');
  });
});

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

  it('marks an arm named after its role once, instead of repeating the role under its name', async () => {
    const [run] = runs;
    // The suite names each arm after the role it runs with: frontend, review.
    const named: BenchmarkRunInput[] = run ? [{ ...run, benchmark: { ...run.benchmark,
      arms: run.benchmark.arms.filter(({ tool }) => tool === 'claude').map((arm) => ({ ...arm, name: arm.role ?? '' })),
      trials: run.benchmark.trials.filter(({ arm }) => arm.startsWith('claude-')).map((trial) => ({ ...trial, arm: trial.arm.split('-')[1] ?? '' })) } }] : [];
    const html = await renderPage(named);
    const bars = [...html.matchAll(/<div class="arm-label">(.*?)<\/div>/gs)].map(([, name]) => text(name ?? '').trim());

    expect(bars.slice(0, 2)).toEqual(['frontend role claude', 'review role claude']);
    expect(html).toContain('<span data-verbatim>review</span> <span class="role-of">role</span>');
    expect(html).not.toContain('review role</span>');
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

    // Two labels, 1 of 2 passing, can not tell production apart from an arm that passed its one trial.
    expect(production('claude-review')).toBe('In production: 50% 1/2 · 95% 9%–91% · not separated · step · review-quality · 30 days Scorers ↗');
    expect(production('codex-review')).toBe('In production: 50% 1/2 · 95% 9%–91% · not separated · step · review-quality · 30 days Scorers ↗');
    expect(production('claude-frontend')).toBe('In production: no labels for this role · 30 days');

    await click('data-bench-production');
    // The query the Scorers page sends for the group it opens on.
    const opened = new URLSearchParams(queries.map((query) => query.split('?')[1]).find((query) => new URLSearchParams(query).has('group')));
    expect(location.hash).toBe('scorers');
    expect([opened.get('window'), opened.get('groupBy'), opened.get('group')]).toEqual(['30', 'role', JSON.stringify(['value', 'review', null, false])]);
  });

  it("weighs a role's production pass rate by its labels, and says whether the role was the step's or the member's", async () => {
    const ran = (stepRole?: string): AgentObservation => ({
      v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local',
      team: { revision: TEAM, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], ...(stepRole ? { stepRole } : {}) } },
    });
    const judged = (index: number, passed: boolean, agent: AgentObservation): ViewedLabel => {
      const label: ScoreLabel = {
        scorer: 'review-quality', rubric: { sourceHash: 'rubric-1', teamRevision: TEAM }, label: passed ? 'thorough' : 'missed-defect', score: passed ? 1 : 0, passed,
        judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-judge-1' }, isolation: 'verified', access: 'read' },
        scoredAt: '2026-10-27T10:00:00.000Z', source: 'workflow', subject: { runId: `r${String(index).padStart(16, '0')}`, step: 'review', pass: 1 }, agent,
      };
      return { label, author: 'bob', agent };
    };
    // The review step failed 20 times in production; one member working as frontend passed once.
    const labels = [...Array.from({ length: 20 }, (_, index) => judged(index, false, ran('review'))), judged(20, true, ran())];
    const html = await renderPage([roleRun({ 'claude-frontend': 'failed', 'claude-review': 'passed' })], { labels });
    const line = (arm: string) => ((html.split('<div class="arm-bars">')[1] ?? '').split('<div class="arm-bar" ').find((bar) => bar.includes(`<span data-verbatim>${arm}</span>`))?.split(/<div class="arm-production"[^>]*>/)[1]?.split('</div>')[0] ?? '');

    // 0 of 20 is told apart from the review arm's 1 of 1, and weighs as much as it.
    expect(text(line('claude-review')).trim()).toBe('In production: 0% 0/20 · 95% 0%–16% · step · review-quality · 30 days Scorers ↗');
    expect(line('claude-review')).toContain('<b>0%</b>');
    // 1 of 1 is not, so it reads lighter than the arm's own rate.
    expect(text(line('claude-frontend')).trim()).toBe('In production: 100% 1/1 · 95% 21%–100% · not separated · member · review-quality · 30 days Scorers ↗');
    expect(line('claude-frontend')).not.toContain('<b>100%</b>');
    // The link wraps with the window before it, never onto a line of its own.
    expect(line('claude-review')).toContain('<span class="production-part"><small>30 days</small> <button class="link" type="button" data-bench-production="review">Scorers ↗</button></span>');
  });

  it('opens on the Arms of the suite another page links to, with the linked arm marked', async () => {
    const { open, location, queries, moved } = await openPage(runs, { view: 'compare' });
    expect(moved).toEqual([]);
    const html = await open({ suite: 'review-roles', arm: 'codex-review' });

    expect(location.hash).toBe('benchmarks');
    expect(queries.findLast((query) => query.startsWith('/api/benchmarks'))).toBe('/api/benchmarks?window=90&suite=review-roles');
    expect(html).toContain('<div class="arm-bars">');
    expect([...html.matchAll(/<div class="arm-bar marked" aria-current="true"[^>]*><div class="arm-label">(.*?)<\/div>/gs)].map(([, name]) => text(name ?? '').trim())).toEqual(['codex-review review role codex']);
    // The arm sits under the charts, below the fold on a phone, so the page takes the reader to it.
    expect(html).toContain('<div class="arm-bar marked" aria-current="true" id="bench-marked-arm" tabindex="-1"');
    expect(moved).toEqual(['scrolled to bench-marked-arm', 'focused bench-marked-arm']);
  });

  it('labels a role in Chinese, keeping the role id as written', async () => {
    const html = await renderPage(runs, { view: 'compare', dimension: 'role', language: 'zh-CN' });

    expect(text(html)).toContain('review 角色');
    expect(text(html)).toContain('角色');
  });
});

describe('the Benchmarks page at every width', () => {
  const runs = [roleRun({ 'claude-frontend': 'passed', 'claude-review': 'passed' }, { 'claude-frontend': 1200, 'claude-review': 1000 })];
  const drawnWidths = (html: string) => [...html.matchAll(/<svg data-chart="[^"]+" viewBox="0 0 (\d+) /g)].map(([, width]) => Number(width));

  it('draws each chart as wide as its box, so its text keeps its size and nothing scrolls, and draws it again on a resize', async () => {
    // A window 768 px wide, whose sidebar leaves each chart a box 486 px wide.
    const arms = await openPage(runs, { width: 768 });
    expect(drawnWidths(arms.html)).toEqual([760, 760]);
    expect(drawnWidths(arms.resize(486))).toEqual([486, 486]);
    // The window turns into a phone's, without reloading the page.
    expect(drawnWidths(arms.resize(330))).toEqual([330, 330]);

    const compare = await openPage(runs, { view: 'compare', width: 768 });
    expect(drawnWidths(compare.resize(486))).toEqual([486]);
  });

  /** The box each point label of `chart` takes, at an assumed 7 px a character of 12 px semibold text. */
  const labelBoxes = (html: string, chart: string) => {
    const svg = html.split(`<svg data-chart="${chart}"`)[1]?.split('</svg>')[0] ?? '';
    return [...svg.matchAll(/<text class="point-label[^"]*" x="([\d.]+)" y="([\d.]+)"(?: text-anchor="(\w+)")?>([^<]*)<\/text>/g)].map(([, x, y, anchor, name]) => {
      const width = (name ?? '').length * 7, left = Number(x) - (anchor === 'end' ? width : anchor === 'middle' ? width / 2 : 0);
      return { name, left, right: left + width, top: Number(y) - 11, bottom: Number(y) + 3 };
    });
  };
  const apart = (a: { left: number; right: number; top: number; bottom: number }, b: typeof a) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;

  it('keeps the names of two close points on the cost chart apart and inside it, at a phone, a tablet and a desktop width', async () => {
    const arms = await openPage(runs, { width: 768 });
    for (const box of [330, 486, 518]) {
      const [left, right, ...more] = labelBoxes(arms.resize(box), 'cost');

      expect(more).toEqual([]);
      expect([left?.name, right?.name]).toEqual(['claude-frontend', 'claude-review']);
      expect(left && right && apart(left, right), `labels overlap in a ${box} px chart`).toBe(true);
      for (const label of [left, right]) expect((label?.left ?? -1) >= 0 && (label?.right ?? Infinity) <= box, `${label?.name} leaves a ${box} px chart`).toBe(true);
    }
  });

  it('keeps the names of points in the top left corner off the "better" note there', async () => {
    const arms = await openPage(runs, { width: 768 });
    for (const box of [330, 486, 518]) {
      const html = arms.resize(box);
      // The note is 11 px text, taken as 6 px a character.
      const [, x = '0', y = '0', note = ''] = /<text class="better" x="([\d.]+)" y="([\d.]+)">([^<]*)<\/text>/.exec(html) ?? [];
      const better = { left: Number(x), right: Number(x) + note.length * 6, top: Number(y) - 10, bottom: Number(y) + 3 };

      for (const label of labelBoxes(html, 'cost')) expect(apart(label, better), `${label.name} covers the note in a ${box} px chart`).toBe(true);
    }
  });

  it('names the hollow end of the arrow beside or under its own point, away from the shaft', async () => {
    const compare = await openPage(runs, { view: 'compare', width: 768 });
    for (const box of [330, 486, 518]) {
      const html = compare.resize(box);
      const arrow = html.split('<g class="arrow active"')[1]?.split('</g>')[0] ?? '';
      const [x1 = 0, , x2 = 0] = [...arrow.matchAll(/<line class="\w+" x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)"/g)].flatMap(([, a, b]) => [Number(a), 0, Number(b)]);
      const [from, to] = labelBoxes(html, 'arrow');

      expect(x2 < x1, 'the arrow runs from claude-frontend on the right to claude-review on the left').toBe(true);
      expect(from && to && apart(from, to)).toBe(true);
      // Centred under the hollow point at most: never stretched along the shaft, towards the filled end.
      expect(((from?.left ?? 0) + (from?.right ?? 0)) / 2, `in a ${box} px chart`).toBeGreaterThanOrEqual(x1 - 1);
    }
  });

  it('lays the suites and runs tables out as cards by their panel\'s width, not the window\'s', async () => {
    const html = await renderPage(runs);

    expect(html.match(/<div class="table-scroll card-table"><table class="session-table bench-cards">/g)).toHaveLength(2);
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.bench-cards thead\{display:none\}/);
  });

  it('counts one run of an arm as "1 run"', async () => {
    const html = await renderPage(runs);
    const values = [...html.matchAll(/<div class="arm-value">(.*?)<\/div>/gs)].map(([, value]) => text(value ?? '').trim());

    expect(values).toEqual(['100% 1/1 · 1 run', '100% 1/1 · 1 run']);
  });

  it('keeps the cost per passed trial neutral while the pass rates of the pair are not separated', async () => {
    const [run] = runs;
    const costs: Record<string, number> = { 'claude-frontend': 0.038, 'claude-review': 0.036 };
    // A trial's cost counts once its prompt ran, as teamai observed.
    const ranAs = (role: string): AgentObservation => ({
      v: 1, tool: { name: 'claude' }, teamai: '1.0.0', driver: 'local',
      team: { revision: TEAM, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], stepRole: role } },
    });
    const costed: BenchmarkRunInput[] = run ? [{ ...run, benchmark: { ...run.benchmark, trials: run.benchmark.trials.map((trial) => ({ ...trial, agent: ranAs(trial.arm.split('-')[1] ?? ''), cost: { amount: costs[trial.arm] ?? 0, unit: 'USD', complete: true } })) } }] : [];
    const html = await renderPage(costed, { view: 'compare' });
    const cost = /<div class="cardtop">Cost per passed trial<\/div><div class="big">(.*?)<\/div>/s.exec(html)?.[1] ?? '';

    expect(text(html)).toContain('not separated');
    expect(text(cost).trim()).toBe('−5%');
    expect(cost).not.toMatch(/class="(up|down)"/);
  });
});

describe('the Benchmarks page counts one of a thing in the singular', () => {
  const runs = [roleRun({ 'claude-frontend': 'passed', 'claude-review': 'passed' }, { 'claude-frontend': 1200, 'claude-review': 1000 })];

  it('"1 deviation", under the arm and in its latest run', async () => {
    const [run] = runs;
    // claude-review's prompt ran on codex.
    const deviated: BenchmarkRunInput[] = run ? [{ ...run, benchmark: { ...run.benchmark, trials: run.benchmark.trials.map((trial) => (trial.arm === 'claude-review' ? { ...trial, agent: { v: 1 as const, tool: { name: 'codex' }, teamai: '1.0.0', driver: 'local' as const } } : trial)) } }] : [];
    const html = text(await renderPage(deviated));

    expect(html.match(/1 deviation /g)).toHaveLength(2);
    expect(html).not.toContain('1 deviations');
  });

  it('"1 trial reported it", in the title of a usage', async () => {
    const html = await renderPage(runs);

    expect(html).toContain('1 trial reported it');
    expect(html).not.toContain('1 trials reported it');
  });

  it('"1 paired trial", under the pass rates of a pair', async () => {
    const html = text(await renderPage(runs, { view: 'compare' }));

    expect(html).toContain('100% → 100% 1 paired trial ');
  });

  it('"1 pair", beside the difference of a pair of arms', async () => {
    const html = await renderPage(runs, { view: 'compare' });

    expect(html).toContain('<small>1 pair</small>');
  });

  describe('on a team revision', () => {
    const [run] = runs;
    const AFTER = 'c'.repeat(40);
    // The same suite, run again a day later on a newer team revision.
    const later: BenchmarkRunInput[] = run ? [{ ...run, run: 'r2', startedAt: '2026-10-21T09:00:00Z', benchmark: { ...run.benchmark, baselineTeamRevision: AFTER, arms: run.benchmark.arms.map((arm) => ({ ...arm, team: { kind: 'pulled' as const, revision: AFTER } })) } }] : [];
    const both = [...runs, ...later];

    it('"1 run", in the title of its point', async () => {
      const html = await renderPage(both, { view: 'team' });

      expect(html).toMatch(/<g class="revision[^"]*" data-bench-revision="c{40}"><title>[^<]* · 1 run<\/title>/);
    });

    it('"and 1 more file", under the files it changed', async () => {
      const html = text(await renderPage(both, { view: 'team', teamDiffs: { [`${TEAM}..${AFTER}`]: { files: [{ path: 'skills/review/SKILL.md', added: 3, removed: 1 }], more: 1 } } }));

      expect(html).toContain('and 1 more file ');
    });
  });
});
