import { spawn } from 'node:child_process';
import { stopProcess } from '../../tool-launch/process-stop.js';
import type { DriverCan } from '../requirements.js';
import type { ExecEnd, OpId, OpState, StepRuntime } from './step-runtime.js';

/**
 * The `local` step runtime, in teamai's process: the place is the worktree as it is on the host, and each `exec` runs
 * there in a process group of its own. It retains outcomes for as long as this process lives, so a teamai started
 * again finds every handle `gone`. It takes no options; `can` is what the caller decided this machine offers.
 */
export function localStepRuntime(can: DriverCan = {}): StepRuntime {
  const handles = new Map<string, string>();
  const ended = new Map<OpId, { handle: string; end: ExecEnd }>();
  const running = new Map<OpId, { handle: string; end: Promise<ExecEnd>; stop: () => Promise<void>; cancelled: boolean }>();
  const detached = process.platform !== 'win32';

  const exec: StepRuntime['exec'] = async (request, events) => {
    const retained = ended.get(request.op);

    if (retained) {
      events.onAccepted?.();

      return retained.end;
    }

    const live = running.get(request.op);

    if (live) {
      events.onAccepted?.();

      return live.end;
    }

    const env: NodeJS.ProcessEnv = { ...process.env, ...request.env };

    for (const name of request.unset) delete env[name];
    const [command = '', ...args] = request.argv;
    const child = spawn(command, args, { cwd: request.cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';

    const closed = new Promise<{ code: number; error?: Error }>((resolve) => {
      child.on('error', (error) => resolve({ code: 127, error }));
      child.on('close', (code) => resolve({ code: code ?? 1 }));
    });

    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; events.onOutput?.('stdout', data); });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { events.onOutput?.('stderr', data); });

    const stopGroup = stopProcess(child, closed, detached);

    const entry = {
      handle: request.handle,
      stop: async (): Promise<void> => { await stopGroup(); },
      cancelled: false,
      end: closed.then(({ code, error }): ExecEnd => {
        running.delete(request.op);

        const end: ExecEnd = entry.cancelled ? { kind: 'cancelled' }
          : error ? { kind: 'failed', failure: { code: 'exec_failed', message: `${command} could not be started: ${error.message}` } }
            : { kind: 'exited', code, stdout };

        ended.set(request.op, { handle: request.handle, end });

        return end;
      }),
    };

    running.set(request.op, entry);
    events.onAccepted?.();

    return entry.end;
  };

  const opsOf = (handle: string): OpState[] => [
    ...[...running].flatMap(([op, live]): OpState[] => (live.handle === handle ? [{ op, state: 'running' }] : [])),
    ...[...ended].flatMap(([op, { handle: of, end }]): OpState[] => {
      if (of !== handle) return [];

      return [end.kind === 'exited' ? { op, state: 'exited', code: end.code, stdout: end.stdout } : end.kind === 'cancelled' ? { op, state: 'cancelled' } : { op, state: 'failed', failure: end.failure }];
    }),
  ];

  return {
    name: 'local',

    async init({ options }) {
      const [key] = Object.keys(options);

      return key === undefined ? { ok: true, can } : { ok: false, failure: { code: 'bad_option', key, message: `The local runtime takes no options, and was given "${key}".` } };
    },

    async open(request, onAccepted) {
      const key = `${request.run}/${request.attempt}`;
      const handle = handles.get(key) ?? `local-${request.run}-${request.attempt}`;
      handles.set(key, handle);
      await onAccepted(handle);

      return { kind: 'ready', handle };
    },

    exec,

    async cancel(op) {
      const live = running.get(op);

      if (!live) return;
      live.cancelled = true;
      await live.stop();
    },

    async collect() {
      return { ok: true };
    },

    async reattach(handle) {
      return [...handles.values()].includes(handle) ? { kind: 'alive', ops: opsOf(handle) } : { kind: 'gone' };
    },

    async close(handle) {
      for (const [key, open] of handles) if (open === handle) handles.delete(key);

      for (const [op, done] of ended) if (done.handle === handle) ended.delete(op);
    },

    async dispose() {},
  };
}
