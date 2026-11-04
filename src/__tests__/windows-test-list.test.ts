import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WINDOWS_TESTS } from './helpers/windows-tests.js';

describe('Windows test list', () => {
  it('names files that exist, sorted, without duplicates, and includes the matrix', async () => {
    for (const file of WINDOWS_TESTS) await expect(readFile(file, 'utf8')).resolves.toBeTypeOf('string');
    expect([...WINDOWS_TESTS].sort()).toEqual([...WINDOWS_TESTS]);
    expect(new Set(WINDOWS_TESTS).size).toBe(WINDOWS_TESTS.length);
    expect(WINDOWS_TESTS).toContain('src/__tests__/locate-matrix.test.ts');
  });

});
