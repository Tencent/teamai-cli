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
import { autoDetectInit, detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { recallDisable } from '../recall-toggle.js';
import { log } from '../utils/logger.js';
import { TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';
import { saveToolHomes } from '../tool-home.js';

describe('a pull and the agents of a moved home', () => {
  let tmp: string; let home: string; let repo: string; let xdg: string; let saved: State; let config: LocalConfig;
  const notices = (): string[] => vi.mocked(log.info).mock.calls.map(([message]) => String(message)).filter((line) => line.includes('no longer updates'));

  beforeEach(async () => {
    tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-places-'));
    home = path.join(tmp, 'home'); repo = path.join(tmp, 'repo'); xdg = path.join(tmp, 'xdg');
    await fse.outputFile(path.join(repo, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: Reviews\ninstructions: Review the diff.\n');
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    saved = {} as State;
    vi.mocked(saveStateForScope).mockImplementation(async (s) => { saved = structuredClone(s); });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved) as never);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    config = {
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'user', enabledAgents: ['opencode', 'muse'],
    } as LocalConfig;
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => scope === 'user' ? config : null);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(log.info).mockClear(); await fse.remove(tmp); });

  it('delivers OpenCode and Muse agents where XDG_CONFIG_HOME puts their homes', async () => {
    await fse.ensureDir(path.join(xdg, 'opencode'));
    await fse.ensureDir(path.join(xdg, 'muse'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await pull({});

    expect(await fse.pathExists(path.join(xdg, 'opencode', 'agents', 'reviewer.md'))).toBe(true);
    expect(await fse.pathExists(path.join(xdg, 'muse', 'agents', 'reviewer.md'))).toBe(true);
    expect(await fse.pathExists(path.join(home, '.config'))).toBe(false);
  });

  it('deploys the built-in recall agent there, and recall off removes it from there', async () => {
    await fse.ensureDir(path.join(xdg, 'opencode'));
    await fse.ensureDir(path.join(xdg, 'muse'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    config.recallEnabled = true;
    const recallAgents = [path.join(xdg, 'opencode', 'agents', 'teamai-recall.md'), path.join(xdg, 'muse', 'agents', 'teamai-recall.md')];

    await pull({});

    for (const file of recallAgents) expect(await fse.pathExists(file), file).toBe(true);

    vi.mocked(autoDetectInit).mockResolvedValue({ localConfig: config, teamConfig: await loadTeamConfig(repo) } as never);
    await recallDisable({});

    for (const file of recallAgents) expect(await fse.pathExists(file), file).toBe(false);
  });

  it('removes a tombstoned agent from there', async () => {
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    await pull({});
    expect(await fse.pathExists(path.join(xdg, 'opencode', 'agents', 'reviewer.md'))).toBe(true);

    await fse.remove(path.join(repo, 'agents', 'reviewer.yaml'));
    await fse.outputFile(path.join(repo, 'agents', '.removed'), 'reviewer\n');
    await pull({ force: true });

    expect(await fse.pathExists(path.join(xdg, 'opencode', 'agents', 'reviewer.md'))).toBe(false);
  });

  describe('when OpenCode\'s agents move at one team revision', () => {
    let before: string; let after: string;
    const recordedAgents = (): unknown => Object.values(saved.lastPullByWorkspace ?? {}).map((record) => record.places?.agents?.opencode);
    beforeEach(async () => {
      // Agents only, so the skills places cannot be what notices the move.
      vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({
        team: 't', repo: 'https://example.invalid/x/t.git',
        toolPaths: { opencode: { agents: '.opencode/agents', userScope: { agents: '.config/opencode/agents' } } },
      }));
      config.enabledAgents = ['opencode'];
      before = path.join(tmp, 'opencode-a'); after = path.join(tmp, 'opencode-b');
      await fse.ensureDir(before); await fse.ensureDir(after);
      await saveToolHomes({ opencode: before });
      await pull({});
      expect(await fse.pathExists(path.join(before, 'agents', 'reviewer.md'))).toBe(true);
      await saveToolHomes({ opencode: after });
      vi.mocked(log.info).mockClear();
    });

    it('syncs in full, keeps the old copies and names the old directory once', async () => {
      await pull({});

      expect(await fse.pathExists(path.join(after, 'agents', 'reviewer.md'))).toBe(true);
      expect(await fse.pathExists(path.join(before, 'agents', 'reviewer.md'))).toBe(true);
      expect(notices()).toEqual([
        `[user] opencode takes the instruction blocks from ${path.join(after, 'teamai-context.md')} now, so teamai no longer updates them in ${path.join(before, 'teamai-context.md')}. Delete them there once no tool reads it.`,
        `[user] opencode takes agents from ${path.join(after, 'agents')} now, so teamai no longer updates its copies in ${path.join(before, 'agents')}. Delete them once no tool reads that directory.`,
      ]);
      expect(recordedAgents()).toEqual([[path.join(after, 'agents')]]);

      vi.mocked(log.info).mockClear();
      await pull({ force: true });

      expect(notices()).toEqual([]);
    });

    it('keeps the old directory on record while a file of the member\'s holds an agent back at the new one', async () => {
      await fse.outputFile(path.join(after, 'agents', 'reviewer.md'), 'The member\'s own reviewer.\n');

      await pull({});

      expect(await fse.readFile(path.join(after, 'agents', 'reviewer.md'), 'utf8')).toContain('member\'s own');
      expect(notices()).toEqual([
        `[user] opencode takes the instruction blocks from ${path.join(after, 'teamai-context.md')} now, so teamai no longer updates them in ${path.join(before, 'teamai-context.md')}. Delete them there once no tool reads it.`,
      ]);
      expect(recordedAgents()).toEqual([[path.join(before, 'agents'), path.join(after, 'agents')]]);

      await fse.remove(path.join(after, 'agents', 'reviewer.md'));
      await pull({});

      expect(await fse.pathExists(path.join(after, 'agents', 'reviewer.md'))).toBe(true);
      expect(recordedAgents()).toEqual([[path.join(after, 'agents')]]);
    });
  });
});
