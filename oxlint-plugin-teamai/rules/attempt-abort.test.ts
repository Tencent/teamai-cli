import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/attempt-abort', { filename: 'src/workflow/steps/x.ts' });

const MESSAGE = 'Pass the step\'s signal to the attempt';

rule.invalid('rejects an abort listener that cancels the attempt', `export const run = async (attempt: { open: () => Promise<void>; cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => { void attempt.cancel(); }, { once: true });
  await attempt.open();
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a listener named by a const whose function stops the attempt', `export const run = async (attempt: { stop: () => Promise<void> }, signal?: AbortSignal) => {
  const stop = (): void => {
    void attempt.stop();
  };
  signal?.addEventListener('abort', stop, { once: true });
};`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a listener whose cancel sits in a function inside it', `export const run = (attempt: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => { setImmediate(() => { void attempt.cancel(); }); });
};`);

rule.invalid('rejects a listener declared as a function', `export function run(attempt: { cancel: () => Promise<void> }, signal: AbortSignal) {
  function onAbort() { void attempt.cancel(); }
  signal.addEventListener('abort', onAbort);
}`);

rule.invalid('rejects it in confined-step.ts', `export const run = (attemptRun: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => attemptRun.cancel());
};`, undefined, { filename: 'src/workflow/confined-step.ts' });

rule.invalid('rejects it anywhere else under src/workflow, as a fleet member\'s', `export const run = (running: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => running.cancel());
};`, undefined, { filename: 'src/workflow/fleet/member.ts' });

rule.valid('allows an abort listener that stops no attempt', `export const wait = (signal: AbortSignal) => new Promise<void>((resolve) => {
  signal.addEventListener('abort', () => resolve(), { once: true });
});`);

rule.valid('allows a listener that calls a stop of its own scope, as setup stops its process', `export const run = (stop: () => Promise<void>, signal: AbortSignal) => {
  const onAbort = (): void => { void stop(); };
  signal.addEventListener('abort', onAbort, { once: true });
};`);

rule.valid('allows another event that cancels the attempt', `export const run = (attempt: { cancel: () => Promise<void> }, socket: EventTarget) => {
  socket.addEventListener('close', () => { void attempt.cancel(); });
};`);

rule.valid('allows the attempt\'s own listener, which owns the step\'s signal', `export const follow = (sends: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => { void sends.cancel(); }, { once: true });
};`, { filename: 'src/workflow/runtimes/attempt.ts' });

rule.valid('allows it outside src/workflow', `export const run = (attempt: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => attempt.cancel());
};`, { filename: 'src/commands/x.ts' });

rule.valid('allows it in a test', `export const run = (attempt: { cancel: () => Promise<void> }, signal: AbortSignal) => {
  signal.addEventListener('abort', () => attempt.cancel());
};`, { filename: 'src/__tests__/x.test.ts' });
