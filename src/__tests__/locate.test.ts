import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { nextToolHomes } from '../tool-home-record.js';
import { cleanupOf, installOf, locate, locatingOnce, ownOf, unreadWrites, writable, writesOf, type EntryPlace, type FilePlace, type FilesChannel, type Install, type Read } from '../locate.js';
import { envToolHome, movedToolHome, toolHome, toolHomeOf, type Host } from '../tool-home.js';
import { TOOLS } from '../tools.js';
import { isToolId, useToolInstances } from '../tool-registry.js';
import { samePlaces } from '../resources/places.js';
import type { ToolId } from '../tools.js';
import { DEFAULT_TOOL_PATHS } from '../types.js';

function linuxHost(env: Record<string, string>, existing: readonly string[] = ['/new/hermes', '/x/opencode', '/home/m/.openclaw']): Host {
  return {
    platform: 'linux', path: path.posix, home: '/home/m', profileHome: '/home/m', env, toolHomes: { kind: 'missing' }, cwd: () => '/home/m',
    exists: async (file) => existing.includes(file), readOpenclawConfig: async () => ({ kind: 'missing' }),
    realpath: async (file) => file, readText: async () => null, existsNow: () => false, readTextNow: () => null, userToolRoots: async () => undefined,
  };
}

describe('nextToolHomes', () => {
  it('lets init overwrite a record with what the env says now', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/new/hermes' }), 'init');

    expect(homes).toEqual({ hermes: '/new/hermes' });
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: '/new/hermes', previous: '/old/hermes' }]);
  });

  it('keeps a record from a shell without the variable, and clears it when the variable is set but blank', async () => {
    expect((await nextToolHomes({ opencode: '/x/opencode' }, linuxHost({}), 'init')).homes).toEqual({ opencode: '/x/opencode' });

    const cleared = await nextToolHomes({ opencode: '/x/opencode' }, linuxHost({ XDG_CONFIG_HOME: '' }), 'init');

    expect(cleared.homes).toEqual({});
    expect(cleared.changes).toEqual([{ tool: 'opencode', variable: 'XDG_CONFIG_HOME', dir: null, previous: '/x/opencode' }]);
  });

  it('never changes an existing record on a pull', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/new/hermes', XDG_CONFIG_HOME: '' }), 'pull');

    expect(homes).toEqual({ hermes: '/old/hermes' });
    expect(changes).toEqual([]);
  });

  it('lets init replace a record with a home that does not exist yet', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/later/hermes' }), 'init');

    expect(homes).toEqual({ hermes: '/later/hermes' });
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: '/later/hermes', previous: '/old/hermes' }]);
  });

  it('lets init record a home a tool\'s own variable names before it exists', async () => {
    const { homes } = await nextToolHomes({}, linuxHost({ HERMES_HOME: '/later/hermes', OPENCLAW_PROFILE: 'work' }), 'init');

    expect(homes).toEqual({ hermes: '/later/hermes', openclaw: '/home/m/.openclaw-work' });
  });

  it('lets init record or replace a home XDG_CONFIG_HOME names only once it exists', async () => {
    expect((await nextToolHomes({ opencode: '/y/opencode' }, linuxHost({ XDG_CONFIG_HOME: '/missing' }), 'init')).homes).toEqual({ opencode: '/y/opencode' });
    expect((await nextToolHomes({}, linuxHost({ XDG_CONFIG_HOME: '/missing' }), 'init')).homes).toEqual({});
    expect((await nextToolHomes({ opencode: '/y/opencode' }, linuxHost({ XDG_CONFIG_HOME: '/x' }), 'init')).homes).toEqual({ opencode: '/x/opencode' });
  });

  it('records only a moved home that exists', async () => {
    const { homes, changes } = await nextToolHomes({}, linuxHost({ XDG_CONFIG_HOME: '/flatpak/config', HERMES_HOME: '/new/hermes' }), 'pull');

    expect(homes).toEqual({ hermes: '/new/hermes' });
    expect(changes.map((change) => change.tool)).toEqual(['hermes']);
  });

  it('moves OpenClaw back to its default home when init sees OPENCLAW_PROFILE=default', async () => {
    const { homes } = await nextToolHomes({ openclaw: '/home/m/.openclaw-work' }, linuxHost({ OPENCLAW_PROFILE: 'default' }), 'init');

    expect(homes).toEqual({ openclaw: '/home/m/.openclaw' });
  });
});

