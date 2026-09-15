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
});
