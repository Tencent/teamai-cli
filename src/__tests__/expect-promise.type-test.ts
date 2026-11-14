/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { expect } from 'vitest';

declare const stopped: Promise<string[]>;

export async function compared(): Promise<void> {
  // @ts-expect-error a Promise compared with a matcher compares the Promise, not what it settles with: await it first
  expect(stopped, 'fake agents left running').toEqual([]);
  // @ts-expect-error the same through not
  expect(stopped).not.toContain('claude');
  await expect(stopped).resolves.toEqual([]);
  await expect(stopped).rejects.toThrow('gone');
  expect(await stopped).toEqual([]);
  expect(stopped).toBe(stopped);
  expect(stopped).toBeInstanceOf(Promise);
}
