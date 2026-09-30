import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { reconcileMcpForConfig, resolveMcpTargets } from '../mcp-reconcile.js';
import { buildMcpDeliveryChecks } from '../doctor-delivery.js';
import { detectMcpFormat, renderJsonEntry, supportsTransport } from '../resources/mcp-format.js';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

const yaml = `servers:
  - name: local
    transport: stdio
    command: node
    args: [server.mjs]
    env: { MODE: test }
    timeout: 1500
    tools: [pi]
  - name: remote
    transport: http
    url: https://example.com/mcp
    headers: { Authorization: 'Bearer public-fixture' }
    tools: [pi]
  - name: legacy
    transport: sse
    url: https://example.com/sse
    tools: [pi]
`;

describe('Pi MCP', () => {
  let root: string;
  let home: string;
  let team: TeamaiConfig;
  let config: LocalConfig;
  let source: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pi-mcp-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    await fse.ensureDir(path.join(home, '.pi', 'agent'));
    source = path.join(root, 'repo', 'mcp', 'mcp.yaml');
    await fse.outputFile(source, yaml);
    team = TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git' });
    config = {
      repo: { localPath: path.join(root, 'repo'), remote: 'fixture' },
      username: 'tester', scope: 'user', enabledAgents: ['pi'], additionalRoles: [],
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  it('supports only native transports and converts timeout without rounding', () => {
    expect(detectMcpFormat('pi')).toBe('pi');
    expect(supportsTransport('pi', 'sse')).toBe(false);
    expect(supportsTransport('pi', 'http')).toBe(true);
    expect(supportsTransport('pi', 'stdio')).toBe(true);
    expect(renderJsonEntry('pi', {
      name: 'remote', transport: 'http', url: 'https://example.com/mcp', timeout: 250,
    })).toEqual({ type: 'http', url: 'https://example.com/mcp', timeout: 0.25 });
  });

  it.each(['user', 'project'] as const)('reconciles the complete %s lifecycle without touching personal servers', async (scope) => {
    const projectRoot = path.join(root, 'project');
    const local = { ...config, scope, ...(scope === 'project' ? { projectRoot } : {}) };
    const file = scope === 'user'
      ? path.join(home, '.pi/agent/mcp.json')
      : path.join(projectRoot, '.pi/mcp.json');
    const personal = { command: 'personal-server', exposure: 'direct' };
    await fse.outputJson(file, { autoEnableCodemode: false, mcpServers: { personal } });
    expect(await resolveMcpTargets(team, local)).toContainEqual(expect.objectContaining({
      tool: 'pi', file, projectScope: scope === 'project',
    }));
    const dry = await reconcileMcpForConfig(team, local, { dryRun: true });
    expect(dry.wrote).toBe(false);
    expect((await fse.readJson(file)).mcpServers).toEqual({ personal });
    const first = await reconcileMcpForConfig(team, local);
    expect(first.changes).toContainEqual({ tool: 'pi', server: 'legacy', action: 'skipped', reason: 'pi does not support sse transport' });
    const result = await fse.readJson(file);
    expect(result).toEqual({ autoEnableCodemode: false, mcpServers: {
      personal,
      local: { type: 'stdio', command: 'node', args: ['server.mjs'], env: { MODE: 'test' }, timeout: 1.5 },
      remote: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer public-fixture' } },
    } });
    expect((await reconcileMcpForConfig(team, local)).wrote).toBe(false);
    // Pi's UI can edit managed entries. Unchanged definitions retain those edits;
    // a changed team definition replaces the entry under the shared ownership policy.
    result.mcpServers.local.exposure = 'direct';
    result.mcpServers.local.enabled = false;
    await fse.writeJson(file, result);
    expect((await reconcileMcpForConfig(team, local)).wrote).toBe(false);
    expect((await fse.readJson(file)).mcpServers.local.enabled).toBe(false);
    await fse.writeFile(source, yaml.replace('1500', '2500'));
    await reconcileMcpForConfig(team, local);
    expect((await fse.readJson(file)).mcpServers.local).toEqual({
      type: 'stdio', command: 'node', args: ['server.mjs'], env: { MODE: 'test' }, timeout: 2.5,
    });
    await fse.writeFile(source, 'servers: []\n');
    await reconcileMcpForConfig(team, local);
    expect(await fse.readJson(file)).toEqual({ autoEnableCodemode: false, mcpServers: { personal } });
    await fse.writeFile(source, yaml);
    await reconcileMcpForConfig(team, local);
    await reconcileMcpForConfig(team, local, { removeAll: true });
    expect(await fse.readJson(file)).toEqual({ autoEnableCodemode: false, mcpServers: { personal } });
    const otherFile = scope === 'user' ? path.join(projectRoot, '.pi/mcp.json') : path.join(home, '.pi/agent/mcp.json');
    expect(await fse.pathExists(otherFile)).toBe(false);
  });


  it('doctor reports unsupported SSE and local edits, and accepts the delivered definition', async () => {
    const context = { localConfig: config, teamConfig: team, toolPaths: team.toolPaths, hookToolPaths: team.toolPaths, baseDir: home };
    const check = async () => {
      const checks = await buildMcpDeliveryChecks(context);
      const pi = checks.find((item) => item.name === 'MCP servers delivered to pi');
      expect(pi).toBeDefined();
      return pi!;
    };
    await reconcileMcpForConfig(team, config);
    expect((await check()).fix).toContain('pi does not support sse transport');
    await fse.writeFile(source, yaml.slice(0, yaml.indexOf('  - name: legacy')));
    expect(await (await check()).check()).toBe(true);
    const file = path.join(home, '.pi/agent/mcp.json');
    const document = await fse.readJson(file);
    document.mcpServers.local.exposure = 'direct';
    await fse.writeJson(file, document);
    expect(await (await check()).check()).toBe(false);
    expect((await check()).fix).toContain("not the team's definition: local");
  });

  it('protects collisions until force is requested', async () => {
    const file = path.join(home, '.pi/agent/mcp.json');
    await fse.writeJson(file, { mcpServers: { local: { command: 'mine' } } });
    const result = await reconcileMcpForConfig(team, config);
    expect(result.changes).toContainEqual(expect.objectContaining({ tool: 'pi', server: 'local', action: 'skipped' }));
    expect((await fse.readJson(file)).mcpServers.local.command).toBe('mine');
    await reconcileMcpForConfig(team, config, { force: true });
    expect((await fse.readJson(file)).mcpServers.local.command).toBe('node');
  });
});
