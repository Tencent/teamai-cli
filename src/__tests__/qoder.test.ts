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
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('Qoder support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Qoder resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.qoder).toEqual({
      skills: '.qoder/skills',
      rules: '.qoder/rules',
      settings: '.qoder/settings.json',
      agents: '.qoder/agents',
      mcp: '.qoder/settings.json',
      mcpProject: '.qoder/settings.json',
    });
  });

  it('registers Qoder for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'qoder')).toMatchObject({
      displayName: 'Qoder',
      skillsPath: '.qoder/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('qoder');
    expect(agentFileExtensionForTool('qoder')).toBe('.md');
    expect(ruleFileExtensionForTool('qoder')).toBe('.md');
    expect(usesMdcRules('qoder')).toBe(false);
  });

  it('uses the mcpServers JSON format in Qoder settings', () => {
    expect(detectMcpFormat('qoder')).toBe('claude');
  });

  it('resolves the installed Qoder settings file as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qoder-test-'));
    try {
      await fse.ensureDir(path.join(home, '.qoder', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'qoder',
        format: 'claude',
        file: path.join(home, '.qoder', 'settings.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});
