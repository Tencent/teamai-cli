import type { OpId, RuntimeRequest } from '@teamai/runtime-protocol';
import type { RuntimeHandlers } from './serve.js';

// ─── The requests a runtime is answering ─────────────────
//
//  `serveRuntime` runs each request as it comes and forgets it. A runtime that has to know which ops it is still
//  answering, so a line that names one is dropped rather than answered twice, or that lets the requests in flight end
//  before its process does, wraps its handlers here.
//

export interface Answering {
  /** The handlers to serve: the runtime's own, each counted while it runs. */
  handlers: RuntimeHandlers;
  /** Whether a request of `op` is still being answered in this process. */
  isAnswering(op: OpId): boolean;
  /** Resolves once every request answered so far has ended, whether it resolved or threw. */
  settled(): Promise<void>;
}

/** Counts each request of `handlers` from when it starts until its handler resolves or throws. */
export function answering(handlers: RuntimeHandlers): Answering {
  const { wake } = handlers;
  const inFlight = new Map<OpId, number>();
  const pending = new Set<Promise<void>>();

  const counted = async (request: RuntimeRequest, handle: () => Promise<void>): Promise<void> => {
    const op = 'op' in request ? request.op : undefined;

    if (op !== undefined) inFlight.set(op, (inFlight.get(op) ?? 0) + 1);
    const answered = handle();
    pending.add(answered);

    try {
      await answered;
    } finally {
      pending.delete(answered);

      if (op !== undefined) {
        const left = (inFlight.get(op) ?? 1) - 1;

        if (left > 0) inFlight.set(op, left);
        else inFlight.delete(op);
      }
    }
  };

  return {
    handlers: {
      init: (request) => counted(request, () => handlers.init(request)),
      open: (request) => counted(request, () => handlers.open(request)),
      exec: (request) => counted(request, () => handlers.exec(request)),
      prompt: (request) => counted(request, () => handlers.prompt(request)),
      cancel: (request) => counted(request, () => handlers.cancel(request)),
      collect: (request) => counted(request, () => handlers.collect(request)),
      reattach: (request) => counted(request, () => handlers.reattach(request)),
      close: (request) => counted(request, () => handlers.close(request)),
      ...(wake && { wake: (request) => counted(request, () => wake(request)) }),
    },
    isAnswering: (op) => inFlight.has(op),
    async settled() {
      await Promise.allSettled(pending);
    },
  };
}
