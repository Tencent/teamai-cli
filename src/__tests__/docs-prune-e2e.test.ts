import { afterEach, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
let sandbox: string;

afterEach(async () => {
  if (sandbox) await fse.remove(sandbox);
});

it('real pull prunes deleted docs from a Git remote, including deletion of the last doc (#794)', async () => {
  sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-docs-prune-e2e-'));
  const home = path.join(sandbox, 'home');
  const remote = path.join(sandbox, 'remote');
  const clone = path.join(home, '.teamai', 'team-repo');
  const destination = path.join(home, '.teamai', 'docs');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(sandbox, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'TeamAI Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'TeamAI Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
  const pull = (...args: string[]) => execFileSync(process.execPath, [cli, 'pull', ...args], {
    cwd: home, env, encoding: 'utf8', stdio: 'pipe', timeout: 30_000,
  });
  const docsCheck = () => {
    // Other doctor checks may fail in this deliberately minimal fixture.
    const result = spawnSync(process.execPath, [cli, 'doctor', '--json'], {
      cwd: home, env, encoding: 'utf8', timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout);
    return report.checks.find((check: { name: string }) => check.name === 'Team docs delivered');
  };
  const commit = () => {
    git(remote, 'add', '-A');
    git(remote, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Update team docs');
  };

  await fse.ensureDir(home);
  await fse.outputFile(path.join(remote, 'teamai.yaml'), YAML.stringify({
    team: 'docs-prune-test', repo: remote, provider: 'git',
    sharing: { docs: { localDir: '~/.teamai/docs' } },
    toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
  }));
  await fse.outputFile(path.join(remote, 'docs', 'guide.md'), 'original');
  await fse.outputFile(path.join(remote, 'docs', 'old', 'retired.md'), 'retired');
  git(remote, 'init', '-q', '-b', 'main');
  commit();
  git(sandbox, 'clone', '-q', remote, clone);
  await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({
    repo: { localPath: clone, remote }, username: 'tester', scope: 'user', updatePolicy: 'skip',
  }));
  await fse.ensureDir(path.join(home, '.claude'));

  expect(pull()).toContain('Synced 2 docs');
  expect(await fse.readFile(path.join(destination, 'old', 'retired.md'), 'utf8')).toBe('retired');

  // The same path changes type in both directions across real Git revisions.
  await fse.remove(path.join(remote, 'docs', 'old'));
  await fse.outputFile(path.join(remote, 'docs', 'old'), 'replacement file');
  commit();
  expect(pull()).toContain('Synced 2 docs');
  expect(await fse.readFile(path.join(destination, 'old'), 'utf8')).toBe('replacement file');
  expect(docsCheck().ok).toBe(true);

  await fse.remove(path.join(remote, 'docs', 'old'));
  await fse.outputFile(path.join(remote, 'docs', 'old', 'retired.md'), 'replacement directory');
  commit();
  expect(pull()).toContain('Synced 2 docs');
  expect(await fse.readFile(path.join(destination, 'old', 'retired.md'), 'utf8')).toBe('replacement directory');
  expect(docsCheck().ok).toBe(true);

  await fse.outputFile(path.join(destination, '.keep'), 'local metadata');
  await fse.outputFile(path.join(destination, 'draft.md'), 'local-only');
  await fse.remove(path.join(remote, 'docs', 'old'));
  await fse.outputFile(path.join(remote, 'docs', 'guide.md'), 'updated');
  commit();

  expect(pull()).toContain('Synced 1 docs');
  expect(await fse.readFile(path.join(destination, 'guide.md'), 'utf8')).toBe('updated');
  expect(await fse.pathExists(path.join(destination, 'old'))).toBe(false);
  expect(await fse.pathExists(path.join(destination, 'draft.md'))).toBe(false);
  expect(await fse.readFile(path.join(destination, '.keep'), 'utf8')).toBe('local metadata');
  expect(docsCheck().ok).toBe(true);

  await fse.remove(path.join(remote, 'docs'));
  commit();
  // --dry-run deliberately does not fetch; update the cached clone for the preview.
  git(clone, 'pull', '--ff-only');
  const staleCheck = docsCheck();
  expect(staleCheck.ok).toBe(false);
  expect(staleCheck.fix).toContain('Stale docs');
  expect(staleCheck.fix).toContain('guide.md');
  expect(pull('--dry-run')).toContain('Would sync 0 docs and remove stale local docs');
  expect(await fse.pathExists(path.join(destination, 'guide.md'))).toBe(true);
  expect(pull()).toContain('Synced 0 docs');
  expect(await fse.readdir(destination)).toEqual(['.keep']);
  expect(docsCheck()).toBeUndefined();
  expect(pull()).toContain('Already synced');
}, 120_000);
