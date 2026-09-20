import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { reconcileMcpForConfig, resolveMcpTargets } from '../mcp-reconcile.js';
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

const LOCAL_SERVER = 'team-local';
const HTTP_SERVER = 'team-http';
const USER_SERVER = 'my-own';
const MCP_YAML = `
servers:
  - name: ${LOCAL_SERVER}
    transport: stdio
    command: node
    args: ["server.mjs"]
    env:
      TEAM_MODE: enabled
    timeout: 5000
    tools: [copilot]
  - name: ${HTTP_SERVER}
    transport: http
    url: https://example.com/mcp
    headers:
      Authorization: Bearer public-test-token
    tools: [copilot]
`;

describe('Copilot MCP reconciliation', () => {
  let sandbox: string;
  let homeDir: string;
  let copilotHome: string;
  let teamRepo: string;
  let teamConfig: TeamaiConfig;
  let userConfig: LocalConfig;

  beforeEach(async () => {
    sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-copilot-mcp-'));
    homeDir = path.join(sandbox, 'home');
    copilotHome = path.join(sandbox, 'copilot-home');
    teamRepo = path.join(sandbox, 'team-repo');
    await fse.ensureDir(path.join(copilotHome, 'skills'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    await fse.ensureDir(path.join(teamRepo, 'mcp'));
    await fse.writeFile(path.join(teamRepo, 'mcp', 'mcp.yaml'), MCP_YAML);
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('COPILOT_HOME', copilotHome);
    teamConfig = TeamaiConfigSchema.parse({ team: 'copilot-mcp-test', repo: 'fixture', provider: 'git' });
    userConfig = {
      repo: { localPath: teamRepo, remote: 'fixture' },
      username: 'tester',
      scope: 'user',
      enabledAgents: ['copilot'],
      additionalRoles: [],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(sandbox);
  });

  it('renders local and HTTP servers in Copilot user schema under COPILOT_HOME', async () => {
    const configFile = path.join(copilotHome, 'mcp-config.json');
    const settingsFile = path.join(copilotHome, 'settings.json');
    const settings = '{"theme":"dark","telemetry":false}\n';
    await fse.writeJson(configFile, {
      custom: { keep: true },
      mcpServers: { [USER_SERVER]: { type: 'local', command: 'personal-server', tools: ['*'] } },
    });
    await fse.writeFile(settingsFile, settings);

    const targets = await resolveMcpTargets(teamConfig, userConfig);
    expect(targets).toContainEqual(expect.objectContaining({
      tool: 'copilot',
      file: configFile,
      projectScope: false,
    }));

    const first = await reconcileMcpForConfig(teamConfig, userConfig);
    expect(first.wrote).toBe(true);
    const after = await fse.readJson(configFile);
    expect(after.custom).toEqual({ keep: true });
    expect(after.mcpServers[USER_SERVER]).toEqual({
      type: 'local',
      command: 'personal-server',
      tools: ['*'],
    });
    expect(after.mcpServers[LOCAL_SERVER]).toEqual({
      type: 'local',
      command: 'node',
      args: ['server.mjs'],
      env: { TEAM_MODE: 'enabled' },
      tools: ['*'],
      timeout: 5000,
    });
    expect(after.mcpServers[HTTP_SERVER]).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer public-test-token' },
      tools: ['*'],
    });
    expect(await fse.readFile(settingsFile, 'utf8')).toBe(settings);

    const mtime = (await fse.stat(configFile)).mtimeMs;
    const second = await reconcileMcpForConfig(teamConfig, userConfig);
    expect(second.wrote).toBe(false);
    expect((await fse.stat(configFile)).mtimeMs).toBe(mtime);
  });

  it('targets an existing Copilot user MCP file without another resource directory', async () => {
    const configFile = path.join(copilotHome, 'mcp-config.json');
    await fse.remove(path.join(copilotHome, 'skills'));
    await fse.writeJson(configFile, { mcpServers: {} });
    const { enabledAgents: _enabledAgents, ...configWithoutSelection } = userConfig;

    const targets = await resolveMcpTargets(teamConfig, configWithoutSelection as LocalConfig);

    expect(targets).toContainEqual(expect.objectContaining({
      tool: 'copilot',
      file: configFile,
      projectScope: false,
    }));
  });

  it('targets a clean Copilot project when the agent is explicitly enabled', async () => {
    const projectRoot = path.join(sandbox, 'clean-project');
    const projectFile = path.join(projectRoot, '.github', 'mcp.json');
    const projectConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot,
    } as LocalConfig;

    const targets = await resolveMcpTargets(teamConfig, projectConfig);

    expect(targets).toContainEqual(expect.objectContaining({
      tool: 'copilot',
      file: projectFile,
      projectScope: true,
    }));
  });

  it('targets an existing Copilot project MCP file without user installation or explicit enablement', async () => {
    const projectRoot = path.join(sandbox, 'config-only-project');
    const projectFile = path.join(projectRoot, '.github', 'mcp.json');
    await fse.remove(copilotHome);
    await fse.ensureDir(path.dirname(projectFile));
    await fse.writeJson(projectFile, { mcpServers: {} });
    const { enabledAgents: _enabledAgents, ...configWithoutSelection } = userConfig;
    const projectConfig = {
      ...configWithoutSelection,
      scope: 'project',
      projectRoot,
    } as LocalConfig;

    const targets = await resolveMcpTargets(teamConfig, projectConfig);

    expect(targets).toContainEqual(expect.objectContaining({
      tool: 'copilot',
      file: projectFile,
      projectScope: true,
    }));
  });

  it('uses .github/mcp.json for project scope and leaves user configuration unchanged', async () => {
    const projectRoot = path.join(sandbox, 'project');
    const projectFile = path.join(projectRoot, '.github', 'mcp.json');
    const userFile = path.join(copilotHome, 'mcp-config.json');
    const userDocument = { mcpServers: { [USER_SERVER]: { type: 'local', command: 'personal-server' } } };
    await fse.ensureDir(path.join(projectRoot, '.github', 'skills'));
    await fse.writeJson(projectFile, {
      repositorySetting: true,
      mcpServers: { [USER_SERVER]: { type: 'local', command: 'repo-server' } },
    });
    await fse.writeJson(userFile, userDocument);
    const projectConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot,
    } as LocalConfig;

    const targets = await resolveMcpTargets(teamConfig, projectConfig);
    expect(targets).toContainEqual(expect.objectContaining({
      tool: 'copilot',
      file: projectFile,
      projectScope: true,
    }));

    await reconcileMcpForConfig(teamConfig, projectConfig);
    const after = await fse.readJson(projectFile);
    expect(after.repositorySetting).toBe(true);
    expect(after.mcpServers[USER_SERVER]).toEqual({ type: 'local', command: 'repo-server' });
    expect(after.mcpServers[LOCAL_SERVER].type).toBe('local');
    expect(after.mcpServers[LOCAL_SERVER].tools).toEqual(['*']);
    expect(after.mcpServers[HTTP_SERVER].type).toBe('http');
    expect(await fse.readJson(userFile)).toEqual(userDocument);
  });

  it('preserves a bare project server map and skips an unmanaged name collision', async () => {
    const projectRoot = path.join(sandbox, 'bare-project');
    const projectFile = path.join(projectRoot, '.github', 'mcp.json');
    const existingLocal = { type: 'local', command: 'personal-server', args: ['--user-owned'] };
    const existingUser = { type: 'http', url: 'https://user.example/mcp' };
    await fse.ensureDir(path.dirname(projectFile));
    await fse.writeJson(projectFile, {
      [LOCAL_SERVER]: existingLocal,
      [USER_SERVER]: existingUser,
    });
    const projectConfig = {
      ...userConfig,
      scope: 'project',
      projectRoot,
    } as LocalConfig;

    const result = await reconcileMcpForConfig(teamConfig, projectConfig);
    const after = await fse.readJson(projectFile);

    expect(result.changes).toContainEqual({
      tool: 'copilot',
      server: LOCAL_SERVER,
      action: 'skipped',
      reason: 'a server with this name already exists and is not managed by teamai',
    });
    expect(after[LOCAL_SERVER]).toEqual(existingLocal);
    expect(after[USER_SERVER]).toEqual(existingUser);
    expect(after[HTTP_SERVER]).toEqual(expect.objectContaining({ type: 'http' }));
    expect(after.mcpServers).toBeUndefined();
  });

  it('removes only TeamAI-owned entries when definitions disappear or removeAll is requested', async () => {
    const configFile = path.join(copilotHome, 'mcp-config.json');
    await fse.writeJson(configFile, {
      mcpServers: { [USER_SERVER]: { type: 'local', command: 'personal-server', tools: ['*'] } },
    });
    await reconcileMcpForConfig(teamConfig, userConfig);

    await fse.writeFile(path.join(teamRepo, 'mcp', 'mcp.yaml'), `
servers:
  - name: ${LOCAL_SERVER}
    transport: stdio
    command: node
    tools: [copilot]
`);
    await reconcileMcpForConfig(teamConfig, userConfig);
    let after = await fse.readJson(configFile);
    expect(after.mcpServers[HTTP_SERVER]).toBeUndefined();
    expect(after.mcpServers[LOCAL_SERVER]).toBeDefined();
    expect(after.mcpServers[USER_SERVER]).toBeDefined();

    await reconcileMcpForConfig(teamConfig, userConfig, { removeAll: true });
    after = await fse.readJson(configFile);
    expect(after.mcpServers[LOCAL_SERVER]).toBeUndefined();
    expect(after.mcpServers[USER_SERVER]).toEqual({
      type: 'local',
      command: 'personal-server',
      tools: ['*'],
    });
  });
});
