import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { effectiveToolPaths, DEFAULT_TOOL_PATHS, scopedToolPaths } from '../types.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

function buildTeamConfig(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://example.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths,
  } as TeamaiConfig;
}

describe('effectiveToolPaths', () => {
  let tmpDir: string;
  let homeDir: string;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-effective-tp-'));
    homeDir = path.join(tmpDir, 'home');
    await fse.ensureDir(homeDir);
    vi.stubEnv('HOME', homeDir);

    localConfig = {
      repo: { localPath: path.join(tmpDir, 'team-repo'), remote: 'r' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('auto-discovers installed .tclaude with verified paths from DEFAULT_TOOL_PATHS', async () => {
    await fse.ensureDir(path.join(homeDir, '.tclaude'));
    const teamConfig = buildTeamConfig({ claude: DEFAULT_TOOL_PATHS['claude'] });
    const result = await effectiveToolPaths(teamConfig, localConfig);

    expect(result['tclaude']).toBeDefined();
    expect(result['tclaude'].skills).toBe('.tclaude/skills');
    expect(result['tclaude'].rules).toBe('.tclaude/rules');
    expect(result['tclaude'].claudemd).toBe('.tclaude/CLAUDE.md');
    expect(result['tclaude'].agents).toBe('.tclaude/agents');
  });

  it('auto-discovers installed .gemini with skills-only (no DEFAULT_TOOL_PATHS entry)', async () => {
    await fse.ensureDir(path.join(homeDir, '.gemini'));
    const teamConfig = buildTeamConfig({ claude: DEFAULT_TOOL_PATHS['claude'] });
    const result = await effectiveToolPaths(teamConfig, localConfig);

    expect(result['gemini']).toBeDefined();
    expect(result['gemini'].skills).toBe('.gemini/skills');
    // No verified rules/agents/claudemd for gemini — should be absent
    expect(result['gemini'].rules).toBeUndefined();
    expect(result['gemini'].agents).toBeUndefined();
    expect(result['gemini'].claudemd).toBeUndefined();
  });

  it('does not override explicitly configured toolPaths with auto-discovery', async () => {
    await fse.ensureDir(path.join(homeDir, '.claude'));
    const customPaths = { skills: '.claude/custom-skills', rules: '.claude/custom-rules' };
    const teamConfig = buildTeamConfig({ claude: customPaths });
    const result = await effectiveToolPaths(teamConfig, localConfig);

    // Team-configured paths take precedence
    expect(result['claude'].skills).toBe('.claude/custom-skills');
    expect(result['claude'].rules).toBe('.claude/custom-rules');
  });

  it('skips agents that are not installed', async () => {
    // No .tclaude directory exists
    const teamConfig = buildTeamConfig({ claude: DEFAULT_TOOL_PATHS['claude'] });
    const result = await effectiveToolPaths(teamConfig, localConfig);

    expect(result['tclaude']).toBeUndefined();
  });

  it('respects disabledAgents', async () => {
    await fse.ensureDir(path.join(homeDir, '.tclaude'));
    const teamConfig = buildTeamConfig({ claude: DEFAULT_TOOL_PATHS['claude'] });
    const configWithDisabled = { ...localConfig, disabledAgents: ['tclaude'] };
    const result = await effectiveToolPaths(teamConfig, configWithDisabled);

    expect(result['tclaude']).toBeUndefined();
  });

  it('preserves codebuddy CODEBUDDY.md (not CLAUDE.md) from registry', async () => {
    await fse.ensureDir(path.join(homeDir, '.codebuddy'));
    const teamConfig = buildTeamConfig({});
    const result = await effectiveToolPaths(teamConfig, localConfig);

    expect(result['codebuddy']).toBeDefined();
    expect(result['codebuddy'].claudemd).toBe('.codebuddy/CODEBUDDY.md');
  });

  it('scopedToolPaths is unaffected — returns only teamConfig.toolPaths', () => {
    const teamConfig = buildTeamConfig({ claude: DEFAULT_TOOL_PATHS['claude'] });
    const result = scopedToolPaths(teamConfig, localConfig);

    // Only claude was in teamConfig.toolPaths
    expect(Object.keys(result)).toEqual(['claude']);
  });
});
