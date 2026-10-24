import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WINDOWS_TESTS } from './helpers/windows-tests.js';

/**
 * What makes a test file POSIX-only on a static read: a spawned POSIX shell, a
 * shebang fixture, a pinned POSIX hook rendering (Windows renders the Git Bash
 * path, `getHookShellCommand`), and mode bits or links. A file that states
 * `commandWindows` may pin the POSIX `command`: Codex keeps `bash -lc` on every
 * platform and carries the Windows form beside it.
 */
const POSIX_ONLY: readonly { readonly pattern: RegExp; readonly unless?: RegExp }[] = [
  { pattern: /\bspawn(?:Sync)?\(\s*['"](?:ba|z)?sh['"]/ },
  { pattern: /\bexec(?:File)?(?:Sync)?\(\s*['"](?:ba|z)?sh\b/ },
  { pattern: /#!\/(?:usr\/)?bin\// },
  // A pinned POSIX rendering is safe when the file pins the platform it renders
  // for, or states `commandWindows` (the Windows form of that same command).
  { pattern: /\bbash -lc\b/, unless: /vi\.spyOn\(process, 'platform'|\bcommandWindows\b/ },
  { pattern: /\bsh -c\b/ },
  { pattern: /\bchmod(?:Sync)?\(/ },
  { pattern: /\bsymlink(?:Sync)?\(/ },
];

describe('Windows test list', () => {
  it('names files that exist, sorted, without duplicates, and includes the matrix', async () => {
    for (const file of WINDOWS_TESTS) await expect(readFile(file, 'utf8')).resolves.toBeTypeOf('string');
    expect([...WINDOWS_TESTS].sort()).toEqual([...WINDOWS_TESTS]);
    expect(new Set(WINDOWS_TESTS).size).toBe(WINDOWS_TESTS.length);
    expect(WINDOWS_TESTS).toContain('src/__tests__/locate-matrix.test.ts');
  });

  for (const file of WINDOWS_TESTS) {
    it(`${file} has no POSIX-only construct`, async () => {
      const source = await readFile(file, 'utf8');
      const hits = POSIX_ONLY.filter(({ pattern, unless }) => pattern.test(source) && !(unless?.test(source) ?? false));
      expect(hits.map(({ pattern }) => String(pattern))).toEqual([]);
    });
  }
});
