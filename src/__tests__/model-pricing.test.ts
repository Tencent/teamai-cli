import { describe, expect, it } from 'vitest';

import { estimateClaudeRequest, PRICE_TABLE_VERSION } from '../model-pricing.js';

describe('Claude API-equivalent price estimation', () => {
  it('prices Sonnet 5 token buckets in integer micro-dollars', () => {
    const result = estimateClaudeRequest('claude-sonnet-5', {
      input: 1_000,
      output: 200,
      cacheRead: 5_000,
      cacheCreation: 400,
    });
    expect(result).toEqual({
      pricedRequests: 1,
      // input $0.002 + output $0.002 + cache read $0.001 + 5m cache write $0.001
      costMicros: 6_000,
      cacheReadTokens: 5_000,
      cacheEligibleInputTokens: 6_400,
      priceVersion: PRICE_TABLE_VERSION,
    });
  });

  it('leaves unknown and third-party models unpriced', () => {
    expect(estimateClaudeRequest('company-proxy-model', { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 })).toBeNull();
  });

  it('prices a gateway alias by mapping it to a known model', () => {
    const usage = { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 400 };
    const aliased = estimateClaudeRequest('gateway-model-42', usage, { 'gateway-model-42': 'claude-sonnet-5' });
    // Identical to pricing 'claude-sonnet-5' directly.
    expect(aliased).toEqual(estimateClaudeRequest('claude-sonnet-5', usage));
    expect(aliased?.costMicros).toBe(6_000);
  });

  it('still returns null for an alias that maps to an unknown model', () => {
    expect(estimateClaudeRequest('gateway-model-42', { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 }, { 'gateway-model-42': 'some-nonexistent-model' })).toBeNull();
  });

  it('ignores the alias map when the raw model already matches', () => {
    const usage = { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 400 };
    // An unrelated alias map must not disturb a directly-matched model.
    expect(estimateClaudeRequest('claude-sonnet-5', usage, { 'ep-other': 'claude-opus-5' }))
      .toEqual(estimateClaudeRequest('claude-sonnet-5', usage));
  });
});