describe('nextToolHomes and Hermes\'s active_profile', () => {
  const sticky: Host = {
    ...linuxHost({}, ['/home/m/.hermes/profiles/work']),
    existsNow: (file) => file === '/home/m/.hermes/profiles/work',
    readTextNow: (file) => (file === '/home/m/.hermes/active_profile' ? 'work\n' : null),
  };

  it('records nothing for a profile Hermes itself made active, on init or pull', async () => {
    for (const by of ['init', 'pull'] as const) {
      expect(await nextToolHomes({}, sticky, by)).toEqual({ homes: {}, changes: [] });
      expect(await nextToolHomes({ hermes: '/srv/hermes' }, sticky, by)).toEqual({ homes: { hermes: '/srv/hermes' }, changes: [] });
    }
  });

  it('records HERMES_HOME on init while active_profile names a profile in it', async () => {
    const host: Host = { ...sticky, env: { HERMES_HOME: '/srv/hermes' }, existsNow: (file) => file === '/srv/hermes/profiles/work', readTextNow: (file) => (file === '/srv/hermes/active_profile' ? 'work\n' : null) };

    expect((await nextToolHomes({}, host, 'init')).homes).toEqual({ hermes: '/srv/hermes' });
  });

  it('takes the profile active_profile names inside a recorded home, from a shell without HERMES_HOME', () => {
    const host: Host = { ...sticky, toolHomes: { kind: 'ok', homes: { hermes: '/srv/hermes' } }, existsNow: (file) => file === '/srv/hermes/profiles/work', readTextNow: (file) => (file === '/srv/hermes/active_profile' ? 'work\n' : null) };

    expect(toolHome('hermes', host)).toBe('/srv/hermes/profiles/work');
  });

  it('clears a recorded home when init sees HERMES_HOME blank, whatever active_profile says', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/srv/hermes' }, { ...sticky, env: { HERMES_HOME: '' } }, 'init');

    expect(homes).toEqual({});
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: null, previous: '/srv/hermes' }]);
  });
});

describe('nextToolHomes on Windows', () => {
  const windowsHost = (env: Record<string, string>, existing: readonly string[]): Host => ({
    platform: 'win32', path: path.win32, home: 'C:\\Users\\m', profileHome: 'C:\\Users\\m', env, toolHomes: { kind: 'missing' },
    cwd: () => 'C:\\repo', exists: async (file) => existing.includes(file), readOpenclawConfig: async () => ({ kind: 'missing' }),
    realpath: async (file) => file, readText: async () => null, existsNow: () => false, readTextNow: () => null, userToolRoots: async () => undefined,
  });
  const appData = 'C:\\Users\\m\\AppData\\Local';

  it('keeps a recorded Hermes home when init runs in a shell without HERMES_HOME', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: 'D:\\hermes-moved' }, windowsHost({ LOCALAPPDATA: appData }, ['D:\\hermes-moved', `${appData}\\hermes`]), 'init');

    expect(homes).toEqual({ hermes: 'D:\\hermes-moved' });
    expect(changes).toEqual([]);
  });

  it('clears a recorded Hermes home when init sees HERMES_HOME set but blank', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: 'D:\\hermes-moved' }, windowsHost({ HERMES_HOME: '', LOCALAPPDATA: appData }, ['D:\\hermes-moved', `${appData}\\hermes`]), 'init');

    expect(homes).toEqual({});
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: null, previous: 'D:\\hermes-moved' }]);
  });

  it('follows active_profile inside the Windows default a pull recorded', async () => {
    const native = `${appData}\\hermes`;
    const host: Host = {
      ...windowsHost({ LOCALAPPDATA: appData }, [native]), toolHomes: { kind: 'ok', homes: { hermes: native } },
      existsNow: (file) => file === `${native}\\profiles\\work`, readTextNow: (file) => (file === `${native}\\active_profile` ? 'work' : null),
    };

    expect(toolHome('hermes', host)).toBe(`${native}\\profiles\\work`);
  });

  it('fills a missing Hermes record with the Windows default only when it exists', async () => {
    expect((await nextToolHomes({}, windowsHost({ LOCALAPPDATA: appData }, [`${appData}\\hermes`]), 'init')).homes).toEqual({ hermes: `${appData}\\hermes` });
    expect((await nextToolHomes({}, windowsHost({ LOCALAPPDATA: appData }, []), 'init')).homes).toEqual({});
  });
});

