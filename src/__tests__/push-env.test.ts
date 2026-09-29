import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import { askSelection } from '../utils/prompt.js';

// Regression for #881: `env add` edits env/env.yaml in a standalone team clone
// without committing and leaves the commit to `push`. The #690 dirty-clone
// guard refused that file, so the edit never got published. Drives the real
// envAdd() and push() against a bare "remote" and a working clone, mocking only
// config detection and the provider's PR creation.

const mockCreatePullRequest = vi.fn().mockResolvedValue('https://example.test/pr/1');
const mockAutoDetectInit = vi.fn();
const mockDetectProjectConfig = vi.fn();
const freshState = (): unknown => ({ lastPush: null, pushedSkills: [], pushedRules: [], pushedEnvVars: [] });
let storedState = freshState();

vi.mock('../providers/index.js', () => ({
  getProvider: () => ({
    name: 'github',
    parseRepoInput: (input: string) => ({ owner: 'acme', repo: 'team', httpsUrl: input }),
    createPullRequest: (...args: unknown[]) => mockCreatePullRequest(...args),
  }),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  detectProjectConfig: (...args: unknown[]) => mockDetectProjectConfig(...args),
  // One state file per test, so a second push sees the first one's records.
  loadStateForScope: vi.fn(() => Promise.resolve(structuredClone(storedState))),
  saveStateForScope: vi.fn((state: unknown) => {
    storedState = structuredClone(state);
    return Promise.resolve();
  }),
}));

// Path → writes still allowed before each further write fails, to stand for
// a disk that refuses the restore.
const failingWrites = new Map<string, number>();
vi.mock('../utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    writeFile: (filePath: string, content: string) => {
      const allowed = failingWrites.get(filePath);
      if (allowed === undefined) return actual.writeFile(filePath, content);
      if (allowed > 0) {
        failingWrites.set(filePath, allowed - 1);
        return actual.writeFile(filePath, content);
      }
      return Promise.reject(new Error(`EACCES: permission denied, open '${filePath}'`));
    },
  };
});

vi.mock('../read-only.js', () => ({ assertNotReadOnly: vi.fn() }));
vi.mock('../utils/pre-push-sync.js', () => ({ syncTeamUpdatesToLocal: vi.fn() }));
vi.mock('../utils/prompt.js', () => ({
  isInteractive: vi.fn(() => true),
  askQuestion: vi.fn(() => Promise.resolve('')),
  askConfirmation: vi.fn(() => Promise.resolve(true)),
  askSelection: vi.fn((_p: string, n: number, all?: boolean) =>
    Promise.resolve(all ? Array.from({ length: n }, (_x, i) => i) : null)),
  parseSelection: vi.fn(),
  closePrompt: vi.fn(),
}));

