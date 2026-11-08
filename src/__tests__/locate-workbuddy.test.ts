/**
 * The WorkBuddy root swap inside `locate` (#1273): `.workbuddy/` belongs to
 * WorkBuddy and `.workbuddy-ai/` to WorkBuddy AI (its international edition),
 * a second product rather than a newer generation, and either can outlive the
 * other. Whichever records the newer launch is the live one, and the surfaces
 * teamai writes must land where that app looks and count as install proof.
 * These run against the in-memory `Host` (no filesystem), mirroring
 * locate-matrix's style.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installOf, locate, ownOf, writable } from '../locate.js';
import { DEFAULT_TOOL_PATHS, scopedToolPaths } from '../types.js';
import type { Host } from '../tool-home.js';

const HOME = '/home/member';
const ROOT = '/repo/project';

function hostWith(existing: readonly string[], launches: Readonly<Record<string, string>> = {}): Host {
  const set = new Set(existing);
  return {
    platform: 'linux', path: path.posix, home: HOME, profileHome: HOME,
    env: {}, toolHomes: { kind: 'missing' },
    cwd: () => ROOT,
    exists: async (dir: string) => set.has(dir),
    realpath: async (file: string) => file,
    readText: async () => null, existsNow: (dir: string) => set.has(dir),
    readTextNow: (file: string) => launches[file] ?? null,
    readOpenclawConfig: async () => ({ kind: 'missing' }),
    userToolRoots: async () => undefined,
  };
}

/** What WorkBuddy writes in the root it starts from, as `last-launch.json` holds it. */
const launch = (timestamp: string): string => JSON.stringify({ version: '5.9.3', build: 'd4692421', timestamp });

const DEFAULT_PATHS = { workbuddy: { skills: '.workbuddy/skills' } };

describe('locate carries the WorkBuddy 5.7+ generation (#1273)', () => {
  it('project scope, only .workbuddy-ai: writes and probes the new root', async () => {
    const host = hostWith([`${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${ROOT}/.workbuddy-ai/skills`);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy-ai`, met: true });
  });

  it('project scope, both roots: the new generation wins (#1290)', async () => {
    const host = hostWith([`${ROOT}/.workbuddy`, `${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${ROOT}/.workbuddy-ai/skills`);
  });

  it('project scope, only the old root: keeps the old default and probes it', async () => {
    const host = hostWith([`${ROOT}/.workbuddy`]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${ROOT}/.workbuddy/skills`);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: true });
  });

  it('project scope, neither root: the install gate stays closed', async () => {
    const host = hostWith([]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: false });
    expect(writable(where)).toBeNull();
  });

  it('a team that redirected skills keeps its own path beside the new root', async () => {
    const host = hostWith([`${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: { workbuddy: { skills: 'custom/skills' } } }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${ROOT}/custom/skills`);
  });

  it('user scope, only .workbuddy-ai under $HOME: writes and probes the new root', async () => {
    const host = hostWith([`${HOME}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy-ai`, met: true });
  });

  it('user scope, only the old root under $HOME: keeps the old default', async () => {
    const host = hostWith([`${HOME}/.workbuddy`]);
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy/skills`);
  });
});

describe('the live root is the one the app launched from, not the one that exists (#1273)', () => {
  // Uninstalling one app leaves its root behind, so both can exist while only
  // one has a running app behind it. Presence cannot tell which, so
  // `last-launch.json` does: the app rewrites it in the root it starts from and
  // the leftover keeps a stale one.

  it('both roots, .workbuddy launched last, so skills go back to it', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: launch('2026-11-06T00:24:14.713Z'),
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch('2026-11-02T12:25:00.628Z'),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy/skills`);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy`, met: true });
  });

  it('both roots, .workbuddy-ai launched last, so skills stay on it (#1290)', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: launch('2026-10-27T09:29:19.843Z'),
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch('2026-11-02T12:25:00.628Z'),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy-ai`, met: true });
  });

  it('only the old root records a launch, though the new root exists: the old root is live', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: launch('2026-11-06T00:24:14.713Z'),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy/skills`);
  });

  it('only the new root records a launch: the new root is live', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch('2026-11-02T12:25:00.628Z'),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
  });

  it('both records unreadable: presence decides, as before (#1290)', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: '{ not json',
      [`${HOME}/.workbuddy-ai/last-launch.json`]: JSON.stringify({ version: '5.9.4' }),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
  });

  it('equal timestamps keep the new root, the direction the swap already had', async () => {
    const at = '2026-11-02T12:25:00.628Z';
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: launch(at),
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch(at),
    });
    const install = installOf({ toolPaths: DEFAULT_PATHS }, { scope: 'user', repo: {} });
    const where = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(where)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
  });

  it('a member running .workbuddy keeps every surface on the old root too', async () => {
    const host = hostWith([`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`], {
      [`${HOME}/.workbuddy/last-launch.json`]: launch('2026-11-06T00:24:14.713Z'),
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch('2026-11-02T12:25:00.628Z'),
    });
    const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user', repo: {} });
    const rules = await locate('workbuddy', 'rules', install, host);
    expect(rules.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy`, met: true });
    expect(writable(rules)).not.toBeNull();
  });
});

