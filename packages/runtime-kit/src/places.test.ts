import { describe, expect, it } from 'vitest';
import { placeWork } from './places.js';

describe('the work under way in a place', () => {
  it('is waited for until it settles, and a place with none is not', async () => {
    const places = placeWork();
    let done = (): void => {};
    const opening = places.track('h-1', new Promise<void>((resolve) => { done = resolve; }));

    expect(await places.settled('h-1', 50)).toBe(false);
    expect(await places.settled('h-2', 50)).toBe(true);
    done();
    await opening;

    expect(await places.settled('h-1', 50)).toBe(true);
  });

  it('counts work that failed as settled', async () => {
    const places = placeWork();

    await expect(places.track('h-1', Promise.reject(new Error('T3 Code did not answer')))).rejects.toThrow('T3 Code did not answer');

    expect(await places.settled('h-1', 50)).toBe(true);
  });

  it('remembers a place the person released until it is opened again', () => {
    const places = placeWork();

    places.release('h-1');
    expect(places.isReleased('h-1')).toBe(true);
    places.reopen('h-1');

    expect(places.isReleased('h-1')).toBe(false);
  });
});
