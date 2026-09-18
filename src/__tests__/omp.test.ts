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
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('OMP (Oh My Pi) support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships OMP resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.omp).toEqual({
      skills: '.omp/skills',
      rules: '.omp/rules',
      claudemd: '.omp/AGENTS.md',
      agents: '.omp/agents',
      mcp: '.omp/agent/mcp.json',
      mcpProject: '.omp/mcp.json',
      userScope: {
        skills: '.omp/agent/skills',
        rules: '.omp/agent/rules',
        claudemd: '.omp/agent/AGENTS.md',
        agents: '.omp/agent/agents',
      },
    });

    // User scope splices the agent-dir prefix (~/.omp/agent/...) over the
    // project-scope paths (.omp/...), matching OMP's native layout.
    const scoped = scopedToolPaths(config, { scope: 'user' });
    expect(scoped.omp).toMatchObject({
      skills: '.omp/agent/skills',
      rules: '.omp/agent/rules',
      claudemd: '.omp/agent/AGENTS.md',
      agents: '.omp/agent/agents',
    });
  });

  it('registers OMP for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'omp')).toMatchObject({
      displayName: 'Oh My Pi',
      skillsPath: '.omp/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('omp');
    expect(agentFileExtensionForTool('omp')).toBe('.md');
    expect(ruleFileExtensionForTool('omp')).toBe('.md');
    expect(usesCursorMdcRules('omp')).toBe(false);
  });

  it('uses the mcpServers JSON format in the OMP agent dir', () => {
    expect(detectMcpFormat('omp')).toBe('claude');
  });

  it('resolves the installed OMP agent dir as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-test-'));
    try {
      await fse.ensureDir(path.join(home, '.omp', 'agent', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'omp',
        format: 'claude',
        file: path.join(home, '.omp', 'agent', 'mcp.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});
