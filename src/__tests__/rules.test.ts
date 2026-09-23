import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn(),
  saveState: vi.fn(),
  // The rules scanner reads state.json for push placements; an empty state is
  // the default, and tests that need a record override it for one call.
  loadStateForScope: vi.fn(async () => ({})),
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
import { loadStateForScope } from '../config.js';
import type { TeamaiConfig, LocalConfig, State } from '../types.js';

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

  it('does not read rules from a tool this member excluded', async () => {
    // `removeItem` leaves an excluded tool's copy alone; read here, it would
    // republish a rule the member just removed (#649 review).
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'kept-by-excluded.md'), 'old rule');

    const items = await handler.scanLocalForPush(teamConfig, { ...localConfig, disabledAgents: ['claude'] });

    expect(items.find((i) => i.name === 'kept-by-excluded')).toBeUndefined();
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


  /**
   * Once push places a new rule under rules/<ns>/, the author's own copy stays
   * at the tool's rules root. Matching by full path alone would read it as a
   * brand-new rule on the next push and send a second copy to the shared root,
   * where it would reach the whole team (issue #649). push records the
   * placement in state.json, and only that record maps a root-level local rule
   * to a namespaced team file: a basename match alone proves nothing, because
   * a namespaced team rule is pulled into a namespaced local directory.
   */
  function stateWithPlacedRules(placedRules: Record<string, string>) {
    const state: State = {
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules,
    };
    vi.mocked(loadStateForScope).mockResolvedValueOnce(state);
  }

  it('matches a root-level local rule against the namespaced copy push recorded for it', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'fe-know'));
    await fse.writeFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'team content');
    stateWithPlacedRules({ 'my-rule': 'rules/fe-know/my-rule.md' });

    await fse.writeFile(path.join(homeDir, '.claude/rules/my-rule.md'), 'edited locally');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-rule');
    expect(item?.status).toBe('modified');
    expect(item?.relativePath).toBe('rules/fe-know/my-rule.md');
    // Recorded on the item too, so an open PR can reuse the destination.
    expect(item?.namespace).toBe('fe-know');
  });

  it('does not re-push a root-level local rule that equals the namespaced copy it was placed at', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'fe-know'));
    await fse.writeFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'same content');
    stateWithPlacedRules({ 'my-rule': 'rules/fe-know/my-rule.md' });

    await fse.writeFile(path.join(homeDir, '.claude/rules/my-rule.md'), 'same content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.map((i) => i.name)).not.toContain('my-rule');
  });

  it('keeps an unrelated root-level rule new when only its basename matches a namespaced team rule', async () => {
    // Another member's machine: the team has rules/fe-know/foo.md, and this
    // user wrote their own foo.md at the rules root. Nothing was pushed from
    // here, so there is no record — and no grounds to overwrite the team rule.
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'fe-know'));
    await fse.writeFile(path.join(teamRulesDir, 'fe-know/foo.md'), 'team rule');
    stateWithPlacedRules({});

    await fse.writeFile(path.join(homeDir, '.claude/rules/foo.md'), 'unrelated local rule');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'foo');
    expect(item?.status).toBe('new');
    expect(item?.relativePath).toBe('rules/foo.md');
    expect(item?.namespace).toBeUndefined();
  });

  it('keeps following the record when a shared-root rule with the same name appears later', async () => {
    // Another contributor adds rules/my-rule.md after this rule was placed.
    // Mapping the author's copy onto it would push their content over an
    // unrelated team rule, so the record wins (#649 review round 3).
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'fe-know'));
    await fse.writeFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'the placed rule');
    await fse.writeFile(path.join(teamRulesDir, 'my-rule.md'), 'somebody else\'s shared rule');
    stateWithPlacedRules({ 'my-rule': 'rules/fe-know/my-rule.md' });

    await fse.writeFile(path.join(homeDir, '.claude/rules/my-rule.md'), 'edited locally');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-rule');
    expect(item?.relativePath).toBe('rules/fe-know/my-rule.md');
    expect(item?.namespace).toBe('fe-know');
  });

  it('treats a root-level rule as new again once its recorded team file is gone', async () => {
    // The rule was removed from the team repo (or its namespace renamed): the
    // record no longer points at anything and must not invent a destination.
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'other-ns'));
    await fse.writeFile(path.join(teamRulesDir, 'other-ns/my-rule.md'), 'team content');
    stateWithPlacedRules({ 'my-rule': 'rules/fe-know/my-rule.md' });

    await fse.writeFile(path.join(homeDir, '.claude/rules/my-rule.md'), 'local');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'my-rule');
    expect(item?.status).toBe('new');
    expect(item?.relativePath).toBe('rules/my-rule.md');
  });

  it('reports a subdirectory rule name as its namespace', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.ensureDir(path.join(teamRulesDir, 'common'));
    await fse.writeFile(path.join(teamRulesDir, 'common/coding-standards.md'), 'team');

    await fse.ensureDir(path.join(homeDir, '.claude/rules/common'));
    await fse.writeFile(path.join(homeDir, '.claude/rules/common/coding-standards.md'), 'edited');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'common/coding-standards');
    expect(item?.namespace).toBe('common');
  });

  it('leaves the namespace unset for a rule at the shared root', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/rules/shared.md'), 'everyone');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'shared');
    expect(item?.relativePath).toBe('rules/shared.md');
    expect(item?.namespace).toBeUndefined();
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

  /**
   * A rule published into a namespace keeps the author's copy at the rules
   * ROOT under its bare name, while the desired set holds `<ns>/<name>` — or
   * nothing at all when the namespace is not active here. Sweeping by name
   * alone therefore deleted the author's own file, local edits included
   * (#649 review).
   */
  it("spares the author's root copy of a rule published into a namespace", async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.outputFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'team content');
    await fse.writeFile(path.join(teamRulesDir, 'other.md'), 'other');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'my-rule.md'), 'my local edits');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules: { 'my-rule': 'rules/fe-know/my-rule.md' },
    } as State);

    await handler.pullAllRules(teamConfig, localConfig, [
      { name: 'other', type: 'rules', sourcePath: path.join(teamRulesDir, 'other.md'), relativePath: 'rules/other.md', status: 'new' },
    ]);

    expect(await fse.readFile(path.join(localRulesDir, 'my-rule.md'), 'utf-8'))
      .toBe('my local edits');
  });

  /**
   * When that namespace IS active here, the team file is delivered — and it
   * used to land at `<tool>/rules/<ns>/<name>` beside the author's root copy,
   * so a tool that loads rules recursively applied both, and they disagreed as
   * soon as the team file moved on. The record names the root copy as this
   * rule's local file, so delivery updates it and takes the duplicate with it
   * (#649 review).
   */
  it("delivers a rule this machine placed onto the author's root copy, not beside it", async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.outputFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'team content');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'my-rule.md'), 'stale root copy');
    await fse.outputFile(path.join(localRulesDir, 'fe-know/my-rule.md'), 'duplicate from an earlier pull');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules: { 'my-rule': 'rules/fe-know/my-rule.md' },
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(localRulesDir, 'my-rule.md'), 'utf-8')).toBe('team content');
    expect(await fse.pathExists(path.join(localRulesDir, 'fe-know/my-rule.md'))).toBe(false);
  });

  it('does not redirect a placed rule onto a root path a shared-root rule of the same name owns', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.outputFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'the author\'s namespaced rule');
    await fse.writeFile(path.join(teamRulesDir, 'my-rule.md'), 'an unrelated rule for everyone');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules: { 'my-rule': 'rules/fe-know/my-rule.md' },
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    // Both would otherwise land on my-rule.md, in whichever order the loop
    // ran; the shared-root rule owns that path and the namespaced one keeps its own.
    expect(await fse.readFile(path.join(localRulesDir, 'my-rule.md'), 'utf-8')).toBe('an unrelated rule for everyone');
    expect(await fse.readFile(path.join(localRulesDir, 'fe-know/my-rule.md'), 'utf-8')).toBe('the author\'s namespaced rule');
  });

  it('delivers a namespaced rule another member placed to its namespace directory', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.outputFile(path.join(teamRulesDir, 'fe-know/my-rule.md'), 'team content');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    // A record for a DIFFERENT namespace is not this rule's.
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules: { 'my-rule': 'rules/be-know/my-rule.md' },
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(localRulesDir, 'fe-know/my-rule.md'), 'utf-8')).toBe('team content');
    expect(await fse.pathExists(path.join(localRulesDir, 'my-rule.md'))).toBe(false);
  });

  it("spares the author's root copy while its placement is still awaiting review", async () => {
    // Pushed, not merged: no team file, no record yet. The pending entry is
    // what says this copy is ours.
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'other.md'), 'other');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'my-rule.md'), 'awaiting review');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null, placedRules: {},
      pendingPushes: [{
        branch: 'teamai/push/me/1', prUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know', placed: true }],
      }],
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(localRulesDir, 'my-rule.md'), 'utf-8')).toBe('awaiting review');
  });

  it("spares the author's root copy while its PR is pending, even once the placement mark is spent", async () => {
    // Reconcile spends the mark on a placement it cannot prove (no blob, or
    // the path arrived with other content), while the PR may still be open:
    // the copy is still the author's work (#649 review).
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'other.md'), 'other');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'my-rule.md'), 'awaiting review');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], lastUpdateCheck: null, availableUpdate: null, placedRules: {},
      pendingPushes: [{
        branch: 'teamai/push/me/1', prUrl: null, createdAt: '2026-01-01T00:00:00.000Z',
        items: [{ type: 'rules', name: 'my-rule', relativePath: 'rules/fe-know/my-rule.md', namespace: 'fe-know', placed: false }],
      }],
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.readFile(path.join(localRulesDir, 'my-rule.md'), 'utf-8')).toBe('awaiting review');
  });

  it('still sweeps a root rule whose record points at a file that is gone', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'other.md'), 'other');
    const localRulesDir = path.join(homeDir, '.claude/rules');
    await fse.writeFile(path.join(localRulesDir, 'my-rule.md'), 'orphaned');
    vi.mocked(loadStateForScope).mockResolvedValue({
      lastPush: null, lastPull: null, lastPullRev: null, pushedRules: [], pushedSkills: [],
      pushedEnvVars: [], pendingPushes: [], lastUpdateCheck: null, availableUpdate: null,
      placedRules: { 'my-rule': 'rules/fe-know/my-rule.md' },
    } as State);

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(localRulesDir, 'my-rule.md'))).toBe(false);
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

