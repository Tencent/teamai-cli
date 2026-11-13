import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { spawnCommand } from '@teamai/shared/exec';
import { redact } from '@teamai/shared/redact';
import { log } from '@teamai/shared/log';
import { EXITED_STDOUT_CHARS, RUNTIME_PROTOCOL, RUNTIME_PROTOCOL_ENV, STDOUT_CUT, type Can, type OpId, type RuntimeFailure, type RuntimeRequest } from '@teamai/runtime-protocol';
import { parseRuntimeLine, type HandleEvent, type OpEvent, type Shown } from './protocol.js';
import type { Accepted, ExecEnd, ExecEvents, Initialized, Opened, PromptEnd, Reattached, StepRuntime, WakeEnd } from '@teamai/runtime-protocol/step-runtime';
import { MAX_TIMER_MS } from '@teamai/shared/timer';
import type { DriverCan } from '../requirements.js';
import { signalChild } from '@teamai/shared/process-group';

/** How long `dispose` waits for a runtime to exit once its stdin ends; one that runs on is left to finish its own work. */
const DISPOSE_WAIT_MS = 2000;

/**
 * How long teamai waits for a runtime's reply to an `init`, a `reattach` or a `close`, and for the first answer to an
 * `open`, an `exec` or a `prompt`, and for the outcome of an `exec` or `prompt` it cancelled, before it fails that
 * request `runtime_unanswered`.
 */
const ANSWER_WITHIN_MS = 15_000;

// The most of a runtime's notice teamai shows.
const NOTICE_SHOWN = 2000;

// The events that end an operation: only the first counts.
const OP_ENDS = new Set(['ready', 'exited', 'finished', 'woken', 'cancelled', 'failed']);

/**
 * The stdout an exec printed: `streamed`, what teamai read of it in `output` events, when the stdout its `exited`
 * carries is cut to protocol 1's bound and is the end of that; else that stdout, as it is. A runtime that predates the
 * marker cuts to the bound with none, so a stdout that long counts as cut too, less a half character it dropped.
 */
function wholeStdout({ streamed, exited }: { streamed: string; exited: string }): string {
  const isMarked = exited.startsWith(STDOUT_CUT);
  const end = isMarked ? exited.slice(STDOUT_CUT.length) : exited;
  const isCut = isMarked || end.length >= EXITED_STDOUT_CHARS - 1;

  return isCut && streamed.length > end.length && streamed.endsWith(end) ? streamed : exited;
}

/**
 * How long an attended `init` may take: a person may have a sign-in page to approve, which the runtime names in a
 * `notice`. An unattended or recover `init` has nobody to wait for, and gets `ANSWER_WITHIN_MS`.
 */
const ATTENDED_INIT_WITHIN_MS = 10 * 60_000;

/**
 * Runs `then` at `deadline` (ms since the epoch), or at once when it passed, and answers how to stop waiting for it.
 * A deadline too far away for a timer is not timed.
 */
function atDeadline(deadline: number | undefined, then: () => void): () => void {
  if (deadline === undefined) return () => {};

  const left = Math.max(0, deadline - Date.now());

  if (left > MAX_TIMER_MS) return () => {};

  const timer = setTimeout(then, left);
  timer.unref();

  return () => clearTimeout(timer);
}

type HandleRequest = Extract<RuntimeRequest, { handle: string; type: 'collect' | 'reattach' | 'close' }>;

/** The display a runtime gave, if the run's details show it; one they do not show is named in a warning. */
function displayOf(name: string, shown: Shown) {
  if (shown.kind === 'dropped') log.warn(`Step runtime "${name}" gave a display the run's details do not show: ${shown.reason}.`);

  return shown.kind === 'shown' ? { display: shown.display } : {};
}

/** The `exec`, `prompt` or `wake` operations this connection has in flight, by op, each joinable by a repeat of its op. */
type InFlight<TEvents, TEnd> = Map<string, { join: (events: TEvents) => Promise<TEnd> }>;

