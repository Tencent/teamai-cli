/**
 * E2E (#1881): `teamai init <url>` must not treat a teamai.yaml that fails the
 * schema as a missing one. It refuses, pushes nothing, and removes only the
 * clone, the empty project data folder this run created, and an empty
 * ~/.teamai/projects that this run created. An empty teamai.yaml is still
 * missing: init writes the skeleton. A data folder that was already there
 * stays. Self-mode cleanup is in init-self-mode-refusal.test.ts.
 *
 * Runs the built CLI against local bare repos.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectSlug } from '../../utils/partition.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run { code: number | null; output: string }

let sandbox: string;
let seq = 0;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-invalid-yaml-1881-')));
});

afterAll(async () => {
  await waitForDetachedChildren();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return r.stdout ?? '';
}

function teamai(args: string[], cwd: string, env: NodeJS.ProcessEnv): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, output: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** A member HOME and a project git repo to init from, so scope is the project partition. */
function member(name: string, url: string, bare: string) {
  const id = `${name}-${++seq}`;
  const home = path.join(sandbox, `home-${id}`);
  const app = path.join(sandbox, `app-${id}`);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(app, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...GIT_ENV,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    FORCE_COLOR: '0',
  };
  delete env.GIT_CONFIG_SYSTEM;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  git(['config', '--global', 'user.name', 'TeamAI CI'], home, env);
  git(['config', '--global', 'user.email', 'ci@teamai.test'], home, env);
  git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, url], home, env);
  fs.writeFileSync(path.join(app, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], app, env);
  git(['add', '.'], app, env);
  git(['commit', '-qm', 'app'], app, env);
  const root = fs.realpathSync.native(app);
  const dataHome = path.join(home, '.teamai', 'projects', projectSlug(root));
  return { home, app: root, env, dataHome };
}

