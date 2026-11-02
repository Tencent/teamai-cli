import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../agent-observation.js';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { benchmarksClient } from '../dashboard/benchmarks-client.js';
import type { RoleArm } from '../dashboard/benchmarks.js';
import { chartFitView } from '../dashboard/chart-fit-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { dashboardStyles } from '../dashboard/styles.js';
import { scorersClient } from '../dashboard/scorers-client.js';
import type { ScoreLabel } from '../scorers/label.js';
import { ScorerResults, type ViewedLabel } from '../scorers/results.js';

const messages: Record<string, string> = dashboardMessages;

const NOW = new Date('2026-10-28T12:00:00Z');
const REVIEWED = 'a'.repeat(40);
const MEMBER = 'b'.repeat(40);

/** A pass that ran on `tool` with `model`, delivered at `revision` for the member `frontend`, in a copy with `stepRole` when given. */
const ranAs = ({ tool, model, revision, stepRole }: { tool: string; model: string; revision: string; stepRole?: string }): AgentObservation => ({
  v: 1, tool: { name: tool }, model: { reported: model }, ...(tool === 'claude' ? { effort: { requested: 'high' } } : {}), teamai: '1.0.0', driver: 'local',
  team: { revision, localChanges: false, selection: { scope: 'project', primaryRole: 'frontend', additionalRoles: [], ...(stepRole ? { stepRole } : {}) } },
});

function label(runId: string, step: string, { passed, scoredAt, agent }: { passed: boolean; scoredAt: string; agent?: AgentObservation }): ScoreLabel {
  return {
    scorer: 'review-quality', rubric: { sourceHash: 'rubric-1', teamRevision: REVIEWED }, label: passed ? 'thorough' : 'missed-defect', score: passed ? 1 : 0, passed,
    judge: { kind: 'model', tool: 'claude', model: { reported: 'claude-judge-1' }, isolation: 'verified', access: 'read' },
    scoredAt, source: 'workflow', subject: { runId, step, pass: 1 }, ...(agent ? { agent } : {}),
  };
}

/**
 * A team lead's week of a code-review workflow: its `review` step runs with `role: review`, its `implement` step with
 * the member's role. One run is still listed, the others are gone, and one label was written before labels carried an agent.
 */
const viewed = (author: string, judged: ScoreLabel, runSource?: 'reported'): ViewedLabel => ({
  author, label: judged, ...(judged.agent ? { agent: judged.agent } : {}), ...(runSource ? { runSource } : {}),
});
const LABELS: ViewedLabel[] = [
  viewed('bob', label('r0000000000000001', 'review', { passed: false, scoredAt: '2026-10-27T10:00:00.000Z', agent: ranAs({ tool: 'claude', model: 'claude-review-1', revision: REVIEWED, stepRole: 'review' }) }), 'reported'),
  viewed('bob', label('r0000000000000002', 'review', { passed: true, scoredAt: '2026-10-26T10:00:00.000Z', agent: ranAs({ tool: 'claude', model: 'claude-review-1', revision: REVIEWED, stepRole: 'review' }) })),
  viewed('ana', label('r0000000000000003', 'implement', { passed: false, scoredAt: '2026-10-25T10:00:00.000Z', agent: ranAs({ tool: 'codex', model: 'gpt-5', revision: MEMBER }) })),
  viewed('ana', label('r0000000000000004', 'implement', { passed: false, scoredAt: '2026-10-24T10:00:00.000Z' })),
];

/**
 * The Scorers page as the dashboard renders `labels` grouped by role, the grouping saved as `groupBy`, in `language`: its
 * HTML, every message key it asked for, each query it sent, and `click`, which clicks the first element an attribute
 * names and renders the page again. The server answers each query with the failing labels of the group it names, split at
 * the commit it names.
 */
