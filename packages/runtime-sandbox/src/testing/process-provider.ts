import { spawn, type ChildProcess } from 'node:child_process';
import { unreachable, type Provider } from '../provider.js';
import { signalChild } from '@teamai/shared/process-group';

/** A bind provider whose one sandbox is this machine: its exec spawns the process here, and its stop ends what runs. */
export function processProvider(): Provider {
  const running = new Set<ChildProcess>();
  const { collect: _collect, family: _family, ...sandboxing } = unreachable({ code: 'runtime_gone', message: 'Only exec and stop run here.' }, 'bind');

  return {
    ...sandboxing,
    family: 'bind',
    exec: (_id, { argv: [executable = '', ...args], env, cwd }, onOutput) => new Promise((resolve) => {
      const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      running.add(child);
      child.stdout.setEncoding('utf8').on('data', (data: string) => onOutput('stdout', data));
      child.stderr.setEncoding('utf8').on('data', (data: string) => onOutput('stderr', data));
      child.on('error', (error) => { running.delete(child); resolve({ kind: 'failed', failure: { code: 'runtime_failed', message: error.message } }); });
      child.on('close', (code, signal) => { running.delete(child); resolve({ kind: 'exited', code: code ?? (signal ? 128 : 1) }); });
    }),
    stop: async () => {
      for (const child of running) signalChild(child, 'SIGKILL');

      return { ok: true };
    },
  };
}
