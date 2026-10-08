import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import YAML from 'yaml';
import { getTeamLibrary } from '../dashboard/library.js';
import { getDashboardHtml } from '../dashboard-html.js';
import { LocalConfigSchema, type LocalConfig } from '../types.js';

async function writeSkill(repo: string, rel: string, frontmatter?: string): Promise<void> {
  const dir = path.join(repo, 'skills', ...rel.split('/'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), frontmatter ? `---\n${frontmatter}---\nBody.\n` : 'No frontmatter here.\n');
}

function makeConfig(repo: string): LocalConfig {
  return LocalConfigSchema.parse({ repo: { localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'tester' });
}

describe('getTeamLibrary', () => {
  let repo = '';
  let config: LocalConfig;
  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-library-'));
    await writeSkill(repo, 'flat-skill', 'name: flat-skill\ndescription: A flat team skill.\n');
    await writeSkill(repo, 'frontend/nested-skill', 'name: nested-skill\ndescription: A namespaced skill.\n');
    await writeSkill(repo, 'no-description');
    await fs.mkdir(path.join(repo, 'mcp'), { recursive: true });
    await fs.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), YAML.stringify({
      servers: [
        { name: 'local-runner', transport: 'stdio', command: 'npx', args: ['-y', 'runner-mcp'], env: { RUNNER_TOKEN: '${RUNNER_TOKEN}' } },
        { name: 'remote-api', description: 'Shared API', transport: 'http', url: 'https://mcp.example.invalid/api', headers: { Authorization: 'Bearer ${API_TOKEN}' } },
      ],
    }));
    await fs.writeFile(path.join(repo, 'teamai.yaml'), YAML.stringify({
      team: 'library-test',
      packages: {
        npm: [
          { name: 'team-cli', version: '^1.2.0', global: true, registry: 'https://npm.example.invalid' },
          { name: 'local-lib' },
        ],
        claude: {
          marketplaces: [{ name: 'team-tools', repo: 'https://example.invalid/team-tools.git', ref: 'v1' }],
          plugins: [{ name: 'formatter@team-tools', version: '1.0.0', scope: 'project' }],
        },
      },
    }));
    config = makeConfig(repo);
  });
  afterAll(async () => {
    if (repo) await fs.rm(repo, { recursive: true, force: true });
  });

  it('returns empty lists for a workspace without a config', async () => {
    expect(await getTeamLibrary(null)).toEqual({
      skills: [], mcpServers: [], packages: { npm: [], claude: { marketplaces: [], plugins: [] } },
    });
  });

  it('passes through the npm and claude package declarations from teamai.yaml', async () => {
    const { packages, packagesError } = await getTeamLibrary(config);
    expect(packagesError).toBeUndefined();
    expect(packages.npm).toEqual([
      { name: 'team-cli', version: '^1.2.0', global: true, registry: 'https://npm.example.invalid' },
      { name: 'local-lib', version: '*' },
    ]);
    expect(packages.claude.marketplaces).toEqual([
      { name: 'team-tools', repo: 'https://example.invalid/team-tools.git', ref: 'v1' },
    ]);
    expect(packages.claude.plugins).toEqual([
      { name: 'formatter@team-tools', version: '1.0.0', scope: 'project' },
    ]);
  });

  it('reports empty packages without an error when the repo has no teamai.yaml', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-library-bare-'));
    try {
      const { packages, packagesError } = await getTeamLibrary(makeConfig(bare));
      expect(packages).toEqual({ npm: [], claude: { marketplaces: [], plugins: [] } });
      expect(packagesError).toBeUndefined();
    } finally {
      await fs.rm(bare, { recursive: true, force: true });
    }
  });

  it('reports an unreadable teamai.yaml as packagesError instead of throwing', async () => {
    const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-library-broken-'));
    try {
      await fs.writeFile(path.join(broken, 'teamai.yaml'), 'packages:\n  npm: not-a-list\n');
      const result = await getTeamLibrary(makeConfig(broken));
      expect(result.packages).toEqual({ npm: [], claude: { marketplaces: [], plugins: [] } });
      expect(result.packagesError).toBeTruthy();
    } finally {
      await fs.rm(broken, { recursive: true, force: true });
    }
  });

  it('lists flat and namespaced skills with frontmatter descriptions', async () => {
    const { skills } = await getTeamLibrary(config);
    expect(skills).toHaveLength(3);
    const flat = skills.find(s => s.name === 'flat-skill');
    expect(flat).toMatchObject({ namespace: undefined, description: 'A flat team skill.', path: 'skills/flat-skill' });
    const nested = skills.find(s => s.name === 'nested-skill');
    expect(nested).toMatchObject({ namespace: 'frontend', description: 'A namespaced skill.', path: 'skills/frontend/nested-skill' });
    // A SKILL.md without a description simply omits the field.
    expect(skills.find(s => s.name === 'no-description')).toMatchObject({ description: undefined, path: 'skills/no-description' });
  });

  it('lists MCP servers with endpoints and secret variable names only', async () => {
    const { mcpServers, mcpError } = await getTeamLibrary(config);
    expect(mcpError).toBeUndefined();
    expect(mcpServers).toHaveLength(2);
    const stdio = mcpServers.find(s => s.name === 'local-runner');
    expect(stdio).toMatchObject({
      transport: 'stdio', endpoint: 'npx -y runner-mcp', source: 'mcp/mcp.yaml', namespace: null, secrets: ['RUNNER_TOKEN'],
    });
    const http = mcpServers.find(s => s.name === 'remote-api');
    expect(http).toMatchObject({
      description: 'Shared API', transport: 'http', endpoint: 'https://mcp.example.invalid/api', secrets: ['API_TOKEN'],
    });
    // Secret values must never appear in the payload.
    expect(JSON.stringify(mcpServers)).not.toContain('Bearer ${API_TOKEN}');
  });

  it('reports an unreadable mcp.yaml as mcpError instead of throwing', async () => {
    await fs.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers: [not: valid');
    try {
      const result = await getTeamLibrary(config);
      expect(result.mcpServers).toEqual([]);
      expect(result.mcpError).toBeTruthy();
      // The skills list still resolves.
      expect(result.skills.length).toBeGreaterThan(0);
    } finally {
      await fs.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), YAML.stringify({ servers: [] }));
    }
  });
});

