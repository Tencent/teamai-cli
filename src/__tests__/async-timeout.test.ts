import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../utils/async.js';

describe('withTimeout', () => {
  it('returns the promise value when it resolves before the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 5000, 'boom');
    expect(result).toBe('ok');
  });

  it('rejects with the timeout message when the promise exceeds the timeout', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, 'timed out')).rejects.toThrow('timed out');
  });

  it('propagates the promise rejection when it rejects before the timeout', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('push failed')), 5000, 'timed out'),
    ).rejects.toThrow('push failed');
  });

  // ── The actual bug fix: a plain Promise.race leaves the losing setTimeout
  //    pending, pinning the event loop for the full timeoutMs after a fast
  //    success. withTimeout must clear it so the process can exit promptly.
  it('clears the timeout timer when the promise resolves first (no event-loop leak)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      const result = await withTimeout(Promise.resolve('ok'), 5000, 'boom');
      expect(result).toBe('ok');

      // Exactly one timer was scheduled by withTimeout ...
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const scheduledTimer = setTimeoutSpy.mock.results[0].value;
      // ... and it was cleared once the push settled, so it cannot pin the loop.
      expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduledTimer);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('clears the timeout timer when the promise rejects first', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      await expect(
        withTimeout(Promise.reject(new Error('nope')), 5000, 'boom'),
      ).rejects.toThrow('nope');

      const scheduledTimer = setTimeoutSpy.mock.results[0].value;
      expect(clearTimeoutSpy).toHaveBeenCalledWith(scheduledTimer);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('does not keep the process alive after a fast success', async () => {
    // A regression here would leave a pending 5s timer: even though the call
    // returns immediately, the Node process would not exit for ~5s. We assert
    // the handles clear by checking no extra timer survives the await.
    const before = process.getActiveResourcesInfo?.() ?? [];
    const baselineTimers = before.filter((t) => t === 'Timeout').length;

    await withTimeout(Promise.resolve('ok'), 5000, 'boom');

    const after = process.getActiveResourcesInfo?.() ?? [];
    const afterTimers = after.filter((t) => t === 'Timeout').length;
    expect(afterTimers).toBe(baselineTimers);
  });
});
