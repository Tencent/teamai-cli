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
vi.mock('../update.js', () => ({ acquireLock: vi.fn().mockResolvedValue(true), releaseLock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis() })),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

describe('a removed root rule whose name is the flat name of a live namespaced rule (#946)', () => {
  let tmp: string; let home: string; let saved: State;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-flat-tombstone-'));
    home = path.join(tmp, 'home');
    const repo = path.join(tmp, 'repo');
    await fse.ensureDir(path.join(home, '.kiro'));
    await fse.ensureDir(path.join(home, '.omp', 'agent'));
    await fse.outputFile(path.join(repo, 'rules', 'fe', 'style.md'), 'Use tabs.\n');
    // The team once had a root rule `fe.style` and removed it.
    await fse.outputFile(path.join(repo, 'rules', '.removed'), 'fe.style\n');
    vi.stubEnv('HOME', home);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (s) => { saved = structuredClone(s); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    vi.mocked(loadLocalConfigForScope).mockResolvedValue({
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'user', enabledAgents: ['kiro', 'omp'],
    } as LocalConfig);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(tmp); });

  it.each(['.kiro/steering', '.omp/agent/rules'])('keeps the live fe/style copy in %s over a full and an already-synced pull', async (dir) => {
    const flat = path.join(home, dir, 'fe.style.md');

    await pull({});
    expect(await fse.readFile(flat, 'utf8')).toContain('Use tabs.');

    await pull({});
    expect(await fse.readFile(flat, 'utf8')).toContain('Use tabs.');
  });
});
