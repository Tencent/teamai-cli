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

  it('prices Opus 5.5 and Sonnet 5.5 at their own rates, not the Opus 5 or Sonnet 5 ones', () => {
    const usage = { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 400 };
    // Opus 5.5: input $0.004 + output $0.004 + cache read $0.001 + 5m cache write $0.002
    expect(estimateClaudeRequest('claude-opus-5-5', usage)?.costMicros).toBe(11_000);
    // Sonnet 5.5: input $0.002 + output $0.002 + cache read $0.0005 + 5m cache write $0.001
    expect(estimateClaudeRequest('claude-sonnet-5-5', usage)?.costMicros).toBe(5_500);
    // The earlier generations keep their rates.
    expect(estimateClaudeRequest('claude-opus-5', usage)?.costMicros).toBe(15_000);
  });

  it('prices Haiku 5.5, with the higher rates once the prompt is over 100,000 tokens', () => {
    const short = { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 400 };
    // input $0.0001 + output $0.0001 + cache read $0.00005 + 5m cache write $0.00005
    expect(estimateClaudeRequest('claude-haiku-5-5', short)?.costMicros).toBe(300);
    // The prompt length counts cache reads: 20,000 + 90,000 + 2,000 = 112,000 tokens.
    const long = { input: 20_000, output: 1_000, cacheRead: 90_000, cacheCreation: 2_000 };
    // input $0.01 + output $0.0025 + cache read $0.0045 + 5m cache write $0.00125
    expect(estimateClaudeRequest('claude-haiku-5-5', long)?.costMicros).toBe(18_250);
    // Exactly 100,000 prompt tokens is still the lower price.
    const edge = { input: 10_000, output: 0, cacheRead: 90_000, cacheCreation: 0 };
    expect(estimateClaudeRequest('claude-haiku-5-5', edge)?.costMicros).toBe(1_900);
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
