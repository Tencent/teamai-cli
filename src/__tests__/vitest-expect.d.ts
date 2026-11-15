import type { Assertion } from '@vitest/expect';

/**
 * A matcher on a Promise compares the Promise, not what it settles with, so `expect(stopLeft()).toEqual([])` passes or
 * fails for the wrong reason once `stopLeft` turns async. On a Promise, `expect` offers only `resolves`, `rejects` and
 * the identity matchers; await the Promise to compare its value. `any` keeps every matcher.
 */
type PromiseAssertion<T> = Pick<Assertion<T>, 'resolves' | 'rejects' | 'toBe' | 'toBeInstanceOf'> & { not: Pick<Assertion<T>, 'toBe' | 'toBeInstanceOf'> };

declare module '@vitest/expect' {
  interface ExpectStatic {
    <T extends PromiseLike<unknown>>(actual: T, message?: string): 0 extends 1 & T ? Assertion<T> : PromiseAssertion<T>;
  }
}
