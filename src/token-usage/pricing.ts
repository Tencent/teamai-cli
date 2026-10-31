import type { TokenUsage } from '../types.js';
import { canonicalModelName } from './model-name.js';
import catalogJson from './model-prices.json';

/** Rates in USD per million tokens, so tokens × rate is micro-dollars. */
export type TokenRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** Rates that rise once a request's prompt (input, cache reads and writes) is over `tokens`. */
export type TieredRates = TokenRates & { above?: Array<TokenRates & { tokens: number }> };

/** A model's standard rates, and its fast-mode (priority) rates when the provider sells them. */
export type ModelPrice = TieredRates & { fast?: TieredRates };

export type PriceCatalog = { version: string; source: string; models: Record<string, ModelPrice> };

const CATALOG: PriceCatalog = catalogJson;

/** The LiteLLM revision the bundled catalog was built from, stored with each cost so a later price change never rewrites it. */
export const PRICE_CATALOG_VERSION = CATALOG.version;

/** Fast mode (Claude's `speed: "fast"`, Codex's priority tier) bills at the model's fast rates. */
export type TokenSpeed = 'standard' | 'fast';

export type PricedTokens = {
  costMicros: number;
  /** `reported`: the tool recorded what the request cost. `catalog`: estimated from the bundled price list. */
  source: 'reported' | 'catalog';
  priceVersion: string;
};

function ratesFor(price: ModelPrice, speed: TokenSpeed, promptTokens: number): TokenRates {
  const tiered = (speed === 'fast' && price.fast) || price;
  return tiered.above?.findLast((tier) => promptTokens > tier.tokens) ?? tiered;
}

/**
 * What one request cost, in micro-dollars: the cost the tool reported, else
 * the bundled catalog's API list price for its model, its fast and
 * long-prompt rates included. `aliases` maps a gateway's model name to the
 * model it serves. Null when neither is known. Subscription and enterprise
 * discounts are not applied.
 */
export function priceTokens(
  request: { model: string; tokens: TokenUsage; speed?: TokenSpeed; reportedCostMicros?: number },
  aliases?: Record<string, string>,
): PricedTokens | null {
  if (request.reportedCostMicros !== undefined) {
    return { costMicros: Math.round(request.reportedCostMicros), source: 'reported', priceVersion: 'reported' };
  }
  const model = aliases?.[request.model] ?? request.model;
  const price = CATALOG.models[model.trim().toLowerCase()] ?? CATALOG.models[canonicalModelName(model)];
  if (!price) return null;
  const { input, output, cacheRead, cacheCreation } = request.tokens;
  const rates = ratesFor(price, request.speed ?? 'standard', input + cacheRead + cacheCreation);
  return {
    costMicros: Math.round(input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheCreation * rates.cacheWrite),
    source: 'catalog',
    priceVersion: PRICE_CATALOG_VERSION,
  };
}
