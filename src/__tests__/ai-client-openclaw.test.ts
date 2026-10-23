import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

vi.mock('../utils/cli-path.js', () => ({ resolveCliPath: (name: string) => name === 'openclaw' ? '/bin/openclaw' : null }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));
import spawn from 'cross-spawn';
import { callClaude } from '../utils/ai-client.js';

afterEach(() => vi.clearAllMocks());

it('uses the OpenClaw agent command and a fresh session per AI task', async () => {
  vi.mocked(spawn).mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(() => {
      child.stdout.write('  model answer\n');
      child.emit('close', 0);
    });
    return child as unknown as ChildProcess;
  });
  const prompt = 'First line\nquotes: " \' ; $(literal) --deliver';
  expect(await callClaude(prompt)).toBe('model answer');
  expect(await callClaude('independent task')).toBe('model answer');
  const [first, second] = vi.mocked(spawn).mock.calls;
  expect(first[0]).toBe('/bin/openclaw');
  expect(first[1]).toEqual(['agent', '--session-id', expect.any(String), '--message', prompt]);
  expect(second[1]).toEqual(['agent', '--session-id', expect.any(String), '--message', 'independent task']);
  expect(first[1]![2]).not.toBe(second[1]![2]);
  expect(first[1]![2]).toMatch(/^[0-9a-f-]{36}$/);
});
