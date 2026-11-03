import { describe, expect, it } from 'vitest';
import { handoffView } from '../dashboard/handoff-view.js';
import type { JudgingHealth } from '../dashboard/judging-health.js';
import { judgingView } from '../dashboard/judging-view.js';
import { dashboardMessages } from '../dashboard/locales.js';
import { dashboardStyles } from '../dashboard/styles.js';

const messages: Record<string, string> = dashboardMessages;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** The Judging health panel as the Workflow Runs page renders `health` in `language`, with every message key it asked for. */
function render(health: JudgingHealth, language: 'en' | 'zh-CN' = 'en'): { html: string; keys: string[] } {
  const keys: string[] = [];
  const t = (key: string) => {
    keys.push(key);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, key) ? messages[key] : key;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const label = (key: string) => e(t(key));
  const scope = {
    t, e, label, language: 'en-US', number: (value: number) => value.toLocaleString('en-US'), when: (at: string) => at.slice(0, 10),
    pct: (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`),
    kpiCard: (title: string, value: string, foot?: string) => `<article class="card kpi"><div class="cardtop">${title}</div><div class="big">${value}</div>${foot ? `<div class="statusline">${foot}</div>` : ''}</article>`,
    deciderText: (by: string) => `<span class="decider">${label(({ judge: 'Judge', hand: 'Hand label', ci: 'Pull request CI' } as Record<string, string>)[by] ?? by)}</span>`,
    runStatus: (status: string) => `<span>${label(status)}</span>`,
  };
  const panel = new Function(...Object.keys(scope), `${handoffView}\n${judgingView}\nreturn judgingHealthPanel;`)(...Object.values(scope)) as (health: JudgingHealth) => string;
  return { html: panel(health), keys };
}

const HEALTH: JudgingHealth = {
  labels: { total: 12, passed: 9, byDecider: { judge: 8, ci: 3, hand: 1 }, inputTokens: 41_200, outputTokens: 3_100 },
  states: { queued: 2, not_sampled: 5, judging: 1, waiting_ci: 1, lapsed: 1, failed: 2, expired: 0 },
  failures: [{ code: 'judge_answer_invalid', count: 2 }],
  missing: [
    { run: 'r00000000000000ab', workflow: 'ship-issue', alias: 'ship', step: 'change', pass: 1, scorer: 'delivered', state: { kind: 'waiting_ci' } },
    { run: 'r00000000000000ab', workflow: 'ship-issue', alias: 'ship', step: 'review', pass: 2, scorer: 'review-quality', state: { kind: 'failed', code: 'judge_answer_invalid' } },
  ],
  sessions: { dailyLimit: 10, days: ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'].map((day, index) => ({ day, launches: [0, 3, 10, 4, 0, 2, 1][index] ?? 0 })) },
};

describe('the Judging health panel', () => {
  it("answers whether this machine's judging keeps up: the week's labels and tokens, what is missing and why, and session launches against the daily limit", () => {
    const { html } = render(HEALTH);
    const cards = [...html.matchAll(/<article class="card kpi">(.*?)<\/article>/gs)].map(([, card]) => text(card ?? ''));

    expect(cards).toEqual([
      'Labels this week 12 75% passed',
      'Judge tokens this week 44,300 41,200 input · 3,100 output',
      'Judging now 1 2 Not judged yet',
      'Waiting for CI 1',
      'Lapsed 1 0 Expired',
      'Failed 2 judge_answer_invalid 2',
    ]);
    expect(text(html)).toContain('Decided by Judge 8 Pull request CI 3 Hand label 1');
    expect(text(html)).toContain("judge_answer_invalid 2 The judge's answer did not match the scorer's answer schema");
    expect(text(html)).toContain('Session launches per day daily_limit 10');
    expect(html).toContain('<div class="launch-day at-limit"');
    const rows = [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].slice(1).map(([, row]) => text(row ?? ''));
    expect(rows).toEqual([
      'ship r00000000000000ab change #1 delivered Waiting for CI The pull request\'s CI has not finished. The next teamai-finished-sessions judges it once CI has.',
      "ship r00000000000000ab review #2 review-quality Failed · judge_answer_invalid The judge's answer did not match the scorer's answer schema, so no label was written. Check the scorer's labels, then judge it again. teamai score --run r00000000000000ab --step review --pass 2 --scorer review-quality Copy",
    ]);
    expect(html).toContain('<button class="link" data-run="r00000000000000ab" data-run-source="local">');
  });

  it('says so when nothing on this machine was judged or is missing', () => {
    const quiet: JudgingHealth = { ...HEALTH, labels: { total: 0, passed: 0, byDecider: {}, inputTokens: 0, outputTokens: 0 }, states: { queued: 0, not_sampled: 0, judging: 0, waiting_ci: 0, lapsed: 0, failed: 0, expired: 0 }, failures: [], missing: [] };

    expect(text(render(quiet).html)).toContain('Every scored pass of the runs listed here has its labels.');
  });

  it('names every part in Chinese, and shows the missing labels as cards in a narrow page', () => {
    const { keys } = render(HEALTH, 'zh-CN');

    expect([...new Set(keys)].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
    expect(dashboardStyles).toMatch(/@container\(max-width:760px\)\{[^@]*\.judging-missing-labels thead[^{]*\{display:none\}/);
  });
});
