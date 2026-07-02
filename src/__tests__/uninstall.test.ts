import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// ─── Mocks ─────────────────────────────────────────────

const mockAutoDetectInit = vi.fn();

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
}));

const mockReconcileHooks = vi.fn();

vi.mock('../hooks.js', () => ({
  reconcileHooks: (...args: unknown[]) => mockReconcileHooks(...args),
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

import { uninstall } from '../uninstall.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

// ─── Helpers ───────────────────────────────────────────

const TEAMAI_RULES_START = '<!-- [teamai:rules:start] -->';
const TEAMAI_RULES_END = '<!-- [teamai:rules:end] -->';
const TEAMAI_CULTURE_START = '<!-- [teamai:culture:start] -->';
const TEAMAI_CULTURE_END = '<!-- [teamai:culture:end] -->';
const TEAMAI_CLAUDEMD_START = '<!-- [teamai:claudemd:start] -->';
const TEAMAI_CLAUDEMD_END = '<!-- [teamai:claudemd:end] -->';
const TEAMAI_RECALL_RULES_START = '<!-- [teamai:recall-rules:start] -->';
const TEAMAI_RECALL_RULES_END = '<!-- [teamai:recall-rules:end] -->';
const TEAMAI_ENV_START = '# [teamai:env:start]';
const TEAMAI_ENV_END = '# [teamai:env:end]';

function makeTeamConfig(overrides?: Partial<TeamaiConfig>): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://git.woa.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '~/.teamai/docs' },
      env: { injectShellProfile: true },
    },
    toolPaths: {
      claude: {
        skills: '.claude/skills',
        rules: '.claude/rules',
        settings: '.claude/settings.json',
        claudemd: '.claude/CLAUDE.md',
      },
    },
    ...overrides,
  };
}

function makeLocalConfig(homeDir: string, repoPath: string, overrides?: Partial<LocalConfig>): LocalConfig {
  return {
    repo: { localPath: repoPath, remote: 'https://git.woa.com/test/repo.git' },
    username: 'testuser',
    updatePolicy: 'auto',
    scope: 'user',
    additionalRoles: [],
    ...overrides,
  };
}

async function setupFixture(tmpDir: string) {
  const homeDir = path.join(tmpDir, 'home');
  const repoPath = path.join(tmpDir, 'team-repo');
  const teamaiHome = path.join(homeDir, '.teamai');

  // Team repo: skills
  await fse.ensureDir(path.join(repoPath, 'skills', 'team-skill'));
  await fse.writeFile(path.join(repoPath, 'skills', 'team-skill', 'SKILL.md'), '# Team Skill');

  // Team repo: rules
  await fse.ensureDir(path.join(repoPath, 'rules'));
  await fse.writeFile(path.join(repoPath, 'rules', 'team-rule.md'), '# Team Rule');

  // Tool dirs: synced skill + user skill
  await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'team-skill'));
  await fse.writeFile(path.join(homeDir, '.claude', 'skills', 'team-skill', 'SKILL.md'), '# Team Skill');
  await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'my-own-skill'));
  await fse.writeFile(path.join(homeDir, '.claude', 'skills', 'my-own-skill', 'SKILL.md'), '# My Skill');

  // Tool dirs: synced rule
  await fse.ensureDir(path.join(homeDir, '.claude', 'rules'));
  await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'team-rule.md'), '# Team Rule');

  // Settings.json with hooks
  await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
    hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'teamai pull' }], description: '[teamai] Auto-pull' }] },
  });

  // CLAUDE.md with all teamai section blocks + user content
  const claudeMd = [
    '# My custom instructions',
    '',
    TEAMAI_RULES_START,
    '<!-- DO NOT EDIT -->',
    '## Team Rules (teamai)',
    TEAMAI_RULES_END,
    '',
    TEAMAI_CULTURE_START,
    '## Team Culture',
    'We value collaboration.',
    TEAMAI_CULTURE_END,
    '',
    TEAMAI_CLAUDEMD_START,
    '## Shared Instructions',
    'Always use TypeScript.',
    TEAMAI_CLAUDEMD_END,
    '',
    TEAMAI_RECALL_RULES_START,
    '## Recall Rules',
    'Use teamai-recall subagent.',
    TEAMAI_RECALL_RULES_END,
    '',
  ].join('\n');
  await fse.writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), claudeMd);

  // Shell profile with env block
  const zshrc = [
    '# My zshrc config',
    'export PATH=$HOME/bin:$PATH',
    '',
    TEAMAI_ENV_START,
    '# DO NOT EDIT',
    '[ -f ~/.teamai/env.sh ] && source ~/.teamai/env.sh',
    TEAMAI_ENV_END,
    '',
    '# More user config',
  ].join('\n');
  await fse.writeFile(path.join(homeDir, '.zshrc'), zshrc);

  // ~/.teamai/ directory
  await fse.ensureDir(path.join(teamaiHome, 'docs'));
  await fse.writeFile(path.join(teamaiHome, 'docs', 'guide.md'), '# Guide');
  await fse.writeFile(path.join(teamaiHome, 'config.yaml'), 'repo: test');
  await fse.writeFile(path.join(teamaiHome, 'state.json'), '{}');
  await fse.writeFile(path.join(teamaiHome, 'usage.jsonl'), '');

  return { homeDir, repoPath, teamaiHome };
}

