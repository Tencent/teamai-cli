import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

describe('teamai doctor CLI (e2e)', () => {
  let sandbox: string;
  let uninitializedHome: string;
  let initializedHome: string;

  function runDoctor(home: string) {
    return spawnSync(process.execPath, [CLI, 'doctor'], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: '0',
      },
      encoding: 'utf8',
    });
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-doctor-e2e-'));
    uninitializedHome = path.join(sandbox, 'uninitialized-home');
    initializedHome = path.join(sandbox, 'initialized-home');
    const repoLocal = path.join(sandbox, 'team-repo');

    fs.mkdirSync(uninitializedHome, { recursive: true });
    fs.mkdirSync(path.join(initializedHome, '.teamai'), { recursive: true });
    fs.mkdirSync(repoLocal, { recursive: true });

    fs.writeFileSync(path.join(initializedHome, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${JSON.stringify(repoLocal)}`,
      '  remote: https://example.invalid/team/repo.git',
      '  kind: git',
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
    ].join('\n'));
    fs.writeFileSync(path.join(repoLocal, 'teamai.yaml'), [
      'team: doctor-e2e',
      'repo: team/repo',
      'provider: git',
      'toolPaths: {}',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('exits 1 without initialization and does not assume TGit', () => {
    const result = runDoctor(uninitializedHome);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain('TeamAI is not initialized');
    expect(output).not.toContain('gf CLI');
  });

  it('exits 0 when every diagnostic passes', () => {
    const result = runDoctor(initializedHome);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain('All checks passed!');
  });
});
