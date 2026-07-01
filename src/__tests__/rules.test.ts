import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', () => ({
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
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
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('RulesHandler.scanLocalForPush — modified rule detection', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-test-'));
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

  it('should detect a modified local rule as pushable with status "modified"', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'shared-rule.md'), 'old content');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared-rule.md'), 'new content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared-rule');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('should NOT include an unchanged rule', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'same-rule.md'), 'same content');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'same-rule.md'), 'same content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('same-rule');
  });

  it('should still detect new rules that are not in the team repo with status "new"', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'brand-new.md'), 'new rule');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'brand-new');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
  });

  it('should detect both new and modified rules together', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'existing.md'), 'v1');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'existing.md'), 'v2');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'brand-new.md'), 'new');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).toContain('existing');
    expect(names).toContain('brand-new');
  });

  it('should not detect modified rule if it is tombstoned', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'removed-rule.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'removed-rule.md'), 'new');
    await fse.writeFile(path.join(teamRulesDir, '.removed'), 'removed-rule\n');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('removed-rule');
  });

  it('should pick the modified version from the tool dir with latest mtime across multiple tools', async () => {
    // Setup: two tool directories
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'shared.md'), 'original');

    // claude dir has an older modification
    const claudePath = path.join(homeDir, '.claude/rules', 'shared.md');
    await fse.writeFile(claudePath, 'claude-modified');

    // Wait a bit to ensure mtime differs
    await new Promise((r) => setTimeout(r, 50));

    // codex dir has a newer modification
    const codexPath = path.join(homeDir, '.codex/rules', 'shared.md');
    await fse.writeFile(codexPath, 'codex-modified');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    expect(item!.sourcePath).toBe(codexPath);
  });

  it('should detect modification even if only one tool dir differs and others match team repo', async () => {
    // Setup: two tool directories
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'shared.md'), 'original');

    // claude dir matches team repo
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'original');

    // codex dir has a modification
    const codexPath = path.join(homeDir, '.codex/rules', 'shared.md');
    await fse.writeFile(codexPath, 'modified-in-codex');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    expect(item!.sourcePath).toBe(codexPath);
  });

  it('should return empty when all tool dirs match team repo', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'shared.md'), 'same');

    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared.md'), 'same');
    await fse.writeFile(path.join(homeDir, '.codex/rules', 'shared.md'), 'same');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items).toHaveLength(0);
  });

  it('should detect a new rule that only exists in one tool dir', async () => {
    await fse.ensureDir(path.join(homeDir, '.codex', 'rules'));
    teamConfig.toolPaths.codex = { skills: '.codex/skills', rules: '.codex/rules' };

    // Rule only exists in codex, not in claude or team repo
    const codexPath = path.join(homeDir, '.codex/rules', 'codex-only.md');
    await fse.writeFile(codexPath, 'only in codex');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'codex-only');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
    expect(item!.sourcePath).toBe(codexPath);
  });

  it('should skip tool dirs without rules path configured', async () => {
    teamConfig.toolPaths.norules = { skills: '.norules/skills' };

    await fse.writeFile(path.join(homeDir, '.claude/rules', 'my-rule.md'), 'content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    // Should still find the claude rule, and not crash on the norules tool
    expect(items.find((i) => i.name === 'my-rule')).toBeDefined();
  });

  it('should NOT include built-in rules (teamai-recall) in push candidates', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'teamai-recall.md'), 'auto-generated recall rule');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('teamai-recall');
  });
});

