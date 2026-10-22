import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nextToolHomes } from '../tool-home-record.js';
import { envToolHome, type Host } from '../tool-home.js';
import { isToolId, TOOLS } from '../tools.js';
import { sameSkillDirs } from '../resources/skill-dirs.js';

function linuxHost(env: Record<string, string>, existing: readonly string[] = ['/new/hermes', '/x/opencode', '/home/m/.openclaw']): Host {
  return {
    platform: 'linux', path: path.posix, home: '/home/m', env, toolHomes: { kind: 'missing' }, cwd: () => '/home/m',
    exists: async (file) => existing.includes(file), readJson: async () => ({ kind: 'missing' }),
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

describe('nextToolHomes on Windows', () => {
  const windowsHost = (env: Record<string, string>, existing: readonly string[]): Host => ({
    platform: 'win32', path: path.win32, home: 'C:\\Users\\m', env, toolHomes: { kind: 'missing' },
    cwd: () => 'C:\\repo', exists: async (file) => existing.includes(file), readJson: async () => ({ kind: 'missing' }),
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
        case 'win32-appdata':
        case 'profile-suffix':
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
      platform: 'win32', path: path.win32, home: 'C:\\Users\\m', env: { LOCALAPPDATA: 'relative-appdata' }, toolHomes: { kind: 'missing' },
      cwd: () => 'C:\\repo', exists: async () => true, readJson: async () => ({ kind: 'missing' }),
    };

    expect(envToolHome('hermes', host)).toEqual({ dir: 'C:\\Users\\m\\AppData\\Local\\hermes', variable: 'LOCALAPPDATA', kind: 'win32-appdata' });
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

describe('skills directories compared on a host', () => {
  it('compare in the path\'s own flavor, wherever the check runs', async () => {
    const recorded = { hermes: ['C:\\Users\\M\\AppData\\Local\\hermes\\skills'] };
    const current = { hermes: ['c:\\users\\m\\appdata\\local\\hermes\\skills\\'] };

    expect(await sameSkillDirs(recorded, current)).toBe(true);
    expect(await sameSkillDirs({ hermes: ['/Users/M/hermes/skills'] }, { hermes: ['/users/m/hermes/skills'] })).toBe(false);
  });
});