describe('envToolHome', () => {
  const atWork = (env: Record<string, string>): Host => ({ ...linuxHost(env), cwd: () => '/home/m/work' });
  type MoveCase = { tool: ToolId; env: Record<string, string>; dir: string | null };
  const cases: MoveCase[] = Object.keys(TOOLS).filter(isToolId).flatMap<MoveCase>((tool) => {
    const { home } = TOOLS[tool];
    return 'moves' in home ? home.moves.by.flatMap<MoveCase>((move) => {
      switch (move.kind) {
        case 'env':
          return [
            { tool, env: { [move.name]: 'rel/home' }, dir: '/home/m/work/rel/home' },
            { tool, env: { [move.name]: '~/home' }, dir: '/home/m/home' },
            { tool, env: { [move.name]: '/abs/home' }, dir: '/abs/home' },
            { tool, env: { [move.name]: ' ' }, dir: null },
          ];
        case 'qoder-home':
          return [
            { tool, env: { QODER_CONFIG_DIR: 'rel/home', QODER_CLI_HOME: 'rel/cli' }, dir: '/home/m/work/rel/home' },
            { tool, env: { QODER_CONFIG_DIR: '/abs/home', QODER_CLI_HOME: '/abs/cli' }, dir: '/abs/home' },
            { tool, env: { QODER_CONFIG_DIR: ' ', QODER_CLI_HOME: '/abs/cli' }, dir: '/abs/cli/.qoder' },
            { tool, env: { QODER_CONFIG_DIR: ' ', QODER_CLI_HOME: ' ' }, dir: null },
          ];
        case 'qoder-cn-home':
          return [
            { tool, env: { QODERCN_CONFIG_DIR: 'rel/home', QODERCN_CLI_HOME: 'rel/cli' }, dir: '/home/m/work/rel/home' },
            { tool, env: { QODERCN_CONFIG_DIR: '/abs/home', QODERCN_CLI_HOME: '/abs/cli' }, dir: '/abs/home' },
            { tool, env: { QODERCN_CONFIG_DIR: ' ', QODERCN_CLI_HOME: '/abs/cli' }, dir: '/abs/cli/.qoder-cn' },
            { tool, env: { QODERCN_CONFIG_DIR: ' ', QODERCN_CLI_HOME: ' ' }, dir: null },
          ];
        case 'xdg':
          return [
            { tool, env: { XDG_CONFIG_HOME: 'rel/config' }, dir: null },
            { tool, env: { XDG_CONFIG_HOME: '/abs/config' }, dir: `/abs/config/${move.child}` },
          ];
        case 'openclaw-state':
        case 'omp-agent':
        case 'hermes-home':
          return [];
        default: {
          const unhandled: never = move;
          return unhandled;
        }
      }
    }) : [];
  });

  it.each(cases)('moves $tool with $env to $dir: a tool\'s own variable as the tool resolves it, XDG_CONFIG_HOME only when absolute', ({ tool, env, dir }) => {
    expect(envToolHome(tool, atWork(env))?.dir ?? null).toBe(dir);
  });

  it('puts Hermes in the Windows default when LOCALAPPDATA is relative', () => {
    const host: Host = {
      platform: 'win32', path: path.win32, home: 'C:\\Users\\m', profileHome: 'C:\\Users\\m', env: { LOCALAPPDATA: 'relative-appdata' }, toolHomes: { kind: 'missing' },
      cwd: () => 'C:\\repo', exists: async () => true, readOpenclawConfig: async () => ({ kind: 'missing' }),
      realpath: async (file) => file, readText: async () => null, existsNow: () => false, readTextNow: () => null, userToolRoots: async () => undefined,
    };

    expect(envToolHome('hermes', host)).toEqual({ dir: 'C:\\Users\\m\\AppData\\Local\\hermes', variable: 'LOCALAPPDATA', kind: 'platform-default' });
  });
});

