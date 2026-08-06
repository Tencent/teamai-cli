import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// ─── Mocks ─────────────────────────────────────────────

const mockAutoDetectInit = vi.fn();
const mockSaveLocalConfig = vi.fn();
const mockSaveLocalConfigForScope = vi.fn();

vi.mock('../config.js', () => ({
  autoDetectInit: (...args: unknown[]) => mockAutoDetectInit(...args),
  saveLocalConfig: (...args: unknown[]) => mockSaveLocalConfig(...args),
  saveLocalConfigForScope: (...args: unknown[]) => mockSaveLocalConfigForScope(...args),
}));

const mockReconcileHooks = vi.fn();

vi.mock('../hooks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks.js')>();
  return { ...actual, reconcileHooks: (...args: unknown[]) => mockReconcileHooks(...args) };
});

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
        agents: '.claude/agents',
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

  // Tool dirs: CLI built-in resources (deployed by the CLI, not the team repo)
  await fse.writeFile(path.join(homeDir, '.claude', 'rules', 'teamai-recall.md'), '# Recall Rule');
  await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
  await fse.writeFile(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'), '# Recall Agent');
  await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings'));
  await fse.writeFile(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings', 'SKILL.md'), '# Share Learnings');
  await fse.ensureDir(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase'));
  await fse.writeFile(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase', 'SKILL.md'), '# Wiki Codebase');

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
    mockSaveLocalConfig.mockReset();
    mockSaveLocalConfigForScope.mockReset();
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

  // Regression: MCP cleanup used to run after ~/.teamai/ was deleted, so the
  // ownership manifest was already gone and removeAll became a no-op.
  it('卸载时移除 teamai 管理的 MCP server，并保留用户自建的', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    await fse.writeJson(path.join(homeDir, '.claude.json'), {
      mcpServers: {
        'team-mcp': { type: 'http', url: 'https://team.example/mcp' },
        'my-own': { command: 'my-server' },
      },
    });
    await fse.writeJson(path.join(teamaiHome, 'managed-mcp.json'), {
      claude: [{ name: 'team-mcp', hash: 'abc' }],
    });

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
          mcp: '.claude.json',
          mcpProject: '.mcp.json',
        },
      },
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: `${teamaiHome}/docs` },
        env: { injectShellProfile: true },
      },
    });
    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(homeDir, repoPath),
      teamConfig,
    });

    await uninstall({ force: true });

    const after = await fse.readJson(path.join(homeDir, '.claude.json'));
    expect(after.mcpServers['team-mcp']).toBeUndefined();
    expect(after.mcpServers['my-own']).toEqual({ command: 'my-server' });
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

  it('uninstall summary lists teamai-managed MCP servers', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    await fse.writeJson(path.join(teamaiHome, 'managed-mcp.json'), {
      claude: [{ name: 'gpu-analysis', hash: 'abc' }],
      cursor: [{ name: 'context7', hash: 'def' }],
    });

    mockAutoDetectInit.mockResolvedValue({
      localConfig: makeLocalConfig(homeDir, repoPath),
      teamConfig: makeTeamConfig({
        toolPaths: {
          claude: {
            skills: '.claude/skills',
            rules: '.claude/rules',
            settings: '.claude/settings.json',
            claudemd: '.claude/CLAUDE.md',
            mcp: '.claude.json',
          },
        },
      }),
    });

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await uninstall({ dryRun: true, force: true });
    spy.mockRestore();

    const summary = lines.join('\n');
    expect(summary).toContain('MCP servers (2):');
    expect(summary).toContain('claude/gpu-analysis');
    expect(summary).toContain('cursor/context7');
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

  it('移除 CLI built-in 资源（recall agent/rule + built-in skills）', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // Built-in recall agent + rule removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'rules', 'teamai-recall.md'))).toBe(false);
    // Built-in skills removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings'))).toBe(false);
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase'))).toBe(false);
    // User's own skill still preserved
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

  it('--agent claude 且只有 claude 一个工具 → 全删含共享', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'claude' });

    // claude team-skill removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
    // ~/.teamai removed (claude was the last tool)
    expect(await fse.pathExists(teamaiHome)).toBe(false);
    // reconcileHooks called with claude + removeAll
    expect(mockReconcileHooks).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'settings.json'),
      'claude',
      [],
      expect.objectContaining({ removeAll: true }),
    );
  });

  it('--agent claude 但 codex 仍有资源 → 保留共享', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Set up codex with a team-skill so discoverToolResources finds resources
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills', 'team-skill'));
    await fse.writeFile(path.join(homeDir, '.codex', 'skills', 'team-skill', 'SKILL.md'), '# Team Skill');

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
          agents: '.claude/agents',
        },
        codex: {
          skills: '.codex/skills',
          rules: '.codex/rules',
        },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'claude' });

    // claude team-skill removed
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
    // ~/.teamai NOT removed (codex still has resources)
    expect(await fse.pathExists(teamaiHome)).toBe(true);
    // codex team-skill still exists
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'team-skill'))).toBe(true);
    // Exclusion persisted so the next pull won't resurrect claude: added to
    // disabledAgents (user scope → saveLocalConfig).
    expect(mockSaveLocalConfig).toHaveBeenCalledTimes(1);
    const savedCfg = mockSaveLocalConfig.mock.calls[0][0] as LocalConfig;
    expect(savedCfg.disabledAgents).toContain('claude');
    // No prior whitelist existed → enabledAgents must stay undefined, NOT collapse
    // to [] (which the hook path reads as "whitelist nothing" and would wrongly
    // stop hook sync for the remaining tools too).
    expect(savedCfg.enabledAgents).toBeUndefined();
  });

  it('--agent 卸载在已有 enabledAgents 白名单时只移除目标工具', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    await fse.ensureDir(path.join(homeDir, '.codex', 'skills', 'team-skill'));
    await fse.writeFile(path.join(homeDir, '.codex', 'skills', 'team-skill', 'SKILL.md'), '# Team Skill');

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
          agents: '.claude/agents',
        },
        codex: { skills: '.codex/skills', rules: '.codex/rules' },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    localConfig.enabledAgents = ['claude', 'codex'];
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'claude' });

    expect(mockSaveLocalConfig).toHaveBeenCalledTimes(1);
    const savedCfg = mockSaveLocalConfig.mock.calls[0][0] as LocalConfig;
    // Existing whitelist is pruned of the target only; codex stays enabled.
    expect(savedCfg.enabledAgents).toEqual(['codex']);
    expect(savedCfg.disabledAgents).toContain('claude');
  });

  it('--agent unknown → 报错不删', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    await uninstall({ force: true, agent: 'nonexistent' });

    // claude team-skill still exists
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(true);
    // ~/.teamai still exists
    expect(await fse.pathExists(teamaiHome)).toBe(true);
    // reconcileHooks not called
    expect(mockReconcileHooks).not.toHaveBeenCalled();
    // Unknown tool sets a non-zero exit code (so scripts/CI see the failure)
    expect(process.exitCode).toBe(2);
    process.exitCode = prevExitCode;
  });

  it('--agent 卸载最后一个工具时移除共享资源（已剥离 hooks 的工具不算占用）', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // claude settings.json has only a non-teamai user hook (simulates hooks already stripped)
    await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    });
    // Remove all teamai resources from claude so it has zero teamai presence
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-skill'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'team-rule.md'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'CLAUDE.md'));

    // codex has one team-skill
    await fse.ensureDir(path.join(homeDir, '.codex', 'skills', 'team-skill'));
    await fse.writeFile(path.join(homeDir, '.codex', 'skills', 'team-skill', 'SKILL.md'), '# Team Skill');

    const teamConfig = makeTeamConfig({
      toolPaths: {
        claude: {
          skills: '.claude/skills',
          rules: '.claude/rules',
          settings: '.claude/settings.json',
          claudemd: '.claude/CLAUDE.md',
          agents: '.claude/agents',
        },
        codex: {
          skills: '.codex/skills',
          rules: '.codex/rules',
        },
      },
    });
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'codex' });

    // codex team-skill removed
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'skills', 'team-skill'))).toBe(false);
    // ~/.teamai removed — claude's settings.json has no teamai hooks, so it doesn't block shared removal
    expect(await fse.pathExists(teamaiHome)).toBe(false);
    // Last-tool uninstall deletes ~/.teamai, so there is no config to persist to.
    expect(mockSaveLocalConfig).not.toHaveBeenCalled();
    expect(mockSaveLocalConfigForScope).not.toHaveBeenCalled();
  });

  it('未检测到配置 + --agent → 返回不删', async () => {
    const homeDir = path.join(tmpDir, 'no-config-home');
    const teamaiHome = path.join(homeDir, '.teamai');
    await fse.ensureDir(teamaiHome);
    vi.stubEnv('HOME', homeDir);

    mockAutoDetectInit.mockRejectedValue(new Error('no config'));

    await uninstall({ force: true, agent: 'claude' });

    // ~/.teamai still exists (minimal uninstall was skipped)
    expect(await fse.pathExists(teamaiHome)).toBe(true);
  });

  it('目标工具无 teamai 资源 → no-op 不删共享', async () => {
    const { homeDir, repoPath, teamaiHome } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Strip all teamai resources from claude so it has zero teamai presence
    await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      hooks: { SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    });
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-skill'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'team-rule.md'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'CLAUDE.md'));

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'claude' });

    // ~/.teamai must still exist — target had no teamai resources
    expect(await fse.pathExists(teamaiHome)).toBe(true);
    expect(mockReconcileHooks).not.toHaveBeenCalled();
  });

  it('hooks 全为空数组时仍纳入清理范围（empty-array residue）', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // Simulate a prior partial uninstall that left hooks cleared to empty arrays.
    await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      hooks: { SessionStart: [], Stop: [], PostToolUse: [] },
    });

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // reconcileHooks must be called — the file was recognised as having teamai residue.
    expect(mockReconcileHooks).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'settings.json'),
      'claude',
      [],
      expect.objectContaining({ removeAll: true }),
    );
  });

  it('settings.json 无 hooks 字段时不纳入清理范围', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // settings.json exists but has no hooks key at all — not a teamai file.
    await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      model: 'claude-opus-4',
    });
    // Also remove all other teamai resources so nothing triggers cleanup.
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-skill'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'teamai-share-learnings'));
    await fse.remove(path.join(homeDir, '.claude', 'skills', 'team-wiki-codebase'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'team-rule.md'));
    await fse.remove(path.join(homeDir, '.claude', 'rules', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'agents', 'teamai-recall.md'));
    await fse.remove(path.join(homeDir, '.claude', 'CLAUDE.md'));

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'claude' });

    // No hooks residue + no teamai resources → reconcileHooks not called.
    expect(mockReconcileHooks).not.toHaveBeenCalled();
  });

  it('hooks 有非空数组（用户自有 hook）时仅由 hasTeamaiHooks 判断是否纳入', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    // User has their own non-teamai hook — isEmptyHooksResidue must return false,
    // but hasTeamaiHooks will still detect the teamai hook that setupFixture added.
    await fse.writeJson(path.join(homeDir, '.claude', 'settings.json'), {
      hooks: {
        SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'teamai pull' }], description: '[teamai] Auto-pull' }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
      },
    });

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true });

    // hasTeamaiHooks detects the teamai hook → reconcileHooks must be called.
    expect(mockReconcileHooks).toHaveBeenCalledWith(
      path.join(homeDir, '.claude', 'settings.json'),
      'claude',
      [],
      expect.objectContaining({ removeAll: true }),
    );
  });

  it('--agent 大小写不敏感', async () => {
    const { homeDir, repoPath } = await setupFixture(tmpDir);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('SHELL', '/bin/zsh');

    const teamConfig = makeTeamConfig();
    const localConfig = makeLocalConfig(homeDir, repoPath);
    mockAutoDetectInit.mockResolvedValue({ localConfig, teamConfig });

    await uninstall({ force: true, agent: 'Claude' });

    // Should have matched 'claude' and removed team-skill
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'skills', 'team-skill'))).toBe(false);
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
