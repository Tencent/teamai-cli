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
    run: 'r1', source: 'reported', username: 'lead', startedAt: '2026-10-20T09:00:00Z', outcome: 'succeeded', schemaVersion: 2,
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

describe('the Benchmarks page of a suite with covered resources (#1605)', () => {
  /** A suite whose fix task covers skill auth-tokens and rule rules/auth.md: a pulled arm, and one without exactly the skill. */
  function coveredRun(): BenchmarkRunInput {
    const arms = [
      { name: 'pulled', tool: 'claude', source: 'team' as const, team: { kind: 'pulled' as const, revision: TEAM } },
      { name: 'no-tokens', tool: 'claude', source: 'team' as const, team: { kind: 'without' as const, paths: ['skills/auth-tokens'] as [string, ...string[]], revision: TEAM } },
    ];
    const trial = (task: string, arm: string, order: number, result: TrialResult, used?: Record<string, 'loaded' | 'unknown'>, routing?: Record<string, 'fit' | 'idle' | 'extra' | 'missed' | 'unknown'>) => ({ task, arm, repetition: 1, order, step: `trials.r1.${task}.${arm}.prompt`, result, ...(used ? { used } : {}), ...(routing ? { routing } : {}) });

    return {
      run: 'r1', source: 'reported', username: 'lead', startedAt: '2026-10-20T09:00:00Z', outcome: 'succeeded', schemaVersion: 2,
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
          // The without-arm reports no routing: the resource is absent by design, not misrouted.
          trial('expired-token', 'no-tokens', 3, 'failed'),
          trial('login-copy', 'no-tokens', 4, 'failed'),
        ],
      },
    };
  }

  it('shows the resource effect tables under the pair, and links the skill to its routing scorer', async () => {
    const html = await renderPage([coveredRun()], { view: 'compare' });

    expect(html).toContain('resource-effect');
    expect(text(html)).toContain('skills/auth-tokens · no-tokens → pulled · claude');
    expect(text(html)).toContain('expired-token yes 0/1 1/1 1/1 fit');
    expect(text(html)).toContain('rules/auth.md · pulled · claude');
    expect(text(html)).toContain('tasks that cover it');
    expect(text(html)).toContain('passed when loaded 1/1 · passed when not loaded -');
    expect(html).toContain('href="#scorers"');
    expect(html).toContain('teamai:routing:auth-tokens');
  });

  it('shows a covered resource\'s rows on Compare when no two arms compare, with every routing count and the namespaced routing link', async () => {
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

  it('says on Compare and under the resource effect how many pairs another judge left out, and why, in en and zh-CN', async () => {
    const OPUS = { by: 'judge' as const, rubric: 'r', tool: 'claude', model: 'claude-opus-5-5', batched: true };
    const run = coveredRun();
    run.benchmark.trials = run.benchmark.trials.map((trial) => ({
      ...trial,
      verdicts: [{ scorer: `teamai:correctness:${trial.task}`, outcome: { kind: 'labelled' as const, label: trial.result, score: trial.result === 'passed' ? 1 : 0, passed: trial.result === 'passed' },
        decider: trial.arm === 'no-tokens' && trial.task === 'login-copy' ? { ...OPUS, model: 'claude-sonnet-5-5' } : OPUS }],
    }));

    const en = text(await renderPage([run], { view: 'compare' }));
    const zh = text(await renderPage([run], { view: 'compare', language: 'zh-CN' }));

    expect(en).toContain('1 paired trial · 1 excluded: their judge changed (claude claude-sonnet-5-5 → claude claude-opus-5-5)');
    expect(en.match(/1 excluded: their judge changed \(claude claude-sonnet-5-5 → claude claude-opus-5-5\)/g)).toHaveLength(2);
    expect(zh).toContain('1 已排除: 评判器已改变 (claude claude-sonnet-5-5 → claude claude-opus-5-5)');
  });

  it('names on Compare two arms whose every pair another judge left out, and why, with no difference for them, in en and zh-CN', async () => {
    const OPUS = { by: 'judge' as const, rubric: 'r', tool: 'claude', model: 'claude-opus-5-5', batched: true };
    const run = coveredRun();
    run.benchmark.trials = run.benchmark.trials.map((trial) => ({
      ...trial,
      verdicts: [{ scorer: `teamai:correctness:${trial.task}`, outcome: { kind: 'labelled' as const, label: trial.result, score: trial.result === 'passed' ? 1 : 0, passed: trial.result === 'passed' },
        decider: trial.arm === 'no-tokens' ? { ...OPUS, model: 'claude-sonnet-5-5' } : OPUS }],
    }));

    const en = text(await renderPage([run], { view: 'compare' }));
    const zh = text(await renderPage([run], { view: 'compare', language: 'zh-CN' }));

    expect(en).not.toContain('No two arms of this suite differ in one thing only');
    expect(en).toContain('Arms with no comparable pair');
    expect(en).toContain('without skills/auth-tokens → pulled team · claude 2 excluded: their judge changed (claude claude-sonnet-5-5 → claude claude-opus-5-5)');
    expect(zh).toContain('没有可比较配对的 arm');
    expect(zh).toContain('2 已排除: 评判器已改变 (claude claude-sonnet-5-5 → claude claude-opus-5-5)');
  });

  it('names what changed in a judge whose tool and model stayed, its batching and rubric, as the CLI does', async () => {
    const OPUS = { by: 'judge' as const, rubric: 'aaaaaaa111', tool: 'claude', model: 'claude-opus-5-5', batched: true };
    const run = coveredRun();
    run.benchmark.trials = run.benchmark.trials.map((trial) => ({
      ...trial,
      verdicts: [{ scorer: `teamai:correctness:${trial.task}`, outcome: { kind: 'labelled' as const, label: trial.result, score: trial.result === 'passed' ? 1 : 0, passed: trial.result === 'passed' },
        decider: trial.arm === 'no-tokens' ? { ...OPUS, rubric: 'bbbbbbb222', batched: false } : OPUS }],
    }));

    const en = text(await renderPage([run], { view: 'compare' }));
    const zh = text(await renderPage([run], { view: 'compare', language: 'zh-CN' }));

    expect(en).toContain('2 excluded: their judge changed (claude claude-opus-5-5 alone rubric bbbbbbb → claude claude-opus-5-5 batched rubric aaaaaaa)');
    expect(zh).toContain('2 已排除: 评判器已改变 (claude claude-opus-5-5 单独 评分标准 bbbbbbb → claude claude-opus-5-5 批量 评分标准 aaaaaaa)');
  });

  it('keeps every resource label in zh-CN too', async () => {
    const zh = text(await renderPage([coveredRun()], { view: 'compare', language: 'zh-CN' }));

    expect(zh).toContain('资源效果');
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

/** One login task, four repetitions, on claude, the defaults arm, and two others: each arm's results, scores and cost per trial. */
function judgedRun(arms: Record<string, { tool: string; results: TrialResult[]; scores: number[]; cost?: number }>): BenchmarkRunInput {
  const names = Object.keys(arms);
  return {
    run: 'r1', source: 'reported', username: 'lead', startedAt: '2026-10-20T09:00:00Z', outcome: 'succeeded', schemaVersion: 2,
    benchmark: {
      suite: { name: 'fix-auth', sourceHash: 'v1' }, repetitions: 4, baselineTeamRevision: TEAM, defaultsArm: 'claude',
      scorers: [{ name: 'teamai:correctness:login', rubric: { sourceHash: 'r1' }, labels: [{ value: 'correct', score: 1 }, { value: 'partial', score: 0.5 }, { value: 'incorrect', score: 0 }], passingScore: 1 }],
      tasks: [{ id: 'login', startingCommit: 'a'.repeat(40), sourceHash: 't1', baseline: 'valid' }],
      arms: names.map((name) => ({ name, tool: arms[name]?.tool ?? '', source: 'team' as const, team: { kind: 'pulled' as const, revision: TEAM } })),
      trials: names.flatMap((name, index) => (arms[name]?.results ?? []).map((result, repetition) => {
        const cost = arms[name]?.cost;
        const score = arms[name]?.scores[repetition] ?? 0;
        return {
          task: 'login', arm: name, repetition: repetition + 1, order: index * 4 + repetition + 1, step: `trials.r${repetition + 1}.login.${name}.prompt`, result,
          verdicts: [{ scorer: 'teamai:correctness:login', outcome: { kind: 'labelled' as const, label: score === 1 ? 'correct' : score > 0 ? 'partial' : 'incorrect', score, passed: result === 'passed' }, decider: { by: 'check' as const, task: 't1' } }],
          agent: { v: 1 as const, tool: { name: arms[name]?.tool ?? '' }, team: { revision: TEAM, localChanges: false }, teamai: '1.0.0', driver: 'local' as const },
          ...(cost === undefined ? {} : { cost: { amount: cost, unit: 'USD', complete: true } }),
        };
      })),
    },
  };
}

describe('the Benchmarks page reads each arm against the defaults arm', () => {
  // claude passes 3 of 4 at 0.50 USD a trial; cheap 3 of 4 at 0.10; codex 1 of 4 at 1.00.
  const runs = [judgedRun({
    claude: { tool: 'claude', results: ['passed', 'passed', 'passed', 'failed'], scores: [1, 1, 1, 0.5], cost: 0.5 },
    cheap: { tool: 'claude', results: ['passed', 'passed', 'passed', 'failed'], scores: [1, 1, 1, 0], cost: 0.1 },
    codex: { tool: 'codex', results: ['passed', 'failed', 'failed', 'failed'], scores: [1, 0.5, 0, 0], cost: 1 },
  })];
  const bar = (html: string, arm: string) => text((html.split('<div class="arm-bars">')[1] ?? '').split('<div class="arm-bar').find((one) => one.includes(`<span data-verbatim>${arm}</span>`)) ?? '').trim();

  it('puts its cost per passed trial, its mean correctness score and its standing under each arm\'s pass rate', async () => {
    const html = await renderPage(runs);

    expect(bar(html, 'claude')).toContain('Cost per passed trial 0.6667 USD · Mean correctness score 0.88 · The arm the others are read against (defaults arm)');
    // Newcombe intervals over the 4 pairs: cheap 0 pp (-43 to +43), codex -50 pp (-79 to +14).
    expect(bar(html, 'cheap')).toContain('Cost per passed trial 0.1333 USD · Mean correctness score 0.75 · Against claude (defaults arm): dominates, same pass rate, 80% cheaper per passed trial · 0 pp · 95% −43 pp to +43 pp · not separated');
    expect(bar(html, 'codex')).toContain('Cost per passed trial 4 USD · Mean correctness score 0.38 · Against claude (defaults arm): dominated, lower pass rate, 500% more expensive per passed trial · −50 pp · 95% −79 pp to +14 pp · not separated');
  });

  it('reads the last run on its own the same way, under each arm of it', async () => {
    const html = await renderPage(runs);
    const latest = (arm: string) => text((html.split('<div class="latest">')[1] ?? '').split('<div class="latest-arm">').find((one) => one.includes(`<span data-verbatim>${arm}</span>`)) ?? '').trim();

    expect(latest('cheap')).toContain('Cost per passed trial 0.1333 USD · Mean correctness score 0.75 · Against claude (defaults arm): dominates, same pass rate, 80% cheaper per passed trial · 0 pp · 95% −43 pp to +43 pp · not separated');
    expect(latest('claude')).toContain('The arm the others are read against (defaults arm)');
  });
});

describe('the Benchmarks page says who judged what', () => {
  const SONNET = { by: 'judge' as const, rubric: 'rq', tool: 'claude', model: 'claude-sonnet-5-5', batched: true };
  const base = judgedRun({
    claude: { tool: 'claude', results: ['passed', 'passed', 'passed', 'failed'], scores: [1, 1, 1, 0], cost: 0.5 },
    codex: { tool: 'codex', results: ['passed', 'failed', 'failed', 'failed'], scores: [1, 0, 0, 0], cost: 1 },
  });
  // The check decides login; review-quality is pinned to claude `judge`, and codex judged codex's first trial; nothing labelled its last.
  const runs = [{ ...base, benchmark: { ...base.benchmark,
    judges: { 'review-quality': { tool: 'claude', model: 'judge' } },
    trials: base.benchmark.trials.map((trial) => ({ ...trial, verdicts: [...trial.verdicts ?? [],
      trial.arm === 'codex' && trial.repetition === 4 ? { scorer: 'review-quality', outcome: { kind: 'unscored' as const, because: 'run_ended' as const } }
        : { scorer: 'review-quality', outcome: { kind: 'labelled' as const, label: 'good', score: 1, passed: true }, ...(trial.arm === 'codex' && trial.repetition === 1 ? { decider: { ...SONNET, tool: 'codex', model: 'gpt-6-sol' }, asPlanned: 'deviation' as const } : { decider: SONNET, asPlanned: 'match' as const }) }] })) } }];
  const panel = (html: string) => text(html.split('<section class="panel sessions bench-panel judges">')[1]?.split('</section>')[0] ?? '');

  it('lists each scorer with the judge the run pinned, who decided its labels, and its deviations, and warns of a judge that is also an arm\'s tool', async () => {
    const judges = panel(await renderPage(runs));

    expect(judges).toContain('Judge claude is also the tool of arm claude · Set tool in the scorer to judge with another.');
    expect(judges).toContain('teamai:correctness — check (8) 0 0 0');
    expect(judges).toContain('review-quality claude · judge claude claude-sonnet-5-5 (6) · codex gpt-6-sol (1) 1 0 1');
  });

  it('shows no judges panel for runs whose records keep no verdicts', async () => {
    const [run] = runs;
    const older: BenchmarkRunInput[] = run ? [{ ...run, schemaVersion: 1, benchmark: { ...run.benchmark, judges: undefined, trials: run.benchmark.trials.map(({ verdicts: _verdicts, ...trial }) => trial) } }] : [];

    expect(await renderPage(older)).not.toContain('judges">');
  });
});

describe('the Benchmarks page shows each scorer by arm', () => {
  const SONNET = { by: 'judge' as const, rubric: 'rq', tool: 'claude', model: 'claude-sonnet-5-5', batched: true };
  const base = judgedRun({
    claude: { tool: 'claude', results: ['passed', 'passed', 'passed', 'passed'], scores: [1, 1, 1, 1] },
    codex: { tool: 'codex', results: ['passed', 'passed', 'passed', 'passed'], scores: [1, 1, 1, 1] },
  });
  // review-quality passed claude's first three trials and codex's first; nothing labelled codex's last.
  const passes: Record<string, Array<boolean | undefined>> = { claude: [true, true, true, false], codex: [true, false, false, undefined] };
  const runs = [{ ...base, benchmark: { ...base.benchmark,
    scorers: [...base.benchmark.scorers, { name: 'review-quality', rubric: { sourceHash: 'rq' }, labels: [{ value: 'good', score: 1 }, { value: 'poor', score: 0 }], passingScore: 1 }],
    trials: base.benchmark.trials.map((trial) => {
      const passed = passes[trial.arm]?.[trial.repetition - 1];

      return { ...trial, verdicts: [...trial.verdicts ?? [], passed === undefined ? { scorer: 'review-quality', outcome: { kind: 'unscored' as const, because: 'run_ended' as const } }
        : { scorer: 'review-quality', outcome: { kind: 'labelled' as const, label: passed ? 'good' : 'poor', score: passed ? 1 : 0, passed }, decider: SONNET, asPlanned: 'match' as const }] };
    }) } }];

  it("colours each suite and task scorer's pass rate per arm, with its 95% interval and what went unscored in the title", async () => {
    const html = await renderPage(runs);
    const panel = html.split('<h2>Scorers by arm')[1]?.split('</section>')[0] ?? '';

    expect(html.indexOf('<h2>Scorers by arm')).toBeGreaterThan(html.indexOf('<h2>Tasks by arm'));
    expect(text(panel)).toContain('review-quality 75% 3/4 33% 1/3');
    // Wilson: 3 of 4 is 30% to 95%; 1 of 3 is 6% to 79%.
    expect(panel).toContain('title="95% 30% to 95%"');
    expect(panel).toContain('title="95% 6% to 79% · 1 unscored"');
  });

  it('names the panel and the unscored labels in zh-CN', async () => {
    const html = await renderPage(runs, { language: 'zh-CN' });

    expect(html).toContain('<h2>评分器 × arm');
    expect(html).toContain('title="95% 6% 至 79% · 1 未评分"');
  });

  it('shows no scorers by arm for runs whose records keep no verdicts', async () => {
    const [run] = runs;
    const older: BenchmarkRunInput[] = run ? [{ ...run, schemaVersion: 1, benchmark: { ...run.benchmark, trials: run.benchmark.trials.map(({ verdicts: _verdicts, ...trial }) => trial) } }] : [];

    expect(await renderPage(older)).not.toContain('Scorers by arm');
  });
});

describe('the Benchmarks page of a suite whose files stayed while its record version changed', () => {
  const base = judgedRun({ claude: { tool: 'claude', results: ['passed', 'failed'], scores: [1, 0] } });
  const older: BenchmarkRunInput = { ...base, run: 'r0', startedAt: '2026-10-19T09:00:00Z', schemaVersion: 1, benchmark: { ...base.benchmark, trials: base.benchmark.trials.map(({ verdicts: _verdicts, ...trial }) => trial) } };

  it('marks only the run of the current record version current, and gives the older one no column of the tasks per run', async () => {
    const html = await renderPage([older, base]);
    const row = (run: string) => text(html.split(`data-run="${run}" data-run-source="reported">`).at(-1)?.split('</tr>')[0] ?? '');

    expect(row(base.run)).toContain('current');
    expect(row('r0')).not.toContain('current');
    expect(html).not.toContain('Tasks per run');
  });
});

describe('the Benchmarks page puts each run\'s cost beside its estimate', () => {
  const base = judgedRun({
    claude: { tool: 'claude', results: ['passed', 'passed', 'passed', 'passed'], scores: [1, 1, 1, 1], cost: 0.5 },
    codex: { tool: 'codex', results: ['passed', 'passed', 'passed', 'failed'], scores: [1, 1, 1, 0], cost: 1 },
  });
  const estimate = { trials: 8, judgeCalls: 0, judgedTrials: 0, calibrationCalls: 0, basis: { run: 'r1' }, total: { unit: 'USD', low: 3.25, median: 4, high: 4.75, complete: true } };
  const cell = (html: string, run: string) => text(html.split(`data-run="${run}" data-run-source="reported">`).at(-1)?.split('</tr>')[0]?.split('data-label="COST">')[1]?.split('</td>')[0] ?? '').trim();

  it('flags a run that cost more than its estimate\'s range, and shows a run with no earlier run to estimate from at what it cost', async () => {
    // The agents stated 4 × 0.5 + 4 × 1 = 6 USD.
    const html = await renderPage([base, { ...base, run: 'r2', startedAt: '2026-10-21T09:00:00Z', benchmark: { ...base.benchmark, estimate } }]);

    expect(cell(html, 'r2')).toBe('6 USD Estimated 3.25–4.75 USD above the estimate');
    expect(cell(html, 'r1')).toBe('6 USD');
  });

  it('says it in zh-CN', async () => {
    const html = await renderPage([{ ...base, benchmark: { ...base.benchmark, estimate } }], { language: 'zh-CN' });

    expect(text(html)).toContain('6 USD 估算 3.25–4.75 USD 高于估算');
  });

  it('shows no cost column when no run has an estimate or a stated cost', async () => {
    const unpriced = { ...base, benchmark: { ...base.benchmark, trials: base.benchmark.trials.map(({ cost: _cost, ...trial }) => trial) } };

    expect(await renderPage([unpriced])).not.toContain('data-label="COST"');
  });
});

describe('the Benchmarks page calibrates the correctness judge', () => {
  const HAIKU = { by: 'judge' as const, rubric: 'rc', tool: 'claude', model: 'claude-haiku-5-5', batched: false };
  const OPUS = { ...HAIKU, model: 'claude-opus-5-5', effort: 'high' };
  const base = judgedRun({
    claude: { tool: 'claude', results: ['failed', 'failed', 'failed', 'failed'], scores: [0, 0, 0, 0], cost: 0.5 },
    codex: { tool: 'codex', results: ['failed', 'failed', 'failed', 'failed'], scores: [0, 0, 0, 0], cost: 1 },
  });
  /**
   * login with success criteria too, whose correctness the run pins to claude `fast`, each trial's check failed, and
   * `calibrated` what its judge then labelled, in a suite that calibrates at `rate`.
   */
  const mixed = (calibrated: (trial: { arm: string; repetition: number }) => { passed: boolean; decider: typeof HAIKU } | undefined, rate = 100): BenchmarkRunInput[] => [{ ...base, benchmark: { ...base.benchmark,
    calibration: { rate },
    tasks: base.benchmark.tasks.map((task) => ({ ...task, judge: 'both' as const })),
    judges: { 'teamai:correctness:login': { tool: 'claude', model: 'fast' } },
    trials: base.benchmark.trials.map((trial) => {
      const calibration = calibrated(trial);
      return calibration ? { ...trial, calibration: { label: calibration.passed ? 'correct' : 'incorrect', ...calibration } } : trial;
    }) } }];

  it('heads the Arms view with the calibration when a judge passes failing work beyond chance, with each judge\'s false pass rate and interval', async () => {
    // claude-haiku-5-5 labelled 2 of claude's 4 failing trials passing; claude-opus-5-5 none of codex's.
    const html = await renderPage(mixed(({ arm, repetition }) => (arm === 'claude' ? { passed: repetition <= 2, decider: HAIKU } : { passed: false, decider: OPUS })));
    const panel = html.split('<section class="panel sessions bench-panel calibration alert">')[1]?.split('</section>')[0] ?? '';

    const at = html.indexOf('calibration alert');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('<div class="arm-bars">'));
    // Wilson: 2 of 4 is 15% to 85%; 0 of 4 is 0% to 49%.
    expect(text(panel)).toContain('claude claude-haiku-5-5 4 2 50% 15% to 85%');
    expect(text(panel)).toContain('claude claude-opus-5-5 high 4 0 0% 0% to 49%');
  });

  it('says plainly when the suite calibrates no judge, and how to turn calibration on', async () => {
    const html = await renderPage(mixed(() => undefined, 0));
    const panel = html.split('<section class="panel sessions bench-panel calibration">')[1]?.split('</section>')[0] ?? '';

    expect(text(panel)).toContain('This suite calibrates no judge, so these runs do not say how far the correctness judge can be trusted. To measure it, set a calibration rate in suite.yaml:');
    expect(panel).toContain('<code class="command" data-verbatim>calibration: { rate: 10 }</code>');
  });

  it('says plainly when a calibrating suite labelled none of the trials whose check failed', async () => {
    const html = await renderPage(mixed(() => undefined, 10));
    const panel = html.split('<section class="panel sessions bench-panel calibration">')[1]?.split('</section>')[0] ?? '';

    expect(html).not.toContain('calibration alert');
    expect(html.indexOf('bench-panel calibration')).toBeGreaterThan(html.indexOf('bench-panel judges'));
    expect(text(panel)).toContain('No judge labelled the trials whose check failed (8), so these runs do not say how far the correctness judge can be trusted.');
    expect(panel).toContain('<code class="command" data-verbatim>calibration: { rate: 10 }</code>');
  });

  it('reads the standing, the judges and the calibration in zh-CN', async () => {
    const zh = text(await renderPage(mixed(({ arm }) => (arm === 'claude' ? { passed: true, decider: HAIKU } : undefined)), { language: 'zh-CN' }));

    expect(zh).toContain('对照 claude (默认 arm)');
    expect(zh).toContain('固定的评审 判定来源 偏差 未验证 未评分');
    expect(zh).toContain('评审校准 · teamai:correctness');
    expect(zh).toContain('评审者 检查失败后评审数 标为通过 误判通过率 95% 区间');
    expect(zh).toContain('claude claude-haiku-5-5 放过失败工作的频率超出了偶然范围');
  });

  it('heads every cell of the judges and calibration tables, which a narrow screen lays out as cards under those heads', async () => {
    const html = await renderPage(mixed(({ arm }) => (arm === 'claude' ? { passed: true, decider: HAIKU } : undefined)));
    const rowsOf = (section: string) => {
      const table = html.split(`<section class="panel sessions bench-panel ${section}`)[1]?.split('</section>')[0] ?? '';
      const heads = [...table.matchAll(/<th>([^<]+)<\/th>/g)].map(([, head]) => head);

      return { heads, rows: [...table.matchAll(/<tr class="[^"]*">(.*?)<\/tr>/g)].map(([, row]) => [...(row ?? '').matchAll(/<td data-label="([^"]+)">/g)].map(([, head]) => head)) };
    };

    for (const section of ['judges', 'calibration']) {
      const { heads, rows } = rowsOf(section);

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toEqual(heads);
    }
  });

  it('shows no calibration on a suite with no task a judge could be calibrated on', async () => {
    const html = await renderPage([base]);

    expect(html).not.toContain('bench-panel calibration');
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
