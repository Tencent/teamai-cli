/**
 * Real CLI: `teamai push --file <local file> --path <team path>` proposes exactly one file at exactly one team path, as
 * teamai-session-to-task's propose step runs it. The pull request is read from the branch that reached the team origin,
 * and the fake `gh` on PATH records it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const PRODUCT_URL = 'https://github.com/acme/frontend.git';
const TASK = `schemaVersion: v1alpha1
title: Pods time out on first start
prompt: |
  The first start of a pod times out after 30 s on a cold node. Make it start.
startingCommit: 3f2c9a7d1e0b4c6a8f5d2e1b0c9a8f7e6d5c4b3a
solutionCommit: 9a1d4e7c2b8f0a3d6e5c1b9f8a7d2e4c6b0a1f3e
check:
  run: npx vitest run test/startup.test.ts
  protect: ['test/**', 'package.json']
  add: ['test/startup.test.ts']
source: { platform: claude-code, sessionId: 7c1e }
`;
const SUITE = `schemaVersion: v1alpha1
name: frontend
repo: ${PRODUCT_URL}
defaults: { tool: claude }
arms: [{ name: main }]
repetitions: 1
timeout: 1h
`;

interface Member {
  root: string;
  /** Where every command runs: the member's project checkout. */
  work: string;
  /** The origin that receives the pull request's branch: the team repo, or the project itself in single-repo mode. */
  origin: string;
  /** The member's clone of the team repo; the project's `.teamai/` in single-repo mode. */
  teamClone: string;
  /** `.teamai/` in single-repo mode, where team paths sit in the origin's tree. */
  prefix: string;
  gh: FakeGh;
  env: NodeJS.ProcessEnv;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

/** A repo seeded with `files` on main, pushed to a new bare origin at `origin`. */
function seeded(root: string, name: string, files: Record<string, string>, origin: string): void {
  const seed = path.join(root, `seed-${name}`);
  write(seed, files);
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(seed, ['push', '-q', origin, 'main']);
}

function base(): { root: string; env: NodeJS.ProcessEnv; gh: FakeGh } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-file-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const gh = fakeGhHost(path.join(root, 'gh'));
  fs.symlinkSync(gh.bin, path.join(bin, 'gh'));
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = member', '\temail = member@example.com',
    `[url "file://${path.join(root, 'team.git')}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${path.join(root, 'app.git')}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter), GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1',
  };
  for (const name of ['XDG_CONFIG_HOME', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_SESSION_ID']) delete env[name];
  return { root, env, gh };
}

/** A member of a team whose repo has the suite benchmarks/frontend and `team`, in a project workspace, after pull. */
function teamMember(team: Record<string, string> = {}): Member {
  const { root, env, gh } = base();
  const origin = path.join(root, 'team.git');
  seeded(root, 'team', {
    'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\nusageReport: false\n`,
    'benchmarks/frontend/suite.yaml': SUITE,
    'benchmarks/frontend/tasks/old-bug.yaml': TASK,
    'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy the app.\n---\nRun the deploy.\n',
    ...team,
  }, origin);
  seeded(root, 'app', { 'README.md': '# app\n' }, path.join(root, 'app.git'));
  const work = path.join(root, 'home', 'work');
  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  const clone = path.join(work, '.teamai', 'team-repo');
  git(root, ['clone', '-q', TEAM_URL, clone], env);
  write(work, {
    '.teamai/config.yaml': YAML.stringify({
      repo: { localPath: clone, remote: TEAM_URL, kind: 'git' },
      username: 'member', scope: 'project', projectRoot: work, updatePolicy: 'skip', additionalRoles: [], enabledAgents: ['claude'],
    }),
  });
  fs.mkdirSync(path.join(work, '.claude'));
  const pulled = teamai({ work, env }, ['pull']);
  expect(pulled.code, pulled.output).toBe(0);
  // The first command moves the workspace's data, its team clone included, under ~/.teamai/projects/.
  const projects = path.join(root, 'home', '.teamai', 'projects');
  const [dataHome] = fs.readdirSync(projects).map((name) => path.join(projects, name));
  if (dataHome === undefined) throw new Error(`no workspace data home under ${projects}`);
  return { root, work, origin, teamClone: path.join(dataHome, 'team-repo'), prefix: '', gh, env };
}

