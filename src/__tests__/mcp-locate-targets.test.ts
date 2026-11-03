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
import { judgeTeamaiOnlyMcpConfigs, reconcileMcpForConfig, resolveMcpTargets, shadowedMcpRecords } from '../mcp-reconcile.js';
import { entryHash, renderCodexBlock, renderJsonEntry } from '../resources/mcp-format.js';
import { managedMcpManifestKey, TeamaiConfigSchema, type LocalConfig, type McpServerDef, type TeamaiConfig } from '../types.js';
import { commitTeamRepo } from './helpers/team-repo-history.js';

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

  // #993 bug 10: CodeBuddy reads only the first of these that exists, and does not merge them.
  describe('CodeBuddy, which reads only the first of ~/.codebuddy/.mcp.json, ~/.codebuddy/mcp.json, ~/.codebuddy.json that exists', () => {
    const TEAM = renderJsonEntry('buddy', API);
    const LEGACY = { projects: { '/work/app': { mcpServers: { local: MINE } } }, mcpServers: { 'usr-srv': MINE } };
    let file: { dotMcp: string; mcp: string; legacy: string };
    const servers = async (at: string): Promise<unknown> => (await fse.pathExists(at) ? (await fse.readJson(at)).mcpServers : undefined);
    const pull = (config = userConfig('codebuddy')) => reconcileMcpForConfig(team(), config);
    const uninstall = () => reconcileMcpForConfig(team(), userConfig('codebuddy'), { removeAll: true });
    const infoLines = (): string[] => vi.mocked(log.info).mock.calls.map(([line]) => String(line));
    const doctorFixes = async (): Promise<string[]> =>
      (await buildMcpReadFileChecks(context(team(), userConfig('codebuddy')))).map((check) => check.fix ?? '');
    const codebuddyTarget = async () => {
      const target = (await resolveMcpTargets(team(), userConfig('codebuddy'))).find((candidate) => candidate.tool === 'codebuddy');
      if (target === undefined) throw new Error('CodeBuddy is not a target');
      return target;
    };
    /** What an earlier teamai recorded: no file in its CodeBuddy records. */
    const forgetRecordedFile = async (): Promise<void> => {
      const manifest = path.join(home, '.teamai', 'managed-mcp.json');
      const records: Array<Record<string, unknown>> = (await fse.readJson(manifest)).codebuddy;
      await fse.outputJson(manifest, { codebuddy: records.map(({ file: _file, ...rest }) => rest) });
    };
    /** The team commits a new set of MCP servers: its history is how teamai knows a server it no longer has a record of. */
    const publishTeamMcp = async (defs: ReadonlyArray<{ name: string; url: string }>): Promise<void> => {
      await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'),
        defs.length === 0 ? 'servers: []\n' : `servers:\n${defs.map((d) => `  - name: ${d.name}\n    transport: http\n    url: ${d.url}\n`).join('')}`);
      commitTeamRepo(repo, 'mcp');
    };

    beforeEach(async () => {
      file = { dotMcp: path.join(home, '.codebuddy', '.mcp.json'), mcp: path.join(home, '.codebuddy', 'mcp.json'), legacy: path.join(home, '.codebuddy.json') };
      await fse.ensureDir(path.join(home, '.codebuddy'));
      vi.mocked(log.info).mockClear();
    });

    it.each(['still detected', 'no longer detected'] as const)('leaves another tool\'s server in a CodeBuddy lookup file that links to that tool\'s file (Claude %s)', async (claude) => {
      const both: LocalConfig = { ...userConfig('codebuddy'), enabledAgents: ['claude', 'codebuddy'] };
      const claudeFile = path.join(home, '.claude.json');
      await fse.outputJson(claudeFile, { mcpServers: {} });
      await fs.promises.symlink(claudeFile, file.mcp);
      await fse.outputJson(file.dotMcp, { mcpServers: { mine: MINE } });
      await fse.ensureDir(path.join(home, '.claude'));
      await pull(both);
      const claudeServer = (await fse.readJson(claudeFile)).mcpServers;
      expect(await servers(file.dotMcp)).toEqual({ mine: MINE, api: TEAM });
      expect(Object.keys(claudeServer)).toEqual(['api']);

      if (claude === 'no longer detected') await fse.remove(path.join(home, '.claude'));
      await pull(both);

      expect(await servers(claudeFile)).toEqual(claudeServer);
      expect((await fs.promises.lstat(file.mcp)).isSymbolicLink()).toBe(true);
    });

    it('creates ~/.codebuddy/.mcp.json when no CodeBuddy user MCP file exists, and keeps a server the member adds there', async () => {
      await pull();
      expect(await servers(file.dotMcp)).toEqual({ api: TEAM });
      expect(await fse.pathExists(file.mcp)).toBe(false);
      expect(await fse.pathExists(file.legacy)).toBe(false);

      // What `codebuddy mcp add -s user mine ...` does: it writes the file CodeBuddy reads.
      await fse.outputJson(file.dotMcp, { mcpServers: { api: TEAM, mine: MINE } });
      await pull();

      expect(await servers(file.dotMcp)).toEqual({ api: TEAM, mine: MINE });
      expect(await fse.pathExists(file.mcp)).toBe(false);
    });

    it('writes to an existing ~/.codebuddy/mcp.json without creating ~/.codebuddy/.mcp.json', async () => {
      await fse.outputJson(file.mcp, { mcpServers: { mine: MINE } });

      await pull();

      expect(await servers(file.mcp)).toEqual({ mine: MINE, api: TEAM });
      expect(await fse.pathExists(file.dotMcp)).toBe(false);
    });

    it('writes to the legacy ~/.codebuddy.json rather than hide its servers behind a new file, and mcp remove takes teamai\'s back out', async () => {
      await fse.outputJson(file.legacy, LEGACY);

      await pull();

      expect(await fse.pathExists(file.dotMcp)).toBe(false);
      expect(await fse.pathExists(file.mcp)).toBe(false);
      expect(await fse.readJson(file.legacy)).toEqual({ ...LEGACY, mcpServers: { 'usr-srv': MINE, api: TEAM } });
      // What `teamai mcp list` names: the file CodeBuddy reads, and the server recorded as installed there.
      expect((await codebuddyTarget()).file).toBe(file.legacy);
      expect((await fse.readJson(path.join(home, '.teamai', 'managed-mcp.json'))).codebuddy).toEqual([{ name: 'api', hash: entryHash(TEAM), file: file.legacy }]);

      await uninstall();

      expect(await fse.readJson(file.legacy)).toEqual(LEGACY);
    });

    // The CLI case for a record that names the file is in e2e/codebuddy-user-mcp-993.test.ts.
    it('moves only teamai\'s entries out of a file CodeBuddy no longer reads, and doctor warns until then, when an earlier teamai recorded no file', async () => {
      await fse.outputJson(file.mcp, { mcpServers: { 'mine-old': MINE } });
      await pull();
      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE, api: TEAM });
      await forgetRecordedFile();
      // The member then runs `codebuddy mcp add -s user`, which creates the file CodeBuddy reads first.
      await fse.outputJson(file.dotMcp, { mcpServers: { mine: MINE } });

      const warned = (await doctorFixes()).find((fix) => fix.includes(`teamai's MCP servers for codebuddy (api) are in ${file.mcp}, which codebuddy does not read`));
      expect(warned).toContain(file.dotMcp);
      expect(await shadowedMcpRecords(userConfig('codebuddy'), await codebuddyTarget())).toEqual(new Map([[file.mcp, ['api']]]));

      await pull();
      expect(await servers(file.dotMcp)).toEqual({ mine: MINE, api: TEAM });
      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE });
      expect((await doctorFixes()).filter((fix) => fix.includes('which codebuddy does not read'))).toEqual([]);

      await uninstall();
      expect(await servers(file.dotMcp)).toEqual({ mine: MINE });
      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE });
    });

    it('uninstall removes teamai\'s servers from the file it recorded, before a pull moved them', async () => {
      await fse.outputJson(file.mcp, { mcpServers: { 'mine-old': MINE } });
      await pull();
      await forgetRecordedFile();
      await fse.outputJson(file.dotMcp, { mcpServers: { mine: MINE } });

      await uninstall();

      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE });
      expect(await servers(file.dotMcp)).toEqual({ mine: MINE });
    });

    // An earlier teamai always created ~/.codebuddy/mcp.json, which hides the member's ~/.codebuddy.json.
    it.each(['recorded by an earlier teamai', 'unrecorded, equal to the team\'s render'] as const)('moves teamai\'s servers out of a ~/.codebuddy/mcp.json holding nothing else into ~/.codebuddy.json, and deletes it (%s)', async (owned) => {
      if (owned === 'recorded by an earlier teamai') {
        await fse.outputFile(file.mcp, '{}');
        await pull();
        expect(await servers(file.mcp)).toEqual({ api: TEAM });
        await forgetRecordedFile();
        vi.mocked(log.info).mockClear();
      } else {
        await fse.outputJson(file.mcp, { mcpServers: { api: TEAM } });
      }
      await fse.outputJson(file.legacy, LEGACY);

      await pull();

      expect(await fse.pathExists(file.mcp)).toBe(false);
      expect(await fse.pathExists(file.dotMcp)).toBe(false);
      expect(await fse.readJson(file.legacy)).toEqual({ ...LEGACY, mcpServers: { 'usr-srv': MINE, api: TEAM } });
      expect(infoLines().filter((line) => line.startsWith(`Moved teamai's MCP servers for codebuddy (api) from ${file.mcp}`))).toHaveLength(1);

      vi.mocked(log.info).mockClear();
      await pull();
      expect(infoLines().filter((line) => line.includes('Moved teamai\'s MCP servers'))).toEqual([]);
      expect(await fse.readJson(file.legacy)).toEqual({ ...LEGACY, mcpServers: { 'usr-srv': MINE, api: TEAM } });
    });

    it.each([
      { what: 'a member\'s server', content: { mcpServers: { 'mine-old': MINE } } },
      { what: 'another key', content: { mcpServers: {}, theme: 'dark' } },
    ])('leaves a ~/.codebuddy/mcp.json that also holds $what where it is', async ({ content }) => {
      await fse.outputJson(file.mcp, content);
      await pull();
      await fse.outputJson(file.legacy, LEGACY);
      vi.mocked(log.info).mockClear();

      await pull();

      expect(infoLines().filter((line) => line.includes('Moved teamai\'s MCP servers'))).toEqual([]);
      expect(await fse.readJson(file.mcp)).toEqual({ ...content, mcpServers: { ...content.mcpServers, api: TEAM } });
      expect(await fse.readJson(file.legacy)).toEqual(LEGACY);
    });

    it('keeps a ~/.codebuddy/mcp.json that is a symlink holding only teamai\'s servers, and writes through it', async () => {
      const target = path.join(root, 'dotfiles', 'codebuddy-mcp.json');
      await fse.outputJson(target, { mcpServers: { api: TEAM } });
      await fs.promises.symlink(target, file.mcp);
      await fse.outputJson(file.legacy, LEGACY);

      await pull();

      expect(infoLines().filter((line) => line.includes('Moved teamai\'s MCP servers'))).toEqual([]);
      expect((await fs.promises.lstat(file.mcp)).isSymbolicLink()).toBe(true);
      expect(await fs.promises.readlink(file.mcp)).toBe(target);
      expect(await servers(target)).toEqual({ api: TEAM });
      expect(await fse.readJson(file.legacy)).toEqual(LEGACY);
    });

    // With its record lost, a server an earlier teamai left in a file CodeBuddy no longer reads would come back
    // once the member deletes the file CodeBuddy reads now.
    const KEEP = { name: 'keep', url: 'https://keep.example.com/mcp' };
    it.each([
      { how: 'pull', change: 'deleted its only server', after: [] },
      { how: 'pull', change: 'kept another server', after: [KEEP] },
      { how: 'uninstall', change: 'deleted its only server', after: [] },
    ] as const)('$how takes teamai\'s servers out of a file CodeBuddy no longer reads after the record is lost and the team $change', async ({ how, after }) => {
      await publishTeamMcp([{ name: 'api', url: API.url ?? '' }, ...after]);
      await fse.outputJson(file.mcp, { mcpServers: { 'mine-old': MINE } });
      await pull();
      expect(Object.keys(await servers(file.mcp) ?? {}).sort()).toEqual(['api', 'mine-old', ...after.map((s) => s.name)].sort());
      await fse.remove(path.join(home, '.teamai', 'managed-mcp.json'));
      await fse.outputJson(file.dotMcp, { mcpServers: {} });
      await publishTeamMcp(after);

      if (how === 'pull') await pull();
      else await uninstall();

      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE });
      const kept = how === 'pull' ? Object.fromEntries(after.map((s) => [s.name, renderJsonEntry('buddy', { name: s.name, transport: 'http', url: s.url })])) : {};
      expect(await servers(file.dotMcp)).toEqual(kept);
    });

    it.each(['records the file', 'an earlier teamai recorded no file'] as const)('keeps teamai\'s server when ~/.codebuddy/.mcp.json is a symlink to ~/.codebuddy/mcp.json (%s)', async (recorded) => {
      await fse.outputJson(file.mcp, { mcpServers: { 'mine-old': MINE } });
      await pull();
      if (recorded === 'an earlier teamai recorded no file') await forgetRecordedFile();
      await fs.promises.symlink('mcp.json', file.dotMcp);
      vi.mocked(log.info).mockClear();

      await pull();

      expect((await fs.promises.lstat(file.dotMcp)).isSymbolicLink()).toBe(true);
      expect(await fs.promises.readlink(file.dotMcp)).toBe('mcp.json');
      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE, api: TEAM });
      expect(infoLines().filter((line) => line.includes('Took teamai\'s MCP servers'))).toEqual([]);
      expect((await doctorFixes()).filter((fix) => fix.includes('which codebuddy does not read'))).toEqual([]);

      await pull();
      expect(await servers(file.mcp)).toEqual({ 'mine-old': MINE, api: TEAM });
    });

    it('neither moves nor deletes a ~/.codebuddy/mcp.json holding only teamai\'s servers when ~/.codebuddy.json is a symlink to it', async () => {
      await fse.outputFile(file.mcp, '{}');
      await pull();
      await fs.promises.symlink(path.join('.codebuddy', 'mcp.json'), file.legacy);
      vi.mocked(log.info).mockClear();

      await pull();

      expect(infoLines().filter((line) => line.includes('Moved teamai\'s MCP servers'))).toEqual([]);
      expect((await fs.promises.lstat(file.mcp)).isFile()).toBe(true);
      expect((await fs.promises.lstat(file.legacy)).isSymbolicLink()).toBe(true);
      expect(await servers(file.mcp)).toEqual({ api: TEAM });
    });
  });

  // #915: with sharing.gitExclude on, CodeBuddy takes a project's servers from its local scope, projects[<root>] of .codebuddy.json.
  describe('CodeBuddy\'s local scope while sharing.gitExclude is on', () => {
    const TOKEN = 'lab-token-value-7c3a';
    const MEMBERS = { mcpServers: { 'my-user-server': { type: 'stdio', command: 'my-user-tool', args: [] } }, projects: { '/elsewhere/project': { mcpServers: { 'my-other': MINE } } } };
    const TEAM_SERVERS = ['plain-api', 'secret-api'];
    let project: string;
    let local: LocalConfig;
    const git = (...args: string[]): string => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
    const codebuddyJson = (): string => path.join(home, '.codebuddy.json');
    const localScope = async (): Promise<Record<string, unknown> | undefined> => (await fse.readJson(codebuddyJson())).projects?.[project]?.mcpServers;
    const projectServers = async (): Promise<Record<string, unknown> | null> =>
      (await fse.pathExists(path.join(project, '.mcp.json')) ? (await fse.readJson(path.join(project, '.mcp.json'))).mcpServers ?? {} : null);
    const names = (servers: Record<string, unknown> | null | undefined): string[] => Object.keys(servers ?? {}).sort();
    /** The lines of teamai's MCP block in the project's .git/info/exclude. */
    const mcpLines = async (): Promise<string[]> => {
      const lines = (await fse.readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8').catch(() => '')).split('\n');
      const start = lines.findIndex((line) => line.startsWith('# [teamai:mcp-exclude:start]'));
      const end = lines.indexOf('# [teamai:mcp-exclude:end]');
      return start < 0 || end < start ? [] : lines.slice(start + 1, end);
    };
    const status = (): string[] => git('status', '--porcelain', '-uall').split('\n').filter(Boolean);
    const pull = (gitExclude: boolean) => reconcileMcpForConfig(team({ gitExclude: { enabled: gitExclude } }), local);
    const commitTeam = async (servers: string): Promise<void> => {
      await fse.outputFile(path.join(repo, 'mcp', 'mcp.yaml'), servers);
      commitTeamRepo(repo);
    };
    const PLAIN = '  - name: plain-api\n    transport: http\n    url: https://plain.example.com/mcp\n';
    const SECRET = '  - name: secret-api\n    transport: http\n    url: https://api.example.com/mcp\n    headers:\n      Authorization: "Bearer ${LAB_TOKEN}"\n';
    const OLD = '  - name: old-api\n    transport: http\n    url: https://old.example.com/mcp\n';

    /** A committed business repo set up for CodeBuddy, holding `committed`. */
    const setUp = async (committed: Record<string, string> = {}): Promise<void> => {
      await fse.outputFile(path.join(project, 'README.md'), '# app\n');
      for (const [rel, content] of Object.entries(committed)) await fse.outputFile(path.join(project, rel), content);
      execFileSync('git', ['init', '-q', project]);
      git('add', '-A');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'app');
      await fse.ensureDir(path.join(project, '.codebuddy'));
    };

    beforeEach(async () => {
      project = path.join(root, 'project');
      local = { ...userConfig('codebuddy'), scope: 'project', projectRoot: project, dataHome: path.join(root, 'data') };
      await fse.outputJson(codebuddyJson(), MEMBERS);
      await fse.outputFile(path.join(repo, 'env', 'env.yaml'), `variables:\n  - key: LAB_TOKEN\n    value: "${TOKEN}"\n`);
      await commitTeam(`servers:\n${SECRET}${PLAIN}`);
    });

    it('leaves the team\'s tracked .mcp.json as it is', async () => {
      const teamFile = `${JSON.stringify({ mcpServers: { 'repo-server': { type: 'stdio', command: 'repo-tool', args: [] } } }, null, 2)}\n`;
      await setUp({ '.mcp.json': teamFile });

      await pull(true);

      expect(await fse.readFile(path.join(project, '.mcp.json'), 'utf8')).toBe(teamFile);
      expect(status()).toEqual([]);
      expect(names(await localScope())).toEqual(TEAM_SERVERS);
    });

    it('turning the option on moves teamai\'s servers out of .mcp.json and releases its MCP line; turning it off moves them back', async () => {
      await setUp();
      await pull(false);
      expect(names(await projectServers())).toEqual(TEAM_SERVERS);
      expect(await mcpLines()).toEqual(['/.mcp.json']);
      expect(await localScope()).toBeUndefined();

      await pull(true);

      expect(await projectServers()).toBeNull();
      expect(names(await localScope())).toEqual(TEAM_SERVERS);
      expect(await mcpLines()).toEqual([]);
      expect(status()).toEqual([]);

      await pull(false);

      expect(names(await projectServers())).toEqual(TEAM_SERVERS);
      expect(await localScope()).toBeUndefined();
      expect(await fse.readJson(codebuddyJson())).toEqual(MEMBERS);
      expect(await mcpLines()).toEqual(['/.mcp.json']);
    });

    it('turning the option on also moves the servers teamai has no record of, removes a removed server\'s copy, and keeps the member\'s', async () => {
      await commitTeam(`servers:\n${SECRET}${PLAIN}${OLD}`);
      await setUp();
      await pull(false);
      const file = path.join(project, '.mcp.json');
      const written: Record<string, unknown> = (await fse.readJson(file)).mcpServers;
      expect(names(written)).toEqual(['old-api', ...TEAM_SERVERS]);
      // teamai's record of what it wrote is lost; the member adds a server of their own.
      await fse.remove(path.join(root, 'data', 'workspaces'));
      await fse.outputJson(file, { mcpServers: { ...written, mine: MINE } });
      await commitTeam(`servers:\n${SECRET}${PLAIN}`);

      await pull(true);

      expect(await projectServers()).toEqual({ mine: MINE });
      expect(names(await localScope())).toEqual(TEAM_SERVERS);
      expect(await fse.readFile(file, 'utf8')).not.toContain(TOKEN);
    });

    it('turning the option on keeps in .mcp.json, and names, a teamai server the member changed', async () => {
      await setUp();
      await pull(false);
      const file = path.join(project, '.mcp.json');
      const written: Record<string, object> = (await fse.readJson(file)).mcpServers;
      const edited = { ...written['plain-api'], headers: { 'X-Mine': 'yes' } };
      await fse.outputJson(file, { mcpServers: { ...written, 'plain-api': edited } });

      await pull(true);

      expect(await projectServers()).toEqual({ 'plain-api': edited });
      expect(vi.mocked(log.warn).mock.calls.flat().join('\n')).toContain(`Kept MCP server plain-api in ${file}: you changed it since teamai wrote it.`);
      expect(names(await localScope())).toEqual(TEAM_SERVERS);
      expect(await fse.readFile(file, 'utf8')).not.toContain(TOKEN);
    });

    it('writes to the .codebuddy.json in CODEBUDDY_CONFIG_DIR when it is set', async () => {
      const configDir = path.join(root, 'codebuddy-config');
      await fse.outputJson(path.join(configDir, '.codebuddy.json'), MEMBERS);
      await fse.remove(codebuddyJson());
      vi.stubEnv('CODEBUDDY_CONFIG_DIR', configDir);
      await setUp();

      await pull(true);

      expect(names((await fse.readJson(path.join(configDir, '.codebuddy.json'))).projects?.[project]?.mcpServers)).toEqual(TEAM_SERVERS);
      expect(await fse.pathExists(codebuddyJson())).toBe(false);
      expect(await projectServers()).toBeNull();
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
      .find((candidate) => candidate.name === 'cursor reads the MCP servers teamai writes');

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
      .find((candidate) => candidate.name === 'opencode MCP servers are where the last write put them');

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
