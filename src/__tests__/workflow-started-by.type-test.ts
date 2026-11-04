/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { InvokeCaller, WorkflowClient } from '../workflow/protocol.js';

declare const client: WorkflowClient;
declare const caller: InvokeCaller;

/** Every start says who starts it, so no automatic start is recorded as a person's by default. */
export const byPerson = client.start('review', { caller, startedBy: 'person' });

export const byCli = client.start('review', { caller, startedBy: 'cli' });

// @ts-expect-error a start that names no starter does not compile
export const unnamed = client.start('review', { caller });

// @ts-expect-error an agent is recorded from the caller's evidence, never from startedBy
export const byAgent = client.start('review', { caller, startedBy: 'agent' });
