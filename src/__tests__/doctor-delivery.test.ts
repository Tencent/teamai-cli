import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The delivery check: what `pull` said it synced, against what an agent can
 * actually read on disk (#598). Everything else in the registry verifies
 * plumbing; this one verifies the payload.
 */
describe('doctor — skills delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  const CLAUDE_SKILLS = ['.claude', 'skills'];

  async function writeTeamSkill(name: string): Promise<void> {
    const dir = path.join(repoPath, 'skills', name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  /** A correctly delivered copy, the way pullItem leaves one. */
  async function deliver(segments: string[], name: string): Promise<void> {
    const dir = path.join(homeDir, ...segments, name);
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  }

  async function deliveryCheck(tool = 'claude'): Promise<Check> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const check = (await buildChecks(ctx)).find((c) => c.name === `Skills delivered to ${tool}`);
    if (!check) throw new Error(`no delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await writeTeamSkill('alpha');
    await writeTeamSkill('beta');
    await fse.ensureDir(path.join(homeDir, ...CLAUDE_SKILLS));

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { claude: { skills: '.claude/skills' } },
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when every desired skill is on disk', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');

    const check = await deliveryCheck();

    expect(await check.check()).toBe(true);
    expect(check.source).toBe('local');
  });

  it('fails and names the skill the tool never received', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');

    const check = await deliveryCheck();

    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('beta');
    expect(check.fix).not.toContain('alpha');
    expect(check.fix).toContain('teamai pull');
  });

  it('reports each installed tool separately', async () => {
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills' },
      codex: { skills: '.codex/skills' },
    };
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');
    await deliver(['.codex', 'skills'], 'alpha');

    expect(await (await deliveryCheck('claude')).check()).toBe(true);
    expect(await (await deliveryCheck('codex')).check()).toBe(false);
  });

  it('counts a codex skill in the shared .agents/skills directory as delivered', async () => {
    teamConfig.toolPaths = { codex: { skills: '.codex/skills' } };
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    await deliver(['.agents', 'skills'], 'alpha');
    await deliver(['.agents', 'skills'], 'beta');

    expect(await (await deliveryCheck('codex')).check()).toBe(true);
  });

  it('asks nothing of a tool that is not installed', async () => {
    teamConfig.toolPaths = {
      claude: { skills: '.claude/skills' },
      codex: { skills: '.codex/skills' },
    };
    await deliver(CLAUDE_SKILLS, 'alpha');
    await deliver(CLAUDE_SKILLS, 'beta');

    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    const names = (await buildChecks(ctx)).map((c) => c.name);

    expect(names).toContain('Skills delivered to claude');
    expect(names).not.toContain('Skills delivered to codex');
  });

  it('asks nothing of an excluded skill', async () => {
    localConfig.excludedSkills = ['beta'];
    await deliver(CLAUDE_SKILLS, 'alpha');

    expect(await (await deliveryCheck()).check()).toBe(true);
  });

  it('never writes to the tool directory it inspects', async () => {
    await deliver(CLAUDE_SKILLS, 'alpha');

    await (await deliveryCheck()).check();

    expect(await fse.readdir(path.join(homeDir, ...CLAUDE_SKILLS))).toEqual(['alpha']);
  });
});