function bareRepo(name: string, env: NodeJS.ProcessEnv, files: Record<string, string>): { bare: string; head: string } {
  const id = `${name}-${++seq}`;
  const seed = path.join(sandbox, `${id}-seed`);
  const bare = path.join(sandbox, `${id}.git`);
  fs.mkdirSync(seed, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(seed, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  git(['init', '-q', '-b', 'main'], seed, env);
  git(['add', '-A'], seed, env);
  git(['commit', '-qm', 'seed'], seed, env);
  git(['clone', '-q', '--bare', seed, bare], sandbox, env);
  return { bare, head: git(['rev-parse', 'HEAD'], bare, env).trim() };
}

const INIT = (url: string, extra: string[] = []) => ['init', url, '--provider', 'git', '--agent', 'claude', '--force', ...extra];

const INVALID_YAML = [
  'description: kept settings',
  'autoUpdate: false',
  'workflows:',
  '  retention: 1s',
  '  driver: local',
  'sharing:',
  '  recall:',
  '    enabled: true',
  '',
].join('\n');

describe('init refuses a teamai.yaml that does not validate (#1881)', () => {
  it('refuses an invalid teamai.yaml, pushes nothing, and leaves no project data folder', () => {
    const url = 'https://git.example.invalid/team/invalid.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig') };
    const { bare, head } = bareRepo('invalid', envProbe, { 'teamai.yaml': INVALID_YAML, 'README.md': '# team\n' });
    const m = member('invalid', url, bare);

    const res = teamai(INIT(url), m.app, m.env);

    expect(res.code, res.output).toBe(1);
    expect(res.output).toContain('Invalid teamai.yaml:');
    expect(res.output).toContain('team:');
    expect(res.output).toContain('repo:');
    expect(res.output).toContain(
      `${url} has a teamai.yaml that does not validate, so init stops instead of replacing it. ` +
      'Fix teamai.yaml in the team repo as the error above says, then run init again.',
    );
    expect(res.output).not.toContain('Creating default config');
    expect(git(['rev-parse', 'HEAD'], bare, m.env).trim()).toBe(head);
    expect(git(['log', '-1', '--format=%s'], bare, m.env)).not.toContain('Initialize team repo skeleton');
    expect(fs.existsSync(m.dataHome)).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.teamai', 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.teamai', 'config.yaml'))).toBe(false);
  });

  it('treats an empty teamai.yaml as missing and writes the skeleton', () => {
    const url = 'https://git.example.invalid/team/empty-yaml.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig-empty-yaml') };
    const { bare, head } = bareRepo('empty-yaml', envProbe, { 'teamai.yaml': '', 'README.md': '# team\n' });
    const m = member('empty-yaml', url, bare);

    const res = teamai(INIT(url), m.app, m.env);

    expect(res.code, res.output).toBe(0);
    expect(res.output).toContain('Creating default config');
    expect(res.output).not.toContain('does not validate');
    const shown = git(['show', 'HEAD:teamai.yaml'], bare, m.env);
    expect(shown).toContain('team:');
    expect(shown).toContain(`repo: ${url}`);
    expect(git(['rev-parse', 'HEAD'], bare, m.env).trim()).not.toBe(head);
    expect(git(['log', '-1', '--format=%s'], bare, m.env)).toContain('Initialize team repo skeleton');
  });

  it('keeps a project data folder that was already there, including an empty one', () => {
    const url = 'https://git.example.invalid/team/kept.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig-kept') };
    const { bare, head } = bareRepo('kept', envProbe, { 'teamai.yaml': INVALID_YAML });
    const earlier = member('kept-earlier', url, bare);
    fs.mkdirSync(earlier.dataHome, { recursive: true });
    fs.writeFileSync(path.join(earlier.dataHome, 'kept.txt'), 'keep\n');
    const empty = member('kept-empty', url, bare);
    fs.mkdirSync(empty.dataHome, { recursive: true });

    const again = teamai(INIT(url), earlier.app, earlier.env);
    const blank = teamai(INIT(url), empty.app, empty.env);

    expect(again.code, again.output).toBe(1);
    expect(blank.code, blank.output).toBe(1);
    expect(again.output).not.toContain('Creating default config');
    expect(blank.output).not.toContain('Creating default config');
    expect(git(['rev-parse', 'HEAD'], bare, earlier.env).trim()).toBe(head);
    expect(fs.readFileSync(path.join(earlier.dataHome, 'kept.txt'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(empty.dataHome)).toBe(true);
    expect(fs.readdirSync(empty.dataHome)).toEqual([]);
  });

  it('refuses again with --force when an earlier install is already on disk, and does not publish a skeleton', () => {
    const url = 'https://git.example.invalid/team/rerun.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig-rerun') };
    const valid = `team: rerun\nrepo: ${url}\nprovider: git\nreviewers: []\n`;
    const { bare, head } = bareRepo('rerun', envProbe, { 'teamai.yaml': valid, 'README.md': '# team\n' });
    const m = member('rerun', url, bare);

    const first = teamai(INIT(url), m.app, m.env);
    expect(first.code, first.output).toBe(0);
    expect(fs.existsSync(path.join(m.dataHome, 'config.yaml'))).toBe(true);
    expect(git(['rev-parse', 'HEAD'], bare, m.env).trim()).toBe(head);

    const work = path.join(sandbox, 'rerun-work');
    git(['clone', '-q', bare, work], sandbox, m.env);
    fs.writeFileSync(path.join(work, 'teamai.yaml'), INVALID_YAML);
    git(['add', 'teamai.yaml'], work, m.env);
    git(['commit', '-qm', 'break teamai.yaml'], work, m.env);
    git(['push', '-q', 'origin', 'main'], work, m.env);
    const broken = git(['rev-parse', 'HEAD'], bare, m.env).trim();
    expect(broken).not.toBe(head);

    const second = teamai(INIT(url), m.app, m.env);

    expect(second.code, second.output).toBe(1);
    expect(second.output).toContain('does not validate, so init stops instead of replacing it');
    expect(second.output).not.toContain('Creating default config');
    expect(git(['rev-parse', 'HEAD'], bare, m.env).trim()).toBe(broken);
    expect(fs.existsSync(path.join(m.dataHome, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(m.dataHome, 'team-repo'))).toBe(true);
  });
});

