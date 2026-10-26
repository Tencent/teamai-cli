import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { isToolInstalledForConfig } from '../resources/base.js';
import { scopedToolPaths } from '../types.js';
import type { LocalConfig } from '../types.js';

/**
 * WorkBuddy 5.7+ moved its runtime to `~/.workbuddy-ai/` (settings.json,
 * plugins/, skills/ …) and stopped reading `~/.workbuddy/` — the old root is a
 * leftover (#1273). The install probe must recognize both generations, or a
 * 5.7+ member looks uninstalled and teamai integrates nothing.
 */
describe('WorkBuddy install probe across generations (#1273)', () => {
  let root: string;
  let home: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-workbuddy-detect-'));
    home = path.join(root, 'home');
    projectRoot = path.join(root, 'project');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    await fse.ensureDir(projectRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const projectConfig = (): LocalConfig => ({
    repo: { localPath: path.join(root, 'repo'), remote: 'fixture' },
    username: 'tester', scope: 'project', projectRoot, additionalRoles: [],
  });

  it('finds old-generation WorkBuddy by .workbuddy at the base dir', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    expect(await isToolInstalledForConfig('workbuddy', '.workbuddy/skills', projectConfig())).toBe(true);
  });

  it('does not treat .workbuddy-ai alone as installed outside the skills surface (#1290)', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(await isToolInstalledForConfig('workbuddy', '.workbuddy/skills', projectConfig())).toBe(false);
  });

  it('takes the old root as proof when both generations left directories behind', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy'));
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(await isToolInstalledForConfig('workbuddy', '.workbuddy/skills', projectConfig())).toBe(true);
  });

  it('does not take a bare .codebuddy directory for WorkBuddy', async () => {
    await fse.ensureDir(path.join(projectRoot, '.codebuddy'));
    expect(await isToolInstalledForConfig('workbuddy', '.codebuddy/rules', projectConfig())).toBe(false);
  });
});

/**
 * The skills write side (#1273): on an install that left only the 5.7+
 * `.workbuddy-ai/` root, skills must land where the app actually scans —
 * live-verified in the issue (13 team skills showed in the `/` menu). Only
 * the default `.workbuddy/skills` swaps: a team that redirected skills on
 * purpose keeps its own path.
 */
describe('scopedToolPaths swaps WorkBuddy skills to the 5.7+ root (#1273)', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-wb-paths-'));
    home = path.join(root, 'home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  const defaultTeam = { toolPaths: { workbuddy: { skills: '.workbuddy/skills' } } };
  const paths = (team: unknown, scope: 'user' | 'project' = 'user', projectRoot?: string) =>
    scopedToolPaths(team as never, { scope, ...(projectRoot ? { projectRoot } : {}) });

  it('delivers to .workbuddy-ai/skills when only the 5.7+ root exists', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('prefers the new root when an upgrade left both roots behind (#1290 P1)', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy'));
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('keeps the old path when neither root exists (nothing detected)', () => {
    expect(paths(defaultTeam).workbuddy.skills).toBe('.workbuddy/skills');
  });

  it('never stomps a team that redirected skills on purpose', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const redirected = { toolPaths: { workbuddy: { skills: '.workbuddy-ai/skills' } } };
    expect(paths(redirected).workbuddy.skills).toBe('.workbuddy-ai/skills');
    const elsewhere = { toolPaths: { workbuddy: { skills: 'custom/skills' } } };
    expect(paths(elsewhere).workbuddy.skills).toBe('custom/skills');
  });

  it('keeps the swap after the user-scope override merges the default path (#1290 P1)', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const scoped = {
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills', userScope: { skills: '.workbuddy/skills' } },
      },
    };
    expect(paths(scoped).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });

  it('never stomps a userScope skills redirect of its own (#1290 P1)', async () => {
    await fse.ensureDir(path.join(home, '.workbuddy-ai'));
    const scoped = {
      toolPaths: {
        workbuddy: { skills: '.workbuddy/skills', userScope: { skills: 'custom/skills' } },
      },
    };
    expect(paths(scoped).workbuddy.skills).toBe('custom/skills');
  });

  it('swaps against the project root in project scope', async () => {
    const projectRoot = path.join(root, 'project');
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(paths(defaultTeam, 'project', projectRoot).workbuddy.skills).toBe('.workbuddy-ai/skills');
  });
});
