import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import { execFileSync } from 'node:child_process';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadStateForScope: vi.fn(async () => ({})),
  saveStateForScope: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  autoDetectInit: vi.fn(),
}));
vi.mock('../utils/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/git.js')>()),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  createGit: vi.fn(),
}));
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({ held: true, value: await body() }),
}));
vi.mock('../utils/logger.js', () => ({
  log: { persist: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis() })),
}));

import { pull } from '../pull.js';
import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { log } from '../utils/logger.js';
import { StateSchema, TeamaiConfigSchema, type LocalConfig, type State } from '../types.js';

const workflow = (invoke: string) => `schemaVersion: v1alpha1
name: check
description: Lint the change.
invoke: ${invoke}
steps:
  - id: lint
    command: node -e "process.exit(0)"
`;

describe('a pull and the generated workflow skills', () => {
  let tmp: string; let home: string; let repo: string; let saved: Record<string, State>; let user: LocalConfig;
  const skill = (root: string) => path.join(root, '.claude', 'skills', 'workflow-check', 'SKILL.md');
  const synced = (label: string): boolean => vi.mocked(log.success).mock.calls.some(([message]) => String(message) === `[${label}] Already synced at abc1234, skipping`);

  beforeEach(async () => {
    tmp = fse.realpathSync(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-workflow-skills-')));
    home = path.join(tmp, 'home'); repo = path.join(tmp, 'repo');
    await fse.outputFile(path.join(repo, 'workflows', 'check.yaml'), workflow('allow'));
    await fse.ensureDir(path.join(home, '.claude'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', '');
    saved = {};
    // Each scope keeps its own state, as each scope's config names its own state file.
    vi.mocked(saveStateForScope).mockImplementation(async (state, config) => { saved[config.scope] = structuredClone(state); });
    vi.mocked(loadStateForScope).mockImplementation(async (config) => structuredClone(saved[config.scope] ?? StateSchema.parse({})));
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'https://example.invalid/x/t.git' }));
    user = {
      repo: { localPath: repo, remote: 'https://example.invalid/x/t.git' }, username: 'u', updatePolicy: 'auto',
      additionalRoles: [], scope: 'user', enabledAgents: ['claude'], dataHome: path.join(tmp, 'data'),
    } as LocalConfig;
    vi.mocked(loadLocalConfigForScope).mockImplementation(async (scope) => scope === 'user' ? user : null);
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.mocked(log.success).mockClear(); await fse.remove(tmp); });

  it('removes the skill of a workflow that stopped offering one, on a pull that finds the repo already synced', async () => {
    await pull({});
    expect(await fse.pathExists(skill(home))).toBe(true);

    await fse.outputFile(path.join(repo, 'workflows', 'check.yaml'), workflow('deny'));
    await pull({});

    expect(synced('user')).toBe(true);
    expect(await fse.pathExists(path.dirname(skill(home)))).toBe(false);
  });

  // Inherited user scope delivers the user team's skills into HOME's roots, so its workflow skills go there too, and
  // the pull that refreshes them is the one that removes them.
  it('writes the skill of an inherited user-scope workflow into HOME\'s roots, not the project\'s, and removes it there', async () => {
    const project = path.join(tmp, 'project');
    const projectRepo = path.join(tmp, 'project-repo');
    await fse.ensureDir(path.join(projectRepo, 'workflows'));
    await fse.ensureDir(path.join(project, '.claude'));
    execFileSync('git', ['init', '-q', project]);
    vi.mocked(detectProjectConfig).mockResolvedValue({
      ...user, repo: { localPath: projectRepo, remote: 'https://example.invalid/x/p.git' }, scope: 'project', projectRoot: project,
      dataHome: path.join(tmp, 'project-data'), inheritUserScope: true,
    });

    await pull({});
    expect([await fse.pathExists(skill(home)), await fse.pathExists(skill(project))]).toEqual([true, false]);

    await fse.outputFile(path.join(repo, 'workflows', 'check.yaml'), workflow('deny'));
    await pull({});

    expect(await fse.pathExists(path.dirname(skill(home)))).toBe(false);
  });
});
