import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

// Issue #73 keeps project scope isolated by default. These tests also cover the
// explicit safe-resource inheritance path without composing control-plane data.

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  requireInit: vi.fn(),
  loadState: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveState: vi.fn(),
  loadLocalConfigForScope: vi.fn(),
  loadTeamConfig: vi.fn(),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadStateForScope: vi.fn().mockResolvedValue({ lastPull: null, lastPullRev: null }),
  saveStateForScope: vi.fn(),
}));

vi.mock('../utils/git.js', () => ({
  pullRepo: vi.fn().mockResolvedValue('already up to date'),
  getHeadRev: vi.fn().mockResolvedValue('abc1234'),
  // The project is no git checkout here.
  gitCommonDir: vi.fn().mockResolvedValue(null),
  nearestGitEntry: vi.fn().mockResolvedValue(null),
  listWorktrees: vi.fn().mockResolvedValue([]),
  resolveAnchors: vi.fn().mockResolvedValue(null),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
    persist: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

// Stub the cross-team source pull so we can assert which scope it runs against
// without doing any real git work.
vi.mock('../source.js', () => ({
  pullSources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks.js', () => ({
  injectHooksToAllTools: vi.fn().mockResolvedValue(undefined),
  reconcileTeamHooksForConfig: vi.fn().mockResolvedValue({ ok: true, defs: [] }),
  deliveredHookFiles: vi.fn().mockResolvedValue([]),
  unreadableHookFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../mcp-reconcile.js', () => ({
  reconcileMcpForConfig: vi.fn().mockResolvedValue({ changes: [], wrote: false }),
  describeKeptMemberServer: vi.fn(() => ''),
  judgeTeamaiOnlyMcpConfigs: vi.fn().mockResolvedValue([]),
}));

vi.mock('../team-push.js', () => ({
  reportUsage: vi.fn().mockResolvedValue('reported'),
}));

vi.mock('../usage-tracker.js', () => ({
  readUsageEvents: vi.fn().mockResolvedValue([]),
  truncateUsageAfterReport: vi.fn().mockResolvedValue(undefined),
  capUsageEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../recall-adoption.js', () => ({
  drainRecallLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../roles.js', () => ({
  loadRolesManifest: vi.fn().mockResolvedValue({
    version: 1,
    roles: [],
    defaults: { shareTarget: 'primary-role' },
  }),
  resolveRoleResourceNamespaces: vi.fn(() => ({ knowledge: [], skills: [], learnings: [] })),
}));

// Isolation: pull() takes a real ~/.teamai/.sync-lock. Parallel vitest workers
// sharing that path race and skip/error, so these tests mock the lock.
vi.mock('../update.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn(async <T>(_lock: string, _wait: unknown, body: () => Promise<T>) => ({
    held: true as const,
    value: await body(),
  })),
}));

import { pull, settleLateUsageReport } from '../pull.js';
import { getTeamSecretsPath } from '../secret-store.js';
import { EnvHandler, readEnvBackup } from '../resources/env.js';
import {
  loadLocalConfigForScope,
  loadTeamConfig,
  detectProjectConfig,
  loadStateForScope,
  saveStateForScope,
} from '../config.js';
import { getHeadRev, gitCommonDir } from '../utils/git.js';
import { pullSources } from '../source.js';
import { log } from '../utils/logger.js';
import { reconcileTeamHooksForConfig } from '../hooks.js';
import { reconcileMcpForConfig } from '../mcp-reconcile.js';
import { reportUsage, type UsageReportOutcome } from '../team-push.js';
import { capUsageEvents, readUsageEvents, truncateUsageAfterReport } from '../usage-tracker.js';
import { drainRecallLog } from '../recall-adoption.js';
import { releaseLock } from '../update.js';
import { StateSchema, SYNC_LOCK_FILENAME, getTeamaiHomeDir, type TeamaiConfig, type LocalConfig, type State } from '../types.js';

const SKIP_MSG = 'workspace scope detected, skipped user scope';

