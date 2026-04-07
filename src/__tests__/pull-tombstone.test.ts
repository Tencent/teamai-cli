import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies
vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('Already up to date.'),
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

import { pull, cleanupInactiveNamespaceSkills } from '../pull.js';
import { loadLocalConfigForScope, loadTeamConfig, detectProjectConfig } from '../config.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [
      {
        id: 'hai',
        name: 'HAI R&D',
        description: 'HyperAI research and development resources',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
        },
      },
      {
        id: 'pm',
        name: 'Product Manager',
        description: 'Product planning and collaboration resources',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          learnings: ['common', 'pm'],
        },
      },
    ],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(({ manifest, primaryRole, additionalRoles }) => {
    const allRoles = [primaryRole, ...additionalRoles].map((id: string) =>
      manifest.roles.find((role: { id: string }) => role.id === id),
    );
    if (allRoles.some((role: unknown) => !role)) {
      throw new Error('Unknown role in config');
    }
    const dedupe = (values: string[]) => [...new Set(values)];
    return {
      knowledge: dedupe(allRoles.flatMap((role: { resources: { knowledge: string[] } }) => role.resources.knowledge)),
      skills: dedupe(allRoles.flatMap((role: { resources: { skills: string[] } }) => role.resources.skills)),
      learnings: dedupe(allRoles.flatMap((role: { resources: { learnings: string[] } }) => role.resources.learnings)),
    };
  }),
}));

describe('pull role-aware sync and cleanup', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-tombstone-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'common'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'common'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'hai'));
    await fse.ensureDir(path.join(repoPath, 'learnings', 'pm'));
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));

    vi.stubEnv('HOME', homeDir);

    const teamConfig: TeamaiConfig = {
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
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codex: { skills: '.codex/skills', rules: '.codex/rules' },
      },
    };

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };

    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should clean up local rule files that are tombstoned', async () => {
    // Tombstone for "old-rule"
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');

    // Local residual files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');
    await fse.writeFile(path.join(homeDir, '.codex/rules', 'old-rule.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/rules', 'old-rule.md'))).toBe(false);
  });

  it('should clean up local skill directories that are tombstoned', async () => {
    // Tombstone for "old-skill"
    await fse.writeFile(path.join(repoPath, 'skills', '.removed'), 'old-skill\n');

    // Local residual directories
    await fse.ensureDir(path.join(homeDir, '.claude/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/old-skill/SKILL.md'), '# Old');
    await fse.ensureDir(path.join(homeDir, '.codex/skills/old-skill'));
    await fse.writeFile(path.join(homeDir, '.codex/skills/old-skill/SKILL.md'), '# Old');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/old-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex/skills/old-skill'))).toBe(false);
  });

  it('should not delete files that are NOT tombstoned', async () => {
    // No tombstone files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'keep-rule.md'), '# Keep');
    await fse.ensureDir(path.join(homeDir, '.claude/skills/keep-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills/keep-skill/SKILL.md'), '# Keep');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'keep-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/keep-skill'))).toBe(true);
  });

  it('should skip tombstone cleanup in dryRun mode', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');

    await pull({ dryRun: true });

    // File should still exist because dryRun skips cleanup
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'old-rule.md'))).toBe(true);
  });

  it('should handle empty tombstone files gracefully', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), '\n\n');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    // Nothing should be deleted
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });

  it('should handle missing tombstone files gracefully', async () => {
    // No .removed file at all
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), '# Mine');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'my-rule.md'))).toBe(true);
  });

  it('pulls only the active skill namespaces for the saved role profile', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'shared-skill', 'SKILL.md'), '# Shared');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'hai-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'hai-skill', 'SKILL.md'), '# HAI');
    await fse.ensureDir(path.join(repoPath, 'skills', 'pm', 'pm-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'pm', 'pm-skill', 'SKILL.md'), '# PM');

    await pull({});

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'shared-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'hai-skill', 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'))).toBe(false);
  });

  it('removes stale skills from namespaces that are no longer active', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude/skills', 'pm-skill'));
    await fse.writeFile(path.join(homeDir, '.claude/skills', 'pm-skill', 'SKILL.md'), '# PM');
    const teamConfig = vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user' as const,
    };

    await cleanupInactiveNamespaceSkills(
      await teamConfig,
      await localConfig,
      new Set(['shared-skill', 'hai-skill']),
      new Set(['pm-skill']),
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills', 'pm-skill'))).toBe(false);
  });

  it('aborts pull when the roles manifest is malformed', async () => {
    const { loadRolesManifest } = await import('../roles.js');
    vi.mocked(loadRolesManifest).mockRejectedValueOnce(new Error('Invalid roles manifest'));

    await pull({});

    const { log } = await import('../utils/logger.js');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Invalid roles manifest'));
  });

  it('aborts pull when the same skill exists in multiple active namespaces', async () => {
    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'common', 'shared-skill', 'SKILL.md'), '# Common');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai', 'shared-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai', 'shared-skill', 'SKILL.md'), '# HAI');

    const teamConfig = await vi.mocked(loadTeamConfig).mock.results.at(-1)?.value;
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      primaryRole: 'hai',
      additionalRoles: [],
      resourceProfileVersion: 1,
      scope: 'user',
    };
    const { scanRoleAwareSkills } = await import('../pull.js');

    await expect(scanRoleAwareSkills(
      localConfig,
      { knowledge: ['common', 'hai'], skills: ['common', 'hai'], learnings: ['common', 'hai'] },
    )).rejects.toThrow(/Duplicate skill "shared-skill"/);
  });
});
