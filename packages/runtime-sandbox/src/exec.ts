import { boundedStdout, CANCEL_FAILED, EXITED_STDOUT_CHARS, type ExecRequestSchema, type OpId, type OpState, type PromptRequestSchema, type RuntimeFailure } from '@teamai/runtime-protocol';
import type { OpLedger } from '@teamai/runtime-kit/ledger';
import { redact } from '@teamai/shared/redact';
import type { z } from 'zod';
import { placeOf } from './attempt-socket.js';
import { boundedTail } from './bounded-tail.js';
import { BOUND_MS, by } from './deadline.js';
import type { ExecRecord, Journal, Outcome, PlaceRecord } from './journal.js';
import { inSandbox, maskedAsGiven, rewrittenMasks } from './loopback.js';
import { sandboxOf, type Provider } from './provider.js';
import type { Ready } from './runtime.js';

// ─── What runs in a sandbox ──────────────────────────────
//
//  Every exec runs under teamai's id, journaled before it starts, so a repeated id is answered with the same outcome
//  and a runtime started again reads what an exec did while it was down. An op another runtime process runs, or one
//  whose process is gone, is followed through the journal until it ends. A stop is confirmed within BOUND_MS or the op
//  ends `cancel_failed`, the one failure a later cancel retries. The ledger writes each op's one end.
//

type ExecRequest = z.infer<typeof ExecRequestSchema>;

type PromptRequest = z.infer<typeof PromptRequestSchema>;

/** How often an exec another runtime process runs is looked at, to answer its outcome. */
const FOLLOW_MS = 100;

/** How long a stopped step's exec may take to end before its sandbox is stopped again, within BOUND_MS. */
const RESTOP_MS = 1_000;

/** One exec as the journal keeps it, with its id. */
type Journaled = { op: OpId } & ExecRecord;

/**
 * Masks a stream with `masks` as if it were one text. The text not given out yet waits, unmasked, for the next chunk or
 * the end: at least the longest mask's length less one, and back to the start of any value it would split, so a value
 * the stream splits across chunks, or one that starts with another, is masked whole, and no chunk ends inside a
 * character. What it gives out joined is the text masked.
 */
function maskedStream(masks: Record<string, string>) {
  const values = Object.values(masks).filter((value) => value !== '');
  const held = Math.max(1, ...values.map((value) => value.length)) - 1;
  const masked = (text: string): string => redact(text, { envSecrets: masks, patterns: false });
  let rest = '';

  /** Where `text` may be given out up to: no value starts before it and ends after it. */
  const cutOf = (text: string): number => {
    let cut = Math.max(0, text.length - held);

    for (let isMoved = true; isMoved;) {
      isMoved = false;

      for (const value of values) {
        const at = cut > 0 ? text.lastIndexOf(value, cut - 1) : -1;

        if (at >= 0 && at + value.length > cut) {
          cut = at;
          isMoved = true;
        }
      }
    }

    const last = text.charCodeAt(cut - 1);

    // A high surrogate last is the first half of a character whose second half follows.
    return last >= 0xd800 && last <= 0xdbff ? cut - 1 : cut;
  };

  return {
    push(chunk: string): string {
      const text = `${rest}${chunk}`;
      const cut = cutOf(text);
      rest = text.slice(cut);

      return masked(text.slice(0, cut));
    },
    flush(): string {
      const last = rest;
      rest = '';

      return masked(last);
    },
  };
}

/** The failure of an op whose place `handle` has no sandbox open. */
function noSandbox(handle: string): Outcome {
  return { state: 'failed', failure: { code: 'runtime_gone', message: `No sandbox is open under handle ${handle}.` } };
}

/** The credentials an exec or a prompt step gets in its sandbox: a credential it withholds is not set. */
export function givenCredentials(request: { credentials: Record<string, string>; unset: readonly string[] }, host: Ready['host']): Record<string, string> {
  return inSandbox(Object.fromEntries(Object.entries(request.credentials).filter(([name]) => !request.unset.includes(name))), host);
}