async function openPage(labels: ViewedLabel[], { groupBy = 'role', language = 'en', split, roleArms = [] }: { groupBy?: string; language?: 'en' | 'zh-CN'; split?: { commit: string; sideOf: ReadonlyMap<string, 'before' | 'after'> }; roleArms?: RoleArm[] } = {}) {
  const viewOf = (url: string) => {
    // The Benchmarks page's answer, with no run but the arms that ran with a role.
    if (url.startsWith('/api/benchmarks')) return { configured: true, window: { from: '', to: '' }, suites: [], teamCommits: {}, teamDiffs: {}, roleArms };
    const params = new URLSearchParams(url.split('?')[1]);
    const group = params.get('group'), commit = params.get('commit');
    // Without a split of its own, a commit the page asks to split at is on the team clone, with work on it after it.
    const at = split ?? (commit ? { commit, sideOf: new Map([[commit, 'after' as const]]) } : undefined);
    return { configured: true, ...ScorerResults.of({ labels, query: { windowDays: 30, groupBy: 'role', ...(group ? { failing: { group } } : {}), ...(at ? { split: at } : {}) }, now: NOW }) };
  };
  const keys: string[] = [];
  const t = (text: string): string => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] ?? text : text;
  };
  const e = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const queries: string[] = [];
  const moved: string[] = [];
  const clicks: Array<(event: { target: { closest: (selector: string) => unknown } }) => void> = [];
  const scope = {
    // As client.ts defines it on the page.
    t, e, label: (text: string) => e(t(text)), link: (key: string, text: string) => `<button class="link" data-page="${key}">${e(t(text))} →</button>`, number: (value: number) => new Intl.NumberFormat('en').format(value), when: (value: string) => value,
    read: (key: string, fallback: string) => (key === 'teamai-dashboard-scorer-group' ? groupBy : fallback), save: () => undefined,
    // Each element of the page, recording where the page scrolled and what it focused.
    $: (id: string) => ({ scrollIntoView: () => moved.push(`scrolled to ${id}`), focus: () => moved.push(`focused ${id}`) }),
    apiQuery: (route: string, params: Record<string, string>) => `${route}?${new URLSearchParams(params)}`, errorPanel: (text: string) => text, render: () => undefined, page: 'scorers', workspaceGeneration: 0,
    fetch: async (url: string) => {
      queries.push(url);
      return { ok: true, json: async () => viewOf(url) };
    },
    window: { innerWidth: 1440 }, location: { hash: 'scorers' },
    document: {
      addEventListener: (type: string, listener: (typeof clicks)[number]) => (type === 'click' ? clicks.push(listener) : undefined),
      // Each chart the page drew, laid out in a box `box` px wide.
      querySelectorAll: () => [...html.matchAll(/<svg data-chart="([^"]+)" viewBox="0 0 (\d+) /g)].map(([, chart, drawn]) => ({
        dataset: { chart }, viewBox: { baseVal: { width: Number(drawn) } }, getBoundingClientRect: () => ({ width: box }),
      })),
    },
  };
  const page = new Function(...Object.keys(scope), `${agentHarnessView}\n${chartFitView}\n${scorersClient}\n${benchmarksClient}\nreturn { scorersPage, loadScorers, fitCharts: () => fitCharts(), openScorers: (changes) => openScorers(changes) };`)(...Object.values(scope)) as {
    scorersPage: () => string; loadScorers: () => Promise<void>; fitCharts: () => void; openScorers: (changes: Record<string, string>) => void;
  };
  let box = 0;
  await page.loadScorers();
  page.scorersPage();
  // Once every answer the page asked for arrived.
  await new Promise((resolve) => setTimeout(resolve, 0));
  let html = page.scorersPage();
  /** Clicks the first element of the page that `attribute` names, with the value the page gave it. */
  const click = async (attribute: string) => {
    const escaped = new RegExp(`${attribute}="([^"]*)"`).exec(html)?.[1];
    if (escaped === undefined) throw new Error(`The page has no ${attribute}`);
    const value = escaped.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const dataset = { [attribute.replace(/^data-/, '').replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())]: value };
    const target = { closest: (selector: string) => (selector === `[${attribute}]` ? { dataset } : null) };
    for (const listener of clicks) listener({ target });
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = page.scorersPage();
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = page.scorersPage();
    return html;
  };
  /** Lays every chart out in a box `boxWidth` px wide, lets the page measure it, and renders the page again. */
  const resize = (boxWidth: number) => {
    box = boxWidth;
    page.fitCharts();
    html = page.scorersPage();
    return html;
  };
  /** Opens the page on \`changes\`, as another page links to a group, and renders it once its answer arrived. */
  const open = async (changes: Record<string, string>) => {
    page.openScorers(changes);
    await new Promise((resolve) => setTimeout(resolve, 0));
    html = page.scorersPage();
    return html;
  };
  return { html, keys, queries, moved, location: scope.location, click, resize, open };
}

