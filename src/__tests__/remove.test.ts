import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Mock external dependencies before importing modules
const mockState: { placedRules?: Record<string, string> } = {};
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  // The rules scanner and `publishedNameFor` read push placements from
  // state.json; tests set `mockState.placedRules` when they need one.
  loadStateForScope: vi.fn(async () => mockState),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn(),
  pushRepoBranch: vi.fn().mockResolvedValue(true),
  generateBranchName: vi.fn().mockReturnValue('teamai/push/test/20260305-120000'),
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
  })),
}));

import { RulesHandler } from '../resources/rules.js';
import { SkillsHandler } from '../resources/skills.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('RulesHandler.removeItem', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-remove-test-'));
    homeDir = path.join(tmpDir, 'home');

    // Create team repo rules dir
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Create home tool directories
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude-internal', 'rules'));

    // Stub HOME
    vi.stubEnv('HOME', homeDir);

    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md' },
        codex: { skills: '.codex/skills', rules: '.codex/rules' },
        'claude-internal': { skills: '.claude-internal/skills', rules: '.claude-internal/rules', settings: '.claude-internal/settings.json', claudemd: '.claude-internal/CLAUDE.md' },
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
    delete mockState.placedRules;
    await fse.remove(tmpDir);
  });

  /**
   * A rule push placed under rules/<ns>/ is published as `<ns>/<name>`, but the
   * author's own copy never left the rules root, so the name they type is the
   * bare one. Answering "not found" about a rule we recorded putting there — or
   * deleting rules/<name>.md and leaving the namespaced one published — is the
   * finding this covers (#649 review round 3).
   */
  describe('a rule published into a namespace', () => {
    it('resolves the bare name to the name it was published under', async () => {
      await fse.outputFile(
        path.join(localConfig.repo.localPath, 'rules', 'fe-know', 'my-rule.md'), 'team content',
      );
      mockState.placedRules = { 'my-rule': 'rules/fe-know/my-rule.md' };

      expect(await handler.publishedNameFor('my-rule', localConfig)).toBe('fe-know/my-rule');
    });

    it('does not resolve a record whose team file is gone', async () => {
      mockState.placedRules = { 'my-rule': 'rules/fe-know/my-rule.md' };

      expect(await handler.publishedNameFor('my-rule', localConfig)).toBeNull();
    });

    it('does not resolve a rule this machine never placed', async () => {
      await fse.outputFile(
        path.join(localConfig.repo.localPath, 'rules', 'fe-know', 'my-rule.md'), 'team content',
      );

      expect(await handler.publishedNameFor('my-rule', localConfig)).toBeNull();
    });

    it('tombstones only the published name, even when the record makes the root copy ours', async () => {
      await fse.outputFile(
        path.join(localConfig.repo.localPath, 'rules', 'fe-know', 'my-rule.md'), 'team content',
      );
      mockState.placedRules = { 'my-rule': 'rules/fe-know/my-rule.md' };

      await handler.removeItem('fe-know/my-rule', teamConfig, localConfig);

      // Every member reads the tombstone: a bare `my-rule` would sweep their
      // own root rule of that name and stop them publishing one. A copy an
      // excluded tool keeps is instead not a push source at all.
      const tombstones = await fse.readFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'utf-8',
      );
      expect(tombstones.split('\n')).toContain('fe-know/my-rule');
      expect(tombstones.split('\n')).not.toContain('my-rule');
    });

    it('tombstones only the name given when no record vouches for the bare one', async () => {
      await fse.outputFile(path.join(localConfig.repo.localPath, 'rules', 'fe', 'foo.md'), 'team');

      await handler.removeItem('fe/foo', teamConfig, localConfig);

      const tombstones = await fse.readFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'utf-8',
      );
      expect(tombstones.split('\n')).toContain('fe/foo');
      // Tombstoning `foo` would suppress an unrelated personal rule of that name.
      expect(tombstones.split('\n')).not.toContain('foo');
    });

    it('leaves an unrelated root rule that only shares the basename', async () => {
      // `remove rules fe/foo` must not take a personal .claude/rules/foo.md
      // with it. Nothing on this machine says the two are the same rule.
      await fse.outputFile(path.join(localConfig.repo.localPath, 'rules', 'fe', 'foo.md'), 'team');
      await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'foo.md'), 'my own foo');

      await handler.removeItem('fe/foo', teamConfig, localConfig);

      expect(await fse.pathExists(path.join(localConfig.repo.localPath, 'rules', 'fe', 'foo.md'))).toBe(false);
      expect(await fse.readFile(path.join(homeDir, '.claude', 'rules', 'foo.md'), 'utf-8'))
        .toBe('my own foo');
    });

    it('ignores a record that points somewhere else', async () => {
      await fse.outputFile(path.join(localConfig.repo.localPath, 'rules', 'fe', 'foo.md'), 'team');
      await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'foo.md'), 'my own foo');
      mockState.placedRules = { foo: 'rules/other-ns/foo.md' };

      await handler.removeItem('fe/foo', teamConfig, localConfig);

      expect(await fse.readFile(path.join(homeDir, '.claude', 'rules', 'foo.md'), 'utf-8'))
        .toBe('my own foo');
    });

    it('removes the namespaced team file and the author\'s copy at the rules root', async () => {
      await fse.outputFile(
        path.join(localConfig.repo.localPath, 'rules', 'fe-know', 'my-rule.md'), 'team content',
      );
      // The record is what makes the root copy this rule's, and ours to delete.
      mockState.placedRules = { 'my-rule': 'rules/fe-know/my-rule.md' };
      // The author's own copy, and the namespaced one a member would receive.
      await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'my-rule.md'), 'local');
      await fse.outputFile(path.join(homeDir, '.claude', 'rules', 'fe-know', 'my-rule.md'), 'local');

      const removed = await handler.removeItem('fe-know/my-rule', teamConfig, localConfig);

      expect(await fse.pathExists(
        path.join(localConfig.repo.localPath, 'rules', 'fe-know', 'my-rule.md'),
      )).toBe(false);
      // Leaving the root copy behind re-publishes the rule on the next push.
      expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'my-rule.md'))).toBe(false);
      expect(await fse.pathExists(
        path.join(homeDir, '.claude', 'rules', 'fe-know', 'my-rule.md'),
      )).toBe(false);
      expect(removed.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('should remove rule from team repo and all tool directories', async () => {
    // Create the rule in team repo
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'my-rule.md'), 'rule content');
    // Create the rule in tool directories
    await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'my-rule.md'), 'rule content');
    await fse.writeFile(path.join(homeDir, '.codex', 'rules', 'my-rule.md'), 'rule content');
    await fse.writeFile(path.join(homeDir, '.claude-internal', 'rules', 'my-rule.md'), 'rule content');

    const removed = await handler.removeItem('my-rule', teamConfig, localConfig);

    expect(removed.length).toBe(4); // team repo + 3 tools
    expect(await fse.pathExists(path.join(localConfig.repo.localPath, 'rules', 'my-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'my-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'rules', 'my-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude-internal', 'rules', 'my-rule.md'))).toBe(false);
  });

  it('should leave rules of an excluded tool alone', async () => {
    // Regression for #590: a tool outside enabledAgents is not ours to write
    // to, so it is not ours to delete from either.
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'my-rule.md'), 'rule content');
    // A second team rule keeps `pullAllRules` from returning early, so the
    // stale-file pass it runs after the removal is exercised too.
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'other-rule.md'), 'other content');
    await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'my-rule.md'), 'rule content');
    await fse.writeFile(path.join(homeDir, '.codex', 'rules', 'my-rule.md'), 'rule content');

    const removed = await handler.removeItem('my-rule', teamConfig, { ...localConfig, enabledAgents: ['claude'] });

    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'my-rule.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'rules', 'my-rule.md'))).toBe(true);
    // `removed` is what the CLI reports back, so it must not name the excluded tool.
    expect(removed.some((p) => p.includes('.codex'))).toBe(false);
  });

  it('should only remove from locations where the rule exists', async () => {
    // Only create in team repo and one tool
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'partial-rule.md'), 'content');
    await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'partial-rule.md'), 'content');

    const removed = await handler.removeItem('partial-rule', teamConfig, localConfig);

    expect(removed.length).toBe(2); // team repo + claude only
  });

  it('should return empty array when rule does not exist anywhere', async () => {
    const removed = await handler.removeItem('nonexistent', teamConfig, localConfig);

    expect(removed.length).toBe(0);
  });

  it('should not affect other rules when removing one', async () => {
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'keep-me.md'), 'keep');
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'delete-me.md'), 'delete');
    await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'keep-me.md'), 'keep');
    await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'delete-me.md'), 'delete');

    await handler.removeItem('delete-me', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(localConfig.repo.localPath, 'rules', 'keep-me.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'keep-me.md'))).toBe(true);
    expect(await fse.pathExists(path.join(localConfig.repo.localPath, 'rules', 'delete-me.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'delete-me.md'))).toBe(false);
  });
});

describe('SkillsHandler.removeItem', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-remove-test-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));

    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills'));

    vi.stubEnv('HOME', homeDir);

    handler = new SkillsHandler();

    teamConfig = {
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

  it('should remove skill directory from team repo and all sync targets', async () => {
    // Create skill directories with SKILL.md
    const teamSkill = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkill);
    await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# My Skill');

    const claudeSkill = path.join(homeDir, '.claude', 'skills', 'my-skill');
    await fse.ensureDir(claudeSkill);
    await fse.writeFile(path.join(claudeSkill, 'SKILL.md'), '# My Skill');

    const codexSkill = path.join(homeDir, '.codex', 'skills', 'my-skill');
    await fse.ensureDir(codexSkill);
    await fse.writeFile(path.join(codexSkill, 'SKILL.md'), '# My Skill');

    const removed = await handler.removeItem('my-skill', teamConfig, localConfig);

    expect(removed.length).toBe(3);
    expect(await fse.pathExists(teamSkill)).toBe(false);
    expect(await fse.pathExists(claudeSkill)).toBe(false);
    expect(await fse.pathExists(codexSkill)).toBe(false);
  });

  it('should leave skills of an excluded tool alone', async () => {
    // Regression for #590, the skills half: same gate as rules and agents.
    const teamSkill = path.join(localConfig.repo.localPath, 'skills', 'my-skill');
    await fse.ensureDir(teamSkill);
    await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# My Skill');

    const claudeSkill = path.join(homeDir, '.claude', 'skills', 'my-skill');
    await fse.ensureDir(claudeSkill);
    await fse.writeFile(path.join(claudeSkill, 'SKILL.md'), '# My Skill');

    const codexSkill = path.join(homeDir, '.codex', 'skills', 'my-skill');
    await fse.ensureDir(codexSkill);
    await fse.writeFile(path.join(codexSkill, 'SKILL.md'), '# My Skill');

    const removed = await handler.removeItem('my-skill', teamConfig, { ...localConfig, enabledAgents: ['claude'] });

    expect(await fse.pathExists(claudeSkill)).toBe(false);
    expect(await fse.pathExists(codexSkill)).toBe(true);
    expect(removed.some((p) => p.includes('.codex'))).toBe(false);
  });

  it('should only remove from locations where the skill exists', async () => {
    const teamSkill = path.join(localConfig.repo.localPath, 'skills', 'partial-skill');
    await fse.ensureDir(teamSkill);
    await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# Skill');

    const removed = await handler.removeItem('partial-skill', teamConfig, localConfig);

    expect(removed.length).toBe(1);
    expect(await fse.pathExists(teamSkill)).toBe(false);
  });

  it('should return empty array when skill does not exist', async () => {
    const removed = await handler.removeItem('ghost-skill', teamConfig, localConfig);
    expect(removed.length).toBe(0);
  });

  it('should not affect other skills when removing one', async () => {
    const keepSkill = path.join(localConfig.repo.localPath, 'skills', 'keep-skill');
    await fse.ensureDir(keepSkill);
    await fse.writeFile(path.join(keepSkill, 'SKILL.md'), '# Keep');

    const deleteSkill = path.join(localConfig.repo.localPath, 'skills', 'delete-skill');
    await fse.ensureDir(deleteSkill);
    await fse.writeFile(path.join(deleteSkill, 'SKILL.md'), '# Delete');

    await handler.removeItem('delete-skill', teamConfig, localConfig);

    expect(await fse.pathExists(keepSkill)).toBe(true);
    expect(await fse.pathExists(deleteSkill)).toBe(false);
  });
});