/** A member of a single-repo team: the team files sit under the project's .teamai/, after init and pull. */
function selfMember(): Member {
  const { root, env, gh } = base();
  const origin = path.join(root, 'app.git');
  seeded(root, 'app', {
    'README.md': '# app\n',
    '.teamai/teamai.yaml': `team: frontend\nrepo: ${PRODUCT_URL}\nprovider: github\nmode: self\nusageReport: false\n`,
    '.teamai/benchmarks/frontend/suite.yaml': SUITE,
    '.teamai/benchmarks/frontend/tasks/old-bug.yaml': TASK,
  }, origin);
  const work = path.join(root, 'home', 'work');
  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  // init . reads the team URL from origin, which git would rewrite to its file:// stand-in.
  fs.writeFileSync(path.join(root, 'plain.gitconfig'), '[user]\n\tname = member\n\temail = member@example.com\n');
  const member = { root, work, origin, teamClone: path.join(work, '.teamai'), prefix: '.teamai/', gh, env };
  const initialized = teamai({ ...member, env: { ...env, GIT_CONFIG_GLOBAL: path.join(root, 'plain.gitconfig') } }, ['init', '.', '--agent', 'claude', '--scope', 'workspace', '--force']);
  expect(initialized.code, initialized.output).toBe(0);
  // init names the member after the account `gh api user` answers, which the fake gh answers with its open requests.
  const projects = path.join(root, 'home', '.teamai', 'projects');
  for (const config of fs.readdirSync(projects).map((name) => path.join(projects, name, 'config.yaml')).filter((file) => fs.existsSync(file))) {
    fs.writeFileSync(config, YAML.stringify({ ...YAML.parse(fs.readFileSync(config, 'utf8')), username: 'member' }));
  }
  git(work, ['push', '-q', 'origin', 'HEAD:main'], env);
  const pulled = teamai(member, ['pull']);
  expect(pulled.code, pulled.output).toBe(0);
  return member;
}

function teamai(member: Pick<Member, 'work' | 'env'>, args: string[]): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: member.work, env: member.env, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

/** A local file outside every repository, holding `text`. */
function localFile(member: Member, name: string, text: string): string {
  const file = path.join(member.root, name);
  fs.writeFileSync(file, text);
  return file;
}

