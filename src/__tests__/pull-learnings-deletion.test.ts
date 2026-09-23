import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

const testRoot = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-learnings-delete-'));
const originalHome = process.env.HOME;
process.env.HOME = path.join(testRoot, 'home');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({ knowledge: [], skills: [], learnings: [] })),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

const { pull } = await import('../pull.js');
const { loadLocalConfigForScope, loadTeamConfig } = await import('../config.js');
const { getUserLearningsDir, getUserSearchIndexPath } = await import('../types.js');
const { loadIndex } = await import('../utils/search-index.js');
import type { LocalConfig, TeamaiConfig } from '../types.js';

const repoPath = path.join(testRoot, 'team-repo');
const localConfig: LocalConfig = {
  repo: { localPath: repoPath, remote: 'https://example.test/team/repo.git' },
  username: 'alice',
  updatePolicy: 'auto',
  additionalRoles: [],
  scope: 'user',
};
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

describe('pull — user-scope learning deletion propagation (issue #458)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await fse.remove(repoPath);
    await fse.remove(getUserLearningsDir());
    await fse.remove(getUserSearchIndexPath());
    await fse.outputFile(path.join(repoPath, 'learnings', 'shared-a.md'), '---\ntitle: shared a\n---\n');
    await fse.outputFile(path.join(repoPath, 'learnings', 'shared-b.md'), '---\ntitle: shared b\n---\n');
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    await fse.remove(testRoot);
  });

  it('removes a shared Markdown file deleted upstream and drops it from the index', async () => {
    await pull({ silent: true });
    expect(await fse.pathExists(path.join(getUserLearningsDir(), 'shared-b.md'))).toBe(true);

    await fse.remove(path.join(repoPath, 'learnings', 'shared-b.md'));
    await pull({ silent: true, force: true });

    expect(await fse.pathExists(path.join(getUserLearningsDir(), 'shared-b.md'))).toBe(false);
    const index = await loadIndex(getUserSearchIndexPath());
    expect(index?.entries.map((entry) => entry.title)).toEqual(['shared a']);
  });
});
