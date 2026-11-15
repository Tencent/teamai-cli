import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { reportAndSyncLocalAgent } from '../local-agent.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { LocalConfigSchema, TeamaiConfigSchema, type LocalConfig } from '../types.js';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

let home: string;
let workspace: string;
let otherWorkspace: string;
let origHome: string | undefined;
let origCwd: string;

const MCP_CONFIG = { transport: 'stdio' as const, command: 'node', args: ['server.js'] };

beforeEach(async () => {
  origHome = process.env.HOME;
  origCwd = process.cwd();
  home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-owner-'));
  workspace = path.join(home, 'ws');
  otherWorkspace = path.join(home, 'ws-other');
  await fse.ensureDir(workspace);
  await fse.ensureDir(otherWorkspace);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  execFileSync('git', ['init', '-q'], { cwd: otherWorkspace });
  await fse.ensureDir(path.join(home, '.openclaw', 'workspace'));
  process.env.HOME = home;
  // OpenClaw's MCP file is JSON5, and a missing file is not a config: give it one.
  await fse.outputJson(path.join(home, '.openclaw', 'openclaw.json'), {});
});

afterEach(async () => {
  process.env.HOME = origHome;
  process.chdir(origCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fse.remove(home);
});

/** The command channel: one install_mcp or uninstall_mcp, as the backend sends it. */
async function run(commands: Array<Record<string, unknown>>, tool = 'openclaw', cwd = workspace): Promise<Array<Record<string, unknown>>> {
  await fse.ensureDir(path.join(home, `.${tool}`, 'skills'));
  await fse.outputJson(path.join(home, '.teamai', 'local-agent', 'config.json'), {
    endpoint: 'https://test.example.com/api',
    token: 'test-token',
    localAgentId: 'test-agent-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    workspaceBindings: {
      [await fse.realpath(workspace)]: { projectId: 32, projectName: 'p32', boundAt: '2026-01-01T00:00:00.000Z' },
      [await fse.realpath(otherWorkspace)]: { projectId: 33, projectName: 'p33', boundAt: '2026-01-01T00:00:00.000Z' },
    },
  });
  const acks: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: { body?: string }) => {
    const url = String(input);
    if (url.includes('/local-agent/sync')) return new Response(JSON.stringify({ ok: true, version: 'v2', cmds: commands }));
    if (url.includes('/commands/ack')) acks.push(JSON.parse(init?.body ?? '{}'));
    return new Response(JSON.stringify({ ok: true }));
  }));

  await reportAndSyncLocalAgent({ cwd, tool, status: 'running' });

  return acks;
}

const installCmd = (id: number, scope: string, url: string, slug = 'docs-mcp', at = workspace) => ({
  id, type: 'install_mcp', scope, slug, version: '1.0.0',
  workspace_path: scope === 'workspace' ? at : undefined,
  mcp_config: url === '' ? MCP_CONFIG : { transport: 'http', url },
});

const uninstallCmd = (id: number, scope: string, slug = 'docs-mcp', at = workspace) => ({
  id, type: 'uninstall_mcp', scope, slug, version: '1.0.0',
  workspace_path: scope === 'workspace' ? at : undefined,
});

const openclawServers = async (): Promise<Record<string, unknown>> =>
  (await fse.readJson(path.join(home, '.openclaw', 'openclaw.json'))).mcp?.servers ?? {};

/** The config a pull runs with, as the CLI builds it: the workspace's own data home. */
const pullConfig = (scope: 'user' | 'project', projectRoot?: string): LocalConfig => {
  const parsed = LocalConfigSchema.parse({
    repo: { kind: 'http', localPath: path.join(home, 'stub'), remote: 'https://test.example.com/api' },
    username: 'tester',
    scope,
    ...(projectRoot === undefined ? {} : { projectRoot }),
  });

  return projectRoot === undefined ? parsed : { ...parsed, dataHome: path.join(projectRoot, '.teamai') };
};

/** The root pull and `uninstall --force` both hand reconcile; a user-scope run names no root. */
async function reconcileScope(scope: 'user' | 'project', projectRoot?: string): Promise<void> {
  await reconcileMcpForConfig(
    TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git' }),
    pullConfig(scope, projectRoot),
    { removeAll: true },
  );
}

/** The workspace's own ownership shard, where a command records what it delivered. */
async function workspaceShardPath(root: string): Promise<string> {
  const dir = path.join(root, '.teamai', 'workspaces');
  const [shard] = await fse.readdir(dir);

  return path.join(dir, shard, 'managed-mcp.json');
}

const workspaceShard = async (root: string): Promise<Record<string, Array<{ name: string; hash: string }>>> =>
  await fse.readJson(await workspaceShardPath(root)) as Record<string, Array<{ name: string; hash: string }>>;

/** The hash a workspace's own records hold for `name`, whichever key its installer wrote it under. */
const recordedHash = async (root: string, name: string): Promise<string | undefined> =>
  Object.values(await workspaceShard(root)).flat().find((record) => record.name === name)?.hash;

