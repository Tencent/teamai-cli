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

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import { getDataHome, managedMcpManifestKey, managedMcpManifestPath, type LocalConfig, type TeamaiConfig } from '../types.js';

/**
 * A tool that reads a project's files only once it trusts the project, or
 * starts its servers only once the member approves them: teamai's delivery is
 * on disk and inert until then, so doctor reads the tool's own verdict.
 */
describe('doctor — the tool trusts the project it reads team files from', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let projectRoot: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  async function writeTeamSkill(name: string): Promise<void> {
    await fse.outputFile(path.join(repoPath, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  /** A copy as pull leaves it in the project. */
  async function deliverSkill(relativeDir: string, name: string): Promise<void> {
    await fse.outputFile(path.join(projectRoot, relativeDir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  async function check(name: string): Promise<Check | undefined> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return (await buildChecks(ctx)).find((c) => c.name === name);
  }

  beforeEach(async () => {
    tempDir = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-read-gates-')));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    projectRoot = path.join(tempDir, 'web-app');
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', undefined);
    vi.stubEnv('COPILOT_HOME', undefined);
    await fse.ensureDir(projectRoot);
    await writeTeamSkill('release-notes');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'project',
      projectRoot,
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: false } },
      toolPaths: {},
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  // Pi 1.4.0 keeps `{ "<dir>": true | false }` in <agent dir>/trust.json, takes
  // the nearest entry walking up from the directory it starts in, and asks
  // `defaultProjectTrust` (settings.json) when none decides. `pi -p` treats
  // "ask" as untrusted.
  describe('Pi project trust', () => {
    const SKILLS = 'Pi trusts this project, so it loads its team skills';
    const trustFile = (): string => path.join(homeDir, '.pi', 'agent', 'trust.json');

    beforeEach(async () => {
      await fse.ensureDir(path.join(homeDir, '.pi', 'agent'));
      teamConfig.toolPaths = { pi: { skills: '.pi/skills' } };
      await deliverSkill('.pi/skills', 'release-notes');
    });

    it('fails while Pi has no verdict for the project, naming the skills and the line that trusts it', async () => {
      const found = await check(SKILLS);

      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`${path.join(projectRoot, '.pi', 'skills')} holds team skills (release-notes)`);
      expect(found?.fix).toContain(trustFile());
      expect(found?.fix).toContain(`"${projectRoot}": true`);
    });

    it.each([
      ['the project', (): string => projectRoot],
      ['a folder above it', (): string => tempDir],
    ])('passes once trust.json trusts %s', async (_label, dir) => {
      await fse.outputJson(trustFile(), { [dir()]: true });

      expect(await (await check(SKILLS))?.check()).toBe(true);
    });

    it('fails on a nearer false entry, naming it, whatever a folder above says', async () => {
      await fse.outputJson(trustFile(), { [tempDir]: true, [projectRoot]: false });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`sets "${projectRoot}": false`);
    });

    it.each([
      ['always', true],
      ['never', false],
      ['ask', false],
    ])('with no entry, defaultProjectTrust "%s" decides', async (value, ok) => {
      await fse.outputJson(path.join(homeDir, '.pi', 'agent', 'settings.json'), { defaultProjectTrust: value });

      expect(await (await check(SKILLS))?.check()).toBe(ok);
    });

    it('reads trust.json from PI_CODING_AGENT_DIR', async () => {
      const agentDir = path.join(tempDir, 'pi-agent');
      vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
      await fse.outputJson(trustFile(), { [projectRoot]: true });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(path.join(agentDir, 'trust.json'));
    });

    it('says the verdict is unknown when trust.json holds a value Pi rejects', async () => {
      await fse.outputJson(trustFile(), { [projectRoot]: 'yes' });

      const found = await check(SKILLS);
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain('whether Pi trusts this project is unknown');
    });

    it('checks the project MCP servers too', async () => {
      teamConfig.toolPaths = { pi: { mcp: '.pi/agent/mcp.json', mcpProject: '.pi/mcp.json' } };
      await fse.outputFile(path.join(repoPath, 'mcp', 'mcp.yaml'), 'servers:\n  - name: issues\n    transport: stdio\n    command: issues-server\n');
      await fse.outputJson(path.join(projectRoot, '.pi', 'mcp.json'), { mcpServers: { issues: { command: 'issues-server' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('pi', true)]: [{ name: 'issues', hash: 'h' }] });

      const found = await check('Pi trusts this project, so it loads its team MCP servers');
      expect(await found?.check()).toBe(false);
      expect(found?.fix).toContain(`${path.join(projectRoot, '.pi', 'mcp.json')} holds team MCP servers (issues)`);
    });
  });
});
