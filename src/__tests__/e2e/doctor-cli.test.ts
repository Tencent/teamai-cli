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
  let missingHookHome: string;

  function runDoctor(home: string, ...args: string[]) {
    return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
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

  function writeLocalConfig(home: string, repoLocal: string) {
    fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${JSON.stringify(repoLocal)}`,
      '  remote: https://example.invalid/team/repo.git',
      '  kind: git',
      'username: e2e-user',
      'updatePolicy: skip',
      'scope: user',
      'enabledAgents:',
      '  - claude',
    ].join('\n'));
  }

  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error('Run npm run build before the E2E test.');

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-doctor-e2e-'));
    uninitializedHome = path.join(sandbox, 'uninitialized-home');
    initializedHome = path.join(sandbox, 'initialized-home');
    missingHookHome = path.join(sandbox, 'missing-hook-home');
    const repoLocal = path.join(sandbox, 'team-repo');

    fs.mkdirSync(uninitializedHome, { recursive: true });
    fs.mkdirSync(repoLocal, { recursive: true });
    writeLocalConfig(initializedHome, repoLocal);
    writeLocalConfig(missingHookHome, repoLocal);
    fs.writeFileSync(path.join(repoLocal, 'teamai.yaml'), [
      'team: doctor-e2e',
      'repo: team/repo',
      'provider: git',
      'sharing:',
      '  env:',
      '    injectShellProfile: false',
      'toolPaths:',
      '  claude:',
      '    settings: .claude/settings.json',
      '    skills: .claude/skills',
    ].join('\n'));
    fs.writeFileSync(
      path.join(initializedHome, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'teamai hook-dispatch' }] }],
        },
      }),
    );
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
    expect(output).toContain('Team repo exists locally');
    expect(output).toContain('Team config (teamai.yaml) is valid');
    expect(output).toContain('teamai hooks in claude settings');
    expect(output).toContain('Env variables injected in shell profile');
    expect(output).toContain('All checks passed!');
  });

  it('exits 1 when an enabled agent is missing teamai hooks', () => {
    const result = runDoctor(missingHookHome);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status, output).toBe(1);
    expect(output).toContain('✖ teamai hooks in claude settings');
    expect(output).toContain('Some checks failed. See suggestions above.');
  });

  it('--json puts the report on stdout and nothing else', () => {
    const result = runDoctor(missingHookHome, '--json');

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);

    // stdout must parse whole: any human line leaking there breaks a consumer.
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      scope: string;
      checks: Array<{ name: string; ok: boolean; fix?: string }>;
    };
    expect(report.ok).toBe(false);
    expect(report.scope).toBe('user');

    const hookCheck = report.checks.find((c) => c.name === 'teamai hooks in claude settings');
    expect(hookCheck?.ok).toBe(false);
    expect(hookCheck?.fix).toContain('teamai hooks inject');
    expect(report.checks.some((c) => c.name === 'Team repo exists locally' && c.ok)).toBe(true);
  });

  it('--json keeps its envelope before initialization', () => {
    const result = runDoctor(uninitializedHome, '--json');

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      scope: string | null;
      checks: Array<{ name: string; ok: boolean }>;
    };
    expect(report.ok).toBe(false);
    expect(report.scope).toBeNull();
    expect(report.checks[0]?.name).toBe('TeamAI is not initialized');
  });
});
