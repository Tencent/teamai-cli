import { z } from 'zod';

import type { TokenUsage } from '../../types.js';
import type { TokenRequest } from '../index.js';

const Count = z.number().finite().nonnegative().optional().catch(undefined);
const Bucket = z.object({ tokenCount: Count }).optional().catch(undefined);
/** Copilot's per-bucket counts; `input` excludes the cached part. */
const TokenDetails = z.object({ input: Bucket, output: Bucket, cache_read: Bucket, cache_write: Bucket }).optional().catch(undefined);
/** `inputTokens` includes the cached part. */
const ModelUsage = z.object({ inputTokens: Count, outputTokens: Count, cacheReadTokens: Count, cacheWriteTokens: Count }).optional().catch(undefined);
const Shutdown = z.object({
  type: z.literal('session.shutdown'),
  id: z.string().catch(''),
  timestamp: z.string().catch(''),
  data: z.object({
    tokenDetails: TokenDetails,
    modelMetrics: z.record(z.string(), z.object({ usage: ModelUsage, tokenDetails: TokenDetails }).catch({ usage: undefined, tokenDetails: undefined })).optional().catch(undefined),
  }).catch({ tokenDetails: undefined, modelMetrics: undefined }),
});

function fromDetails(details: z.infer<typeof TokenDetails>): TokenUsage | undefined {
  if (!details) return undefined;
  const counts = [details.input, details.output, details.cache_read, details.cache_write].map((bucket) => bucket?.tokenCount);
  if (counts.every((count) => count === undefined)) return undefined;
  const [input = 0, output = 0, cacheRead = 0, cacheCreation = 0] = counts;
  return { input, output, cacheRead, cacheCreation };
}

function fromUsage(usage: z.infer<typeof ModelUsage>): TokenUsage | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheCreation = usage.cacheWriteTokens ?? 0;
  const input = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheCreation);
  return { input, output: usage.outputTokens ?? 0, cacheRead, cacheCreation };
}

/**
 * The totals of a Copilot `session.shutdown` record, and one request per model
 * from its `modelMetrics` that sums that model's calls. Copilot writes it when a run ends, so finding the
 * record of a run stays with the dashboard collector. Undefined for any other
 * record; `tokens` is absent from a shutdown without counters.
 */
export function readCopilotShutdown(record: unknown): { tokens?: TokenUsage; requests: TokenRequest[] } | undefined {
  const shutdown = Shutdown.safeParse(record);
  if (!shutdown.success) return undefined;
  const { id, timestamp, data } = shutdown.data;
  const requests: TokenRequest[] = Object.entries(data.modelMetrics ?? {}).flatMap(([model, metrics]) => {
    const tokens = fromDetails(metrics.tokenDetails) ?? fromUsage(metrics.usage);
    return tokens ? [{ key: `${id}:${model}`, timestamp, model, speed: 'standard' as const, tokens, combinesCalls: true as const }] : [];
  });
  const tokens = fromDetails(data.tokenDetails);
  return tokens ? { tokens, requests } : { requests };
}
