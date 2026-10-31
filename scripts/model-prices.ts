/**
 * Builds teamai's model price catalog (`src/token-usage/model-prices.json`)
 * from LiteLLM's community price list, which covers every provider teamai's
 * tools run models from. Run `node scripts/update-model-prices.mjs`; a weekly
 * workflow runs it and opens a pull request when prices change.
 */
import { z } from 'zod';

import { canonicalModelName } from '../src/token-usage/model-name.js';
import type { ModelPrice, PriceCatalog, TieredRates, TokenRates } from '../src/token-usage/pricing.js';

const LITELLM_FILE = 'model_prices_and_context_window.json';
const CHAT_MODES = new Set(['chat', 'responses']);
const Rate = z.number().finite().nonnegative();
const Entry = z.record(z.string(), z.unknown());
const ProviderEntry = z.object({ fast: z.number().finite().positive().optional() }).loose();

/** USD per token to USD per million tokens, without float noise such as 0.09999999999999999. */
function perMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}

/** The four rates under one LiteLLM suffix (`''`, `_priority`, `_above_272k_tokens`, ...). */
function readRates(entry: Record<string, unknown>, suffix: string): TokenRates | undefined {
  const input = Rate.safeParse(entry[`input_cost_per_token${suffix}`]);
  const output = Rate.safeParse(entry[`output_cost_per_token${suffix}`]);
  if (!input.success || !output.success) return undefined;
  // A provider without a separate cache price bills those tokens as input.
  const cacheRead = Rate.safeParse(entry[`cache_read_input_token_cost${suffix}`]);
  const cacheWrite = Rate.safeParse(entry[`cache_creation_input_token_cost${suffix}`]);
  const cacheWrite1h = Rate.safeParse(entry[`cache_creation_input_token_cost_above_1hr${suffix}`]);
  return {
    input: perMillion(input.data),
    output: perMillion(output.data),
    cacheRead: perMillion(cacheRead.success ? cacheRead.data : input.data),
    cacheWrite: perMillion(cacheWrite.success ? cacheWrite.data : input.data),
    ...(cacheWrite1h.success ? { cacheWrite1h: perMillion(cacheWrite1h.data) } : {}),
  };
}

function readTiered(entry: Record<string, unknown>, speed: '' | '_priority'): TieredRates | undefined {
  const base = readRates(entry, speed);
  if (!base) return undefined;
  const above = Object.keys(entry)
    .map((key) => new RegExp(`^input_cost_per_token_above_(\\d+)k_tokens${speed}$`).exec(key))
    .flatMap((match) => {
      const rates = match && readRates(entry, `_above_${match[1]}k_tokens${speed}`);
      return match && rates ? [{ tokens: Number(match[1]) * 1000, ...rates }] : [];
    })
    .sort((a, b) => a.tokens - b.tokens);
  return above.length ? { ...base, above } : base;
}

function scaled(rates: TieredRates, multiple: number): TieredRates {
  const times = (rate: number) => perMillion((rate * multiple) / 1_000_000);
  const scale = (r: TokenRates): TokenRates => ({
    input: times(r.input),
    output: times(r.output),
    cacheRead: times(r.cacheRead),
    cacheWrite: times(r.cacheWrite),
    ...(r.cacheWrite1h === undefined ? {} : { cacheWrite1h: times(r.cacheWrite1h) }),
  });
  const base = scale(rates);
  return rates.above ? { ...base, above: rates.above.map((tier) => ({ tokens: tier.tokens, ...scale(tier) })) } : base;
}

function readModel(raw: unknown): ModelPrice | undefined {
  const parsed = Entry.safeParse(raw);
  if (!parsed.success || typeof parsed.data.mode !== 'string' || !CHAT_MODES.has(parsed.data.mode)) return undefined;
  const entry = parsed.data;
  const standard = readTiered(entry, '');
  // A model listed at no cost is a preview or a placeholder, not a free model.
  if (!standard || (standard.input === 0 && standard.output === 0)) return undefined;
  const multiplier = ProviderEntry.safeParse(entry.provider_specific_entry);
  const fast = multiplier.success && multiplier.data.fast
    ? scaled(standard, multiplier.data.fast)
    : readTiered(entry, '_priority');
  return fast ? { ...standard, fast } : standard;
}

