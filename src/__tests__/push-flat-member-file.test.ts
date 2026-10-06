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
import { RulesHandler } from '../resources/rules.js';

describe('a member\'s own file at a namespaced rule\'s flat name (#946)', () => {
  let tmp: string; let home: string; let saved: State; let local: LocalConfig; let repo: string;
  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-push-member-flat-'));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    await fse.ensureDir(path.join(home, '.kiro', 'steering'));
    await fse.outputFile(path.join(home, '.kiro', 'steering', 'fe.style.md'), '---\ninclusion: always\n---\n\nMy personal notes about FE style.\n');
    await fse.outputFile(path.join(repo, 'rules', 'fe', 'style.md'), 'Team: use tabs.\n');
    vi.stubEnv('HOME', home);
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (s) => { saved = structuredClone(s); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    local = {
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'user', enabledAgents: ['kiro'],
    } as LocalConfig;
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(local);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fse.remove(tmp); });

  it('is kept by pull and not offered by push as an edit of the team rule', async () => {
    await pull({});
    expect(await fse.readFile(path.join(home, '.kiro', 'steering', 'fe.style.md'), 'utf8')).toContain('My personal notes');

    const team = TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' });
    const items = await new RulesHandler().scanLocalForPush(team, local);

    expect(items.find((i) => i.name === 'fe/style')).toBeUndefined();
  });
});