describe('homes that follow the tool\'s own rules', () => {
  const at = (env: Record<string, string>, files: Readonly<Record<string, string>> = {}, homes: Readonly<Record<string, string>> = {}): Host => ({
    ...linuxHost(env), cwd: () => '/home/m/work', toolHomes: { kind: 'ok', homes },
    existsNow: (file) => Object.keys(files).some((known) => known === file || known.startsWith(`${file}/`)),
    readTextNow: (file) => files[file] ?? null,
  });
  const dirOf = (tool: 'openclaw' | 'omp' | 'hermes', host: Host): string | null => movedToolHome(tool, host);

  it('puts OpenClaw\'s state dir in OPENCLAW_HOME, its profile included, and expands ~ in OPENCLAW_HOME against the OS home', () => {
    expect(dirOf('openclaw', at({ OPENCLAW_HOME: '/oc' }))).toBe('/oc/.openclaw');
    expect(dirOf('openclaw', at({ OPENCLAW_HOME: '/oc', OPENCLAW_PROFILE: 'work' }))).toBe('/oc/.openclaw-work');
    expect(dirOf('openclaw', at({ OPENCLAW_HOME: '~/oc' }))).toBe('/home/m/oc/.openclaw');
  });

  it('lets OPENCLAW_STATE_DIR win, with ~ in it expanded against OPENCLAW_HOME', () => {
    expect(dirOf('openclaw', at({ OPENCLAW_HOME: '/oc', OPENCLAW_PROFILE: 'work', OPENCLAW_STATE_DIR: '/state' }))).toBe('/state');
    expect(dirOf('openclaw', at({ OPENCLAW_HOME: '/oc', OPENCLAW_STATE_DIR: '~/state' }))).toBe('/oc/state');
  });

  it('counts a blank, undefined or null OPENCLAW_HOME as unset', () => {
    for (const value of [' ', 'undefined', 'null']) {
      expect(dirOf('openclaw', at({ OPENCLAW_HOME: value }))).toBeNull();
      expect(dirOf('openclaw', at({ OPENCLAW_HOME: value, OPENCLAW_PROFILE: 'work' }))).toBe('/home/m/.openclaw-work');
    }
  });

  it('takes OMP_PROFILE over PI_PROFILE even when empty, and an empty or default profile is the default one', () => {
    expect(dirOf('omp', at({ OMP_PROFILE: 'work', PI_PROFILE: 'other' }))).toBe('/home/m/.omp/profiles/work/agent');
    expect(dirOf('omp', at({ OMP_PROFILE: '', PI_PROFILE: 'other' }))).toBeNull();
    expect(envToolHome('omp', at({ PI_PROFILE: 'default' }))).toEqual({ dir: '/home/m/.omp/agent', variable: 'PI_PROFILE', kind: 'own' });
  });

  it('roots every OMP profile in PI_CONFIG_DIR, and leaves PI_CODING_AGENT_DIR to Pi', () => {
    expect(dirOf('omp', at({ PI_CODING_AGENT_DIR: '/agent' }))).toBeNull();
    expect(dirOf('omp', at({ OMP_PROFILE: 'work', PI_CODING_AGENT_DIR: '/agent' }))).toBe('/home/m/.omp/profiles/work/agent');
    expect(dirOf('omp', at({ PI_CONFIG_DIR: '.alt', OMP_PROFILE: 'work' }))).toBe('/home/m/.alt/profiles/work/agent');
    expect(dirOf('omp', at({ PI_CONFIG_DIR: '.alt' }))).toBe('/home/m/.alt/agent');
  });

  it('appends HERMES_DATA_DIR_SUFFIX as written, and lets HERMES_HOME win over it', () => {
    expect(envToolHome('hermes', at({ HERMES_DATA_DIR_SUFFIX: '-canary' }))).toEqual({ dir: '/home/m/.hermes-canary', variable: 'HERMES_DATA_DIR_SUFFIX', kind: 'own' });
    expect(dirOf('hermes', at({ HERMES_DATA_DIR_SUFFIX: '-canary', HERMES_HOME: '/h' }))).toBe('/h');
  });

  it('takes the profile active_profile names while its directory exists, but not default', () => {
    const profile = { '/home/m/.hermes/active_profile': 'work\n', '/home/m/.hermes/profiles/work/SOUL.md': '' };
    expect(dirOf('hermes', at({}, profile))).toBe('/home/m/.hermes/profiles/work');
    expect(envToolHome('hermes', at({}, profile))).toBeNull();
    expect(dirOf('hermes', at({}, { '/home/m/.hermes/active_profile': 'work' }))).toBeNull();
    expect(dirOf('hermes', at({}, { '/home/m/.hermes/active_profile': 'default', '/home/m/.hermes/profiles/default/x': '' }))).toBeNull();
  });

  it('keeps a HERMES_HOME that is a profiles/<name> dir whatever active_profile says', () => {
    const files = { '/home/m/.hermes/active_profile': 'work', '/home/m/.hermes/profiles/work/x': '' };
    expect(dirOf('hermes', at({ HERMES_HOME: '/home/m/.hermes/profiles/other' }, files))).toBe('/home/m/.hermes/profiles/other');
  });

  it('reads active_profile from the platform home when HERMES_HOME is inside it, and takes the profile under HERMES_HOME', () => {
    const files = { '/home/m/.hermes/active_profile': 'work', '/home/m/.hermes/custom/profiles/work/x': '' };
    expect(dirOf('hermes', at({ HERMES_HOME: '/home/m/.hermes/custom' }, files))).toBe('/home/m/.hermes/custom/profiles/work');
  });

  it('reads active_profile from a HERMES_HOME outside the platform home', () => {
    const files = { '/srv/hermes/active_profile': 'work', '/srv/hermes/profiles/work/x': '', '/home/m/.hermes/active_profile': 'other' };
    expect(dirOf('hermes', at({ HERMES_HOME: '/srv/hermes' }, files))).toBe('/srv/hermes/profiles/work');
  });
});

