import path from 'node:path';
import { z } from 'zod';

import { emptyTokenUsage } from '../../types.js';
import type { TokenReading, TokenSource } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A token count as agy writes it: a string of digits on 1.4.8, a number elsewhere, null on a step without one. */
const Count = z.union([z.number(), z.string().transform(Number)]).pipe(z.number().finite().nonnegative()).catch(0).default(0);
const PlannerStep = z.object({
  type: z.literal('PLANNER_RESPONSE'),
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
});

/**
 * An Antigravity session's tokens from the PLANNER_RESPONSE steps of
 * `<store>/brain/<id>/.system_generated/logs/transcript.jsonl`, in the CLI's
 * store, else the app's. The transcript names no model, so it has tokens and
 * no requests. agy 1.4.8 counted cache reads inside `input_tokens`; agy 1.4.10
 * and the app do not, which shows as a step with fewer input tokens than cache
 * reads. A transcript with such a step is read as the newer kind.
 */
export async function readAgyTranscript(source: TokenSource): Promise<TokenReading> {
  const tokens = emptyTokenUsage();
  if (!SESSION_UUID_RE.test(source.sessionId)) return { tokens, requests: [] };
  const { sessionStoreDir } = await import('../../locate.js');
  const { agyStoreRoots } = await import('../../session-flow/adapters/agy.js');
  for (const store of agyStoreRoots(sessionStoreDir('agy', undefined))) {
    const steps: Array<z.infer<typeof PlannerStep>> = [];
    await forEachJsonLine(path.join(store, 'brain', source.sessionId, '.system_generated', 'logs', 'transcript.jsonl'), ['"PLANNER_RESPONSE"'], (entry) => {
      const step = PlannerStep.safeParse(entry);
      if (step.success) steps.push(step.data);
    });
    if (!steps.length) continue;
    const inclusive = steps.every((step) => step.input_tokens >= step.cache_read_tokens);
    for (const step of steps) {
      tokens.input += inclusive ? step.input_tokens - step.cache_read_tokens : step.input_tokens;
      tokens.output += step.output_tokens;
      tokens.cacheRead += step.cache_read_tokens;
    }
    return { tokens, scope: 'session', requests: [] };
  }
  return { tokens, requests: [] };
}
