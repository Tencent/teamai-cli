import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let tmpDir: string;
let origHome: string | undefined;
let origCopilotHome: string | undefined;

const COPILOT_SERVER = 'copilot-enterprise';

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-test-'));
  origHome = process.env.HOME;
  origCopilotHome = process.env.COPILOT_HOME;
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
  if (origCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = origCopilotHome;
  await fse.remove(tmpDir);
  vi.restoreAllMocks();
});

async function setupConfig(bindings: Record<string, unknown> = {}): Promise<void> {
  const configDir = path.join(tmpDir, '.teamai', 'local-agent');
  await fse.ensureDir(configDir);
  await fse.writeJson(path.join(configDir, 'config.json'), {
    endpoint: 'https://test.example.com/api',
    token: 'test-token',
    localAgentId: 'test-agent-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceBindings: bindings,
  });
}

async function runResponse(
  body: Record<string, unknown>,
  tool: string = 'codebuddy',
  cwd: string = tmpDir,
): Promise<Array<Record<string, unknown>>> {
  // 确保 tool 目录存在，使 isToolInstalled 检查通过
  await fse.ensureDir(path.join(tmpDir, `.${tool}`, 'skills'));
  await setupConfig();
  const acks: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('/local-agent/sync')) {
      return new Response(JSON.stringify({ ok: true, ...body }));
    }
    if (url.includes('/commands/ack')) {
      acks.push(JSON.parse(init?.body ?? '{}'));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const { reportAndSyncLocalAgent } = await import('../local-agent.js');
  await reportAndSyncLocalAgent({ cwd, tool, status: 'running' });
  return acks;
}