describe('skills directories compared on a host', () => {
  it('compare in the path\'s own flavor, wherever the check runs', async () => {
    const recorded = { hermes: ['C:\\Users\\M\\AppData\\Local\\hermes\\skills'] };
    const current = { hermes: ['c:\\users\\m\\appdata\\local\\hermes\\skills\\'] };

    expect(await samePlaces(recorded, current)).toBe(true);
    expect(await samePlaces({ hermes: ['/Users/M/hermes/skills'] }, { hermes: ['/users/m/hermes/skills'] })).toBe(false);
  });
});

describe('the helpers every caller of locate uses', () => {
  const host = linuxHost({});
  const met = [{ kind: 'selected', met: true }] as const;
  const blocks = (reads: readonly Read[]): FilesChannel<FilePlace> => ({
    channel: 'files', own: { kind: 'file', path: '/home/m/.cursor/rules/teamai-context.mdc', owned: true, header: 'always-apply' },
    reads, readGates: [], retired: [], gates: met,
  });
  const servers = (reads: readonly Read[]): FilesChannel<EntryPlace> => ({
    channel: 'files', own: { kind: 'entry', path: '/home/m/.claude.json', key: ['mcpServers'], projectKey: '/home/m/work' },
    reads, readGates: [], gates: met,
    retired: [{ place: { kind: 'entry', path: '/home/m/work/.mcp.json', key: ['mcpServers'] }, was: 'other-scope' }],
  });

  it('counts a file as read by the directory that holds it', () => {
    expect(unreadWrites(blocks([{ path: '/home/m/.cursor/rules', when: 'always' }]), host)).toEqual([]);
    expect(unreadWrites(blocks([{ path: '/home/m/.cursor', key: ['rules'], when: 'always' }]), host)).toEqual([{ write: '/home/m/.cursor/rules/teamai-context.mdc', reason: 'not-read' }]);
  });

  it('counts a map as read only from the same file, key and project key', () => {
    const read = { path: '/home/m/.claude.json', key: ['mcpServers'], projectKey: '/home/m/work', when: 'always' } as const;
    expect(unreadWrites(servers([read]), host)).toEqual([]);
    expect(unreadWrites(servers([{ ...read, key: ['mcp'] }]), host).map((unread) => unread.reason)).toEqual(['not-read']);
    expect(unreadWrites(servers([{ ...read, projectKey: '/home/m/other' }]), host).map((unread) => unread.reason)).toEqual(['not-read']);
    expect(unreadWrites(servers([{ path: '/home/m/.claude.json', when: 'always' }]), host).map((unread) => unread.reason)).toEqual(['not-read']);
    const nested = { ...servers([{ ...read, key: ['mcp'] }]), own: { kind: 'entry', path: '/home/m/.claude.json', key: ['mcp', 'servers'], projectKey: '/home/m/work' } } as const;
    expect(unreadWrites(nested, host).map((unread) => unread.reason)).toEqual(['not-read']);
  });

  it('names the file that hides a write the tool would read if it were first', () => {
    const shadowed = { path: '/home/m/.claude.json', key: ['mcpServers'], projectKey: '/home/m/work', when: 'always', shadowedBy: '/home/m/.mcp.json' } as const;
    expect(unreadWrites(servers([shadowed]), host)).toEqual([{ write: '/home/m/.claude.json', reason: 'shadowed', by: '/home/m/.mcp.json' }]);
  });

  it('writes only through a files channel whose gates are all met, and cleans its retired places too', () => {
    const where = servers([]);
    expect(writable(where)).toEqual(where.own);
    expect(writable({ ...where, gates: [...met, { kind: 'installed', probe: '/home/m/.claude', met: false }] })).toBeNull();
    expect(ownOf({ ...where, gates: [{ kind: 'selected', met: false }] })).toEqual(where.own);
    expect(writable({ channel: 'run-time', via: 'session-hook', probe: 'codex-hooks', limit: null, retired: [], gates: met })).toBeNull();
    expect(cleanupOf(where)).toEqual([where.own, { kind: 'entry', path: '/home/m/work/.mcp.json', key: ['mcpServers'] }]);
    expect(writesOf({ channel: 'none', retired: [], gates: met })).toEqual([]);
  });
});

