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

vi.mock('../utils/gf-cli.js', () => ({
  gfMrCreate: vi.fn().mockReturnValue('https://git.woa.com/mr/1'),
}));

vi.mock('../utils/repo-url.js', () => ({
  parseRepoInput: vi.fn().mockReturnValue({ owner: 'test', repo: 'repo', projectId: 'test%2Frepo' }),
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
      sharing: { skills: { syncTargets: [] }, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should detect a modified local rule as pushable', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'shared-rule.md'), 'old content');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'shared-rule.md'), 'new content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).toContain('shared-rule');
  });

  it('should NOT include an unchanged rule', async () => {
    const teamRulesDir = path.join(localConfig.repo.localPath, 'rules');
    await fse.writeFile(path.join(teamRulesDir, 'same-rule.md'), 'same content');
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'same-rule.md'), 'same content');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).not.toContain('same-rule');
  });

  it('should still detect new rules that are not in the team repo', async () => {
    await fse.writeFile(path.join(homeDir, '.claude/rules', 'brand-new.md'), 'new rule');

    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    const names = items.map((i) => i.name);
    expect(names).toContain('brand-new');
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
});
