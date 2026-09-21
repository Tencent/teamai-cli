import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWN_AGENTS } from '../known-agents.js';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import {
  agentFileExtensionForTool,
  ALL_SUPPORTED_TOOLS,
} from '../resources/agent-format.js';
import { AgentsHandler } from '../resources/agents.js';
import { detectMcpFormat } from '../resources/mcp-format.js';
import { ruleFileExtensionForTool, usesCursorMdcRules } from '../resources/rule-format.js';
import { RulesHandler } from '../resources/rules.js';
import { TeamaiConfigSchema, scopedToolPaths } from '../types.js';
import type { LocalConfig, ResourceItem } from '../types.js';

describe('OMP (Oh My Pi) support', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ships OMP resource paths for user and project scopes', () => {
    const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });

    expect(config.toolPaths.omp).toEqual({
      skills: '.omp/skills',
      rules: '.omp/rules',
      claudemd: '.omp/AGENTS.md',
      agents: '.omp/agents',
      mcp: '.omp/agent/mcp.json',
      mcpProject: '.omp/mcp.json',
      userScope: {
        skills: '.omp/agent/skills',
        rules: '.omp/agent/rules',
        claudemd: '.omp/agent/AGENTS.md',
        agents: '.omp/agent/agents',
      },
    });

    // User scope splices the agent-dir prefix (~/.omp/agent/...) over the
    // project-scope paths (.omp/...), matching OMP's native layout.
    const scoped = scopedToolPaths(config, { scope: 'user' });
    expect(scoped.omp).toMatchObject({
      skills: '.omp/agent/skills',
      rules: '.omp/agent/rules',
      claudemd: '.omp/agent/AGENTS.md',
      agents: '.omp/agent/agents',
    });
  });

  it('registers OMP for discovery and native Markdown resources', () => {
    expect(KNOWN_AGENTS.find((agent) => agent.id === 'omp')).toMatchObject({
      displayName: 'Oh My Pi',
      skillsPath: '.omp/skills',
    });
    expect(ALL_SUPPORTED_TOOLS).toContain('omp');
    expect(agentFileExtensionForTool('omp')).toBe('.md');
    expect(ruleFileExtensionForTool('omp')).toBe('.md');
    expect(usesCursorMdcRules('omp')).toBe(false);
  });

  it('uses the mcpServers JSON format in the OMP agent dir', () => {
    expect(detectMcpFormat('omp')).toBe('claude');
  });

  it('resolves the installed OMP agent dir as an MCP target', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-test-'));
    try {
      await fse.ensureDir(path.join(home, '.omp', 'agent', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      expect(await resolveMcpTargets(config, localConfig)).toContainEqual({
        tool: 'omp',
        format: 'claude',
        file: path.join(home, '.omp', 'agent', 'mcp.json'),
        projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});

describe('OMP rules directory is user-owned', () => {
  it('preserves personal rules across repeated pulls (same policy as JoyCode)', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'notes.md'), 'Personal rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules/nested/private.md'), 'Personal nested rule.');
      await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const handler = new RulesHandler();
      await handler.pullAllRules(teamConfig, localConfig);
      await handler.pullAllRules(teamConfig, localConfig);

      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/notes.md'), 'utf8')).toBe('Personal rule.');
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/nested/private.md'), 'utf8')).toBe('Personal nested rule.');
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/team.md'), 'utf8')).toBe('Team rule.');
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });

  it('still removes a rule the team explicitly tombstoned', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-t-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'gone.md'), 'Former team rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'personal.md'), 'Personal rule.');
      await fse.writeFile(path.join(repoPath, 'rules', 'keep.md'), 'Current team rule.');
      await fse.writeFile(path.join(repoPath, 'rules', '.removed'), 'gone\n');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      await new RulesHandler().pullAllRules(teamConfig, localConfig);

      expect(await fse.pathExists(path.join(homeDir, '.omp/agent/rules/gone.md'))).toBe(false);
      expect(await fse.readFile(path.join(homeDir, '.omp/agent/rules/personal.md'), 'utf8')).toBe('Personal rule.');
      expect(await fse.pathExists(path.join(homeDir, '.omp/agent/rules/keep.md'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });

  it('never offers personal rules as teamai push candidates', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-rules-p-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'rules'));
      await fse.writeFile(path.join(repoPath, 'rules', 'team.md'), 'Team rule.');
      await fse.outputFile(path.join(homeDir, '.omp/agent/rules', 'personal.md'), 'Personal rule.');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', rules: '.omp/agent/rules' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const handler = new RulesHandler();
      await handler.pullAllRules(teamConfig, localConfig);
      // Personal rule stays local-only; a locally edited team rule is still a
      // legitimate "modified" push candidate from the shared dir.
      await fse.writeFile(path.join(homeDir, '.omp/agent/rules', 'team.md'), 'Edited team rule.');

      const items = await handler.scanLocalForPush(teamConfig, localConfig);
      expect(items.find((i) => i.name === 'personal')).toBeUndefined();
      expect(items.find((i) => i.name === 'team')).toMatchObject({ status: 'modified' });
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });
});

describe('OMP receives legacy markdown team agents', () => {
  it('copies agents/<name>.md verbatim into the omp agents dir', async () => {
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-omp-agents-'));
    try {
      const homeDir = path.join(tmp, 'home');
      const repoPath = path.join(tmp, 'repo');
      await fse.ensureDir(path.join(repoPath, 'agents'));
      await fse.ensureDir(path.join(homeDir, '.omp', 'agent'));
      const source = path.join(repoPath, 'agents', 'legacy-helper.md');
      await fse.writeFile(source, '---\nname: legacy-helper\ndescription: Legacy fixture agent\n---\n\nBody.\n');
      vi.stubEnv('HOME', homeDir);

      const teamConfig = TeamaiConfigSchema.parse({
        team: 'test', repo: 'test/repo',
        toolPaths: { omp: { skills: '.omp/skills', agents: '.omp/agent/agents' } },
      });
      const localConfig = {
        repo: { localPath: repoPath, remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      await new AgentsHandler().pullItem({
        name: 'legacy-helper',
        type: 'agents',
        sourcePath: source,
        relativePath: 'agents/legacy-helper.md',
      } as ResourceItem, teamConfig, localConfig);

      expect(await fse.readFile(path.join(homeDir, '.omp/agent/agents/legacy-helper.md'), 'utf8'))
        .toContain('Legacy fixture agent');
    } finally {
      vi.unstubAllEnvs();
      await fse.remove(tmp);
    }
  });
});
