import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeTmpdir } from './helpers/assert-safe-tmpdir.js';

let sandbox: string;
beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tmpdir-safety-')); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('test temporary directory safety', () => {
  it('allows a temporary directory outside every checkout', () => {
    expect(() => assertSafeTmpdir(sandbox)).not.toThrow();
  });

  it.each(['directory', 'file'])('refuses a temporary directory inside a checkout with a .git %s', (kind) => {
    const repo = path.join(sandbox, 'repo');
    const tmp = path.join(repo, 'nested', 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    if (kind === 'directory') fs.mkdirSync(path.join(repo, '.git'));
    else fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/worktrees/linked\n');

    expect(() => assertSafeTmpdir(tmp)).toThrow(/TMPDIR.*inside.*Git checkout/);
    expect(() => assertSafeTmpdir(tmp)).toThrow(/TMPDIR, TMP and TEMP/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('checks the real target of a symlinked temporary directory', () => {
    const repo = path.join(sandbox, 'repo');
    const tmp = path.join(repo, 'tmp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    const link = path.join(sandbox, 'tmp-link');
    fs.symlinkSync(tmp, link, 'dir');
    expect(() => assertSafeTmpdir(link)).toThrow(/Git checkout/);
  });

  it('also refuses the checkout root itself', () => {
    fs.mkdirSync(path.join(sandbox, '.git'));
    expect(() => assertSafeTmpdir(sandbox)).toThrow(/Git checkout/);
  });
});

it.each(['vitest.config.ts', 'vitest.e2e.config.ts'])('%s fails before later setup or worker writes', (name) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const repo = path.join(sandbox, 'checkout');
  const tmp = path.join(repo, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(repo, '.git'), 'gitdir: /elsewhere/worktrees/linked\n');
  const marker = path.join(sandbox, 'unsafe-write');
  const later = path.join(sandbox, 'later-setup.ts');
  fs.writeFileSync(later, `import fs from 'node:fs'; export default () => fs.writeFileSync(${JSON.stringify(marker)}, 'setup ran');`);
  const probe = path.join(sandbox, 'probe.test.ts');
  fs.writeFileSync(probe, "it('must never run', () => {});");
  const config = path.join(sandbox, 'probe.config.ts');
  const pattern = probe.split(path.sep).join('/');
  fs.writeFileSync(config, `import base from ${JSON.stringify(path.join(root, name))};
export default { ...base, test: { ...base.test, include: [${JSON.stringify(pattern)}],
  setupFiles: [], globals: true, maxWorkers: 1, retry: 0,
  globalSetup: [...base.test.globalSetup, ${JSON.stringify(later)}] } };`);
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
    cwd: root, env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('inside the Git checkout');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.readdirSync(tmp)).toEqual([]);
}, 30_000);
