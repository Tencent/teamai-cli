import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
let sandbox: string;
let attempt = 0;
const read = (file: string): string => fs.readFileSync(file, 'utf8');
function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const skill = (name: string, body = name): string => `---\nname: ${name}\ndescription: ${name}\n---\n${body}\n`;

function machine(init = true) {
  const root = path.join(sandbox, String(++attempt));
  const home = path.join(root, 'home');
  const seed = path.join(root, 'seed');
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'app');
  const url = `https://git.example.com/team/ref-${attempt}.git`;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', FORCE_COLOR: '0',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  function run(args: string[], cwd = dir, input?: string) {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', input });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }
  function ok(args: string[], cwd = dir) {
    const r = run(args, cwd);
    expect(r.code, r.output).toBe(0);
    return r;
  }
  function git(args: string[], cwd = seed): string {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }
  write(path.join(seed, 'teamai.yaml'), `team: refs\nrepo: ${url}\nprovider: git\nreviewers: []\n`);
  write(path.join(seed, 'skills/base/SKILL.md'), skill('base'));
  write(path.join(seed, 'tags.yaml'), 'skills:\n  trial: [review]\n');
  write(path.join(seed, 'rules/style.md'), 'DEFAULT RULE\n');
  write(path.join(seed, 'claudemd/common.md'), 'DEFAULT INSTRUCTIONS\n');
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'team']);
  git(['clone', '-q', '--bare', seed, remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['config', '--global', `url.${remote}.insteadOf`, url]);
  function teamCommit(files: Record<string, string | null>, branch = 'trial'): string {
    git(['checkout', '-q', branch]);
    for (const [file, content] of Object.entries(files)) {
      if (content === null) fs.rmSync(path.join(seed, file), { recursive: true, force: true });
      else write(path.join(seed, file), content);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'team change']);
    git(['push', '-q', 'origin', branch]);
    return git(['rev-parse', 'HEAD']);
  }
  git(['checkout', '-q', '-b', 'trial']);
  const trial = teamCommit({ 'skills/trial/SKILL.md': skill('trial'), 'rules/style.md': 'TRIAL RULE\n', 'claudemd/common.md': 'TRIAL INSTRUCTIONS\n' });
  git(['tag', 'v1']);
  git(['push', '-q', 'origin', 'v1']);
  git(['checkout', '-q', 'main']);
  write(path.join(dir, 'README.md'), 'app\n');
  git(['init', '-q', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'app'], dir);
  const initArgs = ['init', url, '--provider', 'git', '--scope', 'workspace', '--agent', 'claude,codex', '--force'];
  if (init) ok(initArgs);
  function dataHome(cwd = dir): string {
    const projects = path.join(home, '.teamai/projects');
    const found = fs.readdirSync(projects).map((p) => path.join(projects, p)).find((p) => read(path.join(p, 'config.yaml')).includes(`projectRoot: ${cwd}`));
    if (!found) throw new Error('workspace partition not found');
    return found;
  }
  const configPath = () => path.join(dataHome(), 'config.yaml');
  function config() { return YAML.parse(read(configPath())); }
  function editConfig(fn: (c: ReturnType<typeof config>) => void) { const c = config(); fn(c); write(configPath(), YAML.stringify(c)); }
  const clone = () => config().repo.localPath as string;
  const copy = (name: string, cwd = dir) => path.join(cwd, '.claude/skills', name, 'SKILL.md');
  return { root, home, dir, seed, remote, url, env, trial, run, ok, git, teamCommit, dataHome, config, configPath, editConfig, clone, copy, initArgs };
}

beforeAll(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pull-failure-exit-e2e-')));
});
afterAll(async () => { await waitForDetachedChildren(); fs.rmSync(sandbox, { recursive: true, force: true }); });

describe('pull exit status when the team repo cannot be fetched (#1500)', () => {
  function breakRemote(m: ReturnType<typeof machine>): void {
    m.git(['config', '--global', `url.${path.join(m.root, 'gone.git')}.insteadOf`, m.url]);
    m.git(['config', '--global', '--unset-all', `url.${m.remote}.insteadOf`]);
  }

  it('exits 1 for a pull a person ran, with the same message', () => {
    const m = machine();
    breakRemote(m);
    const r = m.run(['pull', '--force']);
    expect(r.output).toContain('Pull failed');
    expect(r.code, r.output).toBe(1);
  });

  it('keeps exit 0 for the silent pull a hook runs, and for a git hook pull', () => {
    const m = machine();
    breakRemote(m);
    const silent = m.run(['pull', '--silent', '--force']);
    expect(silent.code, silent.output).toBe(0);
    const hook = m.run(['hook-dispatch', 'post-merge', '--tool', 'git'], m.dir, '0\n');
    expect(hook.code, hook.output).toBe(0);
  });
});
