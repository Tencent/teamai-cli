import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(import.meta.dirname, '..', '..');

/**
 * A default folder is hashed with each file's executable bit, and an npm install on Windows drops it, so a default that
 * ships an executable file hashes differently there and a run of it cannot be claimed across systems (#1787). The git
 * index holds the bit on every system, so this reads it there rather than from the checkout.
 */
describe('teamai\'s shipped workflow and hook files', () => {
  it('hold no executable file', () => {
    const staged = execFileSync('git', ['ls-files', '--stage', '--', 'workflows', 'hooks'], { cwd: repoRoot, encoding: 'utf8' });
    const executable = staged.split('\n').flatMap((line) => (line.startsWith('100755 ') ? [line.slice(line.indexOf('\t') + 1)] : []));

    expect(staged).toContain('workflows/');
    expect(executable).toEqual([]);
  });
});
