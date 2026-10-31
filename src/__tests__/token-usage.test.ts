import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCopilotShutdown } from '../token-usage/formats/copilot-shutdown.js';
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

  it('keeps the part of the cache writes made to the one-hour cache', async () => {
    const file = transcript([
      claudeTurn('a', 'claude-opus-5-5', {
        input_tokens: 2, output_tokens: 321, cache_read_input_tokens: 12_648, cache_creation_input_tokens: 34_833,
        cache_creation: { ephemeral_1h_input_tokens: 34_833, ephemeral_5m_input_tokens: 0 },
      }),
    ]);
    const [request] = (await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' })).requests;
    expect(request.cacheCreation1h).toBe(34_833);
  });

  it('adds the requests of the session\'s subagents', async () => {
    const file = transcript([claudeTurn('a', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 20 })], 's-1.jsonl');
    fs.mkdirSync(path.join(dir, 's-1', 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's-1', 'subagents', 'agent-a1b2.jsonl'),
      JSON.stringify(claudeTurn('sub', 'claude-haiku-5-5', { input_tokens: 400, output_tokens: 90 })) + '\n',
    );
    const reading = await readTokenUsage('claude-jsonl', { transcriptPath: file, sessionId: 's-1' });
    expect(reading.requests.map((request) => request.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(reading.tokens).toEqual({ input: 410, output: 110, cacheRead: 0, cacheCreation: 0 });
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

// Codex rollout lines, trimmed to the fields teamai reads (Codex 0.165).
const THREAD = '01a1910c-010f-7c02-9147-8e051657efb6';
const codexUsage = (input: number, cached: number, output: number) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
});
const codex = {
  meta: (id = THREAD, extra: Record<string, unknown> = {}) => ({ timestamp: '2026-10-31T08:20:45.000Z', type: 'session_meta', payload: { id, model_provider: 'openai', ...extra } }),
  turn: (model: string) => ({ timestamp: '2026-10-31T08:20:45.800Z', type: 'turn_context', payload: { turn_id: 't1', model, effort: 'high' } }),
  tier: (tier: string) => ({ timestamp: '2026-10-31T08:20:45.827Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.1-sol', service_tier: tier } } }),
  record: (responseId: string, usage: ReturnType<typeof codexUsage>, thread: ReturnType<typeof codexUsage>, threadId = THREAD) => ({
    timestamp: '2026-10-31T08:20:50.762Z', type: 'token_usage_record',
    payload: { thread_id: threadId, session_id: threadId, response_id: responseId, usage, thread_token_usage: thread },
  }),
  count: (last: ReturnType<typeof codexUsage>, total: ReturnType<typeof codexUsage>, timestamp = '2026-10-31T08:20:50.944Z') => ({
    timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  }),
};

