import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
  KIRO_SESSION_START_COMMAND,
  renderForKiro,
  reverseFromKiro,
} from '../resources/agent-format.js';
import { AgentsHandler } from '../resources/agents.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, usesCursorMdcRules } from '../resources/rule-format.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';
import { resolveHookCwd } from '../utils/hook-cwd.js';
import { deriveSessionId } from '../utils/session-id.js';

describe('Kiro support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships Kiro resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.kiro).toEqual({
      skills: '.kiro/skills',
      rules: '.kiro/steering',
      agents: '.kiro/agents',
      mcp: '.kiro/settings/mcp.json',
      mcpProject: '.kiro/settings/mcp.json',
    });
  });

  it('does not invent a settings hook path because Kiro hooks live in agent configs', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.kiro?.settings).toBeUndefined();
  });

  it('registers Kiro for discovery and native resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'kiro')).toMatchObject({
      displayName: 'Kiro',
      skillsPath: '.kiro/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('kiro');
    expect(agentFileExtensionForTool('kiro')).toBe('.json');
    expect(ruleFileExtensionForTool('kiro')).toBe('.md');
    expect(usesCursorMdcRules('kiro')).toBe(false);
  });

  it('renders agentSpawn session-start into Kiro JSON while preserving custom hooks', () => {
    const rendered = renderForKiro({
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff carefully.',
      tools: ['read'],
      tool_extras: {
        kiro: {
          includeMcpJson: true,
          hooks: {
            agentSpawn: [{ command: 'git status' }],
            postToolUse: [{ matcher: 'fs_write', command: 'npm test' }],
          },
        },
      },
    });

    expect(rendered.ext).toBe('.json');
    expect(JSON.parse(rendered.content)).toEqual({
      name: 'reviewer',
      description: 'Reviews changes',
      prompt: 'Review the diff carefully.',
      tools: ['read'],
      includeMcpJson: true,
      hooks: {
        agentSpawn: [
          { command: 'git status' },
          { command: KIRO_SESSION_START_COMMAND },
        ],
        postToolUse: [{ matcher: 'fs_write', command: 'npm test' }],
      },
    });
  });

  it('reverse parsing drops only the TeamAI-managed agentSpawn hook', () => {
    const rendered = renderForKiro({
      name: 'reviewer',
      description: 'Reviews changes',
      instructions: 'Review the diff carefully.',
      tool_extras: { kiro: { hooks: { agentSpawn: [{ command: 'git status' }] } } },
    });

    expect(reverseFromKiro('reviewer.json', rendered.content)).toEqual({
      ok: true,
      spec: {
        name: 'reviewer',
        description: 'Reviews changes',
        instructions: 'Review the diff carefully.',
        tool_extras: { kiro: { hooks: { agentSpawn: [{ command: 'git status' }] } } },
      },
    });
  });

  it('maps Kiro agentSpawn STDIN onto the shared cwd and session helpers', () => {
    const payload = {
      hook_event_name: 'agentSpawn',
      cwd: '/workspace/project',
      session_id: 'kiro-session-1',
    };

    expect(resolveHookCwd(payload)).toBe('/workspace/project');
    expect(deriveSessionId(payload)).toBe('kiro-session-1');
  });

  it('writes the hook in the actual .kiro/agents JSON path on pull', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-agent-test-'));
    try {
      const repoPath = path.join(home, 'team-repo');
      const sourcePath = path.join(repoPath, 'agents', 'reviewer.yaml');
      await fse.ensureDir(path.join(home, '.kiro', 'agents'));
      await fse.writeFile(path.join(home, '.kiro', 'agents', 'reviewer.md'), 'stale markdown agent');
      await fse.ensureDir(path.dirname(sourcePath));
      await fse.writeFile(sourcePath, [
        'name: reviewer',
        'description: Reviews changes',
        'instructions: Review the diff carefully.',
        'targets: [kiro]',
        '',
      ].join('\n'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      await new AgentsHandler().pullItem({
        name: 'reviewer',
        type: 'agents',
        sourcePath,
        relativePath: 'agents/reviewer.yaml',
      }, config, localConfig);

      const target = path.join(home, '.kiro', 'agents', 'reviewer.json');
      expect(await fse.pathExists(target)).toBe(true);
      expect(await fse.pathExists(path.join(home, '.kiro', 'agents', 'reviewer.md'))).toBe(false);
      expect(JSON.parse(await fse.readFile(target, 'utf8'))).toMatchObject({
        hooks: { agentSpawn: [{ command: KIRO_SESSION_START_COMMAND }] },
      });
    } finally {
      await fse.remove(home);
    }
  });

  it('uses the mcpServers JSON format in the Kiro MCP config', () => {
    expect(detectMcpFormat('kiro')).toBe('claude');
  });

  it('resolves the installed Kiro MCP file as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kiro-test-'));
    try {
      await fse.ensureDir(path.join(home, '.kiro', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'kiro',
        format: 'claude',
        file: path.join(home, '.kiro', 'settings', 'mcp.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});
