/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { AttemptSends } from '../workflow/runtimes/attempt.js';

declare const sends: AttemptSends;

/** An attempt holds its runtime with no send, so every exec, setup and prompt reads a stop that found nothing running. */
export const held = sends.runtime;
// @ts-expect-error an attempt cannot exec on its runtime but through AttemptSends, which reads how the step was stopped
export const bareExec = held.exec;
// @ts-expect-error an attempt cannot prompt its runtime but through AttemptSends, which reads how the step was stopped
export const barePrompt = held.prompt;
