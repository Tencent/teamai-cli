import { describe, expect, it } from 'vitest';
import { KNOWN_AGENTS, SELF_MODE_AGENT_CHOICES } from '../known-agents.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';

describe('Pi adapter configuration', () => {
  it('declares native project and user resource paths', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
    expect(config.toolPaths.pi).toEqual({
      skills: '.pi/skills',
      rules: '.pi/rules',
      claudemd: 'AGENTS.md',
      userScope: {
        skills: '.pi/agent/skills',
        rules: '.pi/agent/rules',
        claudemd: '.pi/agent/AGENTS.md',
      },
    });

    expect(scopedToolPaths(config, { scope: 'project' }).pi).toEqual(config.toolPaths.pi);
    expect(scopedToolPaths(config, { scope: 'user' }).pi).toMatchObject({
      skills: '.pi/agent/skills',
      rules: '.pi/agent/rules',
      claudemd: '.pi/agent/AGENTS.md',
    });
  });

  it('registers Pi for discovery and single-repo selection', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'pi')).toMatchObject({
      displayName: 'Pi Coding Agent',
      skillsPath: '.pi/skills',
    });
    expect(SELF_MODE_AGENT_CHOICES).toContain('pi');
  });
});