const editServer = async (url: string): Promise<void> => {
  const file = path.join(home, '.openclaw', 'openclaw.json');
  const doc = await fse.readJson(file);
  doc.mcp.servers['docs-mcp'].url = url;
  await fse.writeJson(file, doc);
};

describe('local-agent MCP ownership across scopes', () => {
  it('updates a user-owned entry from workspace pull without matching team history', async () => {
    await run([installCmd(1, 'user', 'https://a.example/mcp')], 'openclaw', home);
    const config = pullConfig('project', await fse.realpath(workspace));
    config.repo.kind = 'git';
    await fse.outputFile(path.join(config.repo.localPath, 'mcp', 'mcp.yaml'),
      'servers:\n  - name: docs-mcp\n    transport: http\n    url: https://b.example/mcp\n');
    await reconcileMcpForConfig(TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git' }), config);
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });
    await reconcileScope('project', await fse.realpath(workspace));
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });
    await reconcileScope('user');
    expect(await openclawServers()).not.toHaveProperty('docs-mcp');
  });

  it('keeps another scope\'s Hermes entry when uninstall cleans a previous home', async () => {
    const oldHome = path.join(home, '.hermes');
    await fse.outputFile(path.join(oldHome, 'config.yaml'), '{}\n');
    await run([installCmd(1, 'user', 'https://a.example/mcp')], 'hermes', home);
    await run([installCmd(2, 'workspace', 'https://a.example/mcp')], 'hermes');
    const file = path.join(oldHome, 'config.yaml');
    const before = await fse.readFile(file, 'utf8');
    const newHome = path.join(home, 'new-hermes');
    await fse.outputFile(path.join(newHome, 'config.yaml'), '{}\n');
    vi.stubEnv('HERMES_HOME', newHome);
    await reconcileScope('project', await fse.realpath(workspace));
    expect(await fse.readFile(file, 'utf8')).toBe(before);
    vi.stubEnv('HERMES_HOME', oldHome);
    await reconcileScope('user');
    expect(await fse.readFile(file, 'utf8')).not.toContain('https://a.example/mcp');
  });

  it('a workspace install_mcp is removed by the same workspace\'s uninstall --force', async () => {
    expect((await run([installCmd(1, 'workspace', '')]))[0].status).toBe('success');
    expect(await openclawServers()).toHaveProperty('docs-mcp');

    // The root `teamai pull` hands reconcile: git's toplevel, resolved.
    await reconcileScope('project', await fse.realpath(workspace));

    expect(await openclawServers()).not.toHaveProperty('docs-mcp');
  });

  it('keeps a member edit when the other scope still records the server', async () => {
    await run([installCmd(1, 'workspace', 'https://a.example/mcp')]);
    await run([installCmd(2, 'user', 'https://b.example/mcp')], 'openclaw', home);

    // The member changes the entry both scopes record.
    await editServer('https://member.example/mcp');

    expect((await run([uninstallCmd(3, 'user')], 'openclaw', home))[0].status).toBe('success');
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://member.example/mcp' });

    expect((await run([uninstallCmd(4, 'workspace')]))[0].status).toBe('success');
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://member.example/mcp' });
  });

  it('a user-scope uninstall --force leaves the workspace able to remove what it still owns', async () => {
    await run([installCmd(1, 'workspace', 'https://a.example/mcp')]);
    await run([installCmd(2, 'user', 'https://b.example/mcp')], 'openclaw', home);
    // The user scope rewrites the entry, so its own record is the current one: the workspace's is stale.
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });

    await reconcileScope('user');

    // B stays: the workspace still records the server.
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });

    const a4 = await run([uninstallCmd(4, 'workspace')]);
    // The workspace leaves last, so the entry it records goes with it. Nothing else owns it.
    expect(a4[0].status).toBe('success');
    expect(await openclawServers()).not.toHaveProperty('docs-mcp');
  });

  it('a workspace uninstall --force keeps an entry another workspace records, and that workspace then removes it', async () => {
    await run([installCmd(1, 'workspace', 'https://a.example/mcp')]);
    await run([installCmd(2, 'workspace', 'https://b.example/mcp', 'docs-mcp', otherWorkspace)]);
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });

    // The first workspace leaves: the second still delivers the entry, so it stays.
    await reconcileScope('project', await fse.realpath(workspace));
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://b.example/mcp' });

    // The second leaves last, and its record names the entry: it goes.
    await reconcileScope('project', await fse.realpath(otherWorkspace));
    expect(await openclawServers()).not.toHaveProperty('docs-mcp');
  });

  it('keeps a member edit that outlives both workspaces recording it', async () => {
    await run([installCmd(1, 'workspace', 'https://a.example/mcp')]);
    await run([installCmd(2, 'workspace', 'https://b.example/mcp', 'docs-mcp', otherWorkspace)]);
    const recorded = await recordedHash(otherWorkspace, 'docs-mcp');

    await editServer('https://member.example/mcp');

    // The first workspace leaves; the edit is not the entry it recorded, and it is not adopted by the other either.
    expect((await run([uninstallCmd(3, 'workspace')]))[0].status).toBe('success');
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://member.example/mcp' });
    expect(await recordedHash(otherWorkspace, 'docs-mcp')).toBe(recorded);

    // The second leaves last. Its record names the entry teamai wrote, not the edit, so the edit stays.
    expect((await run([uninstallCmd(4, 'workspace', 'docs-mcp', otherWorkspace)]))[0].status).toBe('success');
    expect((await openclawServers())['docs-mcp']).toMatchObject({ url: 'https://member.example/mcp' });
  });

  it('does not adopt an entry because another server\'s record renders the same value', async () => {
    await run([installCmd(1, 'workspace', 'https://a.example/mcp')]);
    const before = await recordedHash(workspace, 'docs-mcp');
    await run([installCmd(2, 'user', 'https://b.example/mcp')], 'openclaw', home);
    await run([installCmd(3, 'user', 'https://c.example/mcp', 'echo-mcp')], 'openclaw', home);

    // The member makes docs-mcp hold exactly what echo-mcp's record was written from: a hash, but not its author.
    const file = path.join(home, '.openclaw', 'openclaw.json');
    const doc = await fse.readJson(file);
    doc.mcp.servers['docs-mcp'] = { ...doc.mcp.servers['echo-mcp'] };
    await fse.writeJson(file, doc);

    expect((await run([uninstallCmd(4, 'user')], 'openclaw', home))[0].status).toBe('success');
    // echo-mcp's hash is not docs-mcp's, so the workspace record still names what teamai wrote for docs-mcp.
    expect(await recordedHash(workspace, 'docs-mcp')).toBe(before);

    expect((await run([uninstallCmd(5, 'workspace')]))[0].status).toBe('success');
    expect((await openclawServers())['docs-mcp']).toBeDefined();
  });

  it('an unreadable ownership record keeps an install from overwriting the member\'s own server', async () => {
    await run([installCmd(1, 'workspace', '')]);
    const file = path.join(home, '.openclaw', 'openclaw.json');
    const doc = await fse.readJson(file);
    doc.mcp.servers.mine = { transport: 'http', url: 'https://mine.example/mcp' };
    await fse.writeJson(file, doc);

    // A record that does not parse may name any entry in the shared config: ownership is not proven absent.
    await fse.writeFile(await workspaceShardPath(workspace), '{ not a manifest');

    const acks = await run([installCmd(2, 'user', 'https://teamai.example/mcp', 'mine')], 'openclaw', home);
    expect(acks[0].status).toBe('failed');
    expect(String(acks[0].error)).toContain('not managed by teamai');
    expect((await openclawServers()).mine).toMatchObject({ url: 'https://mine.example/mcp' });
  });

  it.each([
    ['openclaw', 'user', '.openclaw/openclaw.json'],
    ['openclaw', 'workspace', '.openclaw/openclaw.json'],
    ['hermes', 'user', '.hermes/config.yaml'],
    ['hermes', 'workspace', '.hermes/config.yaml'],
    ['dsh', 'user', '.dsh/cordis.patch.yml'],
    ['dsh', 'workspace', '.dsh/cordis.patch.yml'],
  ] as const)('fails a %s %s-scope uninstall_mcp that an unreadable ownership record blocks, naming that record',
    async (tool, scope, configFile) => {
      const otherScope = scope === 'user' ? 'workspace' : 'user';
      const cwdOf = (s: string) => (s === 'user' ? home : workspace);
      if (tool !== 'openclaw') await fse.outputFile(path.join(home, configFile), tool === 'dsh' ? '[]\n' : '{}\n');
      expect((await run([installCmd(1, otherScope, 'https://other.example/mcp', 'other-mcp')], tool, cwdOf(otherScope)))[0].status).toBe('success');
      expect((await run([installCmd(2, scope, 'https://a.example/mcp')], tool, cwdOf(scope)))[0].status).toBe('success');
      const unreadable = otherScope === 'user'
        ? path.join(home, '.teamai', 'managed-mcp.json')
        : await fse.realpath(await workspaceShardPath(workspace));
      await fse.writeFile(unreadable, '{ not a manifest');
      const config = await fse.readFile(path.join(home, configFile), 'utf8');

      const acks = await run([uninstallCmd(3, scope)], tool, cwdOf(scope));
      expect(acks[0].status).toBe('failed');
      expect(String(acks[0].error)).toContain(unreadable);
      expect(String(acks[0].error)).toContain('fix or remove it, then run this again');
      expect(await fse.readFile(path.join(home, configFile), 'utf8')).toBe(config);
      const own = scope === 'user'
        ? await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json')) as Record<string, Array<{ name: string }>>
        : await workspaceShard(workspace);
      expect(Object.values(own).flat().map((record) => record.name)).toContain('docs-mcp');
    });
});