describe('GET /api/library', () => {
  let home = '';
  let base = '';
  const savedHome = process.env.HOME;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-library-route-'));
    const teamHome = path.join(home, '.teamai');
    const repo = path.join(teamHome, 'team-repo');
    await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
    await writeSkill(repo, 'route-skill', 'name: route-skill\ndescription: Served over the API.\n');
    await fs.mkdir(path.join(repo, 'mcp'), { recursive: true });
    await fs.writeFile(path.join(repo, 'mcp', 'mcp.yaml'), YAML.stringify({
      servers: [{ name: 'api', transport: 'http', url: 'https://mcp.example.invalid/${API_TOKEN}' }],
    }));
    await fs.writeFile(path.join(repo, 'teamai.yaml'), YAML.stringify({
      team: 'route-test',
      packages: { npm: [{ name: 'team-cli', version: '^1.0.0', global: true }] },
    }));
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({
      repo: { localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'tester', scope: 'user',
    }));
    process.env.HOME = home;
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const { startDashboard } = await import('../dashboard.js');
    await startDashboard(port);
    base = `http://127.0.0.1:${port}`;
    // Wait until the server accepts requests.
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ok = await fetch(base + '/api/workspaces').then(r => r.ok).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('dashboard server did not start');
      await new Promise(r => setTimeout(r, 50));
    }
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    // The server (and its events.jsonl watcher) keeps running in this isolated
    // worker; the sandbox is intentionally left on disk so the watcher never
    // sees its directory disappear.
  });

  it('serves the user scope library without a workspace parameter', async () => {
    const response = await fetch(base + '/api/library');
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.skills).toEqual([
      { name: 'route-skill', description: 'Served over the API.', path: 'skills/route-skill' },
    ]);
    expect(data.mcpServers).toHaveLength(1);
    expect(data.mcpServers[0]).toMatchObject({
      name: 'api', transport: 'http', endpoint: 'https://mcp.example.invalid/${API_TOKEN}',
      source: 'mcp/mcp.yaml', namespace: null, secrets: ['API_TOKEN'],
    });
    expect(data.packages).toEqual({
      npm: [{ name: 'team-cli', version: '^1.0.0', global: true }],
      claude: { marketplaces: [], plugins: [] },
    });
    expect(data.packagesError).toBeUndefined();
  });

  it('serves the same library for ?workspace=user', async () => {
    const data = await (await fetch(base + '/api/library?workspace=user')).json();
    expect(data.skills.map((s: { name: string }) => s.name)).toEqual(['route-skill']);
    expect(data.mcpServers).toHaveLength(1);
  });

  it('rejects an unknown workspace', async () => {
    const response = await fetch(base + '/api/library?workspace=bogus');
    expect(response.status).toBe(400);
  });
});

describe('Team Library page wiring', () => {
  it('embeds the library page, its fetch path and retry handler in the client', () => {
    const html = getDashboardHtml(3721);
    expect(html).toContain("library: 'Team Library'");
    expect(html).toContain('/api/library');
    expect(html).toContain("data-retry=\"library\"");
    expect(html).toContain("'Team Skills'");
    expect(html).toContain("'MCP Servers'");
    expect(html).toContain("'Packages'");
  });
});
