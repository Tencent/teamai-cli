import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadV2Plugin } from '../helpers/opencode-plugin.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it('installs OpenCode plugins in the recorded home and reads user context there', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-opencode-home-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const moved = path.join(root, 'moved-opencode');
  fs.mkdirSync(path.join(moved, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(moved, 'plugin', 'personal.ts'), '// keep moved personal');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.mkdirSync(project);
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_DIR: moved, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
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
      'enabledAgents: [opencode]', 'additionalRoles: []', '',
    ].join('\n'));
    cli('pull', '--force');
    const extension = path.join(moved, 'plugin', 'teamai-hooks.ts');
    expect(fs.readFileSync(extension, 'utf8')).toContain('[teamai] hooks plugin');
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'plugin', 'teamai-hooks.ts'))).toBe(false);
    fs.writeFileSync(path.join(moved, 'teamai-context.md'), 'MOVED-USER-CONTEXT');
    const host = await loadV2Plugin(fs.readFileSync(extension, 'utf8'), {}, project);
    try {
      const context = { sessionID: 'moved-home-fixture', system: [] as Array<{ type: string; text: string }> };
      await host.callbacks['session.context'](context);
      expect(context.system.map(part => part.text).join('\n')).toContain('MOVED-USER-CONTEXT');
    } finally {
      if (typeof host.cleanup === 'function') await host.cleanup();
    }
    delete env.OPENCODE_CONFIG_DIR;
    expect(cli('hooks', 'list')).toContain(extension);
    cli('hooks', 'remove');
    expect(fs.existsSync(extension)).toBe(false);
    expect(fs.readFileSync(path.join(moved, 'plugin', 'personal.ts'), 'utf8')).toBe('// keep moved personal');
  } finally {
    await waitForDetachedChildren();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
