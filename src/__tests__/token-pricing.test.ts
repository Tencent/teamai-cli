import { describe, expect, it } from 'vitest';

import { PRICE_CATALOG_VERSION, priceTokens } from '../token-usage/pricing.js';

const USAGE = { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 400 };
const cost = (model: string, tokens = USAGE, options: Partial<Parameters<typeof priceTokens>[0]> = {}) =>
  priceTokens({ model, tokens, ...options })?.costMicros ?? null;

describe('priceTokens', () => {
  it('prices Claude token buckets in integer micro-dollars from the catalog', () => {
    expect(priceTokens({ model: 'claude-sonnet-5', tokens: USAGE })).toEqual({
      // input $0.002 + output $0.002 + cache read $0.001 + 5m cache write $0.001
      costMicros: 6_000,
      source: 'catalog',
      priceVersion: PRICE_CATALOG_VERSION,
    });
  });

  it('prices each Claude generation at its own rates', () => {
    // Opus 5.5: input $0.004 + output $0.004 + cache read $0.001 + 5m cache write $0.002
    expect(cost('claude-opus-5-5')).toBe(11_000);
    // Sonnet 5.5: input $0.002 + output $0.002 + cache read $0.0005 + 5m cache write $0.001
    expect(cost('claude-sonnet-5-5')).toBe(5_500);
    expect(cost('claude-opus-5')).toBe(15_000);
  });

  it('prices Haiku 5.5 at its higher rates once the prompt is over 100,000 tokens', () => {
    // input $0.0001 + output $0.0001 + cache read $0.00005 + 5m cache write $0.00005
    expect(cost('claude-haiku-5-5')).toBe(300);
    // The prompt counts cache reads and writes: 20,000 + 90,000 + 2,000 = 112,000 tokens.
    // input $0.01 + output $0.0025 + cache read $0.0045 + 5m cache write $0.00125
    expect(cost('claude-haiku-5-5', { input: 20_000, output: 1_000, cacheRead: 90_000, cacheCreation: 2_000 })).toBe(18_250);
    // Exactly 100,000 prompt tokens is still the lower price.
    expect(cost('claude-haiku-5-5', { input: 10_000, output: 0, cacheRead: 90_000, cacheCreation: 0 })).toBe(1_900);
  });

  it('prices OpenAI models, with the long-context rates over 272,000 prompt tokens', () => {
    // GPT-6.1 Sol: input $0.002 + output $0.002 + cached input $0.0005
    expect(cost('gpt-6.1-sol', { input: 1_000, output: 200, cacheRead: 5_000, cacheCreation: 0 })).toBe(4_500);
    // 300,000 prompt tokens: input $1.20 + output $0.015
    expect(cost('gpt-6.1-sol', { input: 300_000, output: 1_000, cacheRead: 0, cacheCreation: 0 })).toBe(1_215_000);
  });

  it('prices one-hour cache writes at their own rate', () => {
    // Opus 5.5: input $0.004 + output $0.004 + cache read $0.001 + 1h cache write $0.0032
    expect(cost('claude-opus-5-5', USAGE, { cacheCreation1h: 400 })).toBe(12_200);
    // Part of the writes at each duration: 100 at 5m ($0.0005) and 300 at 1h ($0.0024).
    expect(cost('claude-opus-5-5', USAGE, { cacheCreation1h: 300 })).toBe(11_900);
  });

  it('prices fast mode at the provider\'s fast rates', () => {
    // Opus 5.5 fast mode is twice the standard price.
    expect(cost('claude-opus-5-5', USAGE, { speed: 'fast' })).toBe(22_000);
    // A model with no fast price is charged its standard price.
    expect(cost('claude-sonnet-5', USAGE, { speed: 'fast' })).toBe(6_000);
  });

  it('prices every spelling tools and gateways give one model', () => {
    const opus41 = { input: 1_000, output: 200, cacheRead: 0, cacheCreation: 0 };
    // Opus 4.1: input $0.015 + output $0.015
    for (const model of [
      'claude-opus-4-1-20250805',
      'claude-opus-4.1',
      'anthropic/claude-opus-4-1',
      'us.anthropic.claude-opus-4-1-20250805-v1:0',
      'claude-opus-4-1[1m]',
    ]) expect(cost(model, opus41), model).toBe(30_000);
  });

  it('keeps the cost a tool reported over the catalog price', () => {
    expect(priceTokens({ model: 'claude-sonnet-5', tokens: USAGE, reportedCostMicros: 7_250 })).toEqual({
      costMicros: 7_250,
      source: 'reported',
      priceVersion: 'reported',
    });
    // A tool can report the cost of a model no price list knows.
    expect(cost('company-proxy-model', USAGE, { reportedCostMicros: 900 })).toBe(900);
  });

  it('leaves unknown models and bare family names unpriced', () => {
    expect(cost('company-proxy-model')).toBeNull();
    expect(cost('sonnet')).toBeNull();
    expect(cost('<synthetic>')).toBeNull();
  });

  it('prices a gateway alias as the model it maps to', () => {
    const aliases = { 'gateway-model-42': 'claude-sonnet-5' };
    expect(priceTokens({ model: 'gateway-model-42', tokens: USAGE }, aliases)).toEqual(priceTokens({ model: 'claude-sonnet-5', tokens: USAGE }));
    expect(cost('gateway-model-42', USAGE)).toBeNull();
    expect(priceTokens({ model: 'gateway-model-42', tokens: USAGE }, { 'gateway-model-42': 'some-nonexistent-model' })).toBeNull();
    // An unrelated alias leaves a directly priced model alone.
    expect(priceTokens({ model: 'claude-sonnet-5', tokens: USAGE }, { 'ep-other': 'claude-opus-5' })?.costMicros).toBe(6_000);
  });
});
