import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentInit: null as unknown,
  npmInstall: vi.fn(),
  npmSnapshot: vi.fn(),
  saveState: vi.fn(),
  createPullRequest: vi.fn().mockResolvedValue('https://example.test/pr/packages'),
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(async () => mocks.currentInit),
  detectProjectConfig: vi.fn(async () =>
    (mocks.currentInit as { localConfig?: unknown } | null)?.localConfig ?? null),
  loadLocalConfig: vi.fn(async () => null),
  loadStateForScope: vi.fn(async () => ({
    lastPush: null,
    lastPull: null,
    lastPullRev: null,
    pushedRules: [],
    pushedSkills: [],
    pushedEnvVars: [],
    pendingPushes: [],
    lastUpdateCheck: null,
    availableUpdate: null,
  })),
  saveStateForScope: mocks.saveState,
}));

vi.mock('../read-only.js', () => ({
  assertNotReadOnly: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start() { return this; },
    stop() { return this; },
    succeed() { return this; },
    fail() { return this; },
    warn() { return this; },
  })),
}));

vi.mock('../pkg/adapters/npm.js', () => ({
  NpmAdapter: class {
    validate = vi.fn().mockResolvedValue({ valid: true, errors: [] });
    install = mocks.npmInstall;
    snapshot = mocks.npmSnapshot;
    status = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../pkg/adapters/claude-plugin.js', () => ({
  ClaudePluginAdapter: class {
    validate = vi.fn().mockResolvedValue({ valid: true, errors: [] });
    registeredMarketplaces = vi.fn().mockResolvedValue([]);
    install = vi.fn().mockResolvedValue({ marketplaces: [], plugins: [] });
    snapshot = vi.fn().mockResolvedValue({ marketplaces: [], plugins: [] });
    status = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../providers/index.js', () => ({
  getProvider: vi.fn(() => ({
    name: 'github',
    parseRepoInput: vi.fn(() => ({
      owner: 'acme',
      repo: 'team',
      httpsUrl: 'https://github.com/acme/team.git',
    })),
    createPullRequest: mocks.createPullRequest,
  })),
}));

vi.mock('../utils/pre-push-sync.js', () => ({
  syncTeamUpdatesToLocal: vi.fn(),
}));

vi.mock('../utils/prompt.js', () => ({
  isInteractive: vi.fn(() => true),
  askQuestion: vi.fn(async () => ''),
  askConfirmation: vi.fn(async () => true),
  askSelection: vi.fn(async (_prompt: string, count: number) =>
    Array.from({ length: count }, (_value, index) => index)),
}));

import { pkgInstall } from '../pkg/commands.js';
import { computePackageHintOutput } from '../pkg/pkg-hint.js';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { pullRepo } from '../utils/git.js';
import { push } from '../push.js';

describe('team package distribution flow', () => {
  let root: string;
  let remote: string;
  let adminRepo: string;
  let teammateRepo: string;
  let adminProject: string;
  let teammateProject: string;
  let previousCwd: string;
  let previousHome: string | undefined;
  let previousExitCode: typeof process.exitCode;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-distribution-'));
    remote = path.join(root, 'remote.git');
    const seed = path.join(root, 'seed');
    adminRepo = path.join(root, 'admin-repo');
    teammateRepo = path.join(root, 'teammate-repo');
    adminProject = path.join(root, 'admin-project');
    teammateProject = path.join(root, 'teammate-project');
    previousCwd = process.cwd();
    previousHome = process.env.HOME;
    process.env.HOME = root;
    previousExitCode = process.exitCode;
    fs.mkdirSync(seed, { recursive: true });
    fs.mkdirSync(adminProject, { recursive: true });
    fs.mkdirSync(teammateProject, { recursive: true });
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'https://github.com/acme/team.git',
      provider: 'github',
      sharing: {},
      toolPaths: {},
    }));

    await simpleGit().init(['--bare', '--initial-branch=main', remote]);
    const seedGit = simpleGit(seed);
    await seedGit.init();
    await seedGit.addConfig('user.name', 'test');
    await seedGit.addConfig('user.email', 'test@example.com');
    await seedGit.add('.');
    await seedGit.commit('initial');
    await seedGit.branch(['-M', 'main']);
    await seedGit.addRemote('origin', remote);
    await seedGit.push(['-u', 'origin', 'main']);

    await simpleGit().clone(remote, adminRepo);
    await simpleGit().clone(remote, teammateRepo);
    for (const repo of [adminRepo, teammateRepo]) {
      await simpleGit(repo).addConfig('user.name', 'test');
      await simpleGit(repo).addConfig('user.email', 'test@example.com');
    }

    const installed = [{
      name: '@tencent/tokenlint',
      version: '1.3.3',
      source: 'npm',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    }];
    mocks.npmInstall.mockResolvedValue(installed);
    mocks.npmSnapshot.mockResolvedValue(installed);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    process.exitCode = previousExitCode;
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function initFor(repoPath: string, projectRoot: string, username: string): unknown {
    return {
      localConfig: {
        repo: { localPath: repoPath, remote, kind: 'git' },
        username,
        scope: 'project',
        projectRoot,
        additionalRoles: [],
      },
      teamConfig: {
        team: 'platform',
        repo: 'https://github.com/acme/team.git',
        provider: 'github',
        reviewers: [],
        sharing: {},
        toolPaths: {},
      },
    };
  }

  it('covers admin install+push, teammate pull+hint, and one-command restore', async () => {
    mocks.currentInit = initFor(adminRepo, adminProject, 'admin');
    process.chdir(adminProject);
    await pkgInstall('@tencent/tokenlint@latest', {
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    });

    const adminYaml = YAML.parse(fs.readFileSync(path.join(adminRepo, 'teamai.yaml'), 'utf8'));
    expect(adminYaml.packages.npm[0]).toMatchObject({
      name: '@tencent/tokenlint',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    });

    await push({ all: true });
    expect(mocks.createPullRequest).toHaveBeenCalledOnce();

    const remoteHeads = await simpleGit(adminRepo).listRemote(['--heads', 'origin']);
    const packageBranchLine = remoteHeads.split('\n').find(
      (line) => line && !line.endsWith('refs/heads/main'),
    );
    expect(packageBranchLine).toBeDefined();
    const packageCommit = packageBranchLine!.split(/\s+/)[0];
    await simpleGit(remote).raw(['update-ref', 'refs/heads/main', packageCommit]);

    await pullRepo(teammateRepo);
    mocks.currentInit = initFor(teammateRepo, teammateProject, 'teammate');
    process.chdir(teammateProject);

    const sessionStartHint = buildHandlerRegistry().find(
      (registration) =>
        registration.event === 'session-start'
        && registration.handler.name === 'package-hint',
    );
    const hint = await sessionStartHint!.handler.execute(
      { cwd: teammateProject },
      'claude', null,
    );
    expect(hint).toContain('teamai packages');

    mocks.npmInstall.mockClear();
    await pkgInstall(undefined, {});
    expect(mocks.npmInstall).toHaveBeenCalledWith(
      [expect.objectContaining({
        name: '@tencent/tokenlint',
        global: true,
        registry: 'https://mirrors.tencent.com/npm/',
      })],
      expect.objectContaining({ scope: 'project' }),
    );
    expect(await computePackageHintOutput(teammateProject)).toBeNull();
  });
});
