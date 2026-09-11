import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies (same shape as pull-skip-sync.test.ts).
vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
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

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI resources',
        resources: { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'] },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
    const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
      manifest.roles.find((role: { id: string }) => role.id === id),
    );
    const dedupe = (values: string[]) => [...new Set(values)];
    return {
      knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
      skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
      learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
    };
  }),
}));

// pull() takes a real ~/.teamai/.sync-lock; parallel vitest workers race on it.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { pull } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig, loadStateForScope, saveStateForScope } from '../config.js';
import { getHeadRev } from '../utils/git.js';
import { log } from '../utils/logger.js';
import { deployBuiltinSkills } from '../builtin-skills.js';
import { deployBuiltinRules } from '../builtin-rules.js';
import { deployBuiltinAgents } from '../builtin-agents.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

/**
 * `init --agent` / `enabledAgents` scopes resource sync to an opt-in whitelist.
 * These cases pin the sites that used to gate only on `disabledAgents`
 * (`isAgentDisabled`), which let a pull keep writing into a tool that was
 * installed on the machine but deliberately left out of the whitelist (#510).
 *
 * The observable throughout is the disk: with `enabledAgents: ['claude']` and
 * both `~/.claude` and `~/.codebuddy` present, nothing may land under
 * `~/.codebuddy` — not built-in skills/rules/agents, not CLAUDE.md injects, and
 * not the target set that `pull` records for its skip-sync decision.
 */
const TOOL_PATHS = {
  claude: {
    skills: '.claude/skills',
    rules: '.claude/rules',
    agents: '.claude/agents',
    claudemd: '.claude/CLAUDE.md',
  },
  codebuddy: {
    skills: '.codebuddy/skills',
    rules: '.codebuddy/rules',
    agents: '.codebuddy/agents',
    claudemd: '.codebuddy/CODEBUDDY.md',
  },
};

function makeTeamConfig(): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths: TOOL_PATHS,
  };
}

describe('builtin deploy honours enabledAgents (whitelist)', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-whitelist-builtin-'));
    homeDir = path.join(tmpDir, 'home');

    // Both tools are installed; only claude is opted in.
    for (const tool of ['.claude', '.codebuddy']) {
      await fse.ensureDir(path.join(homeDir, tool, 'skills'));
      await fse.ensureDir(path.join(homeDir, tool, 'rules'));
      await fse.ensureDir(path.join(homeDir, tool, 'agents'));
    }
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  function localConfig(): LocalConfig {
    return {
      repo: { localPath: path.join(tmpDir, 'repo'), remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
      enabledAgents: ['claude'],
    };
  }

  it('does not deploy built-in skills into an installed tool outside the whitelist', async () => {
    const deployed = await deployBuiltinSkills(makeTeamConfig(), localConfig());

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/team-wiki-codebase'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/teamai-share-learnings'))).toBe(false);
  });

  it('does not deploy built-in rules into an installed tool outside the whitelist', async () => {
    const deployed = await deployBuiltinRules(makeTeamConfig(), localConfig());

    expect(deployed).toBeGreaterThan(0);
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/rules/teamai-recall.md'))).toBe(false);
  });

  it('does not deploy built-in agents into an installed tool outside the whitelist', async () => {
    const deployed = await deployBuiltinAgents(makeTeamConfig(), localConfig());

    expect(deployed).toBeGreaterThan(0);
    expect(
      await fse.pathExists(path.join(homeDir, '.claude/agents/teamai-recall.md')),
    ).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/agents/teamai-recall.md'))).toBe(false);
  });

  it('still deploys everywhere when enabledAgents is not set', async () => {
    const config = localConfig();
    delete config.enabledAgents;

    await deployBuiltinSkills(makeTeamConfig(), config);

    // No whitelist means "every installed tool", i.e. the previous behaviour.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-wiki-codebase/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/team-wiki-codebase/SKILL.md'))).toBe(true);
  });
});

describe('pull honours enabledAgents for the target set and skip-sync', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-whitelist-pull-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'team-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'team-skill', 'SKILL.md'), '# Team Skill');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');

    // Both tools are installed on the machine; only claude is opted in initially.
    for (const tool of ['.claude', '.codebuddy']) {
      await fse.ensureDir(path.join(homeDir, tool, 'skills'));
      await fse.ensureDir(path.join(homeDir, tool, 'rules'));
      await fse.ensureDir(path.join(homeDir, tool, 'agents'));
    }
    vi.stubEnv('HOME', homeDir);

    vi.mocked(loadTeamConfig).mockResolvedValue(makeTeamConfig());
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  function localConfig(enabled: string[]): LocalConfig {
    return {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
      enabledAgents: enabled,
    };
  }

  it('records only whitelisted tools as resource targets', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig(['claude']));
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: null,
      lastPullRev: null,
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    const saved = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(saved.lastPullTargets).toEqual(['claude']);
    expect(saved.lastPullTargets).not.toContain('codebuddy');

    // And the un-whitelisted tool received nothing on this full sync.
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/team-skill/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/team-skill'))).toBe(false);
  });

  it('syncs a newly whitelisted tool even when the repo HEAD is unchanged', async () => {
    // The recorded state says "claude only" at this exact revision, then the
    // team adds codebuddy to the whitelist without touching the repo.
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig(['claude', 'codebuddy']));
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234', // matches HEAD -> skip-sync fast-path candidate
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    // The target set changed, so the fast-path must not fire...
    expect(log.success).not.toHaveBeenCalledWith(expect.stringContaining('Already synced'));
    // ...and the newly opted-in tool must actually receive the team skill.
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/team-skill/SKILL.md'))).toBe(true);
    const saved = vi.mocked(saveStateForScope).mock.calls[0][0];
    expect(saved.lastPullTargets).toEqual(['claude', 'codebuddy']);
  });

  it('still skips when the target set is unchanged', async () => {
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig(['claude']));
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPull: '2026-04-01',
      lastPullRev: 'abc1234',
      lastPullTargets: ['claude'],
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    });

    await pull({});

    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Already synced at abc1234, skipping'));
    // The un-whitelisted tool is still not touched on the fast-path.
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/team-wiki-codebase'))).toBe(false);
  });
});