// ─── Tests ─────────────────────────────────────────────

describe('uninstall', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-uninstall-test-'));
    mockAutoDetectInit.mockReset();
    mockReconcileHooks.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('完整卸载移除所有资源', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig({
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: `${teamaiHome}/docs` },
        env: { injectShellProfile: true },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // hooks: reconcileHooks(removeAll) was called for the tool settings file,
    // with the managed-hooks manifest so team (B) hooks are cleaned up too.
    expect(mockReconcileHooks).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'settings.json'),
      'claude',
      [],
      expect.objectContaining({ removeAll: true, manifestPath: expect.stringContaining('managed-hooks.json') }),
    );

    // CLAUDE.md: teamai block removed, user content preserved
    const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# My custom instructions');
    expect(claudeMd).not.toContain(TEAMAI_RULES_START);

    // Synced skill removed, user skill preserved
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'my-own-skill'))).toBe(true);

    // Synced rule removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'team-rule.md'))).toBe(false);

    // Shell profile: env block removed, user content preserved
    const zshrc = await fse.readFile(path.join(homeDir, '.zshrc'), 'utf-8');
    expect(zshrc).toContain('export PATH=$HOME/bin:$PATH');
    expect(zshrc).toContain('# More user config');
    expect(zshrc).not.toContain(TEAMAI_ENV_START);

    // ~/.teamai/ removed
    expect(await fse.pathExists(teamaiHome)).toBe(false);
  });

  it('移除 OpenClaw 系 agent 的 HOOK.md 目录（无 settings 路径）', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Simulate an installed OpenClaw-family agent with teamai HOOK.md injected.
    const ocHookDir = path.join(homeDir, '.openclaw', 'hooks', 'teamai-status-report');
    await fse.ensureDir(ocHookDir);
    await fse.writeFile(path.join(ocHookDir, 'HOOK.md'), '---\nname: [teamai] status-report\n---\n');
    await fse.writeFile(path.join(ocHookDir, 'handler.ts'), '// teamai');

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules', settings: '.claude/settings.json', claudemd: '.claude/CLAUDE.md' },
        openclaw: { skills: '.openclaw/skills', rules: '.openclaw/rules' }, // no settings → OpenClaw HOOK.md path
      },
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: `${teamaiHome}/docs` },
        env: { injectShellProfile: true },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // The OpenClaw HOOK.md dir must be removed (regression: previously leaked).
    expect(await fse.pathExists(ocHookDir)).toBe(false);
  });

  it('保留用户自建的 skills', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // User's own skill must survive
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'my-own-skill', 'SKILL.md'))).toBe(true);
  });

  it('保留 CLAUDE.md 中非 teamai 的内容', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# My custom instructions');
    expect(claudeMd).not.toContain(TEAMAI_RULES_START);
    expect(claudeMd).not.toContain(TEAMAI_CULTURE_START);
    expect(claudeMd).not.toContain(TEAMAI_CLAUDEMD_START);
    expect(claudeMd).not.toContain(TEAMAI_RECALL_RULES_START);
  });

  it('shell profile 环境变量块被清理', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    const zshrc = await fse.readFile(path.join(homeDir, '.zshrc'), 'utf-8');
    expect(zshrc).not.toContain(TEAMAI_ENV_START);
    expect(zshrc).not.toContain(TEAMAI_ENV_END);
    expect(zshrc).not.toContain('env.sh');
    expect(zshrc).toContain('export PATH');
  });

  it('dry-run 不做任何更改', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ dryRun: true, force: true });

    // Nothing should be changed
    expect(mockReconcileHooks).not.toHaveBeenCalled();
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(true);
    expect(await fse.pathExists(teamaiHome)).toBe(true);

    const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain(TEAMAI_RULES_START);
  });

  it('什么都不存在时正常退出', async () => {
    const homeDir = path.join(tmpDir, 'empty-home');
    const repoPath = path.join(tmpDir, 'empty-repo');
    await fse.ensureDir(repoPath);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/bash');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    // Should not throw
    await expect(uninstall({ force: true })).resolves.not.toThrow();
  });

  it('配置加载失败时仍然移除 ~/.teamai/', async () => {
    const homeDir = path.join(tmpDir, 'broken-home');
    const teamaiHome = path.join(homeDir, '.teamai');
    await fse.ensureDir(teamaiHome);
    await fse.writeFile(path.join(teamaiHome, 'config.yaml'), 'broken');
    vi.stubEnv('HOME', homeDir);

    mockAutoDetectInit.mockRejectedValue(new Error('Config not found'));

    await uninstall({ force: true });

    expect(await fse.pathExists(teamaiHome)).toBe(false);
  });

  it('project scope 定位正确目录', async () => {
    const projectRoot = path.join(tmpDir, 'my-project');
    const repoPath = path.join(projectRoot, '.teamai', 'team-repo');
    const teamaiHome = path.join(projectRoot, '.teamai');

    // Team repo
    await fse.ensureDir(path.join(repoPath, 'skills', 'proj-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'proj-skill', 'SKILL.md'), '# Proj Skill');

    // Tool dirs at project root
    await fse.ensureDir(path.join(projectRoot, '.claude', 'skills', 'proj-skill'));
    await fse.writeFile(path.join(projectRoot, '.claude', 'skills', 'proj-skill', 'SKILL.md'), '# Proj Skill');

    // .teamai/ at project root
    await fse.writeFile(path.join(teamaiHome, 'config.yaml'), 'scope: project');

    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    vi.stubEnv('SHELL', '/bin/bash');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(projectRoot, repoPath, {
      scope: 'project',
      projectRoot,
    });
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // Project-scope skill removed
    expect(await fse.pathExists(path.join(projectRoot, '.claude', 'skills', 'proj-skill'))).toBe(false);
    // Project .teamai/ removed
    expect(await fse.pathExists(teamaiHome)).toBe(false);
  });

  it('命名空间 skills 正确处理', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Add a namespaced skill in team repo (namespace dir has no SKILL.md)
    await fse.ensureDir(path.join(repoPath, 'skills', 'backend'));
    await fse.ensureDir(path.join(repoPath, 'skills', 'backend', 'ns-skill'));
    await fse.writeFile(path.join(repoPath, 'skills', 'backend', 'ns-skill', 'SKILL.md'), '# NS Skill');

    // Synced to tool dir
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'ns-skill'));
    await fse.writeFile(path.join(homeDir, '.claude', 'skills', 'ns-skill', 'SKILL.md'), '# NS Skill');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // Both flat and namespaced team skills removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'ns-skill'))).toBe(false);
    // User skill preserved
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'my-own-skill'))).toBe(true);
  });

  it('清理 CLAUDE.md 中所有 teamai section（culture/claudemd/recall-rules）', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    const claudeMd = await fse.readFile(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('# My custom instructions');
    expect(claudeMd).not.toContain(TEAMAI_RULES_START);
    expect(claudeMd).not.toContain(TEAMAI_RULES_END);
    expect(claudeMd).not.toContain(TEAMAI_CULTURE_START);
    expect(claudeMd).not.toContain(TEAMAI_CULTURE_END);
    expect(claudeMd).not.toContain(TEAMAI_CLAUDEMD_START);
    expect(claudeMd).not.toContain(TEAMAI_CLAUDEMD_END);
    expect(claudeMd).not.toContain(TEAMAI_RECALL_RULES_START);
    expect(claudeMd).not.toContain(TEAMAI_RECALL_RULES_END);
    expect(claudeMd).not.toContain('Team Culture');
    expect(claudeMd).not.toContain('Shared Instructions');
    expect(claudeMd).not.toContain('Recall Rules');
  });

  it('多工具场景：清理 codebuddy 和 claude-internal 的 CLAUDE.md', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Setup codebuddy CODEBUDDY.md with teamai sections
    const codebuddyMd = [
      '# CodeBuddy Config',
      '',
      TEAMAI_RULES_START,
      '## Team Rules',
      TEAMAI_RULES_END,
      '',
      TEAMAI_RECALL_RULES_START,
      '## Recall Rules',
      'Use recall subagent.',
      TEAMAI_RECALL_RULES_END,
      '',
    ].join('\n');
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));
    await fse.writeFile(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), codebuddyMd);

    // Setup claude-internal CLAUDE.md with teamai sections
    const claudeInternalMd = [
      '# Internal Config',
      '',
      TEAMAI_CULTURE_START,
      '## Culture',
      'Be excellent.',
      TEAMAI_CULTURE_END,
      '',
      TEAMAI_CLAUDEMD_START,
      '## Shared',
      'Use TypeScript.',
      TEAMAI_CLAUDEMD_END,
      '',
    ].join('\n');
    await fse.ensureDir(path.join(homeDir, '.claude-internal'));
    await fse.writeFile(path.join(homeDir, '.claude-internal', 'CLAUDE.md'), claudeInternalMd);

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
        },
        codebuddy: {
          skills: '.codebuddy/skills',
          rules: '.codebuddy/rules',
          settings: '.codebuddy/settings.json',
          claudemd: '.codebuddy/CODEBUDDY.md',
        },
        'claude-internal': {
          skills: '.claude-internal/skills',
          rules: '.claude-internal/rules',
          settings: '.claude-internal/settings.json',
          claudemd: '.claude-internal/CLAUDE.md',
        },
      },
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: `${path.join(homeDir, '.teamai')}/docs` },
        env: { injectShellProfile: true },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // codebuddy: user content preserved, teamai sections removed
    const codebuddyResult = await fse.readFile(path.join(homeDir, '.codebuddy', 'CODEBUDDY.md'), 'utf-8');
    expect(codebuddyResult).toContain('# CodeBuddy Config');
    expect(codebuddyResult).not.toContain(TEAMAI_RULES_START);
    expect(codebuddyResult).not.toContain(TEAMAI_RECALL_RULES_START);

    // claude-internal: user content preserved, teamai sections removed
    const internalResult = await fse.readFile(path.join(homeDir, '.claude-internal', 'CLAUDE.md'), 'utf-8');
    expect(internalResult).toContain('# Internal Config');
    expect(internalResult).not.toContain(TEAMAI_CULTURE_START);
    expect(internalResult).not.toContain(TEAMAI_CLAUDEMD_START);
  });

  it('仅含 teamai section 的 CLAUDE.md 被整文件删除', async () => {
    const homeDir = path.join(tmpDir, 'only-teamai-home');
    const repoPath = path.join(tmpDir, 'only-teamai-repo');
    await fse.ensureDir(repoPath);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/bash');

    // CLAUDE.md with only teamai content (no user content)
    const onlyTeamaiMd = [
      TEAMAI_CULTURE_START,
      '## Culture',
      TEAMAI_CULTURE_END,
    ].join('\n');
    await fse.ensureDir(path.join(homeDir, '.claude'));
    await fse.writeFile(path.join(homeDir, '.claude', 'CLAUDE.md'), onlyTeamaiMd);

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // File should be deleted entirely when nothing remains
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'CLAUDE.md'))).toBe(false);
  });
});
