import { describe, expect, it } from 'vitest';
import { KNOWN_AGENTS, SELF_MODE_AGENT_CHOICES } from '../known-agents.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';

describe('Pi adapter configuration', () => {
  it('declares native project and user resource paths', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
    expect(config.toolPaths.pi).toEqual({
      mcp: '.pi/agent/mcp.json',
      mcpProject: '.pi/mcp.json',
      skills: '.pi/skills',
      claudemd: 'AGENTS.md',
      // Pi reads no rules directory: its user rules are a block in
      // ~/.pi/agent/AGENTS.md, its project rules come from teamai's extension (#946).
      userScope: {
        skills: '.pi/agent/skills',
        claudemd: '.pi/agent/AGENTS.md',
      },
    });

    expect(scopedToolPaths(config, { scope: 'project' }).pi).toEqual(config.toolPaths.pi);
    expect(scopedToolPaths(config, { scope: 'user' }).pi).toMatchObject({
      skills: '.pi/agent/skills',
      claudemd: '.pi/agent/AGENTS.md',
    });
    expect(scopedToolPaths(config, { scope: 'user' }).pi).not.toHaveProperty('rules');
    expect(scopedToolPaths(config, { scope: 'project' }).pi).not.toHaveProperty('rules');
  });

  it('registers Pi for discovery and single-repo selection', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'pi')).toMatchObject({
      displayName: 'Pi Coding Agent',
      skillsPath: '.pi/skills',
    });
    expect(SELF_MODE_AGENT_CHOICES).toContain('pi');
  });
});
