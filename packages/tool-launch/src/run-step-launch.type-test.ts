/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { ToolLauncher } from './run-step-launch.js';

/** A launcher a factory in another module returns, with its return type inferred: the conformance suite never ran on it. */
declare const madeElsewhere: (launch: Parameters<ToolLauncher>[0]) => ReturnType<ToolLauncher>;

// @ts-expect-error only `toolLauncher`, which an adapter the conformance suite runs on calls, makes a ToolLauncher
export const unminted: ToolLauncher = madeElsewhere;