describe('readTokenUsage: codex-rollout', () => {
  it('reads one request per response, on the model of its turn', async () => {
    const file = transcript([
      codex.meta(),
      codex.turn('gpt-6.1-sol'),
      codex.record('resp_1', codexUsage(26_858, 0, 132), codexUsage(26_858, 0, 132)),
      codex.count(codexUsage(26_858, 0, 132), codexUsage(26_858, 0, 132)),
      codex.turn('gpt-6.1-terra'),
      codex.record('resp_2', codexUsage(30_000, 26_000, 400), codexUsage(56_858, 26_000, 532)),
    ], 'rollout.jsonl');

    const reading = await readTokenUsage('codex-rollout', { transcriptPath: file, sessionId: THREAD, settled: true });

    expect(reading.requests.map(({ key, model, tokens }) => ({ key, model, tokens }))).toEqual([
      { key: 'resp_1', model: 'gpt-6.1-sol', tokens: { input: 26_858, output: 132, cacheRead: 0, cacheCreation: 0 } },
      // Codex counts cached tokens inside input_tokens.
      { key: 'resp_2', model: 'gpt-6.1-terra', tokens: { input: 4_000, output: 400, cacheRead: 26_000, cacheCreation: 0 } },
    ]);
    expect(reading.tokens).toEqual({ input: 30_858, output: 532, cacheRead: 26_000, cacheCreation: 0 });
    expect(reading.scope).toBe('session');
  });

  it('prices the priority tier as fast mode', async () => {
    const file = transcript([
      codex.meta(), codex.tier('priority'), codex.turn('gpt-6.1-sol'),
      codex.record('resp_1', codexUsage(1_000, 0, 10), codexUsage(1_000, 0, 10)),
    ], 'rollout.jsonl');
    const [request] = (await readTokenUsage('codex-rollout', { transcriptPath: file, sessionId: THREAD, settled: true })).requests;
    expect(request.speed).toBe('fast');
  });

  it('leaves out the parent\'s responses a forked rollout copies', async () => {
    const parent = '01a19000-0000-7000-8000-000000000000';
    const file = transcript([
      codex.meta(THREAD, { forked_from_id: parent }),
      codex.turn('gpt-6.1-sol'),
      codex.record('resp_parent', codexUsage(9_000, 0, 90), codexUsage(9_000, 0, 90), parent),
      codex.record('resp_child', codexUsage(1_000, 0, 10), codexUsage(1_000, 0, 10)),
    ], 'rollout.jsonl');
    const reading = await readTokenUsage('codex-rollout', { transcriptPath: file, sessionId: THREAD, settled: true });
    expect(reading.requests.map((request) => request.key)).toEqual(['resp_child']);
  });

  it('reads requests from token counts in rollouts older than per-response records', async () => {
    const file = transcript([
      codex.meta(), codex.turn('gpt-5.1-codex'),
      codex.count(codexUsage(500, 200, 25), codexUsage(500, 200, 25), '2026-01-05T10:00:01.000Z'),
      // Codex re-emits the same counters when the rate limits update.
      codex.count(codexUsage(500, 200, 25), codexUsage(500, 200, 25), '2026-01-05T10:00:02.000Z'),
      codex.count(codexUsage(400, 150, 20), codexUsage(900, 350, 45), '2026-01-05T10:00:09.000Z'),
    ], 'rollout.jsonl');
    const reading = await readTokenUsage('codex-rollout', { transcriptPath: file, sessionId: THREAD, settled: true });
    expect(reading.requests.map(({ model, tokens, timestamp }) => ({ model, tokens, timestamp }))).toEqual([
      { model: 'gpt-5.1-codex', tokens: { input: 300, output: 25, cacheRead: 200, cacheCreation: 0 }, timestamp: '2026-01-05T10:00:01.000Z' },
      { model: 'gpt-5.1-codex', tokens: { input: 250, output: 20, cacheRead: 150, cacheCreation: 0 }, timestamp: '2026-01-05T10:00:09.000Z' },
    ]);
    expect(reading.tokens).toEqual({ input: 550, output: 45, cacheRead: 350, cacheCreation: 0 });
    expect(reading.scope).toBe('transcript');
  });
});