/**
 * Runs operation `op` once while it is in flight: the first call starts it with `run`, and a call that repeats `op`
 * before it ends joins it, getting its events from then on, the acceptance it already showed, and the same end.
 * `run` sends the request and maps its events to its end; it tells every caller of the acceptance through `accept`, and
 * every other event through `callers`, which grows as calls join.
 */
function joinable<TEvents extends Pick<ExecEvents, 'onAccepted'>, TEnd>({ inFlight, op, events, run }: {
  inFlight: InFlight<TEvents, TEnd>;
  op: string;
  events: TEvents;
  run: (callers: readonly TEvents[], accept: (accepted: Accepted) => void) => Promise<TEnd>;
}): Promise<TEnd> {
  const joined = inFlight.get(op);

  if (joined) return joined.join(events);
  const callers = [events];
  let shown: Accepted | undefined;

  const ended = run(callers, (accepted) => {
    shown = accepted;

    for (const caller of callers) caller.onAccepted?.(accepted);
  });

  inFlight.set(op, {
    join: (next) => {
      callers.push(next);

      if (shown) next.onAccepted?.(shown);

      return ended;
    },
  });
  void ended.then(() => { inFlight.delete(op); });

  return ended;
}

type HandleWaiter = { request: HandleRequest; events: ReadonlySet<HandleEvent['event']>; settle: (event: HandleEvent | RuntimeFailure) => void };

/** What waits on one operation: the request that started it, and what reads each of its events or its failure. */
type OpWaiter = { type: 'open' | 'exec' | 'prompt' | 'wake'; on: (event: OpEvent | RuntimeFailure) => void };

/** A runtime's offer as teamai takes it: `can.confined` only from a runtime that says it answers confined prompts. */
function offered(can: Can, answersConfined: boolean): Can {
  if (answersConfined) return can;
  const { confined: _dropped, ...rest } = can;

  return rest;
}

/**
 * The client of an external step runtime: `command` spawned with `args`, speaking runtime protocol 1 over its stdio.
 * The process starts at `init`. Once it exits, or writes a line the protocol does not have, no request reaches it
 * again: an exec or prompt in flight ends `lost`, since what it started may outlive the runtime, and every other
 * request fails with `runtime_exited`. A `reattach`, `collect` or `close` ends with its own reply, or with the failure
 * reply for its handle. Every request still waiting fails `runtime_unanswered` when the runtime writes an error that
 * names no request (an exec or prompt ending `lost`), and so does an `init`, a `reattach` or a `close` with no reply
 * within 15 s (an attended `init`, which may wait for a person to sign in, within 10 min), and an `open`, `exec` or `prompt` with no answer within 15 s. A `cancel` gets no answer of its own: an
 * `exec` or `prompt` this process waits on with no outcome within 15 s of its cancel ends `lost` the same way. A
 * `notice` answers nothing: it is shown as a warning, with `secrets`, the values of the credentials the runtime gets,
 * masked.
 */
