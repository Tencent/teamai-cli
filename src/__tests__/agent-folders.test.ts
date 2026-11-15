import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { AgentsHandler } from '../resources/agents.js';
import { filterAgentsByNamespaces } from '../resources/desired.js';
import { log } from '@teamai/shared/log';
import { resetWarnOnce } from '../utils/warn-once.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

const AGENT = '---\nname: reviewer\ndescription: Reviews a change.\n---\nReview the change against ${TEAMAI_AGENT_DIR}/rubric.md and ${TEAMAI_AGENT_DIR}/examples/good.md.\n';
const RUBRIC = '# Rubric\n\n- Name what breaks.\n';

describe('agent folders', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  const home = (...parts: string[]) => path.join(homeDir, ...parts);
  const forward = (file: string) => file.split(path.sep).join('/');

  const pullAgents = async (config: LocalConfig = localConfig): Promise<void> => {
    const handler = new AgentsHandler();

    for (const item of await handler.scanTeamForPull(teamConfig, config)) await handler.pullItem(item, teamConfig, config);
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agent-folders-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer', 'AGENT.md'), AGENT);
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer', 'rubric.md'), RUBRIC);
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer', 'examples', 'good.md'), '# Good\n');
    await fse.ensureDir(home('.claude'));
    vi.stubEnv('HOME', homeDir);
    vi.clearAllMocks();
    resetWarnOnce();
    teamConfig = TeamaiConfigSchema.parse({ team: 'test', repo: 'https://example.invalid/x/team.git' });
    localConfig = LocalConfigSchema.parse({
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      scope: 'user',
      enabledAgents: ['claude'],
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('delivers a user-scope agent folder to the data home and names it there in the agent', async () => {
    await pullAgents();

    const dir = forward(home('.teamai', 'agents', 'reviewer'));
    expect(await fse.readFile(home('.claude', 'agents', 'reviewer.md'), 'utf8'))
      .toBe(`---\nname: reviewer\ndescription: Reviews a change.\n---\nReview the change against ${dir}/rubric.md and ${dir}/examples/good.md.\n`);
    expect(await fse.readFile(home('.teamai', 'agents', 'reviewer', 'rubric.md'), 'utf8')).toBe(RUBRIC);
    expect(await fse.pathExists(home('.teamai', 'agents', 'reviewer', 'examples', 'good.md'))).toBe(true);
    expect(await fse.pathExists(home('.claude', 'agents', 'AGENT.md'))).toBe(false);
  });

  it('names a namespaced agent folder by its path', async () => {
    await fse.move(path.join(repoPath, 'agents', 'reviewer'), path.join(repoPath, 'agents', 'payments', 'reviewer'));

    await pullAgents();

    expect(await fse.readFile(home('.claude', 'agents', 'reviewer.md'), 'utf8')).toContain(`${forward(home('.teamai', 'agents', 'payments', 'reviewer'))}/rubric.md`);
    expect(await fse.readFile(home('.teamai', 'agents', 'payments', 'reviewer', 'rubric.md'), 'utf8')).toBe(RUBRIC);
  });

  it('in a project, names the worktree\'s folder: by its path for Claude Code, from the project root for a tool that reads nothing outside it', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const dataHome = home('.teamai', 'projects', 'project');
    await fse.ensureDir(path.join(projectRoot, '.claude'));
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    const project = { ...localConfig, scope: 'project' as const, projectRoot, dataHome, enabledAgents: ['claude', 'codebuddy'] };

    await pullAgents(project);

    expect(await fse.readFile(path.join(projectRoot, '.claude', 'agents', 'reviewer.md'), 'utf8'))
      .toContain(`against ${forward(path.join(projectRoot, '.teamai', 'delivered', 'agents', 'reviewer'))}/rubric.md and`);
    expect(await fse.readFile(path.join(projectRoot, '.codebuddy', 'agents', 'reviewer.md'), 'utf8'))
      .toContain('against .teamai/delivered/agents/reviewer/rubric.md and .teamai/delivered/agents/reviewer/examples/good.md.');
    expect(await fse.readFile(path.join(projectRoot, '.teamai', 'delivered', 'agents', 'reviewer', 'rubric.md'), 'utf8')).toBe(RUBRIC);
    expect(await fse.pathExists(path.join(dataHome, 'agents'))).toBe(false);
  });

  it('in user scope, names the data home for every tool, and warns once for a tool that cannot read it', async () => {
    await fse.ensureDir(home('.codebuddy'));
    await fse.outputFile(path.join(repoPath, 'agents', 'planner', 'AGENT.md'), 'Plan with ${TEAMAI_AGENT_DIR}/steps.md.\n');
    await fse.outputFile(path.join(repoPath, 'agents', 'planner', 'steps.md'), '1. Plan.\n');
    localConfig = { ...localConfig, enabledAgents: ['claude', 'codebuddy'] };

    await pullAgents();

    expect(await fse.readFile(home('.codebuddy', 'agents', 'reviewer.md'), 'utf8')).toContain(`${forward(home('.teamai', 'agents', 'reviewer'))}/rubric.md`);
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => String(message)).filter((message) => message.includes('user-scope agent folders'))).toEqual([
      `codebuddy may ask before it reads the files of user-scope agent folders in ${home('.teamai', 'agents')}: teamai grants it no access there, `
      + 'and a user-scope agent has no project to copy them into. Allow the directory in its settings, or share these agents from a project.',
    ]);
  });

  it('clashes with an agent file of the same name in the same place', async () => {
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer.yaml'), 'name: reviewer\ndescription: Reviews.\ninstructions: Review.\n');
    const agents = await new AgentsHandler().scanTeamForPull(teamConfig, localConfig);

    expect(filterAgentsByNamespaces(agents, null)).toMatchObject({ kind: 'conflict', conflict: { reason: 'duplicate', name: 'reviewer' } });
    expect(filterAgentsByNamespaces(agents, [])).toMatchObject({ kind: 'conflict', conflict: { reason: 'duplicate', name: 'reviewer' } });
  });

  it('proposes no push of an agent folder\'s copy, edited or not', async () => {
    await pullAgents();
    await fse.appendFile(home('.claude', 'agents', 'reviewer.md'), 'An edit.\n');

    expect(await new AgentsHandler().scanLocalForPush(teamConfig, localConfig)).toEqual([]);
  });
});

describe('TEAMAI_AGENT_DIR', () => {
  it('is a reserved team env name, so no team variable shadows it', async () => {
    const { reservedTeamEnvWarning } = await import('../env-reserved.js');

    expect(reservedTeamEnvWarning(['TEAMAI_AGENT_DIR', 'API_URL'])).toBe('TEAMAI_AGENT_DIR is reserved for the folder path teamai gives a workflow step, hook, rule, agent or MCP server; those team env values are ignored.');
  });
});
