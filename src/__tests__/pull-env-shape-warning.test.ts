/**
 * `pullForScope` skips the env resource as soon as `countEnvVars` reports 0,
 * and an env.yaml with no top-level `variables:` key reports exactly that — so
 * the shape warning has to be raised from the orchestration layer. A check
 * inside `pullItem` never runs on a real pull, and the misconfiguration goes
 * unreported (#662; caught by the #681 review).
 *
 * These tests therefore drive `pull()` rather than the handler: the unit tests
 * in env-handler.test.ts cover the shape detection itself, this file covers the
 * wiring that makes it reachable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', () => ({
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfigForScope: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  loadTeamConfig: vi.fn(),
  requireInit: vi.fn(),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    fail: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis(),
    start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(),
  })),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [{
      id: 'dev',
      name: 'Dev',
      description: '',
      resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [] },
    }],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({
    knowledge: ['common'], skills: ['common'], learnings: ['common'], agents: [],
  })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

// The end-of-pull checks are exercised in pull-post-checks.test.ts; keep them
// out of the way here so a warning under test is the only thing on the wire.
vi.mock('../doctor.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../doctor.js')>(),
  resolveDoctorContext: vi.fn(),
  buildChecks: vi.fn(),
}));

import { detectProjectConfig, loadLocalConfigForScope, loadStateForScope, loadTeamConfig, saveStateForScope } from '../config.js';
import { acquireLock } from '../update.js';
import { buildChecks, resolveDoctorContext, type DoctorContext } from '../doctor.js';
import { log } from '../utils/logger.js';
import { pull } from '../pull.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

const SHAPE_WARNING = 'no top-level `variables:` key';

describe('env.yaml shape warning on a real pull', () => {
  let tempDir: string;
  let homeDir: string;
  let repoPath: string;
  // The object `loadStateForScope` hands out. pull() mutates it in place before
  // saving, so holding the reference is what lets a second pull see the rev the
  // first one recorded — no guessing at the resolved target set.
  let state: Record<string, unknown>;

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-pull-env-shape-'));
    homeDir = path.join(tempDir, 'home');
    repoPath = path.join(tempDir, 'team-repo');
    vi.stubEnv('HOME', homeDir);

    await fse.ensureDir(path.join(repoPath, 'skills', 'common', 'kept-skill'));
    await fse.writeFile(
      path.join(repoPath, 'skills', 'common', 'kept-skill', 'SKILL.md'),
      '---\nname: kept-skill\ndescription: kept\n---\n',
    );
    await fse.ensureDir(path.join(repoPath, 'manifest'));
    await fse.writeFile(path.join(repoPath, 'manifest', 'roles.yaml'), 'version: 1\n');
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));

    const localConfig: LocalConfig = {
      repo: { localPath: repoPath, remote: 'owner/repo' },
      username: 'tester',
      scope: 'user',
      primaryRole: 'dev',
      additionalRoles: [],
    };
    const teamConfig: TeamaiConfig = {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true },
      },
      toolPaths: { claude: { skills: '.claude/skills', rules: '.claude/rules' } },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    state = { lastPull: null, lastPullRev: null };
    vi.mocked(loadStateForScope).mockResolvedValue(state as never);

    const ctx: DoctorContext = {
      localConfig,
      teamConfig,
      toolPaths: teamConfig.toolPaths,
      baseDir: homeDir,
    };
    vi.mocked(resolveDoctorContext).mockResolvedValue(ctx);
    vi.mocked(buildChecks).mockResolvedValue([]);
    // clearAllMocks resets calls, not implementations, so a test that makes the
    // lock contended would otherwise leak into the next one.
    vi.mocked(acquireLock).mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tempDir);
  });

  it('warns, naming the keys it found, when `variables:` is missing', async () => {
    // A bare key/value mapping: zod accepts it as "no variables", so the pull
    // used to look successful while delivering nothing at all.
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'FOO: bar\nBAZ: qux\n');

    await pull({ force: true });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(SHAPE_WARNING));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('`FOO`'));
  });

  it('stays quiet for an env.yaml that does carry `variables:`', async () => {
    await fse.outputFile(
      path.join(repoPath, 'env', 'env.yaml'),
      'variables:\n  - key: FOO\n    value: bar\n',
    );

    await pull({ force: true });

    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining(SHAPE_WARNING));
  });

  it('stays quiet for an env.yaml that is only an empty `variables:` list', async () => {
    // Genuinely nothing to deliver — not a mistake, so not worth a warning.
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'variables: []\n');

    await pull({ force: true });

    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining(SHAPE_WARNING));
  });

  it('warns from the unchanged-rev fast path too', async () => {
    // The machine pulled once while the CLI still accepted a bad shape, so it
    // stored the rev. The repo has not moved since — every later pull takes the
    // "Already synced" branch and returns before Step 2. Without the check on
    // that branch the warning is unreachable for exactly the users it is for.
    await fse.outputFile(path.join(repoPath, 'env', 'env.yaml'), 'FOO: bar\n');

    // First pull: full sync, stores the rev and the target set.
    await pull({});
    expect(state.lastPullRev).toBe('abc1234');

    vi.mocked(log.warn).mockClear();
    vi.mocked(log.success).mockClear();

    // Second pull: same rev, same target set — the fast path.
    await pull({});

    // Pins that the fast path really was taken, so the warning below cannot
    // have come from the Step 2 site.
    expect(log.success).toHaveBeenCalledWith(expect.stringContaining('Already synced'));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(SHAPE_WARNING));
  });
});
