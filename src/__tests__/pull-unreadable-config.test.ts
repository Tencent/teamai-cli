/**
 * `teamai pull` in a project whose config cannot be read (#784): real config
 * files in a sandbox HOME, so detection runs for real. Only what reaches the
 * network or another process is stubbed; which team repos a pull fetches is
 * what these tests observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
  setStderrOnly: vi.fn(() => false),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(true) }));
vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

const { pull } = await import('../pull.js');
const { resolveProjectDataHome, saveLocalConfigForScope } = await import('../config.js');
const { pullRepo } = await import('../utils/git.js');
const { reportUsageToTeam } = await import('../team-push.js');
const { log } = await import('../utils/logger.js');

let tmp: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pull-unreadable-')));
  originalHome = process.env.HOME;
  originalCwd = process.cwd();
  originalExitCode = process.exitCode;
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.exitCode = originalExitCode;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function teamRepo(dir: string, team: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), `team: ${team}\nrepo: https://example.test/acme/${team}.git\n`);
  return dir;
}

function userScope(): string {
  const home = path.join(tmp, 'home', '.teamai');
  const repo = teamRepo(path.join(home, 'team-repo'), 'user-team');
  fs.writeFileSync(path.join(home, 'config.yaml'),
    `repo:\n  localPath: ${repo}\n  remote: https://example.test/acme/user-team.git\nusername: tester\nscope: user\n`);
  return repo;
}

function gitRepo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function brokenPartition(root: string): Promise<string> {
  const partition = await resolveProjectDataHome(root);
  fs.mkdirSync(partition, { recursive: true });
  const configPath = path.join(partition, 'config.yaml');
  fs.writeFileSync(configPath, 'repo: [not: a, valid config\n');
  return configPath;
}

function pulledRepos(): string[] {
  return vi.mocked(pullRepo).mock.calls.map(([repo]) => repo);
}

describe('pull in a project whose config cannot be read (#784)', () => {
  it('syncs nothing from a legacy .teamai/ of another team behind a broken partition, and says why', async () => {
    const root = gitRepo('project-a');
    const configPath = await brokenPartition(root);
    const legacy = path.join(root, '.teamai');
    const legacyRepo = teamRepo(path.join(legacy, 'team-repo'), 'other-team');
    fs.writeFileSync(path.join(legacy, 'config.yaml'),
      `repo:\n  localPath: ${legacyRepo}\n  remote: https://example.test/acme/other-team.git\nusername: tester\nscope: project\n`);
    process.chdir(root);

    await pull({});

    expect(pulledRepos()).toEqual([]);
    expect(reportUsageToTeam).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const errors = vi.mocked(log.error).mock.calls.map(([msg]) => msg);
    expect(errors).toHaveLength(1);
    expect(errors[0].startsWith(`Nothing was synced: ${configPath}: `)).toBe(true);
    expect(errors[0].endsWith('. Fix the file, or move it aside and run `teamai init` to write a new one.')).toBe(true);
    // A parse error's code frame spans several lines; only the first is printed.
    expect(errors[0]).not.toContain('\n');
    expect(errors[0]).not.toContain('teamai doctor');
  });

  it('does not pull or report the user scope in its place', async () => {
    userScope();
    const root = gitRepo('project-a');
    await brokenPartition(root);
    process.chdir(root);

    await pull({});

    expect(pulledRepos()).toEqual([]);
    expect(reportUsageToTeam).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('syncs nothing with --silent either and prints nothing: the reason goes to debug.log, the exit code is still 1', async () => {
    userScope();
    const root = gitRepo('project-a');
    await brokenPartition(root);
    process.chdir(root);

    await pull({ silent: true });

    expect(pulledRepos()).toEqual([]);
    expect(reportUsageToTeam).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(vi.mocked(log.persist).mock.calls.map(([msg]) => msg)).toEqual([
      expect.stringMatching(/^Nothing was synced: /),
    ]);
    // A pre-dispatch hook runs it as `teamai pull --silent … || true`.
    expect(process.exitCode).toBe(1);
  });

  it('pulls the project scope of a readable project config as before', async () => {
    userScope();
    const root = gitRepo('project-a');
    const dataHome = await resolveProjectDataHome(root);
    const repo = teamRepo(path.join(dataHome, 'team-repo'), 'team-a');
    await saveLocalConfigForScope({
      repo: { localPath: repo, remote: 'https://example.test/acme/team-a.git' },
      username: 'tester', scope: 'project', projectRoot: root, additionalRoles: [], dataHome,
    });
    process.chdir(root);

    await pull({});

    expect(pulledRepos()).toEqual([repo]);
    expect(process.exitCode).toBe(originalExitCode);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('pulls the user scope where there is no project config, as before', async () => {
    const userRepo = userScope();
    process.chdir(gitRepo('project-b'));

    await pull({});

    expect(pulledRepos()).toEqual([userRepo]);
    expect(process.exitCode).toBe(originalExitCode);
    expect(log.error).not.toHaveBeenCalled();
  });
});
