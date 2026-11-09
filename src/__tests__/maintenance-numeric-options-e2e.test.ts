import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('knowledge CLI numeric options', () => {
  it.each(['abc', 'NaN', 'Infinity', '0.2abc'])('rejects threshold %s before maintenance', (value) => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'recall', 'maintenance', '--prune', '--threshold', value], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('--threshold must be a finite number');
  });

  it('accepts a finite threshold', () => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'recall', 'maintenance', '--prune', '--threshold', '0.2'], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBeNull();
    expect(result.stdout + result.stderr).not.toContain('--threshold must be a finite number');
  });
});
