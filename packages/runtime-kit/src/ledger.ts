import { boundedStdout, type OpId, type OpState, type RuntimeMessage } from '@teamai/runtime-protocol';

/** How an operation ended: any state it retains but `running`. */
export type OpEnd = Exclude<OpState, { state: 'running' }>;

/** Why teamai's cancel of an op came before the op ran in this process, which its request reads once it comes. */
export type CancelMark = 'cancelled-unseen' | 'cancel-unread';

/**
 * Every line a runtime writes goes through its ledger, which counts each operation's ends, so the request loop never
 * writes a second end for a request whose handler already wrote one and then threw. It also holds what this process
 * knows of each op: the ones it runs, whose end it owns, the place each was accepted in, and a cancel that came first.
 * `TRun` is what the runtime keeps of an op it runs, such as the thread it follows.
 */
export interface OpLedger<TRun = unknown> {
  /** Writes `message`, counting it when it ends its operation. */
  write(message: RuntimeMessage): void;
  /** Writes the one event teamai reads as how `ended`'s operation ended. */
  end(ended: OpEnd): void;
  /** How many ends of `op` this process wrote: a repeated op is answered with its end again. */
  endsOf(op: OpId): number;
  /**
   * Ends `ended`'s op with its true outcome once `keep` journaled it. An end `keep` cannot journal is answered all the
   * same, since the op did end that way and teamai keeps it as soon as it reads it: this process remembers it
   * (`unkept`) until the op runs here again or its place closes, and says so in a notice about the op. A `keep` that
   * returns no promise is answered before `settle` returns; the promise never rejects.
   */
  settle(ended: OpEnd, keep: () => Promise<void> | void): Promise<void>;
  /** The end of `op` this process answered and could not journal, which stands in for its record's. */
  unkept(op: OpId): OpEnd | undefined;
  /** Forgets `op`'s unkept end: it runs here again, or its place closed. */
  forget(op: OpId): void;
  /**
   * Runs `op` in this process with `run`, owning its end until `finish` or `abandon`: a request for it meanwhile joins
   * it. Its unkept end still stands in for its record until the runtime forgets it.
   */
  begin(op: OpId, run: TRun): void;
  /** What the runtime keeps of `op` while this process runs it. */
  running(op: OpId): TRun | undefined;
  /**
   * Ends `op` with `ended` through `settle` when `run` still runs it: the first end any source of an op gives, such as
   * its follow, a stop or a deadline, is its only one, and a source of an earlier run of it ends nothing.
   */
  finish(end: { op: OpId; run: TRun; ended: OpEnd; keep: () => Promise<void> | void }): Promise<void>;
  /** Stops running `op` with no end, when `run` still runs it: a later request runs it again. */
  abandon(op: OpId, run: TRun): void;
  /** Remembers that `op` runs in the place `handle`, as its request says. */
  locate(op: OpId, handle: string): void;
  /** The place `op` was accepted in, or a request of it named, in this process. */
  handleOf(op: OpId): string | undefined;
  /** Remembers why teamai's cancel of `op` came before `op` ran here. */
  mark(op: OpId, why: CancelMark): void;
  /** Why a cancel of `op` came first, once: the request that runs `op` takes it. */
  takeMark(op: OpId): CancelMark | undefined;
  /** Whether this process runs `op`, accepted it, or holds a cancel of it. */
  knows(op: OpId): boolean;
}

/** The events that end an operation: an open's `ready` or `failed`, an exec's, prompt's or wake's outcome. */
const ENDS: ReadonlySet<string> = new Set(['ready', 'exited', 'finished', 'woken', 'cancelled', 'failed']);

/** The line that says how `ended`'s operation ended: an exec's stdout within protocol 1's bound. */
function endLine(ended: OpEnd): RuntimeMessage {
  const { op } = ended;

  switch (ended.state) {
    case 'finished': {
      // Every field of a finished prompt goes out as it ended, so one the protocol adds needs no change here.
      const { state: _state, ...finished } = ended;

      return { ...finished, event: 'finished' };
    }

    case 'cancelled':
      return { op, event: 'cancelled' };
    case 'failed':
      return { op, event: 'failed', failure: ended.failure };
    case 'exited':
      return { op, event: 'exited', code: ended.code, stdout: boundedStdout(ended.stdout) };
    default: {
      const unhandled: never = ended;

      return unhandled;
    }
  }
}

/** A ledger over `write`, the stdout of the runtime `name`, as its messages name it (`t3` in "Runtime t3 …"). */
export function opLedger<TRun = unknown>({ name, write }: { name: string; write: (message: RuntimeMessage) => void }): OpLedger<TRun> {
  const ends = new Map<OpId, number>();
  const unkept = new Map<OpId, OpEnd>();
  const runs = new Map<OpId, TRun>();
  const handles = new Map<OpId, string>();
  const marks = new Map<OpId, CancelMark>();
  /** Ops this process ran, whether or not it still does: a line that names one is no stranger's. */
  const seen = new Set<OpId>();

  const counted = (message: RuntimeMessage): void => {
    if ('op' in message && 'event' in message && message.op !== undefined) {
      if (ENDS.has(message.event)) ends.set(message.op, (ends.get(message.op) ?? 0) + 1);

      if (message.event === 'accepted' && 'handle' in message && message.handle !== undefined) handles.set(message.op, message.handle);
    }

    write(message);
  };

  const settle = (ended: OpEnd, keep: () => Promise<void> | void): Promise<void> => {
    const answer = (): void => {
      unkept.delete(ended.op);
      counted(endLine(ended));
    };

    const answerUnkept = (why: string): void => {
      unkept.set(ended.op, ended);
      counted({ event: 'notice', op: ended.op, message: `Runtime ${name} could not record how ${ended.op} ended (${why}), so only this runtime process remembers that end, until the place closes.` });
      counted(endLine(ended));
    };

    // A record kept at once is answered before settle returns, so what the runtime does next, such as releasing the
    // op or answering its place's close, follows the end, as a runtime with a synchronous journal expects.
    try {
      const kept = keep();

      if (kept instanceof Promise) return kept.then(answer, (error: Error | string) => answerUnkept(error instanceof Error ? error.message : String(error)));
      answer();
    } catch (error) {
      answerUnkept(error instanceof Error ? error.message : String(error));
    }

    return Promise.resolve();
  };

  return {
    write: counted,
    end: (ended) => counted(endLine(ended)),
    endsOf: (op) => ends.get(op) ?? 0,
    settle,
    unkept: (op) => unkept.get(op),
    forget: (op) => { unkept.delete(op); },
    begin(op, run) {
      runs.set(op, run);
      seen.add(op);
    },
    running: (op) => runs.get(op),
    async finish({ op, run, ended, keep }) {
      if (runs.get(op) !== run) return;
      runs.delete(op);
      await settle(ended, keep);
    },
    abandon(op, run) {
      if (runs.get(op) === run) runs.delete(op);
    },
    locate: (op, handle) => { handles.set(op, handle); },
    handleOf: (op) => handles.get(op),
    mark: (op, why) => { marks.set(op, why); },
    takeMark(op) {
      const why = marks.get(op);
      marks.delete(op);

      return why;
    },
    knows: (op) => runs.has(op) || handles.has(op) || marks.has(op) || seen.has(op),
  };
}
