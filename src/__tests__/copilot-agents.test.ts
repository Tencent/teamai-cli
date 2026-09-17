import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import matter from 'gray-matter';
import os from 'node:os';
import path from 'node:path';
import { deployBuiltinAgents } from '../builtin-agents.js';
import {
  agentStemFromFilename,
  renderForTool,
  reverseFromCopilot,
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

const COPILOT_TOOL = 'copilot' as ToolName;
const TEAM_AGENT = 'reviewer';
const ROLE_AGENT = 'frontend-reviewer';
const USER_AGENT = 'personal-agent';
const TEAM_AGENT_YAML = `name: ${TEAM_AGENT}
description: Review team changes
instructions: Review the requested change and report defects.
tools: [Bash, Read, Grep, Glob]
tool_extras:
  copilot:
    target: github-copilot
`;

describe('Copilot custom agents', () => {
  let sandbox: string;
  let homeDir: string;
  let copilotHome: string;
  let teamRepo: string;
  let projectRoot: string;
  let teamConfig: TeamaiConfig;
  let userConfig: LocalConfig;
  let handler: AgentsHandler;

  beforeEach(async () => {
    sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-copilot-agents-'));
    homeDir = path.join(sandbox, 'home');
    copilotHome = path.join(sandbox, 'copilot-home');
    teamRepo = path.join(sandbox, 'team-repo');
    projectRoot = path.join(sandbox, 'project');
    await fse.ensureDir(path.join(copilotHome, 'agents'));
    await fse.ensureDir(path.join(projectRoot, '.github', 'agents'));
    await fse.ensureDir(path.join(teamRepo, 'agents', 'frontend'));
    await fse.writeFile(path.join(teamRepo, 'agents', `${TEAM_AGENT}.yaml`), TEAM_AGENT_YAML);
    await fse.writeFile(path.join(teamRepo, 'agents', 'frontend', `${ROLE_AGENT}.yaml`), `name: ${ROLE_AGENT}
description: Review frontend changes
instructions: Review the frontend change.
targets: [copilot]
`);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('COPILOT_HOME', copilotHome);
    teamConfig = TeamaiConfigSchema.parse({
      team: 'copilot-agents-test',
      repo: 'fixture',
      provider: 'git',
      sharing: { recall: { enabled: true } },
    });
    userConfig = {
      repo: { localPath: teamRepo, remote: 'fixture' },
      username: 'tester',
      scope: 'user',
      enabledAgents: ['copilot'],
      additionalRoles: [],
    } as unknown as LocalConfig;
    handler = new AgentsHandler();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(sandbox);
  });

  it('renders the official .agent.md profile with the least equivalent Copilot tools', () => {
    const spec: AgentSpec = {
      name: TEAM_AGENT,
      description: 'Review team changes',
      instructions: 'Review carefully.',
      model: 'claude-sonnet-4.6',
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
      tool_extras: { copilot: { target: 'github-copilot' } } as AgentSpec['tool_extras'],
    };

    const rendered = renderForTool(spec, COPILOT_TOOL);
    const parsed = matter(rendered.content);

    expect(rendered.ext).toBe('.agent.md');
    expect(agentStemFromFilename(`${TEAM_AGENT}.agent.md`)).toBe(TEAM_AGENT);
    expect(parsed.data).toMatchObject({
      name: TEAM_AGENT,
      description: 'Review team changes',
      model: 'claude-sonnet-4.6',
      tools: ['execute', 'read', 'search'],
      target: 'github-copilot',
    });
    expect(parsed.content.trim()).toBe('Review carefully.');

    const invalid = reverseFromCopilot(
      path.join(copilotHome, 'agents', 'invalid.agent.md'),
      '---\ntools: [unterminated\n---\nInstructions.\n',
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toContain('parse error');
  });

  it('uses COPILOT_HOME and project scope, round-trips edits, and removes only TeamAI files', async () => {
    const userOwned = path.join(copilotHome, 'agents', `${USER_AGENT}.agent.md`);
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
    const userTarget = path.join(copilotHome, 'agents', `${TEAM_AGENT}.agent.md`);
    expect(await fse.pathExists(userTarget)).toBe(true);
    const firstContent = await fse.readFile(userTarget, 'utf8');
    await handler.pullItem(item, teamConfig, userConfig);
    expect(await fse.readFile(userTarget, 'utf8')).toBe(firstContent);
    expect(await fse.readFile(userOwned, 'utf8')).toBe(userOwnedContent);

    await fse.writeFile(userTarget, firstContent.replace('Review team changes', 'Review Copilot changes'));
    const pushed = await handler.scanLocalForPush(teamConfig, userConfig);
    const pushedTeamAgent = pushed.find((candidate) => candidate.name === TEAM_AGENT);
    expect(pushedTeamAgent?.mergedSpec?.description).toBe('Review Copilot changes');
    expect(pushedTeamAgent?.mergedSpec?.tool_extras?.copilot).toEqual({ target: 'github-copilot' });

    const projectConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot,
    } as LocalConfig;
    await handler.pullItem(item, teamConfig, projectConfig);
    const projectTarget = path.join(projectRoot, '.github', 'agents', `${TEAM_AGENT}.agent.md`);
    expect(await fse.pathExists(projectTarget)).toBe(true);
    expect(await fse.pathExists(path.join(projectRoot, 'agents', `${TEAM_AGENT}.agent.md`))).toBe(false);

    const removed = await handler.removeItem(TEAM_AGENT, teamConfig, userConfig);
    expect(removed).toContain(userTarget);
    expect(await fse.pathExists(userTarget)).toBe(false);
    expect(await fse.readFile(userOwned, 'utf8')).toBe(userOwnedContent);
  });

  it('deploys least-privilege recall and cleans inactive role-scoped agents without touching user files', async () => {
    const userOwned = path.join(copilotHome, 'agents', `${USER_AGENT}.agent.md`);
    await fse.writeFile(userOwned, '---\ndescription: Personal\n---\nKeep me.\n');

    const deployed = await deployBuiltinAgents(teamConfig, userConfig);
    expect(deployed).toBeGreaterThan(0);
    const recallFile = path.join(copilotHome, 'agents', 'teamai-recall.agent.md');
    const recall = matter(await fse.readFile(recallFile, 'utf8'));
    expect(recall.data.tools).toEqual(['execute', 'read', 'search']);
    expect(recall.content).toContain('teamai recall');

    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    const defaultScopeDeployments = await deployBuiltinAgents({
      ...teamConfig,
      toolPaths: { claude: { agents: '.claude/agents' } },
    });
    expect(defaultScopeDeployments).toBeGreaterThan(0);

    const roleSource = path.join(teamRepo, 'agents', 'frontend', `${ROLE_AGENT}.yaml`);
    await handler.pullItem({
      name: ROLE_AGENT,
      type: 'agents',
      sourcePath: roleSource,
      relativePath: `agents/frontend/${ROLE_AGENT}.yaml`,
      namespace: 'frontend',
    }, teamConfig, userConfig);
    const roleTarget = path.join(copilotHome, 'agents', `${ROLE_AGENT}.agent.md`);
    expect(await fse.pathExists(roleTarget)).toBe(true);

    await handler.cleanupInactiveNamespaces(teamConfig, userConfig, []);
    expect(await fse.pathExists(roleTarget)).toBe(false);
    expect(await fse.pathExists(recallFile)).toBe(true);
    expect(await fse.pathExists(userOwned)).toBe(true);
  });
});