export function stdioStepRuntime({ name, command, args = [], cwd, secrets = {} }: { name: string; command: string; args?: string[]; cwd?: string; secrets?: Record<string, string> }): StepRuntime<DriverCan> {
  let child: ChildProcess | undefined;
  let dead: RuntimeFailure | undefined;
  let stderrTail = '';
  let exited: Promise<void> = Promise.resolve();
  let onInit: ((reply: Initialized<DriverCan>) => void) | undefined;
  const ops = new Map<string, OpWaiter>();
  const handles = new Map<string, HandleWaiter[]>();
  // The deadline each place was opened with, by handle, which bounds the end of what runs there and its collect.
  const deadlines = new Map<string, number>();
  // An operation repeated while this connection still has it in flight joins it, rather than replacing its listener.
  const opening = new Map<string, { join: (onAccepted: (handle: string) => Promise<void>) => Promise<Opened> }>();
  const executing: InFlight<ExecEvents, ExecEnd> = new Map();
  const prompting: InFlight<Parameters<StepRuntime['prompt']>[1], PromptEnd> = new Map();
  const waking: InFlight<Parameters<NonNullable<StepRuntime['wake']>>[1], WakeEnd> = new Map();
  // Whether the runtime's init for new work offered `wake`: one that did not, or answered only to recover, is sent none.
  let offersWake = false;
  // Operations this connection cancelled: a cancel may race their end, and each cancel is answered with an end.
  const cancelSent = new Set<string>();
  // Ends of operations nothing waits on any more, which teamai ignores but counts.
  let lateEnds = 0;

  const die = (reason: string): void => {
    if (dead) return;
    const tail = stderrTail.trim().split('\n').slice(-5).join(' | ');
    dead = { code: 'runtime_exited', message: `Step runtime "${name}" stopped: ${reason}.${tail ? ` It wrote: ${tail}` : ''}` };
    onInit?.({ ok: false, failure: dead });

    for (const waiter of ops.values()) waiter.on(dead);
    ops.clear();

    for (const waiters of handles.values()) for (const waiter of waiters) waiter.settle(dead);
    handles.clear();

    if (child) signalChild(child, 'SIGKILL');
  };

  /** Fails every request still waiting, as the runtime left them unanswered: `why` says how. */
  const unanswered = (why: string): void => {
    onInit?.({ ok: false, failure: { code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer init: ${why}.` } });
    onInit = undefined;
    const waiting = [...handles.values()].flat();
    handles.clear();
    const inFlight = [...ops];
    ops.clear();

    for (const { request, settle } of waiting) settle({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer ${request.type} of ${request.handle}: ${why}.` });

    for (const [op, { type, on }] of inFlight) on({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not answer ${type} ${op}: ${why}.` });
  };

  /**
   * Waits on operation `op`, which a `type` request starts: `on` reads each of its events, or why it got none. One with
   * no answer within 15 s gets `runtime_unanswered`, since a runtime that never accepts it may still have started it. A
   * `display` is no answer.
   */
  const listen = (type: OpWaiter['type'], op: string, on: OpWaiter['on']): void => {
    const waiter: OpWaiter = { type, on: (event) => {
      if (!('event' in event) || event.event !== 'display') clearTimeout(timer);
      on(event);
    } };

    const timer = setTimeout(() => {
      if (ops.get(op) === waiter) waiter.on({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not accept ${type} ${op} within ${ANSWER_WITHIN_MS / 1000} s.` });
    }, ANSWER_WITHIN_MS);

    timer.unref();
    ops.set(op, waiter);
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
      onInit?.(message.ok
        ? {
          ok: true, launchesAgents: message.prompt === true, ...(message.unavailable && { unavailable: message.unavailable }), ...(message.ownLogins && { ownLogins: message.ownLogins }), ...(message.wake === true && { wakes: true }),
          ...(message.toolHome === true && { runsOnToolHome: true }), ...(message.conversations === true && { keepsConversations: true }),
          can: { ...offered(message.can, message.confinedPrompt === true), ...(message.permissions && { fullAccess: Object.keys(message.permissions) }) },
        }
        : { ok: false, failure: message.error });
      onInit = undefined;

      return;
    }

    if (message.event === 'notice') {
      const about = message.op !== undefined ? `, operation ${message.op}` : message.handle !== undefined ? `, place ${message.handle}` : '';
      // Masked before it is cut, so no cut leaves part of a secret.
      const masked = redact(message.message, { envSecrets: secrets });
      log.warn(`Step runtime "${name}"${about}: ${masked.length > NOTICE_SHOWN ? `${masked.slice(0, NOTICE_SHOWN)}…` : masked}`);

      return;
    }

    if (message.event === 'error') {
      if (onInit === undefined && handles.size === 0 && ops.size === 0) log.warn(`Step runtime "${name}" answered: ${message.message}`);
      else unanswered(`it wrote an error that names no request (${message.message})`);

      return;
    }

    if ('op' in message) {
      const waiter = ops.get(message.op);

      if (waiter) waiter.on(message);
      else if (OP_ENDS.has(message.event) && !cancelSent.has(message.op)) {
        lateEnds += 1;
        log.warn(`Step runtime "${name}" answered ${message.op} with ${message.event} after teamai stopped waiting for it, which teamai ignores (late answers from this runtime: ${lateEnds}).`);
      }

      return;
    }

    const waiters = handles.get(message.handle) ?? [];
    const at = waiters.findIndex((waiter) => waiter.events.has(message.event));

    if (at === -1) return;
    const [waiter] = waiters.splice(at, 1);

    if (waiters.length === 0) handles.delete(message.handle);
    waiter?.settle(message.event === 'failed' ? message.failure : message);
  };

  /** Sends a handle request and waits for one of `events` for its handle, or for the failure reply to it. */
  const askHandle = (request: HandleRequest, events: HandleEvent['event'][]): Promise<HandleEvent | RuntimeFailure> => {
    if (dead) return Promise.resolve(dead);

    return new Promise((resolve) => {
      const waiters = handles.get(request.handle) ?? [];
      // A collect brings the place's work back, which takes as long as that work is large: only its own reply, the
      // runtime's end, or, for a place opened with a deadline, 15 s past it settles it.
      const deadline = deadlines.get(request.handle);

      const by = request.type !== 'collect' ? { at: Date.now() + ANSWER_WITHIN_MS, message: `Step runtime "${name}" did not answer ${request.type} of ${request.handle} within ${ANSWER_WITHIN_MS / 1000} s.` }
        : deadline !== undefined ? { at: Math.max(deadline, Date.now()) + ANSWER_WITHIN_MS, message: `Step runtime "${name}" did not answer collect of ${request.handle} within ${ANSWER_WITHIN_MS / 1000} s of the attempt's deadline.` }
          : undefined;

      let stop = (): void => {};

      const waiter: HandleWaiter = {
        request,
        events: new Set([...events, 'failed']),
        settle: (answer) => {
          stop();
          resolve(answer);
        },
      };

      if (by !== undefined) {
        stop = atDeadline(by.at, () => {
          const left = handles.get(request.handle) ?? [];
          const at = left.indexOf(waiter);

          if (at === -1) return;
          left.splice(at, 1);

          if (left.length === 0) handles.delete(request.handle);
          waiter.settle({ code: 'runtime_unanswered', message: by.message });
        });
      }

      waiters.push(waiter);
      handles.set(request.handle, waiters);
      send(request);
    });
  };

  /** Gives `onDisplay` a display the runtime sent apart from the acceptance, when the run's details show it. */
  const showApart = (events: Pick<ExecEvents, 'onDisplay'>, shown: Shown): void => {
    const { display } = displayOf(name, shown);

    if (display) events.onDisplay?.(display);
  };

  const isFailure = (value: OpEvent | HandleEvent | RuntimeFailure): value is RuntimeFailure => 'code' in value && !('event' in value);

  /**
   * Cancels operation `op`. An exec or prompt this process waits on ends with the cancel's outcome; one the runtime
   * never confirms would hold the driver, and the run's lock, forever. What it writes meanwhile does not count as that
   * outcome.
   */
  const cancelOp = (op: OpId): void => {
    const waiter = ops.get(op);

    cancelSent.add(op);

    if (waiter && waiter.type !== 'open') {
      setTimeout(() => {
        if (ops.get(op) === waiter) waiter.on({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not confirm the cancel of ${waiter.type} ${op} within ${ANSWER_WITHIN_MS / 1000} s, so what it started may still run.` });
      }, ANSWER_WITHIN_MS).unref();
    }

    send({ type: 'cancel', op });
  };

  /**
   * Cancels exec or prompt `op` of place `handle` if it still runs 15 s past the place's deadline; the answer stops that
   * wait. The step's own limit, and the lease's expiry, stop it first: this only bounds a stop that never came.
   */
  const cancelAtDeadline = (type: 'exec' | 'prompt', op: OpId, handle: string): (() => void) => {
    const deadline = deadlines.get(handle);

    return atDeadline(deadline === undefined ? undefined : deadline + ANSWER_WITHIN_MS, () => {
      if (!ops.has(op)) return;
      log.warn(`Step runtime "${name}" still ran ${type} ${op} 15 s past the attempt's deadline, so teamai cancels it.`);
      cancelOp(op);
    });
  };

  return {
    name,

    async init({ options, mode, credentials, instances, homeEnv, checkout }) {
      if (dead) return { ok: false, failure: dead };

      try {
        child = spawnCommand(command, args, { cwd, env: { ...process.env, [RUNTIME_PROTOCOL_ENV]: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
      readline.createInterface({ input: stdout }).on('line', receive).on('error', (error) => die(`its output could not be read (${error.message})`));

      return new Promise<Initialized<DriverCan>>((resolve) => {
        const settle = (reply: Initialized<DriverCan>): void => {
          clearTimeout(timer);
          offersWake = reply.ok && reply.wakes === true && mode !== 'recover';
          resolve(reply);
        };

        // An init that checks a provider which never answers would hold the command, and a cancel the run's lock, forever.
        const timer = setTimeout(() => {
          if (onInit !== settle) return;
          onInit = undefined;
          resolve({ ok: false, failure: { code: 'runtime_unanswered', message: mode === 'attended'
            ? `Step runtime "${name}" did not answer init within ${ATTENDED_INIT_WITHIN_MS / 60_000} min, while it ran attended.`
            : `Step runtime "${name}" did not answer init within ${ANSWER_WITHIN_MS / 1000} s.` } });
        }, mode === 'attended' ? ATTENDED_INIT_WITHIN_MS : ANSWER_WITHIN_MS);

        timer.unref();
        onInit = settle;
        send({ type: 'init', protocol: RUNTIME_PROTOCOL, mode, options, ...(credentials && { credentials }), ...(instances && { instances }), homeEnv, ...(checkout !== undefined && { checkout }) });
      });
    },

    open(request, onAccepted) {
      // A runtime that stopped before the open was sent made no place for it: unlike an open it stopped while it ran.
      if (dead) return Promise.resolve<Opened>({ kind: 'failed', failure: { code: 'runtime_not_sent', message: `${dead.message} teamai did not send open ${request.op}.` } });

      const inFlight = opening.get(request.op);

      if (inFlight) return inFlight.join(onAccepted);
      const persisters = [onAccepted];
      let handle: string | undefined;
      let persisted: Promise<void> = Promise.resolve();

      const persist = (onHandle: (handle: string) => Promise<void>, accepted: string): void => {
        persisted = persisted.then(() => onHandle(accepted));
        // Handled where open settles; the runtime's ready may come after the write already failed.
        persisted.catch(() => {});
      };

      const deadline = request.deadline === undefined ? undefined : Date.parse(request.deadline);
      // Stops the wait for the place to be ready by the deadline, once the place is accepted.
      let notReady = (): void => {};

      const settled = new Promise<Opened>((resolve, reject) => {
        // A caller that joins while the handle is being written adds its own write, which open also waits for.
        const settleAfterPersisted = (opened: Opened): void => {
          const at = persisted;
          at.then(() => (at === persisted ? resolve(opened) : settleAfterPersisted(opened)), reject);
        };

        listen('open', request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            settleAfterPersisted({ kind: 'failed', failure: event });

            return;
          }

          if (event.event === 'accepted') {
            if (event.handle === undefined) {
              die(`it accepted open ${request.op} without a handle`);

              return;
            }

            const accepted = event.handle;
            handle = accepted;

            if (deadline !== undefined) deadlines.set(accepted, deadline);

            for (const onHandle of persisters) persist(onHandle, accepted);

            // Only an accepted place is bounded by the deadline, so its handle is kept even when it is already past.
            notReady = atDeadline(deadline, () => {
              const waiting = ops.get(request.op);

              waiting?.on({ code: 'runtime_unanswered', message: `Step runtime "${name}" did not report the place of open ${request.op} ready by the attempt's deadline.` });
            });

            return;
          }

          if (event.event !== 'ready' && event.event !== 'failed') return;
          ops.delete(request.op);
          notReady();

          settleAfterPersisted(event.event === 'failed' ? { kind: 'failed', failure: event.failure }
            : handle === undefined ? { kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${name}" reported open ${request.op} ready before it accepted it.` } }
              : { kind: 'ready', handle, ...displayOf(name, event.display) });
        });

        send({ type: 'open', ...request });
      });

      opening.set(request.op, {
        join: (onHandle) => {
          persisters.push(onHandle);

          if (handle !== undefined) persist(onHandle, handle);

          return settled;
        },
      });

      const forget = (): void => { opening.delete(request.op); };

      settled.then(forget, forget);

      return settled;
    },

    exec(request, events) {
      if (dead) return Promise.resolve<ExecEnd>({ kind: 'failed', failure: dead });

      return joinable({ inFlight: executing, op: request.op, events, run: (callers, accept) => new Promise<ExecEnd>((resolveEnd) => {
        // Every stdout chunk the runtime streamed, which is the whole stdout an `exited` carries only the end of.
        let streamed = '';

        const resolve = (end: ExecEnd): void => {
          pastDeadline();
          resolveEnd(end);
        };

        listen('exec', request.op, (event) => {
          if (isFailure(event)) {
            ops.delete(request.op);
            resolve({ kind: 'lost', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              accept(displayOf(name, event.display));

              return;

            case 'output':
              if (event.stream === 'stdout') streamed += event.data;

              for (const caller of callers) caller.onOutput?.(event.stream, event.data);

              return;
            case 'display':
              for (const caller of callers) showApart(caller, event.display);

              return;
            case 'exited':
              ops.delete(request.op);
              resolve({ kind: 'exited', code: event.code, stdout: wholeStdout({ streamed, exited: event.stdout }) });

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
            case 'finished':
            case 'woken':
              die(`it answered exec ${request.op} with ${event.event}, which an exec does not have`);

              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        const pastDeadline = cancelAtDeadline('exec', request.op, request.handle);
        send({ type: 'exec', ...request });
      }) });
    },

    prompt(request, events) {
      if (dead) return Promise.resolve<PromptEnd>({ kind: 'failed', failure: dead });

      // An answer step runs on the member's tool in teamai's process: no runtime over stdio is sent one.
      if (request.lease.answer === true) {
        return Promise.resolve<PromptEnd>({ kind: 'failed', failure: { code: 'runtime_protocol', message: `Step runtime "${name}" is never sent an answer step: teamai answers step ${request.lease.step} on its host slot.` } });
      }

      return joinable({ inFlight: prompting, op: request.op, events, run: (callers, accept) => new Promise<PromptEnd>((resolve) => {
        const settle = (end: PromptEnd): void => {
          ops.delete(request.op);
          pastDeadline();
          resolve(end);
        };

        listen('prompt', request.op, (event) => {
          if (isFailure(event)) {
            settle({ kind: 'lost', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              accept(displayOf(name, event.display));

              return;

            case 'display':
              for (const caller of callers) showApart(caller, event.display);

              return;
            case 'finished': {
              const end: PromptEnd = { kind: 'finished', session: event.session, result: event.result };

              if (event.usage) end.usage = event.usage;
              else if (event.unmeasured) end.unmeasured = event.unmeasured;

              if (event.model) end.model = event.model;

              if (event.cost) end.cost = event.cost;

              if (event.confined) end.confined = event.confined;

              if (event.resumed === true) end.resumed = true;

              if (event.stopped) end.stopped = event.stopped;
              settle(end);

              return;
            }

            case 'cancelled':
              settle({ kind: 'cancelled' });

              return;
            case 'failed':
              settle({ kind: 'failed', failure: event.failure });

              return;
            case 'ready':
            case 'output':
            case 'exited':
            case 'woken':
              die(`it answered prompt ${request.op} with ${event.event}, which a prompt does not have`);

              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        const pastDeadline = cancelAtDeadline('prompt', request.op, request.handle);
        send({ type: 'prompt', ...request });
      }) });
    },

    wake(request, events) {
      if (dead) return Promise.resolve<WakeEnd>({ kind: 'failed', failure: dead });

      if (!offersWake) return Promise.resolve<WakeEnd>({ kind: 'failed', failure: { code: 'wake_unavailable', message: `Step runtime "${name}" wakes no fleet member: its init did not offer wake.` } });

      return joinable({ inFlight: waking, op: request.op, events, run: (callers, accept) => new Promise<WakeEnd>((resolve) => {
        const settle = (end: WakeEnd): void => {
          ops.delete(request.op);
          resolve(end);
        };

        listen('wake', request.op, (event) => {
          if (isFailure(event)) {
            settle({ kind: 'lost', failure: event });

            return;
          }

          switch (event.event) {
            case 'accepted':
              accept(displayOf(name, event.display));

              return;

            case 'display':
              for (const caller of callers) showApart(caller, event.display);

              return;
            case 'woken':
              settle({ kind: 'woken', where: event.where, ...displayOf(name, event.display) });

              return;
            // A wake ends woken, failed or lost: one a cancel stopped before it launched fails `cancelled`.
            case 'cancelled':
              settle({ kind: 'failed', failure: { code: 'cancelled', message: `Step runtime "${name}" stopped wake ${request.op} before it launched a fleet member.` } });

              return;
            case 'failed':
              settle({ kind: 'failed', failure: event.failure });

              return;
            case 'ready':
            case 'output':
            case 'exited':
            case 'finished':
              die(`it answered wake ${request.op} with ${event.event}, which a wake does not have`);

              return;
            default: {
              const unhandled: never = event;

              return unhandled;
            }
          }
        });

        send({ type: 'wake', ...request });
      }) });
    },

    async cancel(op) {
      cancelOp(op);
    },

    async collect(handle) {
      const reply = await askHandle({ type: 'collect', handle }, ['collected', 'collect_failed']);

      if (isFailure(reply)) return { ok: false, failure: reply };

      return reply.event === 'collect_failed' ? { ok: false, failure: reply.failure } : { ok: true };
    },

    async reattach(handle, how) {
      const reply = await askHandle({ type: 'reattach', handle, ...how }, ['alive', 'gone']);

      if (isFailure(reply)) return { kind: 'failed', failure: reply } satisfies Reattached;

      return reply.event === 'alive' ? { kind: 'alive', ops: reply.ops, ...displayOf(name, reply.display) } : { kind: 'gone' };
    },

    async close(handle, how) {
      const reply = await askHandle({ type: 'close', handle, ...how }, ['closed', 'close_failed']);

      if (isFailure(reply)) return { ok: false, failure: reply };

      return reply.event === 'close_failed' ? { ok: false, failure: reply.failure } : { ok: true };
    },

    async dispose() {
      if (!child) return;
      child.stdin?.end();

      // A runtime that already stopped is not waited for; what it started may still hold its stdout and stderr open.
      if (!dead) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, DISPOSE_WAIT_MS).unref())]);
      // One that runs on keeps what it started: teamai stops reading it, so this process does not wait for it to exit.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    },
  };
}
