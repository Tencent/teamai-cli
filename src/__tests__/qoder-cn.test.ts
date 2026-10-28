import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectHomeInstalledAgents, KNOWN_AGENTS } from '../known-agents.js';
import {
  agentFileExtensionForTool,
  renderForTool,
} from '../resources/agent-format.js';
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import { isInstalled } from './helpers/install-gate.js';
import type { LocalConfig } from '../types.js';
import { AGENT_TOOLS } from '../tools.js';

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

    for (const key of ['skills', 'rules', 'settings'] as const) {
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

    for (const key of ['skills', 'rules', 'settings', 'mcpProject'] as const) {
      expect(cnProject[key]).toBe(qoderProject[key]);
      expect(cnProject[key].startsWith('.qoder/')).toBe(true);
    }
  });

  it('registers Qoder CN for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'qoder-cn')).toMatchObject({
      displayName: 'Qoder CN',
      skillsPath: '.qoder-cn/skills',
    });
    expect(AGENT_TOOLS).toContain('qoder-cn');
    expect(agentFileExtensionForTool('qoder-cn')).toBe('.md');
    expect(ruleFileExtensionForTool('qoder-cn')).toBe('.md');
    expect(usesMdcRules('qoder-cn')).toBe(false);
  });

  it('renders Qoder CN subagents exactly like Qoder', () => {
    const spec = {
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff.',
    };

    expect(renderForTool(spec, 'qoder-cn')).toEqual(renderForTool(spec, 'qoder'));
  });



  it('counts each edition installed by its own HOME root or an explicit --agent entry, never the shared .qoder/', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-qoder-editions-'));
    try {
      const projectRoot = path.join(home, 'project');
      await fse.ensureDir(path.join(projectRoot, '.qoder', 'skills'));
      vi.stubEnv('HOME', home);
      const localConfig = (enabledAgents?: string[]) => ({
        repo: { localPath: path.join(home, 'repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'project',
        projectRoot,
        additionalRoles: [],
        ...(enabledAgents ? { enabledAgents } : {}),
      }) as unknown as LocalConfig;

      // The shared project root installs neither edition by itself.
      expect(await isInstalled('qoder', 'skills', localConfig())).toBe(false);
      expect(await isInstalled('qoder-cn', 'skills', localConfig())).toBe(false);

      // An explicit --agent entry bootstraps the edition before its app runs.
      expect(await isInstalled('qoder-cn', 'skills', localConfig(['qoder-cn']))).toBe(true);

      // And each edition's own HOME root installs it.
      await fse.ensureDir(path.join(home, '.qoder', 'skills'));
      expect(await isInstalled('qoder', 'skills', localConfig())).toBe(true);
      expect(await isInstalled('qoder-cn', 'skills', localConfig())).toBe(false);
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
