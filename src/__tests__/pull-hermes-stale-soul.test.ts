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
import { detectProjectConfig, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';
import { upsertSoulRules, readSoulRules } from '../hermes-config.js';

describe('the SOUL.md rules block an older project pull wrote, on a machine with no user-scope install (#946)', () => {
  let tmp: string; let home: string; let saved: State; let projectRoot: string; let repo: string;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-hermes-stale-soul-'));
    home = path.join(tmp, 'home'); projectRoot = path.join(tmp, 'proj'); repo = path.join(tmp, 'repo');
    await fse.ensureDir(path.join(home, '.hermes'));
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    await fse.outputFile(path.join(repo, 'rules', 'r.md'), 'New project rule.\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('HERMES_HOME', path.join(home, '.hermes'));
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (s) => { saved = structuredClone(s); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    vi.mocked(detectProjectConfig).mockResolvedValue({
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'project', projectRoot, enabledAgents: ['hermes', 'claude'],
    } as LocalConfig);
    // What a pre-#946 project pull wrote into the global SOUL.md.
    await upsertSoulRules('Old project rule that the team since deleted.');
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(detectProjectConfig).mockResolvedValue(null); await fse.remove(tmp); });

  it('keeps the block when a user config exists but cannot be parsed', async () => {
    await fse.outputFile(path.join(home, '.teamai', 'config.yaml'), 'invalid: [');

    await pull({});

    expect(await readSoulRules()).toBe('Old project rule that the team since deleted.');
  });

  it('leaves the block alone on a dry run', async () => {
    await pull({ dryRun: true });

    expect(await readSoulRules()).toBe('Old project rule that the team since deleted.');
  });

  it('keeps the block when Hermes is excluded in the project', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue({
      ...await detectProjectConfig(), enabledAgents: ['claude'],
    } as LocalConfig);

    await pull({});

    expect(await readSoulRules()).toBe('Old project rule that the team since deleted.');
  });

  it('is removed by a project pull', async () => {
    const soul = path.join(home, '.hermes', 'SOUL.md');
    await fse.appendFile(soul, '\nMy own standing instructions.\n');

    await pull({});

    expect(await readSoulRules()).toBeNull();
    expect(await fse.readFile(soul, 'utf8')).toContain('My own standing instructions.');
    await upsertSoulRules('Another stale project block.');
    await pull({});
    expect(await readSoulRules()).toBeNull();
  });
});