describe('installOf', () => {
  const team = { toolPaths: {}, sharing: { gitExclude: { enabled: true } } };
  const child = { path: 'app', root: '/repo/app', anchor: '/repo/app/.teamai', selection: { additionalRoles: [] } };

  it('parses sharing.gitExclude, self mode and workspace children once, the member\'s setting first', () => {
    expect(installOf(team, { scope: 'user', repo: {} }).gitExclude).toBe(true);
    expect(installOf(team, { scope: 'user', repo: {}, gitExcludeEnabled: false }).gitExclude).toBe(false);
    expect(installOf({ toolPaths: {} }, { scope: 'project', projectRoot: '/repo', repo: { kind: 'self' } })).toMatchObject({ gitExclude: false, repo: 'self', workspaceChildren: false });
    expect(installOf(team, { scope: 'project', projectRoot: '/repo', repo: { kind: 'git' }, children: { children: [child], leftOut: [], roots: [], fingerprint: 'f' } }))
      .toMatchObject({ gitExclude: true, repo: 'team', workspaceChildren: true });
  });
});

describe('locatingOnce', () => {
  const root = '/home/m/work/proj';
  const install: Install = { toolPaths: DEFAULT_TOOL_PATHS, agents: {}, toolRoots: {}, gitExclude: false, scope: 'project', projectRoot: root, repo: 'team', workspaceChildren: false, keepsKnowledgeInside: false };
  const claudeSkills = async () => writable(await locate('claude', 'skills', { ...install }));

  it('answers a tool and resource from the disk as the walk first saw it, and the next walk sees what changed', async () => {
    const existing = new Set<string>();
    const host: Host = { ...linuxHost({}), exists: async (file) => existing.has(file), existsNow: (file) => existing.has(file) };

    const inWalk = await locatingOnce(async () => {
      const before = await claudeSkills();
      existing.add(`${root}/.claude`);

      return [before, await claudeSkills()];
    }, host);

    expect(inWalk).toEqual([null, null]);
    expect(await locatingOnce(claudeSkills, host)).toEqual({ kind: 'dir', path: `${root}/.claude/skills` });
  });

  it('answers an install whose tool paths differ apart from the first, in the same walk', async () => {
    const host: Host = { ...linuxHost({}), exists: async () => true, existsNow: () => true };
    const moved: Install = { ...install, toolPaths: { ...DEFAULT_TOOL_PATHS, claude: { ...DEFAULT_TOOL_PATHS.claude, skills: '.claude/team-skills' } } };

    const places = await locatingOnce(async () => [ownOf(await locate('claude', 'skills', install)), ownOf(await locate('claude', 'skills', moved))], host);

    expect(places).toEqual([{ kind: 'dir', path: `${root}/.claude/skills` }, { kind: 'dir', path: `${root}/.claude/team-skills` }]);
  });

  // A pull's item walk keeps its first answers, so a copy one tool writes must not change what another tool would get.
  it.each(['project', 'user'] as const)('lets a %s pull\'s copies change no answer the rest of its walk reads, but a tool\'s that writes the same copies', async (scope) => {
    const tools = Object.keys(DEFAULT_TOOL_PATHS);
    const walks = [{ walked: 'skills', reads: ['skills'] }, { walked: 'rules', reads: ['rules', 'blocks'] }, { walked: 'agents', reads: ['agents'] }] as const;
    const each: Install = { ...install, agents: { enabledAgents: tools } };
    const scoped: Install = scope === 'project' ? each : { toolPaths: each.toolPaths, agents: each.agents, toolRoots: {}, gitExclude: false, scope };
    const changed: string[] = [];

    for (const everyInstalled of [false, true]) {
      for (const writer of tools) {
        for (const { walked, reads } of walks) {
          const existing = new Set<string>();
          const host: Host = { ...linuxHost({}), exists: async (file) => existing.has(file), existsNow: (file) => existing.has(file) };
          const create = (file: string) => { for (let dir = file; dir !== '/'; dir = path.posix.dirname(dir)) existing.add(dir); };
          const writes = async (tool: string, resource: (typeof reads)[number]) => writesOf(await locate(tool, resource, scoped, host)).map((place) => place.path);
          const answers = async () => Promise.all(tools.flatMap((tool) => reads.map(async (resource) => ({ tool, resource, answer: await locate(tool, resource, scoped, host) }))));

          for (const tool of everyInstalled ? tools : [writer]) {
            for (const resource of ['skills', 'rules', 'blocks', 'agents'] as const) {
              for (const gate of (await locate(tool, resource, scoped, host)).gates) if (gate.kind === 'installed') create(gate.probe);
            }
          }

          if (writable(await locate(writer, walked, scoped, host)) === null) continue;
          const before = await answers();
          for (const file of await writes(writer, walked)) create(file);
          const after = await answers();

          for (const [index, { tool, resource, answer }] of after.entries()) {
            const theirs = await writes(tool, resource);
            const ours = new Set(await writes(writer, resource));

            if (!isDeepStrictEqual(answer, before[index].answer) && !(theirs.length > 0 && theirs.every((file) => ours.has(file)))) {
              changed.push(`${writer} ${walked} changes ${tool} ${resource}${everyInstalled ? ' with every tool installed' : ''}`);
            }
          }
        }
      }
    }

    expect(changed).toEqual([]);
  });
});

