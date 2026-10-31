import { describe, expect, it } from 'vitest';

import { dashboardMessages } from '../dashboard/locales.js';
import type { TokenCostSummary } from '../dashboard/token-costs.js';
import { tokensView } from '../dashboard/tokens-view.js';

const usage = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({ input, output, cacheRead, cacheCreation });

// A week of one developer: Claude Code on a refactor, a Codex review, Pi with a
// cost it reported itself, and OpenCode on a free model no price list knows.
const WEEK: TokenCostSummary = {
  days: 7, from: '2026-10-25', to: '2026-10-31', catalogVersion: 'litellm-2026-10-31-b264711',
  totals: { requests: 412, pricedRequests: 389, costMicros: 18_420_000, reportedCostMicros: 61_699, cacheSavingsMicros: 41_300_000, tokens: usage(1_204_000, 386_000, 29_870_000, 1_910_000) },
  previous: { requests: 300, costMicros: 15_000_000 },
  daily: ['25', '26', '27', '28', '29', '30', '31'].map((day, index) => ({ date: `2026-10-${day}`, requests: index * 10, costMicros: index * 1_000_000, tokens: index * 900_000 })),
  byTool: [
    { tool: 'claude', requests: 301, pricedRequests: 301, costMicros: 14_900_000, tokens: usage(900_000, 300_000, 25_000_000, 1_800_000) },
    { tool: 'opencode', requests: 23, pricedRequests: 0, costMicros: 0, tokens: usage(200_000, 6_000, 40_000, 0) },
  ],
  byModel: [
    { model: 'claude-opus-5-5', tools: ['claude'], requests: 301, pricedRequests: 301, costMicros: 14_900_000, tokens: usage(900_000, 300_000, 25_000_000, 1_800_000) },
    { model: 'big-pickle', tools: ['opencode'], requests: 23, pricedRequests: 0, costMicros: 0, tokens: usage(200_000, 6_000, 40_000, 0) },
  ],
  topSessions: [{ sessionId: 'b2f4c1d0-3a9e-4c55-9d2a-61c0f7e8a912', tool: 'claude', lastAt: '2026-10-30T09:16:40Z', requests: 120, pricedRequests: 120, costMicros: 6_200_000, tokens: usage(1, 1, 1, 1) }],
};

/** The page as the dashboard renders `summary`, in `language`, with every message key it asked to translate. */
async function renderPage(summary: TokenCostSummary, language: 'en' | 'zh-CN' = 'en') {
  const keys: string[] = [];
  const t = (text: string) => {
    keys.push(text);
    return language === 'zh-CN' && Object.hasOwn(dashboardMessages, text) ? dashboardMessages[text] : text;
  };
  const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const label = (text: string) => e(t(text));
  const requested: string[] = [];
  let failing = false;
  const scope = {
    t, e, label, language: 'en',
    number: (value: number) => new Intl.NumberFormat('en').format(value),
    when: (value: string) => value,
    json: async (route: string) => { requested.push(route); if (failing) throw new Error('offline'); return summary; },
    apiQuery: (route: string, params: Record<string, string>) => `${route}?${new URLSearchParams(params)}`,
    errorPanel: (text: string) => text, render: () => undefined, page: 'tokens', workspaceGeneration: 0,
    sessions: [{ sessionId: 'b2f4c1d0-3a9e-4c55-9d2a-61c0f7e8a912', repoLabel: 'acme/payments', prompts: ['Move the refund job off the request thread'] }],
    document: { addEventListener: () => undefined },
  };
  const names = Object.keys(scope);
  const page = new Function(...names, `${tokensView}\nreturn { tokensPage, loadTokens, sessionsChanged };`)(...Object.values(scope)) as { tokensPage: () => string; loadTokens: () => Promise<void>; sessionsChanged: () => Promise<void> };
  page.tokensPage();
  await page.loadTokens();
  keys.length = 0;
  return { html: page.tokensPage(), keys, requested, page, fail: () => { failing = true; } };
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the Tokens & cost page', () => {
  it('shows the window\'s cost against the prior one, the tokens, what caching saved and how much is priced', async () => {
    const { html, requested } = await renderPage(WEEK);
    const shown = text(html);
    expect(requested).toEqual(['/api/tokens?days=7']);
    expect(shown).toContain('Estimated cost $18.42 Prior: $15.00 · +23%');
    expect(shown).toContain('Tokens 33.4M Input 1.2M · Output 386K · Cache 31.8M');
    expect(shown).toContain('Saved by caching $41.30');
    expect(shown).toContain('Requests priced 94% 389 / 412 · $0.0617 reported by the tool');
  });

  it('marks a model no price list knows as tokens only, and shows the alias that would price it', async () => {
    const shown = text((await renderPage(WEEK)).html);
    expect(shown).toContain('big-pickle opencode 23 246K Tokens only');
    expect(shown).toContain('big-pickle: claude-sonnet-5-5');
  });

  it('names a costly session the dashboard knows by its first prompt, and links it to its details', async () => {
    const { html } = await renderPage(WEEK);
    expect(html).toContain('data-session="b2f4c1d0-3a9e-4c55-9d2a-61c0f7e8a912">Move the refund job off the request thread ↗</button>');
    expect(text(html)).toContain('acme/payments · 2026-10-30T09:16:40Z');
  });

  it('says a 90-day window has no prior period to compare with', async () => {
    const { html, keys } = await renderPage({ ...WEEK, days: 90, previous: null }, 'zh-CN');
    expect(html).toContain('请求只保留 90 天');
    expect(keys.filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });

  it('fetches again when a live session update arrives, and not on a plain render', async () => {
    const { page, requested } = await renderPage(WEEK);
    page.tokensPage();
    expect(requested).toHaveLength(1);
    await page.sessionsChanged();
    expect(requested).toHaveLength(2);
  });

  it('waits for the next update after a failed refresh instead of retrying', async () => {
    const { page, requested, fail } = await renderPage(WEEK);
    fail();
    await page.sessionsChanged();
    page.tokensPage();
    page.tokensPage();
    expect(requested).toHaveLength(2);
  });

  it('says where usage comes from when the window has no request', async () => {
    const empty = { ...WEEK, totals: { ...WEEK.totals, requests: 0 } };
    expect(text((await renderPage(empty)).html)).toContain('No requests in this window');
  });

  it('has a zh-CN translation for every label', async () => {
    const { keys } = await renderPage(WEEK, 'zh-CN');
    const emptyKeys = (await renderPage({ ...WEEK, totals: { ...WEEK.totals, requests: 0 } }, 'zh-CN')).keys;
    expect([...new Set([...keys, ...emptyKeys])].filter((key) => !Object.hasOwn(dashboardMessages, key))).toEqual([]);
  });
});
