/**
 * The selection a pull delivers for (#1178): the member's scope, roles, projects, tags, excluded skills and user-scope
 * inheritance, kept in the checkout's record when the pull delivers. Asserted through `pull`, on the state it saves.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    persist: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
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
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue({ ok: true, defs: [] }),
  deliveredHookFiles: vi.fn().mockResolvedValue([]),
  unreadableHookFiles: vi.fn().mockResolvedValue([]),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
}));
vi.mock('../team-push.js', () => ({ reportUsageToTeam: vi.fn().mockResolvedValue(true) }));
vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
  capUsageEvents: vi.fn().mockResolvedValue(undefined),
}));
// pull() takes a real lock file; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig } from '../types.js';

describe('pull: the selection it delivered for', () => {
  let tmpDir: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-selection-')));
    const homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude'));
    vi.stubEnv('HOME', homeDir);
    for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG', 'XDG_CONFIG_HOME']) vi.stubEnv(key, '');
    vi.clearAllMocks();
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({
      team: 'test', repo: 'https://example.com/test/repo.git', provider: 'tgit', toolPaths: { claude: { agents: '.claude/agents' } },
    }));
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com/test/repo.git' },
      username: 'member', updatePolicy: 'auto', scope: 'user',
      primaryRole: 'backend', additionalRoles: ['sre', 'data'], subscribedTags: ['go'], excludedSkills: ['legacy'],
    };
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('keeps the member\'s selection in the record of the checkout it delivered into', async () => {
    await pull({ silent: true });

    const [record] = Object.values((await loadStateForScope(localConfig)).lastPullByWorkspace ?? {});
    expect(record).toBeDefined();
    expect(record?.selection).toEqual({ scope: 'user', primaryRole: 'backend', additionalRoles: ['data', 'sre'], subscribedTags: ['go'], excludedSkills: ['legacy'] });
  });
});
