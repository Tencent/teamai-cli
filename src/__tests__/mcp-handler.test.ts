import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { parseTeamMcpServers } from '../resources/mcp.js';

let repo: string;

beforeEach(async () => {
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-handler-'));
});
afterEach(async () => {
  await fse.remove(repo);
});

async function writeMcpYaml(content: string): Promise<void> {
  await fse.ensureDir(path.join(repo, 'mcp'));
  await fse.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), content);
}

describe('parseTeamMcpServers', () => {
  it('carries an optional roles list through, and leaves it undefined when omitted', async () => {
    await writeMcpYaml(`
servers:
  - name: playwright
    transport: stdio
    command: npx
    args: ['-y', '@playwright/mcp@latest']
    roles: [frontend]
  - name: shared
    transport: http
    url: https://example.com/api/mcp
`);
    const defs = await parseTeamMcpServers(repo);
    expect(defs.map((d) => d.roles)).toEqual([['frontend'], undefined]);
  });

  it('accepts an empty roles list (matches nobody, like tools: [])', async () => {
    await writeMcpYaml(`
servers:
  - name: nobody
    transport: http
    url: https://example.com/api/mcp
    roles: []
`);
    const defs = await parseTeamMcpServers(repo);
    expect(defs[0].roles).toEqual([]);
  });

  it('carries an optional projects list through, and leaves it undefined when omitted', async () => {
    await writeMcpYaml(`
servers:
  - name: checkout-db
    transport: http
    url: https://example.com/checkout
    projects: [checkout]
  - name: shared
    transport: http
    url: https://example.com/api/mcp
`);
    const defs = await parseTeamMcpServers(repo);
    expect(defs.map((d) => d.projects)).toEqual([['checkout'], undefined]);
  });

  it('accepts an empty projects list (matches nobody) and both axes on one server', async () => {
    await writeMcpYaml(`
servers:
  - name: nobody
    transport: http
    url: https://example.com/api/mcp
    projects: []
  - name: both
    transport: http
    url: https://example.com/both
    roles: [frontend]
    projects: [checkout]
`);
    const defs = await parseTeamMcpServers(repo);
    expect(defs[0].projects).toEqual([]);
    expect(defs[1]).toMatchObject({ roles: ['frontend'], projects: ['checkout'] });
  });
});