describe('Tombstone mechanism', () => {
  describe('RulesHandler tombstones', () => {
    let tmpDir: string;
    let homeDir: string;
    let handler: RulesHandler;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-test-'));
      homeDir = path.join(tmpDir, 'home');

      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

      vi.stubEnv('HOME', homeDir);

      handler = new RulesHandler();

      teamConfig = {
        team: 'test',
        description: '',
        repo: 'https://git.woa.com/test/repo.git',
        provider: 'tgit' as const,
        reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: {
          claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md' },
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

    it('should write .removed file when removing a rule', async () => {
      await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'), '# Test');
      await handler.removeItem('test-rule', teamConfig, localConfig);

      const removedContent = await fse.readFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'utf-8',
      );
      expect(removedContent.trim()).toBe('test-rule');
    });

    it('should skip tombstoned resources in scanLocalForPush', async () => {
      // Local files exist
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'deleted-rule.md'), '# Deleted');
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'new-rule.md'), '# New');

      // Tombstone for deleted-rule
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'deleted-rule\n',
      );

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      const names = items.map((i) => i.name);
      expect(names).toContain('new-rule');
      expect(names).not.toContain('deleted-rule');
    });

    it('should still push non-tombstoned resources', async () => {
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'active-rule.md'), '# Active');
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'another-rule.md'), '# Another');

      // Tombstone only an unrelated resource
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'some-other-rule\n',
      );

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      const names = items.map((i) => i.name);
      expect(names).toContain('active-rule');
      expect(names).toContain('another-rule');
      expect(names.length).toBe(2);
    });

    it('should not produce duplicate entries in .removed', async () => {
      // Remove same rule twice
      await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'dup-rule.md'), '# Dup');
      await handler.removeItem('dup-rule', teamConfig, localConfig);

      await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'dup-rule.md'), '# Dup Again');
      await handler.removeItem('dup-rule', teamConfig, localConfig);

      const removedContent = await fse.readFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'utf-8',
      );
      const entries = removedContent.trim().split('\n').filter((l: string) => l.length > 0);
      expect(entries).toEqual(['dup-rule']);
    });

    it('should sort entries in .removed', async () => {
      await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'zebra.md'), '# Z');
      await handler.removeItem('zebra', teamConfig, localConfig);

      await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'alpha.md'), '# A');
      await handler.removeItem('alpha', teamConfig, localConfig);

      const removedContent = await fse.readFile(
        path.join(localConfig.repo.localPath, 'rules', '.removed'), 'utf-8',
      );
      const entries = removedContent.trim().split('\n').filter((l: string) => l.length > 0);
      expect(entries).toEqual(['alpha', 'zebra']);
    });
  });

  describe('SkillsHandler tombstones', () => {
    let tmpDir: string;
    let homeDir: string;
    let handler: SkillsHandler;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-test-'));
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
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '' },
          env: { injectShellProfile: true },
        },
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

    it('should write .removed file when removing a skill', async () => {
      const teamSkill = path.join(localConfig.repo.localPath, 'skills', 'test-skill');
      await fse.ensureDir(teamSkill);
      await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# Skill');

      await handler.removeItem('test-skill', teamConfig, localConfig);

      const removedContent = await fse.readFile(
        path.join(localConfig.repo.localPath, 'skills', '.removed'), 'utf-8',
      );
      expect(removedContent.trim()).toBe('test-skill');
    });

    it('should skip tombstoned skills in scanLocalForPush', async () => {
      // Create local skills
      await fse.ensureDir(path.join(homeDir, '.claude/skills/deleted-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/deleted-skill/SKILL.md'), '# Deleted');

      await fse.ensureDir(path.join(homeDir, '.claude/skills/new-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/new-skill/SKILL.md'), '# New');

      // Tombstone
      await fse.writeFile(
        path.join(localConfig.repo.localPath, 'skills', '.removed'), 'deleted-skill\n',
      );

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      const names = items.map((i) => i.name);
      expect(names).toContain('new-skill');
      expect(names).not.toContain('deleted-skill');
    });
  });

  describe('readTombstones / addTombstone', () => {
    let tmpDir: string;
    let handler: RulesHandler;
    let localConfig: LocalConfig;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-test-'));
      await fse.ensureDir(path.join(tmpDir, 'rules'));
      handler = new RulesHandler();
      localConfig = {
        repo: { localPath: tmpDir, remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };
    });

    afterEach(async () => {
      await fse.remove(tmpDir);
    });

    it('should return empty set when no .removed file exists', async () => {
      const tombstones = await handler.readTombstones(localConfig);
      expect(tombstones.size).toBe(0);
    });

    it('should ignore blank lines in .removed', async () => {
      await fse.writeFile(path.join(tmpDir, 'rules', '.removed'), 'foo\n\nbar\n\n');
      const tombstones = await handler.readTombstones(localConfig);
      expect(tombstones).toEqual(new Set(['foo', 'bar']));
    });

    it('should trim whitespace from entries', async () => {
      await fse.writeFile(path.join(tmpDir, 'rules', '.removed'), '  spaced  \n  padded\n');
      const tombstones = await handler.readTombstones(localConfig);
      expect(tombstones).toEqual(new Set(['spaced', 'padded']));
    });

    it('should create directory when adding first tombstone if needed', async () => {
      await fse.remove(path.join(tmpDir, 'rules'));
      await handler.addTombstone('first-rule', localConfig);
      const exists = await fse.pathExists(path.join(tmpDir, 'rules', '.removed'));
      expect(exists).toBe(true);
      const content = await fse.readFile(path.join(tmpDir, 'rules', '.removed'), 'utf-8');
      expect(content.trim()).toBe('first-rule');
    });
  });

  describe('SkillsHandler tombstone dedup and sort', () => {
    let tmpDir: string;
    let homeDir: string;
    let handler: SkillsHandler;
    let teamConfig: TeamaiConfig;
    let localConfig: LocalConfig;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-test-'));
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
        sharing: {
          skills: {},
          rules: { enforced: [] },
          docs: { localDir: '' },
          env: { injectShellProfile: true },
        },
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

    it('should not produce duplicate entries in skills .removed', async () => {
      const teamSkill = path.join(localConfig.repo.localPath, 'skills', 'dup-skill');
      await fse.ensureDir(teamSkill);
      await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# Dup');
      await handler.removeItem('dup-skill', teamConfig, localConfig);

      // Recreate and remove again
      await fse.ensureDir(teamSkill);
      await fse.writeFile(path.join(teamSkill, 'SKILL.md'), '# Dup Again');
      await handler.removeItem('dup-skill', teamConfig, localConfig);

      const content = await fse.readFile(
        path.join(localConfig.repo.localPath, 'skills', '.removed'), 'utf-8',
      );
      const entries = content.trim().split('\n').filter((l: string) => l.length > 0);
      expect(entries).toEqual(['dup-skill']);
    });

    it('should sort entries in skills .removed', async () => {
      const skillZ = path.join(localConfig.repo.localPath, 'skills', 'zebra-skill');
      await fse.ensureDir(skillZ);
      await fse.writeFile(path.join(skillZ, 'SKILL.md'), '# Z');
      await handler.removeItem('zebra-skill', teamConfig, localConfig);

      const skillA = path.join(localConfig.repo.localPath, 'skills', 'alpha-skill');
      await fse.ensureDir(skillA);
      await fse.writeFile(path.join(skillA, 'SKILL.md'), '# A');
      await handler.removeItem('alpha-skill', teamConfig, localConfig);

      const content = await fse.readFile(
        path.join(localConfig.repo.localPath, 'skills', '.removed'), 'utf-8',
      );
      const entries = content.trim().split('\n').filter((l: string) => l.length > 0);
      expect(entries).toEqual(['alpha-skill', 'zebra-skill']);
    });
  });

  describe('removeItem always writes tombstone even when resource does not exist', () => {
    let tmpDir: string;
    let homeDir: string;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-test-'));
      homeDir = path.join(tmpDir, 'home');
      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.ensureDir(path.join(repoPath, 'skills'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
      vi.stubEnv('HOME', homeDir);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fse.remove(tmpDir);
    });

    it('should write tombstone for rules even when file does not exist', async () => {
      const handler = new RulesHandler();
      const localConfig: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };
      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };

      const removed = await handler.removeItem('nonexistent-rule', teamConfig, localConfig);
      expect(removed.length).toBe(0);

      const tombstones = await handler.readTombstones(localConfig);
      expect(tombstones.has('nonexistent-rule')).toBe(true);
    });

    it('should write tombstone for skills even when directory does not exist', async () => {
      const handler = new SkillsHandler();
      const localConfig: LocalConfig = {
        repo: { localPath: path.join(tmpDir, 'team-repo'), remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };
      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };

      const removed = await handler.removeItem('nonexistent-skill', teamConfig, localConfig);
      expect(removed.length).toBe(0);

      const tombstones = await handler.readTombstones(localConfig);
      expect(tombstones.has('nonexistent-skill')).toBe(true);
    });
  });

  describe('End-to-end: remove then scanLocalForPush', () => {
    let tmpDir: string;
    let homeDir: string;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-e2e-'));
      homeDir = path.join(tmpDir, 'home');
      vi.stubEnv('HOME', homeDir);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fse.remove(tmpDir);
    });

    it('rules: removeItem then scanLocalForPush should not re-discover the removed rule', async () => {
      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };
      const localConfig: LocalConfig = {
        repo: { localPath: repoPath, remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };

      const handler = new RulesHandler();

      // Rule exists in team repo and locally
      await fse.writeFile(path.join(repoPath, 'rules', 'shared-rule.md'), '# Shared');
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared-rule.md'), '# Shared');

      // Remove it from team repo
      await handler.removeItem('shared-rule', teamConfig, localConfig);

      // Local file still exists (simulates another user's state)
      expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'shared-rule.md'))).toBe(false);
      // But re-create it to simulate user B who still has it
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared-rule.md'), '# Shared');

      // scanLocalForPush should NOT pick it up
      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.map((i) => i.name)).not.toContain('shared-rule');
    });

    it('skills: removeItem then scanLocalForPush should not re-discover the removed skill', async () => {
      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'skills'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };
      const localConfig: LocalConfig = {
        repo: { localPath: repoPath, remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };

      const handler = new SkillsHandler();

      // Skill in team repo and locally
      await fse.ensureDir(path.join(repoPath, 'skills', 'shared-skill'));
      await fse.writeFile(path.join(repoPath, 'skills', 'shared-skill', 'SKILL.md'), '# Shared');
      await fse.ensureDir(path.join(homeDir, '.claude/skills/shared-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/shared-skill/SKILL.md'), '# Shared');

      await handler.removeItem('shared-skill', teamConfig, localConfig);

      // Re-create locally to simulate user B
      await fse.ensureDir(path.join(homeDir, '.claude/skills/shared-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/shared-skill/SKILL.md'), '# Shared');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.map((i) => i.name)).not.toContain('shared-skill');
    });
  });

  describe('diff() respects tombstones', () => {
    let tmpDir: string;
    let homeDir: string;

    beforeEach(async () => {
      tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-tombstone-diff-'));
      homeDir = path.join(tmpDir, 'home');
      vi.stubEnv('HOME', homeDir);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fse.remove(tmpDir);
    });

    it('tombstoned rule should not appear in diff.added', async () => {
      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));

      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };
      const localConfig: LocalConfig = {
        repo: { localPath: repoPath, remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };

      const handler = new RulesHandler();

      // Local rule that is tombstoned
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'old-rule.md'), '# Old');
      await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'old-rule\n');

      // Non-tombstoned local rule
      await fse.writeFile(path.join(homeDir, '.claude/rules', 'new-rule.md'), '# New');

      const result = await handler.diff(teamConfig, localConfig);
      const addedNames = result.added.map((i) => i.name);
      expect(addedNames).toContain('new-rule');
      expect(addedNames).not.toContain('old-rule');
    });

    it('tombstoned skill should not appear in diff.added', async () => {
      const repoPath = path.join(tmpDir, 'team-repo');
      await fse.ensureDir(path.join(repoPath, 'skills'));
      await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

      const teamConfig: TeamaiConfig = {
        team: 'test', description: '', repo: '', provider: 'tgit' as const, reviewers: [],
        sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
        toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
      };
      const localConfig: LocalConfig = {
        repo: { localPath: repoPath, remote: '' },
        username: 'testuser',
        updatePolicy: 'auto',
additionalRoles: [],
scope: 'user',
      };

      const handler = new SkillsHandler();

      // Local skill that is tombstoned
      await fse.ensureDir(path.join(homeDir, '.claude/skills/old-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/old-skill/SKILL.md'), '# Old');
      await fse.writeFile(path.join(repoPath, 'skills', '.removed'), 'old-skill\n');

      // Non-tombstoned local skill
      await fse.ensureDir(path.join(homeDir, '.claude/skills/new-skill'));
      await fse.writeFile(path.join(homeDir, '.claude/skills/new-skill/SKILL.md'), '# New');

      const result = await handler.diff(teamConfig, localConfig);
      const addedNames = result.added.map((i) => i.name);
      expect(addedNames).toContain('new-skill');
      expect(addedNames).not.toContain('old-skill');
    });
  });
});
