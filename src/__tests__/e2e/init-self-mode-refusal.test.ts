/**
 * E2E (#1500 Part 2): `teamai init <url>` against a self-mode team URL (a repo
 * holding .teamai/teamai.yaml with mode: self on its default branch and no root
 * teamai.yaml) refuses to initialize as a standalone team repo, pushes nothing,
 * removes the clone when freshly created (preserving existing reused clones),
 * and leaves no local config.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';
import { projectSlug } from '../../utils/partition.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface Run {
  code: number | null;
  output: string;
}

let sandbox: string;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-self-mode-refusal-1500-')));
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
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  return {
    code: r.status,
    output: (r.stdout ?? '') + (r.stderr ?? ''),
  };
}

function createMemberEnv(name: string): { home: string; env: NodeJS.ProcessEnv } {
  const home = path.join(sandbox, `home-${name}`);
  fs.mkdirSync(home, { recursive: true });
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
  git(['config', '--global', 'user.name', 'TeamAI CI'], home, env);
  git(['config', '--global', 'user.email', 'ci@teamai.test'], home, env);
  return { home, env };
}

describe('init refuses self-mode team URL (#1500)', () => {
  it('A1: refuses self-mode team URL, leaves remote main unchanged, removes newly created clone and writes no local config', () => {
    const { home, env } = createMemberEnv('self-mode-a1');
    const bizUrl = 'https://git.example.invalid/team/biz.git';
    const seed = path.join(sandbox, 'biz-seed');
    const bare = path.join(sandbox, 'biz.git');
    fs.mkdirSync(path.join(seed, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.teamai', 'teamai.yaml'), YAML.stringify({
      team: 'biz-team',
      mode: 'self',
      repo: bizUrl,
      provider: 'git',
    }));
    fs.writeFileSync(path.join(seed, 'README.md'), '# Biz Project\n');

    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '-A'], seed, env);
    git(['commit', '-q', '-m', 'biz initial commit'], seed, env);
    git(['clone', '-q', '--bare', seed, bare], sandbox, env);

    const initialCommit = git(['rev-parse', 'HEAD'], bare, env).trim();
    git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, bizUrl], home, env);

    const res = teamai(
      ['init', bizUrl, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'],
      home,
      env,
    );

    expect(res.code).toBe(1);
    expect(res.output).toContain(
      `${bizUrl} is a repo in self mode: its config is .teamai/teamai.yaml. Clone the repository and run \`teamai init --self\` in it.`,
    );

    // Remote bare repository main branch must be completely untouched
    const currentCommit = git(['rev-parse', 'HEAD'], bare, env).trim();
    expect(currentCommit).toBe(initialCommit);

    // No local config created
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(false);

    // Freshly created cloned directory removed
    expect(fs.existsSync(path.join(home, '.teamai', 'team-repo'))).toBe(false);
  });

  it('A1 (preservation): preserves an existing reused clone and its files when refusing a team in self mode', () => {
    const { home, env } = createMemberEnv('reused-self-mode');
    const bizUrl = 'https://git.example.invalid/team/biz-reused.git';
    const seed = path.join(sandbox, 'biz-reused-seed');
    const bare = path.join(sandbox, 'biz-reused.git');
    fs.mkdirSync(path.join(seed, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(seed, '.teamai', 'teamai.yaml'), YAML.stringify({
      team: 'biz-team',
      mode: 'self',
      repo: bizUrl,
      provider: 'git',
    }));
    fs.writeFileSync(path.join(seed, 'README.md'), '# Biz Reused\n');

    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '-A'], seed, env);
    git(['commit', '-q', '-m', 'biz seed commit'], seed, env);
    git(['clone', '-q', '--bare', seed, bare], sandbox, env);

    git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, bizUrl], home, env);

    // Pre-seed an existing clone in ~/.teamai/team-repo using bizUrl so remote matches
    const teamRepo = path.join(home, '.teamai', 'team-repo');
    git(['clone', '-q', bizUrl, teamRepo], sandbox, env);
    const uncommittedFile = path.join(teamRepo, 'uncommitted-work.txt');
    fs.writeFileSync(uncommittedFile, 'precious work that must not be deleted\n');

    const res = teamai(
      ['init', bizUrl, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'],
      home,
      env,
    );

    expect(res.code).toBe(1);
    expect(res.output).toContain(
      `${bizUrl} is a repo in self mode: its config is .teamai/teamai.yaml. Clone the repository and run \`teamai init --self\` in it.`,
    );

    // Existing clone and the uncommitted work must be preserved intact!
    expect(fs.existsSync(teamRepo)).toBe(true);
    expect(fs.existsSync(uncommittedFile)).toBe(true);
    expect(fs.readFileSync(uncommittedFile, 'utf8')).toBe('precious work that must not be deleted\n');
  });

  it('A2: empty repository is not refused as a team in self mode', () => {
    const { home, env } = createMemberEnv('empty-a2');
    const emptyUrl = 'https://git.example.invalid/team/empty.git';
    const bare = path.join(sandbox, 'empty.git');
    git(['init', '-q', '--bare', bare], sandbox, env);

    git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, emptyUrl], home, env);

    const res = teamai(
      ['init', emptyUrl, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'],
      home,
      env,
    );

    // An empty repository must NOT be refused with the self-mode message
    expect(res.output).not.toContain('is a repo in self mode: its config is .teamai/teamai.yaml');
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(true);
  });

  it('A3: allows standalone repository holding root teamai.yaml', () => {
    const { home, env } = createMemberEnv('standalone-a3');
    const teamUrl = 'https://git.example.invalid/team/standalone.git';
    const seed = path.join(sandbox, 'standalone-seed');
    const bare = path.join(sandbox, 'standalone.git');
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'standalone-team',
      repo: teamUrl,
      provider: 'git',
      reviewers: [],
    }));

    git(['init', '-q', '-b', 'main'], seed, env);
    git(['add', '-A'], seed, env);
    git(['commit', '-q', '-m', 'standalone seed commit'], seed, env);
    git(['clone', '-q', '--bare', seed, bare], sandbox, env);

    git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, teamUrl], home, env);

    const res = teamai(
      ['init', teamUrl, '--provider', 'git', '--agent', 'claude', '--scope', 'user', '--force'],
      home,
      env,
    );

    // Standalone team repo with root teamai.yaml must NOT be refused with the self-mode message
    expect(res.output).not.toContain('is a repo in self mode: its config is .teamai/teamai.yaml');
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(home, '.teamai', 'config.yaml'))).toBe(true);
  });
});

/** A project git repo, so init uses the ~/.teamai/projects/<slug> partition (#1881). */
function projectMember(name: string, url: string, bare: string) {
  const { home, env } = createMemberEnv(name);
  delete env.GIT_CONFIG_SYSTEM;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  const app = path.join(sandbox, `app-${name}`);
  fs.mkdirSync(app, { recursive: true });
  git(['config', '--global', `url.${pathToFileURL(bare).href}.insteadOf`, url], home, env);
  fs.writeFileSync(path.join(app, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], app, env);
  git(['add', '.'], app, env);
  git(['commit', '-qm', 'app'], app, env);
  const root = fs.realpathSync.native(app);
  return { home, app: root, env, dataHome: path.join(home, '.teamai', 'projects', projectSlug(root)) };
}

