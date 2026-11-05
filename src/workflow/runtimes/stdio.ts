import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import crossSpawn from 'cross-spawn';
import { log } from '../../utils/logger.js';
import { parseRuntimeLine, RUNTIME_PROTOCOL, type HandleEvent, type OpEvent, type RuntimeRequest } from './protocol.js';
import type { ExecEnd, Initialized, Opened, Reattached, RuntimeFailure, StepRuntime } from './step-runtime.js';

/** How long `dispose` waits for a runtime to exit once its stdin ends; one that runs on is left to finish its own work. */
const DISPOSE_WAIT_MS = 2000;

type HandleWaiter = { events: ReadonlySet<HandleEvent['event']>; settle: (event: HandleEvent | RuntimeFailure) => void };

/**
 * The client of an external step runtime: `command` spawned with `args`, speaking runtime protocol 1 over its stdio.
 * The process starts at `init`. Once it exits, or writes a line the protocol does not have, everything in flight fails
 * with `runtime_exited` and no request reaches it again.
 */
export function stdioStepRuntime({ name, command, args = [], cwd }: { name: string; command: string; args?: string[]; cwd?: string }): StepRuntime {
  let child: ChildProcess | undefined;
  let dead: RuntimeFailure | undefined;
  let stderrTail = '';
  let exited: Promise<void> = Promise.resolve();
  let onInit: ((reply: Initialized) => void) | undefined;
  const ops = new Map<string, (event: OpEvent | RuntimeFailure) => void>();
  const handles = new Map<string, HandleWaiter[]>();

  const die = (reason: string): void => {
    if (dead) return;
    const tail = stderrTail.trim().split('\n').slice(-5).join(' | ');
    dead = { code: 'runtime_exited', message: `Step runtime "${name}" stopped: ${reason}.${tail ? ` It wrote: ${tail}` : ''}` };
    onInit?.({ ok: false, failure: dead });

    for (const listener of ops.values()) listener(dead);
    ops.clear();

    for (const waiters of handles.values()) for (const waiter of waiters) waiter.settle(dead);
    handles.clear();
    child?.kill('SIGKILL');
  };

  const send = (request: RuntimeRequest): void => {
    if (!dead) child?.stdin?.write(`${JSON.stringify(request)}\n`);
  };

  const receive = (line: string): void => {
    if (line.trim() === '') return;
    const parsed = parseRuntimeLine(line);

    if (!parsed.ok) {
      die(parsed.reason);

      return;
    }

    const { message } = parsed;

    if ('type' in message) {
      onInit?.(message.ok ? { ok: true, can: message.can } : { ok: false, failure: message.error });
      onInit = undefined;

      return;
    }

    if (message.event === 'error') {
      log.warn(`Step runtime "${name}" answered: ${message.message}`);

      return;
    }

    if ('op' in message) {
      ops.get(message.op)?.(message);

      return;
    }

    const waiters = handles.get(message.handle) ?? [];
    const at = waiters.findIndex((waiter) => waiter.events.has(message.event));

    if (at === -1) return;
    const [waiter] = waiters.splice(at, 1);
    waiter?.settle(message);
  };

  const askHandle = (request: Extract<RuntimeRequest, { handle: string; type: 'collect' | 'reattach' | 'close' }>, events: HandleEvent['event'][]): Promise<HandleEvent | RuntimeFailure> => {
    if (dead) return Promise.resolve(dead);

    return new Promise((settle) => {
      const waiters = handles.get(request.handle) ?? [];
      waiters.push({ events: new Set(events), settle });
      handles.set(request.handle, waiters);
      send(request);
    });
  };

  const isFailure = (value: OpEvent | HandleEvent | RuntimeFailure): value is RuntimeFailure => 'code' in value && !('event' in value);

  return {
    name,

    async init({ options, mode }) {
      if (dead) return { ok: false, failure: dead };

      try {
        child = crossSpawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        return { ok: false, failure: { code: 'runtime_exited', message: `Step runtime "${name}" could not start: ${error instanceof Error ? error.message : String(error)}` } };
      }

      const started = child;
      const { stdin, stdout, stderr } = started;

      if (!stdin || !stdout || !stderr) return { ok: false, failure: { code: 'runtime_exited', message: `Step runtime "${name}" started without its stdio.` } };
      exited = new Promise((resolve) => started.on('close', () => resolve()));
      started.on('error', (error) => die(`it could not start (${error.message})`));
      started.on('close', (code, signal) => die(signal ? `it was killed by ${signal}` : `it exited with status ${code ?? 1}`));
      stdin.on('error', () => {});
      stderr.setEncoding('utf8').on('data', (data: string) => { stderrTail = `${stderrTail}${data}`.slice(-4000); });
      readline.createInterface({ input: stdout }).on('line', receive);

      return new Promise<Initialized>((resolve) => {
        onInit = resolve;
        send({ type: 'init', protocol: RUNTIME_PROTOCOL, mode, options });
      });
    },

    open(request, onAccepted) {
      if (dead) return Promise.resolve<Opened>({ kind: 'failed', failure: dead });

      return new Promise<Opened>((resolve) => {
        let persisted: Promise<void> = Promise.resolve();
        let handle: string | undefined;

        ops.set(request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            resolve({ kind: 'failed', failure: event });

            return;
          }

          if (event.event === 'accepted') {
            if (event.handle === undefined) {
              die(`it accepted open ${request.op} without a handle`);

              return;
            }

            const accepted = event.handle;
            handle = accepted;
            persisted = persisted.then(() => onAccepted(accepted));

            return;
          }

          if (event.event !== 'ready' && event.event !== 'failed') return;
          ops.delete(request.op);

          const settled: Opened = event.event === 'failed' ? { kind: 'failed', failure: event.failure }
            : handle === undefined ? { kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${name}" reported open ${request.op} ready before it accepted it.` } }
              : { kind: 'ready', handle };

          void persisted.then(() => resolve(settled));
        });

        send({ type: 'open', ...request });
      });
    },

    exec(request, events) {
      if (dead) return Promise.resolve<ExecEnd>({ kind: 'failed', failure: dead });

      return new Promise<ExecEnd>((resolve) => {
        ops.set(request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            resolve({ kind: 'failed', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              events.onAccepted?.();

              return;
            case 'output':
              events.onOutput?.(event.stream, event.data);

              return;
            case 'exited':
              ops.delete(request.op);
              resolve({ kind: 'exited', code: event.code, stdout: event.stdout });

              return;
            case 'cancelled':
              ops.delete(request.op);
              resolve({ kind: 'cancelled' });

              return;
            case 'failed':
              ops.delete(request.op);
              resolve({ kind: 'failed', failure: event.failure });

              return;
            case 'ready':
              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        send({ type: 'exec', ...request });
      });
    },

    async cancel(op) {
      send({ type: 'cancel', op });
    },

    async collect(handle) {
      const reply = await askHandle({ type: 'collect', handle }, ['collected', 'collect_failed']);

      if (isFailure(reply)) return { ok: false, failure: reply };

      return reply.event === 'collect_failed' ? { ok: false, failure: reply.failure } : { ok: true };
    },

    async reattach(handle) {
      const reply = await askHandle({ type: 'reattach', handle }, ['alive', 'gone']);

      if (isFailure(reply)) return { kind: 'failed', failure: reply } satisfies Reattached;

      return reply.event === 'alive' ? { kind: 'alive', ops: reply.ops } : { kind: 'gone' };
    },

    async close(handle) {
      await askHandle({ type: 'close', handle }, ['closed']);
    },

    async dispose() {
      if (!child || dead) return;
      child.stdin?.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref())]);
    },
  };
}
