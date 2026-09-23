import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

const testRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-reconcile-'));
const originalHome = process.env.HOME;
process.env.HOME = path.join(testRoot, 'home');

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
  getDefaultBranch: vi.fn().mockResolvedValue('main'),
}));

vi.mock('../utils/pending-push.js', () => ({
  reconcilePlacementRecords: vi.fn().mockResolvedValue(false),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../utils/learnings-publish.js', () => ({
  publishQueuedLearnings: vi.fn().mockResolvedValue({ published: [], remaining: 0 }),
}));
vi.mock('../source.js', () => ({ pullSources: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({ version: 1, roles: [], defaults: { shareTarget: 'primary-role' } }),
  resolveRoleResourceNamespaces: vi.fn(() => ({ knowledge: [], skills: [], learnings: [] })),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

const { pull } = await import('../pull.js');
const { loadLocalConfigForScope, loadTeamConfig } = await import('../config.js');
const { reconcilePlacementRecords } = await import('../utils/pending-push.js');
import type { LocalConfig, TeamaiConfig } from '../types.js';

const business = path.join(testRoot, 'product');
const teamConfig: TeamaiConfig = {
  team: 'test',
  description: '',
  repo: 'https://example.test/team/repo.git',
  provider: 'git',
  reviewers: [],
  sharing: {
    skills: {},
    rules: { enforced: [] },
    docs: { localDir: '' },
    env: { injectShellProfile: false },
  },
  toolPaths: {},
};

function config(kind: 'git' | 'self'): LocalConfig {
  return kind === 'self'
    ? {
      repo: {
        localPath: path.join(business, '.teamai'),
        remote: 'https://example.test/team/repo.git',
        kind: 'self',
        businessRepoRoot: business,
      },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    }
    : {
      repo: { localPath: path.join(testRoot, 'team-repo'), remote: 'https://example.test/team/repo.git', kind: 'git' },
      username: 'alice',
      scope: 'user',
      additionalRoles: [],
    };
}

/**
 * Placement records are settled against the default branch. An independent
 * clone is that branch once pulled; a single-repo member's own checkout is
 * whatever they have out — a feature branch, a main not pulled yet — and a
 * record dropped against it never comes back, while skipping the pass there
 * left a merged placement unrecorded until the next push (#649 review). So a
 * single-repo pull reads the default branch as the ref origin/<default>.
 */
describe('teamai pull settles placement records against the default branch', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    await fse.outputFile(path.join(business, '.teamai', 'teamai.yaml'), 'team: test\n');
    await fse.outputFile(path.join(testRoot, 'team-repo', 'teamai.yaml'), 'team: test\n');
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fse.remove(testRoot);
  });

  it('in an independent clone', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(config('git'));

    await pull({ silent: true, force: true });

    expect(reconcilePlacementRecords).toHaveBeenCalledWith(path.join(testRoot, 'team-repo'), expect.anything(), undefined);
  });

  it('in single-repo mode, through origin/<default> rather than the member\'s checkout', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(config('self'));

    await pull({ silent: true, force: true });

    expect(reconcilePlacementRecords).toHaveBeenCalledWith(path.join(business, '.teamai'), expect.anything(), 'origin/main');
  });
});