async function renderPage(labels: ViewedLabel[], options: Parameters<typeof openPage>[1] = {}): Promise<{ html: string; keys: string[] }> {
  const { html, keys } = await openPage(labels, options);
  return { html, keys };
}

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The text of each row of the table under the heading `heading`. */
function rowsUnder(html: string, heading: string): string[] {
  const section = html.split('<section').find((part) => part.includes(`<h2>${heading} `)) ?? '';
  return [...section.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].slice(1).map(([, row]) => text(row ?? ''));
}

describe('the Scorers page of a workflow whose review step runs with a role of its own', () => {
  it("groups the labels by the role each pass ran with, and marks whether that was the step's role or the member's", async () => {
    const { html } = await renderPage(LABELS);

    expect(rowsUnder(html, 'By Role')).toEqual(['review step 2 1 1 50%', 'frontend member 1 0 1 0%', 'Not recorded 1 0 1 0%']);
    expect(html).toContain('<span class="role-of step">step</span>');
    expect(html).toContain('<span class="role-of member">member</span>');
  });

  it("lays both tables out as cards by the panel's own width, so a narrow panel beside the sidebar keeps every column", async () => {
    const { html } = await renderPage(LABELS);
    const cellNames = (table: string) => {
      const [row] = [...html.matchAll(new RegExp(`<table class="session-table ${table}">.*?<tbody>(<tr[^>]*>.*?</tr>)`, 'gs'))].map(([, first]) => first ?? '');
      return [...(row ?? '').matchAll(/<td[^>]*data-label="([^"]+)"/g)].map(([, name]) => name);
    };

    expect(html).toContain('<div class="table-scroll card-table"><table class="session-table scorer-groups">');
    expect(html).toContain('<div class="table-scroll card-table"><table class="session-table failing-labels">');
    expect(cellNames('scorer-groups')).toEqual(['VALUE', 'LABELS', 'PASSED', 'FAILED', 'PASS RATE']);
    expect(dashboardStyles).toContain('.card-table{container-type:inline-size}');
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.failing-labels thead,[^@]*\.scorer-groups thead[^{]*\{display:none\}/);
  });

  it('draws the weekly pass rate as wide as its box, so a phone reads its week labels at full size', async () => {
    const { resize } = await openPage(LABELS);
    const drawn = (html: string) => [...html.matchAll(/<svg data-chart="trend" viewBox="0 0 (\d+) /g)].map(([, width]) => Number(width));

    expect(drawn(resize(332))).toEqual([332]);
    expect(drawn(resize(1000))).toEqual([1000]);
  });

  it('lays the scorer table out as cards by its panel\'s width too, naming each part', async () => {
    const { html } = await renderPage(LABELS);
    const [row] = [...html.matchAll(/<table class="session-table scorer-summary">.*?<tbody>(<tr[^>]*>.*?<\/tr>)/gs)].map(([, first]) => first ?? '');

    expect(html).toContain('<div class="table-scroll card-table"><table class="session-table scorer-summary">');
    expect([...(row ?? '').matchAll(/<td[^>]*data-label="([^"]+)"/g)].map(([, name]) => name)).toEqual(['SCORER', 'MEASUREMENT', 'LABELS', 'PASS RATE', 'AGREES WITH HAND LABELS', 'TREND']);
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.scorer-summary thead[^{]*\{display:none\}/);
  });

  it('shows each failing label\'s harness on one line, opens a run still listed, and says when the harness was not recorded', async () => {
    const { html } = await renderPage(LABELS);

    expect(rowsUnder(html, 'Failing labels')).toEqual([
      '2026-10-27T10:00:00.000Z bob missed-defect claude · claude-review-1 · high · review step role · aaaaaaa Workflow run — Start not recorded — r0000000000000001 ↗ review #1',
      '2026-10-25T10:00:00.000Z ana missed-defect codex · gpt-5 · frontend member role · bbbbbbb Workflow run — Start not recorded — r0000000000000003 Run not found implement #1',
      '2026-10-24T10:00:00.000Z ana missed-defect Harness not recorded Workflow run — Start not recorded — r0000000000000004 Run not found implement #1',
    ]);
    expect(html).toContain('<span class="role-of step">step role</span>');
    expect(html).toContain('data-run="r0000000000000001" data-run-source="reported"');
    expect(html).toContain(`title="Team revision ${REVIEWED}"`);
  });

  it('labels each cell of a failing label, so a phone shows it as a card that names its parts', async () => {
    const { html } = await renderPage(LABELS);
    const section = html.split('<section').find((part) => part.includes('<h2>Failing labels ')) ?? '';
    const [row] = [...section.matchAll(/<tbody>(<tr>.*?<\/tr>)/gs)].map(([, first]) => first ?? '');

    expect([...(row ?? '').matchAll(/<td[^>]*data-label="([^"]+)"/g)].map(([, name]) => name)).toEqual(['SCORED', 'AUTHOR', 'LABEL', 'HARNESS', 'PLATFORM', 'SKILLS', 'REGRESSION', 'LEARNINGS', 'OPEN']);
    expect(section).toContain('class="session-table failing-labels"');
  });

  it("sums a selected group's failing labels by harness above the list, and splits at a harness's team revision from it", async () => {
    const later = ranAs({ tool: 'claude', model: 'claude-review-2', revision: MEMBER, stepRole: 'review' });
    const labels = [
      ...LABELS,
      viewed('cy', label('r0000000000000005', 'review', { passed: false, scoredAt: '2026-10-28T09:00:00.000Z', agent: later })),
      viewed('cy', label('r0000000000000006', 'review', { passed: false, scoredAt: '2026-10-28T10:00:00.000Z', agent: later })),
    ];
    const review = JSON.stringify(['value', 'review', null, false]);
    const { html: grouped, click, queries, moved } = await openPage(labels);
    expect(grouped).not.toContain('harness-failures');
    const html = await click('data-scorer-group');
    const failing = html.split('<section').find((part) => part.includes('<h2>Failing labels ')) ?? '';
    const summary = /<div class="harness-failures">.*?<\/div>/s.exec(failing)?.[0] ?? '';

    expect(failing).toMatch(/<div class="harness-failures">.*<table/s);
    expect(summary).toContain('<h3>Failures by harness</h3>');
    expect([...summary.matchAll(/<li>(.*?)<\/li>/gs)].map(([, row]) => text(row ?? ''))).toEqual([
      '2 failing claude · claude-review-2 · high · review step role · bbbbbbb',
      '1 failing claude · claude-review-1 · high · review step role · aaaaaaa',
    ]);
    expect(summary).toContain(`<span class="role-of step">step role</span></span>\u00a0·\u00a0<span class="harness-part"><button class="link" type="button" data-scorer-split="${MEMBER}" title="Split at team commit ${MEMBER}"`);

    const split = await click('data-scorer-split');
    expect(new URLSearchParams(queries.at(-1)?.split('?')[1]).get('commit')).toBe(MEMBER);
    expect(new URLSearchParams(queries.at(-1)?.split('?')[1]).get('group')).toBe(review);
    expect(split).toContain(`id="scorer-commit" name="commit" autocomplete="off" spellcheck="false" placeholder="commit SHA" value="${MEMBER}"`);
    // The split shows far above the list on a phone, so the page takes the reader to it.
    expect(split).toContain('<h2 class="section-label" id="scorer-split" tabindex="-1">Before and after team commit');
    expect(moved).toEqual(['scrolled to scorer-split', 'focused scorer-split']);

    const chinese = await openPage(labels, { language: 'zh-CN' });
    expect(await chinese.click('data-scorer-group')).toContain('<h3>按 Harness 汇总的失败</h3>');
    expect([...new Set(chinese.keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });

  it('says at which team revision a selected group started failing, when its labels show it clearly, and splits there', async () => {
    const review = (runId: string, passed: boolean, scoredAt: string, revision: string) => viewed('bob', label(runId, 'review', { passed, scoredAt, agent: ranAs({ tool: 'claude', model: 'claude-review-1', revision, stepRole: 'review' }) }));
    const turned = [review('r0000000000000011', true, '2026-10-25T10:00:00.000Z', REVIEWED), review('r0000000000000012', false, '2026-10-26T10:00:00.000Z', MEMBER), review('r0000000000000013', false, '2026-10-27T10:00:00.000Z', MEMBER)];
    const hint = (html: string) => text(/<p class="scorer-hint revision-change">.*?<\/p>/s.exec(html)?.[0] ?? '');

    const { click, queries, moved } = await openPage(turned);
    const html = await click('data-scorer-group');
    expect(hint(html)).toBe('First failed at team revision bbbbbbb · last passed on aaaaaaa');
    await click('data-scorer-split');
    expect(new URLSearchParams(queries.at(-1)?.split('?')[1]).get('commit')).toBe(MEMBER);
    expect(moved).toEqual(['scrolled to scorer-split', 'focused scorer-split']);

    // The review step passed and failed on the same revision: no revision to name.
    expect(hint(await (await openPage(LABELS)).click('data-scorer-group'))).toBe('');
    const chinese = await openPage(turned, { language: 'zh-CN' });
    await chinese.click('data-scorer-group');
    expect([...new Set(chinese.keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });

  it('links a role to the benchmark arms that ran with it, and opens Benchmarks on that suite with the arm marked', async () => {
    const roleArms = [{ role: 'review', suite: 'review-sql', arm: 'review' }, { role: 'review', suite: 'review-sql', arm: 'codex-review' }, { role: 'spec', suite: 'spec-api', arm: 'spec' }];
    const { html, click, queries, location } = await openPage(LABELS, { roleArms });

    expect(rowsUnder(html, 'By Role')).toEqual(['review step Benchmark arms: review-sql · review ↗ review-sql · codex-review ↗ 2 1 1 50%', 'frontend member 1 0 1 0%', 'Not recorded 1 0 1 0%']);
    expect(queries).toContain('/api/benchmarks?window=90');

    await click('data-scorer-arm');
    expect(location.hash).toBe('benchmarks');
    expect(queries.at(-1)).toBe('/api/benchmarks?window=90&suite=review-sql');
    // Without benchmark arms, or grouped by anything else, nothing changes.
    expect(rowsUnder((await openPage(LABELS)).html, 'By Role')[0]).toBe('review step 2 1 1 50%');
  });

  it('names the selected group in the heading of its failing labels', async () => {
    const { html: every, click } = await openPage(LABELS);
    const heading = (html: string) => text(/<h2>Failing labels.*?<\/h2>/s.exec(html)?.[0] ?? '');

    expect(heading(every)).toBe('Failing labels 3');
    expect(heading(await click('data-scorer-group'))).toBe('Failing labels · review step 1');
  });

  it('takes the reader to the role group another page opens it on, below the fold on a phone', async () => {
    const { open, moved, click } = await openPage(LABELS);
    const html = await open({ groupBy: 'role', group: JSON.stringify(['value', 'review', null, false]) });

    expect(html).toContain('<button class="link" data-scorer-group="[&quot;value&quot;,&quot;review&quot;,null,false]" aria-pressed="true" id="scorer-selected-group">');
    expect(moved).toEqual(['scrolled to scorer-selected-group', 'focused scorer-selected-group']);
    // A group picked on the page itself is where the reader already is.
    await click('data-scorer-group');
    expect(moved).toHaveLength(2);
  });

  it('translates every label the role groups and the failing list ask for', async () => {
    const { keys } = await renderPage(LABELS, { language: 'zh-CN' });

    expect(keys).toEqual(expect.arrayContaining(['HARNESS', 'Harness not recorded', 'step role', 'member role', 'Team revision', 'step', 'member']));
    expect([...new Set(keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});

describe('the Scorers page counts one of a thing in the singular', () => {
  const ran = (revision: string) => ranAs({ tool: 'claude', model: 'claude-review-1', revision, stepRole: 'review' });
  /** `count` labels of the review step, `passed` of them passing, on work delivered at `revision`, from run `first` on. */
  const reviews = ({ count, passed, revision, first }: { count: number; passed: number; revision: string; first: number }) => Array.from({ length: count }, (_, index) =>
    viewed('bob', label(`r${String(first + index).padStart(16, '0')}`, 'review', { passed: index < passed, scoredAt: '2026-10-27T10:00:00.000Z', agent: ran(revision) })));
  const split = { commit: MEMBER, sideOf: new Map([[REVIEWED, 'before' as const], [MEMBER, 'after' as const]]) };
  /** The title and the line under the value of each card that has one. */
  const feet = (html: string) => html.split('<article class="card kpi">').slice(1).flatMap((card) => {
    const foot = /<div class="statusline">(.*?)<\/div><\/article>/s.exec(card)?.[1];
    return foot === undefined ? [] : [`${text(/<div class="cardtop">(.*?)<\/div>/s.exec(card)?.[1] ?? '')}: ${text(foot)}`];
  });

  it('"1 label", under the pass rate and on each side of a team commit', async () => {
    const { html } = await renderPage([...reviews({ count: 1, passed: 1, revision: REVIEWED, first: 1 }), ...reviews({ count: 1, passed: 0, revision: MEMBER, first: 2 })], { split });

    expect(feet(html)).toEqual(expect.arrayContaining(['Pass rate: 2 labels', 'Before: 1 label', 'After: 1 label · -100 pts']));
  });

  it('"+1 pt", the change after a team commit', async () => {
    const { html } = await renderPage([...reviews({ count: 2, passed: 1, revision: REVIEWED, first: 1 }), ...reviews({ count: 100, passed: 51, revision: MEMBER, first: 3 })], { split });

    expect(feet(html)).toContain('After: 100 labels · +1 pt');
  });

  it('"1 hand-labelled session", beside the judge agreement', async () => {
    const judged = label('r0000000000000001', 'review', { passed: true, scoredAt: '2026-10-27T10:00:00.000Z', agent: ran(REVIEWED) });
    const { html } = await renderPage([viewed('bob', judged), viewed('ana', { ...judged, judge: { kind: 'human' }, scoredAt: '2026-10-27T11:00:00.000Z' })]);

    expect(text(/<h2>Judge agreement with hand labels.*?<\/h2>/s.exec(html)?.[0] ?? '')).toBe('Judge agreement with hand labels 1 hand-labelled session');
  });
});
