import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import {
  agentFileExtensionForTool,
} from '../resources/agent-format.js';
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema } from '../types.js';
import { AGENT_TOOLS } from '../tools.js';

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
    expect(AGENT_TOOLS).toContain('qoder');
    expect(agentFileExtensionForTool('qoder')).toBe('.md');
    expect(ruleFileExtensionForTool('qoder')).toBe('.md');
    expect(usesMdcRules('qoder')).toBe(false);
  });


});
