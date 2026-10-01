import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeCodex, readFakeCodexState } from '../helpers/fake-codex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'index.js');

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // Every CLI startup appends diagnostics; hook/config state is the regression surface.
    if (entry.name === 'debug.log') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(snapshot(full))) files[path.join(entry.name, name)] = content;
    } else {
      files[entry.name] = fs.readFileSync(full).toString('base64');
    }
  }
  return files;
}

describe('hooks inject --dry-run (real CLI)', () => {
  let sandbox: string;
  let home: string;
  let fakeBin: string;

  beforeAll(() => {
    if (!fs.existsSync(cli)) throw new Error(`CLI binary not found at ${cli}. Run "npm run build" first.`);
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hooks-preview-'));
    home = path.join(sandbox, 'home');
    fakeBin = installFakeCodex();
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    fs.mkdirSync(path.join(teamRepo, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"model":"personal"}\n');
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), [
      'team: hooks-preview-e2e',
      'repo: https://example.com/team.git',
      'provider: git',
    ].join('\n'));
    fs.writeFileSync(path.join(teamRepo, 'hooks', 'hooks.yaml'), [
      'hooks:',
      '  - id: preview-stop',
      '    event: Stop',
      '    command: echo preview-stop',
      '    description: Preview regression fixture',
    ].join('\n'));
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${teamRepo}`,
      '  remote: https://example.com/team.git',
      'username: e2e-user',
      'updatePolicy: auto',
      'scope: user',
      'enabledAgents: [claude, codex]',
    ].join('\n'));
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
    if (fakeBin) fs.rmSync(fakeBin, { recursive: true, force: true });
  });

  it('previews hooks without changing settings, manifests or config; a real run still injects', () => {
    const before = snapshot(home);
    const codexHome = path.join(home, '.codex');
    const env = {
      ...process.env, HOME: home, USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: codexHome,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`, FORCE_COLOR: '0',
    };
    const preview = spawnSync(process.execPath, [cli, 'hooks', 'inject', '--dry-run'], {
      cwd: home, env, encoding: 'utf8', timeout: 15_000,
    });

    expect(preview.status).toBe(0);
    expect(preview.stdout + preview.stderr).toContain('[dry-run] Would inject hooks');
    expect(preview.stdout + preview.stderr).not.toContain('Hooks injected');
    expect(snapshot(home)).toEqual(before);

    const inject = spawnSync(process.execPath, [cli, 'hooks', 'inject'], {
      cwd: home, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(inject.status).toBe(0);
    expect(inject.stdout + inject.stderr).toContain('Hooks injected');
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toContain('preview-stop');
    const trusted = readFakeCodexState(codexHome);
    expect(trusted.calls.some((call) => call.method === 'config/batchWrite'), inject.stdout + inject.stderr).toBe(true);
    expect(Object.keys(trusted.hooksState).length).toBeGreaterThan(0);

    const installed = snapshot(home);
    const previewInstalled = spawnSync(process.execPath, [cli, 'hooks', 'inject', '--dry-run'], {
      cwd: home, env, encoding: 'utf8', timeout: 15_000,
    });
    expect(previewInstalled.status).toBe(0);
    expect(previewInstalled.stdout + previewInstalled.stderr).toContain('[dry-run] Would inject hooks');
    expect(readFakeCodexState(codexHome)).toEqual(trusted);
    expect(snapshot(home)).toEqual(installed);
  });
});
