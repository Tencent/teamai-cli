/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { respondProvenance, type Provenance } from '../workflow/run-controls.js';

/** A provenance is decided from where the answer came in. */
export const decided: Provenance = respondProvenance({ kind: 'dashboard', caller: { tty: false, evidence: { kind: 'none' } } });

// @ts-expect-error a same-shaped literal is not a Provenance
export const forged: Provenance = { channel: 'dashboard', driver: undefined, agent: false, agentCause: undefined };
