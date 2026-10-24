import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

describe('doctor — where a tool takes agents', () => {
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

  async function recordAgentsPlaces(checkout: string, agents: Record<string, string[]>): Promise<void> {
    const state = await loadStateForScope(localConfig);
    await saveStateForScope({ ...state, lastPullByWorkspace: { [await checkoutKey(checkout)]: { rev: 'abc1234', targets: Object.keys(agents), places: { skills: {}, agents } } } }, localConfig);
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-places-doctor-'));
    homeDir = path.join(tempDir, 'home');
    const repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: reviews\ninstructions: |\n  Review.\n');
    localConfig = { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
    teamConfig = {
      team: 'test', description: '', repo: 'owner/repo', provider: 'git', reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: { opencode: { agents: '.config/opencode/agents' } },
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('fails when the last pull wrote a tool\'s agents elsewhere than it takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const wrote = path.join(homeDir, '.config', 'opencode', 'agents');
    await recordAgentsPlaces(homeDir, { opencode: [wrote] });

    const check = (await failing()).find((c) => c.name === 'opencode agents are where the last pull wrote them');

    expect(check?.fix).toBe(`opencode takes agents from ${path.join(xdg, 'opencode', 'agents')}, but the last pull wrote them to ${wrote}. Run \`teamai pull\` to sync them there.`);
  });

  it('says the last pull kept the old copies when it could not deliver every agent where the tool takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    const wrote = path.join(homeDir, '.config', 'opencode', 'agents');
    await recordAgentsPlaces(homeDir, { opencode: [wrote, path.join(xdg, 'opencode', 'agents')] });

    const check = (await failing()).find((c) => c.name === 'opencode agents are where the last pull wrote them');

    expect(check?.fix).toBe(`opencode takes agents from ${path.join(xdg, 'opencode', 'agents')}, but the last pull could not deliver every agent there, `
      + `so it kept teamai's copies in ${wrote}. Run \`teamai pull\`: it says what holds them back.`);
  });

  it('passes once the last pull wrote a tool\'s agents where it takes them now', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    await recordAgentsPlaces(homeDir, { opencode: [path.join(xdg, 'opencode', 'agents')] });

    const check = (await checks()).find((c) => c.name === 'opencode agents are where the last pull wrote them');

    expect(await check?.check()).toBe(true);
  });

  it('notes that OpenCode\'s other files stay in its default home while its agents follow the moved one', async () => {
    const xdg = path.join(tempDir, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    const { notes } = await report();

    expect(notes).toContain(`opencode takes agents from ${path.join(xdg, 'opencode', 'agents')}, but teamai still writes some of its other files under ${path.join(homeDir, '.config', 'opencode')}.`);
  });

  describe('Codex project trust for a team that ships agents and no MCP servers', () => {
    const NAME = 'Codex trusts this project, so it loads its team agents';
    let project: string;

    beforeEach(async () => {
      project = path.join(tempDir, 'codex-repo');
      await fse.ensureDir(path.join(project, '.codex'));
      execFileSync('git', ['init', '-q'], { cwd: project });
      Object.assign(localConfig, { scope: 'project', projectRoot: project });
      teamConfig.toolPaths = { codex: { agents: '.codex/agents' } };
    });

    it('fails while Codex has no entry for the project, naming the agents it would skip', async () => {
      const codexConfig = path.join(homeDir, '.codex', 'config.toml');
      await fse.outputFile(codexConfig, 'model = "gpt-5"\n');
      const real = await fse.realpath(project);

      const check = (await failing()).find((c) => c.name === NAME);

      expect(check?.fix).toBe(`${path.join(project, '.codex', 'agents')} holds team agents (reviewer), but Codex loads a project's agents only in a trusted project, `
        + `and ${codexConfig} does not trust ${real}. Open Codex in ${real} and trust the project when it asks, `
        + `or add a [projects.${JSON.stringify(real)}] table holding trust_level = "trusted" to ${codexConfig}. Trusting the main checkout covers every worktree of it.`);
    });

    it('passes once Codex trusts the project', async () => {
      const real = await fse.realpath(project);
      await fse.outputFile(path.join(homeDir, '.codex', 'config.toml'), `[projects.${JSON.stringify(real)}]\ntrust_level = "trusted"\n`);

      const check = (await checks()).find((c) => c.name === NAME);

      expect(await check?.check()).toBe(true);
    });
  });
});
