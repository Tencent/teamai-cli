import { describe, expect, it } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import { ALL_SUPPORTED_TOOLS } from '../resources/agent-format.js';
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { scopedToolPaths, TeamaiConfigSchema } from '../types.js';

describe('JoyCode support', () => {
  it('ships the standard .joycode resource paths', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.joycode).toEqual({
      skills: '.joycode/skills',
      rules: '.joycode/rules',
      agents: '.joycode/agents',
      // User rules are a block in ~/.joycode/rules.txt (#946).
      userScope: { rules: null },
    });
    expect(scopedToolPaths(config, { scope: 'user' }).joycode).not.toHaveProperty('rules');
  });

  it('registers JoyCode for discovery and native agent rendering', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'joycode')).toMatchObject({
      displayName: 'JoyCode',
      skillsPath: '.joycode/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('joycode');
  });

  it('uses .mdc rule files', () => {
    expect(ruleFileExtensionForTool('joycode')).toBe('.mdc');
    expect(usesMdcRules('joycode')).toBe(true);
  });
});
