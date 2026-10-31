import { describe, expect, it } from 'vitest';

import type { LocalRequestRecord } from '../dashboard-collector.js';
import { summarizeTokenCosts } from '../dashboard/token-costs.js';

const NOW = new Date('2026-10-31T12:00:00Z');
let next = 0;
const base = (at: string, model: string) => ({
  id: `r${next++}`, timestamp: at, tool: 'claude', sessionId: 's-claude', model,
  inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 5_000, cacheCreationTokens: 400,
});
const priced = (at: string, model: string, fields: Partial<LocalRequestRecord> & { costMicros: number }): LocalRequestRecord => ({
  ...base(at, model), costSource: 'catalog', priceVersion: 'litellm-2026-10-31-b264711', ...fields,
});
const unpriced = (at: string, model: string, fields: { tool: string; sessionId: string }): LocalRequestRecord => ({
  ...base(at, model), ...fields, costMicros: null, priceVersion: null,
});

// A week of one developer: Claude Code on a refactor, a Codex review, and an
// OpenCode session on a free model no price list knows.
const WEEK = [
  priced('2026-10-30T09:15:02Z', 'claude-opus-5-5', { costMicros: 11_000, cacheSavingsMicros: 18_000 }),
  priced('2026-10-30T09:16:40Z', 'claude-opus-5-5', { costMicros: 11_000, cacheSavingsMicros: 18_000 }),
  priced('2026-10-29T17:02:11Z', 'gpt-6.1-sol', { tool: 'codex', sessionId: 's-codex', costMicros: 4_500, cacheSavingsMicros: 9_500 }),
  priced('2026-10-28T11:00:00Z', 'claude-haiku-5-5', { costMicros: 61_699, costSource: 'reported', tool: 'pi', sessionId: 's-pi' }),
  unpriced('2026-10-27T08:30:00Z', 'big-pickle', { tool: 'opencode', sessionId: 's-opencode' }),
  // The week before, for the comparison.
  priced('2026-10-20T10:00:00Z', 'claude-opus-5-5', { costMicros: 50_000 }),
  // Older than both windows.
  priced('2026-09-01T10:00:00Z', 'claude-opus-5-5', { costMicros: 999_999 }),
];

describe('summarizeTokenCosts', () => {
  const summary = summarizeTokenCosts(WEEK, { days: 7, now: NOW });

  it('totals the window\'s cost, tokens, cache savings and how much of it is priced', () => {
    expect(summary.totals).toEqual({
      requests: 5,
      pricedRequests: 4,
      costMicros: 88_199,
      reportedCostMicros: 61_699,
      cacheSavingsMicros: 45_500,
      tokens: { input: 5_000, output: 1_000, cacheRead: 25_000, cacheCreation: 2_000 },
    });
    expect(summary.previous).toEqual({ requests: 1, costMicros: 50_000 });
  });

  it('charts every day of the window, days without requests included', () => {
    expect(summary.daily.map((day) => [day.date, day.costMicros, day.requests])).toEqual([
      ['2026-10-25', 0, 0], ['2026-10-26', 0, 0], ['2026-10-27', 0, 1], ['2026-10-28', 61_699, 1],
      ['2026-10-29', 4_500, 1], ['2026-10-30', 22_000, 2], ['2026-10-31', 0, 0],
    ]);
  });

  it('ranks tools and models by cost, and keeps models no price list knows as tokens only', () => {
    expect(summary.byTool.map(({ tool, costMicros, requests }) => [tool, costMicros, requests])).toEqual([
      ['pi', 61_699, 1], ['claude', 22_000, 2], ['codex', 4_500, 1], ['opencode', 0, 1],
    ]);
    expect(summary.byModel.map(({ model, tools, costMicros, pricedRequests }) => [model, tools, costMicros, pricedRequests])).toEqual([
      ['claude-haiku-5-5', ['pi'], 61_699, 1],
      ['claude-opus-5-5', ['claude'], 22_000, 2],
      ['gpt-6.1-sol', ['codex'], 4_500, 1],
      ['big-pickle', ['opencode'], 0, 0],
    ]);
  });

  it('lists the sessions that cost the most', () => {
    expect(summary.topSessions.map(({ sessionId, tool, costMicros, lastAt }) => [sessionId, tool, costMicros, lastAt])).toEqual([
      ['s-pi', 'pi', 61_699, '2026-10-28T11:00:00Z'],
      ['s-claude', 'claude', 22_000, '2026-10-30T09:16:40Z'],
      ['s-codex', 'codex', 4_500, '2026-10-29T17:02:11Z'],
      ['s-opencode', 'opencode', 0, '2026-10-27T08:30:00Z'],
    ]);
  });

  it('has no prior period for a window longer than half of the 90 days the log keeps', () => {
    expect(summarizeTokenCosts(WEEK, { days: 90, now: NOW }).previous).toBeNull();
    expect(summarizeTokenCosts(WEEK, { days: 30, now: NOW }).previous).toEqual({ requests: 0, costMicros: 0 });
  });

  it('keeps only a workspace\'s sessions when given them', () => {
    const scoped = summarizeTokenCosts(WEEK, { days: 7, now: NOW, sessionIds: new Set(['s-codex']) });
    expect(scoped.totals.requests).toBe(1);
    expect(scoped.byTool.map(({ tool }) => tool)).toEqual(['codex']);
  });
});
