import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nextToolHomes } from '../tool-home-record.js';
import { cleanupOf, installOf, ownOf, unreadWrites, writable, writesOf, type EntryPlace, type FilePlace, type FilesChannel, type Read } from '../locate.js';
import { envToolHome, movedToolHome, toolHome, type Host } from '../tool-home.js';
import { isToolId, TOOLS } from '../tools.js';
import { samePlaces } from '../resources/places.js';

function linuxHost(env: Record<string, string>, existing: readonly string[] = ['/new/hermes', '/x/opencode', '/home/m/.openclaw']): Host {
  return {
    platform: 'linux', path: path.posix, home: '/home/m', profileHome: '/home/m', env, toolHomes: { kind: 'missing' }, cwd: () => '/home/m',
    exists: async (file) => existing.includes(file), readJson: async () => ({ kind: 'missing' }),
    realpath: async (file) => file, readText: async () => null, existsNow: () => false, readTextNow: () => null, userToolRoots: async () => undefined,
  };
}

describe('nextToolHomes', () => {
  it('lets init overwrite a record with what the env says now', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/new/hermes' }), 'init');

    expect(homes).toEqual({ hermes: '/new/hermes' });
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: '/new/hermes' }]);
  });

  it('keeps a record from a shell without the variable, and clears it when the variable is set but blank', async () => {
    expect((await nextToolHomes({ opencode: '/x/opencode' }, linuxHost({}), 'init')).homes).toEqual({ opencode: '/x/opencode' });

    const cleared = await nextToolHomes({ opencode: '/x/opencode' }, linuxHost({ XDG_CONFIG_HOME: '' }), 'init');

    expect(cleared.homes).toEqual({});
    expect(cleared.changes).toEqual([{ tool: 'opencode', variable: 'XDG_CONFIG_HOME', dir: null }]);
  });

  it('never changes an existing record on a pull', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/new/hermes', XDG_CONFIG_HOME: '' }), 'pull');

    expect(homes).toEqual({ hermes: '/old/hermes' });
    expect(changes).toEqual([]);
  });

  it('lets init replace a record with a home that does not exist yet', async () => {
    const { homes, changes } = await nextToolHomes({ hermes: '/old/hermes' }, linuxHost({ HERMES_HOME: '/later/hermes' }), 'init');

    expect(homes).toEqual({ hermes: '/later/hermes' });
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: '/later/hermes' }]);
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
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: null }]);
  });
});

describe('nextToolHomes on Windows', () => {
  const windowsHost = (env: Record<string, string>, existing: readonly string[]): Host => ({
    platform: 'win32', path: path.win32, home: 'C:\\Users\\m', profileHome: 'C:\\Users\\m', env, toolHomes: { kind: 'missing' },
    cwd: () => 'C:\\repo', exists: async (file) => existing.includes(file), readJson: async () => ({ kind: 'missing' }),
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
    expect(changes).toEqual([{ tool: 'hermes', variable: 'HERMES_HOME', dir: null }]);
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
  const cases = Object.keys(TOOLS).filter(isToolId).flatMap((tool) => {
    const { home } = TOOLS[tool];
    return 'moves' in home ? home.moves.by.flatMap((move) => {
      switch (move.kind) {
        case 'env':
          return [
            { tool, env: { [move.name]: 'rel/home' }, dir: '/home/m/work/rel/home' },
            { tool, env: { [move.name]: '~/home' }, dir: '/home/m/home' },
            { tool, env: { [move.name]: '/abs/home' }, dir: '/abs/home' },
            { tool, env: { [move.name]: ' ' }, dir: null },
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
      cwd: () => 'C:\\repo', exists: async () => true, readJson: async () => ({ kind: 'missing' }),
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

describe('a skills directory outside locate', () => {
  const SKILLS_JOINS_OUTSIDE_LOCATE: Readonly<Record<string, string>> = {
    'source.ts: path.join(baseDir, toolPath.skills, skill.name)': 'tells Codex\'s own directory from the shared .agents/skills a copy went to',
    'uninstall.ts: path.join(baseDir, toolPath.skills)': 'uninstall clears the configured directory too, where releases before #1221 wrote',
  };

  it('is joined from a configured path only where the allow-list says why', async () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const found = new Set<string>();
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') await walk(full);
          continue;
        }
        const rel = path.relative(srcDir, full).split(path.sep).join('/');
        if (!entry.name.endsWith('.ts') || rel === 'locate.ts') continue;
        for (const call of (await fs.readFile(full, 'utf8')).matchAll(/\b(?:path\.)?(?:join|resolve)\([^;()]*\.skills\b[^;()]*\)/g)) found.add(`${rel}: ${call[0]}`);
      }
    }
    await walk(srcDir);

    expect([...found].filter((call) => !Object.hasOwn(SKILLS_JOINS_OUTSIDE_LOCATE, call))).toEqual([]);
    expect(Object.keys(SKILLS_JOINS_OUTSIDE_LOCATE).filter((call) => !found.has(call))).toEqual([]);
  });
});

describe('a rules directory or claudemd path outside locate', () => {
  const RULES_JOINS_OUTSIDE_LOCATE: Readonly<Record<string, string>> = {};

  it('is joined from a configured path only where the allow-list says why', async () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const found = new Set<string>();
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') await walk(full);
          continue;
        }
        const rel = path.relative(srcDir, full).split(path.sep).join('/');
        if (!entry.name.endsWith('.ts') || rel === 'locate.ts') continue;
        const source = await fs.readFile(full, 'utf8');
        for (const call of joinedRulesOrClaudemd(source)) found.add(`${rel}: ${call}`);
      }
    }
    await walk(srcDir);

    expect([...found].filter((call) => !Object.hasOwn(RULES_JOINS_OUTSIDE_LOCATE, call))).toEqual([]);
    expect(Object.keys(RULES_JOINS_OUTSIDE_LOCATE).filter((call) => !found.has(call))).toEqual([]);
  });
});

/** Balanced parentheses, so `?.rules` inside `join(resolve(...), ...)` still counts. */
function joinedRulesOrClaudemd(source: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(/\b(?:path\.)?(?:join|resolve)\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(source, open);
    if (close === undefined) continue;
    const call = source.slice(match.index, close + 1);
    if (/\??\.(?:rules|claudemd)\b/.test(call)) calls.push(call);
  }
  return calls;
}

function matchingParen(source: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

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
