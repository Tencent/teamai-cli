import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { log } from '../../utils/logger.js';
import { addTokenUsage, emptyTokenUsage, INTERVENTION_SCAN_MAX_BYTES, type TokenUsage } from '../../types.js';
import type { TokenReading, TokenRequest, TokenSource } from '../index.js';
import { forEachJsonLine } from './jsonl.js';

const Count = z.number().finite().nonnegative();
const Fields = z.record(z.string(), z.unknown());

/** The first positive count among `names`, looked up in `usage` and its OpenAI-style detail lists. */
function firstCount(usage: Record<string, unknown>, names: readonly string[]): number {
  for (const name of names) {
    const [field, nested] = name.split('.');
    const value = nested
      ? [usage[field]].flat().map((detail) => Fields.safeParse(detail)).find((detail) => detail.success && Count.safeParse(detail.data[nested]).success)
      : undefined;
    const count = Count.safeParse(nested ? (value?.success ? value.data[nested] : undefined) : usage[field]);
    if (count.success && count.data > 0) return count.data;
  }
  return 0;
}

const CACHE_READ = ['cache_read_input_tokens', 'cacheReadInputTokens', 'inputTokensDetails.cached_tokens', 'prompt_tokens_details.cached_tokens', 'prompt_cache_hit_tokens'];
const CACHE_WRITE = ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'prompt_cache_write_tokens'];

/** CodeBuddy's counters, raw first as its own usage helpers read them; input includes both cache buckets. */
function tokensOf(raw: Record<string, unknown>, usage: Record<string, unknown>): TokenUsage {
  const source = Object.keys(raw).length ? raw : usage;
  const input = firstCount(raw, ['prompt_tokens']) || firstCount(usage, ['inputTokens']);
  const output = firstCount(raw, ['completion_tokens']) || firstCount(usage, ['outputTokens']);
  const cacheRead = firstCount(source, CACHE_READ) || firstCount(usage, CACHE_READ);
  const cacheCreation = firstCount(source, CACHE_WRITE) || firstCount(usage, CACHE_WRITE);
  return { input: Math.max(0, input - cacheRead - cacheCreation), output, cacheRead, cacheCreation };
}

const Item = z.object({
  timestamp: z.number().finite().optional().catch(undefined),
  providerData: z.object({
    messageId: z.string().min(1),
    model: z.string().optional().catch(undefined),
    requestModelId: z.string().optional().catch(undefined),
    rawUsage: Fields.optional().catch(undefined),
    usage: Fields.optional().catch(undefined),
  }),
});

const iso = (ms: number | undefined) => (ms === undefined ? '' : new Date(ms).toISOString());

/**
 * CodeBuddy CLI's and WorkBuddy's JSONL (`~/.codebuddy/projects/<cwd>/<id>.jsonl`):
 * OpenAI-agents items whose `providerData` carries each request's usage. A
 * `model-usage` item repeats a message's usage, so a request counts once by
 * `messageId`. Subagent transcripts under `<id>/subagents/` count too.
 */
async function readCliJsonl(file: string): Promise<TokenReading> {
  let tokens = emptyTokenUsage();
  const requests: TokenRequest[] = [];
  const counted = new Set<string>();
  const visit = (entry: unknown) => {
    const item = Item.safeParse(entry);
    if (!item.success) return;
    const data = item.data.providerData;
    if ((!data.rawUsage && !data.usage) || counted.has(data.messageId)) return;
    counted.add(data.messageId);
    const used = tokensOf(data.rawUsage ?? {}, data.usage ?? {});
    tokens = addTokenUsage(tokens, used);
    const model = data.requestModelId ?? data.model;
    if (model) requests.push({ key: data.messageId, timestamp: iso(item.data.timestamp), model, tokens: used, speed: 'standard' });
  };
  await forEachJsonLine(file, ['"providerData"'], visit);
  const subagents = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  for (const name of (await fs.promises.readdir(subagents).catch(() => [])).filter((entry) => entry.endsWith('.jsonl')).sort()) {
    await forEachJsonLine(path.join(subagents, name), ['"providerData"'], visit);
  }
  return { tokens, requests };
}

const IndexDocument = z.object({
  requests: z.array(z.object({
    id: z.string().optional().catch(undefined),
    startedAt: z.number().finite().optional().catch(undefined),
    messages: z.array(z.string()).catch([]).default([]),
    usage: z.object({ inputTokens: Count.catch(0).default(0), outputTokens: Count.catch(0).default(0) }).optional().catch(undefined),
  }).catch({ messages: [] })),
});
const MessageBlob = z.object({ extra: z.string() });
const Extra = z.object({ modelId: z.string().optional(), modelName: z.string().optional() });

/** The model a CodeBuddy IDE message ran on, from its blob's stringified `extra`. */
async function blobModel(conversation: string, messageId: string): Promise<string | undefined> {
  if (!/^[\w.-]+$/.test(messageId)) return undefined;
  try {
    const blob = MessageBlob.parse(JSON.parse(await fs.promises.readFile(path.join(conversation, 'messages', `${messageId}.json`), 'utf-8')));
    const extra = Extra.parse(JSON.parse(blob.extra));
    return (extra.modelName ?? extra.modelId)?.replace(/^custom-local:/, '');
  } catch {
    return undefined;
  }
}

/**
 * CodeBuddy IDE's `index.json`: `requests[].usage` holds input and output
 * only, with no cache split. A request's model is in the `extra` of the
 * message blobs it lists.
 */
async function readIdeIndex(file: string): Promise<TokenReading | undefined> {
  try {
    const { size } = await fs.promises.stat(file);
    if (size === 0 || size > INTERVENTION_SCAN_MAX_BYTES) return undefined;
    const document = IndexDocument.parse(JSON.parse(await fs.promises.readFile(file, 'utf-8')));
    let tokens = emptyTokenUsage();
    const requests: TokenRequest[] = [];
    for (const [index, request] of document.requests.entries()) {
      const used = { input: request.usage?.inputTokens ?? 0, output: request.usage?.outputTokens ?? 0, cacheRead: 0, cacheCreation: 0 };
      if (used.input + used.output === 0) continue;
      tokens = addTokenUsage(tokens, used);
      let model: string | undefined;
      for (const id of request.messages.toReversed()) {
        model = await blobModel(path.dirname(file), id);
        if (model) break;
      }
      if (model) requests.push({ key: request.id ?? `request:${index}`, timestamp: iso(request.startedAt), model, tokens: used, speed: 'standard' });
    }
    return { tokens, requests };
  } catch (e) {
    log.debug(`token-usage: could not read the CodeBuddy index ${file}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

const FLUSH_ATTEMPTS = 8;
const FLUSH_RETRY_MS = 250;

/**
 * CodeBuddy and WorkBuddy: the CLI's JSONL, or the IDE's `index.json`, by the
 * transcript the Stop hook names. The IDE writes a request's usage just after
 * Stop, so an unsettled read retries until usage appears.
 */
export async function readCodebuddy(source: TokenSource): Promise<TokenReading> {
  const file = source.transcriptPath;
  if (!file) return { tokens: emptyTokenUsage(), requests: [] };
  if (path.basename(file) !== 'index.json') return readCliJsonl(file);
  for (let attempt = 0; ; attempt++) {
    const reading = await readIdeIndex(file);
    if ((reading && reading.tokens.input + reading.tokens.output > 0) || source.settled || attempt === FLUSH_ATTEMPTS - 1) {
      return reading ?? { tokens: emptyTokenUsage(), requests: [] };
    }
    await new Promise((resolve) => setTimeout(resolve, FLUSH_RETRY_MS));
  }
}