describe('pull scope isolation (issue #73)', () => {
  let tmpDir: string;
  let homeDir: string;
  let userRepoPath: string;
  let projectRoot: string;
  let projectRepoPath: string;
  let teamConfig: TeamaiConfig;
  let userConfig: LocalConfig;
  let projectConfig: LocalConfig;

  beforeEach(async () => {
    vi.mocked(reportUsage).mockReset().mockResolvedValue('reported');
    vi.mocked(saveStateForScope).mockReset();
    vi.mocked(readUsageEvents).mockResolvedValue([]);
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-scope-iso-'));
    homeDir = path.join(tmpDir, 'home');
    userRepoPath = path.join(tmpDir, 'user-repo');
    projectRoot = path.join(tmpDir, 'proj');
    projectRepoPath = path.join(projectRoot, '.teamai', 'team-repo');

    for (const repo of [userRepoPath, projectRepoPath]) {
      await fse.ensureDir(path.join(repo, 'skills'));
      await fse.ensureDir(path.join(repo, 'rules'));
    }
    await fse.ensureDir(path.join(userRepoPath, 'skills', 'org-safe-review'));
    await fse.writeFile(
      path.join(userRepoPath, 'skills', 'org-safe-review', 'SKILL.md'),
      '---\nname: org-safe-review\ndescription: safe review workflow\n---\n',
    );
    await fse.ensureDir(path.join(userRepoPath, 'env'));
    await fse.writeFile(
      path.join(userRepoPath, 'env', 'env.yaml'),
      'variables:\n  - key: USER_ONLY\n    value: old\n',
    );
    await fse.ensureDir(path.join(homeDir, '.claude', 'skills'));
    await fse.ensureDir(path.join(projectRoot, '.claude', 'skills'));

    vi.stubEnv('HOME', homeDir);

    teamConfig = {
      team: 'test',
      description: '',
      repo: 'https://git.woa.com/test/repo.git',
      provider: 'tgit' as const,
      reviewers: [],
      sharing: {
        skills: {},
        rules: { enforced: [] },
        docs: { localDir: '' },
        env: { injectShellProfile: true },
      },
      toolPaths: {
        claude: { skills: '.claude/skills', rules: '.claude/rules' },
      },
    };

    userConfig = {
      repo: { localPath: userRepoPath, remote: 'https://git.woa.com/test/repo.git' },
      username: 'userscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    projectConfig = {
      repo: { localPath: projectRepoPath, remote: 'https://git.woa.com/test/proj.git' },
      username: 'projscope',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'project',
      projectRoot,
    };

    vi.mocked(loadTeamConfig).mockResolvedValue(teamConfig);
    vi.mocked(getHeadRev).mockResolvedValue('abc1234');
    vi.mocked(loadStateForScope).mockImplementation(async (localConfig) => ({
      lastPull: localConfig.scope === 'project' ? '2026-04-01' : null,
      lastPullRev: localConfig.scope === 'project' ? 'abc1234' : null,
      lastPush: null,
      pushedRules: [],
      pushedSkills: [],
      pushedEnvVars: [],
      pendingPushes: [],
      lastUpdateCheck: null,
      availableUpdate: null,
    }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await fse.remove(tmpDir);
  });

  it.each([false, true])('only consumes usage after confirmed success: %s', async (success) => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(readUsageEvents).mockResolvedValue([{ skill: 'review', timestamp: new Date().toISOString(), tool: 'claude' }]);
    vi.mocked(reportUsage).mockResolvedValueOnce(success ? 'reported' : 'unreported');
    await pull({ silent: true });
    if (success) {
      expect(truncateUsageAfterReport).toHaveBeenCalledTimes(1);
      expect(truncateUsageAfterReport).toHaveBeenCalledWith(1, projectConfig);
    }
    else expect(truncateUsageAfterReport).not.toHaveBeenCalled();
  });

  it.each(['first failure', 'repeated failure', 'recovery', 'success', 'exception'])(
    'persists the auto-report outcome after the other state writers: %s', async (outcome) => {
      const since = '2026-10-26T10:00:00.000Z';
      const wasPending = outcome === 'repeated failure' || outcome === 'recovery';
      vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
      let saved: State = {
        ...StateSchema.parse({ lastPullRev: 'abc1234', pushedSkills: ['keep-me'] }),
        ...(wasPending ? { autoReportPendingSince: since } : {}),
      };
      vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved));
      vi.mocked(saveStateForScope).mockImplementation(async (state) => { saved = structuredClone(state); });
      if (outcome === 'exception') vi.mocked(reportUsage).mockRejectedValueOnce(new Error('offline'));
      else vi.mocked(reportUsage).mockResolvedValueOnce(outcome === 'success' || outcome === 'recovery' ? 'reported' : 'unreported');

      await pull({ silent: true });

      expect(saved.pushedSkills).toEqual(['keep-me']);
      if (outcome === 'success' || outcome === 'recovery') {
        expect(saved).not.toHaveProperty('autoReportPendingSince');
      } else if (wasPending) {
        expect(saved).toHaveProperty('autoReportPendingSince', since);
      } else {
        expect(saved).toHaveProperty('autoReportPendingSince', expect.any(String));
      }
    },
  );

  it.each([
    { scope: 'user', optOut: 'member' },
    { scope: 'user', optOut: 'team' },
    { scope: 'project', optOut: 'member' },
    { scope: 'project', optOut: 'team' },
  ])('clears a pending auto-report when $optOut disables reporting in $scope scope', async ({ scope, optOut }) => {
    const config = scope === 'project' ? projectConfig : userConfig;
    // A real pull reloads the config from disk on every invocation. Return a
    // fresh object from both scope readers so this regression test does not
    // accidentally test an in-memory mutation that the command never persists.
    vi.mocked(detectProjectConfig).mockImplementation(async () => scope === 'project' ? structuredClone(config) : null);
    vi.mocked(loadLocalConfigForScope).mockImplementation(async () => structuredClone(config));
    let saved: State = StateSchema.parse({ lastPullRev: 'abc1234', pushedSkills: ['keep-me'] });
    vi.mocked(loadStateForScope).mockImplementation(async () => structuredClone(saved));
    vi.mocked(saveStateForScope).mockImplementation(async (state) => { saved = structuredClone(state); });
    vi.mocked(readUsageEvents).mockResolvedValue([{ skill: 'review', timestamp: new Date().toISOString(), tool: 'claude' }]);
    vi.mocked(reportUsage).mockResolvedValue('unreported');

    await pull({ silent: true });
    expect(saved.autoReportPendingSince).toEqual(expect.any(String));

    if (optOut === 'member') config.usageReportEnabled = false;
    else vi.mocked(loadTeamConfig).mockResolvedValue({ ...teamConfig, usageReport: false });
    vi.mocked(reportUsage).mockClear();
    await pull({ silent: true });

    expect(saved).not.toHaveProperty('autoReportPendingSince');
    expect(saved.pushedSkills).toEqual(['keep-me']);
    expect(reportUsage).not.toHaveBeenCalled();
    expect(truncateUsageAfterReport).not.toHaveBeenCalled();
  });

  it.each([true, false])('caps the usage file only after the report has truncated it (#788): %s', async (success) => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(readUsageEvents).mockResolvedValue([{ skill: 'review', timestamp: new Date().toISOString(), tool: 'claude' }]);
    vi.mocked(reportUsage).mockResolvedValueOnce(success ? 'reported' : 'unreported');
    await pull({ silent: true });
    expect(capUsageEvents).toHaveBeenCalledTimes(1);
    expect(capUsageEvents).toHaveBeenCalledWith(projectConfig);
    const capOrder = vi.mocked(capUsageEvents).mock.invocationCallOrder[0];
    expect(vi.mocked(reportUsage).mock.invocationCallOrder[0]).toBeLessThan(capOrder);
    if (success) expect(vi.mocked(truncateUsageAfterReport).mock.invocationCallOrder[0]).toBeLessThan(capOrder);
  });

  it('drains the recall log of the active scope before the report, so the votes it credits are reported (#884)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    await pull({ silent: true });
    expect(drainRecallLog).toHaveBeenCalledTimes(1);
    expect(drainRecallLog).toHaveBeenCalledWith(projectConfig);
    expect(vi.mocked(drainRecallLog).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(reportUsage).mock.invocationCallOrder[0]);
  });

  it('drains the recall log of a scope with usageReport: false (#884)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...teamConfig, usageReport: false });
    await pull({ silent: true });
    expect(drainRecallLog).toHaveBeenCalledWith(userConfig);
  });

  it('caps the usage file of a scope with usageReport: false (#788)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...teamConfig, usageReport: false });
    await pull({ silent: true });
    expect(reportUsage).not.toHaveBeenCalled();
    expect(capUsageEvents).toHaveBeenCalledWith(userConfig);
  });

  it('does not report a scope whose member set usageReportEnabled: false', async () => {
    const optedOut = { ...userConfig, usageReportEnabled: false };
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(optedOut);
    await pull({ silent: true });
    expect(reportUsage).not.toHaveBeenCalled();
    expect(capUsageEvents).toHaveBeenCalledWith(optedOut);
  });

  it('reports a scope whose member set usageReportEnabled: true over the team usageReport: false', async () => {
    const optedIn = { ...userConfig, usageReportEnabled: true };
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(optedIn);
    vi.mocked(loadTeamConfig).mockResolvedValue({ ...teamConfig, usageReport: false });
    await pull({ silent: true });
    expect(reportUsage).toHaveBeenCalledWith(userRepoPath, 'userscope', expect.objectContaining({ selfConfig: optedIn }));
  });

  it.each([true, false])('keeps late completion alive without starting a second report: %s', async (success) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(readUsageEvents).mockResolvedValue([{ skill: 'review', timestamp: new Date().toISOString(), tool: 'claude' }]);
    let finish!: (value: UsageReportOutcome) => void;
    let started!: () => void;
    const pushStarted = new Promise<void>((resolve) => { started = resolve; });
    const pushResult = new Promise<UsageReportOutcome>((resolve) => { finish = resolve; });
    vi.mocked(reportUsage).mockImplementationOnce(() => { started(); return pushResult; });
    const pulling = pull({ silent: true });
    await pushStarted;
    await vi.advanceTimersByTimeAsync(5000);
    await pulling;
    expect(truncateUsageAfterReport).not.toHaveBeenCalled();
    // Partition sync-locks stay held until the late report finishes. The
    // reports worktree lock (.reports-lock) is acquired and released around
    // the earlier read-only refresh, which is independent of that wait, and so
    // is the user scope's lock, held for the auto-compact step only.
    expect(
      vi.mocked(releaseLock).mock.calls.filter(
        ([lock]) => typeof lock === 'string' && path.basename(lock) === SYNC_LOCK_FILENAME && path.dirname(lock) !== getTeamaiHomeDir(),
      ),
    ).toEqual([]);
    expect(pullSources).toHaveBeenCalled();
    await pull({ silent: true });
    expect(reportUsage).toHaveBeenCalledTimes(1);
    finish(success ? 'reported' : 'unreported');
    await vi.advanceTimersByTimeAsync(0);
    await settleLateUsageReport();
    const saved = vi.mocked(saveStateForScope).mock.lastCall?.[0] ?? {};
    if (success) expect(saved).not.toHaveProperty('autoReportPendingSince');
    else expect(saved).toHaveProperty('autoReportPendingSince', expect.any(String));
    if (success) {
      expect(truncateUsageAfterReport).toHaveBeenCalledTimes(1);
      expect(truncateUsageAfterReport).toHaveBeenCalledWith(1, projectConfig);
    }
    else expect(truncateUsageAfterReport).not.toHaveBeenCalled();
    await pull({ silent: true });
    expect(reportUsage).toHaveBeenCalledTimes(2);
  });

  it('project mode: skips user scope entirely and pulls source against project', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);

    await pull({ silent: true });

    // User scope is never pulled: it is read only to decide the machine-wide
    // auto-compact value (#1456).
    expect(vi.mocked(loadLocalConfigForScope).mock.calls).toEqual([['user']]);
    // The skip notice is printed.
    expect(log.info).toHaveBeenCalledWith(SKIP_MSG);
    // Source pull still runs (decision 1), against the project config.
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({
      scope: 'project',
      projectRoot,
    });
  });

  it.each([
    { file: 'env.yaml', content: 'variables: [\n' },
    { file: 'secrets.yaml', content: 'secrets: [\n' },
  ])('registers a first-pulled project with no team env when $file cannot resolve', async ({ file, content }) => {
    vi.stubEnv('SHELL', '/bin/bash');
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    await new EnvHandler().writeResolvedEnv([{ key: 'USER_TOKEN', value: 'user-secret' }], teamConfig, userConfig);
    await fse.outputFile(path.join(projectRepoPath, 'env', file), content);

    await pull({ force: true, silent: true });

    const registry = path.join(homeDir, '.teamai', 'env-scopes');
    const rows = (await fse.readFile(registry, 'utf8')).split('\n');
    expect(rows.some((line) => line.startsWith('dir\t') && line.includes('\t-\t0\t')), JSON.stringify({ rows, warns: vi.mocked(log.warn).mock.calls })).toBe(true);
    const shell = spawnSync('bash', ['-c', 'printenv USER_TOKEN || true'], {
      cwd: projectRoot,
      env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash' },
      encoding: 'utf8',
    });
    expect(shell.status).toBe(0);
    expect(shell.stdout.trim()).toBe('');
  });

  // Pull's env stage: resolve → write env.sh and its backup → loader and
  // profile → registry row (with a new stamp). A failure at any step leaves a
  // project that does not inherit the user scope without the user env, keeps
  // its row unless its env could not be resolved, and is reported.
  describe.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0)('env stage failures', () => {
    const steps = ['resolve', 'write', 'profile', 'register', 'register while the lock stays held'] as const;
    const cases = steps.flatMap((step) => (['first pull', 'pulled before'] as const).flatMap((before) =>
      (['full sync', 'fast path'] as const).map((route) => ({ step, before, route }))));

    const projectRow = async (): Promise<string> => {
      const registry = await fse.readFile(path.join(homeDir, '.teamai', 'env-scopes'), 'utf8').catch(() => '');
      return registry.split('\n').find((line) => line.startsWith('dir\t')) ?? 'none';
    };
    /** What a `bash -c` started in `dir` sees, as a tool runs a command there. */
    const sees = (dir: string, key: string): string => spawnSync('bash', ['-c', `printenv ${key} || true`], {
      cwd: dir,
      env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim();

    it.each(cases)('$step fails on the $before, $route', async ({ step, before, route }) => {
      vi.stubEnv('SHELL', '/bin/bash');
      vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
      // A project set up in its checkout, as `detectProjectConfig` reads it there.
      await fse.outputFile(path.join(projectRoot, '.teamai', 'config.yaml'), 'scope: project\n');
      await new EnvHandler().writeResolvedEnv([{ key: 'USER_TOKEN', value: 'user-secret' }], teamConfig, userConfig);
      const projectEnv = (value: string) => fse.outputFile(path.join(projectRepoPath, 'env', 'env.yaml'), `variables:\n  - key: MARKER\n    value: ${value}\n`);
      if (before === 'pulled before') {
        await projectEnv('old');
        await pull({ force: true, silent: true });
      }
      const rowBefore = await projectRow();
      const markerBefore = sees(projectRoot, 'MARKER');
      await projectEnv('new');

      const envSh = path.join(projectRoot, '.teamai', 'env.sh');
      const realWriteFile = fse.writeFile;
      const spies: { mockRestore: () => void }[] = [];
      const failWrite = (fails: (file: string) => boolean) => spies.push(vi.spyOn(fse, 'writeFile').mockImplementation((async (file: string, ...rest: unknown[]) => {
        if (fails(String(file))) throw Object.assign(new Error(`EACCES: permission denied, open '${String(file)}'`), { code: 'EACCES' });
        return (realWriteFile as (...args: unknown[]) => Promise<void>)(file, ...rest);
      }) as typeof fse.writeFile));
      if (step === 'resolve') await fse.outputFile(path.join(projectRepoPath, 'env', 'env.yaml'), 'variables: [\n');
      if (step === 'write') failWrite((file) => file === envSh);
      if (step === 'profile') {
        // An older block to move out, so the profile is written.
        await fse.appendFile(path.join(homeDir, '.bashrc'), `\n# [teamai:env:start]\n# DO NOT EDIT: This section is auto-managed by teamai\n[ -f '${envSh}' ] && source '${envSh}'\n# [teamai:env:end]\n`);
        const home = await fse.realpath(homeDir);
        failWrite((file) => path.dirname(file) === home && /^\.(bash|profile)/.test(path.basename(file)));
      }
      if (step.startsWith('register')) {
        const { acquireLock } = await import('../update.js');
        // Held through one registry change's five seconds of retries, then free, or held throughout.
        let attempts = 0;
        const free = step === 'register' ? 100 : Infinity;
        vi.mocked(acquireLock).mockImplementation(async (lock?: string) => path.basename(lock ?? '') !== 'env-scopes.lock' || ++attempts > free);
        // Those retries pass at once here.
        const realSetTimeout = globalThis.setTimeout;
        spies.push(vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 50 ? 0 : ms)) as typeof setTimeout));
      }

      const exitCode = process.exitCode;
      const outcome = await pull({ force: route === 'full sync', silent: true }).then(() => 'completed', (error: Error) => error.message);
      const exitedWith = process.exitCode;
      process.exitCode = exitCode;
      for (const spy of spies) spy.mockRestore();
      const { acquireLock } = await import('../update.js');
      vi.mocked(acquireLock).mockResolvedValue(true);
      const reported = [outcome, ...vi.mocked(log.warn).mock.calls.map(([message]) => String(message))].join('\n');

      // The user env stays out of the project, and still loads outside it.
      expect(sees(projectRoot, 'USER_TOKEN')).toBe('');
      expect(sees(tmpDir, 'USER_TOKEN')).toBe('user-secret');
      // An env that could not be resolved keeps what the last pull delivered,
      // in shells as in env exec and MCP; a project never delivered loads none.
      if (step === 'resolve' && before === 'first pull') {
        expect(await projectRow()).toMatch(/^dir\t[^\t]+\t-\t0\t/);
        expect(sees(projectRoot, 'MARKER')).toBe('');
        return;
      }
      expect(await projectRow()).toBe(rowBefore);
      if (step === 'resolve') {
        expect(sees(projectRoot, 'MARKER')).toBe('old');
        expect(await readEnvBackup(projectConfig)).toEqual({ MARKER: 'old' });
        return;
      }
      expect(sees(projectRoot, 'MARKER')).toBe(step === 'write' ? markerBefore : (before === 'first pull' ? '' : 'new'));
      expect(reported).toMatch(step.startsWith('register') ? /registry lock stayed busy/ : /EACCES/);
      expect(exitedWith).toBe(1);
    });

    it.each(['full sync', 'fast path'] as const)('keeps the user env out of a project whose data lives outside its checkout while its first pull cannot register, $0', async (route) => {
      vi.stubEnv('SHELL', '/bin/bash');
      // A git checkout whose config lives in ~/.teamai/projects, so nothing in it says it is a project.
      expect(spawnSync('git', ['init', '-q', projectRoot]).status).toBe(0);
      const common = await fse.realpath(path.join(projectRoot, '.git'));
      vi.mocked(gitCommonDir).mockResolvedValue(common);
      projectConfig.dataHome = path.join(homeDir, '.teamai', 'projects', 'proj-1234');
      vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
      await new EnvHandler().writeResolvedEnv([{ key: 'USER_TOKEN', value: 'user-secret' }], teamConfig, userConfig);
      await fse.outputFile(path.join(projectRepoPath, 'env', 'env.yaml'), 'variables:\n  - key: MARKER\n    value: new\n');
      const { acquireLock } = await import('../update.js');
      vi.mocked(acquireLock).mockImplementation(async (lock?: string) => path.basename(lock ?? '') !== 'env-scopes.lock');
      const realSetTimeout = globalThis.setTimeout;
      const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 50 ? 0 : ms)) as typeof setTimeout);

      const exitCode = process.exitCode;
      await pull({ force: route === 'full sync', silent: true }).catch(() => undefined);
      const exitedWith = process.exitCode;
      process.exitCode = exitCode;
      timers.mockRestore();
      vi.mocked(acquireLock).mockResolvedValue(true);

      expect(exitedWith).toBe(1);
      expect(await fse.readFile(path.join(homeDir, '.teamai', 'env-scopes'), 'utf8').catch(() => '')).not.toContain(`git\t${common}\t`);
      expect(sees(projectRoot, 'USER_TOKEN')).toBe('');
      expect(sees(tmpDir, 'USER_TOKEN')).toBe('user-secret');

      await pull({ force: route === 'full sync', silent: true });
      expect(sees(projectRoot, 'MARKER')).toBe('new');
      expect(sees(projectRoot, 'USER_TOKEN')).toBe('');
      expect(await fse.pathExists(path.join(common, 'teamai-env-pending'))).toBe(false);
    });
  });

  it('project mode: inherits user resources only when explicitly enabled', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await pull({ silent: true });

    // The third argument is the LoadOptions the loader now receives so it can
    // preview instead of migrate (#850). It rides along on every call, so the
    // assertion has to mention it; `dryRun` is undefined here because this test
    // drives `pull` without `--dry-run`.
    expect(loadLocalConfigForScope).toHaveBeenCalledWith('user', undefined, { dryRun: undefined });
    expect(loadStateForScope).toHaveBeenCalledWith(expect.objectContaining({ scope: 'user' }));
    expect(loadStateForScope).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project', projectRoot }));
    expect(log.info).toHaveBeenCalledWith(
      'workspace scope detected, inheriting user-scope resources and knowledge',
    );
    expect(log.info).not.toHaveBeenCalledWith(SKIP_MSG);
    expect(await fse.pathExists(
      path.join(homeDir, '.claude', 'skills', 'org-safe-review', 'SKILL.md'),
    )).toBe(true);
    // The project's shells load the user env.sh: it follows the user repo this pull refreshed.
    expect(await fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf8')).toContain("export USER_ONLY='old'");
    expect(saveStateForScope).toHaveBeenCalledWith(
      expect.objectContaining({
        lastPullRev: null,
        lastInheritedPullRev: 'abc1234',
      }),
      expect.objectContaining({ scope: 'user' }),
    );
    expect(reconcileTeamHooksForConfig).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'user' }),
      expect.anything(),
    );
    expect(reconcileMcpForConfig).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'user' }),
    );
    expect(reportUsage).not.toHaveBeenCalledWith(
      userRepoPath,
      expect.anything(),
      expect.anything(),
    );
    // External sources stay bound to the active project scope.
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({ scope: 'project' });
  });

  // Shells load the user env.sh in an inheriting project, while `env exec` and
  // MCP resolve the user repo: the pull that refreshes it rewrites env.sh too.
  it.each([
    { path: 'a full sync', rev: 'def5678' },
    { path: 'the already-synced fast path', rev: 'abc1234' },
  ])('project mode: rewrites the inherited user env.sh with the refreshed value on $path', async ({ rev }) => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);
    const saved = new Map<string, State>();
    vi.mocked(saveStateForScope).mockImplementation(async (state, localConfig) => { saved.set(localConfig.scope, structuredClone(state)); });
    const loadState = vi.mocked(loadStateForScope).getMockImplementation()!;
    vi.mocked(loadStateForScope).mockImplementation(async (localConfig) => saved.get(localConfig.scope) ?? loadState(localConfig));
    await pull({ silent: true });
    expect(await fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf8')).toContain("export USER_ONLY='old'");

    await fse.writeFile(path.join(userRepoPath, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n    value: new\n');
    vi.mocked(getHeadRev).mockResolvedValue(rev);
    await pull({ silent: true });

    expect(await fse.readFile(path.join(homeDir, '.teamai', 'env.sh'), 'utf8')).toContain("export USER_ONLY='new'");
    expect(vi.mocked(log.success).mock.calls.some(([message]) => message === '[user] Already synced at abc1234, skipping')).toBe(rev === 'abc1234');
    expect(reconcileTeamHooksForConfig).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'user' }), expect.anything());
    expect(reconcileMcpForConfig).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: 'user' }));
  });

  // While an env.yaml can't resolve, shells keep the last pull's env.sh; a key
  // now declared a secret leaves them as it leaves env exec and MCP.
  it.skipIf(spawnSync('bash', ['-c', 'true']).status !== 0).each([
    { declares: 'the user scope', repo: () => userRepoPath, last: 'old', breaks: 'env.yaml' },
    { declares: 'the project, of an inherited variable', repo: () => projectRepoPath, last: 'old', breaks: 'env.yaml' },
    { declares: 'the project, of its own variable', repo: () => projectRepoPath, last: 'proj', breaks: 'env.yaml' },
    { declares: 'the project, of its own variable', repo: () => projectRepoPath, last: 'proj', breaks: 'values file' },
  ])('keeps a key $declares now declares a secret out of shells while its $breaks cannot resolve', async ({ repo, last, breaks }) => {
    vi.stubEnv('SHELL', '/bin/bash');
    vi.mocked(gitCommonDir).mockResolvedValue(null);
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);
    await fse.outputFile(path.join(projectRoot, '.teamai', 'config.yaml'), 'scope: project\n');
    await fse.writeFile(path.join(userRepoPath, 'env', 'env.yaml'), 'variables:\n  - key: TOKEN\n    value: old\n');
    await fse.outputFile(path.join(projectRepoPath, 'env', 'env.yaml'), `variables:\n  - key: PROJ\n    value: p\n${last === 'proj' ? '  - key: TOKEN\n    value: proj\n' : ''}`);
    const sees = (dir: string, key: string): string => spawnSync('bash', ['-c', `printenv ${key} || true`], {
      cwd: dir,
      env: { HOME: homeDir, PATH: process.env.PATH, SHELL: '/bin/bash', BASH_ENV: path.join(homeDir, '.teamai', 'env-loader.sh') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout.trim();
    await pull({ force: true, silent: true });
    expect(sees(projectRoot, 'TOKEN')).toBe(last);

    await fse.outputFile(path.join(repo(), 'env', 'secrets.yaml'), 'secrets:\n  - key: TOKEN\n');
    if (breaks === 'env.yaml') await fse.outputFile(path.join(repo(), 'env', 'env.yaml'), 'variables: [\n');
    else await fse.outputFile(getTeamSecretsPath(projectConfig), '{');
    await pull({ force: true, silent: true }).catch(() => undefined);
    process.exitCode = undefined;

    const { appliedTeamEnv, resolveTeamEnv } = await import('../env-resolution.js');
    expect(appliedTeamEnv(await resolveTeamEnv(projectConfig)).variables.has('TOKEN')).toBe(false);
    expect(sees(projectRoot, 'TOKEN')).toBe('');
    // The rest of the last pull stays.
    expect(sees(projectRoot, 'PROJ')).toBe('p');
  });

  it('project mode: warns but continues when inherited user scope is unavailable', async () => {
    projectConfig.inheritUserScope = true;
    vi.mocked(detectProjectConfig).mockResolvedValue(projectConfig);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(null);

    await pull({ silent: true });

    expect(log.warn).toHaveBeenCalledWith(
      'user-scope inheritance is enabled, but user scope is not initialized',
    );
    expect(loadStateForScope).toHaveBeenCalledWith(expect.objectContaining({ scope: 'project', projectRoot }));
  });

  it('user mode: pulls user scope and routes source against user (no skip notice)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await pull({ silent: true });

    expect(loadLocalConfigForScope).toHaveBeenCalledWith('user', undefined, { dryRun: undefined });
    expect(log.info).not.toHaveBeenCalledWith(SKIP_MSG);
    expect(pullSources).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullSources).mock.calls[0][0]).toMatchObject({ scope: 'user' });
    expect(reportUsage).toHaveBeenCalledWith(
      userRepoPath,
      'userscope',
      expect.objectContaining({
        selfConfig: expect.objectContaining({
          repo: expect.objectContaining({ localPath: userRepoPath }),
        }),
      }),
    );
  });

  it('user mode: pull --force never forces MCP over a member\'s own server (#993)', async () => {
    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(userConfig);

    await pull({ silent: true, force: true });

    expect(reconcileMcpForConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ force: true }),
    );
  });

  it('user mode self-repo: reportUsage receives selfConfig so business repo is never reset', async () => {
    const businessRoot = path.join(tmpDir, 'business-repo');
    const selfRepoPath = path.join(businessRoot, '.teamai');
    const selfUserConfig: LocalConfig = {
      repo: {
        localPath: selfRepoPath,
        remote: 'https://git.woa.com/test/self-repo.git',
        kind: 'self',
        businessRepoRoot: businessRoot,
      },
      username: 'selfuser',
      updatePolicy: 'auto',
      additionalRoles: [],
      scope: 'user',
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(null);
    vi.mocked(loadLocalConfigForScope).mockResolvedValue(selfUserConfig);

    await pull({ silent: true });

    expect(reportUsage).toHaveBeenCalledWith(
      selfRepoPath,
      'selfuser',
      expect.objectContaining({
        selfConfig: expect.objectContaining({
          repo: expect.objectContaining({ kind: 'self' }),
        }),
      }),
    );
  });

  it('project mode http-repo: never calls reportUsage (data-loss guard)', async () => {
    const httpProjectConfig: LocalConfig = {
      ...projectConfig,
      repo: { ...projectConfig.repo, kind: 'http' as const },
    };

    vi.mocked(detectProjectConfig).mockResolvedValue(httpProjectConfig);

    await pull({ silent: true });

    // HTTP-kind repo: kind !== 'http' guard filters out both report targets,
    // so targets is empty and the business repo's team-repo dir is never reset.
    expect(reportUsage).not.toHaveBeenCalled();
    // Its local file is the only source `teamai stats` has, so it is capped
    // rather than consumed (#788).
    expect(capUsageEvents).toHaveBeenCalledWith(httpProjectConfig);
  });
});
