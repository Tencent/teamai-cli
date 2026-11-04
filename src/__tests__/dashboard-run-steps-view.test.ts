import { describe, expect, it } from 'vitest';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { handoffView } from '../dashboard/handoff-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { judgingView } from '../dashboard/judging-view.js';
import { runStepsView } from '../dashboard/run-steps-view.js';
import { dashboardStyles } from '../dashboard/styles.js';
import type { RunDetail } from '../dashboard/workflow-runs.js';

const messages: Record<string, string> = dashboardMessages;

type Step = RunDetail['steps'][number];

/** The Steps of a run's details as the page renders `steps` in `language`, with every message key it asked for. */
function render(steps: Step[], language: 'en' | 'zh-CN' = 'en', run = 'r0000000000000001'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const scope = {
    t, e, label, number: (value: number) => String(value),
    runStatus: (status: string) => `<span>${label(({ running: 'Running', succeeded: 'Succeeded', failed: 'Failed' } as Record<string, string>)[status] ?? status)}</span>`, outcomesHtml: () => '—',
    deciderText: (by: string) => `<span class="decider">${label(({ judge: 'Judge', hand: 'Hand label' } as Record<string, string>)[by] ?? by)}</span>`, when: (at: string) => at.slice(0, 10),
  };
  const table = new Function(...Object.keys(scope), `${agentHarnessView}\n${handoffView}\n${judgingView}\n${runStepsView}\nreturn runStepsTable;`)(...Object.values(scope)) as (steps: Step[], run: string) => string;
  return { html: table(steps, run), keys };
}

const REVISION = 'c'.repeat(40);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const STEPS: Step[] = [
  { step: 'plan', pass: 1, status: 'succeeded', tokens: { input: 900, output: 274 }, scores: [{ scorer: 'review-quality', label: 'partial', score: 0.5, passed: false }],
    harness: { tool: 'claude', model: 'claude-sonnet-5-5', role: { of: 'step', names: ['spec'] }, teamRevision: REVISION } },
  { step: 'implement', pass: 1, status: 'succeeded', harness: { tool: 'claude', model: 'claude-sonnet-5-5', role: { of: 'member', names: ['frontend'] }, teamRevision: REVISION } },
];