describe('local-agent: MCP install/uninstall commands', () => {

  it('installs and removes Pi MCP with native transport and timeout units', async () => {
    const file = path.join(tmpDir, '.pi', 'agent', 'mcp.json');
    const acks = await runResponse({ cmds: [{
      id: 8980, type: 'install_mcp', scope: 'user', slug: 'pi-fixture', version: '1',
      mcp_config: { transport: 'http', url: 'https://example.com/mcp', timeout: 1500 },
    }] }, 'pi');
    expect(acks[0].status).toBe('success');
    expect((await fse.readJson(file)).mcpServers['pi-fixture']).toEqual({
      type: 'http', url: 'https://example.com/mcp', timeout: 1.5,
    });
    const removed = await runResponse({ cmds: [{
      id: 8981, type: 'uninstall_mcp', scope: 'user', slug: 'pi-fixture', version: '1',
    }] }, 'pi');
    expect(removed[0].status).toBe('success');
    expect((await fse.readJson(file)).mcpServers).toEqual({});
  });

  it('uses COPILOT_HOME for user-scope install and uninstall', async () => {
    const copilotHome = path.join(tmpDir, 'custom-copilot-home');
    const configFile = path.join(copilotHome, 'mcp-config.json');
    process.env.COPILOT_HOME = copilotHome;

    let acks = await runResponse({
      cmds: [{
        id: 8990,
        type: 'install_mcp',
        scope: 'user',
        slug: COPILOT_SERVER,
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://copilot.example.com/mcp',
        },
      }],
    }, 'copilot');

    expect(acks[0].status).toBe('success');
    expect(await fse.pathExists(path.join(tmpDir, 'mcp-config.json'))).toBe(false);
    let document = await fse.readJson(configFile);
    expect(document.mcpServers[COPILOT_SERVER]).toEqual({
      type: 'http',
      tools: ['*'],
      url: 'https://copilot.example.com/mcp',
    });

    acks = await runResponse({
      cmds: [{
        id: 8991,
        type: 'uninstall_mcp',
        scope: 'user',
        slug: COPILOT_SERVER,
        version: '1.0.0',
      }],
    }, 'copilot');

    expect(acks[0].status).toBe('success');
    document = await fse.readJson(configFile);
    expect(document.mcpServers[COPILOT_SERVER]).toBeUndefined();
  });

  it('preserves a bare Copilot project map through install and uninstall', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-project');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    const userServer = { type: 'http', url: 'https://user.example.com/mcp' };
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, { 'user-server': userServer });

    let acks = await runResponse({
      cmds: [{
        id: 8992,
        type: 'install_mcp',
        scope: 'workspace',
        workspace_path: workspacePath,
        slug: COPILOT_SERVER,
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://copilot.example.com/mcp',
        },
      }],
    }, 'copilot');

    expect(acks[0].status).toBe('success');
    let document = await fse.readJson(configFile);
    expect(document['user-server']).toEqual(userServer);
    expect(document[COPILOT_SERVER]).toEqual(expect.objectContaining({ type: 'http' }));
    expect(document.mcpServers).toBeUndefined();

    acks = await runResponse({
      cmds: [{
        id: 8993,
        type: 'uninstall_mcp',
        scope: 'workspace',
        workspace_path: workspacePath,
        slug: COPILOT_SERVER,
        version: '1.0.0',
      }],
    }, 'copilot');

    expect(acks[0].status).toBe('success');
    document = await fse.readJson(configFile);
    expect(document).toEqual({ 'user-server': userServer });
  });

  it('uninstalls a bare Copilot project entry once another tool has written mcpServers into the file', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-shared-project');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    const userServer = { type: 'http', url: 'https://user.example.com/mcp' };
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, { 'user-server': userServer });
    const command = { scope: 'workspace', workspace_path: workspacePath, slug: COPILOT_SERVER, version: '1.0.0' };
    let acks = await runResponse({
      cmds: [{ id: 8995, type: 'install_mcp', ...command, mcp_config: { transport: 'http', url: 'https://copilot.example.com/mcp' } }],
    }, 'copilot');
    expect(acks[0].status).toBe('success');
    const other = { mcpServers: { claude: { type: 'http', url: 'https://claude.example.com/mcp' } } };
    await fse.writeJson(configFile, { ...await fse.readJson(configFile), ...other });

    acks = await runResponse({ cmds: [{ id: 8996, type: 'uninstall_mcp', ...command }] }, 'copilot');

    expect(acks[0].status).toBe('success');
    expect(await fse.readJson(configFile)).toEqual({ 'user-server': userServer, ...other });
  });

  it('replaces a bare Copilot project entry it installs again once another tool has written mcpServers into the file', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-reinstall-project');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, {});
    const command = { scope: 'workspace', workspace_path: workspacePath, slug: COPILOT_SERVER };
    let acks = await runResponse({
      cmds: [{ id: 8997, type: 'install_mcp', ...command, version: '1.0.0', mcp_config: { transport: 'http', url: 'https://old.example.com/mcp' } }],
    }, 'copilot');
    expect(acks[0].status).toBe('success');
    const other = { mcpServers: { claude: { type: 'http', url: 'https://claude.example.com/mcp' } } };
    await fse.writeJson(configFile, { ...await fse.readJson(configFile), ...other });

    acks = await runResponse({
      cmds: [{ id: 8998, type: 'install_mcp', ...command, version: '1.0.1', mcp_config: { transport: 'http', url: 'https://new.example.com/mcp' } }],
    }, 'copilot');

    expect(acks[0].status).toBe('success');
    const doc = await fse.readJson(configFile) as Record<string, unknown>;
    expect(doc[COPILOT_SERVER]).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('old.example.com');
    expect((doc.mcpServers as Record<string, unknown>)[COPILOT_SERVER]).toEqual(expect.objectContaining({ url: 'https://new.example.com/mcp' }));
  });

  it('preserves an identical member-owned bare Copilot entry through install, update and uninstall', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-identical-member');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    const mine = { type: 'http', tools: ['*'], url: 'https://copilot.example.com/mcp' };
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, { [COPILOT_SERVER]: mine, mcpServers: {} });
    for (const [id, type] of [[8995, 'install_mcp'], [8996, 'install_mcp'], [8997, 'uninstall_mcp']] as const) {
      const acks = await runResponse({ cmds: [{
        id, type, scope: 'workspace', workspace_path: workspacePath,
        slug: COPILOT_SERVER, version: '1.0.0',
        mcp_config: { transport: 'http', url: mine.url },
      }] }, 'copilot');
      expect(acks[0].status).toBe('success');
      expect((await fse.readJson(configFile))[COPILOT_SERVER]).toEqual(mine);
    }
    expect((await fse.readJson(configFile)).mcpServers[COPILOT_SERVER]).toBeUndefined();
  });

  it.each(['install_mcp', 'uninstall_mcp'] as const)('preserves a member-owned keyed Copilot entry after a bare install during %s', async (type) => {
    const workspacePath = path.join(tmpDir, 'copilot-keyed-member');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeFile(configFile, '');
    const command = {
      id: 9010, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0',
      mcp_config: { transport: 'http', url: 'https://team.example/mcp' },
    };
    expect((await runResponse({ cmds: [command] }, 'copilot'))[0].status).toBe('success');
    const doc = await fse.readJson(configFile);
    const mine = { type: 'http', tools: ['*'], url: 'https://member.example/mcp' };
    await fse.writeJson(configFile, { ...doc, mcpServers: { [COPILOT_SERVER]: mine } });

    const acks = await runResponse({ cmds: [{ ...command, id: 9011, type }] }, 'copilot');

    expect((await fse.readJson(configFile)).mcpServers[COPILOT_SERVER]).toEqual(mine);
    if (type === 'install_mcp') {
      expect(acks[0].status).toBe('failed');
      expect(acks[0].error).toContain('not managed by teamai');
      expect((await fse.readJson(configFile))[COPILOT_SERVER]).toEqual(doc[COPILOT_SERVER]);
    } else {
      expect(acks[0].status).toBe('success');
      expect((await fse.readJson(configFile))[COPILOT_SERVER]).toBeUndefined();
    }
  });

  it.each([
    ['legacy', 'install_mcp', false], ['legacy', 'uninstall_mcp', false],
    ['failed placement write', 'install_mcp', false], ['failed placement write', 'uninstall_mcp', false],
    ['legacy', 'install_mcp', true], ['legacy', 'uninstall_mcp', true],
    ['failed placement write', 'install_mcp', true], ['failed placement write', 'uninstall_mcp', true],
  ] as const)('preserves a keyed member entry after an unmarked bare install from %s during %s, identical=%s', async (source, type, identical) => {
    const workspacePath = path.join(tmpDir, 'copilot-unmarked-member');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeFile(configFile, '');
    const command = {
      id: 9020, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0',
      mcp_config: { transport: 'http', url: 'https://team.example/mcp' },
    };
    const fs = await import('../utils/fs.js');
    const write = fs.writeJsonAtomic;
    let writes = 0;
    const spy = vi.spyOn(fs, 'writeJsonAtomic').mockImplementation(async (file, ...args) => {
      if (source === 'failed placement write' && file.endsWith('/managed-mcp.json') && ++writes === 2) {
        throw new Error('simulated placement write failure');
      }
      return write(file, ...args);
    });
    const installed = await runResponse({ cmds: [command] }, 'copilot');
    spy.mockRestore();
    expect(installed[0].status).toBe(source === 'legacy' ? 'success' : 'failed');
    if (source === 'failed placement write') expect(installed[0].error).toContain('simulated placement write failure');
    const wsDir = path.join(workspacePath, '.teamai', 'workspaces');
    const [id] = await fse.readdir(wsDir);
    const manifestFile = path.join(wsDir, id, 'managed-mcp.json');
    const manifest = await fse.readJson(manifestFile);
    if (source === 'legacy') {
      delete manifest['copilot:project'][0].bare;
      await fse.writeJson(manifestFile, manifest);
    }
    expect((await fse.readJson(manifestFile))['copilot:project'][0].bare).toBeUndefined();
    const doc = await fse.readJson(configFile);
    const mine = identical ? doc[COPILOT_SERVER] : { type: 'http', tools: ['*'], url: 'https://member.example/mcp' };
    await fse.writeJson(configFile, { ...doc, mcpServers: { [COPILOT_SERVER]: mine } });

    const acks = await runResponse({ cmds: [{ ...command, id: 9021, type }] }, 'copilot');

    expect((await fse.readJson(configFile)).mcpServers[COPILOT_SERVER]).toEqual(mine);
    expect((await fse.readJson(configFile))[COPILOT_SERVER]).toEqual(doc[COPILOT_SERVER]);
    expect(acks[0].status).toBe(type === 'install_mcp' ? 'failed' : 'success');
    if (type === 'install_mcp') expect(acks[0].error).toContain('not managed by teamai');
  });

  it('updates a legacy keyed Copilot entry with matching content and records keyed placement', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-legacy-keyed');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, { mcpServers: {} });
    const command = {
      id: 9030, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0',
      mcp_config: { transport: 'http', url: 'https://team.example/mcp' },
    };
    expect((await runResponse({ cmds: [command] }, 'copilot'))[0].status).toBe('success');
    const wsDir = path.join(workspacePath, '.teamai', 'workspaces');
    const [id] = await fse.readdir(wsDir);
    const manifestFile = path.join(wsDir, id, 'managed-mcp.json');
    const manifest = await fse.readJson(manifestFile);
    expect(manifest['copilot:project'][0].bare).toBe(false);
    delete manifest['copilot:project'][0].bare;
    await fse.writeJson(manifestFile, manifest);

    const updated = await runResponse({ cmds: [{ ...command, id: 9031, mcp_config: { transport: 'http', url: 'https://team.example/updated' } }] }, 'copilot');

    expect(updated[0].status).toBe('success');
    expect((await fse.readJson(configFile)).mcpServers[COPILOT_SERVER].url).toBe('https://team.example/updated');
    expect((await fse.readJson(manifestFile))['copilot:project'][0].bare).toBe(false);
    expect((await runResponse({ cmds: [{ ...command, id: 9032, type: 'uninstall_mcp' }] }, 'copilot'))[0].status).toBe('success');
    expect((await fse.readJson(configFile)).mcpServers[COPILOT_SERVER]).toBeUndefined();
  });

  it.each((['proven bare', 'proven bare migration', 'legacy bare', 'proven keyed', 'legacy keyed'] as const)
    .flatMap((source) => (['config', 'manifest'] as const)
      .flatMap((failure) => (['retry', 'uninstall'] as const).map((next) => [source, failure, next] as const))))(
    'preserves ownership for %s after a %s write fails, then allows %s', async (source, failure, next) => {
    const workspacePath = path.join(tmpDir, 'copilot-failed-update');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    execFileSync('git', ['init', '-q'], { cwd: workspacePath });
    await fse.writeFile(configFile, source.includes('bare') ? '' : '{"mcpServers":{}}');
    const command = {
      id: 9040, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0',
      mcp_config: { transport: 'http', url: 'https://team.example/mcp', headers: { Authorization: 'Bearer fixture-old' } },
    };
    expect((await runResponse({ cmds: [command] }, 'copilot'))[0].status).toBe('success');
    const wsDir = path.join(workspacePath, '.teamai', 'workspaces');
    const [id] = await fse.readdir(wsDir);
    const manifestFile = path.join(wsDir, id, 'managed-mcp.json');
    const before = await fse.readJson(manifestFile);
    if (source.startsWith('legacy')) {
      delete before['copilot:project'][0].bare;
      await fse.writeJson(manifestFile, before);
    }
    if (source === 'proven bare migration') {
      await fse.writeJson(configFile, { ...(await fse.readJson(configFile)), mcpServers: { mine: { command: 'member-server' } } });
    }
    const original = await fse.readJson(configFile);
    const replacement = { ...command, id: 9041, mcp_config: { transport: 'stdio', command: 'replacement-server' } };
    const fs = await import('../utils/fs.js');
    const write = fs.writeJsonAtomic;
    let configWritten = false;
    const spy = vi.spyOn(fs, 'writeJsonAtomic').mockImplementation(async (file, ...args) => {
      if (failure === 'config' && file.endsWith('/.github/mcp.json')) throw new Error('simulated MCP config write failure');
      if (failure === 'manifest' && file.endsWith('/managed-mcp.json') && configWritten) throw new Error('simulated manifest write failure');
      await write(file, ...args);
      if (file.endsWith('/.github/mcp.json')) configWritten = true;
    });

    const failed = await runResponse({ cmds: [replacement] }, 'copilot');
    spy.mockRestore();
    const afterFailure = await fse.readJson(manifestFile);
    expect(failed[0].status).toBe('failed');
    expect(failed[0].error).toContain(failure === 'config' ? 'simulated MCP config write failure' : 'simulated manifest write failure');
    expect(await fse.readJson(configFile)).toEqual(original);
    if (source === 'proven bare') {
      await fse.writeJson(configFile, { ...original, mcpServers: { mine: { command: 'member-server' } } });
    }

    const resumed = await runResponse({ cmds: [{ ...replacement, id: 9042, type: next === 'retry' ? 'install_mcp' : 'uninstall_mcp' }] }, 'copilot');

    expect(resumed[0].status).toBe('success');
    const after = await fse.readJson(configFile);
    if (next === 'uninstall') {
      expect(after[COPILOT_SERVER]).toBeUndefined();
      expect(after.mcpServers?.[COPILOT_SERVER]).toBeUndefined();
    } else {
      expect(JSON.stringify(after)).not.toContain('fixture-old');
      expect(JSON.stringify(after)).toContain('replacement-server');
      if (source.startsWith('proven bare')) expect(after[COPILOT_SERVER]).toBeUndefined();
    }
    if (source.startsWith('proven bare')) expect(after.mcpServers.mine).toEqual({ command: 'member-server' });
    expect(afterFailure).toEqual(before);
  });

  it.each((['copilot bare', 'copilot keyed', 'codebuddy keyed', 'codex user'] as const)
    .flatMap((source) => (['config', 'manifest'] as const).map((failure) => [source, failure] as const)))(
    'allows retrying uninstall of %s after a %s write fails', async (source, failure) => {
    const tool = source.split(' ')[0];
    const workspacePath = path.join(tmpDir, 'failed-uninstall');
    const configFile = source === 'codex user' ? path.join(tmpDir, '.codex', 'config.toml')
      : path.join(workspacePath, tool === 'copilot' ? '.github/mcp.json' : '.mcp.json');
    await fse.ensureDir(path.dirname(configFile));
    if (tool !== 'codex') await fse.writeFile(configFile, source === 'copilot bare' ? '' : '{"mcpServers":{}}');
    const command = {
      id: 9050, type: 'install_mcp', scope: tool === 'codex' ? 'user' : 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0', mcp_config: { transport: 'stdio', command: 'team-server' },
    };
    expect((await runResponse({ cmds: [command] }, tool))[0].status).toBe('success');
    const wsDir = path.join(workspacePath, '.teamai', 'workspaces');
    const manifestFile = tool === 'codex' ? path.join(tmpDir, '.teamai', 'managed-mcp.json')
      : path.join(wsDir, (await fse.readdir(wsDir))[0], 'managed-mcp.json');
    const before = await fse.readJson(manifestFile);
    const original = await fse.readFile(configFile, 'utf-8');
    const fs = await import('../utils/fs.js');
    const write = fs.writeJsonAtomic;
    const spy = vi.spyOn(fs, 'writeJsonAtomic').mockImplementation(async (file, ...args) => {
      if ((failure === 'config' && file.endsWith(tool === 'copilot' ? '/.github/mcp.json' : '/.mcp.json')) || (failure === 'manifest' && file.endsWith('/managed-mcp.json'))) {
        throw new Error(`simulated ${failure} write failure`);
      }
      return write(file, ...args);
    });
    const reconcile = await import('../mcp-reconcile.js');
    const codexWrite = reconcile.writeCodexAtomic;
    const codexSpy = vi.spyOn(reconcile, 'writeCodexAtomic').mockImplementation(async (...args) => {
      if (failure === 'config') throw new Error('simulated config write failure');
      return codexWrite(...args);
    });
    const removal = { ...command, id: 9051, type: 'uninstall_mcp' };

    const failed = await runResponse({ cmds: [removal] }, tool);
    spy.mockRestore();
    codexSpy.mockRestore();

    expect(failed[0].status).toBe('failed');
    expect(failed[0].error).toContain(`simulated ${failure} write failure`);
    expect(await fse.readJson(manifestFile)).toEqual(before);
    expect(await fse.readFile(configFile, 'utf-8')).toBe(original);
    expect((await runResponse({ cmds: [{ ...removal, id: 9052 }] }, tool))[0].status).toBe('success');
    expect(await fse.readFile(configFile, 'utf-8')).not.toContain('team-server');
  });

  it('keeps ownership when uninstall cannot parse the config, then removes the repaired entry', async () => {
    const workspacePath = path.join(tmpDir, 'malformed-uninstall');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(workspacePath);
    const command = {
      id: 9060, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0', mcp_config: { transport: 'stdio', command: 'team-server' },
    };
    expect((await runResponse({ cmds: [command] }, 'copilot'))[0].status).toBe('success');
    const wsDir = path.join(workspacePath, '.teamai', 'workspaces');
    const manifestFile = path.join(wsDir, (await fse.readdir(wsDir))[0], 'managed-mcp.json');
    const before = await fse.readJson(manifestFile);
    const original = await fse.readFile(configFile, 'utf-8');
    await fse.writeFile(configFile, '{invalid config');
    const removal = { ...command, id: 9061, type: 'uninstall_mcp' };

    const failed = await runResponse({ cmds: [removal] }, 'copilot');

    expect(failed[0].status).toBe('failed');
    expect(failed[0].error).toContain('cannot parse');
    expect(await fse.readJson(manifestFile)).toEqual(before);
    expect(await fse.readFile(configFile, 'utf-8')).toBe('{invalid config');
    await fse.writeFile(configFile, original);
    expect((await runResponse({ cmds: [{ ...removal, id: 9062 }] }, 'copilot'))[0].status).toBe('success');
    expect(await fse.readFile(configFile, 'utf-8')).not.toContain('team-server');
  });

  it.each(['install_mcp', 'uninstall_mcp'] as const)(
    'keeps Codex config and ownership when %s cannot read the config', async (type) => {
    const configFile = path.join(tmpDir, '.codex', 'config.toml');
    const command = {
      id: 9070, type: 'install_mcp', scope: 'user', slug: COPILOT_SERVER, version: '1.0.0',
      mcp_config: { transport: 'stdio', command: 'team-server' },
    };
    expect((await runResponse({ cmds: [command] }, 'codex'))[0].status).toBe('success');
    const manifestFile = path.join(tmpDir, '.teamai', 'managed-mcp.json');
    const before = await fse.readJson(manifestFile);
    const original = await fse.readFile(configFile, 'utf-8');
    const read = fse.readFile;
    const spy = vi.spyOn(fse, 'readFile').mockImplementation((file, ...args) => {
      if (String(file).endsWith('/.codex/config.toml')) return Promise.reject(new Error('simulated config read failure'));
      return read(file, ...args);
    });

    const failed = await runResponse({ cmds: [{ ...command, id: 9071, type }] }, 'codex');
    spy.mockRestore();

    expect(failed[0].status).toBe('failed');
    expect(failed[0].error).toContain('simulated config read failure');
    expect(await fse.readJson(manifestFile)).toEqual(before);
    expect(await fse.readFile(configFile, 'utf-8')).toBe(original);
    expect((await runResponse({ cmds: [{ ...command, id: 9072, type }] }, 'codex'))[0].status).toBe('success');
  });

  it.each(['install_mcp', 'uninstall_mcp'] as const)(
    'reports both failures when %s cannot restore a config after its manifest write fails', async (type) => {
    const workspacePath = path.join(tmpDir, 'failed-restoration');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    await fse.ensureDir(workspacePath);
    const command = {
      id: 9080, type: 'install_mcp', scope: 'workspace', workspace_path: workspacePath,
      slug: COPILOT_SERVER, version: '1.0.0', mcp_config: { transport: 'stdio', command: 'team-server' },
    };
    expect((await runResponse({ cmds: [command] }, 'copilot'))[0].status).toBe('success');
    const original = await fse.readJson(configFile);
    const fs = await import('../utils/fs.js');
    const write = fs.writeJsonAtomic;
    let configWritten = false;
    const spy = vi.spyOn(fs, 'writeJsonAtomic').mockImplementation(async (file, ...args) => {
      if (file.endsWith('/managed-mcp.json')) throw new Error('simulated manifest write failure');
      if (file.endsWith('/.github/mcp.json') && configWritten) throw new Error('simulated restoration failure');
      await write(file, ...args);
      if (file.endsWith('/.github/mcp.json')) configWritten = true;
    });
    const retry = { ...command, id: 9081, type, mcp_config: { transport: 'stdio', command: 'replacement-server' } };

    const failed = await runResponse({ cmds: [retry] }, 'copilot');
    spy.mockRestore();

    expect(failed[0].status).toBe('failed');
    expect(failed[0].error).toContain('simulated manifest write failure');
    expect(failed[0].error).toContain('simulated restoration failure');
    expect(failed[0].error).toContain('The config may not match');
    await fse.writeJson(configFile, original);
    expect((await runResponse({ cmds: [{ ...retry, id: 9082 }] }, 'copilot'))[0].status).toBe('success');
  });

  it('rejects an unmanaged collision in a bare Copilot project map', async () => {
    const workspacePath = path.join(tmpDir, 'copilot-collision-project');
    const configFile = path.join(workspacePath, '.github', 'mcp.json');
    const existingServer = { type: 'http', url: 'https://user.example.com/mcp' };
    await fse.ensureDir(path.dirname(configFile));
    await fse.writeJson(configFile, { [COPILOT_SERVER]: existingServer });

    const acks = await runResponse({
      cmds: [{
        id: 8994,
        type: 'install_mcp',
        scope: 'workspace',
        workspace_path: workspacePath,
        slug: COPILOT_SERVER,
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://enterprise.example.com/mcp',
        },
      }],
    }, 'copilot');

    expect(acks[0].status).toBe('failed');
    expect(acks[0].error).toContain('not managed by teamai');
    expect(await fse.readJson(configFile)).toEqual({ [COPILOT_SERVER]: existingServer });
  });

  // ─── install_mcp: HTTP transport (user scope) ─────────────────────
  it('install_mcp writes server to tool MCP config and acks success', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 9001,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        display_name: 'ClawPro',
        mcp_config: {
          transport: 'http',
          url: 'https://clawpro.example.com/api/mcp/builtin/clawpro',
          headers: { Authorization: 'Bearer bmcp-test-token' },
        },
      }],
    });

    // ACK 成功
    expect(acks).toHaveLength(1);
    expect(acks[0].id).toBe(9001);
    expect(acks[0].type).toBe('install_mcp');
    expect(acks[0].status).toBe('success');
    expect(acks[0].version).toBe('1.0.0');

    // MCP 配置已写入 tool config
    const mcpConfig = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    expect(mcpConfig.mcpServers.clawpro).toBeDefined();
    expect(mcpConfig.mcpServers.clawpro.url).toBe('https://clawpro.example.com/api/mcp/builtin/clawpro');
    expect(mcpConfig.mcpServers.clawpro.type).toBe('http');
    expect(mcpConfig.mcpServers.clawpro.headers.Authorization).toBe('Bearer bmcp-test-token');

    // managed-mcp manifest 记录了 ownership
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'managed-mcp.json'));
    expect(manifest.codebuddy).toBeDefined();
    expect(manifest.codebuddy).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'clawpro' })]),
    );
  });

  // A member who relocated Claude Code's root records it in the local config;
  // the user-scope MCP file then lives inside that root (~/.claude-work/
  // .claude.json), where a `teamai pull` would also write it.
  it('install_mcp follows a relocated Claude Code root', async () => {
    const relocated = path.join(tmpDir, '.claude-work');
    await fse.ensureDir(path.join(relocated, 'skills'));
    await fse.outputFile(path.join(tmpDir, '.teamai', 'config.yaml'), [
      'repo:',
      `  localPath: ${path.join(tmpDir, '.teamai', 'team-repo')}`,
      '  remote: https://git.example.com/team/repo.git',
      'username: tester',
      'scope: user',
      'toolRoots:',
      `  claude: ${relocated}`,
      '',
    ].join('\n'));

    const acks = await runResponse({
      cmds: [{
        id: 9002,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        mcp_config: { transport: 'http', url: 'https://clawpro.example.com/mcp' },
      }],
    }, 'claude');

    expect(acks[0].status).toBe('success');
    const mcpConfig = await fse.readJson(path.join(relocated, '.claude.json'));
    expect(mcpConfig.mcpServers.clawpro).toEqual(expect.objectContaining({ type: 'http' }));
    // The default location is where a Claude Code with CLAUDE_CONFIG_DIR set
    // never looks, so nothing may be written there.
    expect(await fse.pathExists(path.join(tmpDir, '.claude.json'))).toBe(false);
  });

  // ─── install_mcp: stdio transport ─────────────────────────────────
  it('install_mcp handles stdio transport correctly', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 9010,
        type: 'install_mcp',
        scope: 'user',
        slug: 'local-tools',
        version: '2.0.0',
        mcp_config: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@example/mcp-server'],
          env: { EXAMPLE_TOKEN: 'secret-123' },
        },
      }],
    });

    expect(acks[0].status).toBe('success');

    const mcpConfig = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    const server = mcpConfig.mcpServers['local-tools'];
    expect(server).toBeDefined();
    expect(server.type).toBeUndefined();
    expect(server.command).toBe('npx');
    expect(server.args).toEqual(['-y', '@example/mcp-server']);
    expect(server.env.EXAMPLE_TOKEN).toBe('secret-123');
  });

  // ─── install_mcp: 幂等覆盖 ────────────────────────────────────────
  it('install_mcp idempotently overwrites a previously managed server', async () => {
    // 第一次安装
    await runResponse({
      cmds: [{
        id: 9002,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://old.example.com/mcp',
        },
      }],
    });

    // 第二次安装（更新 URL）
    const acks = await runResponse({
      cmds: [{
        id: 9003,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '2.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://new.example.com/mcp',
        },
      }],
    });

    expect(acks[0].status).toBe('success');
    expect(acks[0].version).toBe('2.0.0');

    const mcpConfig = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    expect(mcpConfig.mcpServers.clawpro.url).toBe('https://new.example.com/mcp');
  });

  // ─── install_mcp: 拒绝覆盖用户自有 server ─────────────────────────
  it('install_mcp refuses to overwrite a user-owned server', async () => {
    // 预先写入一个用户手动创建的 server（不在 managed-mcp 中）
    const mcpPath = path.join(tmpDir, '.codebuddy', 'mcp.json');
    await fse.ensureDir(path.dirname(mcpPath));
    await fse.writeJson(mcpPath, {
      mcpServers: {
        'my-server': { type: 'http', url: 'https://user.example.com/mcp' },
      },
    });

    const acks = await runResponse({
      cmds: [{
        id: 9004,
        type: 'install_mcp',
        scope: 'user',
        slug: 'my-server',
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://enterprise.example.com/mcp',
        },
      }],
    });

    expect(acks[0].status).toBe('failed');
    expect(acks[0].error).toContain('not managed by teamai');

    // 用户的配置未被修改
    const mcpConfig = await fse.readJson(mcpPath);
    expect(mcpConfig.mcpServers['my-server'].url).toBe('https://user.example.com/mcp');
  });

  // ─── install_mcp: 无效 transport 拒绝 ─────────────────────────────
  it('install_mcp rejects unsupported transport', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 9011,
        type: 'install_mcp',
        scope: 'user',
        slug: 'bad-transport',
        version: '1.0.0',
        mcp_config: {
          transport: 'grpc',
          url: 'grpc://example.com:443',
        },
      }],
    });

    expect(acks[0].status).toBe('failed');
    expect(acks[0].error).toContain('unsupported transport');
  });

  // ─── uninstall_mcp: 正常卸载 ──────────────────────────────────────
  it('uninstall_mcp removes a managed server and acks success', async () => {
    // 先安装
    await runResponse({
      cmds: [{
        id: 9005,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://clawpro.example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      }],
    });

    // 验证安装成功
    const before = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    expect(before.mcpServers.clawpro).toBeDefined();

    // 卸载
    const acks = await runResponse({
      cmds: [{
        id: 9006,
        type: 'uninstall_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
      }],
    });

    expect(acks[0].status).toBe('success');

    // server 已从 tool config 移除
    const after = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    expect(after.mcpServers.clawpro).toBeUndefined();

    // manifest 也已清理
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'managed-mcp.json'));
    expect(manifest.codebuddy).toBeUndefined();
  });

  // ─── uninstall_mcp: 幂等（目标不存在） ─────────────────────────────
  it('uninstall_mcp is idempotent when target does not exist', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 9007,
        type: 'uninstall_mcp',
        scope: 'user',
        slug: 'nonexistent',
        version: '1.0.0',
      }],
    });

    expect(acks[0].status).toBe('success');
  });

  // ─── uninstall_mcp: 不删除用户自有 server ──────────────────────────
  it('uninstall_mcp does not remove a user-owned server', async () => {
    const mcpPath = path.join(tmpDir, '.codebuddy', 'mcp.json');
    await fse.ensureDir(path.dirname(mcpPath));
    await fse.writeJson(mcpPath, {
      mcpServers: {
        'user-server': { type: 'http', url: 'https://user.example.com/mcp' },
      },
    });

    const acks = await runResponse({
      cmds: [{
        id: 9008,
        type: 'uninstall_mcp',
        scope: 'user',
        slug: 'user-server',
        version: '1.0.0',
      }],
    });

    // 幂等成功（因为不在 manifest 中）
    expect(acks[0].status).toBe('success');

    // 用户的 server 没有被删除
    const mcpConfig = await fse.readJson(mcpPath);
    expect(mcpConfig.mcpServers['user-server']).toBeDefined();
  });

  // ─── install_mcp: workspace scope ──────────────────────────────────
  it('install_mcp writes to workspace-scoped config', async () => {
    const wsPath = path.join(tmpDir, 'projects', 'repo-a');
    await fse.ensureDir(path.join(wsPath, '.codebuddy', 'skills'));

    const acks = await runResponse({
      cmds: [{
        id: 9009,
        type: 'install_mcp',
        scope: 'workspace',
        workspace_path: wsPath,
        slug: 'enterprise-search',
        version: '1.2.0',
        display_name: 'Enterprise Search',
        mcp_config: {
          transport: 'http',
          url: 'https://search.example.com/mcp',
        },
      }],
    });

    expect(acks[0].status).toBe('success');

    // 检查 workspace 级配置
    const mcpConfig = await fse.readJson(path.join(wsPath, '.mcp.json'));
    expect(await fse.pathExists(path.join(wsPath, '.codebuddy', 'mcp.json'))).toBe(false);
    expect(mcpConfig.mcpServers['enterprise-search']).toBeDefined();
    expect(mcpConfig.mcpServers['enterprise-search'].url).toBe('https://search.example.com/mcp');

    // 检查 project 级 manifest — 现为 PER-WORKTREE 文件(#374:分区内每 worktree 一个
    // 独立 managed-mcp.json),key 回归普通 `codebuddy:project`。定位 workspaces/ 下唯一文件
    // (id 由 install 侧解析的 workspacePath 决定,可能经 realpath,故不硬算)。
    const wsDir = path.join(wsPath, '.teamai', 'workspaces');
    const ids = await fse.readdir(wsDir);
    expect(ids.length).toBe(1);
    const manifest = await fse.readJson(path.join(wsDir, ids[0], 'managed-mcp.json'));
    expect(manifest['codebuddy:project']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'enterprise-search' })]),
    );
  });

  // A project-scope install carrying a credential lands only in a file git leaves out of a commit (#882).
  describe('a workspace install carrying a header or env value, in a git checkout (#882)', () => {
    let wsPath: string;
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: wsPath, encoding: 'utf-8' });
    const install = (id: number, mcpConfig: Record<string, unknown>) => runResponse({
      cmds: [{
        id, type: 'install_mcp', scope: 'workspace', workspace_path: wsPath, slug: 'clawpro', version: '1.0.0', mcp_config: mcpConfig,
      }],
    });
    const bearer = { transport: 'http', url: 'https://clawpro.example.com/mcp', headers: { Authorization: 'Bearer bmcp-test-token' } };
    const workspaceFile = async (name: string): Promise<string> => {
      const wsDir = path.join(wsPath, '.teamai', 'workspaces');
      const ids = await fse.readdir(wsDir);
      expect(ids).toHaveLength(1);
      return path.join(wsDir, ids[0], name);
    };

    beforeEach(async () => {
      wsPath = path.join(tmpDir, 'projects', 'repo-git');
      await fse.ensureDir(path.join(wsPath, '.codebuddy', 'skills'));
      git('init', '-q');
    });

    it.each([
      ['an Authorization header', bearer],
      ['a stdio env value', { transport: 'stdio', command: 'clawpro-mcp', env: { CLAWPRO_TOKEN: 'bmcp-test-token' } }],
    ])('lists the config in .git/info/exclude before writing %s, and records it in managed-mcp-files.json', async (_label, mcpConfig) => {
      const acks = await install(9101, mcpConfig);

      expect(acks[0].status).toBe('success');
      expect(await fse.readFile(path.join(wsPath, '.mcp.json'), 'utf-8')).toContain('bmcp-test-token');
      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.mcp\.json$/m);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toBe('');
      const sidecar = await fse.readJson(await workspaceFile('managed-mcp-files.json')) as { files: Record<string, { tools: string[] }> };
      expect(Object.entries(sidecar.files)).toEqual([[expect.stringMatching(/\.mcp\.json$/), { tools: ['codebuddy'] }]]);
      const manifest = await fse.readJson(await workspaceFile('managed-mcp.json'));
      expect(manifest['codebuddy:project']).toEqual([expect.objectContaining({ name: 'clawpro', resolved: true })]);
    });

    it('leaves a user config visible to git when the ownership manifest cannot be written', async () => {
      const original = { mcpServers: { mine: { command: 'my-server' } } };
      await fse.writeJson(path.join(wsPath, '.mcp.json'), original);
      const excludeBefore = await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8');
      const fs = await import('../utils/fs.js');
      const write = fs.writeJsonAtomic;
      vi.spyOn(fs, 'writeJsonAtomic').mockImplementation(async (file, ...args) => {
        if (file.endsWith('/managed-mcp.json')) throw new Error('simulated manifest write failure');
        return write(file, ...args);
      });

      const acks = await install(9110, bearer);

      expect(acks[0].status).toBe('failed');
      expect(acks[0].error).toContain('simulated manifest write failure');
      expect(await fse.readJson(path.join(wsPath, '.mcp.json'))).toEqual(original);
      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toBe(excludeBefore);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toContain('?? .mcp.json');
      const wsDir = path.join(wsPath, '.teamai', 'workspaces');
      const ids = await fse.pathExists(wsDir) ? await fse.readdir(wsDir) : [];
      for (const id of ids) expect(await fse.pathExists(path.join(wsDir, id, 'managed-mcp-files.json'))).toBe(false);
    });

    it('withholds it from a config git tracks, naming why, and leaves the file and its records as they were', async () => {
      const original = { mcpServers: { mine: { type: 'http', url: 'https://mine.example.com/mcp' } } };
      await fse.writeJson(path.join(wsPath, '.mcp.json'), original);
      git('add', '.mcp.json');

      const acks = await install(9102, bearer);

      expect(acks[0].status).toBe('failed');
      expect(acks[0].error).toContain('git already tracks');
      // Commands come from the server: no pull replays one.
      expect(acks[0].error).toContain('then install the MCP server again.');
      expect(acks[0].error).not.toContain('teamai pull');
      expect(await fse.readJson(path.join(wsPath, '.mcp.json'))).toEqual(original);
      const manifestFile = path.join(wsPath, '.teamai', 'workspaces');
      const manifests = await fse.pathExists(manifestFile) ? await fse.readdir(manifestFile) : [];
      for (const id of manifests) {
        const manifest = await fse.readJson(path.join(manifestFile, id, 'managed-mcp.json')).catch(() => ({}));
        expect(manifest['codebuddy:project']).toBeUndefined();
      }
    });

    // Any URL counts (a token can sit in its path), so only a bare stdio command carries none.
    it('adds no line for a server that carries no credential: a bare stdio command', async () => {
      const acks = await install(9103, { transport: 'stdio', command: 'clawpro-mcp' });

      expect(acks[0].status).toBe('success');
      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).not.toMatch(/\.mcp\.json/);
    });

    it('still lists that config when the sync also carried an uninstall_teamai that failed', async () => {
      await install(9106, bearer);
      await fse.writeFile(path.join(wsPath, '.git', 'info', 'exclude'), '');
      await fse.remove(await workspaceFile('managed-mcp-files.json'));
      vi.stubEnv('TEAMAI_DISABLE_REMOTE_CMD', '1');

      await runResponse({ cmds: [{ id: 9107, type: 'uninstall_teamai', cmd: 'teamai uninstall --force --agent codebuddy' }] }, 'codebuddy', wsPath);

      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.mcp\.json$/m);
    });

    // root ignores the read-only bit, so the write it expects to fail succeeds.
    it.skipIf(process.getuid?.() === 0)('says the next session tries again when that sync cannot list the file, and calls it a credential', async () => {
      await install(9105, bearer);
      const excludeFile = path.join(wsPath, '.git', 'info', 'exclude');
      await fse.writeFile(excludeFile, '');
      await fse.remove(await workspaceFile('managed-mcp-files.json'));
      await fse.chmod(excludeFile, 0o444);
      const { log } = await import('../utils/logger.js');
      vi.mocked(log.warn).mockClear();
      try {
        await runResponse({ cmds: [] }, 'codebuddy', wsPath);
      } finally {
        await fse.chmod(excludeFile, 0o644);
      }

      const warned = vi.mocked(log.warn).mock.calls.map(([line]) => String(line)).join('\n');
      expect(warned).toContain('may hold a credential');
      expect(warned).toContain('start a new session');
      expect(warned).not.toContain('teamai pull');
    });

    it('lists a config an older install wrote a credential into on the next sync in the workspace, with no command to run', async () => {
      await install(9104, bearer);
      // As an older local agent left it: no line, no managed-mcp-files.json, no note on the record.
      await fse.writeFile(path.join(wsPath, '.git', 'info', 'exclude'), '');
      await fse.remove(await workspaceFile('managed-mcp-files.json'));
      const manifestFile = await workspaceFile('managed-mcp.json');
      const manifest = await fse.readJson(manifestFile) as Record<string, Array<{ name: string; hash: string }>>;
      manifest['codebuddy:project'] = manifest['codebuddy:project'].map(({ name, hash }) => ({ name, hash }));
      await fse.writeJson(manifestFile, manifest);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).not.toBe('');

      await runResponse({ cmds: [] }, 'codebuddy', wsPath);

      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.mcp\.json$/m);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toBe('');
      const sidecar = await fse.readJson(await workspaceFile('managed-mcp-files.json')) as { files: Record<string, { tools: string[] }> };
      expect(Object.entries(sidecar.files)).toEqual([[expect.stringMatching(/\.mcp\.json$/), { tools: ['codebuddy'] }]]);
      expect(await fse.readFile(path.join(wsPath, '.mcp.json'), 'utf-8')).toContain('bmcp-test-token');
    });

    // As an older local agent left it: no line, no managed-mcp-files.json, no note on the record.
    const asAnOlderAgentLeftIt = async (tool: string): Promise<void> => {
      await fse.writeFile(path.join(wsPath, '.git', 'info', 'exclude'), '');
      await fse.remove(await workspaceFile('managed-mcp-files.json'));
      const manifestFile = await workspaceFile('managed-mcp.json');
      const manifest = await fse.readJson(manifestFile) as Record<string, Array<{ name: string; hash: string }>>;
      manifest[`${tool}:project`] = manifest[`${tool}:project`].map(({ name, hash }) => ({ name, hash }));
      await fse.writeJson(manifestFile, manifest);
    };

    it('lists the config an agent from before 57636a27 wrote at CodeBuddy\'s former .codebuddy/mcp.json, on the next sync', async () => {
      await install(9107, bearer);
      await asAnOlderAgentLeftIt('codebuddy');
      await fse.move(path.join(wsPath, '.mcp.json'), path.join(wsPath, '.codebuddy', 'mcp.json'));
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.codebuddy/mcp.json')).not.toBe('');

      await runResponse({ cmds: [] }, 'codebuddy', wsPath);

      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.codebuddy\/mcp\.json$/m);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.codebuddy/mcp.json')).toBe('');
    });

    it('lists a Copilot config whose bare entry holds a credential beside a credential-free one of its name under mcpServers', async () => {
      const configFile = path.join(wsPath, '.github', 'mcp.json');
      await fse.outputJson(configFile, {});
      const acks = await runResponse({
        cmds: [{ id: 9108, type: 'install_mcp', scope: 'workspace', workspace_path: wsPath, slug: 'clawpro', version: '1.0.0', mcp_config: bearer }],
      }, 'copilot');
      expect(acks[0].status).toBe('success');
      await asAnOlderAgentLeftIt('copilot');
      const doc = await fse.readJson(configFile) as Record<string, unknown>;
      expect(JSON.stringify(doc.clawpro)).toContain('bmcp-test-token');
      await fse.writeJson(configFile, { ...doc, mcpServers: { clawpro: { command: 'clawpro-mcp' } } });

      await runResponse({ cmds: [] }, 'copilot', wsPath);

      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.github\/mcp\.json$/m);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.github/mcp.json')).toBe('');
    });

    // root ignores the directory's read-only bit, so the write it expects to fail succeeds.
    it.skipIf(process.getuid?.() === 0)('still lists that config when an install replacing its entry with a bare command cannot write the file', async () => {
      await install(9105, bearer);
      await fse.writeFile(path.join(wsPath, '.git', 'info', 'exclude'), '');
      await fse.remove(await workspaceFile('managed-mcp-files.json'));
      const manifestFile = await workspaceFile('managed-mcp.json');
      const manifest = await fse.readJson(manifestFile) as Record<string, Array<{ name: string; hash: string }>>;
      manifest['codebuddy:project'] = manifest['codebuddy:project'].map(({ name, hash }) => ({ name, hash }));
      await fse.writeJson(manifestFile, manifest);
      // The config's directory refuses the write: the old entry, and its token, stay.
      await fse.chmod(wsPath, 0o555);
      let acks;
      try {
        acks = await install(9106, { transport: 'stdio', command: 'clawpro-mcp' });
      } finally {
        await fse.chmod(wsPath, 0o755);
      }

      expect(acks[0].status).toBe('failed');
      expect(await fse.readFile(path.join(wsPath, '.mcp.json'), 'utf-8')).toContain('bmcp-test-token');

      await runResponse({ cmds: [] }, 'codebuddy', wsPath);

      expect(await fse.readFile(path.join(wsPath, '.git', 'info', 'exclude'), 'utf-8')).toMatch(/^\/\.mcp\.json$/m);
      expect(git('status', '--porcelain', '--untracked-files=all', '--', '.mcp.json')).toBe('');
    });
  });

  // ─── install_mcp: 缺少 mcp_config 时失败 ──────────────────────────
  it('install_mcp fails when mcp_config is missing', async () => {
    const acks = await runResponse({
      cmds: [{
        id: 9012,
        type: 'install_mcp',
        scope: 'user',
        slug: 'no-config',
        version: '1.0.0',
        // mcp_config 缺失
      }],
    });

    expect(acks[0].status).toBe('failed');
    expect(acks[0].error).toContain('missing mcp_config');
  });

  // ─── report: 上报已安装的 MCP ──────────────────────────────────────
  it('buildReportPayload includes managed MCPs in user_level.mcps', async () => {
    // 先安装一个 MCP server
    await runResponse({
      cmds: [{
        id: 9020,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://clawpro.example.com/mcp',
        },
      }],
    });

    // 然后调 buildReportPayload 检查
    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();
    const payload = await buildReportPayload(config!, { cwd: tmpDir, tool: 'codebuddy', status: 'running' });
    const userLevel = payload.user_level as Record<string, unknown>;
    const mcps = userLevel.mcps as Array<{ slug: string; source: string }>;

    expect(mcps).toBeDefined();
    expect(mcps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'clawpro', source: 'enterprise' }),
      ]),
    );
  });

  // ─── install + uninstall 连续执行 ──────────────────────────────────
  it('processes install_mcp and uninstall_mcp in the same sync batch', async () => {
    // 先安装
    await runResponse({
      cmds: [{
        id: 9030,
        type: 'install_mcp',
        scope: 'user',
        slug: 'temp-server',
        version: '1.0.0',
        mcp_config: { transport: 'http', url: 'https://temp.example.com/mcp' },
      }],
    });

    // 同一批次中先安装再卸载
    const acks = await runResponse({
      cmds: [
        {
          id: 9031,
          type: 'install_mcp',
          scope: 'user',
          slug: 'new-server',
          version: '1.0.0',
          mcp_config: { transport: 'http', url: 'https://new.example.com/mcp' },
        },
        {
          id: 9032,
          type: 'uninstall_mcp',
          scope: 'user',
          slug: 'temp-server',
          version: '1.0.0',
        },
      ],
    });

    expect(acks).toHaveLength(2);
    expect(acks.find((a) => a.id === 9031)?.status).toBe('success');
    expect(acks.find((a) => a.id === 9032)?.status).toBe('success');

    const mcpConfig = await fse.readJson(path.join(tmpDir, '.codebuddy', 'mcp.json'));
    expect(mcpConfig.mcpServers['new-server']).toBeDefined();
    expect(mcpConfig.mcpServers['temp-server']).toBeUndefined();
  });

  // ─── install_mcp: claude 工具 ──────────────────────────────────────
  it('install_mcp works with claude tool format', async () => {
    // claude 需要 .claude 目录存在
    await fse.ensureDir(path.join(tmpDir, '.claude', 'skills'));

    const acks = await runResponse({
      cmds: [{
        id: 9040,
        type: 'install_mcp',
        scope: 'user',
        slug: 'clawpro',
        version: '1.0.0',
        mcp_config: {
          transport: 'http',
          url: 'https://clawpro.example.com/mcp',
          headers: { Authorization: 'Bearer test' },
        },
      }],
    }, 'claude');

    expect(acks[0].status).toBe('success');

    // claude 的 user-scope MCP 配置写到 $HOME/.claude.json
    const claudeConfig = await fse.readJson(path.join(tmpDir, '.claude.json'));
    expect(claudeConfig.mcpServers.clawpro).toBeDefined();
    expect(claudeConfig.mcpServers.clawpro.type).toBe('http');
    expect(claudeConfig.mcpServers.clawpro.url).toBe('https://clawpro.example.com/mcp');

    // managed-mcp manifest 记录在 claude key 下
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'managed-mcp.json'));
    expect(manifest.claude).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'clawpro' })]),
    );
  });

  // ─── issue #427: MCP inventory 按工具隔离，不跨工具合并 ────────────
  it('buildReportPayload does not leak another tool\'s MCPs (issue #427)', async () => {
    // 仅为 codebuddy 安装 MCP（runResponse 默认 tool=codebuddy）
    await runResponse({
      cmds: [{
        id: 9050,
        type: 'install_mcp',
        scope: 'user',
        slug: 'codebuddy-only-mcp',
        version: '1.0.0',
        mcp_config: { transport: 'http', url: 'https://cb.example.com/mcp' },
      }],
    });

    // manifest 里只有 codebuddy 拥有该 MCP
    const manifest = await fse.readJson(path.join(tmpDir, '.teamai', 'managed-mcp.json'));
    expect(manifest.codebuddy).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'codebuddy-only-mcp' })]),
    );

    const { buildReportPayload, loadLocalAgentConfig } = await import('../local-agent.js');
    const config = await loadLocalAgentConfig();

    // workbuddy 的 report 不应包含 codebuddy 的 MCP
    const wbPayload = await buildReportPayload(config!, { cwd: tmpDir, tool: 'workbuddy', status: 'running' });
    const wbUserLevel = wbPayload.user_level as Record<string, unknown>;
    expect(wbUserLevel.mcps).toBeUndefined();

    // codebuddy 自身的 report 仍应包含它
    const cbPayload = await buildReportPayload(config!, { cwd: tmpDir, tool: 'codebuddy', status: 'running' });
    const cbUserLevel = cbPayload.user_level as Record<string, unknown>;
    const cbMcps = cbUserLevel.mcps as Array<{ slug: string; source: string }>;
    expect(cbMcps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'codebuddy-only-mcp', source: 'enterprise' }),
      ]),
    );
  });
});