/** The execs and confined prompts of one runtime process, which the journal keeps and the ledger ends. */
export function execOperations({ journal, ledger }: { journal: Journal; ledger: OpLedger }) {
  const { write } = ledger;

  /** The ops this process runs, each with what resolves once its end is written. */
  const running = new Map<OpId, { ended: Promise<void>; end: () => void }>();
  /** The ops whose stop this process asked for and has not confirmed or failed yet, so a second cancel starts no second stop. */
  const pendingStops = new Set<OpId>();
  /** The ops this process answers but does not run, each with its handle and what stops following it. */
  const followers = new Map<OpId, { handle: string; stop: () => void }>();

  /** Writes `op`'s one end: `outcome`. */
  const endWith = (op: OpId, outcome: Outcome): void => ledger.end({ op, ...outcome });

  const claim = (op: OpId): void => {
    let end = (): void => {};
    const ended = new Promise<void>((resolve) => { end = resolve; });
    running.set(op, { ended, end });
  };

  const release = (op: OpId): void => {
    running.get(op)?.end();
    running.delete(op);
  };

  /**
   * Keeps `kept` as op's outcome, unless the journal holds one already or `close` forgot the op; throws when the journal
   * cannot be read or written.
   */
  const keep = (op: OpId, kept: Outcome): void => {
    const record = journal.exec(op);

    if (record !== undefined && record.outcome === undefined) journal.saveExec(op, { ...record, outcome: kept });
  };

  /**
   * Ends `op`, which this process claimed, with its true outcome once the journal keeps `kept`: one the journal cannot
   * keep is answered all the same, and the ledger remembers it until the place closes. Only an op's first end counts,
   * so an exec that ends after its cancel already failed it writes nothing more.
   */
  const finish = (op: OpId, outcome: Outcome, kept: Outcome = outcome): void => {
    if (!running.has(op)) return;
    void ledger.settle({ op, ...outcome }, () => keep(op, kept));
    release(op);
  };

  /**
   * An op with no outcome is running, wherever it runs: the runtime process that ran it may be gone, but what it started
   * in the sandbox may still run (#1717: only `running`, or `failed` with `cancel_failed`, may still run). Only a stop the
   * provider confirmed ends it.
   */
  const stateOf = (exec: Journaled): OpState => (exec.outcome ? { op: exec.op, ...exec.outcome } : { op: exec.op, state: 'running' });

  /** An op's state as `alive` reports it: an exec's stdout within protocol 1's bound, as its end carries it. */
  const reported = (state: OpState): OpState => (state.state === 'exited' ? { ...state, stdout: boundedStdout(state.stdout) } : state);

  /**
   * Writes the end of an op this process does not run, and stops following it here. With `keepIt`, the end is answered
   * once that kept it in the journal, or all the same, remembered by the ledger, when it could not.
   */
  const conclude = (op: OpId, outcome: Outcome, keepIt?: () => void): void => {
    followers.get(op)?.stop();

    if (keepIt === undefined) endWith(op, outcome);
    else void ledger.settle({ op, ...outcome }, keepIt);
  };

  /**
   * Answers an op another runtime process started, or one whose process is gone: with its outcome once the journal holds
   * one, or once a stop or a close here ends it. Its polling never keeps this process alive once teamai is gone.
   */
  const follow = (op: OpId, handle: string): Promise<void> => new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;

    const stop = (): void => {
      clearTimeout(timer);
      followers.delete(op);
      resolve();
    };

    const look = (): void => {
      try {
        const now = journal.exec(op);

        // A close forgot it once its sandbox, and whatever ran there, was removed.
        if (now === undefined) conclude(op, { state: 'cancelled' });
        else if (now.outcome) conclude(op, now.outcome);
        else timer = setTimeout(look, FOLLOW_MS).unref();
      } catch (error) {
        followers.delete(op);
        reject(error);
      }
    };

    followers.set(op, { handle, stop });
    look();
  });

  /**
   * Answers an id this runtime has seen, with its outcome or once it has one, without running it again; undefined for
   * a new id. It decides without awaiting, so the caller claims a new id before anything else is read.
   */
  const replay = (op: OpId): Promise<void> | undefined => {
    const unkept = ledger.unkept(op);

    if (unkept !== undefined) {
      write({ op, event: 'accepted' });
      ledger.end(unkept);

      return Promise.resolve();
    }

    const record = journal.exec(op);

    if (record?.outcome) {
      write({ op, event: 'accepted' });
      endWith(op, record.outcome);

      return Promise.resolve();
    }

    if (running.has(op) || followers.has(op)) {
      // Its end is written when it ends, under the same id.
      write({ op, event: 'accepted' });

      return Promise.resolve();
    }

    if (record) {
      write({ op, event: 'accepted' });

      return follow(op, record.handle);
    }

    return undefined;
  };

  /**
   * Journals `op`, which this process claimed, on `handle`, answers it accepted, and finds `place`'s sandbox: its id, or
   * undefined once `op` ended, its sandbox gone or a cancel come meanwhile. Journaled and accepted first: a runtime that
   * died before it kept the sandbox id leaves it to its labels, a lookup that takes the engine's time, and a cancel or a
   * close meanwhile finds the op and keeps it from starting.
   */
  const accept = async (op: OpId, { handle, place, provider }: { handle: string; place: PlaceRecord; provider: Provider }): Promise<string | undefined> => {
    journal.saveExec(op, { handle, runner: process.pid });
    write({ op, event: 'accepted' });
    const found = await sandboxOf(place, provider);

    if (!found.ok) {
      finish(op, { state: 'failed', failure: found.failure });

      return undefined;
    }

    if (found.id === undefined) {
      finish(op, noSandbox(handle));

      return undefined;
    }

    if (journal.isCancelled(op)) {
      finish(op, { state: 'cancelled' });

      return undefined;
    }

    return found.id;
  };

  const exec = async (request: ExecRequest, { provider, host }: Ready): Promise<void> => {
    const { op } = request;
    const handle = placeOf(request.handle);
    const replayed = replay(op);

    if (replayed) return replayed;

    // Claimed before the first await, so the same id sent again meanwhile is answered by this run.
    claim(op);
    const place = journal.place(handle);

    if (place?.confined) {
      finish(op, { state: 'failed', failure: { code: 'bad_request', message: `Handle ${handle} is a judge's place, which runs only its confined prompt, never an exec.` } });

      return;
    }

    if (place === undefined) {
      finish(op, noSandbox(handle));

      return;
    }

    const id = await accept(op, { handle, place, provider });

    if (id === undefined) return;

    // A name the exec sets itself wins over a credential.
    const scoped = givenCredentials(request, host);
    // teamai masks what the step prints with the values it gave. A URL on this machine itself reached the step as the
    // sandbox names it, which teamai cannot know, so that value is masked here first.
    const rewritten = rewrittenMasks(request.credentials, scoped);
    const streams = { stdout: maskedStream(rewritten), stderr: maskedStream(rewritten) };
    // The stdout the exec ends with is what it streamed, joined: past protocol 1's bound, its end, marked as cut, so
    // teamai gives the step what it streamed. Two characters over the bound tell a cut apart.
    const stdout = boundedTail(EXITED_STDOUT_CHARS + 2);

    const stream = (name: 'stdout' | 'stderr', data: string): void => {
      if (data === '') return;

      if (name === 'stdout') stdout.push(data);
      write({ op, event: 'output', stream: name, data });
    };

    const ran = await provider.exec(id, { argv: request.argv, env: { ...scoped, ...request.env }, unset: request.unset, cwd: request.cwd }, (name, data) => stream(name, streams[name].push(data)));
    stream('stdout', streams.stdout.flush());
    stream('stderr', streams.stderr.flush());

    const outcome: Outcome = journal.isCancelled(op) ? { state: 'cancelled' } : ran.kind === 'failed' ? { state: 'failed', failure: ran.failure } : { state: 'exited', code: ran.code, stdout: boundedStdout(stdout.text()) };
    // teamai masks the stdout itself; the journal never holds a credential the tool printed, so a repeated id is
    // answered with it masked. It is cut first: a credential masked shorter must not make a cut stdout look whole.
    finish(op, outcome, outcome.state === 'exited' ? { ...outcome, stdout: redact(outcome.stdout, { envSecrets: maskedAsGiven(request.credentials, scoped), patterns: false }) } : outcome);
  };

  /**
   * Stops what `op` runs, and when this process runs it, waits for its process to end: why the stop is not confirmed,
   * or undefined once it is, all within BOUND_MS. A judge's container is removed, so an exec still on its way to the
   * engine has nothing to start in; a step's restarts, ready for the step's next exec, and is stopped again while that
   * exec has not ended. One the engine cannot look up is not stopped.
   */
  const stopOf = async (op: OpId, { handle }: ExecRecord, provider: Provider): Promise<RuntimeFailure | undefined> => {
    const deadline = Date.now() + BOUND_MS;
    const place = journal.place(handle);

    const overdue = (what: string): RuntimeFailure => ({
      code: CANCEL_FAILED,
      message: `${what} within ${BOUND_MS / 1000} s, so exec ${op} may still run. Run \`teamai workflow cancel ${place?.run ?? '<run>'}\` again to stop it${place ? `, or ${provider.removal(place)}` : ''}.`,
    });

    const stopping = async (): Promise<{ ok: true } | { ok: false; failure: RuntimeFailure }> => {
      const found = place ? await sandboxOf(place, provider) : { ok: true as const, id: undefined };

      return !found.ok ? found : found.id === undefined ? { ok: true } : place?.confined ? provider.destroy(found.id) : provider.stop(found.id);
    };

    const stop = async (): Promise<RuntimeFailure | undefined> => {
      const stopped = await by(deadline, stopping());

      if (stopped.kind === 'late') return overdue(`The stop of sandbox ${handle} did not end`);

      return stopped.value.ok ? undefined : stopped.value.failure;
    };

    const unstopped = await stop();

    if (unstopped !== undefined) return unstopped;
    const ended = running.get(op)?.ended;

    if (ended === undefined) return undefined;

    // A step's sandbox outlives its stop, so an exec still on its way to the engine when the stop landed starts after it
    // (sbx starts a stopped sandbox again for it): each later stop ends what started since, until the exec ends.
    const waitUntil = (): number => (place?.confined ? deadline : Math.min(deadline, Date.now() + RESTOP_MS));

    while ((await by(waitUntil(), ended)).kind === 'late') {
      if (Date.now() >= deadline) return overdue(`Sandbox ${handle} was stopped, but exec ${op} did not end`);
      const again = await stop();

      if (again !== undefined) return again;
    }

    return undefined;
  };

  const cancel = async (op: OpId, provider: Provider): Promise<void> => {
    const record = journal.exec(op);
    // An end this process answered and could not journal stands in for the record's.
    const ended = ledger.unkept(op) ?? record?.outcome;
    // A stop this runtime could not confirm is the one outcome a later cancel replaces.
    const isRetried = ended?.state === 'failed' && ended.failure.code === CANCEL_FAILED;

    if (!record || pendingStops.has(op)) return;

    // A cancel of an op that already ended answers that end again.
    if (ended !== undefined && !isRetried) {
      conclude(op, ended);

      return;
    }

    const endsBefore = ledger.endsOf(op);
    journal.cancel(op);

    // A retried stop clears the failure the stop before it left, before anything else is read: until it is confirmed or
    // fails, a reattach or a resent id reads the op running, in this process or any other, never that old failure.
    if (isRetried) journal.saveExec(op, { handle: record.handle, runner: record.runner });
    pendingStops.add(op);

    try {
      const unconfirmed = await stopOf(op, record, provider);

      // One the engine could not stop may still run: it ends failed now, with why, wherever it runs, and its place stays
      // this attempt's for close to remove. When it ends after all, that end is not a second outcome (finish).
      if (unconfirmed !== undefined) {
        const outcome: Outcome = { state: 'failed', failure: { code: CANCEL_FAILED, message: unconfirmed.message } };

        if (running.has(op)) {
          finish(op, outcome);

          return;
        }

        // An exec that ended on its own meanwhile keeps that end, and one a close forgot is not kept again.
        const now = journal.exec(op);

        if (now === undefined || now.outcome !== undefined) return;
        conclude(op, outcome, () => journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome }));

        return;
      }

      // The engine confirmed the stop, so whatever ran is gone: an exec this process ran has ended cancelled already, and
      // any other ends cancelled here.
      const now = journal.exec(op);

      if (now === undefined || now.outcome !== undefined) return;
      conclude(op, { state: 'cancelled' }, () => journal.saveExec(op, { handle: record.handle, runner: record.runner, outcome: { state: 'cancelled' } }));
    } finally {
      pendingStops.delete(op);

      // The runtime process that ran the op, which teamai may no longer read, recorded its end while this stop ran:
      // this cancel answers with it, since nothing else here would. An op this process runs ends through finish only.
      if (!running.has(op) && ledger.endsOf(op) === endsBefore) {
        const recorded = journal.exec(op)?.outcome;

        if (recorded !== undefined) conclude(op, recorded);
      }
    }
  };

  /** Stops `op`, as teamai's cancel asks: a stop that threw ends the op `cancel_failed`, which a later cancel retries. */
  const cancelGuarded = async (op: OpId, provider: Provider): Promise<void> => {
    const endsBefore = ledger.endsOf(op);

    try {
      await cancel(op, provider);
    } catch (error) {
      // A cancel has no reply of its own, so its op ends with the failure: it may still run, and a later cancel
      // retries. It is kept in the op's record when that can still be written, so a reattach before the retry reads
      // it, never running.
      const outcome: Outcome = { state: 'failed', failure: { code: CANCEL_FAILED, message: `Exec ${op} may still run: the sandbox runtime could not stop it. ${error instanceof Error ? error.message : String(error)}` } };

      if (running.has(op)) finish(op, outcome);
      else if (ledger.endsOf(op) === endsBefore) conclude(op, outcome, () => keep(op, outcome));
    }
  };

  /**
   * An exec or a prompt that threw: one this process still runs ends failed through finish, which releases it, so a
   * close of its place waits for no end that never comes. The kit answers any other.
   */
  const guarded = async (request: ExecRequest | PromptRequest, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (!running.has(request.op)) throw error;
      finish(request.op, { state: 'failed', failure: { code: 'runtime_failed', message: `Runtime sandbox could not carry out ${request.type} of ${request.op}: ${error instanceof Error ? error.message : String(error)}` } });
    }
  };

  return {
    /** Runs an exec in `current`'s sandbox, answering a repeated id with its outcome. */
    exec: (request: ExecRequest, current: Ready): Promise<void> => guarded(request, () => exec(request, current)),
    guarded,
    claim,
    finish,
    replay,
    accept,
    cancel: cancelGuarded,
    /** Marks each op of `ops` this process runs cancelled, and gives what resolves once each has ended. */
    stopIn: (ops: ReadonlyArray<{ op: OpId }>): Array<Promise<void>> => ops.flatMap(({ op }) => {
      const run = running.get(op);

      if (run === undefined) return [];
      journal.cancel(op);

      return [run.ended];
    }),
    /**
     * Ends each op of `handle` this process answers but no live process runs, now that its sandbox is gone: with the end
     * its runner recorded since this process last looked, or cancelled.
     */
    endFollowersOf(handle: string): void {
      for (const [op, follower] of followers) if (follower.handle === handle) conclude(op, journal.exec(op)?.outcome ?? { state: 'cancelled' });
    },
    /** `op`'s state as `alive` reports it: the end this process could not journal stands in for its record's. */
    reported: (op: OpId, record: ExecRecord): OpState => reported(ledger.unkept(op) ?? stateOf({ op, ...record })),
    /** Whether this process runs, follows or stops `op`, or the journal holds or may hold it: it then has its end. */
    holds: (op: OpId): boolean => running.has(op) || followers.has(op) || pendingStops.has(op) || ledger.unkept(op) !== undefined || journal.exec(op) !== undefined,
  };
}

export type ExecOperations = ReturnType<typeof execOperations>;
