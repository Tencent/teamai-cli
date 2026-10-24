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
  saveLocalConfigForScope: vi.fn(),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({ held: true, value: await body() }),
}));
vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis() })),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { LocalConfigSchema, StateSchema, TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';
import { saveToolHomes } from '../tool-home.js';

describe('a pull and the rules and instruction blocks of a moved home', () => {
  let tmp: string; let repo: string; let before: string; let after: string; let saved: State; let config: LocalConfig;
  const notices = (): string[] => vi.mocked(log.info).mock.calls.map(([message]) => String(message)).filter((line) => line.includes('no longer updates'));
  const recorded = (resource: 'rules' | 'blocks'): unknown => Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.[resource]?.opencode);

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-places-'));
    repo = path.join(tmp, 'repo'); before = path.join(tmp, 'opencode-a'); after = path.join(tmp, 'opencode-b');
    await fse.outputFile(path.join(repo, 'rules', 'style.md'), '# Style\n\nUse tabs.\n');
    await fse.outputFile(path.join(repo, 'culture.md'), '# Culture\n\nShip small.\n');
    await fse.ensureDir(before); await fse.ensureDir(after);
    vi.stubEnv('HOME', path.join(tmp, 'home'));
    vi.stubEnv('XDG_CONFIG_HOME', '');
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    saved = StateSchema.parse({});
    vi.mocked(saveStateForScope).mockImplementation(async (state) => { saved = structuredClone(state); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved));
    // Rules only, so neither the skills nor the agents places can be what notices the move.
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({
      team: 't', repo: 'https://example.invalid/x/t.git',
      toolPaths: {
        opencode: { rules: '.opencode/rules', mcp: '.config/opencode/opencode.json', userScope: { rules: '.config/opencode/rules' } },
      },
    }));
    config = LocalConfigSchema.parse({
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      scope: 'user', enabledAgents: ['opencode'],
    });
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => scope === 'user' ? config : null);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    await saveToolHomes({ opencode: before });
    await pull({});
    expect(await fse.pathExists(path.join(before, 'rules', 'style.md'))).toBe(true);
    await saveToolHomes({ opencode: after });
    vi.mocked(log.info).mockClear();
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(log.info).mockClear(); await fse.remove(tmp); });

  it('syncs the rules in full at one team revision, keeps the old copies and names each old place once', async () => {
    await pull({});

    expect(await fse.pathExists(path.join(after, 'rules', 'style.md'))).toBe(true);
    expect(await fse.pathExists(path.join(before, 'rules', 'style.md'))).toBe(true);
    expect(notices()).toEqual([
      `[user] opencode takes the team rules from ${path.join(after, 'rules')} now, so teamai no longer updates them in ${path.join(before, 'rules')}. Delete them there once no tool reads it.`,
      `[user] opencode takes the instruction blocks from ${path.join(after, 'teamai-context.md')} now, so teamai no longer updates them in ${path.join(before, 'teamai-context.md')}. Delete them there once no tool reads it.`,
    ]);
    expect(recorded('rules')).toEqual([[path.join(after, 'rules')]]);
    expect(recorded('blocks')).toEqual([[path.join(after, 'teamai-context.md')]]);

    vi.mocked(log.info).mockClear();
    await pull({ force: true });

    expect(notices()).toEqual([]);
  });

  it('keeps the old rules directory on record while an edited copy holds a rule back at the new one', async () => {
    await fse.outputFile(path.join(after, 'rules', 'style.md'), 'The member\'s own style.\n');

    await pull({});

    expect(await fse.readFile(path.join(after, 'rules', 'style.md'), 'utf8')).toContain('member\'s own');
    expect(notices().filter((line) => line.includes('team rules'))).toEqual([]);
    expect(recorded('rules')).toEqual([[path.join(before, 'rules'), path.join(after, 'rules')]]);

    await fse.remove(path.join(after, 'rules', 'style.md'));
    await pull({});

    expect(await fse.pathExists(path.join(after, 'rules', 'style.md'))).toBe(true);
    expect(recorded('rules')).toEqual([[path.join(after, 'rules')]]);
  });
});
