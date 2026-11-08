import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));

vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel workers would race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
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

import { pull } from '../pull.js';
import { log } from '../utils/logger.js';
import { loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

/**
 * A member upgrades while the team revision stays put: the copies an older
 * release delivered from a folder this release skips must go on the first
 * pull, not on the team's next commit (#1791).
 */
describe('a pull at an unchanged team revision after a folder becomes skipped (#1791)', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let saved: State;

  const rulesDir = () => path.join(homeDir, '.claude', 'rules');

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skipped-fast-path-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.outputFile(path.join(repoPath, 'rules', 'style.md'), '# Style\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'checklist.md'), '# Checklist\n');
    vi.stubEnv('HOME', homeDir);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (state) => {
      saved = structuredClone(state);
    });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(
      TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' }),
    );
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
      enabledAgents: ['claude'],
    } as LocalConfig);
    await pull({});
  });

  afterEach(async () => {
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(loadStateForScope).mockImplementation(async () => ({}) as never);
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('removes the copies delivered from the folder and keeps the rest', async () => {
    expect(await fse.pathExists(path.join(rulesDir(), 'api-style', 'checklist.md'))).toBe(true);
    // The folder's marker was there all along; the release that pulled it
    // read it as an ordinary directory.
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.md'), '# API style\n');

    await pull({});

    expect(await fse.pathExists(path.join(rulesDir(), 'api-style', 'checklist.md'))).toBe(false);
    expect(await fse.pathExists(path.join(rulesDir(), 'api-style', 'RULE.md'))).toBe(false);
    expect(await fse.readFile(path.join(rulesDir(), 'style.md'), 'utf8')).toBe('# Style\n');
  });

  it('takes the fast path again once the folders it skips are on record', async () => {
    await fse.outputFile(path.join(repoPath, 'rules', 'api-style', 'RULE.md'), '# API style\n');
    await pull({});
    vi.mocked(log.success).mockClear();

    await pull({});

    const successes = vi.mocked(log.success).mock.calls.map(([message]) => String(message));
    expect(successes.some((message) => message.includes('Already synced at abc1234'))).toBe(true);
  });
});