describe('an instance of Codex under the Codex root the member recorded (toolRoots.codex)', () => {
  const host = linuxHost({}, ['/home/m/.codex-work']);
  const install: Install = { toolPaths: { ...DEFAULT_TOOL_PATHS, 'acme-codex': DEFAULT_TOOL_PATHS.codex }, agents: {}, toolRoots: { codex: '/home/m/.codex-work' }, gitExclude: false, scope: 'user' };
  const instance = { kind: 'instance', name: 'acme-codex', extends: 'codex', command: 'acme-codex', source: 'team', file: '/repo/tools/acme-codex.yaml', location: 'tools/acme-codex.yaml', revision: 'r1' } as const;
  const placeOf = async (tool: string, resource: 'skills' | 'hooks') => ownOf(await locate(tool, resource, install, host))?.path;

  afterEach(() => {
    useToolInstances(new Map());
  });

  it('puts an instance that keeps the home of Codex where Codex is', async () => {
    useToolInstances(new Map([['acme-codex', instance]]));

    expect(await placeOf('acme-codex', 'skills')).toBe('/home/m/.codex-work/skills');
    expect(await placeOf('acme-codex', 'hooks')).toBe(await placeOf('codex', 'hooks'));
  });

  it.each([
    { set: 'moved from Codex\'s', paths: undefined },
    { set: 'of its own', paths: { skills: '.acme-codex/skills' } },
  ])('keeps an instance with a home of its own and paths $set in that home, reads it there, and gives it the shared skills directory a Codex build reads', async ({ paths }) => {
    useToolInstances(new Map([['acme-codex', { ...instance, home: { dir: '.acme-codex' }, ...(paths === undefined ? {} : { paths }) }]]));
    const own: Install = { ...install, toolPaths: { ...install.toolPaths, 'acme-codex': { ...DEFAULT_TOOL_PATHS.codex, skills: '.acme-codex/skills' } } };
    const skills = await locate('acme-codex', 'skills', own, host);

    expect([ownOf(skills)?.path, skills.shared?.path, unreadWrites(skills, host)]).toEqual(['/home/m/.acme-codex/skills', '/home/m/.agents/skills', []]);
  });

  it.each(['user', 'project'] as const)('takes an instance as installed in %s scope by its nested home, not by the directory that holds it', async (scope) => {
    useToolInstances(new Map([['acme-codex', { ...instance, home: { dir: 'work/.acme-codex' } }]]));
    const paths = { ...DEFAULT_TOOL_PATHS.codex, skills: 'work/.acme-codex/skills', settings: 'work/.acme-codex/hooks.json' };
    const own: Install = scope === 'user'
      ? { ...install, toolPaths: { ...install.toolPaths, 'acme-codex': paths } }
      : { ...install, toolPaths: { ...install.toolPaths, 'acme-codex': paths }, scope, projectRoot: '/p', repo: 'team', workspaceChildren: false, keepsKnowledgeInside: false };
    const base = scope === 'user' ? '/home/m' : '/p';
    const skills = await locate('acme-codex', 'skills', own, linuxHost({}, [`${base}/work`]));

    expect(skills.gates).toContainEqual({ kind: 'installed', probe: `${base}/work/.acme-codex`, met: false });
  });
});