describe('RulesHandler.scanLocalForPush — subdirectory support', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-subdir-'));
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

  it('should detect new rules in subdirectories', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude/rules/common'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/common/coding-standards.md'), 'rule content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'common/coding-standards');
    expect(item).toBeDefined();
    expect(item!.status).toBe('new');
    expect(item!.relativePath).toBe('rules/common/coding-standards.md');
  });

  it('should detect modified rules in subdirectories', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'python'));
    await fse.writeFile(path.join(teamRulesDir, 'python/style.md'), 'old style');

    await fse.ensureDir(path.join(homeDir, '.claude/rules/python'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/python/style.md'), 'new style');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'python/style');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
  });

  it('should skip unchanged rules in subdirectories', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'golang'));
    await fse.writeFile(path.join(teamRulesDir, 'golang/errors.md'), 'same content');

    await fse.ensureDir(path.join(homeDir, '.claude/rules/golang'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/golang/errors.md'), 'same content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('golang/errors');
  });

  it('should detect rules in multiple subdirectories at once', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude/rules/common'));
    await fse.ensureDir(path.join(homeDir, '.claude/rules/python'));
    await fse.ensureDir(path.join(homeDir, '.claude/rules/golang'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/common/general.md'), 'general');
    await fse.writeFile(path.join(homeDir, '.claude/rules/python/style.md'), 'python style');
    await fse.writeFile(path.join(homeDir, '.claude/rules/golang/errors.md'), 'golang errors');
    // Also a root-level rule
    await fse.writeFile(path.join(homeDir, '.claude/rules/top-level.md'), 'top level');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(['common/general', 'golang/errors', 'python/style', 'top-level']);
  });

  it('should handle tombstoned rules in subdirectories', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'common'));
    await fse.writeFile(path.join(teamRulesDir, 'common/old-rule.md'), 'old');
    await fse.writeFile(path.join(teamRulesDir, '.removed'), 'common/old-rule\n');

    await fse.ensureDir(path.join(homeDir, '.claude/rules/common'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/common/old-rule.md'), 'modified');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('common/old-rule');
  });
});

describe('RulesHandler.scanTeamForPull — subdirectory support', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-pull-subdir-'));
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

  it('should scan rules in subdirectories from team repo', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'common'));
    await fse.ensureDir(path.join(teamRulesDir, 'python'));
    await fse.writeFile(path.join(teamRulesDir, 'top-level.md'), 'top');
    await fse.writeFile(path.join(teamRulesDir, 'common/general.md'), 'general');
    await fse.writeFile(path.join(teamRulesDir, 'python/style.md'), 'style');

    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    const names = items.map((i) => i.name).sort();
    expect(names).toEqual(['common/general', 'python/style', 'top-level']);
  });

  it('should generate correct relativePath for subdirectory rules', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'golang'));
    await fse.writeFile(path.join(teamRulesDir, 'golang/errors.md'), 'errors');

    const items = await handler.scanTeamForPull(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'golang/errors');
    expect(item).toBeDefined();
    expect(item!.relativePath).toBe('rules/golang/errors.md');
  });
});

