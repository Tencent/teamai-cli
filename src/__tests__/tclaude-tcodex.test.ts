// -*- coding: utf-8 -*-
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

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
      });
    });

    it('tcodex has codex-compatible paths (no settings)', async () => {
      const { TeamaiConfigSchema } = await import('../types.js');
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      expect(config.toolPaths.tcodex).toEqual({
        skills: '.tcodex/skills',
        rules: '.tcodex/rules',
        agents: '.tcodex/agents',
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

  describe('hooks injection targets tclaude', () => {
    it('tclaude settings path enables hook injection', async () => {
      const { TeamaiConfigSchema } = await import('../types.js');
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      // tclaude has settings → hooks will be injected
      expect(config.toolPaths.tclaude.settings).toBe('.tclaude/settings.json');
      // tcodex has no settings → hooks will NOT be injected
      expect(config.toolPaths.tcodex.settings).toBeUndefined();
    });
  });

  describe('AI CLI detection includes tclaude/tcodex', () => {
    it('tclaude uses -p flag (claude-style invocation)', async () => {
      // We test by checking the source logic indirectly
      // buildCliArgs is not exported, but we can verify through callClaude behavior
      // For now, just verify the whitelist includes our tools
      const aiClientSrc = await fs.readFile(
        path.join(process.cwd(), 'src/utils/ai-client.ts'), 'utf8'
      );
      expect(aiClientSrc).toContain("'tclaude'");
      expect(aiClientSrc).toContain("'tcodex'");
      // tcodex should be in the exec branch
      expect(aiClientSrc).toContain("cmd === 'tcodex'");
    });
  });
});
