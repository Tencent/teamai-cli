import { expect, it } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { commitTeamRepo } from '../helpers/team-repo-history.js';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it.each(['repair', 'uninstall'])('keeps a blocking file, reports it in doctor, and allows %s', (next) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-blocked-skills-'));
  try {
    const home = path.join(root, 'home');
    const seed = path.join(root, 'seed');
    const repo = path.join(home, '.teamai', 'team-repo');
    for (const dir of [path.join(seed, 'skills', 'fixture'), path.dirname(repo), path.join(home, '.claude'), path.join(home, '.hermes')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({ team: 'blocked-skills', repo: seed, provider: 'git', usageReport: false }));
    fs.writeFileSync(path.join(seed, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Fixture\n---\nFixture skill.\n');
    commitTeamRepo(seed);
    execFileSync('git', ['clone', '-q', seed, repo]);
    fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: seed }, username: 'tester', scope: 'user', enabledAgents: ['hermes', 'claude'], updatePolicy: 'skip' }));
    const blocked = path.join(home, '.hermes', 'skills');
    fs.writeFileSync(blocked, 'member file');
    const env = { ...process.env, HOME: home, USERPROFILE: home, HERMES_HOME: path.join(home, '.hermes'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FORCE_COLOR: '0' };
    const pull = (args: string[]) => spawnSync(process.execPath, [cli, 'pull', ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    const first = pull(['--force']);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout + first.stderr).toContain('not a directory');
    expect(first.stdout + first.stderr).not.toContain('ENOTDIR');
    expect(fs.readFileSync(blocked, 'utf8')).toBe('member file');
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'fixture', 'SKILL.md'))).toBe(true);
    const doctor = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    expect(doctor.status, doctor.stdout + doctor.stderr).toBe(1);
    const report = JSON.parse(doctor.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'hermes skills directory is usable', ok: false, fix: expect.stringContaining(blocked) }));
    expect(report.checks).not.toContainEqual(expect.objectContaining({ name: 'hermes skills are where the last pull wrote them', ok: true }));
    if (next === 'uninstall') {
      const hook = path.join(home, '.hermes', 'hooks', 'teamai-status-report.sh');
      const plugin = path.join(home, '.hermes', 'plugins', 'teamai-instructions');
      expect(fs.existsSync(hook)).toBe(true);
      expect(fs.existsSync(plugin)).toBe(true);
      const uninstall = spawnSync(process.execPath, [cli, 'uninstall', '--agent', 'hermes', '--force'], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
      expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
      expect(uninstall.stdout + uninstall.stderr).not.toContain('ENOTDIR');
      expect(fs.existsSync(hook)).toBe(false);
      expect(fs.existsSync(plugin)).toBe(false);
      expect(fs.readFileSync(blocked, 'utf8')).toBe('member file');
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'fixture', 'SKILL.md'))).toBe(true);
      const again = spawnSync(process.execPath, [cli, 'uninstall', '--agent', 'hermes', '--force'], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
      expect(again.status, again.stdout + again.stderr).toBe(0);
      expect(again.stdout + again.stderr).toContain('Nothing to uninstall');
      expect(again.stdout + again.stderr).not.toContain('Removed teamai Hermes hook');
      return;
    }
    fs.unlinkSync(blocked);
    const retry = pull([]);
    expect(retry.status, retry.stdout + retry.stderr).toBe(0);
    expect(fs.existsSync(path.join(blocked, 'fixture', 'SKILL.md')), retry.stdout + retry.stderr).toBe(true);
    expect(fs.existsSync(path.join(blocked, 'teamai', 'SKILL.md'))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
