import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it('installs, lists and removes Pi hooks in the recorded agent directory', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pi-home-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const moved = path.join(root, 'moved-agent');
  fs.mkdirSync(path.join(moved, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(moved, 'extensions', 'personal.ts'), '// keep moved personal');
  fs.mkdirSync(path.join(home, '.pi', 'agent'), { recursive: true });
  fs.mkdirSync(project);
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: moved, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', FORCE_COLOR: '0' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
    const seed = path.join(root, 'team-seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: Pi launch fixture\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(seed, 'culture.md'), '---\ncompany:\n  name: Fixture\n---\n\nPI-LAUNCH-CONTEXT\n');
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
      'enabledAgents: [pi]', 'additionalRoles: []', '',
    ].join('\n'));
    cli('pull', '--force');
    const extension = path.join(moved, 'extensions', 'teamai-hooks.ts');
    expect(fs.readFileSync(extension, 'utf8')).toContain('[teamai] hooks extension');
    expect(fs.existsSync(path.join(home, '.pi', 'agent', 'extensions', 'teamai-hooks.ts'))).toBe(false);
    delete env.PI_CODING_AGENT_DIR;
    expect(cli('hooks', 'list')).toContain(extension);
    cli('hooks', 'remove');
    expect(fs.existsSync(extension)).toBe(false);
    expect(fs.readFileSync(path.join(moved, 'extensions', 'personal.ts'), 'utf8')).toBe('// keep moved personal');
  } finally {
    await waitForDetachedChildren();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
