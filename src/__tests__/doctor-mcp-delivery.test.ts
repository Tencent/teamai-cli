import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext, type Check } from '../doctor.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/**
 * The MCP half of the delivery check (#624). A server lands as an entry inside
 * the tool's own config, so "delivered" is a key being present — and a server
 * the reconcile skipped is reported with its reason, which is the only place
 * an unresolved `${VAR}` is ever named again (#662).
 */
describe('doctor — MCP servers delivered on disk', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;
  let teamConfig: TeamaiConfig;

  async function writeTeamMcp(yaml: string): Promise<void> {
    await fse.ensureDir(path.join(repoPath, 'mcp'));
    await fse.writeFile(path.join(repoPath, 'mcp', 'mcp.yaml'), yaml);
  }

  async function writeClaudeConfig(servers: Record<string, unknown>): Promise<void> {
    const file = path.join(homeDir, '.claude.json');
    await fse.writeJson(file, { mcpServers: servers }, { spaces: 2 });
  }

  async function checks(): Promise<Check[]> {
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');
    return buildChecks(ctx);
  }

  async function mcpCheck(tool = 'claude'): Promise<Check> {
    const check = (await checks()).find((c) => c.name === `MCP servers delivered to ${tool}`);
    if (!check) throw new Error(`no MCP delivery check for ${tool}`);
    return check;
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-delivery-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(homeDir, '.claude'));
    await writeTeamMcp('servers:\n  - name: docs\n    transport: stdio\n    command: docs-server\n');

    localConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      additionalRoles: [],
    };
    teamConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'git',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' },
        env: { injectShellProfile: false },
      },
      toolPaths: { claude: { skills: '.claude/skills', mcp: '.claude.json' } },
    };

    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('passes when every desired server is installed as teamai renders it', async () => {
    await writeClaudeConfig({ docs: { type: 'stdio', command: 'docs-server' } });

    expect(await (await mcpCheck()).check()).toBe(true);
  });

  it('passes when the installed entry differs only in key order', async () => {
    await writeClaudeConfig({ docs: { command: 'docs-server', type: 'stdio' } });

    expect(await (await mcpCheck()).check()).toBe(true);
  });

  it('fails when the name is held by a server teamai did not write', async () => {
    // Exactly what reconciliation refuses to overwrite: the key is there, the
    // team's server is not, and a plain pull skips it rather than clobber it.
    await writeClaudeConfig({ docs: { type: 'stdio', command: 'my-own-docs-server' } });

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain("not the team's definition: docs");
    expect(check.fix).toContain('--force');
  });

  it('fails when the installed entry is a stale copy of the team definition', async () => {
    await writeClaudeConfig({ docs: { type: 'stdio', command: 'docs-server' } });
    await writeTeamMcp('servers:\n  - name: docs\n    transport: stdio\n    command: docs-server-v2\n');

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain("not the team's definition: docs");
  });

  it('fails and names a desired server with no entry', async () => {
    await writeClaudeConfig({ other: { command: 'x' } });

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('not injected: docs');
    expect(check.fix).toContain(path.join(homeDir, '.claude.json'));
  });

  it('names the variable a server was skipped for, and points at env.yaml', async () => {
    await writeTeamMcp(
      'servers:\n  - name: jira\n    transport: stdio\n    command: jira-server\n'
      + '    env:\n      TOKEN: "${JIRA_PASSWORD}"\n',
    );
    await writeClaudeConfig({});

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('jira');
    expect(check.fix).toContain('JIRA_PASSWORD');
    expect(check.fix).toContain('variables:');
  });

  it('stays silent about a server the member excluded on purpose', async () => {
    localConfig.excludedSkills = ['docs'];
    await writeClaudeConfig({});

    const names = (await checks()).map((c) => c.name);
    expect(names).not.toContain('MCP servers delivered to claude');
  });

  it('compares codex blocks by their text, whatever spacing the file has', async () => {
    teamConfig.toolPaths!.codex = { skills: '.codex/skills', mcp: '.codex/config.toml' };
    await fse.ensureDir(path.join(homeDir, '.codex'));
    const configToml = path.join(homeDir, '.codex', 'config.toml');
    await fse.writeFile(
      configToml,
      '[mcp_servers.docs]\ncommand = "docs-server"\nargs = []\n\n\n[other]\nx = 1\n',
    );

    expect(await (await mcpCheck('codex')).check()).toBe(true);

    await fse.writeFile(configToml, '[mcp_servers.docs]\ncommand = "someone-elses"\nargs = []\n');
    const check = await mcpCheck('codex');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain("not the team's definition: docs");
  });

  it('reports a tool config that cannot be parsed', async () => {
    await fse.writeFile(path.join(homeDir, '.claude.json'), '{ not json');

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('could not be parsed');
  });

  it('fails when mcp.yaml is present but does not parse', async () => {
    // The parse yields no servers, exactly as an absent file does. Reading
    // that as "this team ships no MCP" is what let `doctor --json` answer
    // ok: true over a team whose every server reaches no tool at all.
    await writeTeamMcp('servers:\n  - name: docs\n    transport: stdio\n  bad indent\n');

    const check = (await checks()).find((c) => c.name === 'Team MCP servers can be read');
    if (!check) throw new Error('no MCP parse check');
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain('does not parse');
    expect(check.fix).toContain(path.join(repoPath, 'mcp', 'mcp.yaml'));
  });

  it('fails when mcp.yaml parses as YAML but breaks the server schema', async () => {
    // `stdio` without `command`: zod refuses it, so the desired set is empty
    // for a reason a member has to be told rather than shown as success.
    await writeTeamMcp('servers:\n  - name: docs\n    transport: stdio\n');

    const check = (await checks()).find((c) => c.name === 'Team MCP servers can be read');
    if (!check) throw new Error('no MCP parse check');
    expect(await check.check()).toBe(false);
  });

  it('emits no check when the team ships no MCP servers', async () => {
    await fse.remove(path.join(repoPath, 'mcp'));

    const names = (await checks()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('MCP servers delivered to'))).toEqual([]);
  });

  it('emits no check while the team has not opted into auto-apply', async () => {
    teamConfig.sharing.mcp = { autoApply: false, allowedCommands: [], allowedHosts: [] };
    await writeClaudeConfig({});

    const names = (await checks()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('MCP servers delivered to'))).toEqual([]);
  });

  it('never writes to the tool config it inspects', async () => {
    await writeClaudeConfig({ docs: { type: 'stdio', command: 'docs-server' } });
    const file = path.join(homeDir, '.claude.json');
    const before = await fse.readFile(file, 'utf8');

    await (await mcpCheck()).check();

    expect(await fse.readFile(file, 'utf8')).toBe(before);
  });
});