/**
 * The price a model is billed at under its own name: the entry listed under
 * exactly that name (`claude-opus-5-5`), else the price most other spellings
 * list it at (`moonshot/kimi-k3`, `fireworks_ai/kimi-k3`, ...). A tie stays unpriced.
 */
function consensus(own: ModelPrice | undefined, resold: ModelPrice[]): ModelPrice | undefined {
  if (own) return own;
  // Vote on the standard rates; the winners' most detailed entry keeps the tiers and fast rates some omit.
  const votes = new Map<string, ModelPrice[]>();
  for (const price of resold) {
    const key = JSON.stringify([price.input, price.output, price.cacheRead, price.cacheWrite]);
    votes.set(key, [...(votes.get(key) ?? []), price]);
  }
  const [first, second] = [...votes.values()].sort((a, b) => b.length - a.length);
  if (!first || (second && second.length === first.length)) return undefined;
  return first.toSorted((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
}

/** The catalog of every LiteLLM chat model with token prices, keyed by `canonicalModelName`. */
export function catalogFromLiteLlm(document: unknown, source: { revision: string; date: string }): PriceCatalog {
  const byName = new Map<string, { own?: ModelPrice; resold: ModelPrice[] }>();
  for (const [key, raw] of Object.entries(Entry.parse(document))) {
    const price = readModel(raw);
    if (!price) continue;
    const name = canonicalModelName(key);
    const group = byName.get(name) ?? { resold: [] };
    if (key.trim().toLowerCase() === name) group.own = price;
    else group.resold.push(price);
    byName.set(name, group);
  }
  const models: Record<string, ModelPrice> = {};
  for (const name of [...byName.keys()].sort()) {
    const group = byName.get(name);
    const price = group && consensus(group.own, group.resold);
    if (price) models[name] = price;
  }
  return {
    version: `litellm-${source.date}-${source.revision.slice(0, 7)}`,
    source: `https://github.com/BerriAI/litellm/blob/${source.revision}/${LITELLM_FILE}`,
    models,
  };
}

/** One model per line, so the weekly pull request reads as a per-model diff. */
export function formatCatalog(catalog: PriceCatalog): string {
  const lines = Object.entries(catalog.models).map(([name, price]) => `    ${JSON.stringify(name)}: ${JSON.stringify(price)}`);
  return `{\n  "version": ${JSON.stringify(catalog.version)},\n  "source": ${JSON.stringify(catalog.source)},\n  "models": {\n${lines.join(',\n')}\n  }\n}\n`;
}

const RATE_COLUMNS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/** A Markdown summary of what a catalog update changes, for the weekly pull request. */
export function describeCatalogChange(before: PriceCatalog, after: PriceCatalog): string {
  const rows: string[] = [];
  const counts = { added: 0, removed: 0, repriced: 0 };
  for (const name of [...new Set([...Object.keys(before.models), ...Object.keys(after.models)])].sort()) {
    const old = before.models[name];
    const now = after.models[name];
    if (old && now && JSON.stringify(old) === JSON.stringify(now)) continue;
    const change = !old ? 'added' : !now ? 'removed' : 'repriced';
    counts[change] += 1;
    const cells = RATE_COLUMNS.map((column) => {
      const from = old?.[column];
      const to = now?.[column];
      return from !== undefined && to !== undefined && from !== to ? `$${from} → $${to}` : `$${to ?? from}`;
    });
    rows.push(`| ${name} | ${change} | ${cells.join(' | ')} |`);
  }
  if (!rows.length) return `Model prices unchanged at ${after.version}.`;
  return [
    `Model prices from ${before.version} to ${after.version}: ${counts.added} added, ${counts.removed} removed, ${counts.repriced} repriced.`,
    '',
    '| Model | Change | Input | Output | Cache read | Cache write |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'USD per million tokens, standard rates. Costs teamai already recorded keep the prices they were recorded with.',
  ].join('\n');
}
