import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
}));

import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { detectMcpFormat, renderDshEntry, supportsTransport } from '../resources/mcp-format.js';
import { resetWarnOnce } from '../utils/warn-once.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const USER_PATCH = `# Your own dsh patch layer.
- id: some-plugin
  config:
    token: !!js process.env.MY_TOKEN
- insert:
    - id: my-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: mine
        transport: stdio
        command: my-server
`;

describe('DeepSeek Harness MCP', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let patchFile: string;
  let teamConfig: TeamaiConfig;
  let localConfig: LocalConfig;

  async function writeMcpYaml(body: string): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'mcp'));
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), body);
  }

  beforeEach(async () => {
    resetWarnOnce();
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-dsh-mcp-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');
    patchFile = path.join(homeDir, '.dsh', 'cordis.patch.yml');
    await fse.ensureDir(path.join(homeDir, '.dsh', 'skills'));
    await fse.ensureDir(path.join(homeDir, '.teamai'));
    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 't',
      description: '',
      repo: 'r',
      provider: 'tgit',
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '~/.teamai/docs' },
        env: { injectShellProfile: false },
      },
      toolPaths: { dsh: { skills: '.dsh/skills', mcp: '.dsh/cordis.patch.yml' } },
    } as unknown as TeamaiConfig;
    localConfig = {
      repo: { localPath: repoPath, remote: 'r' },
      username: 'u',
      scope: 'user',
      additionalRoles: [],
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('renders one dsh-mcp-client loader entry per server', () => {
    expect(detectMcpFormat('dsh')).toBe('dsh');
    expect(supportsTransport('dsh', 'sse')).toBe(false);
    expect(renderDshEntry({ name: 'a', transport: 'stdio', command: 'node', args: ['x.js'], timeout: 9000 })).toEqual({
      id: 'teamai-mcp-a',
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'a', transport: 'stdio', command: 'node', args: ['x.js'], toolCallTimeoutMs: 9000 },
    });
    expect(renderDshEntry({ name: 'b', transport: 'http', url: 'https://example.com/mcp', headers: { A: '1' } }).config)
      .toEqual({ serverName: 'b', transport: 'streamable-http', url: 'https://example.com/mcp', headers: { A: '1' } });
  });

  it('adds team servers to the home patch layer and leaves the user\'s patches intact', async () => {
    await fse.writeFile(patchFile, USER_PATCH);
    await writeMcpYaml(`
servers:
  - name: team-server
    transport: stdio
    command: node
    args: [server.js]
`);

    const first = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(first.changes).toContainEqual({ tool: 'dsh', server: 'team-server', action: 'added' });

    const text = await fse.readFile(patchFile, 'utf-8');
    expect(text.startsWith(USER_PATCH)).toBe(true);
    const patches = YAML.parse(text, { logLevel: 'error', customTags: [{ tag: '!!js', resolve: (s: string) => s }] }) as unknown[];
    expect(patches.at(-1)).toEqual({
      insert: [{
        id: 'teamai-mcp-team-server',
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'team-server', transport: 'stdio', command: 'node', args: ['server.js'] },
      }],
    });

    const second = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(second.wrote).toBe(false);
    expect(await fse.readFile(patchFile, 'utf-8')).toBe(text);
  });

  it('skips a server whose name the user already configured, and removes only its own on removeAll', async () => {
    await fse.writeFile(patchFile, USER_PATCH);
    await writeMcpYaml(`
servers:
  - name: mine
    transport: stdio
    command: other
  - name: team-server
    transport: http
    url: https://example.com/mcp
`);

    const { changes } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(changes).toContainEqual(expect.objectContaining({ server: 'mine', action: 'skipped' }));

    await reconcileMcpForConfig(teamConfig, localConfig, { removeAll: true });
    expect(await fse.readFile(patchFile, 'utf-8')).toBe(USER_PATCH);
  });

  it('refuses to touch a patch file that does not parse as a patch list', async () => {
    await fse.writeFile(patchFile, 'not: a list\n');
    await writeMcpYaml(`
servers:
  - name: team-server
    transport: stdio
    command: node
`);
    const { wrote } = await reconcileMcpForConfig(teamConfig, localConfig);
    expect(wrote).toBe(false);
    expect(await fse.readFile(patchFile, 'utf-8')).toBe('not: a list\n');
  });
});