async function initTeamRepos(root: string): Promise<{ teamRepo: string; remote: string }> {
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const teamRepo = path.join(root, 'team-repo');
  await simpleGit().init(['--bare', '--initial-branch=main', remote]);

  fs.mkdirSync(path.join(seed, 'env', 'team'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'version: 1\n');
  fs.writeFileSync(path.join(seed, 'README.md'), '# team\n');
  fs.writeFileSync(path.join(seed, 'env', 'env.yaml'), 'variables:\n  - key: TEAM_VAR\n    value: first\n');
  fs.writeFileSync(path.join(seed, 'env', 'team', 'env.yaml'), 'variables:\n  - key: TEAM_ONLY\n    value: first\n');
  const seedGit = simpleGit(seed);
  await seedGit.init();
  await seedGit.addConfig('user.email', 't@t.com');
  await seedGit.addConfig('user.name', 't');
  await seedGit.add('.');
  await seedGit.commit('init');
  await seedGit.branch(['-M', 'main']);
  await seedGit.addRemote('origin', remote);
  await seedGit.push(['-u', 'origin', 'main']);

  await simpleGit().clone(remote, teamRepo);
  const trGit = simpleGit(teamRepo);
  await trGit.addConfig('user.email', 't@t.com');
  await trGit.addConfig('user.name', 't');
  return { teamRepo, remote };
}

/** What log.error printed. */
function errorOutput(): string {
  return vi.mocked(console.error).mock.calls.map((args) => args.map(String).join(' ')).join('\n');
}

/** What push printed to stderr, where the spinner reports the refusal. */
function stderrOutput(): string {
  return vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join('');
}

async function pushBranches(remote: string): Promise<string[]> {
  const out = await simpleGit(remote).raw(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/']);
  return out.split('\n').filter(Boolean);
}

describe('push publishes the env files env add leaves in a standalone clone (#881)', () => {
  let tmpDir: string;
  let teamRepo: string;
  let remote: string;
  let previousExitCode: typeof process.exitCode;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-push-env-'));
    vi.clearAllMocks();
    failingWrites.clear();
    storedState = freshState();
    mockCreatePullRequest.mockResolvedValue('https://example.test/pr/1');
    ({ teamRepo, remote } = await initTeamRepos(tmpDir));
    const localConfig = {
      repo: { localPath: teamRepo, remote },
      username: 'alice',
      scope: 'user',
    };
    mockDetectProjectConfig.mockResolvedValue(localConfig);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig: { repo: 'acme/team', toolPaths: {} } });
    previousExitCode = process.exitCode;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = previousExitCode;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pushes the env.yaml edit from env add', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('TEAM_VAR', 'changed', {});
    expect(await simpleGit(teamRepo).raw(['status', '--porcelain'])).toContain('env/env.yaml');

    await push({ all: true });

    expect(process.exitCode).toBe(previousExitCode);
    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const [branch] = await pushBranches(remote);
    expect(branch).toBeDefined();
    const pushed = await simpleGit(remote).show([`${branch}:env/env.yaml`]);
    expect(pushed).toContain('value: changed');
  });

  // #879: `env add --secret` leaves env/secrets.yaml for push the same way.
  it('pushes the secrets.yaml that env add --secret creates', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('GITHUB_TOKEN', undefined, { secret: true });
    expect(await simpleGit(teamRepo).raw(['status', '--porcelain', '--untracked-files=all'])).toContain('env/secrets.yaml');

    await push({ all: true });

    expect(process.exitCode).toBe(previousExitCode);
    const [branch] = await pushBranches(remote);
    expect(branch).toBeDefined();
    const pushed = await simpleGit(remote).show([`${branch}:env/secrets.yaml`]);
    expect(pushed).toContain('key: GITHUB_TOKEN');
    expect(pushed).not.toContain('value');
  });

  it('keeps the env.yaml edit when the refresh fails after the reset', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('TEAM_VAR', 'changed', {});
    await simpleGit(teamRepo).remote(['set-url', 'origin', path.join(tmpDir, 'missing.git')]);

    await push({ all: true });

    expect(stderrOutput()).toContain('Pull failed');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
  });

  it('still refuses when another path is dirty, and keeps the env edit', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('TEAM_VAR', 'changed', {});
    fs.appendFileSync(path.join(teamRepo, 'README.md'), 'local note\n');

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    const errors = stderrOutput();
    expect(errors).toContain('Cannot push: the team repo has uncommitted changes');
    expect(errors).toMatch(/Paths: README\.md$/m);
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
    expect(await pushBranches(remote)).toEqual([]);
    expect(fs.readFileSync(path.join(teamRepo, 'README.md'), 'utf8')).toContain('local note');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
  });

  it('still refuses an env.yaml edit staged before a later edit, and keeps both', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    const envPath = path.join(teamRepo, 'env', 'env.yaml');
    await envAdd('TEAM_VAR', 'staged', {});
    await git.add('env/env.yaml');
    // Edited by hand: a second `env add` would realign the clone first.
    fs.writeFileSync(envPath, fs.readFileSync(envPath, 'utf8').replace('value: staged', 'value: changed'));

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toMatch(/Paths: env\/env\.yaml$/m);
    expect(await pushBranches(remote)).toEqual([]);
    expect(await git.show([':env/env.yaml'])).toContain('value: staged');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
  });

  it('keeps the env.yaml edit and its mode when the push rolls the clone back', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const envPath = path.join(teamRepo, 'env', 'env.yaml');
    await envAdd('TEAM_VAR', 'changed', {});
    // Git sees no mode change in 0600, but reset --hard recreates the file 0644.
    fs.chmodSync(envPath, 0o600);
    // A local branch of the requested name makes the branch creation throw
    // after the copy step, so pushGroup resets and cleans the clone.
    await simpleGit(teamRepo).branch(['teamai/taken']);

    await push({ all: true, branch: 'teamai/taken' });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Push failed');
    expect(fs.readFileSync(envPath, 'utf8')).toContain('value: changed');
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('pushes only the selected env file and keeps the deselected edit in the clone', async () => {
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    const rootEnv = path.join(teamRepo, 'env', 'env.yaml');
    const teamEnv = path.join(teamRepo, 'env', 'team', 'env.yaml');
    fs.writeFileSync(rootEnv, fs.readFileSync(rootEnv, 'utf8').replace('value: first', 'value: selected'));
    fs.writeFileSync(teamEnv, fs.readFileSync(teamEnv, 'utf8').replace('value: first', 'value: deselected'));
    // Entry files list the root first: 1. env.yaml, 2. team/env.yaml.
    vi.mocked(askSelection).mockResolvedValueOnce([0]);

    await push({});

    const [branch] = await pushBranches(remote);
    expect(branch).toBeDefined();
    expect(await simpleGit(remote).show([`${branch}:env/env.yaml`])).toContain('value: selected');
    expect(await simpleGit(remote).show([`${branch}:env/team/env.yaml`])).toContain('value: first');
    expect(fs.readFileSync(teamEnv, 'utf8')).toContain('value: deselected');
    expect(await git.raw(['status', '--porcelain'])).toContain('env/team/env.yaml');
  });

  it('keeps the env.yaml edit on the default branch when git push fails after the commit, and retries it', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });
    await envAdd('TEAM_VAR', 'changed', {});

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Push failed');
    expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(await git.raw(['status', '--porcelain'])).toContain('env/env.yaml');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');

    fs.rmSync(hook);
    process.exitCode = previousExitCode;
    // A generated name could repeat the failed run's, which is still a local branch.
    await push({ all: true, branch: 'teamai/retry' });

    const [branch] = await pushBranches(remote);
    expect(branch).toBeDefined();
    expect(await simpleGit(remote).show([`${branch}:env/env.yaml`])).toContain('value: changed');
  });

  it('restores a new env file env add --role created when the push rolls the clone back', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    const opsEnv = path.join(teamRepo, 'env', 'ops', 'env.yaml');
    await envAdd('OPS_VAR', 'ops-value', { role: 'ops' });
    expect(await git.raw(['status', '--porcelain', '--untracked-files=all'])).toContain('?? env/ops/env.yaml');
    // Git records no mode for an untracked file, so only the snapshot can keep it.
    fs.chmodSync(opsEnv, 0o600);
    await git.branch(['teamai/taken']);

    await push({ all: true, branch: 'teamai/taken' });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Push failed');
    expect(fs.readFileSync(opsEnv, 'utf8')).toContain('value: ops-value');
    expect(fs.statSync(opsEnv).mode & 0o777).toBe(0o600);
    expect(await git.raw(['status', '--porcelain', '--untracked-files=all'])).toContain('?? env/ops/env.yaml');
  });

  it('restores a new env file env add --role created when git push fails after the commit', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    const opsEnv = path.join(teamRepo, 'env', 'ops', 'env.yaml');
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await envAdd('OPS_VAR', 'ops-value', { role: 'ops' });
    fs.chmodSync(opsEnv, 0o600);

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(fs.readFileSync(opsEnv, 'utf8')).toContain('value: ops-value');
    expect(fs.statSync(opsEnv).mode & 0o777).toBe(0o600);
    expect(await git.raw(['status', '--porcelain', '--untracked-files=all'])).toContain('?? env/ops/env.yaml');
  });

  it('keeps the teamai.yaml edit on the default branch when git push fails after the commit', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    fs.writeFileSync(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await envAdd('TEAM_VAR', 'changed', {});
    // After env add, whose refresh would realign the clone and drop it.
    fs.appendFileSync(path.join(teamRepo, 'teamai.yaml'), '# local edit\n');

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect((await git.revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(fs.readFileSync(path.join(teamRepo, 'teamai.yaml'), 'utf8')).toContain('# local edit');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
  });

  it('stops and names the env file when putting it back after the refresh fails', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('TEAM_VAR', 'changed', {});
    failingWrites.set(path.join(teamRepo, 'env', 'env.yaml'), 0);

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).not.toContain('Pull failed');
    expect(errorOutput()).toMatch(/env\/env\.yaml \(EACCES: permission denied/);
    expect(errorOutput()).toContain('teamai env add');
    expect(mockCreatePullRequest).not.toHaveBeenCalled();
  });

  it('stops and names the env file when putting it back after a group fails', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const { saveStateForScope } = await import('../config.js');
    await envAdd('TEAM_VAR', 'changed', {});
    await simpleGit(teamRepo).branch(['teamai/taken']);
    // The restore after the refresh succeeds; the one after the rollback fails.
    failingWrites.set(path.join(teamRepo, 'env', 'env.yaml'), 1);

    await push({ all: true, branch: 'teamai/taken' });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Push failed');
    expect(errorOutput()).toMatch(/env\/env\.yaml \(EACCES: permission denied/);
    expect(errorOutput()).toContain('teamai env add');
    // Earlier groups' PR records are saved before stopping, as for any failed group.
    expect(vi.mocked(saveStateForScope)).toHaveBeenCalled();
  });

  it('keeps the bytes of an env file that is not UTF-8', async () => {
    const { push } = await import('../push.js');
    const envPath = path.join(teamRepo, 'env', 'env.yaml');
    // A hand edit saved as Latin-1: 0xE9 is "é" there and invalid UTF-8.
    const latin1 = Buffer.from('variables:\n  - key: TEAM_VAR\n    value: caf\xe9\n', 'latin1');
    fs.writeFileSync(envPath, latin1);
    await simpleGit(teamRepo).branch(['teamai/taken']);

    await push({ all: true, branch: 'teamai/taken' });

    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(envPath).equals(latin1)).toBe(true);
  });

  it('keeps a deselected env edit when a group with no change rolls the clone back', async () => {
    const { push } = await import('../push.js');
    const rootEnv = path.join(teamRepo, 'env', 'env.yaml');
    fs.writeFileSync(rootEnv, fs.readFileSync(rootEnv, 'utf8').replace('value: first', 'value: deselected'));
    // A blank line only: pushRepoBranch reads it as metadata, resets and cleans.
    fs.appendFileSync(path.join(teamRepo, 'env', 'team', 'env.yaml'), '\n');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({});

    expect(await pushBranches(remote)).toEqual([]);
    expect(fs.readFileSync(rootEnv, 'utf8')).toContain('value: deselected');
  });

  /** Push an env/team/env.yaml edit whose PR creation fails, leaving a reuse record with prUrl null. */
  async function pushWithoutPr(): Promise<void> {
    const { push } = await import('../push.js');
    const teamEnv = path.join(teamRepo, 'env', 'team', 'env.yaml');
    fs.writeFileSync(teamEnv, fs.readFileSync(teamEnv, 'utf8').replace('value: first', 'value: reviewed'));
    mockCreatePullRequest.mockResolvedValue(null);
    await push({ all: true });
    expect(await pushBranches(remote)).toHaveLength(1);
    expect(fs.readFileSync(teamEnv, 'utf8')).toContain('value: first');
    process.exitCode = previousExitCode;
    vi.mocked(process.stderr.write).mockClear();
  }

  it('keeps a deselected env edit when a reuse group that retries its PR rolls the clone back', async () => {
    const { push } = await import('../push.js');
    await pushWithoutPr();
    const rootEnv = path.join(teamRepo, 'env', 'env.yaml');
    fs.writeFileSync(rootEnv, fs.readFileSync(rootEnv, 'utf8').replace('value: first', 'value: deselected'));
    // The recorded file now differs from main by a blank line only: the reuse
    // branch is rebuilt from main, reads that as metadata, resets and cleans
    // the clone, then retries the missing PR.
    fs.appendFileSync(path.join(teamRepo, 'env', 'team', 'env.yaml'), '\n');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);
    mockCreatePullRequest.mockClear();

    await push({});

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(rootEnv, 'utf8')).toContain('value: deselected');
  });

  it('keeps a deselected env edit when the config-only push after the reuse groups has no change', async () => {
    const { push } = await import('../push.js');
    await pushWithoutPr();
    const rootEnv = path.join(teamRepo, 'env', 'env.yaml');
    const teamEnv = path.join(teamRepo, 'env', 'team', 'env.yaml');
    fs.writeFileSync(rootEnv, fs.readFileSync(rootEnv, 'utf8').replace('value: first', 'value: deselected'));
    fs.writeFileSync(teamEnv, fs.readFileSync(teamEnv, 'utf8').replace('value: first', 'value: reviewed again'));
    // A blank line only: pushTeamConfigOnly's pushRepoBranch resets and cleans.
    fs.appendFileSync(path.join(teamRepo, 'teamai.yaml'), '\n');
    vi.mocked(askSelection).mockResolvedValueOnce([1]);

    await push({ branch: 'teamai/config' });

    expect(stderrOutput()).toContain('No changes to push (config already up to date)');
    expect(fs.readFileSync(rootEnv, 'utf8')).toContain('value: deselected');
  });

  it('still refuses a deleted env.yaml', async () => {
    const { push } = await import('../push.js');
    fs.rmSync(path.join(teamRepo, 'env', 'env.yaml'));

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Paths: env/env.yaml');
    expect(await pushBranches(remote)).toEqual([]);
  });

  it('still refuses a mode change on env.yaml', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    const git = simpleGit(teamRepo);
    await git.addConfig('core.fileMode', 'true');
    await envAdd('TEAM_VAR', 'changed', {});
    fs.chmodSync(path.join(teamRepo, 'env', 'env.yaml'), 0o755);

    await push({ all: true });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Paths: env/env.yaml');
    expect(await pushBranches(remote)).toEqual([]);
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
  });
});
