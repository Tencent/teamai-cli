import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

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

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-test-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = origHome;
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
  await reportAndSyncLocalAgent({ cwd: tmpDir, tool, status: 'running' });
  return acks;
}

describe('local-agent: MCP install/uninstall commands', () => {

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
    const mcpConfig = await fse.readJson(path.join(wsPath, '.codebuddy', 'mcp.json'));
    expect(mcpConfig.mcpServers['enterprise-search']).toBeDefined();
    expect(mcpConfig.mcpServers['enterprise-search'].url).toBe('https://search.example.com/mcp');

    // 检查 project 级 manifest
    const manifest = await fse.readJson(path.join(wsPath, '.teamai', 'managed-mcp.json'));
    expect(manifest['codebuddy:project']).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'enterprise-search' })]),
    );
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
});
