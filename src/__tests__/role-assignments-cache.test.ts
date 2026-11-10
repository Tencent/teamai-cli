import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every git helper is spied on and still calls through, so a test can tell
// whether a config load ran git at all.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  return Object.fromEntries(Object.entries(actual).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value]));
});

/** The modules of one CLI process: each hook is a process of its own, so a second load must not rely on memory. */
async function freshProcess() {
  vi.resetModules();
  // The mocked module outlives the reset, spies and their calls included.
  const git = await import('../utils/git.js');

  for (const value of Object.values(git)) if (vi.isMockFunction(value)) value.mockClear();

  return {
    git,
    loadLocalConfig: (await import('../config.js')).loadLocalConfig,
    resetWarnOnce: (await import('../utils/warn-once.js')).resetWarnOnce,
    activeRoleIds: (await import('../roles.js')).activeRoleIds,
    loadRoleAssignments: (await import('../role-assignments.js')).loadRoleAssignments,
    log: (await import('../utils/logger.js')).log,
  };
}

let cli = await freshProcess();

/** The temporary directory of the run, outside every sandbox's profile. */
const runTmp = os.tmpdir();

/** As on Windows, where no uid tells who owns the temporary directory. */
function withoutUid(): void {
  const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', { value: undefined, configurable: true, writable: true });
  onTestFinished(() => {
    if (getuid) Object.defineProperty(process, 'getuid', getuid);
    else Reflect.deleteProperty(process, 'getuid');
  });
}

/** Point every variable os.tmpdir() reads, on any platform, at `dir`. */
function useTmp(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, dir);
}

/** The git helpers this process has called, by name. */
function gitCalls(): string[] {
  return Object.entries(cli.git).flatMap(([name, value]) => (vi.isMockFunction(value) && value.mock.calls.length > 0 ? [name] : []));
}

/**
 * Every config load reads `manifest/members.yaml` at `origin/<default>` (#1186).
 * A hook loads the config on every tool call, so what it read is kept, for
 * later processes too, under the commit it was read at (#1788).
 */