describe("a run's Steps", () => {
  it('names the column of every cell, so a narrow drawer shows each pass as a card with its harness, score and outcome', () => {
    const { html } = render(STEPS);
    const [first] = [...html.matchAll(/<tbody>(<tr>.*?<\/tr>)/gs)].map(([, row]) => row ?? '');

    expect(html).toMatch(/^<div class="table-scroll card-table"><table class="run-steps">/);
    expect([...(first ?? '').matchAll(/<td data-label="([^"]+)"/g)].map(([, name]) => name)).toEqual(['STEP', 'PASS', 'STATUS', 'TOKENS', 'ANSWER', 'SCORES', 'OUTCOMES']);
    expect(first).toContain('<span class="harness-part"><span data-verbatim>spec</span> <span class="role-of step">step role</span></span>\u00a0·\u00a0<span class="harness-part" data-verbatim>ccccccc</span>');
  });

  it('says under a skipped step\'s status why it was skipped, as the engine wrote it', () => {
    const why = 'Step "publish" was skipped: this run is isolated, so it publishes nothing to a data branch.';
    const { html } = render([{ step: 'publish', pass: 1, status: 'skipped', message: why }]);
    const status = /<td data-label="STATUS">(.*?)<\/td>/s.exec(html)?.[1] ?? '';

    expect(status).toContain('<small data-verbatim>Step &quot;publish&quot; was skipped: this run is isolated, so it publishes nothing to a data branch.</small>');
  });

  it('switches to cards by the width of the drawer, not of the window', () => {
    expect(dashboardStyles).toContain('.card-table{container-type:inline-size}');
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.run-steps thead[^{]*\{display:none\}/);
  });

  it('flags a pass whose harness changed since the previous pass of its step, naming each change', () => {
    const review = (pass: number, model: string, extra: Partial<Step> = {}): Step => ({
      step: 'review', pass, status: 'failed', harness: { tool: 'claude', model, role: { of: 'step', names: ['review'] }, teamRevision: REVISION }, ...extra,
    });
    const passes = [
      review(1, 'claude-sonnet-5-5'),
      review(2, 'claude-opus-5-5', { harnessChanges: [{ part: 'model', from: 'claude-sonnet-5-5', to: 'claude-opus-5-5' }] }),
      review(3, 'claude-opus-5-5', { harnessChanges: [
        { part: 'effort', to: 'high' },
        { part: 'role', from: { of: 'step', names: ['review'] }, to: { of: 'member', names: ['frontend'] } },
        { part: 'teamRevision', from: REVISION, to: 'd'.repeat(40) },
      ] }),
    ];
    const { html } = render(passes);
    const changed = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].slice(1).map(([, row]) => [...(row ?? '').matchAll(/<li>(.*?)<\/li>/gs)].map(([, change]) => text(change ?? '')));

    expect(changed).toEqual([
      [],
      ['model changed: claude-sonnet-5-5 → claude-opus-5-5'],
      ['effort changed: not recorded → high', 'role changed: review step role → frontend member role', 'team revision changed: ccccccc → ddddddd'],
    ]);
    expect(html).toContain('<ul class="harness-changed">');

    const chinese = render(passes, 'zh-CN');
    expect(chinese.html).toContain('<li><b>模型已变:</b>');
    expect([...new Set(chinese.keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });

  it('names each card part in Chinese', () => {
    const { html, keys } = render(STEPS, 'zh-CN');

    expect(html).toContain('<td data-label="步骤">');
    expect([...new Set(keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });

  it("names each scorer's state on a pass, links the score run judging it, and gives the command that judges it again", () => {
    const run = 'r00000000000000ab';
    const judging = 'r00000000000000cc';
    const scored: Step = {
      step: 'review', pass: 2, status: 'succeeded',
      scores: [{ scorer: 'quality', label: 'good', score: 1, passed: true, decidedBy: 'judge' }, { scorer: 'coverage', label: 'thin', score: 0, passed: false, decidedBy: 'hand' }],
      unlabelled: [
        { scorer: 'delivered', state: { kind: 'waiting_ci' } },
        { scorer: 'clarity', state: { kind: 'judging', run: judging, since: '2026-11-03T09:00:00.000Z' } },
        { scorer: 'tests', state: { kind: 'lapsed', lapses: 3, expiresAt: '2026-11-17T09:00:00.000Z' } },
        { scorer: 'style', state: { kind: 'failed', code: 'judge_answer_invalid' } },
        { scorer: 'docs', state: { kind: 'not_sampled', samplingRate: 20 } },
        { scorer: 'security', state: { kind: 'queued' } },
        { scorer: 'naming', state: { kind: 'expired' } },
      ],
      scoreRuns: [{ run: 'r00000000000000bb', status: 'failed' }, { run: judging, status: 'running' }],
    };
    const { html } = render([scored], 'en', run);
    const cell = /<td data-label="SCORES">(.*?)<\/td>/s.exec(html)?.[1] ?? '';
    const lines = [...cell.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map(([, line]) => text(line ?? '').replace(/&#39;/g, "'"));

    expect(lines).toEqual([
      'quality: good · score 1 Judge',
      'coverage: thin · score 0 Hand label',
      'delivered: Waiting for CI The pull request\'s CI has not finished. The next teamai-finished-sessions judges it once CI has.',
      `clarity: Judging in ${judging} since 2026-11-03`,
      'tests: Lapsed 3/4 · expires 2026-11-17 Score runs ended without labelling it. The next teamai-finished-sessions starts it again, and the fourth lapse closes it. teamai score --run r00000000000000ab --step review --pass 2 --scorer tests Copy',
      'style: Failed · judge_answer_invalid The judge\'s answer did not match the scorer\'s answer schema, so no label was written. Check the scorer\'s labels, then judge it again. teamai score --run r00000000000000ab --step review --pass 2 --scorer style Copy',
      'docs: Not sampled at 20% teamai score --run r00000000000000ab --step review --pass 2 --scorer docs Copy',
      'security: Not judged yet',
      'naming: Expired Not judged within 14 days of the run\'s last change, so automatic judging no longer starts it. teamai score --run r00000000000000ab --step review --pass 2 --scorer naming Copy',
    ]);
    expect(cell).toContain(`<button class="link" data-run="${judging}" data-run-source="local">`);
    expect(cell).toContain('data-copy="teamai score --run r00000000000000ab --step review --pass 2 --scorer style"');
    expect(text(cell)).toContain('Score runs: r00000000000000bb Failed · r00000000000000cc Running');

    const chinese = render([scored], 'zh-CN', run);
    expect([...new Set(chinese.keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
