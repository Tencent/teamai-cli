import fs from 'node:fs';
import { z } from 'zod';

import { emptyTokenUsage, type TokenSnapshotScope, type TokenUsage } from '../../types.js';
import type { TokenReading, TokenRequest, TokenSource, TokenSpeed } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

const Count = z.number().finite().nonnegative().catch(0).default(0);
/** Codex's usage counters: `input_tokens` includes both cache buckets, `output_tokens` includes reasoning. */
const Usage = z.object({
  input_tokens: Count,
  cached_input_tokens: Count,
  cache_write_input_tokens: Count,
  output_tokens: Count,
});
type Usage = z.infer<typeof Usage>;
const Line = z.object({ type: z.string(), timestamp: z.string().catch('').default(''), payload: z.record(z.string(), z.unknown()).catch({}) });

function tokensOf(usage: Usage): TokenUsage {
  return {
    input: Math.max(0, usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens),
    output: usage.output_tokens,
    cacheRead: usage.cached_input_tokens,
    cacheCreation: usage.cache_write_input_tokens,
  };
}

const parseUsage = (value: unknown): Usage | undefined => {
  const usage = Usage.safeParse(value);
  return usage.success ? usage.data : undefined;
};

/** `fast` and `priority` bill at the priority rates; `default`, `flex` and no tier at standard ones. */
const speedOf = (tier: unknown): TokenSpeed => (tier === 'priority' || tier === 'fast' ? 'fast' : 'standard');

type Snapshot = { tokens: TokenUsage; scope: TokenSnapshotScope };

/**
 * The rollout's latest cumulative counters: Codex's session-wide
 * `token_usage_record.thread_token_usage` when present, else the legacy
 * per-file `token_count.total_token_usage`.
 */
function snapshotOf(type: string, payload: Record<string, unknown>): Snapshot | undefined {
  if (type === 'token_usage_record') {
    const usage = parseUsage(payload.thread_token_usage);
    return usage && { tokens: tokensOf(usage), scope: 'session' };
  }
  if (type === 'event_msg' && payload.type === 'token_count') {
    const info = z.object({ total_token_usage: z.unknown() }).safeParse(payload.info);
    const usage = info.success ? parseUsage(info.data.total_token_usage) : undefined;
    return usage && { tokens: tokensOf(usage), scope: 'transcript' };
  }
  return undefined;
}

async function readOnce(file: string): Promise<{ reading: TokenReading; snapshot?: Snapshot }> {
  let thread: string | undefined;
  let model = '';
  let speed: TokenSpeed = 'standard';
  let session: Snapshot | undefined;
  let transcript: Snapshot | undefined;
  const responses: TokenRequest[] = [];
  const counted: TokenRequest[] = [];
  let lastTotal = '';
  await forEachJsonLine(file, ['"session_meta"', '"turn_context"', '"thread_settings_applied"', '"token_usage_record"', '"token_count"'], (entry) => {
    const line = Line.safeParse(entry);
    if (!line.success) return;
    const { type, timestamp, payload } = line.data;
    // The first meta names this rollout's thread; a fork copies its parent's after it.
    if (type === 'session_meta') thread ??= typeof payload.id === 'string' ? payload.id : '';
    else if (type === 'turn_context' && typeof payload.model === 'string') model = payload.model;
    else if (payload.type === 'thread_settings_applied') speed = speedOf(z.object({ service_tier: z.unknown() }).catch({ service_tier: undefined }).parse(payload.thread_settings).service_tier);
    const snapshot = snapshotOf(type, payload);
    if (snapshot?.scope === 'session') session = snapshot;
    else if (snapshot) transcript = snapshot;
    if (!model) return;
    if (type === 'token_usage_record') {
      // Codex 0.153 and later: one record per model response, its id the key.
      const usage = parseUsage(payload.usage);
      const own = !thread || payload.thread_id === undefined || payload.thread_id === thread;
      if (usage && own && typeof payload.response_id === 'string' && usage.input_tokens + usage.output_tokens > 0) {
        responses.push({ key: payload.response_id, timestamp, model, tokens: tokensOf(usage), speed });
      }
    } else if (snapshot?.scope === 'transcript') {
      // Older rollouts: a token count per response, re-emitted unchanged when only rate limits update.
      const info = z.object({ last_token_usage: z.unknown(), total_token_usage: z.unknown() }).safeParse(payload.info);
      const last = info.success ? parseUsage(info.data.last_token_usage) : undefined;
      const total = info.success ? JSON.stringify(info.data.total_token_usage) : '';
      if (!last || total === lastTotal || last.input_tokens + last.output_tokens === 0) return;
      lastTotal = total;
      counted.push({ key: `token_count:${total}`, timestamp, model, tokens: tokensOf(last), speed });
    }
  });
  const snapshot = session ?? transcript;
  return {
    reading: {
      tokens: snapshot?.tokens ?? emptyTokenUsage(),
      ...(snapshot ? { scope: snapshot.scope } : {}),
      requests: responses.length ? responses : counted,
    },
    snapshot,
  };
}

const FLUSH_ATTEMPTS = 7;
const FLUSH_RETRY_MS = 250;
const TAIL_BYTES = 256 * 1024;

/** The latest cumulative counters in the file's tail, without reading the whole rollout again. */
async function tailSnapshot(file: string): Promise<string> {
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      let latest: Snapshot | undefined;
      for (const text of buffer.toString('utf-8').split('\n')) {
        if (!text.includes('"token_usage_record"') && !text.includes('"token_count"')) continue;
        try {
          const line = Line.safeParse(JSON.parse(text));
          const snapshot = line.success ? snapshotOf(line.data.type, line.data.payload) : undefined;
          if (snapshot && (snapshot.scope === 'session' || latest?.scope !== 'session')) latest = snapshot;
        } catch {
          // The last line can still be mid-write.
        }
      }
      return JSON.stringify(latest ?? null);
    } finally {
      await handle.close();
    }
  } catch {
    return 'null';
  }
}

/**
 * A Codex rollout (`~/.codex/sessions/**\/rollout-*.jsonl`, and JoyCode's):
 * one request per `token_usage_record` (Codex 0.153+), else per changed
 * `token_count`, on the model of the latest `turn_context`. Codex can write
 * the turn's usage just after its Stop hook fires, so an unsettled read waits
 * up to 1.75 s for the cumulative counters to change.
 */
export async function readCodexRollout(source: TokenSource): Promise<TokenReading> {
  if (!source.transcriptPath) return { tokens: emptyTokenUsage(), requests: [] };
  const first = await readOnce(source.transcriptPath);
  if (source.settled) return first.reading;
  const before = JSON.stringify(first.snapshot ?? null);
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, FLUSH_RETRY_MS));
    const now = await tailSnapshot(source.transcriptPath);
    if (now !== before && now !== 'null') return (await readOnce(source.transcriptPath)).reading;
  }
  return first.reading;
}