describe('RulesHandler.pullAllRules — stale file cleanup', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-stale-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    // Create CLAUDE.md so pullAllRules can update it
    await fse.writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '');

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

  it('should remove local rule files that no longer exist in team repo', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');

    // Team repo only has tencent_standard.md
    await fse.writeFile(path.join(teamRulesDir, 'tencent_standard.md'), 'standard content');

    // Local has tencent_standard.md + stale files
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'tencent_standard.md'), 'old standard content');
    await fse.writeFile(path.join(localRulesDir, 'coding-style.md'), 'stale content');
    await fse.writeFile(path.join(localRulesDir, 'hooks.md'), 'stale content');

    await handler.pullAllRules(teamConfig, localConfig);

    // tencent_standard.md should be updated
    expect(await fse.pathExists(path.join(localRulesDir, 'tencent_standard.md'))).toBe(true);
    const content = await fse.readFile(path.join(localRulesDir, 'tencent_standard.md'), 'utf-8');
    expect(content).toBe('standard content');

    // Stale files should be removed
    expect(await fse.pathExists(path.join(localRulesDir, 'coding-style.md'))).toBe(false);
    expect(await fse.pathExists(path.join(localRulesDir, 'hooks.md'))).toBe(false);
  });

  it('should remove stale files in subdirectories', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');

    // Team repo has python/tencent_standard.md only
    await fse.ensureDir(path.join(teamRulesDir, 'python'));
    await fse.writeFile(path.join(teamRulesDir, 'python/tencent_standard.md'), 'standard');

    // Local has extra files in python/
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.ensureDir(path.join(localRulesDir, 'python'));
    await fse.writeFile(path.join(localRulesDir, 'python/tencent_standard.md'), 'old');
    await fse.writeFile(path.join(localRulesDir, 'python/coding-style.md'), 'stale');
    await fse.writeFile(path.join(localRulesDir, 'python/security.md'), 'stale');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(localRulesDir, 'python/tencent_standard.md'))).toBe(true);
    expect(await fse.pathExists(path.join(localRulesDir, 'python/coding-style.md'))).toBe(false);
    expect(await fse.pathExists(path.join(localRulesDir, 'python/security.md'))).toBe(false);
  });

  it('should remove empty subdirectories after cleaning stale files', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');

    // Team repo has only common/agents.md
    await fse.ensureDir(path.join(teamRulesDir, 'common'));
    await fse.writeFile(path.join(teamRulesDir, 'common/agents.md'), 'agents');

    // Local has a python/ subdir that should be cleaned entirely
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.ensureDir(path.join(localRulesDir, 'common'));
    await fse.writeFile(path.join(localRulesDir, 'common/agents.md'), 'old agents');
    await fse.ensureDir(path.join(localRulesDir, 'python'));
    await fse.writeFile(path.join(localRulesDir, 'python/old-rule.md'), 'stale');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(localRulesDir, 'common/agents.md'))).toBe(true);
    expect(await fse.pathExists(path.join(localRulesDir, 'python/old-rule.md'))).toBe(false);
    // The empty python/ directory should also be removed
    expect(await fse.pathExists(path.join(localRulesDir, 'python'))).toBe(false);
  });

  it('should clean stale files across multiple tool directories', async () => {
    // Add a second tool
    await fse.ensureDir(path.join(homeDir, '.claude-internal', 'rules'));
    teamConfig.toolPaths['claude-internal'] = {
      skills: '.claude-internal/skills',
      rules: '.claude-internal/rules',
      claudemd: '.claude-internal/CLAUDE.md',
    };
    await fse.writeFile(path.join(homeDir, '.claude-internal', 'CLAUDE.md'), '');

    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'keep.md'), 'keep this');

    // Both tool dirs have stale files
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'keep.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'stale.md'), 'stale');
    await fse.writeFile(path.join(homeDir, '.claude-internal/rules', 'keep.md'), 'old');
    await fse.writeFile(path.join(homeDir, '.claude-internal/rules', 'stale.md'), 'stale');

    await handler.pullAllRules(teamConfig, localConfig);

    // Both tool dirs should have stale.md removed
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'stale.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude-internal/rules', 'stale.md'))).toBe(false);

    // keep.md should exist in both
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules', 'keep.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.claude-internal/rules', 'keep.md'))).toBe(true);
  });

  it('should not remove non-.md files during cleanup', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'only-rule.md'), 'content');

    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'only-rule.md'), 'old');
    await fse.writeFile(path.join(localRulesDir, 'some-config.json'), '{}');

    await handler.pullAllRules(teamConfig, localConfig);

    // .json file should NOT be removed
    expect(await fse.pathExists(path.join(localRulesDir, 'some-config.json'))).toBe(true);
  });

  it('should not remove built-in rules (teamai-recall) during stale cleanup', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'team-rule.md'), 'team content');

    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'team-rule.md'), 'old');
    await fse.writeFile(path.join(localRulesDir, 'teamai-recall.md'), 'recall rule content');
    await fse.writeFile(path.join(localRulesDir, 'old-user-rule.md'), 'stale');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(localRulesDir, 'team-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(localRulesDir, 'teamai-recall.md'))).toBe(true);
    expect(await fse.pathExists(path.join(localRulesDir, 'old-user-rule.md'))).toBe(false);
  });
});