function selfBare(name: string, url: string, env: NodeJS.ProcessEnv): { bare: string; head: string } {
  const seed = path.join(sandbox, `${name}-seed`);
  const bare = path.join(sandbox, `${name}.git`);
  fs.mkdirSync(path.join(seed, '.teamai'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.teamai', 'teamai.yaml'), YAML.stringify({
    team: 'biz-team',
    mode: 'self',
    repo: url,
    provider: 'git',
  }));
  fs.writeFileSync(path.join(seed, 'README.md'), '# biz\n');
  git(['init', '-q', '-b', 'main'], seed, env);
  git(['add', '-A'], seed, env);
  git(['commit', '-qm', 'biz'], seed, env);
  git(['clone', '-q', '--bare', seed, bare], sandbox, env);
  return { bare, head: git(['rev-parse', 'HEAD'], bare, env).trim() };
}

describe('init refusal of a self-mode repo removes only a project data folder this run created (#1881)', () => {
  it('removes the empty project data folder a refused self-mode init created', () => {
    const url = 'https://git.example.invalid/team/self-project.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig-self-project') };
    const { bare, head } = selfBare('self-project', url, envProbe);
    const m = projectMember('self-project', url, bare);

    const res = teamai(
      ['init', url, '--provider', 'git', '--agent', 'claude', '--force'],
      m.app,
      m.env,
    );

    expect(res.code, res.output).toBe(1);
    expect(res.output).toContain(
      `${url} is a repo in self mode: its config is .teamai/teamai.yaml. Clone the repository and run \`teamai init --self\` in it.`,
    );
    expect(res.output).not.toContain('Creating default config');
    expect(git(['rev-parse', 'HEAD'], bare, m.env).trim()).toBe(head);
    expect(fs.existsSync(m.dataHome)).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.teamai', 'projects'))).toBe(false);
    expect(fs.existsSync(path.join(m.home, '.teamai', 'team-repo'))).toBe(false);
  });

  it('keeps an empty project data folder that was there before the self-mode refusal', () => {
    const url = 'https://git.example.invalid/team/self-kept.git';
    const envProbe = { ...process.env, ...GIT_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(sandbox, 'unused-gitconfig-self-kept') };
    const { bare } = selfBare('self-kept', url, envProbe);
    const m = projectMember('self-kept', url, bare);
    fs.mkdirSync(m.dataHome, { recursive: true });

    const res = teamai(
      ['init', url, '--provider', 'git', '--agent', 'claude', '--force'],
      m.app,
      m.env,
    );

    expect(res.code, res.output).toBe(1);
    expect(res.output).toContain('is a repo in self mode');
    expect(fs.existsSync(m.dataHome)).toBe(true);
    expect(fs.readdirSync(m.dataHome)).toEqual([]);
  });
});

