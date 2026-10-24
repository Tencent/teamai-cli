/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { LocalConfig } from '../types.js';
import { startRun, withRun } from '../workflow/engine.js';
import { cancelRun, respondToHitl, retryStep } from '../workflow/run-controls.js';

declare const config: LocalConfig;
declare const secrets: Record<string, string>;

/** Each operation that writes a run masks with the secrets its command resolved, so a caller passes them. */
export const started = startRun(config, 'build', {}, { secrets });
export const retried = retryStep(config, 'r00000000', secrets, 'step');

// @ts-expect-error a start that resolved no secrets cannot write the run
export const unmaskedStart = startRun(config, 'build', {}, {});
// @ts-expect-error inputs are not the start's options
export const inputsAsOptions = startRun(config, 'build', { ticket: 'x' });
// @ts-expect-error a retry that resolved no secrets cannot write the run
export const unmaskedRetry = retryStep(config, 'r00000000', 'step');
// @ts-expect-error a cancel that resolved no secrets cannot write the run
export const unmaskedCancel = cancelRun(config, 'r00000000');
// @ts-expect-error an answer that resolved no secrets cannot write the run
export const unmaskedAnswer = respondToHitl(config, 'r00000000', { step: 'ask', choice: 'yes', channel: 'cli', agent: false });
// @ts-expect-error an operation under the run lock masks with the secrets resolved before it
export const unmaskedWrite = withRun(config, 'r00000000', async () => ({ envelope: { data: {} }, save: false }));