describe('the live root is install proof for every surface teamai writes (#1273)', () => {
  // A project's rules and agents live under its own `.codebuddy/`, which no
  // root change touches, so project scope keeps probing `.workbuddy/` there.
  // User scope is the opposite: every leaf teamai writes hangs off the app's
  // data root, so it follows the live one. Hooks stay on `.workbuddy/` until
  // their half of #1273 lands — that is why they are not in this table.
  const PATHS = {
    workbuddy: {
      skills: '.workbuddy/skills',
      rules: '.codebuddy/rules',
      mcp: '.workbuddy/mcp.json',
      mcpProject: '.mcp.json',
    },
  };

  it('project rules stay fail-closed when only .workbuddy-ai exists', async () => {
    const host = hostWith([`${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'rules', install, host);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: false });
    expect(writable(where)).toBeNull();
  });

  it('project mcp stays fail-closed when only .workbuddy-ai exists', async () => {
    const host = hostWith([`${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'mcp', install, host);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: false });
    expect(writable(where)).toBeNull();
  });

  it('rules keep working from the old root alone (no regression)', async () => {
    const host = hostWith([`${ROOT}/.workbuddy`]);
    const install = installOf({ toolPaths: PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'rules', install, host);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: true });
    expect(writable(where)).not.toBeNull();
  });

  it('user scope, .workbuddy-ai-only home: rules, agents and MCP follow it, so no .workbuddy/ is created', async () => {
    // The reviewer's exact scenario, with the answer #1273 settled: every
    // surface configured and the home holding only the second app's root. All
    // of them land in that root — the engine reads `<root>/rules`,
    // `<root>/agents` and `<root>/mcp.json` — so pull never creates a
    // `.workbuddy/` on a WorkBuddy AI-only machine.
    const host = hostWith([`${HOME}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user', repo: {} });
    // Separate calls, not a loop: `writable()` narrows by resource, so a
    // union-typed `Location<'mcp' | 'rules'>` does not type-check.
    const rules = await locate('workbuddy', 'rules', install, host);
    expect(rules.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy-ai`, met: true });
    expect(writable(rules)?.path).toBe(`${HOME}/.workbuddy-ai/rules`);
    const mcp = await locate('workbuddy', 'mcp', install, host);
    expect(writable(mcp)?.path).toBe(`${HOME}/.workbuddy-ai/.mcp.json`);
    const agents = await locate('workbuddy', 'agents', install, host);
    expect(writable(agents)?.path).toBe(`${HOME}/.workbuddy-ai/agents`);
    const skills = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(skills)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
    expect(writable(skills)).not.toBeNull();
  });

  it('user scope, .workbuddy live: the same surfaces stay on it', async () => {
    const host = hostWith([`${HOME}/.workbuddy`]);
    const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user', repo: {} });
    const rules = await locate('workbuddy', 'rules', install, host);
    expect(writable(rules)?.path).toBe(`${HOME}/.workbuddy/rules`);
    const mcp = await locate('workbuddy', 'mcp', install, host);
    expect(writable(mcp)?.path).toBe(`${HOME}/.workbuddy/.mcp.json`);
    const agents = await locate('workbuddy', 'agents', install, host);
    expect(writable(agents)?.path).toBe(`${HOME}/.workbuddy/agents`);
  });
});

