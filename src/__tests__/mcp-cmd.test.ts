import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));
vi.mock('../namespaced-entries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../namespaced-entries.js')>()),
  resolveEntriesFor: vi.fn(),
}));
vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn(),
  resolveMcpTargets: vi.fn().mockResolvedValue([]),
  buildVarTable: vi.fn().mockResolvedValue({}),
}));
vi.mock('../utils/fs.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import { autoDetectInit } from '../config.js';
import { resolveEntriesFor } from '../namespaced-entries.js';
import { mcpInject, mcpList } from '../mcp-cmd.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { resetWarnOnce } from '../utils/warn-once.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedResolve = resolveEntriesFor as Mock;

/** An MCP resolution as `resolveEntriesFor` returns it, from `[server, source, replaces]`. */
function resolved(entries: [Record<string, unknown>, string, string | null][]) {
  return {
    kind: 'resolved',
    active: [],
    notices: [],
    repeated: [],
    entries: entries.map(([entry, source, replaces]) => ({
      entry,
      name: entry.name,
      source,
      namespace: source === 'mcp/mcp.yaml' ? null : source.split('/')[1],
      replaces,
    })),
  };
}

async function listOutput(): Promise<string> {
  const out: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
  try {
    await mcpList({});
  } finally {
    spy.mockRestore();
  }
  return out.join('\n');
}

describe('mcpList', () => {
  beforeEach(() => {
    resetWarnOnce();
    mockedAutoDetectInit.mockResolvedValue({
      localConfig: { repo: { localPath: '/repo' }, scope: 'user', additionalRoles: [] },
      teamConfig: { toolPaths: {} },
    });
  });

  it('prints where each server comes from, and says when a namespace overrides the root', async () => {
    mockedResolve.mockResolvedValue(resolved([
      [{ name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' }, 'mcp/mcp.yaml', null],
      [{ name: 'db', transport: 'http', url: 'https://checkout.example.com/db' }, 'mcp/checkout/mcp.yaml', 'mcp/mcp.yaml'],
      [{ name: 'orders', transport: 'http', url: 'https://checkout.example.com/orders' }, 'mcp/checkout/mcp.yaml', null],
    ]));
    const text = await listOutput();
    expect(text).toContain('from:     mcp/mcp.yaml (root)');
    expect(text).toContain('from:     mcp/checkout/mcp.yaml (checkout, overrides root)');
    expect(text).toContain('from:     mcp/checkout/mcp.yaml (checkout)');
  });

  it('prints a deprecated roles restriction, and nothing for an unscoped server', async () => {
    mockedResolve.mockResolvedValue(resolved([
      [{ name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], roles: ['frontend'] }, 'mcp/mcp.yaml', null],
      [{ name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' }, 'mcp/mcp.yaml', null],
    ]));
    const text = await listOutput();
    expect(text).toContain('playwright  [stdio]');
    expect(text).toContain('roles:    frontend (deprecated)');
    expect(text.match(/roles:/g)).toHaveLength(1);
  });

  it('reports a set that cannot be resolved instead of listing part of it', async () => {
    mockedResolve.mockResolvedValue({
      kind: 'failed',
      notices: [{
        kind: 'unknown-key',
        message: 'mcp/mcp.yaml: server "hidden" has unknown key `role:`, so this entry is not delivered.',
      }],
      failure: { kind: 'two-namespaces', type: 'mcp', name: 'db', first: 'mcp/checkout/mcp.yaml', second: 'mcp/billing/mcp.yaml' },
    });
    const { log } = await import('../utils/logger.js');
    await listOutput();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('server "hidden" has unknown key `role:`'));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('server "db" is defined in both mcp/checkout/mcp.yaml and mcp/billing/mcp.yaml'));
    process.exitCode = 0;
  });

  it('names the server a removed per-entry key takes out of the delivered set (#822)', async () => {
    mockedResolve.mockResolvedValue({
      ...resolved([
        [{ name: 'good_server', transport: 'stdio', command: 'echo' }, 'mcp/mcp.yaml', null],
      ]),
      notices: [{
        kind: 'removed-key' as const,
        message: 'mcp/mcp.yaml: server "scoped_server" is scoped with per-entry `projects:`, '
          + 'which this version no longer reads, so it reaches nobody. '
          + 'It lists no id: remove it, or move it to the namespace file it is meant for.',
      }],
    });
    const { log } = await import('../utils/logger.js');
    const text = await listOutput();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(
      'server "scoped_server" is scoped with per-entry `projects:`, which this version no longer reads, so it reaches nobody.',
    ));
    expect(text).toContain('good_server');
    expect(text).not.toContain('scoped_server');
  });

  it('leaves delivered deprecated-role notices to pull and doctor', async () => {
    mockedResolve.mockResolvedValue({
      ...resolved([[
        { name: 'scoped_server', transport: 'http', url: 'https://example.com/mcp', roles: ['worker'] },
        'mcp/mcp.yaml', null,
      ]]),
      notices: [{
        kind: 'deprecated-roles',
        message: 'mcp/mcp.yaml: server "scoped_server" uses deprecated per-entry `roles:`.',
      }],
    });
    const { log } = await import('../utils/logger.js');
    vi.mocked(log.warn).mockClear();
    await listOutput();
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('deprecated per-entry `roles:`'));
  });
});

describe('mcpInject', () => {
  beforeEach(() => {
    mockedAutoDetectInit.mockResolvedValue({
      localConfig: { repo: { localPath: '/repo' }, scope: 'user', additionalRoles: [] },
      teamConfig: { toolPaths: {} },
    });
  });

  it('fails instead of saying "Already up to date" when the team servers cannot be resolved', async () => {
    // The reconcile reported why and left every installed server as it was.
    vi.mocked(reconcileMcpForConfig).mockResolvedValue({ changes: [], wrote: false, unresolved: true });
    const { log } = await import('../utils/logger.js');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await mcpInject({});
      expect(log.info).not.toHaveBeenCalledWith('Already up to date.');
      expect(process.exitCode).toBe(1);
    } finally {
      spy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