describe('the home an instance\'s own variable moves', () => {
  const instance = { kind: 'instance', name: 'acme-codex', extends: 'codex', home: { dir: '.acme-codex', env: 'ACME_CODEX_HOME' }, source: 'team', file: '/repo/tools/acme-codex.yaml', location: 'tools/acme-codex.yaml', revision: 'r1' } as const;
  const recorded = (homes: Record<string, string>, env: Record<string, string> = {}): Host => ({ ...linuxHost(env, ['/x/acme']), toolHomes: { kind: 'ok', homes } });

  afterEach(() => {
    useToolInstances(new Map());
  });

  it('is recorded as a shipped tool\'s own variable is: init records and replaces it, a pull only fills a missing record, a blank one clears it', async () => {
    useToolInstances(new Map([['acme-codex', instance]]));

    expect(await nextToolHomes({}, linuxHost({ ACME_CODEX_HOME: '/x/acme' }, ['/x/acme']), 'pull')).toEqual({ homes: { 'acme-codex': '/x/acme' }, changes: [{ tool: 'acme-codex', variable: 'ACME_CODEX_HOME', dir: '/x/acme' }] });
    expect((await nextToolHomes({ 'acme-codex': '/x/acme' }, linuxHost({ ACME_CODEX_HOME: '/y/acme' }, ['/y/acme']), 'pull')).homes).toEqual({ 'acme-codex': '/x/acme' });
    expect((await nextToolHomes({ 'acme-codex': '/x/acme' }, linuxHost({ ACME_CODEX_HOME: '/y/acme' }), 'init')).homes).toEqual({ 'acme-codex': '/y/acme' });
    expect(await nextToolHomes({ 'acme-codex': '/x/acme' }, linuxHost({ ACME_CODEX_HOME: '' }), 'init')).toEqual({ homes: {}, changes: [{ tool: 'acme-codex', variable: 'ACME_CODEX_HOME', dir: null, previous: '/x/acme' }] });
  });

  it('names the default home an instance leaves on its first move, so init can release it', async () => {
    useToolInstances(new Map([['acme-codex', instance]]));

    expect((await nextToolHomes({}, linuxHost({ ACME_CODEX_HOME: '/x/acme' }), 'init')).changes).toEqual([{ tool: 'acme-codex', variable: 'ACME_CODEX_HOME', dir: '/x/acme', previous: '/home/m/.acme-codex' }]);
    expect((await nextToolHomes({}, linuxHost({ ACME_CODEX_HOME: '/home/m/.acme-codex' }), 'init')).changes).toEqual([{ tool: 'acme-codex', variable: 'ACME_CODEX_HOME', dir: '/home/m/.acme-codex' }]);
  });

  it('is read from the record in a shell without the variable, and the record wins over another value, as for a shipped tool', () => {
    useToolInstances(new Map([['acme-codex', instance]]));

    expect(toolHomeOf('acme-codex', recorded({ 'acme-codex': '/x/acme' }))?.dir).toBe('/x/acme');
    expect(toolHomeOf('acme-codex', recorded({ 'acme-codex': '/x/acme' }, { ACME_CODEX_HOME: '/y/acme' }))?.dir).toBe('/x/acme');
    expect(toolHomeOf('acme-codex', recorded({}))?.dir).toBe('/home/m/.acme-codex');
  });
});
