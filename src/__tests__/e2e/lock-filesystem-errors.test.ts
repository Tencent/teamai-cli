import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('real CLI lock filesystem errors (#999)', () => {
  it('env set reports a parent-file error instead of waiting for a competing writer', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lock-error-'));
    const home = path.join(sandbox, 'home');
    const secrets = path.join(home, '.teamai', 'secrets');
    fs.mkdirSync(path.dirname(secrets), { recursive: true });
    fs.writeFileSync(secrets, 'keep');
    const run = () => spawnSync(process.execPath, [cli, 'env', 'set', 'TEST_TOKEN', '--global', '--from-env', 'TEST_TOKEN'], {
      cwd: sandbox,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const result = run();
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain(`Cannot acquire lock ${path.join(secrets, 'machine.json.lock')}:`);
    expect(output).toMatch(/EEXIST|ENOTDIR/);
    expect(output).not.toContain('Another teamai command is changing');
    expect(fs.readFileSync(secrets, 'utf8')).toBe('keep');

    fs.unlinkSync(secrets);
    const retry = run();
    expect(retry.error).toBeUndefined();
    expect(retry.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(secrets, 'machine.json'), 'utf8'))).toEqual({ TEST_TOKEN: { env: 'TEST_TOKEN', kind: 'secret' } });
    expect(fs.existsSync(path.join(secrets, 'machine.json.lock'))).toBe(false);
  });
});
