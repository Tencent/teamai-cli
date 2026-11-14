import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimePrompter } from '../workflow/steps/runtime-steps.js';
import type { AttemptRun } from '../workflow/runtimes/attempt.js';
import { RunIdSchema } from '../workflow/store.js';
import type { PromptEnd } from '@teamai/runtime-protocol/step-runtime';

/**
 * An attempt on a runtime that launches agents its own way. Like the real one, `cancel` stops only the prompt it has
 * sent: `beforeSend` runs first, as an open or a reattach does, and a prompt not cancelled finishes on the next turn.
 */
function promptOnlyRun({ duringOpen, beforeSend, result = { output: { ok: true } }, stopped }: { duringOpen?: () => void; beforeSend?: () => Promise<void>; result?: Extract<PromptEnd, { kind: 'finished' }>['result']; stopped?: Extract<PromptEnd, { kind: 'finished' }>['stopped'] } = {}): { run: AttemptRun; cancels: () => number } {
  let sent: ((end: PromptEnd) => void) | undefined;
  let cancels = 0;

  const run: AttemptRun = {
    open: async () => {
      duringOpen?.();

      return { ok: true, handle: 'h-1' };
    },
    exec: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'prompt only' } }),
    setup: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'prompt only' } }),
    prompt: async (_request, events) => {
      await beforeSend?.();

      return new Promise<PromptEnd>((resolve) => {
        sent = resolve;
        events.onAccepted?.({});
        setImmediate(() => resolve({ kind: 'finished', session: { tool: 'claude', id: 's-1' }, result, ...(stopped && { stopped }) }));
      });
    },
    cancel: async () => {
      if (!sent) return;
      cancels += 1;
      sent({ kind: 'cancelled' });
    },
    stop: async () => run.cancel(),
    collect: async () => undefined,
    close: async () => {},
    stopLeftSetup: async () => undefined,
    closeForRemadeFolder: async () => undefined,
    stopLeftOperation: async () => undefined,
  };

  return { run, cancels: () => cancels };
}

describe('a prompt step on a runtime that launches agents its own way', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-runtime-prompter-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = { worktree: '/work', readonly: [], result: '/work/out', runDir: '/work/scratch', toolHome: {} };

  it('is cancelled when the driver aborts while the place opens', async () => {
    const controller = new AbortController();
    const { run, cancels } = promptOnlyRun({ duringOpen: () => controller.abort() });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, controller.signal);

    expect(ran).toMatchObject({ exitCode: 143, failure: { code: 'tool_failed' } });
    expect(cancels()).toBe(1);
  });

  it('stops at its timeout when the timeout passes before the prompt is sent', async () => {
    const { run, cancels } = promptOnlyRun({ beforeSend: () => new Promise((resolve) => setTimeout(resolve, 50)) });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), timeoutMs: 1, secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 143, stoppedBy: 'timeout' });
    expect(cancels()).toBe(1);
  });

  it.each(['budget', 'timeout'] as const)('stops at the limit, %s, at which the runtime says it stopped the tool', async (stopped) => {
    const { run } = promptOnlyRun({ stopped });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 0, session: 's-1', stoppedBy: stopped });
  });

  it('fails a tool the runtime stopped at its idle limit, as teamai\'s own launch fails one', async () => {
    const { run } = promptOnlyRun({ stopped: 'idle' });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), idleTimeoutMs: 30_000, secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 1, session: 's-1', failure: { code: 'tool_failed', message: 'claude printed nothing for 30s, longer than its idle limit (workflows.idle_timeout). Raise the limit if this tool works silently for longer.' } });
    expect('stoppedBy' in ran).toBe(false);
  });

  it('fails a tool the runtime stopped at an idle limit of its own, with no limit of teamai\'s to name', async () => {
    const { run } = promptOnlyRun({ stopped: 'idle' });

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 1, failure: { code: 'tool_failed', message: 'claude printed nothing for longer than the step runtime\'s own idle limit. Raise that limit if this tool works silently for longer.' } });
  });

  it('asks the runtime to stop the tool at the step\'s budget, timeout and idle limit, and ends the step at the limit the runtime stopped it at', async () => {
    const leases: unknown[] = [];
    const run: AttemptRun = {
      ...promptOnlyRun().run,
      prompt: async (request) => {
        leases.push(request.lease);

        return { kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: {}, usage: { input: 900, output: 200 }, stopped: 'budget' };
      },
    };

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined })
      .run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {}, budget: 1000, timeoutMs: 60_000, idleTimeoutMs: 30_000 }, undefined);

    expect(leases).toEqual([expect.objectContaining({ limits: { budget: { tokens: 1000 }, timeoutMs: 60_000, idleMs: 30_000 } })]);
    expect(ran).toMatchObject({ exitCode: 0, session: 's-1', stoppedBy: 'budget', tokens: { input: 900, output: 200 } });
  });

  it('reports the model the tool ran on and what it said the run cost, as the runtime gives them', async () => {
    const run: AttemptRun = {
      ...promptOnlyRun().run,
      prompt: async () => ({ kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { ok: true } }, model: 'claude-sonnet-4-5', cost: { amount: 0.12, unit: 'USD' } }),
    };

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined })
      .run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 0, session: 's-1', model: 'claude-sonnet-4-5', cost: { amount: 0.12, unit: 'USD' } });
  });

  it('says it started fresh when the runtime resumed no session, even when its place could not be collected', async () => {
    const { run } = promptOnlyRun();
    const uncollectable: AttemptRun = { ...run, collect: async () => ({ code: 'runtime_failed', message: 'The place could not be collected.' }) };

    const ran = await runtimePrompter(uncollectable, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), resume: 'earlier-session', secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 1, session: 's-1', startedFresh: true });
  });

  it('takes the session of an instance step that the runtime reports under the tool the instance extends', async () => {
    const { run } = promptOnlyRun();

    const ran = await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'acme-claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath: path.join(dir, 'result.json'), secrets: {} }, undefined);

    expect(ran).toMatchObject({ exitCode: 0, session: 's-1' });
  });

  it('masks a secret that the runtime result echoes in the result file teamai writes', async () => {
    const { run } = promptOnlyRun({ result: { output: { note: 'signed in with prompter-secret-7d2e' }, failure: { code: 'tool_failed', message: 'denied for prompter-secret-7d2e' } } });
    const resultPath = path.join(dir, 'result.json');

    await runtimePrompter(run, { view, runId: RunIdSchema.parse('r0123abcd'), step: 'review', tool: 'claude', provided: [], unset: [], credentials: {}, setUp: async () => undefined }).run('claude', { prompt: 'Review.', expected: undefined, cwd: dir, resultPath, secrets: { TOY_TEAM: 'prompter-secret-7d2e' } }, undefined);
    const written = fs.readFileSync(resultPath, 'utf8');

    expect(written).not.toContain('prompter-secret-7d2e');
    expect(JSON.parse(written)).toMatchObject({ output: { note: expect.stringContaining('signed in with') } });
  });
});
