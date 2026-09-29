import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
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
import { getDataHome, managedMcpManifestKey, managedMcpManifestPath, type LocalConfig, type TeamaiConfig } from '../types.js';

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
    // Named as it is in the team repo, where it has to be fixed.
    expect(check.fix).toContain('mcp/mcp.yaml does not parse');
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

  describe('project MCP config holding a resolved value (#882)', () => {
    const NAME = 'Project MCP configs with resolved values are kept out of git';
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = path.join(tempDir, 'business-repo');
      await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));
      execFileSync('git', ['init', '-q'], { cwd: projectRoot });
      Object.assign(localConfig, { scope: 'project', projectRoot });
      teamConfig.toolPaths = { claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: '.mcp.json' } };
      await writeTeamMcp(
        'servers:\n  - name: jira\n    transport: http\n    url: https://jira.example/mcp\n'
        + '    headers:\n      Authorization: "Bearer ${JIRA_TOKEN}"\n',
      );
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
        mcpServers: { jira: { type: 'http', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer t0ken' } } },
      });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'jira', hash: 'h' }],
      });
    });

    async function excludeCheck(): Promise<Check | undefined> {
      return (await checks()).find((c) => c.name === NAME);
    }

    it('fails while git would track the file, and names it', async () => {
      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(path.join(projectRoot, '.mcp.json'));
      expect(check.fix).toContain('teamai pull');
    });

    it('passes once git ignores the file', async () => {
      await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(true);
    });

    it.each([
      ['its tool is disabled', async () => { localConfig.disabledAgents = ['claude', 'tclaude']; }],
      ['its tool is no longer detected', async () => { await fse.remove(path.join(projectRoot, '.claude')); }],
      ['it does not parse', async () => {
        await fse.writeFile(path.join(projectRoot, '.mcp.json'), '{ "mcpServers": { "jira": { "headers": { "Authorization": "Bearer t0ken" } } },\n');
      }],
      ['git cannot say whether it would commit it', async () => {
        await fse.writeFile(path.join(projectRoot, '.git', 'config'), '[core\nbroken\n');
      }],
    ])('still fails while git would track the file when %s', async (_label, arrange) => {
      await arrange();

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(path.join(projectRoot, '.mcp.json'));
    });

    it.each([
      ['its server has left mcp.yaml and its tool is disabled', async () => {
        await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');
        localConfig.disabledAgents = ['claude', 'tclaude'];
      }],
      ['the team dropped its tool from toolPaths', async () => {
        teamConfig.toolPaths = { cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' } };
      }],
      ['the team\'s mcp.yaml does not parse', async () => {
        await writeTeamMcp('servers: [unclosed\n');
      }],
    ])('still fails, naming the file once, when %s', async (_label, arrange) => {
      await arrange();

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect((check.fix ?? '').split(path.join(projectRoot, '.mcp.json'))).toHaveLength(2);
    });

    it.each([
      ['notes it wrote a resolved value', { resolved: true }],
      ['is an older teamai\'s, without that note', {}],
    ])('still fails when the server\'s ${VAR} became a literal, its tool is disabled and the record %s', async (_label, note) => {
      const { entryHash } = await import('../resources/mcp-format.js');
      const { mcpServers } = await fse.readJson(path.join(projectRoot, '.mcp.json')) as { mcpServers: Record<string, unknown> };
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'jira', hash: entryHash(mcpServers.jira), ...note }],
      });
      await writeTeamMcp(
        'servers:\n  - name: jira\n    transport: http\n    url: https://jira.example/mcp\n'
        + '    headers:\n      Authorization: "Bearer published-literal"\n',
      );
      localConfig.disabledAgents = ['claude', 'tclaude'];

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(path.join(projectRoot, '.mcp.json'));
    });

    it('fails, naming it once, for a config a pull wrote under a mcpProject the team has since changed', async () => {
      const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      const old = path.join(projectRoot, '.cursor', 'team-mcp.json');
      await fse.outputJson(old, {
        mcpServers: { jira: { type: 'http', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer t0ken' } } },
      });
      expect(await trackResolvedMcpFiles(localConfig, [{ tool: 'cursor', file: old }])).toBe('written');
      await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect((check.fix ?? '').split(old)).toHaveLength(2);
      expect(check.fix).not.toContain(path.join(projectRoot, '.mcp.json'));
    });

    it('fails for a server that was in the file when a pull rebuilt the lost record, after it left mcp.yaml', async () => {
      const { trackResolvedMcpFiles, recordUnverifiedMcpServers } = await import('../mcp-resolved-files.js');
      const file = path.join(projectRoot, '.mcp.json');
      await trackResolvedMcpFiles(localConfig, [{ tool: 'claude', file }]);
      expect(await recordUnverifiedMcpServers(localConfig, [{ file, names: ['jira'] }])).toBe('written');
      await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'h' }],
      });

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(file);
    });

    it('names a file two tools share once', async () => {
      teamConfig.toolPaths = {
        claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: '.mcp.json' },
        codebuddy: { skills: '.codebuddy/skills', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' },
      };
      vi.stubEnv('JIRA_TOKEN', 'long-t0ken-value-7c1');
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
        mcpServers: { jira: { type: 'http', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer long-t0ken-value-7c1' } } },
      });

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect((check.fix ?? '').split(path.join(projectRoot, '.mcp.json'))).toHaveLength(2);
    });

    it('still fails when the manifest is gone but the resolved value is in the file', async () => {
      vi.stubEnv('JIRA_TOKEN', 'long-t0ken-value-7c1');
      await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
        mcpServers: { jira: { type: 'http', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer long-t0ken-value-7c1' } } },
      });
      await fse.remove(managedMcpManifestPath(getDataHome(localConfig), projectRoot));

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
    });

    it('emits no check when the server of that name is the member\'s own, not teamai\'s', async () => {
      await fse.remove(managedMcpManifestPath(getDataHome(localConfig), projectRoot));

      expect(await excludeCheck()).toBeUndefined();
    });

    it.skipIf(process.getuid?.() === 0)('says a server was withheld because its file cannot be kept out of git, and the fix', async () => {
      await fse.remove(path.join(projectRoot, '.mcp.json'));
      vi.stubEnv('JIRA_TOKEN', 'long-t0ken-value-7c1');
      const excludeFile = path.join(projectRoot, '.git', 'info', 'exclude');
      await fse.chmod(excludeFile, 0o444);

      try {
        const check = await mcpCheck();
        expect(await check.check()).toBe(false);
        expect(check.fix).toMatch(/\.git\/info\/exclude is not writable/);
        expect(check.fix).toContain('teamai pull');
        expect(check.fix).not.toContain('again..');
      } finally {
        await fse.chmod(excludeFile, 0o644);
      }
    });

    it('emits no check when the installed servers carry no resolved value', async () => {
      await writeTeamMcp('servers:\n  - name: jira\n    transport: http\n    url: https://jira.example/mcp\n');

      expect(await excludeCheck()).toBeUndefined();
    });

    it('fails the delivery check for a server withheld from a file git tracks, naming the file and the fix once', async () => {
      vi.stubEnv('JIRA_TOKEN', 'fixture-jira-token');
      execFileSync('git', ['add', '.mcp.json'], { cwd: projectRoot });

      const check = await mcpCheck();
      expect(await check.check()).toBe(false);
      const file = path.join(projectRoot, '.mcp.json');
      expect(check.fix).toContain(`In ${file}, withheld: jira, as git would commit the file: git already tracks ${file}.`);
      expect(check.fix).toContain(`git rm --cached ${file}\` (rotate any value a commit of it holds)`);
      expect(check.fix).not.toContain('not the team\'s definition');
      expect(check.fix).not.toContain('pull --force');
    });
  });
});
