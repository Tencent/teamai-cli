import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectHomeInstalledAgents, KNOWN_AGENTS } from '../known-agents.js';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
  renderForTool,
} from '../resources/agent-format.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, usesCursorMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('Qoder CN support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Qoder CN project-scope paths identical to Qoder, with user-scope overrides', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    // Top-level fields are PROJECT-scope paths. Only the user scope differs for
    // Qoder CN, so these stay identical to the international `qoder` entry.
    expect(config.toolPaths['qoder-cn']).toEqual({
      skills: '.qoder/skills',
      rules: '.qoder/rules',
      settings: '.qoder/settings.json',
      agents: '.qoder/agents',
      mcp: '.qoder-cn/settings.json',
      mcpProject: '.qoder/settings.json',
      userScope: {
        skills: '.qoder-cn/skills',
        rules: '.qoder-cn/rules',
        settings: '.qoder-cn/settings.json',
        agents: '.qoder-cn/agents',
      },
    });
  });

  it('maps Qoder CN to .qoder-cn under user scope and to .qoder under project scope', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    // End-to-end through the scope contract rather than reading the static table:
    // a CN install reads ~/.qoder-cn, so every user-scope resource must resolve
    // there and must differ from the international ~/.qoder paths.
    const userScoped = scopedToolPaths(config, { scope: 'user' });
    const cnUser = userScoped['qoder-cn'] as Record<string, string>;
    const qoderUser = userScoped.qoder as Record<string, string>;

    for (const key of ['skills', 'rules', 'settings', 'agents'] as const) {
      expect(cnUser[key]).toBe(`.qoder-cn/${key === 'settings' ? 'settings.json' : key}`);
      expect(cnUser[key]).not.toEqual(qoderUser[key]);
    }
    // MCP is not part of the userScope splice: its two scopes are distinct
    // fields and the user-scope file is already the CN one.
    expect(cnUser.mcp).toBe('.qoder-cn/settings.json');
    expect(qoderUser.mcp).toBe('.qoder/settings.json');

    // Project scope is the identity map: Qoder CN and Qoder share one layout.
    const projectScoped = scopedToolPaths(config, { scope: 'project' });
    const cnProject = projectScoped['qoder-cn'] as Record<string, string>;
    const qoderProject = projectScoped.qoder as Record<string, string>;

    for (const key of ['skills', 'rules', 'settings', 'agents', 'mcpProject'] as const) {
      expect(cnProject[key]).toBe(qoderProject[key]);
      expect(cnProject[key].startsWith('.qoder/')).toBe(true);
    }
  });

  it('registers Qoder CN for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'qoder-cn')).toMatchObject({
      displayName: 'Qoder CN',
      skillsPath: '.qoder-cn/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('qoder-cn');
    expect(agentFileExtensionForTool('qoder-cn')).toBe('.md');
    expect(ruleFileExtensionForTool('qoder-cn')).toBe('.md');
    expect(usesCursorMdcRules('qoder-cn')).toBe(false);
  });

  it('renders Qoder CN subagents exactly like Qoder', () => {
    const spec = {
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff.',
    };

    expect(renderForTool(spec, 'qoder-cn')).toEqual(renderForTool(spec, 'qoder'));
  });

  it('uses the mcpServers JSON format in Qoder CN settings', () => {
    expect(detectMcpFormat('qoder-cn')).toBe('claude');
  });

  it('resolves the installed Qoder CN settings file as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qoder-cn-test-'));
    try {
      await fse.ensureDir(path.join(home, '.qoder-cn', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'qoder-cn',
        format: 'claude',
        file: path.join(home, '.qoder-cn', 'settings.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });

  it('detects .qoder-cn and .qoder independently when probing HOME', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qoder-cn-probe-'));
    try {
      vi.stubEnv('HOME', home);

      await fse.ensureDir(path.join(home, '.qoder-cn', 'skills'));
      expect(await detectHomeInstalledAgents(['qoder', 'qoder-cn'])).toEqual(['qoder-cn']);

      // The international install must not be reported for the CN directory,
      // and vice versa — the two roots are separate opt-ins.
      await fse.ensureDir(path.join(home, '.qoder', 'skills'));
      expect(await detectHomeInstalledAgents(['qoder', 'qoder-cn'])).toEqual(['qoder', 'qoder-cn']);
    } finally {
      await fse.remove(home);
    }
  });
});
