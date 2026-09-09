import type { RequestCostMetrics, TokenUsage } from './types.js';

/**
 * Snapshot date for the public Claude API prices below. Existing daily costs are
 * stored as integer micro-dollars and are never recomputed after this table changes.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 */
export const PRICE_TABLE_VERSION = 'anthropic-2026-09-09';

interface TokenRates {
  input: number;
  output: number;
  cacheRead: number;
  /** Claude transcript usage does not expose cache TTL; use the standard 5m rate. */
  cacheWrite: number;
}

const RATES: Array<{ match: RegExp; rates: TokenRates }> = [
  { match: /(?:fable|mythos)[-_ ]?5[-_.]?1/i, rates: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 } },
  { match: /(?:fable|mythos)[-_ ]?5/i, rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 } },
  { match: /opus[-_ ]?(?:5|4[-_.]?(?:8|7|6|5))/i, rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  { match: /opus[-_ ]?4(?:[-_.]?1)?/i, rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } },
  { match: /sonnet[-_ ]?5/i, rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  { match: /sonnet[-_ ]?4(?:[-_.]?(?:6|5))?/i, rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
  { match: /haiku[-_ ]?4[-_.]?5/i, rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  { match: /haiku[-_ ]?3[-_.]?5/i, rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 } },
];

/** Estimate standard first-party API token cost. Subscription and enterprise discounts are excluded. */
export function estimateClaudeRequest(model: string, usage: TokenUsage): RequestCostMetrics | null {
  const entry = RATES.find(({ match }) => match.test(model));
  if (!entry) return null;
  const { rates } = entry;
  return {
    pricedRequests: 1,
    // At a USD-per-million-token rate, tokens × rate equals micro-US-dollars.
    costMicros: Math.round(
      usage.input * rates.input
      + usage.output * rates.output
      + usage.cacheRead * rates.cacheRead
      + usage.cacheCreation * rates.cacheWrite,
    ),
    cacheReadTokens: usage.cacheRead,
    cacheEligibleInputTokens: usage.input + usage.cacheRead + usage.cacheCreation,
    priceVersion: PRICE_TABLE_VERSION,
  };
}
