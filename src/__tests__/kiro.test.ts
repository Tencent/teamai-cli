import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
} from '../resources/agent-format.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, usesCursorMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('Kiro support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Kiro resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.kiro).toEqual({
      skills: '.kiro/skills',
      rules: '.kiro/steering',
      agents: '.kiro/agents',
      mcp: '.kiro/settings/mcp.json',
      mcpProject: '.kiro/settings/mcp.json',
    });
  });

  it('does not ship a settings path, so hook injection skips Kiro', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.kiro?.settings).toBeUndefined();
  });

  it('registers Kiro for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'kiro')).toMatchObject({
      displayName: 'Kiro',
      skillsPath: '.kiro/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('kiro');
    expect(agentFileExtensionForTool('kiro')).toBe('.md');
    expect(ruleFileExtensionForTool('kiro')).toBe('.md');
    expect(usesCursorMdcRules('kiro')).toBe(false);
  });

  it('uses the mcpServers JSON format in the Kiro MCP config', () => {
    expect(detectMcpFormat('kiro')).toBe('claude');
  });

  it('resolves the installed Kiro MCP file as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-test-'));
    try {
      await fse.ensureDir(path.join(home, '.kiro', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'kiro',
        format: 'claude',
        file: path.join(home, '.kiro', 'settings', 'mcp.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});
