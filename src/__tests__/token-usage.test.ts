import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTokenUsage } from '../token-usage/index.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-token-usage-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(lines: unknown[], name = 'session.jsonl'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

// A Claude Code assistant line, trimmed to the fields teamai reads.
function claudeTurn(id: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    type: 'assistant', requestId: `req_${id}`, timestamp: '2026-10-30T09:15:02.118Z', sessionId: 's-1',
    message: { id: `msg_${id}`, model, usage, content: [{ type: 'text', text: '…' }] }, ...extra,
  };
}

describe('readTokenUsage: claude-jsonl', () => {
  it('reads each request once, with its model, from a Claude Code transcript', async () => {
    const usage = { input_tokens: 12, output_tokens: 840, cache_read_input_tokens: 48_210, cache_creation_input_tokens: 1_930 };
    const file = transcript([
      { type: 'user', message: { content: 'fix the flaky retry test' } },
      claudeTurn('a', 'claude-opus-5-5', usage),
      // Claude Code repeats the turn's usage on each content block.
      claudeTurn('a', 'claude-opus-5-5', usage),
      claudeTurn('b', 'claude-haiku-5-5', { input_tokens: 3, output_tokens: 60 }),
    ]);

    const reading = await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' });

    expect(reading.tokens).toEqual({ input: 15, output: 900, cacheRead: 48_210, cacheCreation: 1_930 });
    expect(reading.requests.map(({ model, tokens, speed }) => ({ model, tokens, speed }))).toEqual([
      { model: 'claude-opus-5-5', tokens: { input: 12, output: 840, cacheRead: 48_210, cacheCreation: 1_930 }, speed: 'standard' },
      { model: 'claude-haiku-5-5', tokens: { input: 3, output: 60, cacheRead: 0, cacheCreation: 0 }, speed: 'standard' },
    ]);
    expect(reading.requests[0].timestamp).toBe('2026-10-30T09:15:02.118Z');
    expect(new Set(reading.requests.map((request) => request.key)).size).toBe(2);
  });

  it('records fast mode and the cost Claude Code reported', async () => {
    const file = transcript([
      claudeTurn('a', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 100, speed: 'fast' }, { costUSD: 0.00408 }),
    ]);
    const [request] = (await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' })).requests;
    expect(request.speed).toBe('fast');
    expect(request.reportedCostMicros).toBe(4_080);
  });

  it('counts an advisor call as its own request on its own model', async () => {
    const file = transcript([
      claudeTurn('a', 'claude-sonnet-5-5', {
        input_tokens: 100, output_tokens: 50,
        iterations: [{ type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 2_000, output_tokens: 300, cache_read_input_tokens: 0 }],
      }),
    ]);
    const reading = await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' });
    expect(reading.requests.map(({ model, tokens }) => [model, tokens.input, tokens.output])).toEqual([
      ['claude-sonnet-5-5', 100, 50],
      ['claude-opus-5-5', 2_000, 300],
    ]);
    expect(reading.tokens).toEqual({ input: 2_100, output: 350, cacheRead: 0, cacheCreation: 0 });
  });

  it('leaves placeholder messages that never reached the API out of requests', async () => {
    const file = transcript([claudeTurn('a', '<synthetic>', { input_tokens: 0, output_tokens: 0 })]);
    expect((await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' })).requests).toEqual([]);
  });

  it('reads nothing from a missing transcript', async () => {
    const reading = await readTokenUsage('claude-jsonl', { transcriptPath: path.join(dir, 'gone.jsonl'), sessionId: 's-1' });
    expect(reading).toEqual({ tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, requests: [] });
  });
});
