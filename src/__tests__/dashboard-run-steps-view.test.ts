import { describe, expect, it } from 'vitest';
import { agentHarnessView } from '../dashboard/agent-harness-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { runStepsView } from '../dashboard/run-steps-view.js';
import { dashboardStyles } from '../dashboard/styles.js';
import type { RunDetail } from '../dashboard/workflow-runs.js';

const messages: Record<string, string> = dashboardMessages;

type Step = RunDetail['steps'][number];

/** The Steps of a run's details as the page renders `steps` in `language`, with every message key it asked for. */
function render(steps: Step[], language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? messages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (text: string) => e(t(text));
  const scope = {
    t, e, label, number: (value: number) => String(value),
    runStatus: (status: string) => `<span>${label(status)}</span>`, outcomesHtml: () => '—',
  };
  const table = new Function(...Object.keys(scope), `${agentHarnessView}\n${runStepsView}\nreturn runStepsTable;`)(...Object.values(scope)) as (steps: Step[]) => string;
  return { html: table(steps), keys };
}

const REVISION = 'c'.repeat(40);
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const STEPS: Step[] = [
  { step: 'plan', pass: 1, status: 'succeeded', tokens: { input: 900, output: 274 }, scores: [{ scorer: 'review-quality', label: 'partial', passed: false }],
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
});
