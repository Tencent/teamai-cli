import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { KNOWN_AGENTS } from '../known-agents.js';
import { ruleFileExtensionForTool, usesMdcRules } from '../resources/rule-format.js';
import { scopedToolPaths, TeamaiConfigSchema, type LocalConfig } from '../types.js';
import { AGENT_TOOLS, channelsOf, homeVariables, sessionPlatformsOf } from '../tools.js';
import { AgentsHandler, updateJoycodeAgentIndex } from '../resources/agents.js';
import { builtinHookDefs } from '../builtin-hooks.js';
import { getAdapter } from '../session-flow/adapters/index.js';
import { CodexAdapter } from '../session-flow/adapters/codex.js';
import { SESSION_PLATFORM_FACTS } from '../session-flow/adapters/platform-facts.js';
import { AgentSession } from '../session-flow/agent-session.js';

describe('JoyCode support', () => {
  it('follows JOYCODE_HOME for user-scope resources', () => {
    expect(homeVariables('joycode')).toEqual(['JOYCODE_HOME']);
  });

  it('ships the standard .joycode resource paths', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.joycode).toEqual({
      skills: '.joycode/skills',
      rules: '.joycode/rules',
      settings: '.joycode/hooks.json',
      agents: '.joycode/agents',
      // User rules are a block in ~/.joycode/rules.txt (#946).
      userScope: { rules: null },
    });
    expect(scopedToolPaths(config, { scope: 'user' }).joycode).not.toHaveProperty('rules');
  });

  it('installs the built-in hooks into .joycode/hooks.json with timeouts', () => {
    expect(channelsOf('joycode').hooks.user).toMatchObject({ channel: 'settings', format: 'claude' });
    const defs = builtinHookDefs('joycode');
    expect(defs.map((d) => d.event)).toEqual(['SessionStart', 'Stop', 'PostToolUse', 'PostToolUse', 'UserPromptSubmit']);
    expect(defs.every((d) => typeof d.timeout === 'number')).toBe(true);
    expect(defs[0].command).toContain('hook-dispatch session-start --tool joycode');
  });

  it('registers JoyCode for discovery and native agent rendering', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'joycode')).toMatchObject({
      displayName: 'JoyCode',
      skillsPath: '.joycode/skills',
    });
    expect(AGENT_TOOLS).toContain('joycode');
  });

  it('writes the agent index that JoyCode reads while preserving member entries', async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-joycode-index-'));
    try {
      const agentsDir = path.join(root, '.joycode', 'agents');
      const sidecar = { kind: 'file' as const, path: path.join(root, '.joycode', 'agent.json'), owned: true as const, header: null };
      await fse.ensureDir(agentsDir);
      await fse.writeFile(sidecar.path, JSON.stringify({ version: '1.0.0', agents: [{ agentId: 'member-agent', name: 'Member', source: 'project', contentPath: 'agents/member.md', isActive: false }] }));

      await updateJoycodeAgentIndex(sidecar, {
        kind: 'upsert', file: 'team.md', scope: 'user',
        content: '---\nname: Team reviewer\ndescription: Review pull requests\nmodel: glm\n---\n\nReview the change.',
      });

      const afterUpsert = JSON.parse(await fse.readFile(sidecar.path, 'utf8')) as { version: string; agents: Array<Record<string, unknown>> };
      expect(afterUpsert.version).toBe('1.0.0');
      expect(afterUpsert.agents).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: 'member-agent', contentPath: 'agents/member.md', isActive: false }),
        expect.objectContaining({ agentId: 'teamai-e833fa6a', name: 'Team reviewer', source: 'global', contentPath: 'agents/team.md', whenToUse: 'Review pull requests', model: 'glm', isActive: true }),
      ]));

      await updateJoycodeAgentIndex(sidecar, { kind: 'remove', file: 'team.md' });
      const afterRemove = JSON.parse(await fse.readFile(sidecar.path, 'utf8')) as { agents: Array<Record<string, unknown>> };
      expect(afterRemove.agents).toEqual([{ agentId: 'member-agent', name: 'Member', source: 'project', contentPath: 'agents/member.md', isActive: false }]);

      await updateJoycodeAgentIndex(sidecar, { kind: 'upsert', file: 'team.md', scope: 'user', content: '# Team reviewer' });
      expect(JSON.parse(await fse.readFile(sidecar.path, 'utf8')).agents).toEqual(expect.arrayContaining([
        ...afterRemove.agents,
        expect.objectContaining({ agentId: 'teamai-e833fa6a', contentPath: 'agents/team.md' }),
      ]));

      await fse.writeFile(sidecar.path, '{');
      await updateJoycodeAgentIndex(sidecar, { kind: 'upsert', file: 'other.md', scope: 'user', content: '# Other' });
      expect(await fse.readFile(sidecar.path, 'utf8')).toBe('{');
    } finally {
      await fse.remove(root);
    }
  });

  it('yields a TeamAI index entry to a member entry for the same file', async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-joycode-member-index-'));
    try {
      const sidecar = { kind: 'file' as const, path: path.join(root, 'agent.json'), owned: true as const, header: null };
      await updateJoycodeAgentIndex(sidecar, { kind: 'upsert', file: 'team.md', scope: 'user', content: '# Team reviewer' });
      const before = JSON.parse(await fse.readFile(sidecar.path, 'utf8')) as { agents: Array<Record<string, unknown>> };
      await fse.writeFile(sidecar.path, JSON.stringify({
        version: '1.0.0',
        agents: [...before.agents, { agentId: 'member-team', name: 'Member reviewer', source: 'project', contentPath: 'agents/team.md', isActive: false }],
      }));

      await updateJoycodeAgentIndex(sidecar, { kind: 'upsert', file: 'team.md', scope: 'user', content: '# Updated Team reviewer' });

      expect(JSON.parse(await fse.readFile(sidecar.path, 'utf8')).agents).toEqual([
        { agentId: 'member-team', name: 'Member reviewer', source: 'project', contentPath: 'agents/team.md', isActive: false },
      ]);
    } finally {
      await fse.remove(root);
    }
  });

  it('removes an index that held only the TeamAI entry', async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-joycode-empty-index-'));
    try {
      const sidecar = { kind: 'file' as const, path: path.join(root, 'agent.json'), owned: true as const, header: null };
      await updateJoycodeAgentIndex(sidecar, { kind: 'upsert', file: 'team.md', scope: 'user', content: '# Team reviewer' });
      await updateJoycodeAgentIndex(sidecar, { kind: 'remove', file: 'team.md' });
      expect(await fse.pathExists(sidecar.path)).toBe(false);
    } finally {
      await fse.remove(root);
    }
  });

  it('writes an index beside an agent pulled for JoyCode', async () => {
    const root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-joycode-pull-'));
    try {
      const home = path.join(root, 'home');
      const repo = path.join(root, 'team');
      const yaml = path.join(repo, 'agents', 'reviewer.yaml');
      await fse.outputFile(yaml, 'name: reviewer\ndescription: Review changes\ninstructions: Review the patch carefully.\ntargets: [joycode]\n');
      await fse.ensureDir(path.join(home, '.joycode'));
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const local: LocalConfig = { repo: { localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'test', additionalRoles: [], scope: 'user' };
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        await new AgentsHandler().pullItem({ name: 'reviewer', type: 'agents', sourcePath: yaml, relativePath: 'agents/reviewer.yaml' }, config, local);
      } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
      const index = JSON.parse(await fse.readFile(path.join(home, '.joycode', 'agent.json'), 'utf8')) as { agents: Array<Record<string, unknown>> };
      expect(index.agents).toEqual([expect.objectContaining({ name: 'reviewer', contentPath: 'agents/reviewer.md', source: 'global' })]);
    } finally {
      await fse.remove(root);
    }
  });

  it('uses .mdc rule files', () => {
    expect(ruleFileExtensionForTool('joycode')).toBe('.mdc');
    expect(usesMdcRules('joycode')).toBe(true);
  });

  it('supports sessions via CodexAdapter under ~/.joycode/sessions', () => {
    expect(sessionPlatformsOf('joycode')).toEqual(['joycode']);
    expect(AgentSession.platformForTool('joycode')).toBe('joycode');
    expect(AgentSession.toolForPlatform('joycode')).toBe('joycode');
    expect(SESSION_PLATFORM_FACTS.joycode).toMatchObject({
      store: { in: 'tool-home', home: 'joycode', dir: 'sessions' },
      idFormat: 'uuid',
    });
    const adapter = getAdapter('joycode');
    expect(adapter).toBeInstanceOf(CodexAdapter);
  });
});
