import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

describe('batch import concurrency validation through the built CLI', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-batch-concurrency-'));
    fs.writeFileSync(path.join(sandbox, 'repos.yaml'), 'version: 1\nrepos: []\n');
  });

  afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

  function run(args: string[]) {
    const result = spawnSync(process.execPath, [CLI, 'import', '--from-repo-list', 'repos.yaml',
      '--output', path.join(sandbox, 'out'), ...args], {
      cwd: sandbox,
      env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, FORCE_COLOR: '0', TEAMAI_CACHE_DIR: path.join(sandbox, 'cache') },
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: result.stdout + result.stderr };
  }

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '2repos', '9007199254740992', ''])(
    'rejects --concurrency=%s before creating output or cache', (value) => {
      const result = run([`--concurrency=${value}`]);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain('--concurrency must be a positive safe integer');
      expect(result.output).not.toContain('Batch import complete');
      expect(fs.existsSync(path.join(sandbox, 'out'))).toBe(false);
      expect(fs.existsSync(path.join(sandbox, 'cache'))).toBe(false);
    },
  );

  it.each([undefined, '2'])('accepts the default or a positive integer (%s)', (value) => {
    const result = run(value === undefined ? [] : [`--concurrency=${value}`]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Batch import complete: 0 succeeded, 0 failed, 0 skipped');
  });
});
