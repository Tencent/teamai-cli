import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { isToolInstalledForConfig } from '../resources/base.js';
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

  it('finds new-generation WorkBuddy 5.7+ by .workbuddy-ai alone', async () => {
    await fse.ensureDir(path.join(projectRoot, '.workbuddy-ai'));
    expect(await isToolInstalledForConfig('workbuddy', '.workbuddy/skills', projectConfig())).toBe(true);
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
