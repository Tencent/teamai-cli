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
import { scanTeamRepoNamespaces, ensureSkillFrontmatter } from '../resources/skills.js';
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

  it('should NOT detect modification when skill only has extra files locally', async () => {
    // Extra local files (scripts, agents, etc.) should not trigger "modified" status.
    // Only changes to files that exist in the team repo should count.
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# Skill');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Skill');
    await fse.writeFile(path.join(localSkillDir, 'helper.sh'), 'echo hi');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('my-skill');
  });

  it('should detect modification when team repo file content differs', async () => {
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# Skill v1');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Skill v2');

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

  it('should not detect a new skill listed in ~/.teamai/pushignore', async () => {
    const ignoredSkillDir = path.join(homeDir, '.claude/skills', 'ignored-skill');
    await fse.ensureDir(ignoredSkillDir);
    await fse.writeFile(path.join(ignoredSkillDir, 'SKILL.md'), '# Ignored');

    const trackedSkillDir = path.join(homeDir, '.claude/skills', 'tracked-skill');
    await fse.ensureDir(trackedSkillDir);
    await fse.writeFile(path.join(trackedSkillDir, 'SKILL.md'), '# Tracked');

    await fse.ensureDir(path.join(homeDir, '.teamai'));
    await fse.writeFile(path.join(homeDir, '.teamai', 'pushignore'), 'ignored-skill\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('ignored-skill');
    expect(names).toContain('tracked-skill');
  });

  it('should not detect a modified skill listed in ~/.teamai/pushignore', async () => {
    const teamSkillDir = path.join(localConfig.repo.localPath, 'skills', 'ignored-skill');
    await fse.ensureDir(teamSkillDir);
    await fse.writeFile(path.join(teamSkillDir, 'SKILL.md'), '# v1');

    const localSkillDir = path.join(homeDir, '.claude/skills', 'ignored-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2');

    await fse.ensureDir(path.join(homeDir, '.teamai'));
    await fse.writeFile(path.join(homeDir, '.teamai', 'pushignore'), '\n  ignored-skill  \n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('ignored-skill');
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

  it('scans role-scoped team skill namespaces when a primary role is configured', async () => {
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

  it('blocks skills that exist in non-allowed namespaces', async () => {
    localConfig.primaryRole = 'hai';
    localConfig.additionalRoles = [];

    // Create a skill in a non-allowed namespace (thpc_dev)
    await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'thpc_dev', 'blocked-skill'));
    await fse.writeFile(path.join(localConfig.repo.localPath, 'skills', 'thpc_dev', 'blocked-skill', 'SKILL.md'), '# v1');

    // Create the same skill locally
    const localSkillDir = path.join(homeDir, '.claude/skills', 'blocked-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2 - local version');

    // Scan should NOT include this skill because it's in a non-allowed namespace
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((item) => item.name === 'blocked-skill')).toBeUndefined();
  });

  it('recognizes root-level flat skills in role mode and does not mark them as new', async () => {
    localConfig.primaryRole = 'hai';
    localConfig.additionalRoles = [];

    // Create a root-level flat skill in team repo (has SKILL.md directly)
    const rootSkillDir = path.join(localConfig.repo.localPath, 'skills', 'autoresearch-skill');
    await fse.ensureDir(rootSkillDir);
    await fse.writeFile(path.join(rootSkillDir, 'SKILL.md'), '# Root skill');

    // Create the same skill locally with identical content
    const localSkillDir = path.join(homeDir, '.claude/skills', 'autoresearch-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Root skill');

    // Should NOT appear in push candidates since local == team repo
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((item) => item.name === 'autoresearch-skill')).toBeUndefined();
  });

  it('detects modified root-level flat skill in role mode', async () => {
    localConfig.primaryRole = 'hai';
    localConfig.additionalRoles = [];

    // Create a root-level flat skill in team repo
    const rootSkillDir = path.join(localConfig.repo.localPath, 'skills', 'autoresearch-skill');
    await fse.ensureDir(rootSkillDir);
    await fse.writeFile(path.join(rootSkillDir, 'SKILL.md'), '# v1');

    // Create the same skill locally with modified content
    const localSkillDir = path.join(homeDir, '.claude/skills', 'autoresearch-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2 — modified locally');

    // Should appear as "modified", not "new"
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'autoresearch-skill');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    // Root-level flat skills have no namespace
    expect(item!.namespace).toBeUndefined();
  });

  it('detects modified skill in namespaced team repo when no primaryRole is set', async () => {
    // No primaryRole — legacy mode
    // Team repo uses namespaced layout: skills/tencent/tgit/SKILL.md
    const namespacedSkillDir = path.join(localConfig.repo.localPath, 'skills', 'tencent', 'tgit');
    await fse.ensureDir(namespacedSkillDir);
    await fse.writeFile(path.join(namespacedSkillDir, 'SKILL.md'), '# v1');

    // Local has modified version
    const localSkillDir = path.join(homeDir, '.claude/skills', 'tgit');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# v2');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'tgit');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    // Modified skill should carry its original namespace from team repo
    expect(item!.namespace).toBe('tencent');
    expect(item!.relativePath).toBe('skills/tencent/tgit');
  });

  it('detects unchanged skill in namespaced team repo when no primaryRole is set', async () => {
    // No primaryRole — legacy mode
    const content = '# Same Skill';
    const namespacedSkillDir = path.join(localConfig.repo.localPath, 'skills', 'tencent', 'same-skill');
    await fse.ensureDir(namespacedSkillDir);
    await fse.writeFile(path.join(namespacedSkillDir, 'SKILL.md'), content);

    const localSkillDir = path.join(homeDir, '.claude/skills', 'same-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), content);

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.map((i) => i.name)).not.toContain('same-skill');
  });

  it('handles mixed flat and namespaced layout without primaryRole', async () => {
    // Flat skill
    const flatSkillDir = path.join(localConfig.repo.localPath, 'skills', 'flat-skill');
    await fse.ensureDir(flatSkillDir);
    await fse.writeFile(path.join(flatSkillDir, 'SKILL.md'), '# v1');

    // Namespaced skill
    const nsSkillDir = path.join(localConfig.repo.localPath, 'skills', 'myns', 'ns-skill');
    await fse.ensureDir(nsSkillDir);
    await fse.writeFile(path.join(nsSkillDir, 'SKILL.md'), '# v1');

    // Local has modified versions of both
    const localFlat = path.join(homeDir, '.claude/skills', 'flat-skill');
    await fse.ensureDir(localFlat);
    await fse.writeFile(path.join(localFlat, 'SKILL.md'), '# v2');

    const localNs = path.join(homeDir, '.claude/skills', 'ns-skill');
    await fse.ensureDir(localNs);
    await fse.writeFile(path.join(localNs, 'SKILL.md'), '# v2');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const flatItem = items.find((i) => i.name === 'flat-skill');
    const nsItem = items.find((i) => i.name === 'ns-skill');
    expect(flatItem?.status).toBe('modified');
    expect(flatItem?.namespace).toBeUndefined(); // flat skill has no namespace
    expect(nsItem?.status).toBe('modified');
    expect(nsItem?.namespace).toBe('myns'); // carries original namespace
    expect(nsItem?.relativePath).toBe('skills/myns/ns-skill');
  });

  it('does not treat namespace directories as new skills', async () => {
    // Team repo has namespace dir "tencent" with a skill inside
    const nsSkillDir = path.join(localConfig.repo.localPath, 'skills', 'tencent', 'tgit');
    await fse.ensureDir(nsSkillDir);
    await fse.writeFile(path.join(nsSkillDir, 'SKILL.md'), '# TGit');

    // Local has a completely unrelated skill
    const localSkillDir = path.join(homeDir, '.claude/skills', 'my-new-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# New');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    // "tencent" should NOT appear as a skill name
    expect(items.map((i) => i.name)).not.toContain('tencent');
    // "my-new-skill" should be detected as new with no namespace
    const newItem = items.find((i) => i.name === 'my-new-skill');
    expect(newItem?.status).toBe('new');
    expect(newItem?.namespace).toBeUndefined();
  });

  it('allows skills in allowed namespaces and new skills', async () => {
    localConfig.primaryRole = 'hai';
    localConfig.additionalRoles = [];

    // Create a skill in an allowed namespace
    await fse.ensureDir(path.join(localConfig.repo.localPath, 'skills', 'hai', 'allowed-skill'));
    await fse.writeFile(path.join(localConfig.repo.localPath, 'skills', 'hai', 'allowed-skill', 'SKILL.md'), '# v1');

    // Create a new skill locally that doesn't exist in team repo
    const newSkillDir = path.join(homeDir, '.claude/skills', 'new-skill');
    await fse.ensureDir(newSkillDir);
    await fse.writeFile(path.join(newSkillDir, 'SKILL.md'), '# new');

    // Create local version of allowed skill (modified)
    const localAllowedDir = path.join(homeDir, '.claude/skills', 'allowed-skill');
    await fse.ensureDir(localAllowedDir);
    await fse.writeFile(path.join(localAllowedDir, 'SKILL.md'), '# v2 - modified');

    // Scan should include allowed skill (modified) and new skill
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((item) => item.name === 'allowed-skill')?.status).toBe('modified');
    expect(items.find((item) => item.name === 'new-skill')?.status).toBe('new');
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
      namespace: 'hai',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const contribPath = path.join(localConfig.repo.localPath, 'skills', 'hai', 'my-skill', 'CONTRIBUTORS');
    const content = await fse.readFile(contribPath, 'utf-8');
    expect(content).toBe('testuser\n');
  });

  it('should NOT copy .git directory when skill source is a git repo', async () => {
    const localSkillDir = path.join(homeDir, '.claude/skills', 'git-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Git Skill\nContent here');
    await fse.writeFile(path.join(localSkillDir, 'helper.py'), 'print("hello")');
    // Simulate a .git directory (as if skill was cloned from a git repo)
    await fse.ensureDir(path.join(localSkillDir, '.git', 'objects'));
    await fse.writeFile(path.join(localSkillDir, '.git', 'HEAD'), 'ref: refs/heads/main');

    const item = {
      name: 'git-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/git-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    const destDir = path.join(localConfig.repo.localPath, 'skills', 'git-skill');
    expect(await fse.pathExists(path.join(destDir, 'SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(destDir, 'helper.py'))).toBe(true);
    expect(await fse.pathExists(path.join(destDir, '.git'))).toBe(false);
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

describe('scanTeamRepoNamespaces', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-ns-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('returns namespace directories (those without SKILL.md)', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    // Namespace dir
    await fse.ensureDir(path.join(repoPath, 'skills', 'tencent', 'tgit'));
    await fse.writeFile(path.join(repoPath, 'skills', 'tencent', 'tgit', 'SKILL.md'), '# TGit');
    // Flat skill
    await fse.ensureDir(path.join(repoPath, 'skills', 'flat-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'flat-skill', 'SKILL.md'), '# Flat');

    const namespaces = await scanTeamRepoNamespaces(repoPath);
    expect(namespaces).toContain('tencent');
    expect(namespaces).not.toContain('flat-skill');
  });

  it('returns empty array for purely flat layout', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    await fse.ensureDir(path.join(repoPath, 'skills', 'skill-a'));
    await fse.writeFile(path.join(repoPath, 'skills', 'skill-a', 'SKILL.md'), '# A');
    await fse.ensureDir(path.join(repoPath, 'skills', 'skill-b'));
    await fse.writeFile(path.join(repoPath, 'skills', 'skill-b', 'SKILL.md'), '# B');

    const namespaces = await scanTeamRepoNamespaces(repoPath);
    expect(namespaces).toEqual([]);
  });

  it('returns empty array when skills dir does not exist', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    await fse.ensureDir(repoPath);

    const namespaces = await scanTeamRepoNamespaces(repoPath);
    expect(namespaces).toEqual([]);
  });

  it('detects multiple namespaces', async () => {
    const repoPath = path.join(tmpDir, 'repo');
    await fse.ensureDir(path.join(repoPath, 'skills', 'tencent', 'tgit'));
    await fse.writeFile(path.join(repoPath, 'skills', 'tencent', 'tgit', 'SKILL.md'), '# TGit');
    await fse.ensureDir(path.join(repoPath, 'skills', 'hai_dev', 'hai-log'));
    await fse.writeFile(path.join(repoPath, 'skills', 'hai_dev', 'hai-log', 'SKILL.md'), '# Log');

    const namespaces = await scanTeamRepoNamespaces(repoPath);
    expect(namespaces).toContain('tencent');
    expect(namespaces).toContain('hai_dev');
    expect(namespaces).toHaveLength(2);
  });
});

describe('ensureSkillFrontmatter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-frontmatter-'));
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('injects frontmatter when SKILL.md has none', async () => {
    const skillDir = path.join(tmpDir, 'my-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# My Awesome Skill\n\nDoes cool things.');

    const changed = await ensureSkillFrontmatter(skillDir, 'my-skill');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^---\nname: my-skill\ndescription: My Awesome Skill\n---\n/);
    // Original content preserved after frontmatter
    expect(content).toContain('# My Awesome Skill');
    expect(content).toContain('Does cool things.');
  });

  it('does not modify SKILL.md when frontmatter already has name and description', async () => {
    const skillDir = path.join(tmpDir, 'complete-skill');
    await fse.ensureDir(skillDir);
    const original = '---\nname: complete-skill\ndescription: Already has metadata\n---\n\n# Complete Skill';
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), original);

    const changed = await ensureSkillFrontmatter(skillDir, 'complete-skill');
    expect(changed).toBe(false);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toBe(original);
  });

  it('adds missing name field to existing frontmatter', async () => {
    const skillDir = path.join(tmpDir, 'no-name');
    await fse.ensureDir(skillDir);
    await fse.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\ndescription: Has description only\n---\n\n# No Name Skill',
    );

    const changed = await ensureSkillFrontmatter(skillDir, 'no-name');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/name: no-name/);
    expect(content).toMatch(/description: Has description only/);
  });

  it('adds missing description field to existing frontmatter', async () => {
    const skillDir = path.join(tmpDir, 'no-desc');
    await fse.ensureDir(skillDir);
    await fse.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: no-desc\n---\n\n# A Skill Without Description',
    );

    const changed = await ensureSkillFrontmatter(skillDir, 'no-desc');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/name: no-desc/);
    expect(content).toMatch(/description: A Skill Without Description/);
  });

  it('uses first non-empty line when no heading is found', async () => {
    const skillDir = path.join(tmpDir, 'no-heading');
    await fse.ensureDir(skillDir);
    await fse.writeFile(
      path.join(skillDir, 'SKILL.md'),
      'This skill does something interesting and useful for the team.',
    );

    const changed = await ensureSkillFrontmatter(skillDir, 'no-heading');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/description: This skill does something interesting and useful for the team\./);
  });

  it('falls back to skill name when content is too short', async () => {
    const skillDir = path.join(tmpDir, 'short');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), 'Hi');

    const changed = await ensureSkillFrontmatter(skillDir, 'short');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/description: short skill/);
  });

  it('returns false for missing SKILL.md', async () => {
    const skillDir = path.join(tmpDir, 'empty');
    await fse.ensureDir(skillDir);

    const changed = await ensureSkillFrontmatter(skillDir, 'empty');
    expect(changed).toBe(false);
  });

  it('truncates very long descriptions', async () => {
    const skillDir = path.join(tmpDir, 'long-desc');
    await fse.ensureDir(skillDir);
    const longLine = 'A'.repeat(100);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), longLine);

    const changed = await ensureSkillFrontmatter(skillDir, 'long-desc');
    expect(changed).toBe(true);

    const content = await fse.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const descMatch = content.match(/description: (.+)/);
    expect(descMatch).toBeTruthy();
    expect(descMatch![1].length).toBeLessThanOrEqual(80);
    expect(descMatch![1]).toContain('...');
  });

  it('pushItem auto-injects frontmatter for skills without it', async () => {
    const homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    const localSkillDir = path.join(homeDir, '.claude/skills', 'bare-skill');
    await fse.ensureDir(localSkillDir);
    await fse.writeFile(path.join(localSkillDir, 'SKILL.md'), '# Bare Skill\n\nNo frontmatter here.');

    const handler = new SkillsHandler();
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
    };
    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    const item = {
      name: 'bare-skill',
      type: 'skills' as const,
      sourcePath: localSkillDir,
      relativePath: 'skills/bare-skill',
    };

    await handler.pushItem(item, teamConfig, localConfig);

    // Verify frontmatter was injected in the team repo copy
    const pushedContent = await fse.readFile(
      path.join(repoPath, 'skills', 'bare-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(pushedContent).toMatch(/^---\nname: bare-skill\ndescription: Bare Skill\n---\n/);
  });
});
