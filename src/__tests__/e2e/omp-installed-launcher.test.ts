import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

it('loads project instructions through the installed OMP extension without teamai on PATH', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-omp-launch-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(home, '.omp', 'agent'), { recursive: true });
  fs.mkdirSync(project);
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', FORCE_COLOR: '0' };
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env, encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env });
    const seed = path.join(root, 'team-seed');
    fs.mkdirSync(seed);
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: OMP launch fixture\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(seed, 'culture.md'), '---\ncompany:\n  name: Fixture\n---\n\nOMP-LAUNCH-CONTEXT\n');
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
      'enabledAgents: [omp]', 'additionalRoles: []', '',
    ].join('\n'));
    cli('pull', '--force');
    const extension = path.join(home, '.omp', 'agent', 'extensions', 'teamai-hooks.ts');
    const host = `
      import fs from 'node:fs';
      const source = fs.readFileSync(${JSON.stringify(extension)}, 'utf8');
      const adapted = source.replace('import { $ } from "bun";', \`import {spawnSync} from 'node:child_process';
const $ = (_strings, launcher, args, response) => {
 const run = response.text().then(input => {
  const result=spawnSync(launcher[0],[...launcher.slice(1),...args],{input,encoding:'utf8',env:process.env});
  return result.stdout ?? '';
 });
 const output=Object.assign(run,{text:async()=>run});
 return {quiet:()=>({nothrow:()=>output})};
};\`);
      const {default: install} = await import('data:text/javascript;base64,' + Buffer.from(adapted).toString('base64'));
      const handlers = {};
      install({on: (name, fn) => { handlers[name] = fn; }});
      const ctx = {cwd: ${JSON.stringify(project)}, sessionManager: {getSessionId: () => 'omp-launch-fixture'}};
      await handlers.session_start({}, ctx);
      const answer = await handlers.before_agent_start({prompt: 'hello', systemPrompt: ['original']}, ctx);
      console.log(JSON.stringify(answer));
    `;
    const answer = execFileSync(process.execPath, ['--input-type=module', '-e', host], {
      cwd: project, env: { ...env, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
    });
    expect(answer).toContain('OMP-LAUNCH-CONTEXT');
    expect(answer).toContain('original');
  } finally {
    await waitForDetachedChildren();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