describe('RulesHandler.pullAllRules — OpenCode instructions activation', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-oc-'));
    homeDir = path.join(tmpDir, 'home');
    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));
    // OpenCode installed at user scope: ~/.config/opencode present.
    await fse.ensureDir(path.join(homeDir, '.config', 'opencode', 'skills'));
    vi.stubEnv('HOME', homeDir);

    handler = new RulesHandler();
    teamConfig = {
      team: 'test', description: '', repo: 'r', provider: 'tgit' as const, reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        opencode: {
          skills: '.opencode/skills', rules: '.opencode/rules', agents: '.opencode/agents',
          mcp: '.config/opencode/opencode.json', mcpProject: 'opencode.json',
          userScope: { skills: '.config/opencode/skills', rules: '.config/opencode/rules', agents: '.config/opencode/agents' },
        },
      },
    } as unknown as TeamaiConfig;

    localConfig = {
      repo: { localPath: repoPath, remote: 'r' },
      username: 'u', additionalRoles: [], scope: 'user',
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  const ocConfig = () => path.join(homeDir, '.config', 'opencode', 'opencode.json');
  const ocRules = () => path.join(homeDir, '.config', 'opencode', 'rules');

  it('copies rule files to ~/.config/opencode/rules and adds the instructions glob', async () => {
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'team-rule.md'), 'team content');

    await handler.pullAllRules(teamConfig, localConfig);

    // File landed under the user-scope OpenCode rules dir.
    expect(await fse.pathExists(path.join(ocRules(), 'team-rule.md'))).toBe(true);
    // opencode.json now references the teamai glob (user scope → 'rules/*.md').
    const doc = await fse.readJson(ocConfig());
    expect(doc.instructions).toContain('rules/*.md');
  });

  it('removes the instructions glob when the team has no rules left', async () => {
    // First: one rule → glob present.
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'r.md'), 'x');
    await handler.pullAllRules(teamConfig, localConfig);
    expect((await fse.readJson(ocConfig())).instructions).toContain('rules/*.md');

    // Then: remove the team rule and re-pull → glob gone.
    await fse.remove(path.join(localConfig.repo.localPath, 'rules', 'r.md'));
    await handler.pullAllRules(teamConfig, localConfig);
    const doc = await fse.readJson(ocConfig());
    expect(doc.instructions ?? []).not.toContain('rules/*.md');
  });

  it('does not create opencode.json when OpenCode is not installed', async () => {
    // Remove the install marker.
    await fse.remove(path.join(homeDir, '.config', 'opencode'));
    await fse.writeFile(path.join(localConfig.repo.localPath, 'rules', 'team-rule.md'), 'content');

    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.pathExists(ocConfig())).toBe(false);
  });
});