describe('role assignments cached by the fetched commit', () => {
  const originalHome = process.env.HOME;
  let sandbox: string;
  let upstream: string;
  let clone: string;

  const ROLES = 'version: 1\nroles:\n  - id: frontend\n    resources: { knowledge: [], skills: [frontend] }\n  - id: backend\n    resources: { knowledge: [], skills: [backend] }\n';

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'TeamAI Test', GIT_AUTHOR_EMAIL: 'test@teamai.test',
        GIT_COMMITTER_NAME: 'TeamAI Test', GIT_COMMITTER_EMAIL: 'test@teamai.test',
      },
    });
  }

  function assign(content: string, message: string): void {
    writeFileSync(path.join(upstream, 'manifest', 'members.yaml'), content, 'utf-8');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-qm', message);
  }

  async function activeRoles(): Promise<string[] | null> {
    const config = await cli.loadLocalConfig();

    if (!config) throw new Error('the fixture config did not load');

    return cli.activeRoleIds(config);
  }

  async function primaryRole(): Promise<string | undefined> {
    return (await cli.loadLocalConfig())?.primaryRole;
  }

  beforeEach(async () => {
    cli = await freshProcess();
    sandbox = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-cache-'));
    process.env.HOME = sandbox;
    vi.stubEnv('USERPROFILE', sandbox);
    // Inside the profile, as Windows' default %LOCALAPPDATA%\Temp is.
    useTmp(path.join(sandbox, 'AppData', 'Local', 'Temp'));
    upstream = path.join(sandbox, 'upstream');
    clone = path.join(sandbox, 'clone');
    mkdirSync(path.join(upstream, 'manifest'), { recursive: true });
    writeFileSync(path.join(upstream, 'manifest', 'roles.yaml'), ROLES, 'utf-8');
    writeFileSync(path.join(upstream, 'manifest', 'members.yaml'), 'version: 1\nmembers:\n  alice: [frontend]\n', 'utf-8');
    git(upstream, 'init', '-q', '-b', 'main');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'fixture');
    git(sandbox, 'clone', '-q', upstream, clone);
    mkdirSync(path.join(sandbox, '.teamai'), { recursive: true });
    writeFileSync(
      path.join(sandbox, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${clone}\n  remote: https://gitlab.com/acme/team.git\nusername: alice\n`,
      'utf-8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('runs no git for roles in a later process at the same commit', async () => {
    expect(await primaryRole()).toBe('frontend');
    cli = await freshProcess();

    expect(await primaryRole()).toBe('frontend');
    expect(gitCalls()).toEqual([]);
  });

  it('reads again once a fetch moves the ref', async () => {
    expect(await primaryRole()).toBe('frontend');
    assign('version: 1\nmembers:\n  alice: [backend]\n', 'reassign alice');
    git(clone, 'fetch', '-q');

    expect(await primaryRole()).toBe('backend');
  });

  // A dry run loads the config too, and promises the TeamAI home stays as it was (#900).
  it('writes nothing in the TeamAI home', async () => {
    expect(await primaryRole()).toBe('frontend');

    expect(readdirSync(path.join(sandbox, '.teamai'))).toEqual(['config.yaml']);
  });

  it('does not remember a failed read as an absent file', async () => {
    const blob = execFileSync('git', ['rev-parse', 'origin/main:manifest/members.yaml'], { cwd: clone, encoding: 'utf8' }).trim();
    const object = path.join(clone, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    renameSync(object, `${object}.away`);

    // Unreadable reads as absent, as it always has: the member keeps no assigned role.
    expect(await primaryRole()).toBeUndefined();
    renameSync(`${object}.away`, object);
    cli = await freshProcess();

    expect(await primaryRole()).toBe('frontend');
  });

  it('holds no roles at either load when the file cannot be parsed', async () => {
    assign('version: 1\nmembers: [alice]\n', 'break the manifest');
    git(clone, 'fetch', '-q');
    // The member's own selection, which an unreadable assignments file must not leave in charge (#1096).
    writeFileSync(
      path.join(sandbox, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${clone}\n  remote: https://gitlab.com/acme/team.git\nusername: alice\nprimaryRole: backend\n`,
      'utf-8',
    );
    vi.spyOn(cli.log, 'warn').mockImplementation(() => {});

    expect(await activeRoles()).toEqual([]);
    cli = await freshProcess();
    vi.spyOn(cli.log, 'warn').mockImplementation(() => {});
    expect(await activeRoles()).toEqual([]);
    expect(gitCalls()).toEqual([]);
  });

  it('keeps the answer for later processes on Windows, in a temporary directory inside the profile', async () => {
    withoutUid();

    expect(await primaryRole()).toBe('frontend');
    cli = await freshProcess();
    expect(await primaryRole()).toBe('frontend');
    expect(gitCalls()).toEqual([]);
  });

  // Another user may write a temporary directory outside the profile, and a kept answer says where teamai writes.
  it('keeps nothing on Windows when the temporary directory lies outside the profile', async () => {
    withoutUid();
    const shared = mkdtempSync(path.join(runTmp, 'teamai-shared-tmp-'));
    onTestFinished(() => rmSync(shared, { recursive: true, force: true }));
    useTmp(shared);

    expect(await primaryRole()).toBe('frontend');
    cli = await freshProcess();
    expect(await primaryRole()).toBe('frontend');
    expect(gitCalls()).not.toEqual([]);
  });

  // Self mode: the team repo is `.teamai/` in the business repo, whose git dir is the repo's own.
  it('reads a team in self mode at the fetched commit once', async () => {
    mkdirSync(path.join(upstream, '.teamai', 'manifest'), { recursive: true });
    writeFileSync(path.join(upstream, '.teamai', 'manifest', 'members.yaml'), 'version: 1\nmembers:\n  alice: [backend]\n', 'utf-8');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-qm', 'self-mode team');
    git(clone, 'pull', '-q');
    // Fetched but not merged: the assignment at the tip is the one that holds.
    writeFileSync(path.join(upstream, '.teamai', 'manifest', 'members.yaml'), 'version: 1\nmembers:\n  alice: [backend, frontend]\n', 'utf-8');
    git(upstream, 'commit', '-qam', 'reassign alice');
    git(clone, 'fetch', '-q');

    expect((await cli.loadRoleAssignments(path.join(clone, '.teamai'))).members).toEqual({ alice: ['backend', 'frontend'] });
    cli = await freshProcess();
    expect((await cli.loadRoleAssignments(path.join(clone, '.teamai'))).members).toEqual({ alice: ['backend', 'frontend'] });
    expect(gitCalls()).toEqual([]);
  });

  it('reads the ref from files in a linked worktree and from packed refs', async () => {
    git(clone, 'pack-refs', '--all');
    const linked = path.join(sandbox, 'linked');
    git(clone, 'worktree', 'add', '-q', linked);
    writeFileSync(
      path.join(sandbox, '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${linked}\n  remote: https://gitlab.com/acme/team.git\nusername: alice\n`,
      'utf-8',
    );

    expect(await primaryRole()).toBe('frontend');
    cli = await freshProcess();
    expect(await primaryRole()).toBe('frontend');
    expect(gitCalls()).toEqual([]);
  });
});
