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

import { ResourceHandler } from '../resources/base.js';
import { SkillsHandler } from '../resources/skills.js';
import { RulesHandler } from '../resources/rules.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

describe('ResourceHandler.isToolInstalled', () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-install-test-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    vi.stubEnv('HOME', homeDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should return true when tool root directory exists', async () => {
    expect(await ResourceHandler.isToolInstalled('.claude/skills')).toBe(true);
  });

  it('should return false when tool root directory does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.codebuddy/skills')).toBe(false);
  });

  it('should return false for nested path when root does not exist', async () => {
    expect(await ResourceHandler.isToolInstalled('.cursor/skills')).toBe(false);
  });

  it('should return true after tool directory is created', async () => {
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(false);
    await fse.ensureDir(path.join(homeDir, '.codex'));
    expect(await ResourceHandler.isToolInstalled('.codex/skills')).toBe(true);
  });
});

describe('SkillsHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: SkillsHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-skills-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'skills'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new SkillsHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      sharing: {
        skills: { syncTargets: ['claude', 'codebuddy'] },
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
    };

    // Create a skill in the team repo to pull
    const skillDir = path.join(repoPath, 'skills', 'test-skill');
    await fse.ensureDir(skillDir);
    await fse.writeFile(path.join(skillDir, 'SKILL.md'), '# Test Skill');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync skill to installed tool (claude)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (codebuddy)', async () => {
    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    // Now also create .codebuddy
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));

    const item = {
      name: 'test-skill',
      type: 'skills' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'skills', 'test-skill'),
      relativePath: 'skills/test-skill',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/skills/test-skill/SKILL.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy/skills/test-skill/SKILL.md'))).toBe(true);
  });
});

describe('RulesHandler.pullItem — skip uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-rules-pull-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .cursor
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      sharing: {
        skills: { syncTargets: [] },
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        cursor: { skills: '.cursor/skills', rules: '.cursor/rules' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
    };

    // Create a rule in the team repo
    await fse.writeFile(path.join(repoPath, 'rules', 'test-rule.md'), '# Test Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should sync rule to installed tool (claude)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
  });

  it('should NOT create directories for uninstalled tool (cursor)', async () => {
    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.cursor'))).toBe(false);
  });

  it('should sync to both tools when both are installed', async () => {
    await fse.ensureDir(path.join(homeDir, '.cursor'));

    const item = {
      name: 'test-rule',
      type: 'rules' as const,
      sourcePath: path.join(localConfig.repo.localPath, 'rules', 'test-rule.md'),
      relativePath: 'rules/test-rule.md',
    };

    await handler.pullItem(item, teamConfig, localConfig);

    expect(await fse.pathExists(path.join(homeDir, '.claude/rules/test-rule.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.cursor/rules/test-rule.md'))).toBe(true);
  });
});

describe('RulesHandler.pullAllRules — skip CLAUDE.md update for uninstalled tools', () => {
  let tmpDir: string;
  let homeDir: string;
  let handler: RulesHandler;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-claudemd-'));
    homeDir = path.join(tmpDir, 'home');

    const repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'rules'));

    // Only create .claude, NOT .codebuddy
    await fse.ensureDir(path.join(homeDir, '.claude'));

    vi.stubEnv('HOME', homeDir);
    handler = new RulesHandler();

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      sharing: {
        skills: { syncTargets: [] },
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', claudemd: '.claude/CLAUDE.md' },
        codebuddy: { skills: '.codebuddy/skills', rules: '.codebuddy/rules', claudemd: '.codebuddy/CLAUDE.md' },
      },
    };

    localConfig = {
      repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'testuser',
    };

    await fse.writeFile(path.join(repoPath, 'rules', 'my-rule.md'), '# My Rule');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('should update CLAUDE.md for installed tool only', async () => {
    await handler.pullAllRules(teamConfig, localConfig);

    // claude CLAUDE.md should be created/updated
    expect(await fse.pathExists(path.join(homeDir, '.claude/CLAUDE.md'))).toBe(true);
    const content = await fse.readFile(path.join(homeDir, '.claude/CLAUDE.md'), 'utf-8');
    expect(content).toContain('.claude/rules/');

    // codebuddy should not exist at all
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy'))).toBe(false);
  });
});
