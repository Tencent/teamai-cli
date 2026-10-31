import { describe, expect, it } from 'vitest';

import type { PriceCatalog } from '../src/token-usage/pricing.js';
import { catalogFromLiteLlm, describeCatalogChange } from './model-prices.js';

// Entries copied from LiteLLM's model_prices_and_context_window.json.
const HAIKU_5_5 = {
  litellm_provider: 'anthropic', mode: 'chat',
  input_cost_per_token: 1e-7, output_cost_per_token: 5e-7,
  cache_read_input_token_cost: 1e-8, cache_creation_input_token_cost: 1.25e-7,
  input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6,
  cache_read_input_token_cost_above_100k_tokens: 5e-8, cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
  input_cost_per_token_batches: 5e-8, output_cost_per_token_batches: 2.5e-7,
};
const OPUS_5_5 = {
  litellm_provider: 'anthropic', mode: 'chat',
  input_cost_per_token: 4e-6, output_cost_per_token: 2e-5,
  cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 5e-6, cache_creation_input_token_cost_above_1hr: 8e-6,
  provider_specific_entry: { us: 1.1, fast: 2 },
};
const GPT_6_1_SOL = {
  litellm_provider: 'openai', mode: 'chat',
  input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7,
  input_cost_per_token_priority: 4e-6, output_cost_per_token_priority: 2e-5, cache_read_input_token_cost_priority: 2e-7,
  input_cost_per_token_above_272k_tokens: 4e-6, output_cost_per_token_above_272k_tokens: 1.5e-5,
  cache_read_input_token_cost_above_272k_tokens: 2e-7,
  input_cost_per_token_above_272k_tokens_priority: 8e-6, output_cost_per_token_above_272k_tokens_priority: 3e-5,
  cache_read_input_token_cost_above_272k_tokens_priority: 4e-7,
  input_cost_per_token_flex: 1e-6, output_cost_per_token_flex: 5e-6,
};

const SOURCE = { revision: '0123456789abcdef', date: '2026-10-31' };

