/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { MarkKey } from '../scorers/marks.js';

const run = { kind: 'run', subject: { runId: 'r00000000', step: 'fix', pass: 1 } } as const;
const session = { kind: 'session', subject: { platform: 'claude-code', sessionId: '7c1e' } } as const;
const pushed = { kind: 'team-session', subject: { author: 'alice', name: 'fix-the-retry-loop' } } as const;

export const passKey: MarkKey = { scorer: 'review', subject: run };
export const sessionKey: MarkKey = { scorer: 'review', sourceHash: 'h1', subject: session };
export const pushedKey: MarkKey = { scorer: 'review', sourceHash: 'h1', subject: pushed };

// @ts-expect-error a pass is keyed by scorer and subject, never by rubric
export const passWithRubric: MarkKey = { scorer: 'review', sourceHash: 'h1', subject: run };

// @ts-expect-error a session is keyed by its rubric too
export const sessionWithoutRubric: MarkKey = { scorer: 'review', subject: session };
