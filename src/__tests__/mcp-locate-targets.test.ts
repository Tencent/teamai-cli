import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn(), persist: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() })),
}));

import { buildMcpReadFileChecks, mcpTransportNotes } from '../doctor-delivery.js';
import type { DoctorContext } from '../doctor.js';
import { mcpFormatOf } from '../tools.js';
import { log } from '../utils/logger.js';
import { judgeTeamaiOnlyMcpConfigs, reconcileMcpForConfig } from '../mcp-reconcile.js';
import { entryHash, renderCodexBlock, renderJsonEntry } from '../resources/mcp-format.js';
import { managedMcpManifestKey, TeamaiConfigSchema, type LocalConfig, type McpServerDef, type TeamaiConfig } from '../types.js';

const API: McpServerDef = { name: 'api', transport: 'http', url: 'https://api.example.com/mcp' };
const MINE = { type: 'stdio', command: 'my-own-server' };

describe('pull writes MCP servers where each tool reads them (#1221)', () => {
  let root: string;
  let home: string;
  let repo: string;

  const userConfig = (tool: string): LocalConfig => ({
    repo: { localPath: repo, remote: 'fixture' }, username: 'tester', scope: 'user', enabledAgents: [tool], additionalRoles: [],
  });
  const team = (sharing: Record<string, unknown> = {}): TeamaiConfig =>
    TeamaiConfigSchema.parse({ team: 'fixture', repo: 'fixture', provider: 'git', sharing });

  beforeEach(async () => {
    root = fs.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mcp-locate-')));
    home = path.join(root, 'home');
    repo = path.join(root, 'repo');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    for (const name of ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CODEBUDDY_CONFIG_DIR']) vi.stubEnv(name, '');
    await fse.ensureDir(path.join(home, '.teamai'));
    await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers:\n  - name: api\n    transport: http\n    url: https://api.example.com/mcp\n');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  describe('WorkBuddy, which reads only the first of ~/.workbuddy/.mcp.json, ~/.workbuddy/mcp.json, ~/.codebuddy.json that exists', () => {
    it('writes the member\'s ~/.workbuddy/.mcp.json, not the ~/.workbuddy/mcp.json it hides', async () => {
      await fse.outputJson(path.join(home, '.workbuddy', '.mcp.json'), { mcpServers: { mine: MINE } });

      await reconcileMcpForConfig(team(), userConfig('workbuddy'));

      expect(await fse.readJson(path.join(home, '.workbuddy', '.mcp.json'))).toEqual({
        mcpServers: { mine: MINE, api: renderJsonEntry('buddy', API) },
      });
      expect(await fse.pathExists(path.join(home, '.workbuddy', 'mcp.json'))).toBe(false);
    });

    it('takes the servers an earlier pull wrote out of ~/.workbuddy/mcp.json once it writes ~/.workbuddy/.mcp.json', async () => {
      const api = renderJsonEntry('buddy', API);
      await fse.outputJson(path.join(home, '.workbuddy', '.mcp.json'), { mcpServers: { mine: MINE } });
      await fse.outputJson(path.join(home, '.workbuddy', 'mcp.json'), { mcpServers: { api, other: MINE } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { workbuddy: [{ name: 'api', hash: entryHash(api) }] });

      await reconcileMcpForConfig(team(), userConfig('workbuddy'));

      expect((await fse.readJson(path.join(home, '.workbuddy', '.mcp.json'))).mcpServers).toEqual({ mine: MINE, api });
      expect(await fse.readJson(path.join(home, '.workbuddy', 'mcp.json'))).toEqual({ mcpServers: { other: MINE } });
    });
  });

  it('writes WorkBuddy\'s project servers to its local scope in .codebuddy.json while sharing.gitExclude is on', async () => {
    const project = path.join(root, 'project');
    await fse.ensureDir(path.join(project, '.workbuddy'));
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('workbuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };

    await reconcileMcpForConfig(team({ gitExclude: { enabled: true } }), local);

    expect((await fse.readJson(path.join(home, '.codebuddy.json'))).projects[project].mcpServers).toEqual({ api: renderJsonEntry('buddy', API) });
    expect(await fse.pathExists(path.join(project, '.workbuddy', 'mcp.json'))).toBe(false);
  });

  it.each([['.mcp.json', false], ['mcp.json', false], ['.mcp.json', true]] as const)('writes WorkBuddy project servers to %s with gitExclude=%s and retires the old project file', async (name, gitExclude) => {
    const project = path.join(root, 'project');
    const api = renderJsonEntry('buddy', API);
    const old = path.join(project, '.workbuddy', 'mcp.json');
    await fse.outputJson(old, { mcpServers: { api, other: MINE } });
    await fse.outputJson(path.join(project, name), { mcpServers: { mine: MINE } });
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('workbuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    const { loadMcpManifest, saveMcpManifest } = await import('../mcp-reconcile.js');
    const { manifestPath, manifest } = await loadMcpManifest(local, false);
    manifest['workbuddy:project'] = [{ name: 'api', hash: entryHash(api) }];
    await saveMcpManifest(local, manifestPath, manifest);

    await reconcileMcpForConfig(team({ gitExclude: { enabled: gitExclude } }), local);

    if (gitExclude) {
      expect((await fse.readJson(path.join(home, '.codebuddy.json'))).projects[project].mcpServers).toEqual({ api });
    } else {
      expect((await fse.readJson(path.join(project, name))).mcpServers).toEqual({ mine: MINE, api });
    }
    expect(await fse.readJson(old)).toEqual({ mcpServers: { other: MINE } });
    if (name === 'mcp.json') expect(await fse.pathExists(path.join(project, '.mcp.json'))).toBe(false);
  });

  it('writes Pi\'s user servers to the agent directory PI_CODING_AGENT_DIR names', async () => {
    const agentDir = path.join(root, 'pi-agent');
    await fse.ensureDir(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    await reconcileMcpForConfig(team(), userConfig('pi'));

    expect((await fse.readJson(path.join(agentDir, 'mcp.json'))).mcpServers).toEqual({ api: renderJsonEntry('pi', API) });
    expect(await fse.pathExists(path.join(home, '.pi', 'agent', 'mcp.json'))).toBe(false);
  });

  it.each([
    ['XDG_CONFIG_HOME', (dir: string) => path.join(dir, 'opencode')],
    ['OPENCODE_CONFIG_DIR', (dir: string) => dir],
  ])('writes OpenCode\'s user servers to the config directory %s moves it to', async (variable, configDir) => {
    const dir = path.join(root, 'moved');
    await fse.ensureDir(configDir(dir));
    vi.stubEnv(variable, dir);

    await reconcileMcpForConfig(team(), userConfig('opencode'));

    expect((await fse.readJson(path.join(configDir(dir), 'opencode.json'))).mcp).toEqual({ api: renderJsonEntry('opencode', API) });
    expect(await fse.pathExists(path.join(home, '.config', 'opencode', 'opencode.json'))).toBe(false);
  });

  describe('ZCode, which reads mcp.servers in its own config files (ZCode 3.16.2 source; 3.15.1 not certified)', () => {
    it('writes the user servers to ~/.zcode/cli/config.json, keeping its other keys', async () => {
      const config = path.join(home, '.zcode', 'cli', 'config.json');
      await fse.outputJson(config, { hooks: { enabled: true }, mcp: { timeout: 5 } });

      await reconcileMcpForConfig(team(), userConfig('zcode'));

      expect(await fse.readJson(config)).toEqual({ hooks: { enabled: true }, mcp: { timeout: 5, servers: { api: renderJsonEntry('claude', API) } } });
      expect(await fse.pathExists(path.join(home, '.agents', 'mcp.json'))).toBe(false);
    });

    it('takes the servers an earlier pull wrote out of ~/.agents/mcp.json, and leaves the member\'s', async () => {
      const api = renderJsonEntry('claude', API);
      await fse.ensureDir(path.join(home, '.zcode', 'cli'));
      await fse.outputJson(path.join(home, '.agents', 'mcp.json'), { mcpServers: { api, mine: MINE } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(api) }] });

      await reconcileMcpForConfig(team(), userConfig('zcode'));

      expect((await fse.readJson(path.join(home, '.zcode', 'cli', 'config.json'))).mcp.servers).toEqual({ api });
      expect(await fse.readJson(path.join(home, '.agents', 'mcp.json'))).toEqual({ mcpServers: { mine: MINE } });
    });

    it.each([
      { mode: 'uninstall', mapped: '.agents/mcp.json' },
      { mode: 'pull', mapped: '.agents/mcp.json' },
      { mode: 'uninstall', mapped: '.zcode/cli/config.json' },
      { mode: 'pull', mapped: '.zcode/cli/config.json' },
    ] as const)('$mode: an earlier release\'s servers under mcpServers in ~/.agents/mcp.json, with the team mapping mcp to $mapped', async ({ mode, mapped }) => {
      const api = renderJsonEntry('claude', API);
      const edited = { type: 'stdio', command: 'edited' };
      const legacy = path.join(home, '.agents', 'mcp.json');
      const current = path.join(home, mapped);
      await fse.ensureDir(path.join(home, '.zcode', 'cli'));
      await fse.outputJson(legacy, { mcpServers: { api, edited: { ...edited, args: ['by-member'] }, mine: MINE } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(api) }, { name: 'edited', hash: entryHash(edited) }] });
      const legacyTeam = TeamaiConfigSchema.parse({
        team: 'fixture', repo: 'fixture', provider: 'git',
        toolPaths: { zcode: { skills: '.zcode/skills', agents: '.zcode/agents', settings: '.zcode/cli/config.json', mcp: mapped } },
      });

      await reconcileMcpForConfig(legacyTeam, userConfig('zcode'), { removeAll: mode === 'uninstall' });

      const left = { edited: { ...edited, args: ['by-member'] }, mine: MINE };
      expect((await fse.readJson(legacy)).mcpServers).toEqual(left);
      expect((await fse.readJson(current).catch(() => ({}))).mcp?.servers ?? {}).toEqual(mode === 'pull' ? { api } : {});
      const manifest = await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json'));
      expect(manifest.zcode ?? []).toEqual(mode === 'pull' ? [{ name: 'api', hash: entryHash(api), file: current }] : []);
    });

    it.each([
      { mode: 'uninstall', legacyState: 'unparsable' },
      { mode: 'pull', legacyState: 'unparsable' },
      { mode: 'uninstall', legacyState: 'unreadable' },
      { mode: 'pull', legacyState: 'unreadable' },
    ] as const)('$mode keeps an earlier release\'s record while ~/.agents/mcp.json is $legacyState, so an uninstall after it is repaired removes the server', async ({ mode, legacyState }) => {
      if (legacyState === 'unreadable' && (process.platform === 'win32' || process.getuid?.() === 0)) return;
      const api = renderJsonEntry('claude', API);
      const legacy = path.join(home, '.agents', 'mcp.json');
      const current = path.join(home, '.zcode', 'cli', 'config.json');
      const repaired = { mcpServers: { api, mine: MINE } };
      await fse.ensureDir(path.dirname(current));
      await fse.outputFile(legacy, legacyState === 'unparsable' ? '{ "mcpServers": {' : JSON.stringify(repaired));
      if (legacyState === 'unreadable') await fs.promises.chmod(legacy, 0o000);
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(api) }] });

      await reconcileMcpForConfig(team(), userConfig('zcode'), { removeAll: mode === 'uninstall' });

      const manifest = await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json')).catch(() => ({}));
      expect(manifest.zcode ?? []).toContainEqual({ name: 'api', hash: entryHash(api), file: legacy, key: ['mcpServers'] });

      if (legacyState === 'unreadable') await fs.promises.chmod(legacy, 0o644);
      await fse.outputJson(legacy, repaired);
      await reconcileMcpForConfig(team(), userConfig('zcode'), { removeAll: true });

      expect(await fse.readJson(legacy)).toEqual({ mcpServers: { mine: MINE } });
      expect((await fse.readJson(current).catch(() => ({}))).mcp?.servers ?? {}).toEqual({});
      expect((await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json')).catch(() => ({}))).zcode ?? []).toEqual([]);
    });

    it('writes a project\'s servers to <project>/.zcode/config.json', async () => {
      const project = path.join(root, 'project');
      await fse.ensureDir(path.join(home, '.zcode'));
      await fse.outputJson(path.join(project, '.zcode', 'config.json'), { model: 'glm' });
      execFileSync('git', ['init', '-q', project]);
      const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };

      await reconcileMcpForConfig(team(), local);

      expect(await fse.readJson(path.join(project, '.zcode', 'config.json'))).toEqual({ model: 'glm', mcp: { servers: { api: renderJsonEntry('claude', API) } } });
    });

    it('judges a project\'s .zcode/config.json holding nothing but teamai\'s servers teamai\'s alone, and one with other keys not', async () => {
      const project = path.join(root, 'project');
      await fse.ensureDir(path.join(project, '.zcode'));
      execFileSync('git', ['init', '-q', project]);
      const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
      const file = path.join(project, '.zcode', 'config.json');

      await reconcileMcpForConfig(team(), local);
      const alone = await judgeTeamaiOnlyMcpConfigs(team(), local);
      await fse.writeJson(file, { ...await fse.readJson(file), model: 'glm' });

      expect(alone).toEqual([{ file, teamaiOnly: true }]);
      expect(await judgeTeamaiOnlyMcpConfigs(team(), local)).toEqual([{ file, teamaiOnly: false }]);
    });
  });

  it('reads a recorded ZCode config through its nested key after the team changes its mapping', async () => {
    const project = path.join(root, 'project');
    const file = path.join(project, '.zcode', 'before.json');
    await fse.outputJson(file, { mcp: { servers: { api: renderJsonEntry('claude', API) } } });
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('zcode'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    const { trackResolvedMcpFiles } = await import('../mcp-resolved-files.js');
    const { recordedMcpTargets, installedMcpEntries } = await import('../mcp-reconcile.js');
    await trackResolvedMcpFiles(local, [{ tool: 'zcode', file }]);

    const group = (await recordedMcpTargets(local, [])).get(file);
    const target = group?.targets[0];
    if (target === undefined) throw new Error('missing recorded ZCode config');

    expect(await installedMcpEntries(target)).toEqual(new Map([['api', renderJsonEntry('claude', API)]]));
  });

  it('keeps a member\'s server in the moved CodeBuddy home that an earlier release\'s record, noting no file, does not own', async () => {
    const api = renderJsonEntry('buddy', API);
    const moved = path.join(root, 'moved');
    await fse.outputJson(path.join(home, '.codebuddy', 'mcp.json'), { mcpServers: { api } });
    await fse.outputJson(path.join(moved, 'mcp.json'), { mcpServers: { api: MINE } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { codebuddy: [{ name: 'api', hash: entryHash(api) }] });
    await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), 'servers:\n  - name: api\n    transport: http\n    url: https://api.example.com/v2\n');
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);

    await reconcileMcpForConfig(team(), userConfig('codebuddy'));

    expect(await fse.readJson(path.join(moved, 'mcp.json'))).toEqual({ mcpServers: { api: MINE } });
  });

  it('lets uninstall remove CodeBuddy\'s unchanged local-scope servers from the .codebuddy.json it left when CODEBUDDY_CONFIG_DIR moves its home', async () => {
    const project = path.join(root, 'project');
    const before = path.join(home, '.codebuddy.json');
    await fse.ensureDir(path.join(project, '.codebuddy'));
    execFileSync('git', ['init', '-q', project]);
    const local: LocalConfig = { ...userConfig('codebuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
    await reconcileMcpForConfig(team({ gitExclude: { enabled: true } }), local);
    const written = await fse.readJson(before);
    written.projects[project].mcpServers.mine = MINE;
    await fse.outputJson(before, written);
    const moved = path.join(root, 'moved');
    await fse.ensureDir(moved);
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);

    await reconcileMcpForConfig(team(), local, { removeAll: true });

    expect((await fse.readJson(before)).projects[project].mcpServers).toEqual({ mine: MINE });
  });

  it('lets uninstall remove another checkout\'s CodeBuddy servers from the .codebuddy.json its record names after the home moves', async () => {
    const project = path.join(root, 'project');
    const sibling = path.join(root, 'sibling');
    const dataHome = path.join(root, 'data');
    const before = path.join(home, '.codebuddy.json');
    await fse.ensureDir(path.join(project, '.codebuddy'));
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'fixture']);
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', '-b', 'sibling', sibling]);
    const api = renderJsonEntry('buddy', API);
    await fse.outputJson(before, { projects: { [project]: { mcpServers: { api } }, [sibling]: { mcpServers: { api, mine: MINE } } } });
    const record = { name: 'api', hash: entryHash(api), file: before };
    await fse.outputJson(path.join(dataHome, 'managed-local-mcp.json'), { [`codebuddy:local:${project}`]: [record], [`codebuddy:local:${sibling}`]: [record] });
    const moved = path.join(root, 'moved');
    await fse.ensureDir(moved);
    vi.stubEnv('CODEBUDDY_CONFIG_DIR', moved);
    const local: LocalConfig = { ...userConfig('codebuddy'), scope: 'project', projectRoot: project, dataHome };

    await reconcileMcpForConfig(team(), local, { removeAll: true });

    expect((await fse.readJson(before)).projects).toEqual({ [sibling]: { mcpServers: { mine: MINE } } });
  });

  it('uninstall removes a local scope from the file its record names when no team config remains', async () => {
    const dataHome = path.join(root, 'orphan');
    const file = path.join(home, '.claude-team', 'custom.json');
    const project = path.join(root, 'project');
    const api = renderJsonEntry('claude', API);
    await fse.outputJson(file, { projects: { [project]: { mcpServers: { api, mine: MINE } } } });
    await fse.outputJson(path.join(dataHome, 'managed-local-mcp.json'), { [`claude:local:${project}`]: [{ name: 'api', hash: entryHash(api), file }] });
    const { removeLocalScopeMcpServers } = await import('../mcp-reconcile.js');

    expect(await removeLocalScopeMcpServers(dataHome)).toEqual([]);
    expect((await fse.readJson(file)).projects[project].mcpServers).toEqual({ mine: MINE });
  });

  const context = (teamConfig: TeamaiConfig, localConfig: LocalConfig): DoctorContext => ({
    teamConfig, localConfig, toolPaths: teamConfig.toolPaths, hookToolPaths: {}, baseDir: home,
  });

  it('doctor rejects a mapped MCP file the tool does not read', async () => {
    await fse.ensureDir(path.join(home, '.cursor'));
    const config = team();
    config.toolPaths = { ...config.toolPaths, cursor: { ...config.toolPaths.cursor, mcp: '.cursor/unread.json' } };

    const check = (await buildMcpReadFileChecks(context(config, userConfig('cursor'))))
      .find((check) => check.name === 'cursor reads the MCP servers teamai writes');

    expect(check).toBeDefined();
    expect(await check?.check()).toBe(false);
    expect(check?.fix).toContain('toolPaths.cursor.mcp');
  });

  it('doctor reports the MCP file moved since the last write', async () => {
    const before = path.join(home, '.config', 'opencode', 'opencode.json');
    const entry = renderJsonEntry('opencode', API);
    await fse.outputJson(before, { mcp: { api: entry } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { opencode: [{ name: 'api', hash: entryHash(entry), file: before }] });
    const xdg = path.join(root, 'xdg');
    await fse.ensureDir(path.join(xdg, 'opencode'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    const check = (await buildMcpReadFileChecks(context(team(), userConfig('opencode'))))
      .find((check) => check.name === 'opencode MCP servers are where the last write put them');

    expect(check).toBeDefined();
    expect(await check?.check()).toBe(false);
    expect(check?.fix).toContain(before);
  });

  it('doctor warns about ZCode desktop fallback servers the native file hides', async () => {
    await fse.ensureDir(path.join(home, '.zcode'));
    await fse.outputJson(path.join(home, '.agents', 'mcp.json'), { mcpServers: { mine: MINE, api: renderJsonEntry('claude', API) } });
    await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { zcode: [{ name: 'api', hash: entryHash(renderJsonEntry('claude', API)) }] });

    expect(await mcpTransportNotes(context(team(), userConfig('zcode')))).toContain(
      '⚠ ZCode reads ~/.agents/mcp.json only while ~/.zcode/cli/config.json has no servers; move these servers there: mine',
    );
  });

  it.each(['claude-internal', 'codex-internal', 'tcodex'])('doctor notes %s has an unknown MCP channel', async (tool) => {
    await fse.ensureDir(path.join(home, `.${tool}`));

    expect(mcpFormatOf(tool)).toBeNull();
    expect(await mcpTransportNotes(context(team(), userConfig(tool)))).toContain(`${tool}'s MCP channel is unknown; teamai does not write its servers.`);
  });

  it('doctor notes cwd-only MCP from any directory, and nothing left at the default home once the home moves (#1221)', async () => {
    const agentDir = path.join(root, 'pi-agent');
    await fse.ensureDir(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    expect((await mcpTransportNotes(context(team(), userConfig('pi')))).some((note) => note.includes('still writes some of its other files'))).toBe(false);
    const project = path.join(root, 'project');
    await fse.ensureDir(path.join(project, '.pi'));
    const local: LocalConfig = { ...userConfig('pi'), scope: 'project', projectRoot: project };
    const note = `pi reads project MCP servers only from a session started in ${project}.`;
    const cwd = process.cwd();
    try {
      for (const dir of [project, path.join(project, 'src')]) {
        await fse.ensureDir(dir);
        process.chdir(dir);
        expect(await mcpTransportNotes(context(team(), local))).toContain(note);
      }
    } finally {
      process.chdir(cwd);
    }
  });

  describe('the file each server was written to, in its ownership record', () => {
    it('is recorded for every server a pull writes', async () => {
      await fse.ensureDir(path.join(home, '.cursor'));

      await reconcileMcpForConfig(team(), userConfig('cursor'));

      expect(await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json'))).toEqual({
        cursor: [{ name: 'api', hash: entryHash(renderJsonEntry('cursor', API)), file: path.join(home, '.cursor', 'mcp.json') }],
      });
    });

    it('names once, and keeps, the servers an earlier release wrote to OpenCode\'s default home after XDG_CONFIG_HOME moves it', async () => {
      const api = renderJsonEntry('opencode', API);
      const before = path.join(home, '.config', 'opencode', 'opencode.json');
      await fse.outputJson(before, { mcp: { api } });
      await fse.outputJson(path.join(home, '.teamai', 'managed-mcp.json'), { opencode: [{ name: 'api', hash: entryHash(api) }] });
      const xdg = path.join(root, 'xdg');
      const now = path.join(xdg, 'opencode', 'opencode.json');
      await fse.ensureDir(path.dirname(now));
      vi.stubEnv('XDG_CONFIG_HOME', xdg);
      const left = `[user] opencode takes MCP servers from ${now} now, so teamai no longer updates its entries in ${before} (api). `
        + 'Remove them once no tool reads that file.';

      await reconcileMcpForConfig(team(), userConfig('opencode'));
      await reconcileMcpForConfig(team(), userConfig('opencode'));

      expect((await fse.readJson(now)).mcp).toEqual({ api });
      expect(await fse.readJson(before)).toEqual({ mcp: { api } });
      expect(vi.mocked(log.info).mock.calls.filter(([line]) => line === left)).toHaveLength(1);
    });

    // Uninstall takes teamai's unchanged servers out of the file each record names, whatever the tool now reads:
    // under an earlier home (an earlier release's record notes no file) or an earlier toolPaths mapping.
    const json = (tool: Parameters<typeof renderJsonEntry>[0], key: string) => ({
      format: 'JSON', render: (def: McpServerDef) => renderJsonEntry(tool, def),
      write: (entries: Record<string, unknown>) => JSON.stringify({ [key]: entries }),
      read: (text: string) => Object.keys(JSON.parse(text)[key]),
    });
    const toml = {
      format: 'TOML', render: (def: McpServerDef) => renderCodexBlock(def),
      write: (entries: Record<string, unknown>) => `model = "o3"\n\n${Object.values(entries).join('\n')}`,
      read: (text: string) => [...text.matchAll(/^\[mcp_servers\.([\w-]+)\]$/gm)].map(([, name]) => name),
    };
    const leftFiles = [
      { tool: 'opencode', scope: 'user', moves: 'OPENCODE_CONFIG_DIR', file: '.config/opencode/opencode.json', now: 'opencode.json', notesFile: false, ...json('opencode', 'mcp') },
      { tool: 'codex', scope: 'user', moves: 'toolRoots', file: '.codex/config.toml', now: 'config.toml', notesFile: true, ...toml },
      { tool: 'opencode', scope: 'project', moves: 'mcpProject', file: 'opencode.json', now: 'config/opencode.json', notesFile: true, ...json('opencode', 'mcp') },
      { tool: 'claude', scope: 'project', moves: 'mcpProject', file: '.mcp.json', now: 'config/.mcp.json', notesFile: true, ...json('claude', 'mcpServers') },
      { tool: 'codex', scope: 'project', moves: 'mcpProject', file: '.codex/config.toml', now: 'config/config.toml', notesFile: true, ...toml },
    ] as const;
    // A permission a test can take away only from a user who is not root.
    const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;
    const states = ['missing', 'parses', 'unparsable', 'unreadable'] as const;
    // A Codex config.toml is scanned, not parsed: it always reads.
    const occurs = (state: typeof states[number], format: string): boolean =>
      (state !== 'unparsable' || format === 'JSON') && (state !== 'unreadable' || canDenyRead);
    const cases = leftFiles.flatMap((row) => (['uninstall', 'pull'] as const).flatMap((mode) => states.flatMap((current) => states
      .filter((recorded) => occurs(current, row.format) && occurs(recorded, row.format))
      .map((recorded) => ({ ...row, mode, current, recorded })))));

    // What happens to the file a record names and to that record depends on the mode and on that file alone, except
    // that a pull touches nothing while the current file cannot be read, and a record that notes no file (an earlier
    // release's) may name an entry in the current file when its guessed file lacks it.
    it.each(cases)('$mode: $tool $scope ($format) after $moves moves it, current file $current, recorded file $recorded',
      async ({ tool, scope, moves, file, now, notesFile, render, write, read, mode, current, recorded }) => {
        const { loadMcpManifest, saveMcpManifest } = await import('../mcp-reconcile.js');
        const api = render(API);
        const edited = render({ ...API, name: 'edited', url: 'https://edited.example.com/mcp' });
        const mine = render({ name: 'mine', transport: 'stdio', command: 'my-own-server' });
        const project = path.join(root, 'project');
        const base = scope === 'user' ? home : project;
        const before = path.join(base, file);
        const moved = path.join(home, `.${tool}-work`);
        const target = path.join(scope === 'user' ? moved : project, now);
        let config = userConfig(tool);
        const teamConfig = team();
        if (scope === 'project') {
          execFileSync('git', ['init', '-q', project]);
          await fse.ensureDir(path.join(project, `.${tool}`));
          config = { ...config, scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
          teamConfig.toolPaths = { ...teamConfig.toolPaths, [tool]: { ...teamConfig.toolPaths[tool], mcpProject: now } };
        } else {
          // A tool root stays under HOME.
          await fse.ensureDir(moved);
          if (moves === 'toolRoots') config.toolRoots = { [tool]: moved };
          else vi.stubEnv(moves, moved);
        }
        await fse.ensureDir(path.dirname(target));
        const setUp = async (at: string, state: typeof states[number], entries: Record<string, unknown>): Promise<string | null> => {
          if (state === 'missing') return null;
          const contents = write(entries) + (state === 'unparsable' ? '\n}' : '');
          await fse.outputFile(at, contents);
          if (state === 'unreadable') await fs.promises.chmod(at, 0o000);
          return contents;
        };
        const contents = await setUp(before, recorded, { api, edited, mine });
        await setUp(target, current, { mine });
        const noted = notesFile ? { file: before } : {};
        const records = [
          { name: 'api', hash: entryHash(api), ...noted },
          { name: 'edited', hash: entryHash(render({ ...API, name: 'edited' })), ...noted },
          { name: 'gone', hash: entryHash(render({ ...API, name: 'gone' })), ...noted },
        ];
        const key = managedMcpManifestKey(tool, scope === 'project');
        const saved = await loadMcpManifest(config, false);
        saved.manifest[key] = records;
        await saveMcpManifest(config, saved.manifestPath, saved.manifest);

        await reconcileMcpForConfig(teamConfig, config, { removeAll: mode === 'uninstall' });

        if (contents !== null) await fs.promises.chmod(before, 0o600);
        const after = contents === null ? null : await fse.readFile(before, 'utf8');
        const left = ((await loadMcpManifest(config, false)).manifest[key] ?? []).filter((record) => record.file === undefined || record.file === before);
        const currentRead = current === 'missing' || current === 'parses';
        const fileRead = recorded === 'missing' || recorded === 'parses';
        if (mode === 'uninstall' && recorded === 'parses') expect(read(after ?? '')).toEqual(['edited', 'mine']);
        else expect(after).toBe(contents);
        // Kept: the file could not be read, or a pull could not write the current one.
        const keptAll = (mode === 'uninstall' && !fileRead) || (mode === 'pull' && !currentRead);
        // A record of an earlier release whose guessed file lacks its entry follows the current file.
        const followsCurrent = !notesFile && !currentRead && mode === 'uninstall'
          ? records.filter((record) => recorded === 'missing' || record.name === 'gone') : [];
        expect(left.map((record) => record.name)).toEqual((keptAll ? records : followsCurrent).map((record) => record.name));
        // A kept record keeps what it said of a resolved value: an earlier release's says nothing, so the credential hold stays.
        expect(left.map((record) => record.resolved)).toEqual(left.map(() => undefined));
      });

    // The same rule in the scope a project's servers left once sharing.gitExclude goes off: the local scope's
    // file under the tool's old home is cleaned on uninstall whatever state the file under its new home is in.
    const movedHomes = [
      { tool: 'claude', moves: 'the team\'s user MCP file', now: '.claude-team/custom.json' },
      { tool: 'codebuddy', moves: 'CODEBUDDY_CONFIG_DIR', now: '.codebuddy-work/.codebuddy.json' },
    ] as const;
    const localCases = movedHomes.flatMap((row) => (['uninstall', 'pull'] as const).flatMap((mode) => states
      .filter((current) => occurs(current, 'JSON')).map((current) => ({ ...row, mode, current }))));
    it.each(localCases)('$mode: $tool local scope after $moves moves it and sharing.gitExclude goes off, current file $current',
      async ({ tool, now, mode, current }) => {
        const api = renderJsonEntry(tool === 'claude' ? 'claude' : 'buddy', API);
        const project = path.join(root, 'project');
        const dataHome = path.join(root, 'data');
        const before = path.join(home, tool === 'claude' ? '.claude.json' : '.codebuddy.json');
        const target = path.join(home, now);
        await fse.ensureDir(path.join(project, `.${tool}`));
        execFileSync('git', ['init', '-q', project]);
        const local: LocalConfig = { ...userConfig(tool), scope: 'project', projectRoot: project, dataHome };
        await reconcileMcpForConfig(team({ gitExclude: { enabled: true } }), local);
        const written = await fse.readJson(before);
        expect(written.projects[project].mcpServers).toEqual({ api });
        written.projects[project].mcpServers.mine = MINE;
        await fse.outputJson(before, written);
        const contents = await fse.readFile(before, 'utf8');
        const teamConfig = team();
        if (tool === 'claude') teamConfig.toolPaths = { ...teamConfig.toolPaths, claude: { ...teamConfig.toolPaths.claude, mcp: now } };
        else vi.stubEnv('CODEBUDDY_CONFIG_DIR', path.dirname(target));
        await fse.ensureDir(path.dirname(target));
        if (current !== 'missing') {
          await fse.outputFile(target, JSON.stringify({ projects: { [project]: { mcpServers: { mine: MINE } } } }) + (current === 'unparsable' ? '\n}' : ''));
          if (current === 'unreadable') await fs.promises.chmod(target, 0o000);
        }
        const recordsOf = async (): Promise<unknown[]> => Object.entries(await fse.readJson(path.join(dataHome, 'managed-local-mcp.json')).catch(() => ({})))
          .filter(([key]) => key.startsWith(`${tool}:local:`)).flatMap(([, records]) => records as unknown[]);
        const recorded = await recordsOf();
        expect(recorded).toHaveLength(1);

        await reconcileMcpForConfig(teamConfig, local, { removeAll: mode === 'uninstall' });

        if (current === 'unreadable') await fs.promises.chmod(target, 0o600);
        if (mode === 'uninstall') expect((await fse.readJson(before)).projects[project].mcpServers).toEqual({ mine: MINE });
        else expect(await fse.readFile(before, 'utf8')).toBe(contents);
        // A pull that cannot read the scope's current file keeps its records; otherwise the old file's record goes.
        const currentRead = current === 'missing' || current === 'parses';
        expect(await recordsOf()).toEqual(mode === 'pull' && !currentRead ? recorded : []);
      });
  });

  it('writes Muse\'s user servers to $XDG_CONFIG_HOME/muse/settings.json', async () => {
    const xdg = path.join(root, 'xdg');
    await fse.ensureDir(path.join(xdg, 'muse'));
    vi.stubEnv('XDG_CONFIG_HOME', xdg);

    await reconcileMcpForConfig(team(), userConfig('muse'));

    expect(await fse.readJson(path.join(xdg, 'muse', 'settings.json'))).toEqual({ schema_version: 1, mcpServers: { api: renderJsonEntry('muse', API) } });
    expect(await fse.pathExists(path.join(home, '.config', 'muse', 'settings.json'))).toBe(false);
  });
});