describe('readTokenUsage: codebuddy', () => {
  // CodeBuddy CLI and WorkBuddy write OpenAI-agents items; usage rides on providerData.
  const item = (type: string, messageId: string, model: string, rawUsage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
    type, id: `item-${messageId}-${type}`, timestamp: 1_793_000_000_000,
    providerData: {
      messageId, model: 'auto', requestModelId: model,
      rawUsage, usage: { requests: 1, inputTokens: rawUsage.prompt_tokens ?? 0, outputTokens: rawUsage.completion_tokens ?? 0 },
      ...extra,
    },
  });

  it('reads each CLI request once by message id, on the model it ran', async () => {
    const file = transcript([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a retry' }] },
      item('message', 'm1', 'claude-sonnet-5-5', { prompt_tokens: 12_000, completion_tokens: 300, cache_read_input_tokens: 9_000, credit: 0.5 }),
      // A model-usage item repeats a message's usage when the message was not saved with it.
      item('model-usage', 'm1', 'claude-sonnet-5-5', { prompt_tokens: 12_000, completion_tokens: 300, cache_read_input_tokens: 9_000, credit: 0.5 }),
      item('model-usage', 'm2', 'deepseek-v4.1-flash', { prompt_tokens: 4_000, completion_tokens: 80 }),
    ], 'cb-session.jsonl');

    const reading = await readTokenUsage('codebuddy', { transcriptPath: file, sessionId: 'cb-session', settled: true });

    expect(reading.requests.map(({ key, model, tokens, timestamp }) => ({ key, model, tokens, timestamp }))).toEqual([
      // prompt_tokens includes the cached part.
      { key: 'm1', model: 'claude-sonnet-5-5', tokens: { input: 3_000, output: 300, cacheRead: 9_000, cacheCreation: 0 }, timestamp: '2026-10-26T07:33:20.000Z' },
      { key: 'm2', model: 'deepseek-v4.1-flash', tokens: { input: 4_000, output: 80, cacheRead: 0, cacheCreation: 0 }, timestamp: '2026-10-26T07:33:20.000Z' },
    ]);
    expect(reading.tokens).toEqual({ input: 7_000, output: 380, cacheRead: 9_000, cacheCreation: 0 });
  });

  it('reads the IDE\'s index.json, with each request\'s model from its messages', async () => {
    const conversation = path.join(dir, 'conv-1');
    fs.mkdirSync(path.join(conversation, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(conversation, 'messages', 'a2.json'), JSON.stringify({
      role: 'assistant', id: 'a2', extra: JSON.stringify({ modelId: 'hunyuan-t2', modelName: 'hunyuan-t2' }),
    }));
    const index = path.join(conversation, 'index.json');
    fs.writeFileSync(index, JSON.stringify({
      messages: [{ id: 'u1', role: 'user' }, { id: 'a2', role: 'assistant' }],
      requests: [
        { id: 'r0', startedAt: 1_793_000_000_000, messages: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { id: 'r1', startedAt: 1_793_000_000_000, messages: ['u1', 'a2'], usage: { inputTokens: 215_609, outputTokens: 2_967, totalTokens: 218_576 } },
      ],
    }));

    const reading = await readTokenUsage('codebuddy', { transcriptPath: index, sessionId: 'conv-1', settled: true });

    expect(reading.tokens).toEqual({ input: 215_609, output: 2_967, cacheRead: 0, cacheCreation: 0 });
    expect(reading.requests.map(({ key, model }) => [key, model])).toEqual([['r1', 'hunyuan-t2']]);
  });
});

describe('readTokenUsage: muse-session', () => {
  const sessionId = '01a131de-7a62-70c3-bc37-60b3e2c6575b';
  const completed = (id: string, model: unknown, usage: Record<string, number>, kind = 'model_completed') => ({
    schema_version: 1, record_type: 'event', payload_type: 'runtime.session', payload_schema_version: 1,
    id, recorded_at: 1_793_000_000_000_000, stream: { kind: 'session', id: sessionId },
    payload: { source_run_record_id: `run-${id}`, event: { kind, model, usage } },
  });

  it('reads each model call with its model, cached input apart', async () => {
    const sessionDir = path.join(process.env.HOME ?? '', '.local', 'share', 'muse', 'sessions', '2026', '10', '26', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), [
      completed('e1', 'muse-spark-1.2', { input_tokens: 12_000, output_tokens: 600, cached_input_tokens: 10_000 }),
      completed('e2', { model_id: 'muse-spark-open', provider_id: 'meta' }, { input_tokens: 3_000, output_tokens: 90 }, 'automated_review_completed'),
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');

    const reading = await readTokenUsage('muse-session', { sessionId, settled: true });

    expect(reading.requests.map(({ key, model, tokens, timestamp }) => ({ key, model, tokens, timestamp }))).toEqual([
      { key: 'run-e1', model: 'muse-spark-1.2', tokens: { input: 2_000, output: 600, cacheRead: 10_000, cacheCreation: 0 }, timestamp: '2026-10-26T07:33:20.000Z' },
      { key: 'run-e2', model: 'muse-spark-open', tokens: { input: 3_000, output: 90, cacheRead: 0, cacheCreation: 0 }, timestamp: '2026-10-26T07:33:20.000Z' },
    ]);
    expect(reading.tokens).toEqual({ input: 5_000, output: 690, cacheRead: 10_000, cacheCreation: 0 });
    expect(reading.scope).toBe('session');
  });
});

describe('readTokenUsage: agy-transcript', () => {
  it('sums planner steps whose input excludes the cached part', async () => {
    const sessionId = '6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    const logs = path.join(process.env.HOME ?? '', '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    // agy 1.4.10: input_tokens < cache_read_tokens, so input is the uncached part.
    fs.writeFileSync(path.join(logs, 'transcript.jsonl'), [
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 812, cache_read_tokens: 40_960, output_tokens: 233 },
      { step_index: 4, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: null, cache_read_tokens: null, output_tokens: null },
      { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: 95, cache_read_tokens: 41_472, output_tokens: 61 },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');

    const reading = await readTokenUsage('agy-transcript', { sessionId, settled: true });

    expect(reading).toEqual({ tokens: { input: 907, output: 294, cacheRead: 82_432, cacheCreation: 0 }, scope: 'session', requests: [] });
  });
});

describe('readTokenUsage: pi-session', () => {
  const assistant = (id: string, message: Record<string, unknown>) => ({ type: 'message', id, parentId: 'p', timestamp: '2026-09-01T15:01:51.019Z', message: { role: 'assistant', api: 'openai-codex-responses', ...message } });

  it('reads Pi and Oh My Pi assistant messages with their model and reported cost', async () => {
    const file = transcript([
      { type: 'session', id: '0198f1c2-5e1a-7b3c-9d4e-1f2a3b4c5d6e', version: 3 },
      // As Oh My Pi 18.12 writes it.
      assistant('8b1d4e6a', {
        provider: 'openai-codex', model: 'gpt-5.6-sol', responseId: 'resp_1',
        usage: { input: 2_039, output: 921, cacheRead: 87_808, cacheWrite: 0, totalTokens: 90_768, reasoningTokens: 878, cost: { total: 0.0616992 } },
      }),
      // A response served by another model than the one requested.
      assistant('8b1d4e6b', { provider: 'openrouter', model: 'auto', responseModel: 'kimi-k3', usage: { input: 300, output: 40, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }),
      { type: 'model_usage', id: 'u1', timestamp: '2026-09-01T15:02:00.000Z', purpose: 'auto-thinking', provider: 'anthropic', model: 'claude-haiku-5-5', usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } },
      { type: 'compaction', id: 'c1', timestamp: '2026-09-01T15:03:00.000Z', usage: { input: 9_000, output: 700, cacheRead: 0, cacheWrite: 0 } },
    ], 'pi-session.jsonl');

    const reading = await readTokenUsage('pi-session', { transcriptPath: file, sessionId: 's', settled: true });

    expect(reading.requests.map(({ model, tokens, reportedCostMicros }) => ({ model, tokens, reportedCostMicros }))).toEqual([
      { model: 'gpt-5.6-sol', tokens: { input: 2_039, output: 921, cacheRead: 87_808, cacheCreation: 0 }, reportedCostMicros: 61_699 },
      // A cost of 0 means Pi had no price for it, not that it was free.
      { model: 'kimi-k3', tokens: { input: 300, output: 40, cacheRead: 0, cacheCreation: 0 }, reportedCostMicros: undefined },
      { model: 'claude-haiku-5-5', tokens: { input: 50, output: 5, cacheRead: 0, cacheCreation: 0 }, reportedCostMicros: undefined },
    ]);
    // A compaction's summary call has no model, so it counts in the tokens only.
    expect(reading.tokens).toEqual({ input: 11_389, output: 1_666, cacheRead: 87_808, cacheCreation: 0 });
  });
});

const HAS_SQLITE3 = process.platform !== 'win32' && spawnSync('sqlite3', ['-version']).status === 0;

describe.skipIf(!HAS_SQLITE3)('readTokenUsage: opencode-db', () => {
  it('reads the session\'s assistant messages from opencode.db, both message tables', async () => {
    const data = path.join(dir, 'opencode');
    fs.mkdirSync(data, { recursive: true });
    const v1 = { role: 'assistant', modelID: 'claude-sonnet-5-5', providerID: 'anthropic', cost: 0.0213, time: { created: 1_793_000_000_000 }, tokens: { input: 1_200, output: 300, reasoning: 100, cache: { read: 40_000, write: 2_000 } } };
    // OpenCode 2.1 keeps the role in the row's type, not in its data.
    const v2 = { agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, finish: 'stop', cost: 0, time: { created: 1_793_000_060_000 }, tokens: { input: 17_835, output: 87, reasoning: 229, cache: { read: 1_941, write: 0 } } };
    const sql = [
      'CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);',
      'CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);',
      `INSERT INTO message VALUES ('msg_a', 'ses_7Hq2', 1, 1, '${JSON.stringify(v1)}');`,
      `INSERT INTO message VALUES ('msg_u', 'ses_7Hq2', 1, 1, '${JSON.stringify({ role: 'user' })}');`,
      `INSERT INTO message VALUES ('msg_other', 'ses_other', 1, 1, '${JSON.stringify(v1)}');`,
      // Newer OpenCode writes the same message to both tables.
      `INSERT INTO session_message VALUES ('msg_a', 'ses_7Hq2', 'assistant', 1, 1, 1, '${JSON.stringify(v1)}');`,
      `INSERT INTO session_message VALUES ('msg_s', 'ses_7Hq2', 'system', 3, 1, 1, '${JSON.stringify({ ...v2, model: undefined })}');`,
      `INSERT INTO session_message VALUES ('msg_b', 'ses_7Hq2', 'assistant', 2, 1, 1, '${JSON.stringify(v2)}');`,
    ].join('\n');
    expect(spawnSync('sqlite3', [path.join(data, 'opencode.db')], { input: sql }).status).toBe(0);
    const xdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    try {
      const reading = await readTokenUsage('opencode-db', { sessionId: 'ses_7Hq2', settled: true });
      expect(reading.requests.map(({ key, model, tokens, reportedCostMicros }) => ({ key, model, tokens, reportedCostMicros }))).toEqual([
        // Reasoning tokens are billed as output and OpenCode keeps them apart.
        { key: 'msg_a', model: 'claude-sonnet-5-5', tokens: { input: 1_200, output: 400, cacheRead: 40_000, cacheCreation: 2_000 }, reportedCostMicros: 21_300 },
        { key: 'msg_b', model: 'big-pickle', tokens: { input: 17_835, output: 316, cacheRead: 1_941, cacheCreation: 0 }, reportedCostMicros: undefined },
      ]);
      expect(reading.tokens).toEqual({ input: 19_035, output: 716, cacheRead: 41_941, cacheCreation: 2_000 });
    } finally {
      if (xdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = xdg;
    }
  });
});

describe('readCopilotShutdown', () => {
  // A session.shutdown record as Copilot CLI 1.0 writes it, trimmed to the fields teamai reads.
  const shutdown = {
    type: 'session.shutdown', id: 'e7c1', timestamp: '2026-10-30T18:04:11.902Z',
    data: {
      tokenDetails: { input: { tokenCount: 15_311 }, cache_read: { tokenCount: 1_280 }, cache_write: { tokenCount: 0 }, output: { tokenCount: 1_034 } },
      modelMetrics: {
        'mai-code-1.1-flash': {
          usage: { inputTokens: 14_591, outputTokens: 934, cacheReadTokens: 1_280, cacheWriteTokens: 0 },
          tokenDetails: { input: { tokenCount: 13_311 }, cache_read: { tokenCount: 1_280 }, cache_write: { tokenCount: 0 }, output: { tokenCount: 934 } },
        },
        // Without per-model details, the usage counts the cached input inside inputTokens.
        'gpt-6.1-sol': { usage: { inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    },
  };

  it('reads the session totals and one request per model, which sums its calls', () => {
    expect(readCopilotShutdown(shutdown)).toEqual({
      tokens: { input: 15_311, output: 1_034, cacheRead: 1_280, cacheCreation: 0 },
      requests: [
        { key: 'e7c1:mai-code-1.1-flash', timestamp: '2026-10-30T18:04:11.902Z', model: 'mai-code-1.1-flash', speed: 'standard', tokens: { input: 13_311, output: 934, cacheRead: 1_280, cacheCreation: 0 }, combinesCalls: true },
        { key: 'e7c1:gpt-6.1-sol', timestamp: '2026-10-30T18:04:11.902Z', model: 'gpt-6.1-sol', speed: 'standard', tokens: { input: 2_000, output: 100, cacheRead: 0, cacheCreation: 0 }, combinesCalls: true },
      ],
    });
  });

  it('tells a shutdown without counters from another record', () => {
    expect(readCopilotShutdown({ type: 'session.shutdown', id: 'e7c2', data: {} })).toEqual({ requests: [] });
    expect(readCopilotShutdown({ type: 'assistant.message', id: 'e7c3', data: {} })).toBeUndefined();
  });
});
