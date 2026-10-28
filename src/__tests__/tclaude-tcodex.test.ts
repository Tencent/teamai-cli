// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';

describe('tclaude/tcodex adapter integration', () => {
  describe('toolPaths defaults include tclaude/tcodex', () => {
    it('tclaude has full claude-compatible paths', async () => {
      const { TeamaiConfigSchema } = await import('../types.js');
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      expect(config.toolPaths.tclaude).toEqual({
        skills: '.tclaude/skills',
        rules: '.tclaude/rules',
        settings: '.tclaude/settings.json',
        claudemd: '.tclaude/CLAUDE.md',
        agents: '.tclaude/agents',
        // customUserDataDir relocates Claude Code's user data dir into .tclaude/
        mcp: '.tclaude/.claude.json',
      });
    });

    it('tcodex has codex-compatible paths including hooks.json', async () => {
      const { TeamaiConfigSchema } = await import('../types.js');
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      // Same shape as codex: no rules dir, and an AGENTS.md in user scope only (#938, #945).
      expect(config.toolPaths.tcodex).toEqual({
        skills: '.tcodex/skills',
        settings: '.tcodex/hooks.json',
        agents: '.tcodex/agents',
        userScope: { claudemd: '.tcodex/AGENTS.md' },
      });
    });
  });

  describe('agent rendering dispatches correctly', () => {
    it('tclaude renders as claude format (.md)', async () => {
      const { renderForTool } = await import('../resources/agent-format.js');
      const spec = {
        name: 'test-agent',
        description: 'A test agent',
        tools: ['Read', 'Bash'],
        instructions: 'You are a test agent.',
      };
      const result = renderForTool(spec, 'tclaude');
      expect(result.ext).toBe('.md');
      expect(result.content).toContain('name: test-agent');
    });

    it('tcodex renders as codex format (.toml)', async () => {
      const { renderForTool } = await import('../resources/agent-format.js');
      const spec = {
        name: 'test-agent',
        description: 'A test agent',
        tools: ['Read', 'Bash'],
        instructions: 'You are a test agent.',
      };
      const result = renderForTool(spec, 'tcodex');
      expect(result.ext).toBe('.toml');
      expect(result.content).toContain('name = "test-agent"');
    });
  });

  describe('known-agents includes tclaude/tcodex', () => {
    it('KNOWN_AGENTS has tclaude entry', async () => {
      const { KNOWN_AGENTS } = await import('../known-agents.js');
      const tclaude = KNOWN_AGENTS.find(a => a.id === 'tclaude');
      expect(tclaude).toBeDefined();
      expect(tclaude!.skillsPath).toBe('.tclaude/skills');
    });

    it('KNOWN_AGENTS has tcodex entry', async () => {
      const { KNOWN_AGENTS } = await import('../known-agents.js');
      const tcodex = KNOWN_AGENTS.find(a => a.id === 'tcodex');
      expect(tcodex).toBeDefined();
      expect(tcodex!.skillsPath).toBe('.tcodex/skills');
    });
  });

  describe('hooks injection targets tclaude/tcodex', () => {
    it('settings paths enable hook injection', async () => {
      const { TeamaiConfigSchema } = await import('../types.js');
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      // tclaude has settings → hooks will be injected
      expect(config.toolPaths.tclaude.settings).toBe('.tclaude/settings.json');
      // tcodex has Codex hooks.json → hooks will be injected
      expect(config.toolPaths.tcodex.settings).toBe('.tcodex/hooks.json');
    });
  });
});
