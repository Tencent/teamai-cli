import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/attempt-reattach', { filename: 'src/workflow/runtimes/attempt.ts' });

const MESSAGE = 'Read a reattach through the attempt\'s reattached(recorded, handle)';

rule.invalid('rejects a reattach the attempt reads outside reattached', `export const live = async (runtime: { reattach: (handle: string) => Promise<unknown> }, handle: string) => {
  const seen = await runtime.reattach(handle);
  return seen;
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects one elsewhere under src/workflow, as a cancel\'s', `export async function stop(runtime: { reattach: (handle: string) => Promise<unknown> }, handle: string) {
  return runtime.reattach(handle);
}`, undefined, { filename: 'src/workflow/runtimes/cancelled.ts' });

rule.valid('allows the attempt\'s reattached', `export const attempt = (runtime: { reattach: (handle: string) => Promise<unknown> }) => {
  const reattached = async (handle: string) => {
    const seen = await runtime.reattach(handle);
    return seen;
  };
  return reattached;
};`);

rule.valid('allows the composed runtime, which reattaches its parts', `export const reattach = async (outer: { reattach: (handle: string) => Promise<unknown> }, handle: string) => outer.reattach(handle);`, { filename: 'src/workflow/runtimes/composed.ts' });

rule.valid('allows a runtime package outside src/workflow', `export const reattach = async (inner: { reattach: (handle: string) => Promise<unknown> }, handle: string) => inner.reattach(handle);`, { filename: 'packages/runtime-sandbox/src/runtime.ts' });