/** Every branch the origin holds besides main, with the paths it changes against main. */
function proposed(member: Member): Record<string, string[]> {
  const branches = git(member.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter((branch) => branch !== '' && branch !== 'main');
  return Object.fromEntries(branches.map((branch) => [branch, git(member.origin, ['diff', '--name-only', 'main', branch]).split('\n').filter(Boolean)]));
}

describe('teamai push --file --path', () => {
  it('proposes only that file at that path, while the team clone holds other edits', async () => {
    const member = teamMember();
    fs.appendFileSync(path.join(member.teamClone, 'teamai.yaml'), 'reviewers: [lead]\n');
    fs.appendFileSync(path.join(member.teamClone, 'skills', 'deploy', 'SKILL.md'), 'Then tell the channel.\n');
    const file = localFile(member, 'pod-startup.yaml', TASK);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/pod-startup.yaml']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(pushed.output).toContain('Pull Request created: https://github.com/acme/team/pull/1');
    const branches = proposed(member);
    expect(Object.values(branches)).toEqual([['benchmarks/frontend/tasks/pod-startup.yaml']]);
    const [branch] = Object.keys(branches);
    expect(git(member.origin, ['show', `${branch}:benchmarks/frontend/tasks/pod-startup.yaml`])).toBe(TASK.trimEnd());
    expect(member.gh.calls().find((call) => call.args[1] === 'create')?.args).toEqual(expect.arrayContaining(['-R', 'acme/team', '-H', branch, '-B', 'main']));
    expect(git(member.teamClone, ['status', '--porcelain']).split('\n').map((line) => line.trim())).toEqual(['M skills/deploy/SKILL.md', 'M teamai.yaml']);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('pushes a skill file without rewriting it or any other skill file', async () => {
    const member = teamMember();
    const bytes = 'A note with no frontmatter.\n';
    const file = localFile(member, 'note.md', bytes);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'skills/deploy/notes/rollback.md']);

    expect(pushed.code, pushed.output).toBe(0);
    const [[branch, paths]] = Object.entries(proposed(member));
    expect(paths).toEqual(['skills/deploy/notes/rollback.md']);
    expect(git(member.origin, ['show', `${branch}:skills/deploy/notes/rollback.md`])).toBe(bytes.trimEnd());
  });

  it('keeps a new script executable', async () => {
    const member = teamMember();
    const file = localFile(member, 'rollback.sh', '#!/bin/sh\nkubectl rollout undo deployment/web\n');
    fs.chmodSync(file, 0o755);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'skills/deploy/scripts/rollback.sh']);

    expect(pushed.code, pushed.output).toBe(0);
    const [branch] = Object.keys(proposed(member));
    expect(git(member.origin, ['ls-tree', `${branch}`, '--', 'skills/deploy/scripts/rollback.sh']).split(/\s+/)[0]).toBe('100755');
  });

  it('pushes a scorer to the exact path given', async () => {
    const member = teamMember();
    const file = localFile(member, 'review.md', '---\nlabels: [pass, fail]\n---\nDid the review name a risk?\n');

    const pushed = teamai(member, ['push', '--file', file, '--path', 'scorers/review.md']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(Object.values(proposed(member))).toEqual([['scorers/review.md']]);
  });

  it('pushes to the branch --branch names', async () => {
    const member = teamMember();
    const file = localFile(member, 'pod-startup.yaml', TASK);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--branch', 'tasks/pod-startup']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(proposed(member)).toEqual({ 'tasks/pod-startup': ['benchmarks/frontend/tasks/pod-startup.yaml'] });
  });

  it('updates the open pull request of the branch --branch names, rather than opening another', async () => {
    const member = teamMember();
    const file = localFile(member, 'pod-startup.yaml', TASK);
    const args = ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--branch', 'tasks/pod-startup'];
    const first = teamai(member, args);
    expect(first.code, first.output).toBe(0);
    const reworked = TASK.replace('Make it start.', 'Make it start within 10 s.');
    fs.writeFileSync(file, reworked);

    const again = teamai(member, args);

    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('Updated pull request https://github.com/acme/team/pull/1');
    expect(proposed(member)).toEqual({ 'tasks/pod-startup': ['benchmarks/frontend/tasks/pod-startup.yaml'] });
    expect(git(member.origin, ['show', 'tasks/pod-startup:benchmarks/frontend/tasks/pod-startup.yaml'])).toBe(reworked.trimEnd());
    expect(member.gh.calls().filter((call) => call.args[1] === 'create')).toHaveLength(1);
  });

  it('refuses a --branch that origin has with no open pull request, and leaves that branch as it was', async () => {
    const member = teamMember();
    git(path.join(member.root, 'seed-team'), ['push', '-q', member.origin, 'main:refs/heads/release']);
    const release = git(member.origin, ['rev-parse', 'release']);
    const file = localFile(member, 'pod-startup.yaml', TASK);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--branch', 'release']);

    expect(pushed.code).not.toBe(0);
    expect(pushed.output).toContain('--branch release already exists on origin and teamai found no open pull request of it, so it is not rebuilt. Name a new branch, or the branch of your open pull request.');
    expect(git(member.origin, ['rev-parse', 'release'])).toBe(release);
    expect(member.gh.calls().filter((call) => call.args[1] === 'create')).toEqual([]);
  });

  it('answers no changes when the path already holds the same bytes', async () => {
    const member = teamMember();
    const file = localFile(member, 'old-bug.yaml', TASK);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/old-bug.yaml']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(pushed.output).toContain('No changes to push: benchmarks/frontend/tasks/old-bug.yaml already holds these bytes on main.');
    expect(proposed(member)).toEqual({});
  });

  it.each([
    [['--path', 'benchmarks/frontend/tasks/pod-startup.yaml'], '--file and --path go together: --file names the local file, --path where it goes in the team repo.'],
    [['--file', '{file}'], '--file and --path go together: --file names the local file, --path where it goes in the team repo.'],
    [['--file', '{file}', '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--role', 'web'], '--path names the destination, so it cannot be combined with --skill, --role, --project, --shared, --all or --carried.'],
    [['--file', '{file}', '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--carried', 'skills/deploy/SKILL.md@0123abc'], '--path names the destination, so it cannot be combined with --skill, --role, --project, --shared, --all or --carried.'],
    [['--file', '{file}', '--path', 'benchmarks/frontend/pod-startup.yaml'], 'benchmarks/frontend/pod-startup.yaml is not a benchmark task path. A task goes in benchmarks/<suite>/tasks/<task>.yaml or benchmarks/<namespace>/<suite>/tasks/<task>.yaml.'],
    [['--file', '{file}', '--path', 'benchmarks/missing/tasks/pod-startup.yaml'], 'benchmarks/missing/suite.yaml does not exist, so benchmarks/missing/tasks/pod-startup.yaml belongs to no suite. Pick a suite the team repo has under benchmarks/.'],
    [['--file', '{file}', '--path', 'skills/../../escape.md'], 'skills/../../escape.md is not a path inside the team repo. Give a relative path with "/" between its parts, such as benchmarks/frontend/tasks/pod-startup.yaml.'],
    [['--file', '{file}', '--path', 'notes/pod-startup.yaml'], 'notes/pod-startup.yaml is not under a team resource directory. Give a path under skills/, rules/, scorers/, benchmarks/ or another directory teamai pulls.'],
    [['--file', '{file}', '--path', 'skills/deploy/SKILL.md/notes.md'], 'skills/deploy/SKILL.md/notes.md goes through the file skills/deploy/SKILL.md in the team repo, so it is not pushed. Give a path whose directories are real directories.'],
    [['--file', '{file}', '--path', 'skills/linked/SKILL.md'], 'skills/linked/SKILL.md goes through the symlink skills/linked in the team repo, so it is not pushed. Give a path whose directories are real directories.'],
    [['--file', '{file}', '--path', 'benchmarks/frontend/tasks/pod-startup.yaml', '--branch', 'main'], '--branch main is the team repo\'s default branch, so the file would skip review. Name the pull request\'s branch, or leave --branch out.'],
  ])('refuses %j and pushes nothing', async (args, message) => {
    const member = teamMember();
    const seed = path.join(member.root, 'seed-team');
    fs.symlinkSync('deploy', path.join(seed, 'skills', 'linked'));
    git(seed, ['add', '-A']);
    git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'link']);
    git(seed, ['push', '-q', member.origin, 'main']);
    const file = localFile(member, 'pod-startup.yaml', TASK);
    const main = git(member.origin, ['rev-parse', 'main']);

    const pushed = teamai(member, ['push', ...args.map((arg) => arg.replace('{file}', file))]);

    expect(pushed.code).not.toBe(0);
    expect(pushed.output).toContain(message);
    expect(proposed(member)).toEqual({});
    expect(git(member.origin, ['rev-parse', 'main'])).toBe(main);
  });

  it('in single-repo mode proposes .teamai/<path>, and leaves the checkout\'s files, index and HEAD as they were', async () => {
    const member = selfMember();
    fs.writeFileSync(path.join(member.work, 'README.md'), '# app, edited\n');
    git(member.work, ['add', 'README.md']);
    fs.appendFileSync(path.join(member.work, '.teamai', 'teamai.yaml'), 'reviewers: [lead]\n');
    const before = { head: git(member.work, ['rev-parse', 'HEAD']), status: git(member.work, ['status', '--porcelain']), diff: git(member.work, ['diff', '--cached']) };
    const file = localFile(member, 'pod-startup.yaml', TASK);

    const pushed = teamai(member, ['push', '--file', file, '--path', 'benchmarks/frontend/tasks/pod-startup.yaml']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(pushed.output).toContain('Pull Request created: https://github.com/acme/frontend/pull/1');
    expect(Object.values(proposed(member))).toEqual([['.teamai/benchmarks/frontend/tasks/pod-startup.yaml']]);
    expect({ head: git(member.work, ['rev-parse', 'HEAD']), status: git(member.work, ['status', '--porcelain']), diff: git(member.work, ['diff', '--cached']) }).toEqual(before);
  });
});
