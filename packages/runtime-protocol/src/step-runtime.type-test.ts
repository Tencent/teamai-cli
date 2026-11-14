/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { Can } from './protocol.js';
import { newOpId, type StepRuntime } from './step-runtime.js';

const failed = { kind: 'failed', failure: { code: 'runtime_protocol', message: 'stub' } } as const;

/** A runtime package implements the interface from the protocol alone, with nothing of teamai's src/. */
export const stub = {
  name: 'stub',
  init: async () => ({ ok: true, can: { exec: true }, launchesAgents: false }),
  open: async () => failed,
  exec: async () => failed,
  prompt: async () => ({ kind: 'cancelled' }),
  cancel: async () => {},
  collect: async () => ({ ok: true }),
  reattach: async () => ({ kind: 'gone' }),
  close: async () => ({ ok: true }),
  dispose: async () => {},
} satisfies StepRuntime;

/** The can type is a parameter, so teamai answers its own wider can through the same interface. */
export const wider: StepRuntime<Can & { workflow?: true }> = { ...stub, init: async () => ({ ok: true, can: { workflow: true }, launchesAgents: false }) };

// @ts-expect-error the protocol's can has no `workflow`: only a runtime typed with a wider can answers it
export const narrow: StepRuntime = { ...stub, init: async () => ({ ok: true, can: { workflow: true }, launchesAgents: false }) };

export const op = newOpId();
