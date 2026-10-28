import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it('injects, lists, diagnoses and uninstalls Muse hooks in the recorded XDG home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-muse-home-e2e-'));
  const home = path.join(root, 'home');
  const moved = path.join(root, 'xdg', 'muse');
  const repo = path.join(root, 'team');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(moved, { recursive: true });
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  const old = path.join(home, '.config/muse/settings.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '{"model":"old-personal"}\n');
  const active = path.join(moved, 'settings.json');
  fs.writeFileSync(active, '{"model":"personal"}\n');
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: Hook fixture\nrepo: fixture/team\nprovider: git\n');
  fs.writeFileSync(path.join(home, '.teamai/config.yaml'), [
    'repo:', `  localPath: ${repo}`, '  remote: fixture/team', 'username: fixture',
    'scope: user', 'updatePolicy: auto', 'usageReportEnabled: false',
    'enabledAgents: [muse]', 'additionalRoles: []', '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.teamai/tool-homes.json'), JSON.stringify({ muse: moved }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  try {
    cli('hooks', 'inject');
    expect(fs.readFileSync(active, 'utf8')).toContain('hook-dispatch session-start');
    expect(cli('hooks', 'list')).toContain(active);
    // Other doctor checks can fail for this deliberately minimal team fixture.
    let report: string;
    try { report = cli('doctor', '--json'); }
    catch (error) { report = (error as { stdout: string }).stdout; }
    const parsed = JSON.parse(report) as { checks: Array<{ name: string; ok: boolean }> };
    expect(parsed.checks.find(c => c.name === 'teamai hooks in muse settings')?.ok).toBe(true);
    cli('uninstall', '--agent', 'muse', '--force');
    expect(fs.readFileSync(active, 'utf8')).not.toContain('hook-dispatch');
    expect(JSON.parse(fs.readFileSync(active, 'utf8')).model).toBe('personal');
    expect(fs.readFileSync(old, 'utf8')).toBe('{"model":"old-personal"}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
