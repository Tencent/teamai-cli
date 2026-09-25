import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import matter from 'gray-matter';
import os from 'node:os';
import path from 'node:path';
import {
  ALL_SUPPORTED_TOOLS,
  agentStemFromFilename,
  renderForTool,
  reverseFromWorkbuddy,
  type AgentSpec,
  type ToolName,
} from '../resources/agent-format.js';
import { AgentsHandler } from '../resources/agents.js';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

const WORKBUDDY_TOOL = 'workbuddy' as ToolName;
const TEAM_AGENT = 'reviewer';
const USER_AGENT = 'personal-agent';
const TEAM_AGENT_YAML = `name: ${TEAM_AGENT}
description: Review team changes
instructions: Review the requested change and report defects.
tools: [Bash, Read, Grep, Glob]
tool_extras:
  workbuddy:
    mode: strict
`;

describe('WorkBuddy custom agents', () => {
  let sandbox: string;
  let homeDir: string;
  let teamRepo: string;
  let teamConfig: TeamaiConfig;
  let userConfig: LocalConfig;
  let handler: AgentsHandler;

  beforeEach(async () => {
    sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-workbuddy-agents-'));
    homeDir = path.join(sandbox, 'home');
    teamRepo = path.join(sandbox, 'team-repo');
    await fse.ensureDir(path.join(homeDir, '.workbuddy', 'agents'));
    await fse.ensureDir(path.join(teamRepo, 'agents'));
    await fse.writeFile(path.join(teamRepo, 'agents', `${TEAM_AGENT}.yaml`), TEAM_AGENT_YAML);
    vi.stubEnv('HOME', homeDir);
    teamConfig = TeamaiConfigSchema.parse({
      team: 'workbuddy-agents-test',
      repo: 'fixture',
      provider: 'git',
    });
    userConfig = {
      repo: { localPath: teamRepo, remote: 'fixture' },
      username: 'tester',
      scope: 'user',
      enabledAgents: ['workbuddy'],
      additionalRoles: [],
    } as unknown as LocalConfig;
    handler = new AgentsHandler();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(sandbox);
  });

  it('registers workbuddy as a supported tool with a default agents path', () => {
    expect(ALL_SUPPORTED_TOOLS).toContain('workbuddy');
    expect(teamConfig.toolPaths['workbuddy']?.agents).toBe('.workbuddy/agents');
  });

  it('renders Claude-style Markdown frontmatter and round-trips through reverse', () => {
    const spec: AgentSpec = {
      name: TEAM_AGENT,
      description: 'Review team changes',
      instructions: 'Review carefully.',
      model: 'claude-sonnet-4.6',
      tools: ['Bash', 'Read'],
      tool_extras: { workbuddy: { mode: 'strict' } },
    };

    const rendered = renderForTool(spec, WORKBUDDY_TOOL);
    const parsed = matter(rendered.content);

    expect(rendered.ext).toBe('.md');
    expect(agentStemFromFilename(`${TEAM_AGENT}.md`)).toBe(TEAM_AGENT);
    expect(parsed.data).toMatchObject({
      name: TEAM_AGENT,
      description: 'Review team changes',
      model: 'claude-sonnet-4.6',
      tools: ['Bash', 'Read'],
      mode: 'strict',
    });
    expect(parsed.content.trim()).toBe('Review carefully.');

    const reversed = reverseFromWorkbuddy(
      path.join(homeDir, '.workbuddy', 'agents', `${TEAM_AGENT}.md`),
      rendered.content,
    );
    expect(reversed.ok).toBe(true);
    if (!reversed.ok) return;
    expect(reversed.spec.name).toBe(TEAM_AGENT);
    expect(reversed.spec.description).toBe('Review team changes');
    expect(reversed.spec.instructions).toBe('Review carefully.');
    expect(reversed.spec.model).toBe('claude-sonnet-4.6');
    expect(reversed.spec.tools).toEqual(['Bash', 'Read']);
    // Private fields must be namespaced to workbuddy, not claude
    expect(reversed.spec.tool_extras?.workbuddy).toEqual({ mode: 'strict' });
    expect(reversed.spec.tool_extras?.claude).toBeUndefined();
  });

  it('deploys to ~/.workbuddy/agents on pull, round-trips edits on push, and removes only TeamAI files', async () => {
    const userOwned = path.join(homeDir, '.workbuddy', 'agents', `${USER_AGENT}.md`);
    const userOwnedContent = '---\ndescription: Personal\n---\nKeep me.\n';
    await fse.writeFile(userOwned, userOwnedContent);
    const sourcePath = path.join(teamRepo, 'agents', `${TEAM_AGENT}.yaml`);
    const item = {
      name: TEAM_AGENT,
      type: 'agents' as const,
      sourcePath,
      relativePath: `agents/${TEAM_AGENT}.yaml`,
    };

    await handler.pullItem(item, teamConfig, userConfig);
    const userTarget = path.join(homeDir, '.workbuddy', 'agents', `${TEAM_AGENT}.md`);
    expect(await fse.pathExists(userTarget)).toBe(true);
    const firstContent = await fse.readFile(userTarget, 'utf8');
    const firstParsed = matter(firstContent);
    expect(firstParsed.data.name).toBe(TEAM_AGENT);
    expect(firstParsed.data.mode).toBe('strict');

    // Idempotent re-pull, user-owned files untouched
    await handler.pullItem(item, teamConfig, userConfig);
    expect(await fse.readFile(userTarget, 'utf8')).toBe(firstContent);
    expect(await fse.readFile(userOwned, 'utf8')).toBe(userOwnedContent);

    // Local edit → push candidate carries the edit and keeps workbuddy extras
    await fse.writeFile(userTarget, firstContent.replace('Review team changes', 'Review WorkBuddy changes'));
    const pushed = await handler.scanLocalForPush(teamConfig, userConfig);
    const pushedTeamAgent = pushed.find((candidate) => candidate.name === TEAM_AGENT);
    expect(pushedTeamAgent?.mergedSpec?.description).toBe('Review WorkBuddy changes');
    expect(pushedTeamAgent?.mergedSpec?.tool_extras?.workbuddy).toEqual({ mode: 'strict' });

    // Removal deletes the managed file only
    const removed = await handler.removeItem(TEAM_AGENT, teamConfig, userConfig);
    expect(removed).toContain(userTarget);
    expect(await fse.pathExists(userTarget)).toBe(false);
    expect(await fse.readFile(userOwned, 'utf8')).toBe(userOwnedContent);
  });
});
