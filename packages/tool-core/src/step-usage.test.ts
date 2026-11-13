import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stepUsage } from './step-usage.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-step-usage-'));
  dirs.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

  return file;
}

const FIRST_TURN = '2026-11-13T10:00:00.000Z';
const SECOND_TURN = '2026-11-13T10:05:00.000Z';

function claudeRequest(id: string, timestamp: string | undefined, usage: { input: number; output: number; cacheRead: number; cacheCreation: number }): object {
  return {
    type: 'assistant', sessionId: 'session-1', ...(timestamp !== undefined && { timestamp }),
    message: { id, model: 'claude-opus-5-5', usage: { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheCreation } },
  };
}

function codexRecord(timestamp: string, responseId: string, usage: { input: number; cached: number; output: number }, thread: { input: number; cached: number; output: number }): object {
  const counted = ({ input, cached, output }: typeof usage) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output });

  return { timestamp, type: 'token_usage_record', payload: { thread_id: 'session-1', session_id: 'session-1', response_id: responseId, usage: counted(usage), thread_token_usage: counted(thread) } };
}

const twoClaudeTurns = () => transcript([
  claudeRequest('msg_1', FIRST_TURN, { input: 4, output: 300, cacheRead: 10_000, cacheCreation: 9_000 }),
  claudeRequest('msg_2', FIRST_TURN, { input: 2, output: 100, cacheRead: 12_000, cacheCreation: 500 }),
  claudeRequest('msg_3', SECOND_TURN, { input: 3, output: 50, cacheRead: 20_000, cacheCreation: 700 }),
]);

describe('stepUsage', () => {
  it('reports every request of the session of a step that started it, as Claude Code reports its own usage', async () => {
    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: twoClaudeTurns(), sessionId: 'session-1' })).toEqual({ kind: 'measured', usage: { input: 9, output: 450, cachedInput: 42_000 } });
  });

  it('reports only the requests at or after a turn was sent, not those of the earlier steps in the same session', async () => {
    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: twoClaudeTurns(), sessionId: 'session-1', turnSentAt: Date.parse(SECOND_TURN) })).toEqual({ kind: 'measured', usage: { input: 3, output: 50, cachedInput: 20_000 } });
  });

  it('reports a Codex session as Codex reports its own usage, counting cached input inside input', async () => {
    const rollout = transcript([
      { timestamp: FIRST_TURN, type: 'session_meta', payload: { id: 'session-1', cwd: '/work' } },
      { timestamp: FIRST_TURN, type: 'turn_context', payload: { turn_id: 'turn-1', cwd: '/work', model: 'gpt-6.1-sol' } },
      codexRecord(FIRST_TURN, 'resp_1', { input: 1_200, cached: 1_000, output: 40 }, { input: 1_200, cached: 1_000, output: 40 }),
    ]);

    expect(await stepUsage({ format: 'codex-rollout', transcriptPath: rollout, sessionId: 'session-1' })).toEqual({ kind: 'measured', usage: { input: 1_200, output: 40, cachedInput: 1_000 } });
  });

  const unreadable = (): string => {
    const file = twoClaudeTurns();
    fs.chmodSync(file, 0o200);

    return file;
  };

  const oversized = (): string => {
    const file = twoClaudeTurns();
    fs.truncateSync(file, 50 * 1024 * 1024 + 1);

    return file;
  };

  it.each([
    {
      when: 'the transcript is missing', file: () => path.join(os.tmpdir(), 'teamai-step-usage-missing', 'session.jsonl'), turnSentAt: undefined,
      why: (file: string) => ({ cause: `teamai found no transcript at ${file}, where the tool keeps the step's session.`, next: 'Retry the step.' }),
    },
    {
      when: 'no request falls in the turn', file: twoClaudeTurns, turnSentAt: Date.parse('2026-11-13T11:00:00.000Z'),
      why: (file: string) => ({ cause: `${file}, the transcript of the step's session, records no request since the step sent its turn, as when the tool writes a turn's usage only after it ends.`, next: 'Retry the step.' }),
    },
    {
      when: 'a request records no time that would place it in or out of the turn',
      file: () => transcript([claudeRequest('msg_1', undefined, { input: 4, output: 300, cacheRead: 0, cacheCreation: 0 }), claudeRequest('msg_2', SECOND_TURN, { input: 3, output: 50, cacheRead: 0, cacheCreation: 0 })]),
      turnSentAt: Date.parse(SECOND_TURN),
      why: (file: string) => ({ cause: `${file}, the transcript of the step's session, records a request with no time, so teamai cannot tell this turn's requests from the earlier steps'.`, next: 'Run the step in a new session rather than continue this one.' }),
    },
    {
      when: 'the transcript is over the size teamai reads', file: oversized, turnSentAt: undefined,
      why: (file: string) => ({ cause: `${file}, the transcript of the step's session, is over the 50 MiB teamai reads.`, next: 'Run the step in a new session rather than continue one this long.' }),
    },
    ...(process.platform === 'win32' ? [] : [{
      when: 'teamai has no permission to read the transcript', file: unreadable, turnSentAt: undefined,
      why: (file: string) => ({ cause: `teamai cannot read ${file}, the transcript of the step's session, because it has no permission to read it.`, next: `Let the user teamai runs as read ${file}, then retry the step.` }),
    }]),
  ])('reports no usage, never zero, and says why, when $when', async ({ file: fileOf, turnSentAt, why }) => {
    const file = fileOf();

    expect(await stepUsage({ format: 'claude-jsonl', transcriptPath: file, sessionId: 'session-1', ...(turnSentAt !== undefined && { turnSentAt }) })).toEqual({ kind: 'unmeasured', why: why(file) });
  });
});
