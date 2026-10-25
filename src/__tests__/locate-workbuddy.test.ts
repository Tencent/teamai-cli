/**
 * The WorkBuddy generation swap inside `locate` (#1273): WorkBuddy 5.7+ moved
 * its runtime to `.workbuddy-ai/` and stops reading `.workbuddy/`, so when the
 * new root is the live generation, skills must land where the app scans and
 * the new root must count as install proof. These run against the in-memory
 * `Host` (no filesystem), mirroring locate-matrix's style.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installOf, locate, ownOf, writable } from '../locate.js';
import type { Host } from '../tool-home.js';

const HOME = '/home/member';
const ROOT = '/repo/project';

function hostWith(existing: readonly string[]): Host {
  const set = new Set(existing);
  return {
    platform: 'linux', path: path.posix, home: HOME,
    env: {}, toolHomes: { kind: 'missing' },
    cwd: () => ROOT,
    exists: async (dir: string) => set.has(dir),
    realpath: async (file: string) => file,
    readText: async () => null,
    readJson: async () => ({ kind: 'missing' }),
    userToolRoots: async () => undefined,
  };
}

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
