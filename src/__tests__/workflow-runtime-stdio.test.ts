import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { spawnCommand } from '@teamai/shared/exec';
import { newOpId } from '@teamai/runtime-protocol/step-runtime';
import { stdioStepRuntime } from '../workflow/runtimes/stdio.js';

vi.mock(import('@teamai/shared/exec'), async (original) => ({ ...await original(), spawnCommand: vi.fn() }));

it.each([
  { exitCode: null, reason: 'it closed its protocol output' },
  { exitCode: 70, reason: 'it exited with status 70' },
])('ends an accepted exec as lost when runtime stdout ends ($reason)', async ({ exitCode, reason }) => {
  vi.useFakeTimers();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child: ChildProcess = Object.assign(Object.create(ChildProcess.prototype), { stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null });
  vi.mocked(spawnCommand).mockReturnValue(child);
  const runtime = stdioStepRuntime({ name: 'test', command: 'test' });
  const reply = (event: object): string => `${JSON.stringify(event)}\n`;

  try {
    const initialized = runtime.init({ options: {}, mode: 'unattended', homeEnv: {} });
    stdout.write(reply({ type: 'init', ok: true, can: { exec: true } }));
    expect(await initialized).toMatchObject({ ok: true });

    const op = newOpId();
    const accepted = vi.fn();
    const exec = runtime.exec({ op, handle: 'place', argv: ['example'], env: {}, unset: [], credentials: {}, cwd: process.cwd() }, { onAccepted: accepted }, 'command');
    const eof = once(stdout, 'end');
    stdout.end(reply({ op, event: 'accepted' }));
    await eof;

    if (exitCode !== null) {
      Object.assign(child, { exitCode });
      child.emit('exit', exitCode, null);
    }

    await vi.advanceTimersByTimeAsync(1000);

    expect(accepted).toHaveBeenCalledOnce();
    expect(await Promise.race([exec, 'still pending'])).toEqual({
      kind: 'lost',
      failure: { code: 'runtime_exited', message: `Step runtime "test" stopped: ${reason}.` },
    });
  } finally {
    child.emit('close', 0, null);
    await runtime.dispose();
    vi.useRealTimers();
  }
});
