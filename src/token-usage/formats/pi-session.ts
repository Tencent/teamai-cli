import { z } from 'zod';

import { addTokenUsage, emptyTokenUsage, type TokenUsage } from '../../types.js';
import type { TokenReading, TokenRequest, TokenSource } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

const Count = z.number().finite().nonnegative().catch(0).default(0);
/** Pi counts cache reads and writes apart from `input`, as Anthropic does. */
const Usage = z.object({
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  cost: z.object({ total: z.number().finite().nonnegative() }).optional().catch(undefined),
});
const Model = z.string().min(1).optional().catch(undefined);
/** An assistant message (Pi and Oh My Pi), or a call Oh My Pi made beside the conversation (`model_usage`). */
const Entry = z.union([
  z.object({
    type: z.literal('message'),
    id: z.string().min(1),
    timestamp: z.string().catch(''),
    message: z.object({ role: z.literal('assistant'), model: Model, responseModel: Model, usage: Usage }),
  }).transform(({ id, timestamp, message }) => ({ id, timestamp, model: message.responseModel ?? message.model, usage: message.usage })),
  z.object({ type: z.literal('model_usage'), id: z.string().min(1), timestamp: z.string().catch(''), model: Model, usage: Usage }),
  // A compaction or branch summary has usage but no model.
  z.object({ type: z.string(), usage: Usage }).transform(({ usage }) => ({ id: undefined, timestamp: '', model: undefined, usage })),
]);

/**
 * Pi's and Oh My Pi's session file: one request per assistant message and
 * per `model_usage` entry. The cost Pi reports is kept when it is above zero;
 * Pi writes 0 for a model it has no price for.
 */
export async function readPiSession(source: TokenSource): Promise<TokenReading> {
  let tokens: TokenUsage = emptyTokenUsage();
  const requests: TokenRequest[] = [];
  if (!source.transcriptPath) return { tokens, requests };
  const counted = new Set<string>();
  await forEachJsonLine(source.transcriptPath, ['"usage"'], (raw) => {
    const entry = Entry.safeParse(raw);
    if (!entry.success) return;
    const { id, timestamp, model, usage } = entry.data;
    const key = id && `${id}:${timestamp}`;
    if (key && counted.has(key)) return;
    if (key) counted.add(key);
    const used = { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheCreation: usage.cacheWrite };
    tokens = addTokenUsage(tokens, used);
    if (!key || !model) return;
    const cost = usage.cost?.total;
    requests.push({
      key, timestamp, model, tokens: used, speed: 'standard',
      reportedCostMicros: cost ? Math.round(cost * 1_000_000) : undefined,
    });
  });
  return { tokens, requests };
}
