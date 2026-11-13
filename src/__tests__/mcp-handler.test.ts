import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn() },
}));

import YAML from 'yaml';
import { McpHandler, TEAM_MCP_ENTRIES } from '../resources/mcp.js';
import { LayeredEntries } from '../resources/layered-entries.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

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

function member(over: Partial<Pick<LocalConfig, 'primaryRole' | 'projects'>> = {}): LocalConfig {
  return { repo: { localPath: repo, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [], ...over };
}

async function serversFor(localConfig: LocalConfig) {
  const resolution = await LayeredEntries.resolve(TEAM_MCP_ENTRIES, localConfig);
  if (resolution.kind !== 'resolved') throw new Error('servers did not resolve');
  return resolution.entries.map((entry) => entry.entry.server);
}

describe('LayeredEntries.resolve(TEAM_MCP_ENTRIES) — per-entry keys (#707)', () => {
  it('keeps a (deprecated) roles list on the entry, and leaves it undefined when omitted', async () => {
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
    const servers = await serversFor(member());
    expect(servers.map((s) => s.roles)).toEqual([['frontend'], undefined]);
  });

  it('still filters by the deprecated roles list for a member with a role', async () => {
    await writeMcpYaml(`
servers:
  - name: nobody
    transport: http
    url: https://example.com/api/mcp
    roles: []
  - name: shared
    transport: http
    url: https://example.com/shared
`);
    expect((await serversFor(member({ primaryRole: 'frontend' }))).map((s) => s.name)).toEqual(['shared']);
  });

  it('delivers no server that carries the removed projects key', async () => {
    await writeMcpYaml(`
servers:
  - name: checkout-db
    transport: http
    url: https://example.com/checkout
    projects: [checkout]
  - name: both
    transport: http
    url: https://example.com/both
    roles: [frontend]
    projects: [checkout]
  - name: shared
    transport: http
    url: https://example.com/api/mcp
`);
    expect((await serversFor(member({ projects: ['checkout'] }))).map((s) => s.name)).toEqual(['shared']);
  });
});

describe('McpHandler.removeItem', () => {
  // A server with a misspelled `roles:` reaches nobody (#822); a rewrite that
  // drops the key would install it for the whole team.
  it('keeps a key MCP does not know on the servers it leaves', async () => {
    await writeMcpYaml(`
servers:
  - name: gone
    transport: http
    url: https://example.com/gone
  - name: fe-db
    transport: http
    url: https://example.com/fe-db
    role: [frontend]
`);
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
      toolPaths: {},
    };
    await new McpHandler().removeItem('gone', teamConfig, member());

    const written = YAML.parse(await fse.readFile(path.join(repo, 'mcp', 'mcp.yaml'), 'utf-8'));
    expect(written.servers).toEqual([
      { name: 'fe-db', transport: 'http', url: 'https://example.com/fe-db', role: ['frontend'] },
    ]);
  });
});

/** `teamai remove mcp` searches and edits server folders as it does mcp.yaml servers (#1787). */
describe('McpHandler server folders', () => {
  const teamConfig: TeamaiConfig = {
    team: 'test',
    description: '',
    repo: 'owner/repo',
    provider: 'github',
    reviewers: [],
    sharing: { skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true } },
    toolPaths: {},
  };

  async function writeFolder(relativeDir: string, marker = 'transport: stdio\ncommand: node\nargs: ["${TEAMAI_MCP_DIR}/server.mjs"]\n'): Promise<void> {
    const dir = path.join(repo, ...relativeDir.split('/'));
    await fse.ensureDir(dir);
    await fse.writeFile(path.join(dir, 'MCP.yaml'), marker);
    await fse.writeFile(path.join(dir, 'server.mjs'), 'console.log("hi");\n');
  }

  it('lists a server folder at the root and in a namespace, with its namespace', async () => {
    await writeFolder('mcp/jira-lite');
    await writeFolder('mcp/checkout/db');

    const items = await new McpHandler().scanTeamForPull(teamConfig, member());

    expect(items.map(({ name, namespace, relativePath }) => ({ name, namespace, relativePath }))).toEqual([
      { name: 'jira-lite', namespace: undefined, relativePath: 'mcp/jira-lite' },
      { name: 'db', namespace: 'checkout', relativePath: 'mcp/checkout/db' },
    ]);
  });

  it('removes a server folder from the team repo, the root one by a bare name and a namespace one by <ns>/<name>', async () => {
    await writeFolder('mcp/jira-lite');
    await writeFolder('mcp/checkout/db');
    await writeFolder('mcp/billing/db');

    const handler = new McpHandler();
    const removedRoot = await handler.removeItem('jira-lite', teamConfig, member());
    const removedNamespaced = await handler.removeItem('checkout/db', teamConfig, member());

    expect(removedRoot).toEqual([path.join(repo, 'mcp', 'jira-lite')]);
    expect(removedNamespaced).toEqual([path.join(repo, 'mcp', 'checkout', 'db')]);
    expect(await fse.pathExists(path.join(repo, 'mcp', 'jira-lite'))).toBe(false);
    expect(await fse.pathExists(path.join(repo, 'mcp', 'checkout', 'db'))).toBe(false);
    expect(await fse.pathExists(path.join(repo, 'mcp', 'billing', 'db', 'MCP.yaml'))).toBe(true);
  });

  it('removes a folder whose MCP.yaml does not parse', async () => {
    await writeFolder('mcp/broken', 'transport: [\n');

    expect(await new McpHandler().removeItem('broken', teamConfig, member())).toEqual([path.join(repo, 'mcp', 'broken')]);
    expect(await fse.pathExists(path.join(repo, 'mcp', 'broken'))).toBe(false);
  });
});
