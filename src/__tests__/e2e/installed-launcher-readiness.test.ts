import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';
const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
it('doctor accepts the live launcher saved by another entry to the same built CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-readiness-cli-'));
  try {
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const team = path.join(root, 'team');
    fs.mkdirSync(path.join(home, '.pi/agent'), { recursive: true });
    fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
    fs.mkdirSync(team);
    fs.writeFileSync(path.join(team, 'culture.md'), '---\ncompany:\n  name: Fixture\n---\n\nReadiness culture.\n');
    fs.writeFileSync(path.join(team, 'teamai.yaml'), 'team: Readiness fixture\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(project, '.teamai/config.yaml'), YAML.stringify({ repo: { localPath: team, remote: 'fixture/team' }, username: 'fixture', scope: 'project', projectRoot: project, updatePolicy: 'skip', usageReportEnabled: false, enabledAgents: ['pi'], additionalRoles: [] }));
    const first = path.join(root, "first member's CLI.mjs");
    const second = path.join(root, 'second CLI.mjs');
    for (const file of [first, second]) fs.writeFileSync(file, `import ${JSON.stringify(pathToFileURL(CLI).href)};\n`);
    const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', PI_CODING_AGENT_DIR: '', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
    execFileSync('git', ['init', '-q'], { cwd: project, env });
    execFileSync('git', ['init', '-q'], { cwd: team, env });
    execFileSync('git', ['add', '.'], { cwd: team, env });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: team, env });
    const cli = (entry: string, ...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd: project, env, encoding: 'utf8', timeout: 30000 });
    const installed = cli(first, 'hooks', 'inject');
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    const file = path.join(home, '.pi/agent/extensions/teamai-hooks.ts');
    const before = fs.readFileSync(file, 'utf8');
    expect(before).toContain(first);
    const ready = () => {
      const run = cli(second, 'doctor', '--json');
      const report = JSON.parse(run.stdout) as { checks: Array<{ name: string; ok: boolean }> };
      return report.checks.find(check => check.name.startsWith('pi adds the team instructions'))?.ok;
    };
    expect(ready()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    fs.unlinkSync(first);
    expect(ready()).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60000);
