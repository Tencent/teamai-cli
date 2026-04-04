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
}));

import { SkillsHandler } from '../resources/skills.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('SkillsHandler.scanLocalForPush', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-test-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    handler = new SkillsHandler();

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
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should detect a new skill with status "new"', async () => {
    const skillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-skill');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
  });

  it('should NOT detect a skill without SKILL.md', async () => {
    const skillDir = path.join(homeDir, '.claude/skills', 'no-skillmd');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'README.md'), 'not a skill');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('no-skillmd');
  });

  it('should detect a modified skill with status "modified"', async () => {
    // Team repo has v1
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# v1');

    // Local has v2
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-skill');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('should NOT include an unchanged skill', async () => {
    const content = '# Same Skill';

    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'same-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), content);

    const localSkillDir = path.join(homeDir, '.claude/skills', 'same-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), content);

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('same-skill');
  });

  it('should detect modification when skill has extra file locally', async () => {
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# Skill');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Skill');
    await fse.writeFile(path.join(localSkillDir, 'helper.sh'), 'echo hi');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-skill');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('should not detect a tombstoned skill', async () => {
    const skillDir = path.join(homeDir, '.claude/skills', 'removed-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Removed');

    // Write tombstone
    const tombstonePath = path.join(localConfig.repo.localPath, 'skills', '.removed');
    await fse.writeFile(tombstonePath, 'removed-skill\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('removed-skill');
  });

  it('should not detect a tombstoned modified skill', async () => {
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'removed-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# v1');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'removed-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2');

    const tombstonePath = path.join(localConfig.repo.localPath, 'skills', '.removed');
    await fse.writeFile(tombstonePath, 'removed-skill\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('removed-skill');
  });

  it('should detect both new and modified skills together', async () => {
    // Modified
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'existing');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# v1');

    const localExisting = path.join(homeDir, '.claude/skills', 'existing');
    await fse.ensureDir(localExisting);
    await fse.writeFile(path.join(localExisting, 'SKILL.md'), '# v2');

    // New
    const localNew = path.join(homeDir, '.claude/skills', 'brand-new');
    await fse.ensureDir(localNew);
    await fse.writeFile(path.join(localNew, 'SKILL.md'), '# New');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'existing')?.status).toBe('modified');
    expect(items.find((i) => i.name === 'brand-new')?.status).toBe('new');
  });

  it('should pick the modified version from the tool dir with latest mtime across multiple tools', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'shared');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# original');

    // claude dir has an older modification
    const claudeDir = path.join(homeDir, '.claude/skills', 'shared');
    await fse.ensureDir(claudeDir);
    await fse.writeFile(path.join(claudeDir, 'SKILL.md'), '# claude-modified');

    await new Promise((r) => setTimeout(r, 50));

    // codex dir has a newer modification
    const codexDir = path.join(homeDir, '.codex/skills', 'shared');
    await fse.ensureDir(codexDir);
    await fse.writeFile(path.join(codexDir, 'SKILL.md'), '# codex-modified');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    expect(item!.sourcePath).toBe(codexDir);
  });

  it('should detect modification even if only one tool dir differs and others match', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'shared');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# original');

    // claude matches team repo
    const claudeDir = path.join(homeDir, '.claude/skills', 'shared');
    await fse.ensureDir(claudeDir);
    await fse.writeFile(path.join(claudeDir, 'SKILL.md'), '# original');

    // codex has a modification
    const codexDir = path.join(homeDir, '.codex/skills', 'shared');
    await fse.ensureDir(codexDir);
    await fse.writeFile(path.join(codexDir, 'SKILL.md'), '# modified');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    expect(item!.sourcePath).toBe(codexDir);
  });

  it('should NOT detect modification when only CONTRIBUTORS differs in team repo', async () => {
    const content = '# Same Skill';

    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), content);
    await fse.writeFile(path.join(teamSkillDir, 'CONTRIBUTORS'), 'alice\nbob\n');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), content);
    // Local has no CONTRIBUTORS file

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('my-skill');
  });

  it('should not crash when a toolPath has no skills property', async () => {
    // Add a tool entry without a skills path (e.g., a hypothetical tool with only rules)
    (teamConfig.toolPaths as Record<string, unknown>)['no-skills-tool'] = { rules: '.no-skills-tool/rules' };

    const skillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# My Skill');

    // Should not throw and should still find skills from other tools
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'my-skill')).toBeDefined();
  });

  it('scans role-scoped team skill buckets when a primary role is configured', async () => {
    localConfig.primaryRole = 'hai';
    localConfig.additionalRoles = ['pm'];
    await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'hai', 'role-skill'));
    await fse.writeFile(path.join(localConfig.repo.localPath, 'skills', 'hai', 'role-skill', 'SKILL.md'), '# v1');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'role-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((item) => item.name === 'role-skill')?.status).toBe('modified');
  });
});

describe('SkillsHandler.pushItem', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-push-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    handler = new SkillsHandler();

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
      updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should create CONTRIBUTORS file with current user on first push', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# My Skill');

    const item = {
      name: 'my-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/my-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(localConfig.repo.localPath, 'skills', 'my-skill', 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('testuser\n');
  });

  it('should not duplicate username on repeated push', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# My Skill');

    const item = {
      name: 'my-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/my-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);
    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(localConfig.repo.localPath, 'skills', 'my-skill', 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('testuser\n');
  });

  it('should append new user to existing CONTRIBUTORS', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# My Skill');

    // Pre-seed CONTRIBUTORS in the team repo destination
    const destDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(destDir);
    await fse.writeFile(path.join(destDir, 'CONTRIBUTORS'), 'alice\n');

    const item = {
      name: 'my-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/my-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(destDir, 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('alice\ntestuser\n');
  });

  it('should preserve existing contributors when user already listed', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# My Skill');

    const destDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(destDir);
    await fse.writeFile(path.join(destDir, 'CONTRIBUTORS'), 'alice\ntestuser\n');

    const item = {
      name: 'my-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/my-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(destDir, 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('alice\ntestuser\n');
  });

  it('pushes role-scoped skills into skills/<role>/<name>', async () => {
    localConfig.primaryRole = 'hai';
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# My Skill');

    const item = {
      name: 'my-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/hai/my-skill',
      bucket: 'hai',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(localConfig.repo.localPath, 'skills', 'hai', 'my-skill', 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('testuser\n');
  });
});

describe('SkillsHandler.readContributors', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-contrib-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('should return contributors from CONTRIBUTORS file', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'CONTRIBUTORS'), 'alice\nbob\n');

    const contributors = await SkillsHandler.readContributors(skillDir);
    expect(contributors).toEqual(['alice', 'bob']);
  });

  it('should return empty array when CONTRIBUTORS does not exist', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fse.ensureDir(skillDir);

    const contributors = await SkillsHandler.readContributors(skillDir);
    expect(contributors).toEqual([]);
  });

  it('should handle empty CONTRIBUTORS file', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'CONTRIBUTORS'), '');

    const contributors = await SkillsHandler.readContributors(skillDir);
    expect(contributors).toEqual([]);
  });

  it('should trim whitespace and skip blank lines', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'CONTRIBUTORS'), '  alice  \n\n  bob  \n\n');

    const contributors = await SkillsHandler.readContributors(skillDir);
    expect(contributors).toEqual(['alice', 'bob']);
  });
});
