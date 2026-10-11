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
  it('push --dry-run reports a directory at the lock path without altering it', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-preview-lock-error-'));
    const home = path.join(sandbox, 'home');
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(sandbox, 'team-repo');
    const lock = path.join(dataHome, '.sync-lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.mkdirSync(repo);
    const config = [
      'repo:', `  localPath: ${JSON.stringify(repo)}`,
      '  remote: https://git.example.com/team/repo.git',
      'username: e2e', 'scope: user', 'updatePolicy: skip', '',
    ].join('\n');
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), config);
    fs.writeFileSync(path.join(repo, 'teamai.yaml'),
      'team: lock-error-e2e\nrepo: https://git.example.com/team/repo.git\nprovider: git\nusageReport: false\n');
    fs.writeFileSync(path.join(lock, 'keep'), 'keep');

    const result = spawnSync(process.execPath, [cli, 'push', '--dry-run'], {
      cwd: sandbox,
      env: { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0' },
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(output).toContain(`Cannot acquire lock ${lock}:`);
    expect(output).toContain('EISDIR');
    expect(output).not.toContain('Another teamai pull/push');
    expect(fs.readdirSync(lock)).toEqual(['keep']);
    expect(fs.readFileSync(path.join(lock, 'keep'), 'utf8')).toBe('keep');
    expect(fs.readFileSync(path.join(dataHome, 'config.yaml'), 'utf8')).toBe(config);
    expect(fs.existsSync(`${lock}.sentinel`)).toBe(false);
  });

  it('env unset reports a parent-file error instead of waiting for a competing writer', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-lock-error-'));
    const home = path.join(sandbox, 'home');
    const secrets = path.join(home, '.teamai', 'secrets');
    fs.mkdirSync(path.dirname(secrets), { recursive: true });
    fs.writeFileSync(secrets, 'keep');
    // env set reads the store before locking: POSIX reports ENOTDIR there,
    // while Windows reports ENOENT. Unset reaches the lock on both platforms.
    const run = () => spawnSync(process.execPath, [cli, 'env', 'unset', 'TEST_TOKEN', '--global'], {
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
    fs.mkdirSync(secrets);
    fs.writeFileSync(path.join(secrets, 'machine.json'), JSON.stringify({
      TEST_TOKEN: { env: 'TEST_TOKEN', kind: 'secret' },
      OTHER_TOKEN: { env: 'OTHER_TOKEN', kind: 'secret' },
    }));
    const retry = run();
    expect(retry.error).toBeUndefined();
    expect(retry.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(secrets, 'machine.json'), 'utf8'))).toEqual({ OTHER_TOKEN: { env: 'OTHER_TOKEN', kind: 'secret' } });
    expect(fs.existsSync(path.join(secrets, 'machine.json.lock'))).toBe(false);
  });
});
