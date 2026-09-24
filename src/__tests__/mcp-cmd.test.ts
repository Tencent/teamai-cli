import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(),
}));
vi.mock('../resources/mcp.js', () => ({
  parseTeamMcpServers: vi.fn(),
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
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { autoDetectInit } from '../config.js';
import { parseTeamMcpServers } from '../resources/mcp.js';
import { mcpList } from '../mcp-cmd.js';

const mockedAutoDetectInit = autoDetectInit as Mock;
const mockedParse = parseTeamMcpServers as Mock;

describe('mcpList', () => {
  beforeEach(() => {
    mockedAutoDetectInit.mockResolvedValue({
      localConfig: { repo: { localPath: '/repo' }, scope: 'user', additionalRoles: [] },
      teamConfig: { toolPaths: {} },
    });
  });

  it('prints the roles restriction of a server, and nothing for an unscoped one', async () => {
    mockedParse.mockResolvedValue([
      { name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], roles: ['frontend'] },
      { name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' },
      { name: 'nobody', transport: 'http', url: 'https://example.com/none', roles: [] },
    ]);
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    try {
      await mcpList({});
    } finally {
      spy.mockRestore();
    }
    const text = out.join('\n');
    expect(text).toContain('playwright  [stdio]');
    expect(text).toContain('roles:    frontend');
    expect(text).toContain('roles:    nobody');
    expect(text.match(/roles:/g)).toHaveLength(2);
  });

  it('prints the projects restriction the same way, and both when a server scopes both', async () => {
    mockedParse.mockResolvedValue([
      { name: 'checkout-db', transport: 'http', url: 'https://example.com/checkout', projects: ['checkout'] },
      { name: 'shared', transport: 'http', url: 'https://example.com/api/mcp' },
      { name: 'nobody', transport: 'http', url: 'https://example.com/none', projects: [] },
      { name: 'both', transport: 'http', url: 'https://example.com/both', roles: ['frontend'], projects: ['checkout', 'billing'] },
    ]);
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    try {
      await mcpList({});
    } finally {
      spy.mockRestore();
    }
    const text = out.join('\n');
    expect(text).toContain('projects: checkout');
    expect(text).toContain('projects: nobody');
    expect(text).toContain('projects: checkout, billing');
    expect(text.match(/projects:/g)).toHaveLength(3);
    expect(text.match(/roles:/g)).toHaveLength(1);
  });
});
