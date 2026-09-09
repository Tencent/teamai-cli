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
});
