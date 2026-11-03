import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MACOS_TESTS } from './helpers/macos-tests.js';

describe('macOS test list', () => {
  it('names files that exist, sorted, without duplicates', async () => {
    for (const file of MACOS_TESTS) await expect(readFile(file, 'utf8')).resolves.toBeTypeOf('string');
    expect([...MACOS_TESTS].sort()).toEqual([...MACOS_TESTS]);
    expect(new Set(MACOS_TESTS).size).toBe(MACOS_TESTS.length);
    expect(MACOS_TESTS).toContain('src/__tests__/session-target-id.test.ts');
  });

  it('keeps the git exclude cases CI selects by name', async () => {
    const source = await readFile('src/__tests__/git-exclude.test.ts', 'utf8');
    expect(source).toContain('core.precomposeunicode');
    expect(source).toContain('on a case-insensitive filesystem');
  });
});