describe('catalogFromLiteLlm', () => {
  it('converts per-token USD to USD per million tokens, with the long-prompt tier', () => {
    const catalog = catalogFromLiteLlm({ 'claude-haiku-5-5': HAIKU_5_5 }, SOURCE);
    expect(catalog.models['claude-haiku-5-5']).toEqual({
      input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125,
      above: [{ tokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
    });
  });

  it('prices fast mode from the provider multiplier, and one-hour cache writes', () => {
    const catalog = catalogFromLiteLlm({ 'claude-opus-5-5': OPUS_5_5 }, SOURCE);
    expect(catalog.models['claude-opus-5-5']).toEqual({
      input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8,
      fast: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 },
    });
  });

  it('prices fast mode from priority rates, tiers included, and charges cache writes as input when unlisted', () => {
    const catalog = catalogFromLiteLlm({ 'gpt-6.1-sol': GPT_6_1_SOL }, SOURCE);
    expect(catalog.models['gpt-6-1-sol']).toEqual({
      input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2,
      above: [{ tokens: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 4 }],
      fast: {
        input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4,
        above: [{ tokens: 272_000, input: 8, output: 30, cacheRead: 0.4, cacheWrite: 8 }],
      },
    });
  });

  it('keeps only chat models with input and output prices', () => {
    const catalog = catalogFromLiteLlm({
      'claude-haiku-5-5': HAIKU_5_5,
      'gpt-image-2': { mode: 'image_generation', input_cost_per_token: 5e-6, output_cost_per_token: 4e-5 },
      'free-preview': { mode: 'chat', input_cost_per_token: 0 },
      sample_spec: { mode: 'one of: chat, embedding' },
    }, SOURCE);
    expect(Object.keys(catalog.models)).toEqual(['claude-haiku-5-5']);
  });

  it('keys models by the name every spelling of them shares, the provider\'s own price first', () => {
    const catalog = catalogFromLiteLlm({
      'claude-opus-5-5': OPUS_5_5,
      'bedrock/us.anthropic.claude-opus-5-5-v1:0': { ...OPUS_5_5, input_cost_per_token: 4.4e-6 },
      'vertex_ai/claude-opus-5-5@20261001': { ...OPUS_5_5, input_cost_per_token: 4.4e-6 },
      'anthropic.claude-opus-4-1-20250805-v1:0': { mode: 'chat', input_cost_per_token: 1.5e-5, output_cost_per_token: 7.5e-5 },
    }, SOURCE);
    expect(Object.keys(catalog.models)).toEqual(['claude-opus-4-1', 'claude-opus-5-5']);
    expect(catalog.models['claude-opus-5-5'].input).toBe(4);
    expect(catalog.models['claude-opus-4-1'].input).toBe(15);
  });

  it('prices a model only resellers list at the price most of them charge', () => {
    const kimi = (input: number, output: number) => ({ mode: 'chat', input_cost_per_token: input, output_cost_per_token: output });
    const catalog = catalogFromLiteLlm({
      'moonshot/kimi-k3': kimi(3e-6, 1.5e-5),
      'fireworks_ai/kimi-k3': kimi(3e-6, 1.5e-5),
      'kyma/kimi-k3': kimi(3.052e-6, 1.5258e-5),
      'aihubmix/muse-spark-1.2': kimi(1.375e-6, 4.675e-6),
      'meta/muse-spark-1.2': kimi(1.25e-6, 4.25e-6),
    }, SOURCE);
    expect(catalog.models['kimi-k3']).toEqual({ input: 3, output: 15, cacheRead: 3, cacheWrite: 3 });
    // Two resellers, two prices: no consensus, so the model stays unpriced.
    expect(catalog.models['muse-spark-1-2']).toBeUndefined();
  });

  it('keeps the fast rates one reseller lists when the others agree on the standard price', () => {
    const argon = { mode: 'chat', input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1e-7 };
    const catalog = catalogFromLiteLlm({
      'gemini/gemini-4-argon': { ...argon, input_cost_per_token_priority: 3.6e-6, output_cost_per_token_priority: 1.8e-5, cache_read_input_token_cost_priority: 1.8e-7 },
      'github_copilot/gemini-4-argon': argon,
      'opencode_go/gemini-4-argon': argon,
      'kyma/gemini-4-argon': { ...argon, input_cost_per_token: 5.4e-6 },
    }, SOURCE);
    expect(catalog.models['gemini-4-argon']).toEqual({
      input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2,
      fast: { input: 3.6, output: 18, cacheRead: 0.18, cacheWrite: 3.6 },
    });
  });

  it('names the LiteLLM revision and date it was built from', () => {
    const catalog = catalogFromLiteLlm({}, SOURCE);
    expect(catalog.version).toBe('litellm-2026-10-31-0123456');
    expect(catalog.source).toBe('https://github.com/BerriAI/litellm/blob/0123456789abcdef/model_prices_and_context_window.json');
  });
});

describe('describeCatalogChange', () => {
  const catalog = (version: string, models: PriceCatalog['models']): PriceCatalog => ({ version, source: '', models });
  const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

  it('lists added, removed and repriced models for the pull request body', () => {
    const before = catalog('litellm-2026-10-24-aaaaaaa', { 'claude-opus-5-5': opus, 'gpt-5-old': { ...opus, input: 1 } });
    const after = catalog('litellm-2026-10-31-bbbbbbb', { 'claude-opus-5-5': { ...opus, output: 18 }, 'kimi-k3': { ...opus, input: 3 } });
    expect(describeCatalogChange(before, after)).toBe([
      'Model prices from litellm-2026-10-24-aaaaaaa to litellm-2026-10-31-bbbbbbb: 1 added, 1 removed, 1 repriced.',
      '',
      '| Model | Change | Input | Output | Cache read | Cache write |',
      '| --- | --- | --- | --- | --- | --- |',
      '| claude-opus-5-5 | repriced | $4 | $20 → $18 | $0.2 | $5 |',
      '| gpt-5-old | removed | $1 | $20 | $0.2 | $5 |',
      '| kimi-k3 | added | $3 | $20 | $0.2 | $5 |',
      '',
      'USD per million tokens, standard rates. Costs teamai already recorded keep the prices they were recorded with.',
    ].join('\n'));
  });

  it('says so when nothing changed', () => {
    const same = catalog('litellm-2026-10-31-bbbbbbb', { 'claude-opus-5-5': opus });
    expect(describeCatalogChange(same, same)).toBe('Model prices unchanged at litellm-2026-10-31-bbbbbbb.');
  });
});
