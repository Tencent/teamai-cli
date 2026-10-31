import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WINDOWS_TESTS } from './helpers/windows-tests.js';
import { WINDOWS_TEST_FILES } from '../../oxlint-plugin-teamai/rules/windows-test-safety.js';

/**
 * Keep the legacy text-only checks until the oxlint rule has equivalent AST
 * coverage for fixtures and rendered hook strings. The rule owns process and
 * filesystem calls; this scanner retains shebang and string safeguards.
 */
const POSIX_ONLY: readonly { readonly pattern: RegExp; readonly unless?: RegExp }[] = [
  { pattern: /#!\/(?:usr\/)?bin\// },
  // A pinned POSIX rendering is safe when the file pins its rendered platform
  // or carries the matching Windows command form.
  { pattern: /\bbash -lc\b/, unless: /vi\.spyOn\(process, 'platform'|\bcommandWindows\b/ },
  { pattern: /\bsh -c\b/ },
];

describe('Windows test list', () => {
  it('names files that exist, sorted, without duplicates, and includes the matrix', async () => {
    for (const file of WINDOWS_TESTS) await expect(readFile(file, 'utf8')).resolves.toBeTypeOf('string');
    expect([...WINDOWS_TESTS].sort()).toEqual([...WINDOWS_TESTS]);
    expect(new Set(WINDOWS_TESTS).size).toBe(WINDOWS_TESTS.length);
    expect(WINDOWS_TEST_FILES).toEqual(WINDOWS_TESTS);
    expect(WINDOWS_TESTS).toContain('src/__tests__/locate-matrix.test.ts');
  });

  for (const file of WINDOWS_TESTS) {
    it(`${file} keeps fixture-only POSIX constructs platform-pinned`, async () => {
      const source = await readFile(file, 'utf8');
      const hits = POSIX_ONLY.filter(({ pattern, unless }) => pattern.test(source) && !(unless?.test(source) ?? false));
      expect(hits.map(({ pattern }) => String(pattern))).toEqual([]);
    });
  }
});
