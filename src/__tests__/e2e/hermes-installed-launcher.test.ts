import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it.runIf(process.platform !== 'win32')('loads project instructions through the installed Hermes plugin and status hook without teamai on PATH', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-launch-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.hermes'), { recursive: true });
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    HERMES_HOME: path.join(home, '.hermes'), GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', FORCE_COLOR: '0' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
    const seed = path.join(root, 'team-seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: Hermes launch fixture\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(seed, 'culture.md'), '---\ncompany:\n  name: Fixture\n---\n\nHERMES-LAUNCH-CONTEXT\n');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'fixture');
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', seed, origin);
    const teamRepo = path.join(project, '.teamai', 'team-repo');
    git(root, 'clone', '-q', origin, teamRepo);
    fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), [
      'repo:', `  localPath: ${teamRepo}`, `  remote: ${origin}`, 'username: fixture',
      'scope: project', `projectRoot: ${project}`, 'updatePolicy: auto', 'usageReportEnabled: false',
      'enabledAgents: [hermes]', 'additionalRoles: []', '',
    ].join('\n'));
    cli('pull', '--force');
    const plugin = path.join(home, '.hermes', 'plugins', 'teamai-instructions', '__init__.py');
    const host = `import runpy; p = runpy.run_path(${JSON.stringify(plugin)}); print(p['_instructions']({'cwd': ${JSON.stringify(project)}, 'session_id': 'hermes-launch-fixture'}))`;
    const answer = execFileSync('/usr/bin/python3', ['-c', host], {
      cwd: project, env: { ...env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(answer).toContain('HERMES-LAUNCH-CONTEXT');
    const observed = path.join(root, 'status.json');
    const probe = path.join(root, 'status-probe.cjs');
    fs.writeFileSync(probe, `if (process.argv.includes('session-start') && !process.argv.includes('--bg-only')) require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));`);
    execFileSync('/bin/bash', [path.join(home, '.hermes', 'hooks', 'teamai-status-report.sh')], {
      cwd: project, env: { ...env, PATH: '/usr/bin:/bin', NODE_OPTIONS: '--require ' + JSON.stringify(probe) }, timeout: 30_000,
    });
    expect(JSON.parse(fs.readFileSync(observed, 'utf8'))).toEqual(['hook-dispatch', 'session-start', '--tool', 'hermes']);
  } finally {
    await waitForDetachedChildren();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
