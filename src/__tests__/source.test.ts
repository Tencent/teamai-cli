import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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
  })),
}));

// Mock git operations
vi.mock('../utils/git.js', () => ({
  createGit: vi.fn(() => ({
    clone: vi.fn(),
  })),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

import { getAllSourceSkillNames, pullSources } from '../source.js';
import type { TeamaiConfig, LocalConfig, SourceInstallManifest } from '../types.js';

describe('source', () => {
  let tmpDir: string;
  let homeDir: string;
  let sourcesDir: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-source-test-'));
    homeDir = path.join(tmpDir, 'home');
    sourcesDir = path.join(homeDir, '.teamai', 'sources');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto' as const,
      additionalRoles: [],
      scope: 'user' as const,
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  describe('getAllSourceSkillNames', () => {
    it('should return empty set when no sources exist', async () => {
      const names = await getAllSourceSkillNames();
      expect(names.size).toBe(0);
    });

    it('should return skill names from installed manifests', async () => {
      const manifestDir = path.join(sourcesDir, 'other-team');
      await fse.ensureDir(manifestDir);

      const manifest: SourceInstallManifest = {
        lastPull: new Date().toISOString(),
        installedSkills: ['skill-a', 'skill-b'],
      };
      await fse.writeJson(path.join(manifestDir, 'installed.json'), manifest);

      const names = await getAllSourceSkillNames();
      expect(names.has('skill-a')).toBe(true);
      expect(names.has('skill-b')).toBe(true);
      expect(names.size).toBe(2);
    });

    it('should aggregate skills across multiple sources', async () => {
      for (const source of ['team-a', 'team-b']) {
        const manifestDir = path.join(sourcesDir, source);
        await fse.ensureDir(manifestDir);
        const manifest: SourceInstallManifest = {
          lastPull: new Date().toISOString(),
          installedSkills: [`${source}-skill`],
        };
        await fse.writeJson(path.join(manifestDir, 'installed.json'), manifest);
      }

      const names = await getAllSourceSkillNames();
      expect(names.has('team-a-skill')).toBe(true);
      expect(names.has('team-b-skill')).toBe(true);
      expect(names.size).toBe(2);
    });
  });

  describe('pullSources', () => {
    it('should do nothing when no sources configured', async () => {
      await pullSources(localConfig, {});
      // No errors, no side effects
    });

    it('should skip source with no publicSkills', async () => {
      // Set up team config with a source
      teamConfig.sources = [{ name: 'other', repo: 'git@git.woa.com:other/repo.git' }];

      // Write teamai.yaml to team repo
      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with no publicSkills
      const sourceRepoDir = path.join(sourcesDir, 'other', 'repo');
      await fse.ensureDir(path.join(sourceRepoDir, 'skills'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({ team: 'other', repo: 'git@git.woa.com:other/repo.git' }),
      );

      await pullSources(localConfig, {});

      // No skills should be deployed
      const claudeSkills = await fse.readdir(path.join(homeDir, '.claude', 'skills'));
      expect(claudeSkills).toHaveLength(0);
    });

    it('should deploy public skills from source', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with publicSkills
      const sourceRepoDir = path.join(sourcesDir, 'platform', 'repo');
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'cool-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'cool-skill', 'SKILL.md'),
        '---\nname: cool-skill\ndescription: A cool skill\n---\n# Cool Skill',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['cool-skill'],
        }),
      );

      await pullSources(localConfig, {});

      // Skill should be deployed to claude skills dir
      const deployed = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'cool-skill', 'SKILL.md'),
      );
      expect(deployed).toBe(true);

      // Manifest should be written
      const manifest = await fse.readJson(
        path.join(sourcesDir, 'platform', 'installed.json'),
      ) as SourceInstallManifest;
      expect(manifest.installedSkills).toContain('cool-skill');
    });

    it('should not deploy source skill that conflicts with local team skill', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;

      // Create a local team skill with the same name
      await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'shared-name'));
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'skills', 'shared-name', 'SKILL.md'),
        '# Local version',
      );

      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Create source repo with same skill name
      const sourceRepoDir = path.join(sourcesDir, 'platform', 'repo');
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'shared-name'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'shared-name', 'SKILL.md'),
        '# Source version',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['shared-name'],
        }),
      );

      await pullSources(localConfig, {});

      // Source skill should NOT be in the manifest (local takes priority)
      const manifestPath = path.join(sourcesDir, 'platform', 'installed.json');
      if (await fse.pathExists(manifestPath)) {
        const manifest = await fse.readJson(manifestPath) as SourceInstallManifest;
        expect(manifest.installedSkills).not.toContain('shared-name');
      }
    });

    it('should clean up skills no longer in publicSkills', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      // Simulate a previous install with old-skill
      const oldManifest: SourceInstallManifest = {
        lastPull: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        installedSkills: ['old-skill'],
      };
      await fse.ensureDir(path.join(sourcesDir, 'platform'));
      await fse.writeJson(path.join(sourcesDir, 'platform', 'installed.json'), oldManifest);

      // Deploy old-skill to claude dir
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'old-skill'));
      await fse.writeFile(
        path.join(homeDir, '.claude', 'skills', 'old-skill', 'SKILL.md'),
        '# Old',
      );

      // Source repo now only has new-skill (old-skill removed from publicSkills)
      const sourceRepoDir = path.join(sourcesDir, 'platform', 'repo');
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'new-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'new-skill', 'SKILL.md'),
        '# New',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['new-skill'],
        }),
      );

      await pullSources(localConfig, {});

      // old-skill should be removed
      const oldExists = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'old-skill'),
      );
      expect(oldExists).toBe(false);

      // new-skill should be deployed
      const newExists = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'new-skill', 'SKILL.md'),
      );
      expect(newExists).toBe(true);
    });

    it('should handle dry-run mode', async () => {
      teamConfig.sources = [{ name: 'platform', repo: 'git@git.woa.com:platform/repo.git' }];

      const YAML = (await import('yaml')).default;
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'teamai.yaml'),
        YAML.stringify(teamConfig),
      );

      const sourceRepoDir = path.join(sourcesDir, 'platform', 'repo');
      await fse.ensureDir(path.join(sourceRepoDir, 'skills', 'cool-skill'));
      await fse.writeFile(
        path.join(sourceRepoDir, 'skills', 'cool-skill', 'SKILL.md'),
        '# Cool',
      );
      await fse.writeFile(
        path.join(sourceRepoDir, 'teamai.yaml'),
        YAML.stringify({
          team: 'platform',
          repo: 'git@git.woa.com:platform/repo.git',
          publicSkills: ['cool-skill'],
        }),
      );

      await pullSources(localConfig, { dryRun: true });

      // Skill should NOT be deployed in dry-run
      const deployed = await fse.pathExists(
        path.join(homeDir, '.claude', 'skills', 'cool-skill'),
      );
      expect(deployed).toBe(false);
    });
  });
});

describe('TeamaiConfig sources schema', () => {
  it('should parse config without sources field (backward compat)', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
    });
    // sources is optional, so it should be undefined
    expect(config.sources).toBeUndefined();
  });

  it('should parse config with sources', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
      sources: [{ name: 'other', repo: 'git@git.woa.com:other/repo.git' }],
    });
    expect(config.sources).toHaveLength(1);
    expect(config.sources![0].name).toBe('other');
  });

  it('should parse config with publicSkills', async () => {
    const { TeamaiConfigSchema } = await import('../types.js');
    const config = TeamaiConfigSchema.parse({
      team: 'test',
      repo: 'https://git.woa.com/test/repo.git',
      publicSkills: ['skill-a', 'skill-b'],
    });
    expect(config.publicSkills).toEqual(['skill-a', 'skill-b']);
  });
});
