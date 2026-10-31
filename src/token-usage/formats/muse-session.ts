import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { emptyTokenUsage, type TokenUsage } from '../../types.js';
import { pathExists } from '../../utils/fs.js';
import { getUserHome } from '../../utils/home.js';
import type { TokenReading, TokenRequest, TokenSource } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Muse Code's log of `sessionId`, `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`
 * (`~/.local/share` when unset; muse 1.4.6 honors XDG_DATA_HOME, #1138), found by its id
 * alone: Muse's hooks send `transcript_path: null`. The variable is read live: the reader
 * is muse's own stop hook, which inherits muse's environment.
 */
async function findSessionLog(sessionId: string): Promise<string | null> {
  if (!SESSION_UUID_RE.test(sessionId)) return null;
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(getUserHome(), '.local', 'share');
  const subdirs = async (dir: string) => (await fs.promises.readdir(dir).catch(() => [] as string[]))
    .filter((name) => /^\d+$/.test(name)).sort().toReversed().map((name) => path.join(dir, name));
  for (const year of await subdirs(path.join(dataHome, 'muse', 'sessions'))) {
    for (const month of await subdirs(year)) {
      for (const day of await subdirs(month)) {
        const file = path.join(day, sessionId, 'session.jsonl');
        if (await pathExists(file)) return file;
      }
    }
  }
  return null;
}

const Count = z.number().finite().nonnegative().catch(0).default(0);
/** Muse counts the cached part inside `input_tokens`, as Codex does. */
const Call = z.object({
  id: z.string().min(1),
  recorded_at: z.number().finite().nonnegative(),
  payload: z.object({
    source_run_record_id: z.string().min(1).optional().catch(undefined),
    event: z.object({
      kind: z.enum(['model_completed', 'automated_review_completed']),
      model: z.union([z.string().min(1), z.object({ model_id: z.string().min(1) }).transform((model) => model.model_id)]),
      usage: z.object({
        input_tokens: Count,
        output_tokens: Count,
        cached_tokens: Count,
        cached_input_tokens: Count,
        cache_read_tokens: Count,
        cache_write_tokens: Count,
      }),
    }),
  }),
});
/** The session rollup older logs hold, without a model. */
const Rollup = z.object({
  payload: z.object({
    event: z.object({
      kind: z.literal('goal_usage_attribution'),
      record: z.object({ quantity: z.object({ unit: z.literal('tokens'), input_tokens: Count, output_tokens: Count, cached_tokens: Count }) }),
    }),
  }),
});

const add = (sum: TokenUsage, used: TokenUsage) => {
  sum.input += used.input;
  sum.output += used.output;
  sum.cacheRead += used.cacheRead;
  sum.cacheCreation += used.cacheCreation;
};

/**
 * Muse Code's session log: one request per `model_completed` or
 * `automated_review_completed` event, with its model. A log with none of
 * those (Muse 1.4.6) totals its `goal_usage_attribution` rollups instead,
 * with no model. Subagent logs (`subagent/<id>/`) are not read, as Claude's
 * sidechains were not before.
 */
export async function readMuseSession(source: TokenSource): Promise<TokenReading> {
  const file = await findSessionLog(source.sessionId);
  if (!file) return { tokens: emptyTokenUsage(), requests: [] };
  const requests: TokenRequest[] = [];
  const counted = new Set<string>();
  const rollup = emptyTokenUsage();
  await forEachJsonLine(file, ['"model_completed"', '"automated_review_completed"', '"goal_usage_attribution"'], (entry) => {
    const call = Call.safeParse(entry);
    if (call.success) {
      const { usage, model } = call.data.payload.event;
      const key = call.data.payload.source_run_record_id ?? call.data.id;
      const input = usage.input_tokens;
      const cacheRead = Math.min(input, usage.cache_read_tokens || usage.cached_input_tokens || usage.cached_tokens);
      const cacheCreation = Math.min(input - cacheRead, usage.cache_write_tokens);
      const tokens = { input: input - cacheRead - cacheCreation, output: usage.output_tokens, cacheRead, cacheCreation };
      if (counted.has(key) || input + usage.output_tokens === 0) return;
      counted.add(key);
      requests.push({ key, timestamp: new Date(Math.trunc(call.data.recorded_at / 1000)).toISOString(), model, tokens, speed: 'standard' });
      return;
    }
    const total = Rollup.safeParse(entry);
    if (!total.success) return;
    const { input_tokens: input, output_tokens: output, cached_tokens: cached } = total.data.payload.event.record.quantity;
    const cacheRead = Math.min(input, cached);
    add(rollup, { input: input - cacheRead, output, cacheRead, cacheCreation: 0 });
  });
  const tokens = emptyTokenUsage();
  for (const request of requests) add(tokens, request.tokens);
  return { tokens: requests.length ? tokens : rollup, scope: 'session', requests };
}
