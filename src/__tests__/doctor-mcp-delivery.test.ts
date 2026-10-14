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
    expect(check.fix).toContain('If JIRA_PASSWORD is a personal token');
    expect(check.fix).toContain('teamai env add JIRA_PASSWORD --secret');
    expect(check.fix).toContain('teamai env set JIRA_PASSWORD');
    expect(check.fix).toContain('A shared value stays in env.yaml.');
    expect(check.fix).not.toContain('A personal token is not an env.yaml value');
  });

  it.each(['__TEAMAI_TOKEN', 'ZDOTDIR'])('does not suggest declaring reserved %s as a secret', async (reserved) => {
    vi.stubEnv(reserved, undefined);
    await writeTeamMcp(
      'servers:\n  - name: jira\n    transport: stdio\n    command: jira-server\n'
      + `    env:\n      TOKEN: "\${${reserved}}"\n      PASSWORD: "\${JIRA_PASSWORD}"\n`,
    );
    await writeClaudeConfig({});

    const check = await mcpCheck();
    expect(await check.check()).toBe(false);
    expect(check.fix).toContain(reserved);
    expect(check.fix).toContain('teamai env add JIRA_PASSWORD --secret');
    expect(check.fix).not.toContain(`teamai env add ${reserved}`);
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

    it('fails for a moved tool\'s file while the tool mapping it today owns that server name only under another key', async () => {
      const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      teamConfig.toolPaths = { ...teamConfig.toolPaths, opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: 'shared/mcp.json' } };
      const shared = path.join(projectRoot, 'shared', 'mcp.json');
      await fse.outputJson(shared, {
        mcpServers: { x: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t0ken-of-cursor' } } },
        mcp: { x: { type: 'remote', url: 'https://x.example/mcp' } },
      });
      expect(await trackResolvedMcpFiles(localConfig, [{ tool: 'cursor', file: shared }])).toBe('written');
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('opencode', true)]: [{ name: 'x', hash: 'fixture-hash', resolved: false }],
      });
      await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix ?? '').toContain(shared);
    });

    it('fails for a moved Copilot\'s file while the tool mapping it today owns that server name only under mcpServers', async () => {
      const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
      teamConfig.toolPaths = {
        ...teamConfig.toolPaths,
        cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: 'shared/mcp.json' },
        copilot: { skills: '.github/skills', mcp: '.copilot/mcp-config.json', mcpProject: '.github/mcp.json' },
      };
      const shared = path.join(projectRoot, 'shared', 'mcp.json');
      await fse.outputJson(shared, {
        x: { type: 'http', url: 'https://x.example/mcp', headers: { Authorization: 'Bearer t0ken-of-copilot' } },
        mcpServers: { x: { type: 'http', url: 'https://x.example/mcp' } },
      });
      expect(await trackResolvedMcpFiles(localConfig, [{ tool: 'copilot', file: shared }])).toBe('written');
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('cursor', true)]: [{ name: 'x', hash: 'fixture-hash', resolved: false }],
        // Copilot's record describes the file its mapping reaches today, not this one.
        [managedMcpManifestKey('copilot', true)]: [],
      });
      // Cursor's x is still the team's, now a literal: its own rules find nothing to keep.
      await writeTeamMcp('servers:\n  - name: x\n    transport: http\n    url: https://x.example/mcp\n');
      await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix ?? '').toContain(shared);
    });

    describe('for an HTTP-backed team, judged by the records the local agent wrote', () => {
      const writeRecord = (record: Record<string, unknown>): Promise<void> =>
        fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('claude', true)]: [record] });

      beforeEach(async () => {
        Object.assign(localConfig, { repo: { localPath: repoPath, remote: 'https://teamai.example', kind: 'http', url: 'https://teamai.example' } });
        // An HTTP team has no mcp.yaml: its servers arrive through install_mcp.
        await fse.remove(path.join(repoPath, 'mcp'));
      });

      it.each([
        ['notes it carried a header or env value', { name: 'jira', hash: 'h', resolved: true }],
        ['is an older local agent\'s, without that note, and its entry holds a header', { name: 'jira', hash: 'h' }],
      ])('fails while git would track the file, and names it, when the record %s', async (_label, record) => {
        await writeRecord(record);

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect(check.fix).toContain(path.join(projectRoot, '.mcp.json'));
        // No pull writes an HTTP team's servers, so none lists the file.
        expect(check.fix).not.toContain('teamai pull');
      });

      it('passes once git ignores the file', async () => {
        await writeRecord({ name: 'jira', hash: 'h', resolved: true });
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(true);
      });

      it('still fails for a file managed-mcp-files.json lists, holding a server, while the manifest has no record for it', async () => {
        const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        await fse.remove(managedMcpManifestPath(getDataHome(localConfig), projectRoot));
        expect(await trackResolvedMcpFiles(localConfig, [{ tool: 'claude', file: path.join(projectRoot, '.mcp.json') }])).toBe('written');

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect(check.fix).toContain(path.join(projectRoot, '.mcp.json'));
      });

      it('still fails while a server carrying a credential has lost its record, though another server\'s remains', async () => {
        await fse.writeJson(path.join(projectRoot, '.mcp.json'), {
          mcpServers: {
            jira: { type: 'http', url: 'https://jira.example/mcp', headers: { Authorization: 'Bearer t0ken' } },
            local: { command: 'local-mcp' },
          },
        });
        await writeRecord({ name: 'local', hash: 'h', resolved: false });

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
      });

      it('fails for a credential a local agent from before 57636a27 wrote at CodeBuddy\'s former .codebuddy/mcp.json', async () => {
        const old = path.join(projectRoot, '.codebuddy', 'mcp.json');
        await fse.outputJson(old, { mcpServers: { clawpro: { type: 'http', url: 'https://clawpro.example/mcp', headers: { Authorization: 'Bearer t0ken' } } } });
        await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
          [managedMcpManifestKey('codebuddy', true)]: [{ name: 'clawpro', hash: 'h' }],
        });

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect(check.fix ?? '').toContain(old);
      });

      it('has nothing to say of a file whose recorded server carries neither header nor env value', async () => {
        const jira = { type: 'http', url: 'https://jira.example/mcp' };
        await fse.writeJson(path.join(projectRoot, '.mcp.json'), { mcpServers: { jira } });
        const { entryHash } = await import('../resources/mcp-format.js');
        await writeRecord({ name: 'jira', hash: entryHash(jira), resolved: false });

        expect(await excludeCheck()).toBeUndefined();
      });
    });

    describe('a config an older teamai wrote under a mapping an earlier teamai.yaml made, before a pull on this version', () => {
      const old = (): string => path.join(projectRoot, '.cursor', 'team-mcp.json');
      const commitTeamYaml = (toolPaths: object): void => {
        fse.writeFileSync(path.join(repoPath, 'teamai.yaml'), JSON.stringify({ team: 't', toolPaths }));
        execFileSync('git', ['add', '-A'], { cwd: repoPath });
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'toolPaths'], { cwd: repoPath });
      };

      beforeEach(async () => {
        execFileSync('git', ['init', '-q'], { cwd: repoPath });
        commitTeamYaml({ ...teamConfig.toolPaths, cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: '.cursor/team-mcp.json' } });
        commitTeamYaml(teamConfig.toolPaths ?? {});
        // Its server left mcp.yaml since, and no record names the file.
        await fse.outputJson(old(), {
          mcpServers: { gone: { type: 'http', url: 'https://gone.example/mcp', headers: { Authorization: 'Bearer t0ken' } } },
        });
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');
      });

      it('fails, naming it, without writing managed-mcp-files.json', async () => {
        const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect((check.fix ?? '').split(old())).toHaveLength(2);
        expect(check.fix).not.toContain(path.join(projectRoot, '.mcp.json'));
        expect(await fse.pathExists(resolvedMcpFilesPath(localConfig) ?? '')).toBe(false);
      });

      it('passes once it is kept out of git', async () => {
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.cursor/team-mcp.json\n');

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(true);
      });

      it.each([
        ['a pull on this version has read those mappings', async () => {
          const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
          await fse.outputJson(resolvedMcpFilesPath(localConfig) ?? '', { version: 1, files: {}, earlierMappingsRead: true });
        }],
        ['git tracks it', async () => {
          execFileSync('git', ['add', '-f', '.cursor/team-mcp.json'], { cwd: projectRoot });
        }],
        ['git cannot read the team repo\'s history', async () => {
          await fse.emptyDir(path.join(repoPath, '.git', 'objects'));
        }],
      ])('does not name it when %s', async (_label, arrange) => {
        await arrange();

        const check = await excludeCheck();
        if (check) expect(check.fix).not.toContain(old());
        // .mcp.json is listed, so nothing is left to fail on.
        if (check) expect(await check.check()).toBe(true);
      });

      describe('recorded as tracked by a pull that found git tracking it', () => {
        beforeEach(async () => {
          const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
          await fse.outputJson(resolvedMcpFilesPath(localConfig) ?? '', {
            version: 1, files: { [old()]: { tools: ['cursor'], tracked: true } }, earlierMappingsRead: true,
          });
        });

        it('does not name it while git tracks it', async () => {
          execFileSync('git', ['add', '-f', '.cursor/team-mcp.json'], { cwd: projectRoot });

          const check = await excludeCheck();
          if (check) expect(check.fix).not.toContain(old());
          if (check) expect(await check.check()).toBe(true);
        });

        it('fails, naming it, once git no longer tracks it', async () => {
          const check = await excludeCheck();
          if (!check) throw new Error('no git exclude check');
          expect(await check.check()).toBe(false);
          expect((check.fix ?? '').split(old())).toHaveLength(2);
        });
      });
    });

    describe('a tool\'s built-in location, once the team moved the tool, and its records describe the file it maps now', () => {
      const old = (): string => path.join(projectRoot, '.cursor', 'mcp.json');

      beforeEach(async () => {
        teamConfig.toolPaths = {
          claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: '.mcp.json' },
          cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: '.cursor/team-mcp.json' },
        };
        // Its server left mcp.yaml since.
        await fse.outputJson(old(), {
          mcpServers: { gone: { type: 'http', url: 'https://gone.example/mcp', headers: { Authorization: 'Bearer t0ken' } } },
        });
        await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
          [managedMcpManifestKey('claude', true)]: [{ name: 'jira', hash: 'h' }],
          [managedMcpManifestKey('cursor', true)]: [],
        });
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.mcp.json\n');
      });

      it('fails, naming it once', async () => {
        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect((check.fix ?? '').split(old())).toHaveLength(2);
        expect(check.fix).not.toContain(path.join(projectRoot, '.mcp.json'));
      });

      it('passes once it is kept out of git', async () => {
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), '/.cursor/mcp.json\n');

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(true);
      });
    });

    // The toolPaths here drop CodeBuddy, whose built-in location is Claude's .mcp.json.
    describe('a tool\'s built-in location another tool maps today, once the team moved or dropped the tool', () => {
      const file = (): string => path.join(projectRoot, '.mcp.json');

      beforeEach(async () => {
        await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');
        // Claude's own entry, and one an older teamai wrote there for CodeBuddy, whose record is lost.
        await fse.writeJson(file(), {
          mcpServers: {
            docs: { type: 'http', url: 'https://docs.example/mcp' },
            gone: { type: 'http', url: 'https://gone.example/mcp', headers: { Authorization: 'Bearer t0ken' } },
          },
        });
        await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
          [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'h', resolved: false }],
        });
      });

      it('fails, naming it once, while it holds a server none of the tools mapping it own', async () => {
        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect((check.fix ?? '').split(file())).toHaveLength(2);
      });

      it('emits no check once only their servers are left', async () => {
        await fse.writeJson(file(), { mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } });

        expect(await excludeCheck()).toBeUndefined();
      });
    });

    describe('a config written for a tool the team has since moved, that another tool\'s mapping still reaches', () => {
      const file = (): string => path.join(projectRoot, '.mcp.json');

      beforeEach(async () => {
        const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
        teamConfig.toolPaths = {
          claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: '.mcp.json' },
          cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: '.cursor/mcp.json' },
        };
        await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');
        // Claude's own entry, and the one a pull wrote there for Cursor with a token before the team moved it.
        await fse.writeJson(file(), {
          mcpServers: {
            docs: { type: 'http', url: 'https://docs.example/mcp' },
            gone: { type: 'http', url: 'https://gone.example/mcp', headers: { Authorization: 'Bearer t0ken' } },
          },
        });
        await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
          [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'h', resolved: false }],
        });
        expect(await trackResolvedMcpFiles(localConfig, [{ tool: 'cursor', file: file() }])).toBe('written');
      });

      it('fails, naming it once, while it holds a server none of the tools mapping it own', async () => {
        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect((check.fix ?? '').split(file())).toHaveLength(2);
      });

      it('emits no check once only their servers are left', async () => {
        await fse.writeJson(file(), { mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } });

        expect(await excludeCheck()).toBeUndefined();
      });

      describe('written by an older teamai under a mapping only an earlier teamai.yaml made, before a pull on this version', () => {
        beforeEach(async () => {
          const { resolvedMcpFilesPath } = await import('../mcp-resolved-files.js');
          await fse.remove(resolvedMcpFilesPath(localConfig) ?? '');
          execFileSync('git', ['init', '-q'], { cwd: repoPath });
          for (const cursorFile of ['.mcp.json', '.cursor/mcp.json']) {
            const toolPaths = { ...teamConfig.toolPaths, cursor: { skills: '.cursor/skills', mcp: '.cursor/mcp.json', mcpProject: cursorFile } };
            fse.writeFileSync(path.join(repoPath, 'teamai.yaml'), JSON.stringify({ team: 't', toolPaths }));
            execFileSync('git', ['add', '-A'], { cwd: repoPath });
            execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'toolPaths'], { cwd: repoPath });
          }
        });

        it('fails, naming it once, while it holds a server none of the tools mapping it own', async () => {
          const check = await excludeCheck();
          if (!check) throw new Error('no git exclude check');
          expect(await check.check()).toBe(false);
          expect((check.fix ?? '').split(file())).toHaveLength(2);
        });

        it('emits no check once only their servers are left', async () => {
          await fse.writeJson(file(), { mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } });

          expect(await excludeCheck()).toBeUndefined();
        });
      });
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

    it('fails, naming it, while this worktree has no managed-mcp.json and the file holds a server since dropped from mcp.yaml', async () => {
      teamConfig.toolPaths = { ...teamConfig.toolPaths, codebuddy: { skills: '.codebuddy/skills', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' } };
      await fse.remove(managedMcpManifestPath(getDataHome(localConfig), projectRoot));
      await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect((check.fix ?? '').split(path.join(projectRoot, '.mcp.json'))).toHaveLength(2);
    });

    it('fails the same way while an installed tool mapping the file has no record, though another tool\'s is there', async () => {
      teamConfig.toolPaths = { ...teamConfig.toolPaths, codebuddy: { skills: '.codebuddy/skills', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' } };
      await fse.ensureDir(path.join(projectRoot, '.codebuddy', 'skills'));
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'fixture-hash', resolved: false }],
      });
      await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
    });

    it('fails the same way for the config an uninstalled tool left, its record lost, though another tool\'s is there', async () => {
      teamConfig.toolPaths = { ...teamConfig.toolPaths, opencode: { skills: '.opencode/skills', mcp: '.config/opencode/opencode.json', mcpProject: 'opencode.json' } };
      await fse.outputJson(path.join(projectRoot, 'opencode.json'), { mcp: { stale: { type: 'remote', url: 'https://stale.example/mcp' } } });
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'fixture-hash', resolved: false }],
      });
      await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect(check.fix ?? '').toContain(path.join(projectRoot, 'opencode.json'));
    });

    it('fails the same way while the record a pull wrote without managed-mcp.json is still marked unnoted', async () => {
      teamConfig.toolPaths = { ...teamConfig.toolPaths, codebuddy: { skills: '.codebuddy/skills', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' } };
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {
        [managedMcpManifestKey('claude', true)]: [{ name: 'docs', hash: 'fixture-hash', unnoted: true }],
      });
      await writeTeamMcp('servers:\n  - name: docs\n    transport: http\n    url: https://docs.example/mcp\n');

      const check = await excludeCheck();
      if (!check) throw new Error('no git exclude check');
      expect(await check.check()).toBe(false);
      expect((check.fix ?? '').split(path.join(projectRoot, '.mcp.json'))).toHaveLength(2);
    });

    it('emits no check when the server of that name is the member\'s own, not teamai\'s', async () => {
      // CodeBuddy at its built-in .mcp.json: dropped, any server there Claude's records don't own would hold it.
      teamConfig.toolPaths = { ...teamConfig.toolPaths, codebuddy: { skills: '.codebuddy/skills', mcp: '.codebuddy/mcp.json', mcpProject: '.mcp.json' } };
      // teamai owns nothing there. With no managed-mcp.json at all, any server would hold it.
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), { [managedMcpManifestKey('claude', true)]: [] });

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
    // The appliers replace the file itself but follow its directories (#886).
    describe('for a config under a symlinked directory, judged where the write lands', () => {
      const logical = (): string => path.join(projectRoot, 'cfg', 'mcp.json');

      beforeEach(async () => {
        teamConfig.toolPaths = { claude: { skills: '.claude/skills', mcp: '.claude.json', mcpProject: 'cfg/mcp.json' } };
        await fse.move(path.join(projectRoot, '.mcp.json'), path.join(projectRoot, 'config', 'mcp.json'));
        await fse.symlink('config', path.join(projectRoot, 'cfg'), 'dir');
      });

      it('fails while git tracks the file it lands in, naming both paths', async () => {
        execFileSync('git', ['add', 'config/mcp.json'], { cwd: projectRoot });

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(false);
        expect(check.fix).toContain(`${path.join(await fse.realpath(projectRoot), 'config', 'mcp.json')} (where ${logical()} is written)`);
      });

      it.each([
        ['passes once git ignores the file it lands in', '/config/mcp.json\n', true],
        ['still fails when git ignores only the path it is reached by', '/cfg/mcp.json\n', false],
      ])('%s', async (_label, line, ok) => {
        await fse.appendFile(path.join(projectRoot, '.git', 'info', 'exclude'), line);

        const check = await excludeCheck();
        if (!check) throw new Error('no git exclude check');
        expect(await check.check()).toBe(ok);
      });

      it('passes when the directory links outside any repository', async () => {
        const outside = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-no-repo-'));
        await fse.move(path.join(projectRoot, 'config', 'mcp.json'), path.join(outside, 'mcp.json'));
        await fse.remove(path.join(projectRoot, 'cfg'));
        await fse.symlink(outside, path.join(projectRoot, 'cfg'), 'dir');

        try {
          const check = await excludeCheck();
          if (!check) throw new Error('no git exclude check');
          expect(await check.check()).toBe(true);
        } finally {
          await fse.remove(outside);
        }
      });
    });
  });

  // Codex loads a project's .codex/config.toml only in a trusted project, by
  // the first `projects` entry for the checkout or its main checkout (#954).
  describe('Codex project trust for team MCP servers (#954)', () => {
    const NAME = 'Codex trusts this project, so it loads its team MCP servers';
    let projectRoot: string;

    async function useCheckout(root: string): Promise<void> {
      projectRoot = root;
      Object.assign(localConfig, { scope: 'project', projectRoot: root });
      await fse.outputFile(path.join(root, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs-server"\nargs = []\n');
      await fse.ensureDir(path.join(root, '.codex', 'skills'));
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), root), {
        [managedMcpManifestKey('codex', true)]: [{ name: 'docs', hash: 'h' }],
      });
    }

    async function trustCheck(): Promise<Check | undefined> {
      return (await checks()).find((c) => c.name === NAME);
    }

    async function writeCodexConfig(toml: string, root = '.codex'): Promise<string> {
      const file = path.join(homeDir, root, 'config.toml');
      await fse.outputFile(file, toml);
      return file;
    }

    const trusted = (dir: string, level = 'trusted'): string => `[projects.${JSON.stringify(dir)}]\ntrust_level = "${level}"\n`;

    beforeEach(async () => {
      const root = path.join(tempDir, 'codex-repo');
      await fse.ensureDir(root);
      execFileSync('git', ['init', '-q'], { cwd: root });
      teamConfig.toolPaths = { codex: { skills: '.codex/skills', mcp: '.codex/config.toml', mcpProject: '.codex/config.toml' } };
      await useCheckout(root);
    });

    it('fails while Codex has no entry for the project, and gives the lines that trust it', async () => {
      const codexConfig = await writeCodexConfig('model = "gpt-5"\n');
      const real = await fse.realpath(projectRoot);

      const check = await trustCheck();
      if (!check) throw new Error('no Codex trust check');
      expect(await check.check()).toBe(false);
      expect(check.fix).toContain(path.join(projectRoot, '.codex', 'config.toml'));
      expect(check.fix).toContain('docs');
      expect(check.fix).toContain(codexConfig);
      expect(check.fix).toContain(`add a [projects.${JSON.stringify(real)}] table holding trust_level = "trusted"`);
    });

    it('passes once Codex trusts the project by its real path', async () => {
      await writeCodexConfig(trusted(await fse.realpath(projectRoot)));

      expect(await (await trustCheck())?.check()).toBe(true);
    });

    it('fails when Codex marks the project untrusted, and says which entry decides', async () => {
      const real = await fse.realpath(projectRoot);
      await writeCodexConfig(trusted(real, 'untrusted'));

      const check = await trustCheck();
      expect(await check?.check()).toBe(false);
      expect(check?.fix).toContain(`[projects.${JSON.stringify(real)}]`);
      expect(check?.fix).toContain('"untrusted"');
    });

    describe('in a linked worktree', () => {
      let main: string;

      beforeEach(async () => {
        main = await fse.realpath(projectRoot);
        const git = (...args: string[]): void => {
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: main });
        };
        git('commit', '-q', '--allow-empty', '-m', 'init');
        const worktree = path.join(tempDir, 'codex-wt');
        git('worktree', 'add', '-q', worktree);
        await useCheckout(worktree);
      });

      it('passes once Codex trusts the main checkout', async () => {
        await writeCodexConfig(trusted(main));

        expect(await (await trustCheck())?.check()).toBe(true);
      });

      it('passes over a worktree entry without a trust_level, which decides nothing', async () => {
        await writeCodexConfig(`[projects.${JSON.stringify(await fse.realpath(projectRoot))}]\n${trusted(main)}`);

        expect(await (await trustCheck())?.check()).toBe(true);
      });

      it('fails when the worktree entry is untrusted, whatever the main checkout says', async () => {
        const worktree = await fse.realpath(projectRoot);
        await writeCodexConfig(trusted(worktree, 'untrusted') + trusted(main));

        const check = await trustCheck();
        expect(await check?.check()).toBe(false);
        expect(check?.fix).toContain(`[projects.${JSON.stringify(worktree)}]`);
      });
    });

    it('reads the Codex config of the recorded CODEX_HOME root', async () => {
      Object.assign(localConfig, { toolRoots: { codex: path.join(homeDir, '.codex-alt') } });
      await writeCodexConfig(trusted(await fse.realpath(projectRoot)));
      const altConfig = await writeCodexConfig('', '.codex-alt');

      const check = await trustCheck();
      expect(await check?.check()).toBe(false);
      expect(check?.fix).toContain(altConfig);
    });

    it('fails with the parse error when the Codex config does not parse', async () => {
      const codexConfig = await writeCodexConfig('[projects\n');

      const check = await trustCheck();
      expect(await check?.check()).toBe(false);
      expect(check?.fix).toContain(`${codexConfig} could not be parsed`);
    });

    it('is not built while the project config holds no team server', async () => {
      await fse.outputJson(managedMcpManifestPath(getDataHome(localConfig), projectRoot), {});

      expect(await trustCheck()).toBeUndefined();
    });
  });
});
