import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { findGitBashWindows } from '../../bundled-runtime.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it('injects, lists, diagnoses and uninstalls CodeBuddy hooks in the recorded configuration home', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codebuddy-home-e2e-'));
  const home = path.join(root, 'home with spaces');
  const moved = path.join(root, 'xdg', 'codebuddy');
  const repo = path.join(root, 'team');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(moved, { recursive: true });
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  const old = path.join(home, '.codebuddy/settings.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, '{"model":"old-personal"}\n');
  const active = path.join(moved, 'settings.json');
  fs.writeFileSync(active, JSON.stringify({ model: 'personal', hooks: { UserPromptSubmit: [{
    description: '[teamai] Hook dispatch prompt-submit',
    hooks: [{ type: 'command', command: 'PATH="$HOME/.teamai/bin:$PATH" teamai hook-dispatch prompt-submit --tool codebuddy 2>/dev/null || true' }],
  }] } }));
  fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: Hook fixture\nrepo: fixture/team\nprovider: git\n');
  fs.writeFileSync(path.join(home, '.teamai/config.yaml'), [
    'repo:', `  localPath: ${repo}`, '  remote: fixture/team', 'username: fixture',
    'scope: user', 'updatePolicy: auto', 'usageReportEnabled: false',
    'enabledAgents: [codebuddy]', 'additionalRoles: []', '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.teamai/tool-homes.json'), JSON.stringify({ codebuddy: moved }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: '', FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' });
  try {
    cli('hooks', 'inject');
    const installed = fs.readFileSync(active, 'utf8');
    expect(installed).toContain('hook-dispatch session-start');
    expect((JSON.parse(installed) as { hooks: { UserPromptSubmit: unknown[] } }).hooks.UserPromptSubmit).toHaveLength(1);
    if (process.platform === 'win32') {
      const gitBash = findGitBashWindows();
      if (!gitBash) throw new Error('Git Bash is required for this test');
      const settings = JSON.parse(installed) as { hooks: { UserPromptSubmit: Array<{ hooks: Array<{ command: string }> }> } };
      const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
      const input = JSON.stringify({ cwd: root, session_id: 'codebuddy-ide-test', prompt: 'hello' });
      for (const run of [
        () => spawnSync(command, { shell: true, input, encoding: 'utf8', cwd: root, env }),
        () => spawnSync(gitBash, ['-c', command], { input, encoding: 'utf8', cwd: root, env }),
      ]) {
        const result = run();
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(path.join(home, '.teamai/debug.log'), 'utf8')).toContain('[hook-dispatch] prompt-submit/codebuddy ');
        fs.rmSync(path.join(home, '.teamai/debug.log'));
      }
      const failed = spawnSync(command.replace('prompt-submit', 'not-an-event'), { shell: true, input, encoding: 'utf8', cwd: root, env });
      expect(failed.status).toBe(0);
      expect(failed.stderr).toBe('');
      const missingShell = command.replace(/^"[^"]+"/, '"C:/missing-teamai-test/bash.exe"');
      expect(spawnSync(missingShell, { shell: true, input, encoding: 'utf8', cwd: root, env }).status).toBe(0);
      expect(spawnSync(gitBash, ['-c', missingShell], { input, encoding: 'utf8', cwd: root, env }).status).toBe(0);
    }
    expect(cli('hooks', 'list')).toContain(active);
    cli('hooks', 'inject');
    expect(fs.readFileSync(active, 'utf8')).toBe(installed);
    // Other doctor checks can fail for this deliberately minimal team fixture.
    let report: string;
    try { report = cli('doctor', '--json'); }
    catch (error) { report = (error as { stdout: string }).stdout; }
    const parsed = JSON.parse(report) as { checks: Array<{ name: string; ok: boolean }> };
    expect(parsed.checks.find(c => c.name === 'teamai hooks in codebuddy settings')?.ok, report).toBe(true);
    cli('uninstall', '--agent', 'codebuddy', '--force');
    expect(fs.readFileSync(active, 'utf8')).not.toContain('hook-dispatch');
    expect(JSON.parse(fs.readFileSync(active, 'utf8')).model).toBe('personal');
    expect(fs.readFileSync(old, 'utf8')).toBe('{"model":"old-personal"}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
