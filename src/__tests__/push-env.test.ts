import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';

// Regression for #881: `env add` edits env/env.yaml in a standalone team clone
// without committing and leaves the commit to `push`. The #690 dirty-clone
// guard refused that file, so the edit never got published. Drives the real
// envAdd() and push() against a bare "remote" and a working clone, mocking only
// config detection and the provider's PR creation.

const mockCreatePullRequest = vi.fn().mockResolvedValue('https://example.test/pr/1');
const mockAutoDetectInit = vi.fn();
const mockDetectProjectConfig = vi.fn();

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
  loadStateForScope: vi.fn(() => Promise.resolve({
    lastPush: null, pushedSkills: [], pushedRules: [], pushedEnvVars: [],
  })),
  saveStateForScope: vi.fn(() => Promise.resolve()),
}));

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

  fs.mkdirSync(path.join(seed, 'env'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'version: 1\n');
  fs.writeFileSync(path.join(seed, 'README.md'), '# team\n');
  fs.writeFileSync(path.join(seed, 'env', 'env.yaml'), 'variables:\n  - key: TEAM_VAR\n    value: first\n');
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

  it('keeps the env.yaml edit when the push rolls the clone back', async () => {
    const { envAdd } = await import('../env-commands.js');
    const { push } = await import('../push.js');
    await envAdd('TEAM_VAR', 'changed', {});
    // A local branch of the requested name makes the branch creation throw
    // after the copy step, so pushGroup resets and cleans the clone.
    await simpleGit(teamRepo).branch(['teamai/taken']);

    await push({ all: true, branch: 'teamai/taken' });

    expect(process.exitCode).toBe(1);
    expect(stderrOutput()).toContain('Push failed');
    expect(fs.readFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'utf8')).toContain('value: changed');
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