describe('RulesHandler — Cursor-compatible .mdc handling', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-cursor-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));
    // Both tools installed so pull targets both dirs.
    await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.cursor', 'rules'));
    await fse.ensureDir(path.join(homeDir, '.joycode', 'rules'));

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
        cursor: { skills: '.cursor/skills', rules: '.cursor/rules', settings: '.cursor/hooks.json' },
        joycode: { skills: '.joycode/skills', rules: '.joycode/rules' },
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

  it('pull writes .mdc (not .md) with derived frontmatter for Cursor and JoyCode', async () => {
    await fse.writeFile(
      path.join(repoPath, 'rules', 'ts-style.md'),
      '---\npaths:\n  - "**/*.ts"\n---\n\nUse named exports.',
    );

    await handler.pullAllRules(teamConfig, localConfig);

    const mdcPath = path.join(homeDir, '.cursor/rules/ts-style.mdc');
    expect(await fse.pathExists(mdcPath)).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/ts-style.md'))).toBe(false);
    const content = await fse.readFile(mdcPath, 'utf-8');
    expect(content).toContain('globs: "**/*.ts"');
    expect(content).toContain('alwaysApply: false');
    const joycodeMdcPath = path.join(homeDir, '.joycode/rules/ts-style.mdc');
    expect(await fse.pathExists(joycodeMdcPath)).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.joycode/rules/ts-style.md'))).toBe(false);
    expect(await fse.readFile(joycodeMdcPath, 'utf-8')).toBe(content);
    // claude still gets a plain .md copy
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/ts-style.md'))).toBe(true);
  });

  it('a clean pull does not make cursor rules look modified on push', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'enforced.md'), 'A mandatory rule.');
    await handler.pullAllRules(teamConfig, localConfig);

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'enforced')).toBeUndefined();
  });

  it.each(['user', 'project'] as const)('preserves unrelated JoyCode rules across repeated %s-scope pulls', async (scope) => {
    localConfig.scope = scope;
    if (scope === 'project') localConfig.projectRoot = homeDir;
    await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
    const personalFiles = ['personal.mdc', 'notes.md', 'nested/private.mdc', 'nested/notes.md'];
    for (const file of personalFiles) {
      await fse.outputFile(path.join(homeDir, '.joycode/rules', file), `Personal content: ${file}`);
    }

    await handler.pullAllRules(teamConfig, localConfig);
    await handler.pullAllRules(teamConfig, localConfig);

    for (const file of personalFiles) {
      expect(await fse.readFile(path.join(homeDir, '.joycode/rules', file), 'utf-8'))
        .toBe(`Personal content: ${file}`);
    }
    expect(await fse.readFile(path.join(homeDir, '.joycode/rules/team.mdc'), 'utf-8'))
      .toContain('Team rule.');
  });

  it.each(['user', 'project'] as const)('cleans only explicitly removed JoyCode rules in %s scope', async (scope) => {
    localConfig.scope = scope;
    if (scope === 'project') localConfig.projectRoot = homeDir;
    await fse.writeFile(path.join(repoPath, 'rules', 'keep.md'), 'Current team rule.');
    await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'nested/removed\n');
    for (const ext of ['.mdc', '.md']) {
      await fse.outputFile(path.join(homeDir, '.joycode/rules/nested', `removed${ext}`), 'Former team rule.');
    }
    const personalPath = path.join(homeDir, '.joycode/rules/nested/personal.mdc');
    await fse.outputFile(personalPath, 'Personal rule.');

    await handler.pullAllRules(teamConfig, localConfig);

    for (const ext of ['.mdc', '.md']) {
      expect(await fse.pathExists(path.join(homeDir, '.joycode/rules/nested', `removed${ext}`))).toBe(false);
    }
    expect(await fse.readFile(personalPath, 'utf-8')).toBe('Personal rule.');
    expect(await fse.pathExists(path.join(homeDir, '.joycode/rules/keep.mdc'))).toBe(true);
  });

  it('detects a genuine edit to a cursor .mdc body as modified', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'edit-me.md'), 'Original body.');
    await handler.pullAllRules(teamConfig, localConfig);

    // User edits the body of the .mdc directly.
    const mdcPath = path.join(homeDir, '.cursor/rules/edit-me.mdc');
    await fse.writeFile(mdcPath, '---\nalwaysApply: true\n---\n\nEdited body.');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const item = items.find((i) => i.name === 'edit-me');
    expect(item).toBeDefined();
    expect(item!.status).toBe('modified');
    expect(item!.sourcePath).toBe(mdcPath);
  });

  it('pushItem strips cursor frontmatter when writing an .mdc back to team repo', async () => {
    const mdcPath = path.join(homeDir, '.cursor/rules/back.mdc');
    await fse.writeFile(mdcPath, '---\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\nBody to push.');

    await handler.pushItem(
      { name: 'back', type: 'rules', sourcePath: mdcPath, relativePath: 'rules/back.md' },
      teamConfig,
      localConfig,
    );

    const teamContent = await fse.readFile(path.join(repoPath, 'rules', 'back.md'), 'utf-8');
    expect(teamContent).toBe('Body to push.\n');
    expect(teamContent).not.toContain('globs');
  });

  it('pushItem preserves a namespaced rule destination', async () => {
    const sourcePath = path.join(homeDir, '.claude/rules/scoped.md');
    await fse.ensureDir(path.dirname(sourcePath));
    await fse.writeFile(sourcePath, 'Scoped rule body.');

    await handler.pushItem(
      { name: 'scoped', type: 'rules', sourcePath, relativePath: 'rules/frontend/scoped.md' },
      teamConfig,
      localConfig,
    );

    expect(await fse.readFile(path.join(repoPath, 'rules/frontend/scoped.md'), 'utf-8')).toBe('Scoped rule body.');
    expect(await fse.pathExists(path.join(repoPath, 'rules/scoped.md'))).toBe(false);
  });

  it('pushItem preserves the team rule `paths:` frontmatter when pushing from cursor', async () => {
    // The team rule is scoped; only its body may cross back from Cursor.
    await fse.writeFile(
      path.join(repoPath, 'rules', 'scoped.md'),
      '---\npaths:\n  - "**/*.ts"\n---\n\nOriginal body.',
    );
    await handler.pullAllRules(teamConfig, localConfig);

    const mdcPath = path.join(homeDir, '.cursor/rules/scoped.mdc');
    await fse.writeFile(mdcPath, '---\nglobs: "**/*.ts"\nalwaysApply: false\n---\n\nEdited body.');

    await handler.pushItem(
      { name: 'scoped', type: 'rules', sourcePath: mdcPath, relativePath: 'rules/scoped.md' },
      teamConfig,
      localConfig,
    );

    const teamContent = await fse.readFile(path.join(repoPath, 'rules', 'scoped.md'), 'utf-8');
    expect(teamContent).toContain('paths:');
    expect(teamContent).toContain('- "**/*.ts"');
    expect(teamContent).toContain('Edited body.');
    expect(teamContent).not.toContain('Original body.');
    // Cursor's own derived frontmatter must not leak upstream.
    expect(teamContent).not.toContain('alwaysApply');

    // And the scope survives the next pull.
    await handler.pullAllRules(teamConfig, localConfig);
    const mdc = await fse.readFile(mdcPath, 'utf-8');
    expect(mdc).toContain('globs: "**/*.ts"');
    expect(mdc).toContain('alwaysApply: false');
  });

  it('pushItem fails loudly instead of blanking the team rule on an unreadable source', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'keepme.md'), 'Precious team content.');
    const missing = path.join(homeDir, '.cursor/rules/keepme.mdc');

    await expect(
      handler.pushItem(
        { name: 'keepme', type: 'rules', sourcePath: missing, relativePath: 'rules/keepme.md' },
        teamConfig,
        localConfig,
      ),
    ).rejects.toThrow(/Cannot read rule source/);

    const teamContent = await fse.readFile(path.join(repoPath, 'rules', 'keepme.md'), 'utf-8');
    expect(teamContent).toBe('Precious team content.');
  });

  it('does not offer a user-authored cursor .mdc as a new team rule', async () => {
    // `.cursor/rules/` is where Cursor's own "New Cursor Rule" writes personal
    // rules — they must never be proposed as team resources.
    await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
    await handler.pullAllRules(teamConfig, localConfig);
    await fse.writeFile(
      path.join(homeDir, '.cursor/rules/my-personal-rule.mdc'),
      '---\nalwaysApply: true\n---\n\nMy private notes.',
    );

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    expect(items.find((i) => i.name === 'my-personal-rule')).toBeUndefined();
  });

  it('pull removes the legacy .md copy an older layout left in the cursor dir', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'legacy.md'), 'Legacy rule body.');
    // Simulate the pre-.mdc layout.
    await fse.writeFile(path.join(homeDir, '.cursor/rules/legacy.md'), 'Legacy rule body.');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/legacy.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/legacy.mdc'))).toBe(true);
  });

  it('removeItem deletes a legacy .md cursor copy as well as the .mdc', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'both.md'), 'bye');
    await handler.pullAllRules(teamConfig, localConfig);
    // Re-create the legacy copy to prove `remove` sweeps both extensions.
    await fse.writeFile(path.join(homeDir, '.cursor/rules/both.md'), 'bye');

    await handler.removeItem('both', teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/both.mdc'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/both.md'))).toBe(false);
  });

  it('sweeps a legacy .md whose rule the team has since deleted', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
    // `dropped` is no longer in the team repo, but its pre-.mdc copy lingers.
    await fse.writeFile(path.join(homeDir, '.cursor/rules/dropped.md'), 'gone upstream');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/dropped.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/team.mdc'))).toBe(true);
  });

  it('sweeps a legacy .md copy of the built-in recall rule from the cursor dir', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
    // Built-ins now deploy to Cursor as `.mdc`, so the `.md` must not survive.
    await fse.writeFile(path.join(homeDir, '.cursor/rules/teamai-recall.md'), '# Recall');
    await fse.writeFile(path.join(homeDir, '.claude/rules/teamai-recall.md'), '# Recall');

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/teamai-recall.md'))).toBe(false);
    // The built-in copy in a `.md` tool's dir is still managed by the CLI.
    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/teamai-recall.md'))).toBe(true);
  });

  it('stale cleanup removes an orphaned cursor .mdc not in team repo', async () => {
    // Team has one rule; cursor dir has an extra orphan .mdc.
    await fse.writeFile(path.join(repoPath, 'rules', 'keep.md'), 'keep me');
    await fse.writeFile(
      path.join(homeDir, '.cursor/rules/orphan.mdc'),
      '---\nalwaysApply: true\n---\n\norphan',
    );

    await handler.pullAllRules(teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/orphan.mdc'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/keep.mdc'))).toBe(true);
  });

  it('removeItem deletes the cursor .mdc copy', async () => {
    await fse.writeFile(path.join(repoPath, 'rules', 'gone.md'), 'bye');
    await handler.pullAllRules(teamConfig, localConfig);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/gone.mdc'))).toBe(true);

    await handler.removeItem('gone', teamConfig, localConfig);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/gone.mdc'))).toBe(false);
  });
});
