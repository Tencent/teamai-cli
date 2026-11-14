import { describe, expect, it } from 'vitest';
import type { OpId, RuntimeRequest } from '@teamai/runtime-protocol';
import { answering } from './answering.js';
import type { RuntimeHandlers } from './serve.js';

const OP = 'op-0123abcd' as OpId;

const prompt = (op: OpId): Extract<RuntimeRequest, { type: 'prompt' }> => ({
  type: 'prompt', op, handle: 'h-1', env: {}, unset: [], credentials: {}, cwd: '/w',
  lease: { step: 's', tool: 'claude', permissions: 'approval-required', interactive: false, prompt: 'p', result: '/w/result.json' },
});

/** Handlers whose prompt waits until the test lets it end, as `end` resolves or `fail` rejects. */
function held() {
  let end = (): void => {};
  let fail = (_: Error): void => {};
  const nothing = async (): Promise<void> => {};
  const handlers: RuntimeHandlers = {
    init: nothing, open: nothing, exec: nothing, cancel: nothing, collect: nothing, reattach: nothing, close: nothing,
    prompt: () => new Promise<void>((resolve, reject) => { end = resolve; fail = reject; }),
  };

  return { handlers, end: () => end(), fail: (error: Error) => fail(error) };
}

describe('the requests a runtime is answering', () => {
  it('counts an op from when its request starts until its handler ends', async () => {
    const runtime = held();
    const tracked = answering(runtime.handlers);

    const answered = tracked.handlers.prompt(prompt(OP));
    expect(tracked.isAnswering(OP)).toBe(true);
    runtime.end();
    await answered;

    expect(tracked.isAnswering(OP)).toBe(false);
  });

  it('stops counting an op whose handler threw, and passes the throw on to the loop that answers it', async () => {
    const runtime = held();
    const tracked = answering(runtime.handlers);

    const answered = tracked.handlers.prompt(prompt(OP));
    runtime.fail(new Error('boom'));

    await expect(answered).rejects.toThrow('boom');
    expect(tracked.isAnswering(OP)).toBe(false);
  });

  it('settles once every request in flight ended', async () => {
    const runtime = held();
    const tracked = answering(runtime.handlers);
    let settled = false;

    void tracked.handlers.prompt(prompt(OP)).catch(() => {});
    void tracked.settled().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    runtime.fail(new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(true);
  });
});
