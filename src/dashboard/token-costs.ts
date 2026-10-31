import { REQUEST_LOG_RETENTION_DAYS, type LocalRequestRecord } from '../dashboard-collector.js';
import { PRICE_CATALOG_VERSION } from '../token-usage/pricing.js';
import { emptyTokenUsage, totalTokens, type TokenUsage } from '../types.js';

const DAY_MS = 86_400_000;
const TOP_SESSIONS = 10;

type Usage = { requests: number; pricedRequests: number; costMicros: number; tokens: TokenUsage };

/** What `/api/tokens` answers: the cost and tokens of the member's requests over a window of days. */
export type TokenCostSummary = {
  days: number;
  /** First and last day of the window, UTC. */
  from: string;
  to: string;
  /** The price catalog new requests are priced with. */
  catalogVersion: string;
  totals: Usage & { reportedCostMicros: number; cacheSavingsMicros: number };
  /** The window of the same length before this one; null when the request log does not keep it. */
  previous: { requests: number; costMicros: number } | null;
  daily: Array<{ date: string; requests: number; costMicros: number; tokens: number }>;
  byTool: Array<Usage & { tool: string }>;
  /** A model with no priced request is one no price list knows: tokens only. */
  byModel: Array<Usage & { model: string; tools: string[] }>;
  topSessions: Array<Usage & { sessionId: string; tool: string; lastAt: string }>;
};

const emptyUsage = (): Usage => ({ requests: 0, pricedRequests: 0, costMicros: 0, tokens: emptyTokenUsage() });

function add(usage: Usage, record: LocalRequestRecord): void {
  usage.requests += 1;
  if (record.costMicros !== null) {
    usage.pricedRequests += 1;
    usage.costMicros += record.costMicros;
  }
  usage.tokens.input += record.inputTokens;
  usage.tokens.output += record.outputTokens;
  usage.tokens.cacheRead += record.cacheReadTokens;
  usage.tokens.cacheCreation += record.cacheCreationTokens;
}

const byCost = (a: Usage, b: Usage) => b.costMicros - a.costMicros || totalTokens(b.tokens) - totalTokens(a.tokens);

function group<T extends Usage>(map: Map<string, T>, key: string, create: () => T): T {
  const found = map.get(key);
  if (found) return found;
  const created = create();
  map.set(key, created);
  return created;
}

/**
 * Sum `records` over the `days` UTC days ending today: totals, a point per
 * day, and rankings by tool, model and session. `scope` keeps a workspace's
 * requests only: those its data home recorded, and, for a request recorded
 * before requests named their data home, those of its `sessionIds`.
 */
export function summarizeTokenCosts(
  records: readonly LocalRequestRecord[],
  options: { days: number; now: Date; scope?: { dataHomeKey?: string; sessionIds: ReadonlySet<string> } },
): TokenCostSummary {
  const today = Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), options.now.getUTCDate());
  const start = today - (options.days - 1) * DAY_MS;
  const previousStart = start - options.days * DAY_MS;
  const end = today + DAY_MS;
  const dates = Array.from({ length: options.days }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));

  const totals = { ...emptyUsage(), reportedCostMicros: 0, cacheSavingsMicros: 0 };
  const previous = { requests: 0, costMicros: 0 };
  const daily = new Map(dates.map((date) => [date, emptyUsage()]));
  const tools = new Map<string, Usage & { tool: string }>();
  const models = new Map<string, Usage & { model: string; tools: string[] }>();
  const sessions = new Map<string, Usage & { sessionId: string; tool: string; lastAt: string }>();

  for (const record of records) {
    const { scope } = options;
    if (scope && !(scope.dataHomeKey && record.dataHomeKey
      ? record.dataHomeKey === scope.dataHomeKey
      : record.sessionId !== undefined && scope.sessionIds.has(record.sessionId))) continue;
    const at = Date.parse(record.timestamp);
    if (at >= previousStart && at < start) {
      previous.requests += 1;
      previous.costMicros += record.costMicros ?? 0;
      continue;
    }
    if (at < start || at >= end) continue;
    const tool = record.tool ?? 'unknown';
    add(totals, record);
    if (record.costMicros !== null && record.costSource === 'reported') totals.reportedCostMicros += record.costMicros;
    if (record.costMicros !== null) totals.cacheSavingsMicros += record.cacheSavingsMicros ?? 0;
    const day = daily.get(record.timestamp.slice(0, 10));
    if (day) add(day, record);
    add(group(tools, tool, () => ({ ...emptyUsage(), tool })), record);
    const model = group(models, record.model, () => ({ ...emptyUsage(), model: record.model, tools: [] }));
    add(model, record);
    if (!model.tools.includes(tool)) model.tools.push(tool);
    const { sessionId } = record;
    if (sessionId) {
      const session = group(sessions, sessionId, () => ({ ...emptyUsage(), sessionId, tool, lastAt: record.timestamp }));
      add(session, record);
      if (at > Date.parse(session.lastAt)) session.lastAt = record.timestamp;
    }
  }

  return {
    days: options.days,
    from: dates[0] ?? '',
    to: dates.at(-1) ?? '',
    catalogVersion: PRICE_CATALOG_VERSION,
    totals,
    previous: options.days * 2 <= REQUEST_LOG_RETENTION_DAYS ? previous : null,
    daily: dates.map((date) => {
      const day = daily.get(date) ?? emptyUsage();
      return { date, requests: day.requests, costMicros: day.costMicros, tokens: totalTokens(day.tokens) };
    }),
    byTool: [...tools.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
    topSessions: [...sessions.values()].sort(byCost).slice(0, TOP_SESSIONS),
  };
}
