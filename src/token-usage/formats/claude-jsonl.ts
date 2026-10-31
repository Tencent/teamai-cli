import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { emptyTokenUsage, type TokenUsage } from '../../types.js';
import type { TokenReading, TokenRequest, TokenSource } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

/** Claude Code writes this model for local placeholders that never reached the API. */
const SYNTHETIC_MODEL = '<synthetic>';

const Count = z.number().finite().nonnegative().catch(0).default(0);
const Usage = z.object({
  input_tokens: Count,
  output_tokens: Count,
  cache_read_input_tokens: Count,
  cache_creation_input_tokens: Count,
  speed: z.unknown().optional(),
  cache_creation: z.object({ ephemeral_1h_input_tokens: Count }).optional().catch(undefined),
  iterations: z.array(z.unknown()).catch([]).default([]),
});
const Advisor = Usage.extend({ type: z.literal('advisor_message'), model: z.string().min(1) });
const AssistantLine = z.object({
  type: z.literal('assistant'),
  requestId: z.string().optional().catch(undefined),
  timestamp: z.string().catch('').default(''),
  costUSD: z.number().finite().nonnegative().optional().catch(undefined),
  message: z.object({
    id: z.string().optional().catch(undefined),
    model: z.string().optional().catch(undefined),
    usage: Usage,
  }),
});

function tokensOf(usage: z.infer<typeof Usage>): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
  };
}

/**
 * Claude Code's JSONL transcript (and Qoder's, CodeBuddy CLI's and other
 * Claude-format tools'): one request per assistant message. Every content
 * block of a message repeats the same `usage`, so a message counts once, by
 * `message.id`, else `requestId`. An advisor call (`usage.iterations`) runs on
 * another model and is its own request. Subagents write their own transcripts
 * under `<session>/subagents/`, which count toward the session.
 */
export async function readClaudeJsonl(source: TokenSource): Promise<TokenReading> {
  const tokens = emptyTokenUsage();
  const requests: TokenRequest[] = [];
  const counted = new Set<string>();
  const add = (request: Omit<TokenRequest, 'model'> & { model?: string }) => {
    tokens.input += request.tokens.input;
    tokens.output += request.tokens.output;
    tokens.cacheRead += request.tokens.cacheRead;
    tokens.cacheCreation += request.tokens.cacheCreation;
    if (request.model && request.model !== SYNTHETIC_MODEL) requests.push({ ...request, model: request.model });
  };
  if (!source.transcriptPath) return { tokens, requests };
  const visit = (entry: unknown) => {
    const line = AssistantLine.safeParse(entry);
    if (!line.success) return;
    const { message, requestId, timestamp, costUSD } = line.data;
    const key = message.id ?? requestId;
    if (!key || counted.has(key)) return;
    counted.add(key);
    const speed = message.usage.speed === 'fast' ? 'fast' : 'standard';
    const hour = message.usage.cache_creation?.ephemeral_1h_input_tokens;
    add({
      key, timestamp, model: message.model, tokens: tokensOf(message.usage), speed,
      ...(hour ? { cacheCreation1h: hour } : {}),
      ...(costUSD === undefined ? {} : { reportedCostMicros: Math.round(costUSD * 1_000_000) }),
    });
    message.usage.iterations.forEach((iteration, index) => {
      const advisor = Advisor.safeParse(iteration);
      if (advisor.success) add({ key: `${key}:advisor:${index}`, timestamp, model: advisor.data.model, tokens: tokensOf(advisor.data), speed });
    });
  };
  await forEachJsonLine(source.transcriptPath, ['"assistant"'], visit);
  const subagents = path.join(source.transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  const files = await fs.promises.readdir(subagents).catch(() => []);
  for (const file of files.filter((name) => name.endsWith('.jsonl')).sort()) {
    await forEachJsonLine(path.join(subagents, file), ['"assistant"'], visit);
  }
  return { tokens, requests };
}
