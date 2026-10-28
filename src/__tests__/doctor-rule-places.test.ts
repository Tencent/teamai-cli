import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { buildChecks, doctor, resolveDoctorContext, type Check, type DoctorReport } from '../doctor.js';
import { checkoutKey } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

describe('doctor — where a tool takes rules and instruction blocks', () => {
  let tempDir: string;
  let homeDir: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function failing(): Promise<Check[]> {
    const out: Check[] = [];
    for (const check of await checks()) if (!await check.check()) out.push(check);
    return out;
  }

  async function report(): Promise<DoctorReport> {
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { printed.push(String(line)); });
    try {
      await doctor({ json: true });
    } finally {
      spy.mockRestore();
    }
    const json = printed.find((line) => line.trimStart().startsWith('{'));
    if (json === undefined) throw new Error('doctor printed no JSON');
    return JSON.parse(json) as DoctorReport;
  }

  async function recordPlaces(checkout: string, places: { rules?: Record<string, string[]>; blocks?: Record<string, string[]> }): Promise<void> {
    const state = await loadStateForScope(localConfig);
    await saveStateForScope({
      ...state,
      lastPullByWorkspace: {
        [await checkoutKey(checkout)]: { rev: 'abc1234', targets: ['opencode'], places: { skills: {}, ...places } },
      },
    }, localConfig);
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rule-places-doctor-'));
    homeDir = path.join(tempDir, 'home');
    const repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    await fse.outputFile(path.join(repoPath, 'rules', 'style.md'), '# Style\n');
    localConfig = { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
    teamConfig = {
      team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: { opencode: { rules: '.config/opencode/rules', userScope: { rules: '.config/opencode/rules' } } },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('fails when the last pull wrote a tool\'s rules elsewhere than it takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const wrote = path.join(homeDir, '.config', 'opencode', 'rules');
    await recordPlaces(homeDir, { rules: { opencode: [wrote] } });

    const check = (await failing()).find((c) => c.name === 'opencode rules are where the last pull wrote them');

    expect(check?.fix).toBe(`opencode takes rules from ${path.join(xdg, 'opencode', 'rules')}, but the last pull wrote them to ${wrote}. Run \`teamai pull\` to sync them there.`);
  });

  it('passes once the last pull wrote a tool\'s rules where it takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    await recordPlaces(homeDir, { rules: { opencode: [path.join(xdg, 'opencode', 'rules')] } });

    const check = (await checks()).find((c) => c.name === 'opencode rules are where the last pull wrote them');

    expect(await check?.check()).toBe(true);
  });

  it('fails when a tool does not read the rules directory teamai writes', async () => {
    teamConfig.toolPaths = { opencode: { rules: '.opencode/rules', userScope: { rules: '.opencode/rules' } } };
    await fse.ensureDir(path.join(homeDir, '.opencode'));

    const check = (await failing()).find((c) => c.name === 'opencode reads the rules teamai writes');

    expect(check?.fix).toContain(`opencode does not read ${path.join(homeDir, '.opencode', 'rules')}`);
  });

  it('notes nothing left in OpenCode\'s default home once its rules and blocks follow the moved one (#1221)', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    const { notes } = await report();

    expect(notes?.some((note) => note.includes('still writes some of its other files'))).toBe(false);
  });
});
