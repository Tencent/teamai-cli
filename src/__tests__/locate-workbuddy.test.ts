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
import { DEFAULT_TOOL_PATHS } from '../types.js';
import type { Host } from '../tool-home.js';

const HOME = '/home/member';
const ROOT = '/repo/project';

function hostWith(existing: readonly string[]): Host {
  const set = new Set(existing);
  return {
    platform: 'linux', path: path.posix, home: HOME, profileHome: HOME,
    env: {}, toolHomes: { kind: 'missing' },
    cwd: () => ROOT,
    exists: async (dir: string) => set.has(dir),
    realpath: async (file: string) => file,
    readText: async () => null, existsNow: () => false, readTextNow: () => null,
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

describe('only skills accept the new root as install proof (#1290)', () => {
  // Only skills have verified 5.7+ delivery evidence (the 13-skill `/` menu
  // check in #1273). Every other surface keeps requiring `.workbuddy/`, so a
  // 5.7-only member fails closed instead of writing into the dead layout.
  const PATHS = {
    workbuddy: {
      skills: '.workbuddy/skills',
      rules: '.codebuddy/rules',
      mcp: '.workbuddy/mcp.json',
      mcpProject: '.mcp.json',
    },
  };

  it('rules stay fail-closed when only .workbuddy-ai exists', async () => {
    const host = hostWith([`${ROOT}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: PATHS }, { scope: 'project', projectRoot: ROOT, repo: {} });
    const where = await locate('workbuddy', 'rules', install, host);
    expect(where.gates).toContainEqual({ kind: 'installed', probe: `${ROOT}/.workbuddy`, met: false });
    expect(writable(where)).toBeNull();
  });

  it('mcp stays fail-closed when only .workbuddy-ai exists', async () => {
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

  it('user scope, .workbuddy-ai-only home: a team rule and an MCP server find no target, so no .workbuddy/ is created (#1290)', async () => {
    // The reviewer's exact scenario: every surface configured (rules and an
    // MCP server, via the default entry that carries them all), the home
    // holding only the 5.7+ root. Rules and MCP stay fail-closed — pull
    // finds no writable target for either, so nothing ever creates
    // `.workbuddy/` — while skills still take the new root on the same
    // member.
    const host = hostWith([`${HOME}/.workbuddy-ai`]);
    const install = installOf({ toolPaths: DEFAULT_TOOL_PATHS }, { scope: 'user', repo: {} });
    // Two explicit calls, not a loop: `writable()` narrows by resource, so a
    // union-typed `Location<'mcp' | 'rules'>` does not type-check.
    const rules = await locate('workbuddy', 'rules', install, host);
    expect(rules.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy`, met: false });
    expect(writable(rules)).toBeNull();
    const mcp = await locate('workbuddy', 'mcp', install, host);
    expect(mcp.gates).toContainEqual({ kind: 'installed', probe: `${HOME}/.workbuddy`, met: false });
    expect(writable(mcp)).toBeNull();
    const skills = await locate('workbuddy', 'skills', install, host);
    expect(ownOf(skills)?.path).toBe(`${HOME}/.workbuddy-ai/skills`);
    expect(writable(skills)).not.toBeNull();
  });
});