describe('the live-root swap takes only the leaves it delivers (#1273)', () => {
  // WorkBuddy AI launched after WorkBuddy, so its root is the live one.
  const aiLive = (): Host => hostWith(
    [`${HOME}/.workbuddy`, `${HOME}/.workbuddy-ai`],
    {
      [`${HOME}/.workbuddy/last-launch.json`]: launch('2026-11-02T12:25:00.628Z'),
      [`${HOME}/.workbuddy-ai/last-launch.json`]: launch('2026-11-06T00:24:14.713Z'),
    },
  );

  it('leaves settings.json where hooks are resolved from it', async () => {
    const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user', repo: {} });
    const hooks = await locate('workbuddy', 'hooks', install, aiLive());
    // Hooks still land in `.workbuddy/`, so the file that holds them must not
    // follow the live root: reporting the AI settings file would name a
    // delivery pull never makes.
    expect(ownOf(hooks)?.path).toBe(`${HOME}/.workbuddy/settings.json`);

    const skills = await locate('workbuddy', 'skills', install, aiLive());
    expect(ownOf(skills)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
  });

  it('keeps the destination a team userScope override names', async () => {
    const teamPaths = {
      workbuddy: { ...DEFAULT_TOOL_PATHS.workbuddy, userScope: { rules: '.workbuddy/shared-rules', agents: '.workbuddy/agents' } },
    };
    const install = installOf({ toolPaths: teamPaths }, { scope: 'user', repo: {} });

    const rules = await locate('workbuddy', 'rules', install, aiLive());
    expect(writable(rules)?.path).toBe(`${HOME}/.workbuddy/shared-rules`);

    const agents = await locate('workbuddy', 'agents', install, aiLive());
    expect(writable(agents)?.path).toBe(`${HOME}/.workbuddy-ai/agents`);
  });
});

describe('the swap reads the home it was handed (#1273)', () => {
  // The inspected machine runs WorkBuddy AI; this one runs WorkBuddy. A swap
  // that reads the process home answers for the wrong machine.
  const at = (launches: Readonly<Record<string, string>>, aiPresent: boolean) => ({
    home: '/home/other',
    path: path.posix,
    readTextNow: (file: string) => launches[file] ?? null,
    existsNow: (file: string) => aiPresent && file === '/home/other/.workbuddy-ai',
  });

  it('moves the user paths when the inspected home launched the other app', () => {
    const out = scopedToolPaths({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user' }, at({
      '/home/other/.workbuddy/last-launch.json': launch('2026-11-02T12:25:00.628Z'),
      '/home/other/.workbuddy-ai/last-launch.json': launch('2026-11-06T00:24:14.713Z'),
    }, true));
    expect(out.workbuddy.userScope?.rules).toBe('.workbuddy-ai/rules');
    expect(out.workbuddy.mcp).toBe('.workbuddy-ai/mcp.json');
  });

  it('keeps them when the inspected home launched the default app', () => {
    const out = scopedToolPaths({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user' }, at({
      '/home/other/.workbuddy/last-launch.json': launch('2026-11-06T00:24:14.713Z'),
      '/home/other/.workbuddy-ai/last-launch.json': launch('2026-11-02T12:25:00.628Z'),
    }, true));
    expect(out.workbuddy.userScope?.rules).toBe('.workbuddy/rules');
    expect(out.workbuddy.skills).toBe('.workbuddy/skills');
  });
});
