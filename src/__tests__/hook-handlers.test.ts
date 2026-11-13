import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mocks ────────────────────────────────────────────────
// Mock the underlying modules so handlers don't do real I/O

const mockPull = vi.fn().mockResolvedValue(undefined);
const mockSettleLateUsageReport = vi.fn().mockResolvedValue(undefined);
const mockDashboardReport = vi.fn().mockResolvedValue(undefined);
const mockParseHookEvent = vi.fn().mockResolvedValue({ type: 'session_start', timestamp: '2026-01-01', sessionId: 'test', tool: 'claude' });
const mockAppendEvent = vi.fn().mockResolvedValue(undefined);
const mockTrackFromParsed = vi.fn().mockResolvedValue(undefined);
const mockTrackSlashFromParsed = vi.fn().mockResolvedValue(undefined);
const mockContributeCheckForSession = vi.fn().mockResolvedValue({ hint: null });
const mockTakePendingHint = vi.fn().mockResolvedValue(null);
// Default: no doc has been credited yet this session → every adopted doc is
// "fresh" (returns its input). Tests that exercise the dedup override this.
// incrementUpvoted now returns the docs it actually credited (or null on lock
// failure). Default: echo the input docIds as the freshly-credited set.
const mockIncrementUpvoted = vi.fn().mockImplementation(async (_p: string, docIds: string[]) => docIds);
const mockSyncVotesToTeam = vi.fn().mockResolvedValue(false);
const mockDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockReportAndSyncFromHook = vi.fn().mockResolvedValue(null);
const mockLocalAgentInstructionText = vi.fn().mockResolvedValue('');
const mockPackageManifestHash = vi.fn().mockResolvedValue('before-hash');
const mockStashPackageHint = vi.fn().mockResolvedValue(undefined);
const mockClaimPackageHint = vi.fn().mockResolvedValue(null);
const mockTakePendingPackageHint = vi.fn().mockResolvedValue(null);

const mockTeamDelivery = vi.fn().mockResolvedValue({ complete: false, key: undefined, gap: 'no_record' });
// The checkout already has a delivery record: a session start or tool use prepares nothing.
const mockDeliveringCheckoutRecord = vi.fn().mockResolvedValue({ rev: 'abc', targets: [] });
vi.mock('../pull.js', () => ({
  pull: mockPull,
  deliveringCheckoutRecord: mockDeliveringCheckoutRecord,
  settleLateUsageReport: mockSettleLateUsageReport,
  teamDelivery: mockTeamDelivery,
}));

vi.mock('../dashboard-collector.js', () => ({
  parseHookEvent: mockParseHookEvent,
  appendEvent: mockAppendEvent,
  compactEvents: vi.fn().mockResolvedValue(undefined),
  dashboardReport: mockDashboardReport,
  dataHomeKey: vi.fn().mockResolvedValue('key'),
  eventRepoAnchor: vi.fn().mockResolvedValue(undefined),
  addGitStateAtStart: vi.fn().mockResolvedValue(undefined),
  addGitHeadAtStop: vi.fn().mockResolvedValue(undefined),
  gitStateIn: vi.fn().mockReturnValue(undefined),
  gitStateAtStopIn: vi.fn().mockReturnValue(undefined),
  // The payload's cwd: what hookScopeDir answers for a cwd that exists (#810).
  hookScopeDir: async (stdin: Record<string, unknown>) =>
    (await vi.importActual<typeof import('../utils/hook-cwd.js')>('../utils/hook-cwd.js')).resolveHookCwd(stdin),
}));

// The REAL skill-name extraction and validation, so the webhook and skill-use
// tests exercise the resolution production runs; every named skill counts as
// installed, since these payloads name paths that do not exist here.
vi.mock('../usage-tracker.js', async () => {
  const actual = await vi.importActual<typeof import('../usage-tracker.js')>('../usage-tracker.js');
  return {
    trackFromStdin: mockTrackFromParsed,
    trackSlashCommand: mockTrackSlashFromParsed,
    extractSkillName: actual.extractSkillName,
    isValidSkillName: actual.isValidSkillName,
    skillRoots: vi.fn().mockResolvedValue([]),
    skillExistsOnDisk: vi.fn().mockResolvedValue(true),
    isInstalledSkillFile: vi.fn().mockResolvedValue(true),
    appendUsageEvent: vi.fn().mockResolvedValue(undefined),
    updateKnownSkills: vi.fn().mockResolvedValue(undefined),
  };
});

const mockSendWebhook = vi.fn().mockResolvedValue(undefined);
const mockLoadWebhookConfig = vi.fn().mockResolvedValue({
  enabled: true,
  endpoints: [{ url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 3 }],
});
vi.mock('../webhook.js', () => ({
  sendWebhook: mockSendWebhook,
  loadWebhookConfig: mockLoadWebhookConfig,
}));

vi.mock('../contribute-check.js', async () => ({
  contributeCheck: vi.fn().mockResolvedValue(undefined),
  contributeCheckForSession: mockContributeCheckForSession,
  takePendingHint: mockTakePendingHint,
  sanitizeSessionId: (await vi.importActual<typeof import('../contribute-check.js')>('../contribute-check.js')).sanitizeSessionId,
}));

vi.mock('../update.js', () => ({
  doUpdate: mockDoUpdate,
  checkForUpdate: vi.fn().mockResolvedValue({ available: false, current: '1.0.0' }),
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
  withFileLock: vi.fn(async (_lockPath: string, _wait: unknown, body: () => Promise<unknown>) => ({ held: true, value: await body() })),
}));

const mockAutoDetectInit = vi.fn().mockResolvedValue({
  localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
  // Recall on: the contribute hint routes to the share workflow, which is
  // refused while recall is off, so the hint is withheld there too.
  teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { recall: { enabled: true } } },
});

const mockFindUnreadableProjectConfig = vi.fn().mockResolvedValue(null);

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: mockAutoDetectInit,
  // A payload cwd that no longer exists (these tests use '/x') holds no
  // project config, so the gate asks the user config: the same mocked one.
  requireInit: mockAutoDetectInit,
  findUnreadableProjectConfig: mockFindUnreadableProjectConfig,
  loadLocalConfigForScope: vi.fn().mockResolvedValue(null),
  resolveConfigForDir: vi.fn().mockResolvedValue({
    repo: { localPath: '/tmp/team-repo', remote: '' }, username: 'test', scope: 'user', additionalRoles: [],
  }),
}));

vi.mock('@teamai/shared/log', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setStderrOnly: vi.fn().mockReturnValue(false),
}));

vi.mock('../local-agent.js', () => ({
  reportAndSyncFromHook: mockReportAndSyncFromHook,
  localAgentInstructionText: mockLocalAgentInstructionText,
}));

vi.mock('../pkg/pkg-hint.js', () => ({
  packageManifestHashForCwd: mockPackageManifestHash,
  stashPackageHintAfterPull: mockStashPackageHint,
  claimPackageHintOutput: mockClaimPackageHint,
  takePendingPackageHint: mockTakePendingPackageHint,
}));

const mockMrHintOutput = vi.fn().mockResolvedValue(null);
const mockStashMrHint = vi.fn().mockResolvedValue(undefined);
vi.mock('../mr-hint.js', () => ({
  computeMrHintOutput: mockMrHintOutput,
  stashMrHint: mockStashMrHint,
  takePendingMrHint: vi.fn().mockResolvedValue(null),
}));

// votes-sync's adoption comes from the recall-log reducer (#884); its own
// behavior is covered end to end in recall-attribution.test.ts.
const mockCreditAdoptedDocs = vi.hoisted(() => vi.fn());
vi.mock('../recall-adoption.js', () => ({
  recalledDocsForSession: vi.fn(async () => []),
  creditAdoptedDocs: mockCreditAdoptedDocs,
  recordToolCall: vi.fn(async () => undefined),
}));

const voteMocks = vi.hoisted(() => ({
  hasPendingVoteDeltas: vi.fn().mockResolvedValue(false),
  creditedDocIdsForSession: vi.fn().mockResolvedValue(new Set<string>()),
  stageVotesMerge: vi.fn().mockResolvedValue(null),
  confirmVotesSynced: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../votes.js', () => ({
  incrementUpvoted: mockIncrementUpvoted,
  syncVotesToTeam: mockSyncVotesToTeam,
  hasPendingVoteDeltas: (...args: unknown[]) => voteMocks.hasPendingVoteDeltas(...args),
  creditedDocIdsForSession: (...args: unknown[]) => voteMocks.creditedDocIdsForSession(...args),
  pruneUpvoteLedger: vi.fn().mockResolvedValue(undefined),
  stageVotesMerge: (...args: unknown[]) => voteMocks.stageVotesMerge(...args),
  confirmVotesSynced: (...args: unknown[]) => voteMocks.confirmVotesSynced(...args),
  readUserVotesFromContent: vi.fn(() => ({ version: 2, votes: {}, deltas: {} })),
}));

const reportsBranchMocks = vi.hoisted(() => ({
  updateReports: vi.fn().mockResolvedValue({ status: 'published' }),
  readReportsOriginFile: vi.fn().mockResolvedValue(null),
}));
vi.mock('../utils/reports-branch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/reports-branch.js')>(),
  updateReports: (...args: unknown[]) => reportsBranchMocks.updateReports(...args),
  readReportsOriginFile: (...args: unknown[]) => reportsBranchMocks.readReportsOriginFile(...args),
}));

const mockSeedProjectAgentRoot = vi.fn().mockResolvedValue(undefined);
const mockCreateProjectToolRoots = vi.fn().mockResolvedValue(undefined);
vi.mock('../project-agent-root.js', () => ({
  seedProjectAgentRoot: mockSeedProjectAgentRoot,
  createProjectToolRoots: mockCreateProjectToolRoots,
}));

// No scope scores finished sessions unless a test says so; a detached process is never started for real.
const mockBackgroundPassScopes = vi.fn().mockResolvedValue([]);
const mockStartFinished = vi.fn();
vi.mock('../session-flow/finished-sessions.js', () => ({ FinishedSessions: { backgroundScopes: mockBackgroundPassScopes, start: mockStartFinished } }));
const mockDriveByDefault = vi.fn().mockResolvedValue({ kind: 'drive', driver: 'local' });
vi.mock('../default-driver.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../default-driver.js')>()), driveByDefault: mockDriveByDefault }));
vi.mock('../env-resolution.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../env-resolution.js')>()), resolveWorkflowEnv: vi.fn().mockResolvedValue({}) }));
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn(() => ({ on: vi.fn().mockReturnThis(), unref: vi.fn() })) }));
vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:child_process')>()), spawn: mockSpawn }));

import { buildAdoptedSummary, buildHandlerRegistry, filterHandlersForConfig } from '../hook-handlers.js';
import { createDispatcher } from '../hook-dispatch.js';
import { GIT_HOOK_EVENTS } from '../git-hook.js';
import type { JsonValue, LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';

/** The scope hook-dispatch resolved for the hook's cwd, handed to every handler. */
// Recall on through the member's switch: `/tmp` holds no teamai.yaml to turn it on for the team, and the recall handlers do nothing while it is off.
const scope: LocalConfig = { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user', additionalRoles: [], recallEnabled: true };

// ── Tests ────────────────────────────────────────────────

describe('hook-handlers registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalAgentInstructionText.mockResolvedValue('');
    mockIncrementUpvoted.mockImplementation(async (_p: string, docIds: string[]) => docIds);
    mockCreditAdoptedDocs.mockResolvedValue({ credited: [], recalled: 0 });
    mockPackageManifestHash.mockResolvedValue('before-hash');
    mockTakePendingPackageHint.mockResolvedValue(null);
  });

  it('lets a background update finish its registry, install and hook-refresh budgets (#1685)', async () => {
    vi.useFakeTimers();
    mockDoUpdate.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 80_000)));
    const handlers = buildHandlerRegistry().filter((r) => r.handler.name === 'update');
    const dispatcher = createDispatcher({ handlers, localConfig: null });
    let settled = false;
    const dispatch = dispatcher.dispatch('stop', '*', {}, 'copilot', 'background').then((result) => {
      settled = true;
      return result;
    });

    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(70_000);
      expect((await dispatch).errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns registrations for all expected events', () => {
    const registry = buildHandlerRegistry();
    const events = new Set(registry.map((r) => r.event));
    expect(events).toContain('session-start');
    expect(events).toContain('stop');
    expect(events).toContain('post-tool-use');
    expect(events).toContain('prompt-submit');
    expect(events).toContain('session-end');
  });

  it('records an automatic update skipped by its policy or install layout as skipped', async () => {
    mockDoUpdate.mockResolvedValueOnce('skipped');
    const handlers = buildHandlerRegistry().filter((r) => r.handler.name === 'update');
    const dispatcher = createDispatcher({ handlers, localConfig: null });
    const result = await dispatcher.dispatch('stop', '*', {}, 'claude', 'background');
    expect(mockDoUpdate).toHaveBeenLastCalledWith(null, { automatic: true });
    expect(result).toEqual({ output: null, errors: [] });
    expect(log.debug).toHaveBeenCalledWith(expect.stringMatching(/update=\d+ms\(skipped\)/));
  });

  it('records an automatic update failure as failed rather than ok', async () => {
    mockDoUpdate.mockResolvedValueOnce('failed');
    const handlers = buildHandlerRegistry().filter((r) => r.handler.name === 'update');
    const dispatcher = createDispatcher({ handlers, localConfig: null });
    const result = await dispatcher.dispatch('stop', '*', {}, 'claude', 'background');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].handlerName).toBe('update');
    expect(log.debug).toHaveBeenCalledWith(expect.stringMatching(/update=\d+ms\(failed\)/));
  });

  it('records an automatic update that could not reach the registry as failed', async () => {
    mockDoUpdate.mockResolvedValueOnce('unreachable');
    const handlers = buildHandlerRegistry().filter((r) => r.handler.name === 'update');
    const dispatcher = createDispatcher({ handlers, localConfig: null });
    const result = await dispatcher.dispatch('stop', '*', {}, 'claude', 'background');
    expect(result.errors).toHaveLength(1);
    expect(log.debug).toHaveBeenCalledWith(expect.stringMatching(/update=\d+ms\(failed\)/));
  });

  it('post-tool-use runs every non-output handler detached, leaving the inline pass empty (#1216)', () => {
    // dashboard-report and recall-attribution always return null — pure side
    // effects, the exact criterion `background` documents — and the same
    // dashboard handler already runs detached for stop and session-end. On
    // Windows each foreground handler second is host-visible: a dispatch pays
    // one node start-up per pass, and under disk contention dashboard-report
    // alone measured 3.8 s inside the host's 10 s budget (#1216). Detached,
    // the inline pass for a plain tool call has no handlers at all, and the
    // host-visible cost collapses to bundle load + spawn.
    const handlers = buildHandlerRegistry().filter((r) => r.event === 'post-tool-use' && r.matcher === '*');
    for (const name of ['dashboard-report', 'recall-attribution', 'local-agent-sync']) {
      const reg = handlers.find((r) => (r.handler as { name: string }).name === name);
      expect(reg, name).toBeDefined();
      expect(reg!.background, `${name} must run detached`).toBe(true);
    }
    // What remains inline: the TodoWrite hint alone, which answers nothing but a
    // TodoWrite call (#1788). The fast path hands every other call to the child.
    const inline = handlers.filter((r) => !r.background);
    expect(inline.map((r) => r.handler.name)).toEqual(['todowrite-hint']);
  });

  // What a prompt's foreground runs is what hook-fast-path.ts `promptAnswersInForeground` predicts
  // the output of: a package hint, an MR hint, a contribute hint, the HTTP local agent's notices (#1788).
  it.each([
    ['darwin', ['pending-hint', 'package-pending-hint', 'mr-hint-pending', 'local-agent-sync']],
    ['linux', ['pending-hint', 'package-pending-hint', 'mr-hint-pending', 'local-agent-sync']],
    // No detached child is added on Windows, where one is a WMI spawn.
    ['win32', ['pending-hint', 'package-pending-hint', 'mr-hint-pending', 'skill-mention', 'dashboard-report', 'local-agent-sync']],
  ])('prompt-submit on %s answers in the foreground with only %j', (platform, foreground) => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform as NodeJS.Platform);
    const handlers = buildHandlerRegistry().filter((r) => r.event === 'prompt-submit');
    platformSpy.mockRestore();

    expect(handlers.filter((r) => !r.background).map((r) => r.handler.name)).toEqual(foreground);
    expect(handlers.map((r) => r.handler.name)).toEqual(['pending-hint', 'package-pending-hint', 'mr-hint-pending', 'skill-mention', 'dashboard-report', 'local-agent-sync']);
  });

  it('session-end records the final dashboard snapshot, dispatches the webhook and pushes votes in the background, and credits votes in the foreground', () => {
    const handlers = buildHandlerRegistry().filter((r) => r.event === 'session-end');
    // Copilot fires SessionEnd (not Stop), so the webhook handler must run here
    // too — otherwise those sessions emit no session-stop notification (#702).
    // votes-sync credits the last turn's reads, votes-push pushes them (#884).
    expect(handlers).toEqual([
      expect.objectContaining({
        matcher: '*',
        background: true,
        handler: expect.objectContaining({ name: 'dashboard-report' }),
      }),
      expect.objectContaining({
        matcher: '*',
        background: true,
        handler: expect.objectContaining({ name: 'webhook-dispatch' }),
      }),
      expect.objectContaining({
        matcher: '*',
        gitOnly: true,
        requiresConfig: true,
        handler: expect.objectContaining({ name: 'votes-sync' }),
      }),
      expect.objectContaining({
        matcher: '*',
        background: true,
        gitOnly: true,
        requiresConfig: true,
        handler: expect.objectContaining({ name: 'votes-push' }),
      }),
    ]);
    expect(handlers[2].background).toBeUndefined();
  });

  it('session-start has pull and dashboard-report handlers', () => {
    const registry = buildHandlerRegistry();
    const sessionStartHandlers = registry
      .filter((r) => r.event === 'session-start' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(sessionStartHandlers).toContain('pull');
    expect(sessionStartHandlers).toContain('dashboard-report');
  });

  it.skipIf(process.platform === 'win32')('session-start adds the tool version to the capture its start wrote, and sweeps captures of sessions that are gone, in the background (#1178)', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-version-')));
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f11';
    const dir = path.join(root, 'data', 'sessions', 'captures', 'claude-code', 's-capture');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({
      captureId, platform: 'claude-code', sessionId: 's-capture', capturedAt: '2026-10-23T10:00:00.000Z',
      agent: { v: 1, tool: { name: 'claude' }, teamai: '0.0.0', driver: 'session' },
    }));
    const gone = path.join(root, 'data', 'sessions', 'captures', 'claude-code', 's-gone');
    fs.mkdirSync(gone, { recursive: true });
    fs.writeFileSync(path.join(gone, `${captureId}.json`), JSON.stringify({
      captureId, platform: 'claude-code', sessionId: 's-gone', capturedAt: '2026-10-01T10:00:00.000Z', sessionFile: path.join(root, 's-gone.jsonl'),
      agent: { v: 1, tool: { name: 'claude' }, teamai: '0.0.0', driver: 'session' },
    }));
    const { clearVersionCache } = await import('../agent-version.js');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'claude'), '#!/bin/sh\necho "2.1.308 (Claude Code)"\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`);
    clearVersionCache();
    const config: LocalConfig = { repo: { kind: 'git', localPath: root, remote: '' }, username: 'test', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
    const registration = buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'session-capture');

    try {
      expect(registration).toMatchObject({ background: true, requiresConfig: true });
      await registration?.handler.execute({ session_id: 's-capture', teamai_capture: captureId }, 'claude', config);
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${captureId}.json`), 'utf8')).agent.tool).toEqual({ name: 'claude', version: '2.1.308' });
      expect(fs.existsSync(path.join(root, 'data', 'sessions', 'captures', 'claude-code', 's-gone'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      clearVersionCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps the self-mode post-merge lock wait at five seconds', async () => {
    const handler = buildHandlerRegistry().find(r => r.event === 'post-merge')!.handler;
    await handler.execute({ cwd: '/tmp/self-project' }, 'git', {
      scope: 'project', projectRoot: '/tmp/self-project', username: 'test', additionalRoles: [],
      repo: { kind: 'self', localPath: '/tmp/self-project', remote: '' },
    });
    expect(mockPull).toHaveBeenCalledWith({ silent: true, inline: true, gitHook: 'post-merge', fetchTimeoutMs: 5000 });
  });

  it.each(['rebase', 'amend'])('post-rewrite syncs only a completed rebase, not amend (%s)', async (rewrite) => {
    const { createDispatcher: freshCreateDispatcher } = await import('../hook-dispatch.js');
    const dispatcher = freshCreateDispatcher({
      handlers: buildHandlerRegistry(),
      localConfig: {
        scope: 'project', projectRoot: '/tmp/self-project', username: 'test', additionalRoles: [],
        repo: { kind: 'self', localPath: '/tmp/self-project', remote: '' },
      },
    });
    const result = await dispatcher.dispatch('post-rewrite', '*', {
      cwd: '/tmp/self-project', hook_event_name: 'post-rewrite', git_args: [rewrite],
    }, 'git');
    expect(result.errors).toEqual([]);
    expect(result.output).toBeNull();
    if (rewrite === 'amend') expect(mockPull).not.toHaveBeenCalled();
    else expect(mockPull).toHaveBeenCalledWith({ silent: true, inline: true, gitHook: 'post-rewrite', fetchTimeoutMs: 5000 });
  });

  // Git 2.14–2.32 runs a fast-forward `git pull --rebase` with autostash as a
  // rebase that only checks out the upstream: no post-merge, no post-rewrite.
  describe('post-checkout from a rebase that fast-forwards', () => {
    let repo: string;
    let base: string;
    let ahead: string;
    let side: string;
    const savedAction = process.env.GIT_REFLOG_ACTION;

    beforeAll(async () => {
      const { execFileSync } = await import('node:child_process');
      repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-ff-rebase-')));
      const git = (args: string[]) => execFileSync('git', args, {
        cwd: repo, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim();
      git(['init', '-q', '-b', 'main']);
      git(['commit', '-q', '--allow-empty', '-m', 'base']);
      base = git(['rev-parse', 'HEAD']);
      git(['commit', '-q', '--allow-empty', '-m', 'upstream']);
      ahead = git(['rev-parse', 'HEAD']);
      git(['checkout', '-q', '-b', 'local', base]);
      git(['commit', '-q', '--allow-empty', '-m', 'local']);
      side = git(['rev-parse', 'HEAD']);
    });
    afterEach(() => {
      if (savedAction === undefined) delete process.env.GIT_REFLOG_ACTION;
      else process.env.GIT_REFLOG_ACTION = savedAction;
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

    const checkout = async (args: () => string[], action: string | undefined) => {
      if (action === undefined) delete process.env.GIT_REFLOG_ACTION;
      else process.env.GIT_REFLOG_ACTION = action;
      const { createDispatcher: freshCreateDispatcher } = await import('../hook-dispatch.js');
      const dispatcher = freshCreateDispatcher({
        handlers: buildHandlerRegistry(),
        localConfig: {
          scope: 'project', projectRoot: repo, username: 'test', additionalRoles: [],
          repo: { kind: 'self', localPath: repo, remote: '' },
        },
      });
      const result = await dispatcher.dispatch('post-checkout', '*', {
        cwd: repo, hook_event_name: 'post-checkout', git_args: args(),
      }, 'git');
      expect(result.errors).toEqual([]);
    };

    it.each([
      'pull --rebase --autostash (start): checkout origin/main',
      'pull -q --rebase --autostash',
      'rebase (start): checkout origin/main',
      'rebase',
    ])('syncs once, as a capped git pull recorded as post-checkout (GIT_REFLOG_ACTION=%s)', async (action) => {
      await checkout(() => [base, ahead, '1'], action);
      expect(mockPull).toHaveBeenCalledTimes(1);
      expect(mockPull).toHaveBeenCalledWith({ silent: true, inline: true, gitHook: 'post-checkout', fetchTimeoutMs: 5000 });
    });

    it.each<[string, () => string[], string | undefined]>([
      ['a divergent rebase (post-rewrite syncs it)', () => [side, ahead, '1'], 'pull --rebase'],
      ['a checkout outside pull or rebase', () => [base, ahead, '1'], undefined],
      ['an unknown reflog action', () => [base, ahead, '1'], 'pullish'],
      ['a file checkout', () => [base, ahead, '0'], 'pull --rebase'],
      ['an unchanged HEAD', () => [ahead, ahead, '1'], 'pull --rebase'],
      ['arguments that are not object ids', () => ['--help', ahead, '1'], 'pull --rebase'],
    ])('does not sync %s', async (_case, args, action) => {
      await checkout(args, action);
      expect(mockPull).not.toHaveBeenCalled();
    });
  });

  it('does not sync teamai\'s own knowledge worktree on post-checkout or post-merge', async () => {
    const { execFileSync } = await import('node:child_process');
    const main = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-own-wt-')));
    const git = (args: string[], cwd: string) => execFileSync('git', args, {
      cwd, stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
    try {
      git(['init', '-q', '-b', 'main'], main);
      git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
      const wt = path.join(main, '.teamai', 'knowledge-wt');
      git(['worktree', 'add', '-q', '--detach', wt, 'HEAD'], main);
      // As detection resolves it from inside that worktree: its own checkout.
      const config = {
        scope: 'project', projectRoot: wt, username: 'test', additionalRoles: [],
        repo: { kind: 'self', localPath: path.join(wt, '.teamai'), remote: '' },
      } as unknown as LocalConfig;
      const registry = buildHandlerRegistry();
      mockPull.mockClear();
      await registry.find(r => r.event === 'post-checkout')!.handler.execute(
        { cwd: wt, git_args: ['0'.repeat(40), 'abc', '1'] }, 'git', config);
      await registry.find(r => r.event === 'post-merge')!.handler.execute({ cwd: wt, git_args: ['0'] }, 'git', config);
      await registry.find(r => r.event === 'post-rewrite')!.handler.execute({ cwd: wt, hook_event_name: 'post-rewrite', git_args: ['rebase'] }, 'git', config);
      expect(mockPull).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it.each(['pi', 'omp', 'hermes', 'codex', 'codex-internal', 'tcodex'])('does not read or sync HTTP prompts for excluded %s', async (tool) => {
    const registry = buildHandlerRegistry();
    const cached = registry.find((r) => r.handler.name === 'http-prompt-instructions')!.handler;
    const sync = registry.find((r) => r.handler.name === 'local-agent-sync')!.handler;
    const config = { scope: 'project', disabledAgents: [tool] } as never;
    const input = { cwd: '/project', hook_event_name: tool.includes('codex') ? 'SubagentStart' : 'instructions' };
    expect(await cached.execute(input, tool, config)).toBeNull();
    expect(await sync.execute({ cwd: '/project', hook_event_name: 'SessionStart' }, tool, config)).toBeNull();
    expect(mockLocalAgentInstructionText).not.toHaveBeenCalled();
    expect(mockReportAndSyncFromHook).not.toHaveBeenCalled();
  });

  it('still delivers cached HTTP prompts without a git team configuration', async () => {
    mockLocalAgentInstructionText.mockResolvedValue('HTTP-PROMPT');
    const registry = buildHandlerRegistry();
    const cached = registry.find((r) => r.handler.name === 'http-prompt-instructions')!.handler;
    const sync = registry.find((r) => r.handler.name === 'local-agent-sync')!.handler;
    expect(await cached.execute({ cwd: '/project' }, 'pi', null)).toContain('HTTP-PROMPT');
    expect(await sync.execute({ cwd: '/project', hook_event_name: 'SessionStart' }, 'codex', null)).toContain('HTTP-PROMPT');
    expect(mockReportAndSyncFromHook).toHaveBeenCalledOnce();
  });

  it('session-start pull seeds the hook tool root before pulling', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute({ session_id: 's-pull', cwd: '/tmp/some-project' }, 'claude', null);

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('claude', '/tmp/some-project');
    expect(mockPull).toHaveBeenCalledWith({ silent: true, sessionStart: true });
    expect(mockStashPackageHint).toHaveBeenCalledWith(
      '/tmp/some-project',
      's-pull',
      'before-hash',
    );
    expect(mockSeedProjectAgentRoot.mock.invocationCallOrder[0]).toBeLessThan(
      mockPull.mock.invocationCallOrder[0],
    );
  });

  it('session-start pull returns only after a report the pull stopped waiting for settles (#1322)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;
    let settle!: () => void;
    mockSettleLateUsageReport.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
    let returned = false;

    const done = handler.execute({ cwd: '/tmp/some-project' }, 'claude', null).then(() => { returned = true; });
    await vi.waitFor(() => expect(mockSettleLateUsageReport).toHaveBeenCalledOnce());
    expect(returned).toBe(false);
    settle();
    await done;

    expect(returned).toBe(true);
  });

  function sessionStartPull() {
    const registered = buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'pull');
    if (!registered) throw new Error('no session-start pull handler');
    return registered.handler;
  }

  it('session-start pull starts teamai-finished-sessions in each scope that scores or publishes sessions, and drives it detached with no agent evidence, once the late usage report settles', async () => {
    const handler = sessionStartPull();
    const cwd = fs.realpathSync.native(os.tmpdir());
    const user = { ...scope, dataHome: '/data/user' };
    mockBackgroundPassScopes.mockResolvedValueOnce([scope, user]);
    mockStartFinished.mockResolvedValueOnce({ kind: 'started', run: 'r1111111111111111', cwd: '/data/project' })
      .mockResolvedValueOnce({ kind: 'working', run: 'r2222222222222222', cwd: '/data/user' });
    mockSpawn.mockClear();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'the-agent-session');
    vi.stubEnv('TEAMAI_WORKFLOW_ATTEMPT', 'r3333333333333333/a00000001');

    try {
      await handler.execute({ cwd }, 'claude', scope);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mockBackgroundPassScopes).toHaveBeenCalledWith(cwd);
    expect(mockStartFinished.mock.calls.map(([config]) => config)).toEqual([scope, user]);
    expect(mockSpawn.mock.calls).toEqual([[process.execPath, [expect.any(String), 'workflow', 'resume', 'r1111111111111111', '--driver', 'local'], expect.objectContaining({ cwd: '/data/project', detached: true, stdio: 'ignore' })]]);
    const env: unknown = mockSpawn.mock.calls.at(0)?.at(2);
    expect(env).toMatchObject({ env: expect.not.objectContaining({ CLAUDE_CODE_SESSION_ID: expect.anything() }) });
    expect(env).toMatchObject({ env: expect.not.objectContaining({ TEAMAI_WORKFLOW_ATTEMPT: expect.anything() }) });
    expect(mockSettleLateUsageReport.mock.invocationCallOrder.at(-1)).toBeLessThan(mockStartFinished.mock.invocationCallOrder.at(0) ?? 0);
  });

  it('session-start pull starts teamai-finished-sessions awaiting the driver workflows.driver names, and drives it here only on a driver this machine runs', async () => {
    const handler = sessionStartPull();
    const user = { ...scope, dataHome: '/data/user' };
    mockBackgroundPassScopes.mockResolvedValueOnce([scope, user]);
    mockDriveByDefault.mockResolvedValueOnce({ kind: 'awaits', driver: 'acme-sandbox' }).mockResolvedValueOnce({ kind: 'unassigned' });
    mockStartFinished.mockResolvedValueOnce({ kind: 'started', run: 'r1111111111111111', cwd: '/data/project' })
      .mockResolvedValueOnce({ kind: 'started', run: 'r2222222222222222', cwd: '/data/user' });
    mockStartFinished.mockClear();
    mockSpawn.mockClear();
    vi.mocked(log.debug).mockClear();

    await handler.execute({ cwd: fs.realpathSync.native(os.tmpdir()) }, 'claude', scope);

    expect(mockStartFinished).toHaveBeenNthCalledWith(1, scope, expect.objectContaining({ awaits: { driver: 'acme-sandbox' } }));
    expect(mockStartFinished).toHaveBeenNthCalledWith(2, user, expect.not.objectContaining({ awaits: expect.anything() }));
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(log.debug).mock.calls.map(([said]) => said)).toContain(
      'hook-dispatch: r1111111111111111 waits for driver acme-sandbox, which this machine does not run. To drive it here: teamai workflow resume r1111111111111111 --driver local',
    );
  });

  it('session-start pull drives no run of teamai-finished-sessions that did not start, and says why only in debug output', async () => {
    const handler = sessionStartPull();
    mockBackgroundPassScopes.mockResolvedValueOnce([scope, { ...scope, dataHome: '/data/user' }]);
    mockStartFinished.mockResolvedValueOnce({ kind: 'failed', failure: { code: 'workflow_not_found', message: 'No workflow named teamai-finished-sessions.' } })
      .mockRejectedValueOnce(new Error('EACCES: permission denied'));
    mockSpawn.mockClear();
    vi.mocked(log.debug).mockClear();

    await handler.execute({ cwd: fs.realpathSync.native(os.tmpdir()) }, 'claude', scope);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(vi.mocked(log.debug).mock.calls.map(([said]) => said)).toEqual(expect.arrayContaining([
      'hook-dispatch: teamai-finished-sessions did not start: workflow_not_found: No workflow named teamai-finished-sessions.',
      'hook-dispatch: teamai-finished-sessions did not start: EACCES: permission denied',
    ]));
    expect(vi.mocked(log.warn)).not.toHaveBeenCalledWith(expect.stringContaining('teamai-finished-sessions'));
  });

  it('session-start pull reaches the scopes of the directory it runs in when the payload names none (#1179)', async () => {
    const handler = sessionStartPull();
    mockBackgroundPassScopes.mockResolvedValueOnce([]);

    await handler.execute({}, 'claude', scope);

    expect(mockBackgroundPassScopes).toHaveBeenLastCalledWith(process.cwd());
  });

  it('session-start pull starts nothing when no scope scores or publishes sessions (#1179)', async () => {
    const handler = sessionStartPull();
    mockSpawn.mockClear();
    mockStartFinished.mockClear();

    await handler.execute({ cwd: fs.realpathSync.native(os.tmpdir()) }, 'claude', scope);

    expect(mockStartFinished).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('session-start pull marks the session\'s captures when it delivers a new revision (#1178)', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-pull-')));
    const captureId = '0b6f2a52-5d7e-4c7e-9a43-6a3c1d0e2f12';
    const dir = path.join(root, 'data', 'sessions', 'captures', 'claude-code', 's-pull');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${captureId}.json`), JSON.stringify({
      captureId, platform: 'claude-code', sessionId: 's-pull', capturedAt: '2026-10-23T10:00:00.000Z',
      agent: { v: 1, tool: { name: 'claude' }, teamai: '0.0.0', driver: 'session' },
    }));
    const record = (rev: string) => ({ rev, targets: ['claude'] });
    mockDeliveringCheckoutRecord.mockResolvedValueOnce(record('a')).mockResolvedValueOnce(record('b'));
    const config: LocalConfig = { repo: { kind: 'git', localPath: root, remote: '' }, username: 'test', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
    const handler = buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'pull')?.handler;

    try {
      await handler?.execute({ session_id: 's-pull', cwd: root }, 'claude', config);
      expect(JSON.parse(fs.readFileSync(path.join(dir, `${captureId}.json`), 'utf8')).teamChanged).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('session-start pull seeds from workspace_roots when cwd is absent', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute({ workspace_roots: ['/tmp/cursor-project'] }, 'cursor', null);

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('cursor', '/tmp/cursor-project');
  });

  it('session-start pull prefers cwd over workspace_roots', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute(
      { cwd: '/from-cwd', workspace_roots: ['/from-roots'] },
      'claude', null,
    );

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('claude', '/from-cwd');
  });

  it('session-start pull runs nothing where the project config cannot be read (#784)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;
    mockFindUnreadableProjectConfig.mockResolvedValueOnce('/tmp/p/.teamai/config.yaml: bad indentation');

    await handler.execute({ session_id: 's-pull', cwd: '/tmp' }, 'claude', null);

    expect(mockFindUnreadableProjectConfig).toHaveBeenCalledWith('/tmp');
    expect(mockSeedProjectAgentRoot).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
    expect(mockStashPackageHint).not.toHaveBeenCalled();
  });

  it('stop has update, contribute-check, and dashboard-report handlers', () => {
    const registry = buildHandlerRegistry();
    const stopHandlers = registry
      .filter((r) => r.event === 'stop' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(stopHandlers).toContain('update');
    expect(stopHandlers).toContain('contribute-check');
    expect(stopHandlers).toContain('dashboard-report');
  });

  // Regression: handler used to hard-require stdin.session_id (returned null
  // otherwise) and derived it differently from dashboard-collector, leaving
  // sessionEvents empty. Now it uses the shared deriveSessionId helper.
  it('contribute-check handler derives session id even when stdin.session_id is missing', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    const originalEnv = process.env.CLAUDE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    try {
      const result = await handler.execute({ cwd: '/tmp/some-project' }, 'claude', null);
      expect(result).toBeNull();
      expect(mockContributeCheckForSession).toHaveBeenCalledOnce();
      const [sessionId, cwd] = mockContributeCheckForSession.mock.calls[0];
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
      // PID fallback embeds the cwd
      expect(sessionId).toContain('/tmp/some-project');
      expect(cwd).toBe('/tmp/some-project');
    } finally {
      if (originalEnv !== undefined) process.env.CLAUDE_SESSION_ID = originalEnv;
    }
  });

  it('contribute-check handler prefers explicit session_id when present', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    await handler.execute({ session_id: 'sid-abc', cwd: '/x' }, 'claude', null);
    // transcriptPath is the third arg; absent from this stdin so it is undefined.
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('sid-abc', '/x', undefined, false, undefined, null);
  });

  it('contribute-check handler forwards transcript_path so friction is read live', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    await handler.execute(
      { session_id: 'sid-abc', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude', null,
    );
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('sid-abc', '/x', '/t/transcript.jsonl', false, undefined, null);
  });

  it('contribute-check handler routes hint through formatStopHookOutput for cursor', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] hello' });

    const result = await handler.execute({ session_id: 's', cwd: '/x' }, 'cursor', null);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(String(result));
    expect(parsed.followup_message).toContain('[teamai] hello');
    // Cursor hides the payload, so the model is asked to pass it on.
    expect(parsed.followup_message).toContain('verbatim');
  });

  it('gives Claude the hint alone, with nothing telling the model to reprint it', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] hello' });

    const result = await handler.execute({ session_id: 's', cwd: '/x' }, 'claude', null);
    const parsed = JSON.parse(String(result));
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] hello');
  });

  it.each(['codebuddy', 'codex', 'codex-internal', 'tcodex', 'muse'])('contribute-check handler asks to stash (not stdout) for %s', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    // codebuddy stashes: contributeCheckForSession is called with stash=true and
    // returns hint:null (it persisted the hint as pendingHint itself).
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    const result = await handler.execute({ session_id: 's1', cwd: '/x' }, tool, null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('s1', '/x', undefined, true, undefined, null);
  });

  it('contribute-check handler returns stdout hint for claude (unchanged)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] do share' });

    const result = await handler.execute({ session_id: 's2', cwd: '/x' }, 'claude', null);
    expect(result).not.toBeNull();
    expect(result).toContain('do share');
    // claude is not a stash tool: called with stash=false.
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('s2', '/x', undefined, false, undefined, null);
  });

  it('contribute-check handler stays silent when the team turned the hint off', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { contributeHint: { enabled: false } } },
    });
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's3', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler honors a member override that re-enables the hint', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user', contributeHintEnabled: true },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { contributeHint: { enabled: false }, recall: { enabled: true } } },
    });
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] do share' });

    const result = await handler.execute({ session_id: 's4', cwd: '/x' }, 'claude', null);
    expect(result).toContain('do share');
  });

  it('contribute-check handler stays silent while recall is off, since `teamai skill get share` would refuse', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {} },
    });
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's3b', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler stays silent on a read-only HTTP source even with recall on', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { kind: 'http', localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { recall: { enabled: true } } },
    });
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's3c', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler stays silent when there is no config at all', async () => {
    // A project that never set up teamai has no team to share with (#748).
    const { NotInitializedError } = await import('../config.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    // A directory without teamai has no team to share with.
    mockAutoDetectInit.mockRejectedValueOnce(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's5', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler stays silent when the project config is unreadable, even if the user config loads', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    // Detection skips the broken project file and loads the user config (recall
    // on), but `teamai skill get share` refuses here, so the nudge would lead nowhere.
    mockFindUnreadableProjectConfig.mockResolvedValueOnce('/x/.teamai/config.yaml: bad indentation');
    mockContributeCheckForSession.mockClear();

    // An existing directory: a deleted one holds no project config to be unreadable.
    const result = await handler.execute({ session_id: 's5c', cwd: process.cwd() }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler asks the gate about the payload cwd, not the directory the process is in', async () => {
    // hook-dispatch changes into the payload cwd, but that can fail; the gate
    // must not then read wherever the process started.
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockFindUnreadableProjectConfig.mockImplementation(async (cwd?: string) =>
      cwd === undefined ? '/launcher/.teamai/config.yaml: bad indentation' : null);
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] do share' });
    try {
      const result = await handler.execute({ session_id: 's5e', cwd: process.cwd() }, 'claude', null);
      expect(result).toContain('do share');
    } finally {
      mockFindUnreadableProjectConfig.mockReset();
      mockFindUnreadableProjectConfig.mockResolvedValue(null);
    }
  });

  it('contribute-check handler withholds the reminder when the payload cwd exists but cannot be checked', async () => {
    // Only a cwd that is gone (ENOENT) falls back to the user config; one that
    // cannot be opened, here a path through a file (ENOTDIR), is unknown.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hook-cwd-'));
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockContributeCheckForSession.mockClear();
    try {
      const result = await handler.execute({ session_id: 's5f', cwd: path.join(file, 'sub') }, 'claude', null);
      expect(result).toBeNull();
      expect(mockContributeCheckForSession).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('contribute-check handler withholds the reminder, without failing the turn, when the gate itself faults', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { get repo(): never { throw new TypeError('a bug past the config load'); } },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { recall: { enabled: true } } },
    });
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's5d', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler stays silent when a config exists but cannot be loaded', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    // `teamai skill get share` refuses on such a config, so the nudge would lead nowhere.
    mockAutoDetectInit.mockRejectedValueOnce(new Error('Team config (teamai.yaml) not found. Check your repo path.'));
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's5b', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler obeys TEAMAI_CONTRIBUTE_HINT_DISABLED=1', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    const previous = process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED;
    process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED = '1';
    mockContributeCheckForSession.mockClear();
    try {
      const result = await handler.execute({ session_id: 's6', cwd: '/x' }, 'claude', null);
      expect(result).toBeNull();
      expect(mockContributeCheckForSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED;
      else process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED = previous;
    }
  });

  it('pending-hint handler drops (consumes but hides) a stashed hint when the team turned the hint off', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { contributeHint: { enabled: false } } },
    });
    mockTakePendingHint.mockResolvedValueOnce('[teamai] stashed');

    const result = await handler.execute({ session_id: 's7', cwd: '/x' }, 'codebuddy', scope);
    // The stash is consumed (so it is not delivered later) but not shown.
    expect(mockTakePendingHint).toHaveBeenCalledWith(expect.any(String));
    expect(result).toBeNull();
  });

  it.each(['codebuddy', 'codex', 'muse'])('pending-hint handler injects stashed hint for %s on prompt-submit', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce('[teamai] stashed');

    const result = await handler.execute({ session_id: 's3', cwd: '/x' }, tool, scope);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(String(result));
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] stashed');
  });

  it('package-pending-hint checks package hints for claude', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'package-pending-hint',
    )!.handler;

    const result = await handler.execute({ session_id: 's4', cwd: '/x' }, 'claude', null);
    expect(result).toBeNull();
    expect(mockTakePendingHint).not.toHaveBeenCalled();
    expect(mockTakePendingPackageHint).toHaveBeenCalledWith('s4');
  });

  it('pending-hint handler returns null when no pending hint', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce(null);

    const result = await handler.execute({ session_id: 's5', cwd: '/x' }, 'codebuddy', null);
    expect(result).toBeNull();
  });

  it('delivers a post-pull package hint on prompt-submit for Claude', async () => {
    mockTakePendingPackageHint.mockResolvedValue('Run `teamai packages`');
    const handler = buildHandlerRegistry().find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'package-pending-hint',
    )!.handler;

    const output = await handler.execute({ session_id: 's6', cwd: '/x' }, 'claude', null);

    expect(JSON.parse(String(output)).hookSpecificOutput.additionalContext)
      .toBe('Run `teamai packages`');
  });

  it('post-tool-use wildcard has dashboard-report', () => {
    const registry = buildHandlerRegistry();
    const wildcardHandlers = registry
      .filter((r) => r.event === 'post-tool-use' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(wildcardHandlers).toContain('dashboard-report');
  });

  it('post-tool-use tracks skill use on the wildcard pass, detached, with no Skill matcher (#1221)', () => {
    const registry = buildHandlerRegistry();
    expect(registry.filter((r) => r.event === 'post-tool-use' && r.matcher === 'Skill')).toEqual([]);
    const skillUse = registry.find((r) => r.event === 'post-tool-use' && r.handler.name === 'skill-use');
    expect(skillUse).toMatchObject({ matcher: '*', background: true, requiresConfig: true });
  });

  // Perf regression: post-tool-use fires on every tool call, so its local-agent
  // report/sync (two HTTP round-trips) must run detached — never in the
  // foreground where it stalls the host's hook completion by ~300ms–seconds
  // depending on network latency. Mirrors the `stop` event, which already
  // backgrounds local-agent-sync.
  it('post-tool-use wildcard local-agent-sync is a background handler', () => {
    const registry = buildHandlerRegistry();
    const localAgent = registry.find(
      (r) => r.event === 'post-tool-use' && r.matcher === '*' && r.handler.name === 'local-agent-sync',
    );
    expect(localAgent).toBeDefined();
    expect(localAgent!.background).toBe(true);
  });

  // post-tool-use dashboard-report runs detached (#1216): the old "fast local
  // append, detaching adds spawn overhead" premise is platform-dependent — on
  // Windows (Defender, disk contention) the same append measured 3.8 s inside
  // the host's 10 s hook budget, and hooks were killed outright. The spawn
  // already exists (local-agent-sync below is background), so moving this into
  // the detached child adds no process and removes its runtime from the
  // host-visible path.
  it('post-tool-use wildcard dashboard-report runs detached (#1216)', () => {
    const registry = buildHandlerRegistry();
    const dashboard = registry.find(
      (r) => r.event === 'post-tool-use' && r.matcher === '*' && r.handler.name === 'dashboard-report',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.background).toBe(true);
  });

  // prompt-submit local-agent-sync must NOT be backgrounded: when the org
  // binding prompt is enabled (TEAMAI_BIND_PROMPT_ENABLED=1) it writes the
  // binding hint to STDOUT for the host to inject back into the session, and a
  // detached child's STDOUT is discarded. Guards against a copy-paste of the
  // post-tool-use change onto prompt-submit.
  it('prompt-submit wildcard local-agent-sync stays foreground', () => {
    const registry = buildHandlerRegistry();
    const localAgent = registry.find(
      (r) => r.event === 'prompt-submit' && r.matcher === '*' && r.handler.name === 'local-agent-sync',
    );
    expect(localAgent).toBeDefined();
    expect(localAgent!.background).not.toBe(true);
  });

  // Regression: foreground local-agent-sync runs inline and blocks the host's
  // hook. Its timeout MUST stay safely under CodeBuddy's per-event hook cap
  // (see builtin-hooks.ts: UserPromptSubmit=10s, SessionStart=15s). Otherwise a
  // slow/unreachable HTTP endpoint makes CodeBuddy abort the hook with
  // "Hook timed out after 10000ms" (error 3003) on every prompt — breaking the
  // IDE for anyone who installed `teamai init --http`.
  it('foreground local-agent-sync timeouts are unified under 5s', () => {
    const registry = buildHandlerRegistry();
    const promptSubmit = registry.find(
      (r) => r.event === 'prompt-submit' && r.matcher === '*' && r.handler.name === 'local-agent-sync',
    );
    const sessionStart = registry.find(
      (r) => r.event === 'session-start' && r.matcher === '*' && r.handler.name === 'local-agent-sync',
    );
    // Kept < 5s (and unified) so a slow/unreachable HTTP endpoint never blocks the
    // IDE long enough to trip CodeBuddy's per-event hook cap (error 3003).
    expect(promptSubmit!.timeoutMs).toBeLessThan(5_000);
    expect(sessionStart!.timeoutMs).toBeLessThan(5_000);
    expect(promptSubmit!.timeoutMs).toBe(sessionStart!.timeoutMs);
  });

  it('post-tool-use Bash/Grep/WebSearch/WebFetch have no registered handlers', () => {
    const registry = buildHandlerRegistry();
    for (const matcher of ['Bash', 'Grep', 'WebSearch', 'WebFetch']) {
      const handlers = registry.filter((r) => r.event === 'post-tool-use' && r.matcher === matcher);
      expect(handlers).toHaveLength(0);
    }
  });

  it('prompt-submit has skill-mention and dashboard-report', () => {
    const registry = buildHandlerRegistry();
    const handlers = registry
      .filter((r) => r.event === 'prompt-submit' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(handlers).toContain('skill-mention');
    expect(handlers).toContain('dashboard-report');
  });

  it('all handlers have timeoutMs set', () => {
    const registry = buildHandlerRegistry();
    for (const reg of registry) {
      expect(reg.timeoutMs).toBeGreaterThan(0);
    }
  });

  // CodeBuddy aborts a hook at ~10s regardless of the declared timeout (even
  // Stop/SessionStart, declared 15s, are killed at 10000ms). Every foreground
  // (inline, blocking) handler must therefore stay well under that ceiling —
  // unified at <5s — so a slow/unreachable endpoint can never trip the host
  // timeout on any event. Background (detached) handlers are not awaited by the
  // host, so they may keep longer budgets. Git's own events (git-hook.ts) run
  // under git, which has no hook timeout.
  it('every foreground handler timeout is under 5s', () => {
    const registry = buildHandlerRegistry();
    const gitEvents: readonly string[] = GIT_HOOK_EVENTS;
    const foreground = registry.filter((r) => r.background !== true && !gitEvents.includes(r.event));
    expect(foreground.length).toBeGreaterThan(0);
    for (const reg of foreground) {
      expect(reg.timeoutMs).toBeLessThan(5_000);
    }
  });

  it('TodoWrite hint keeps the budget of the 3s entry it had before it joined the wildcard pass (#1788)', () => {
    const registry = buildHandlerRegistry();
    const todo = registry.find(
      (r) => r.event === 'post-tool-use' && r.handler.name === 'todowrite-hint',
    );
    expect(todo?.matcher).toBe('*');
    expect(todo?.timeoutMs).toBeLessThan(3_000);
  });

  it('marks contribute-check, mr-hint, votes-sync and votes-push as gitOnly', () => {
    const registry = buildHandlerRegistry();
    const gitOnly = registry.filter((r) => r.gitOnly === true).map((r) => r.handler.name);
    expect(gitOnly).toContain('contribute-check');
    expect(gitOnly).toContain('mr-hint');
    expect(gitOnly).toContain('mr-hint-stash');
    expect(gitOnly).toContain('votes-sync');
    expect(gitOnly).toContain('votes-push');
  });

  it('filterHandlersForConfig drops gitOnly handlers for http source', () => {
    const registry = buildHandlerRegistry();
    const filtered = filterHandlersForConfig(registry, { repo: { kind: 'http' } } as never);
    const names = filtered.map((r) => r.handler.name);
    expect(names).not.toContain('contribute-check');
    expect(names).not.toContain('mr-hint');
    expect(names).not.toContain('votes-sync');
    // Non-git-only handlers survive
    expect(names).toContain('pull');
    expect(names).toContain('package-hint');
    expect(names).toContain('package-pending-hint');
    expect(names).toContain('local-agent-sync');
  });

  it('filterHandlersForConfig keeps all handlers for git source', () => {
    const registry = buildHandlerRegistry();
    const full = registry.length;
    expect(filterHandlersForConfig(registry, { repo: { kind: 'git' } } as never).length).toBe(full);
    expect(filterHandlersForConfig(registry, { repo: {} } as never).length).toBe(full);
  });

  // The background pass of a tool call or a prompt outside any scope exits before running handlers unless the machine
  // syncs over HTTP (#1788), which is only behaviour-preserving while the local agent is all that is left to run there.
  it.each(['post-tool-use', 'prompt-submit'])('leaves %s no background handler but the HTTP local agent\'s where teamai is not set up', (event) => {
    const background = filterHandlersForConfig(buildHandlerRegistry(), null).filter((reg) => reg.event === event && reg.background === true);

    expect(background.map((reg) => reg.handler.name).filter((name) => name !== 'local-agent-sync')).toEqual([]);
  });

  it('filterHandlersForConfig drops the share nudge where teamai is not set up (#748)', () => {
    const names = filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name);
    expect(names).not.toContain('contribute-check');
  });

  it('only machine-level handlers run where teamai is not set up (#748)', () => {
    // A new handler must decide: team handlers set requiresConfig, the rest join this list.
    const names = new Set(filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name));
    expect([...names].sort()).toEqual([
      'http-prompt-instructions',
      'local-agent-sync',
      'package-pending-hint',
      'pull',
      'update',
    ]);
  });

  it('TodoWrite gets no recall nudge where teamai is not set up (#748)', async () => {
    const registry = buildHandlerRegistry();
    expect(registry.some((r) => r.matcher === '*' && r.handler.name === 'todowrite-hint')).toBe(true);
    const dispatcher = createDispatcher({ handlers: filterHandlersForConfig(registry, null), localConfig: null });

    const result = await dispatcher.dispatch(
      'post-tool-use', '*', { session_id: 'td-748', tool_name: 'TodoWrite' }, 'claude', 'foreground',
    );
    expect(result.output).toBeNull();
  });

  // ── adopted-knowledge summary: show the user what was actually used ──

  it('votes-sync prints an adopted-knowledge summary when a recalled doc was opened', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    // Tool-use adoption → show the summary of what was actually used.
    mockCreditAdoptedDocs.mockResolvedValue({ credited: ['doc-a'], recalled: 2 });

    const result = await handler.execute({ session_id: 'sid-adopt-1', cwd: '/x' }, 'claude', scope);
    expect(result).not.toBeNull();
    expect(result).toContain('Adopted team knowledge this session');
    expect(result).toContain('doc-a');
    // Only the adopted doc is listed, not every recalled candidate.
    expect(result).not.toContain('doc-b');
  });

  it('votes-sync does NOT print a summary when nothing was adopted', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    // recalled>0 but no adoption evidence → nothing to report, stay silent.
    mockCreditAdoptedDocs.mockResolvedValue({ credited: [], recalled: 1 });

    const result = await handler.execute({ session_id: 'sid-adopt-3', cwd: '/x' }, 'claude', scope);
    expect(result).toBeNull();
  });

  it('votes-sync stays quiet when the votes file was busy', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockCreditAdoptedDocs.mockResolvedValue({ credited: null, recalled: 1 });

    const result = await handler.execute({ session_id: 'sid-adopt-4', cwd: '/x' }, 'claude', scope);
    expect(result).toBeNull();
  });

  // ── upvote from tool-use adoption only ──

  it('votes-sync credits the dispatch session\'s adoption from the recall log, with no transcript (#884)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockCreditAdoptedDocs.mockResolvedValue({ credited: ['doc-a'], recalled: 2 });

    const result = await handler.execute({ session_id: 'sid-adopt-1', cwd: '/x' }, 'claude', scope);

    expect(mockCreditAdoptedDocs).toHaveBeenCalledWith(scope, 'sid-adopt-1');
    expect(result).toContain('Adopted team knowledge this session');
  });

  it('votes-push skips updateReports when there are no pending vote deltas', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-push',
    )!.handler;

    reportsBranchMocks.updateReports.mockClear();
    await handler.execute(
      { session_id: 'sid-skip-reports', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude', scope,
    );
    expect(reportsBranchMocks.updateReports).not.toHaveBeenCalled();
  });

  // A fetch and a push to a remote a few seconds away do not fit the 4.5 s
  // foreground budget: the dispatcher's exit then cut the push and left the
  // vote commit unpushed, on every Stop until a pull carried it.
  it('votes-sync leaves pending votes to the detached pass instead of pushing inline', async () => {
    const handler = buildHandlerRegistry().find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;
    voteMocks.hasPendingVoteDeltas.mockResolvedValue(true);

    try {
      await handler.execute({ session_id: 'sid-inline-push', cwd: '/x' }, 'claude', scope);
    } finally {
      voteMocks.hasPendingVoteDeltas.mockResolvedValue(false);
    }

    expect(reportsBranchMocks.updateReports).not.toHaveBeenCalled();
  });

  it('votes-push runs detached at Stop and SessionEnd, with more time than the foreground cap', () => {
    const registry = buildHandlerRegistry();

    for (const event of ['stop', 'session-end']) {
      const reg = registry.find((r) => r.event === event && r.handler.name === 'votes-push');
      expect(reg).toMatchObject({ background: true, gitOnly: true, requiresConfig: true });
      expect(reg!.timeoutMs).toBeGreaterThan(4_500);
    }
  });

  it('votes-push writes votes through updateReports when deltas are pending', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-push',
    )!.handler;

    const syncedDeltas = { 'doc-a': { recalled_delta: 0, upvoted_delta: 1 } };
    voteMocks.hasPendingVoteDeltas.mockResolvedValueOnce(true);
    voteMocks.stageVotesMerge.mockResolvedValueOnce({ syncedDeltas });
    voteMocks.confirmVotesSynced.mockClear();
    reportsBranchMocks.updateReports.mockClear();
    reportsBranchMocks.readReportsOriginFile.mockResolvedValueOnce(null);
    reportsBranchMocks.updateReports.mockImplementationOnce(
      async (
        _cfg: unknown,
        write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<unknown>,
      ) => {
        const delivered: (() => Promise<void>)[] = [];
        const change = await write('/wt', { onDelivered: (fn) => { delivered.push(fn); } });
        // The staged write is what the branch publishes, and the deltas are
        // cleared only after delivery (#1027): the confirm hook runs here.
        expect(change).toEqual({
          files: ['votes/test.yaml'],
          message: '[teamai] Update votes for test',
        });
        for (const fn of delivered) await fn();
        return { status: 'published' };
      },
    );

    await handler.execute(
      { session_id: 'sid-write-reports', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude', scope,
    );

    expect(reportsBranchMocks.updateReports).toHaveBeenCalledOnce();
    // The merge base is origin's snapshot, not the worktree copy (#1027).
    expect(voteMocks.stageVotesMerge).toHaveBeenCalledWith('/wt', 'test', expect.any(String), null);
    expect(voteMocks.confirmVotesSynced).toHaveBeenCalledWith(expect.any(String), syncedDeltas);
  });

  it('votes-push keeps the deltas pending when the reports push is not delivered (#1027)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-push',
    )!.handler;

    voteMocks.hasPendingVoteDeltas.mockResolvedValueOnce(true);
    voteMocks.stageVotesMerge.mockResolvedValueOnce({ syncedDeltas: {} });
    voteMocks.confirmVotesSynced.mockClear();
    reportsBranchMocks.readReportsOriginFile.mockResolvedValueOnce(null);
    reportsBranchMocks.updateReports.mockImplementationOnce(
      async (
        _cfg: unknown,
        write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<unknown>,
      ) => {
        await write('/wt', { onDelivered: () => {} });
        // Push failed after its retries: delivery never confirmed.
        return { status: 'failed', reason: 'push did not land' };
      },
    );

    await handler.execute(
      { session_id: 'sid-push-failed', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude', scope,
    );

    expect(voteMocks.stageVotesMerge).toHaveBeenCalledOnce();
    // Not delivered → the deltas are NOT cleared; the next Stop retries them.
    expect(voteMocks.confirmVotesSynced).not.toHaveBeenCalled();
  });

  // ── votes-sync adopted-summary is skipped for stdout-less tools ──

  it.each(['codebuddy', 'codex'])('votes-sync stays silent (no summary) for %s whose Stop stdout is ignored', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    // Adoption happened, but the summary is a user-facing note we do not route
    // through the model context of stdout-less tools.
    mockCreditAdoptedDocs.mockResolvedValue({ credited: ['doc-b'], recalled: 1 });

    const result = await handler.execute({ session_id: 'sid-votes-stash', cwd: '/x' }, tool, scope);
    expect(result).toBeNull();
    // The upvote is still recorded.
    expect(mockCreditAdoptedDocs).toHaveBeenCalledWith(scope, 'sid-votes-stash');
  });

  it('votes-sync returns the adopted summary via stdout for claude', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockCreditAdoptedDocs.mockResolvedValue({ credited: ['doc-c'], recalled: 1 });

    const result = await handler.execute({ session_id: 'sid-votes-stdout', cwd: '/x' }, 'claude', scope);
    expect(result).not.toBeNull();
    expect(result).toContain('doc-c');
  });

  it('stop dispatcher merges the adopted summary and the contribute hint', async () => {
    mockCreditAdoptedDocs.mockResolvedValue({ credited: ['doc-a'], recalled: 1 });
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: 'CONTRIBUTE-HINT' });
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });

    const result = await dispatcher.dispatch(
      'stop',
      '*',
      { session_id: 'sid-merged-stop', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
      'foreground',
    );

    const context = JSON.parse(result.output!).hookSpecificOutput.additionalContext;
    expect(context).toContain('doc-a');
    expect(context).toContain('CONTRIBUTE-HINT');
  });

  it('pending-hint returns null when no contribute hint is pending', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce(null);

    const result = await handler.execute({ session_id: 'sid-both-absent', cwd: '/x' }, 'codebuddy', scope);
    expect(result).toBeNull();
  });
});

// End-to-end: wire the real handler registry through the real dispatcher and
// assert the foreground/background split that actually governs host latency.
// The registry declares `background: true`; the dispatcher must honor it by
// keeping local-agent-sync OUT of the foreground pass (so the host's hook
// returns without waiting on the two HTTP round-trips) while still running it
// in the detached background pass (so report/sync are not silently dropped).
describe('post-tool-use dispatch — local-agent runs detached, never blocks host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const stdin = { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp/proj' };

  it('hasBackground is true for the post-tool-use wildcard', () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    expect(dispatcher.hasBackground('post-tool-use', '*')).toBe(true);
  });

  it('foreground pass does NOT invoke local-agent-sync (host is not blocked on HTTP)', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'foreground');
    expect(mockReportAndSyncFromHook).not.toHaveBeenCalled();
  });

  it('background pass DOES invoke local-agent-sync (report/sync still happen)', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'background');
    expect(mockReportAndSyncFromHook).toHaveBeenCalledOnce();
  });

  it('the background pass runs dashboard-report; a plain tool call leaves the foreground pass empty (#1216)', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'foreground');
    // dashboard-report and recall-attribution moved to the detached pass: the
    // inline pass for a plain tool call runs no handlers at all, so the host
    // waits only for bundle load + spawn.
    expect(mockParseHookEvent).not.toHaveBeenCalled();
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'background');
    expect(mockParseHookEvent).toHaveBeenCalled();
  });
});

describe('a checkout no pull delivered into (#1424)', () => {
  let root: string;
  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'new-checkout-')));
    mockDeliveringCheckoutRecord.mockResolvedValue(undefined);
    // A linked worktree: its `.git` file names a git dir holding `commondir`.
    fs.mkdirSync(path.join(root, 'project'));
    fs.mkdirSync(path.join(root, 'repo.git', 'worktrees', 'project'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repo.git', 'worktrees', 'project', 'commondir'), '../..\n');
    fs.writeFileSync(path.join(root, 'project', '.git'), `gitdir: ${path.join(root, 'repo.git', 'worktrees', 'project')}\n`);
  });
  afterEach(() => {
    mockDeliveringCheckoutRecord.mockResolvedValue({ rev: 'abc', targets: [] });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const projectConfig = (kind: 'git' | 'http'): LocalConfig => ({
    repo: { kind, localPath: path.join(root, 'team'), remote: '' }, username: 'test', scope: 'project',
    additionalRoles: [], dataHome: path.join(root, 'data'), projectRoot: path.join(root, 'project'),
  });
  const toolUse = (config: LocalConfig) => createDispatcher({ handlers: buildHandlerRegistry(), localConfig: config })
    .dispatch('post-tool-use', '*', { tool_name: 'EnterWorktree', cwd: path.join(root, 'project') }, 'claude', 'background');

  it('prepares it from the team clone as last fetched', async () => {
    await toolUse(projectConfig('git'));

    expect(mockPull).toHaveBeenCalledWith({ silent: true, prepareCheckout: 'once', inline: true, localOnly: true });
  });

  it('prepares nothing in a main checkout, where init runs', async () => {
    fs.rmSync(path.join(root, 'project', '.git'));
    fs.mkdirSync(path.join(root, 'project', '.git'));

    await toolUse(projectConfig('git'));

    expect(mockPull).not.toHaveBeenCalled();
  });

  it('prepares nothing in a submodule or a --separate-git-dir checkout, whose git dir holds no commondir', async () => {
    fs.rmSync(path.join(root, 'repo.git', 'worktrees', 'project', 'commondir'));

    await toolUse(projectConfig('git'));

    expect(mockPull).not.toHaveBeenCalled();
  });

  it('prepares nothing for an HTTP team, whose checkouts keep no delivery record', async () => {
    await toolUse(projectConfig('http'));

    expect(mockPull).not.toHaveBeenCalled();
  });

  it('git\'s hook for a new worktree hands the pull it starts after git returns the checkout to prepare', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: projectConfig('git') });

    await dispatcher.dispatch('post-checkout', '*', {
      cwd: path.join(root, 'project'), hook_event_name: 'post-checkout', git_args: ['0'.repeat(40), 'a'.repeat(40), '1'],
    }, 'git');

    expect(mockSpawn).toHaveBeenCalledWith(process.execPath, [expect.any(String), 'pull', '--silent'], expect.objectContaining({
      env: expect.objectContaining({ TEAMAI_GIT_HOOK: 'post-checkout', TEAMAI_PREPARE_CHECKOUT: 'once' }),
    }));
  });

  it('a session start still pulls when the tool roots cannot be created', async () => {
    mockCreateProjectToolRoots.mockRejectedValueOnce(new Error('EACCES'));
    const handler = buildHandlerRegistry().find((r) => r.event === 'session-start' && r.handler.name === 'pull')?.handler;

    await handler?.execute({ session_id: 's-roots', cwd: path.join(root, 'project') }, 'claude', projectConfig('git'));

    expect(mockPull).toHaveBeenCalledWith({ silent: true, prepareCheckout: 'once', sessionStart: true });
  });
});

describe('session-start team env hint (#875, #1018)', () => {
  let teamRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    teamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-secrets-hint-'));
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\n');
    const sessionStart = (context: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
    mockClaimPackageHint.mockResolvedValueOnce(sessionStart('Package context'));
  });

  afterEach(() => {
    fs.rmSync(teamRepo, { recursive: true, force: true });
  });

  async function sessionContext(): Promise<string[]> {
    const localConfig: LocalConfig = { ...scope, repo: { localPath: teamRepo, remote: '' } };
    const dispatcher = createDispatcher({ handlers: filterHandlersForConfig(buildHandlerRegistry(), localConfig), localConfig });
    const result = await dispatcher.dispatch('session-start', '*', { session_id: 'sid-secrets', cwd: teamRepo }, 'claude', 'foreground');
    expect(result.errors).toEqual([]);
    return (JSON.parse(result.output ?? '{}').hookSpecificOutput.additionalContext as string).split('\n');
  }

  it('tells the agent once which secrets the scope declares and to run their CLIs through env exec', async () => {
    fs.mkdirSync(path.join(teamRepo, 'env'));
    fs.writeFileSync(path.join(teamRepo, 'env', 'secrets.yaml'), [
      'secrets:',
      '  - { key: GITHUB_TOKEN, description: "gh and the github MCP server" }',
      '  - { key: SENTRY_AUTH_TOKEN }',
      '',
    ].join('\n'));

    const lines = await sessionContext();

    const secretLines = lines.filter((line) => line.includes('GITHUB_TOKEN'));
    expect(secretLines).toHaveLength(1);
    expect(secretLines[0]).toContain('GITHUB_TOKEN (gh and the github MCP server)');
    expect(secretLines[0]).toContain('SENTRY_AUTH_TOKEN');
    expect(secretLines[0]).toContain('teamai env exec --');
    expect(secretLines[0]).toContain('teamai env set KEY');
    expect(lines.filter((line) => line !== secretLines[0])).toEqual(['Package context']);
  });

  it('names the scope\'s env variables and env exec when it delivers variables but no secrets (#1018)', async () => {
    fs.mkdirSync(path.join(teamRepo, 'env'));
    fs.writeFileSync(path.join(teamRepo, 'env', 'env.yaml'), 'variables:\n  - key: API_URL\n    value: https://api.example\n');

    const lines = await sessionContext();

    const envLines = lines.filter((line) => line.includes('API_URL'));
    expect(envLines).toHaveLength(1);
    expect(envLines[0]).toContain('teamai env exec --');
    expect(envLines[0]).not.toContain('teamai env set KEY');
  });

  it('includes inherited user variables in the hint through the shared env resolution', async () => {
    const userRepo = path.join(teamRepo, 'user-team');
    fs.mkdirSync(path.join(userRepo, 'env'), { recursive: true });
    fs.writeFileSync(path.join(userRepo, 'teamai.yaml'), 'team: acme\nrepo: https://example.test/acme/team.git\n');
    fs.writeFileSync(path.join(userRepo, 'env', 'env.yaml'), 'variables:\n  - key: USER_ONLY\n    value: inherited\n');
    const { loadLocalConfigForScope } = await import('../config.js');
    vi.mocked(loadLocalConfigForScope).mockResolvedValueOnce({
      ...scope, scope: 'user', repo: { localPath: userRepo, remote: '' },
    });
    const projectConfig: LocalConfig = {
      ...scope, scope: 'project', inheritUserScope: true, projectRoot: teamRepo, repo: { localPath: teamRepo, remote: '' },
    };
    const dispatcher = createDispatcher({ handlers: filterHandlersForConfig(buildHandlerRegistry(), projectConfig), localConfig: projectConfig });
    const result = await dispatcher.dispatch('session-start', '*', { session_id: 'sid-inherited', cwd: teamRepo }, 'claude', 'foreground');

    expect(result.errors).toEqual([]);
    expect(result.output).toContain('Team env variables in this scope: USER_ONLY.');
  });

  it('adds nothing when the scope delivers no env', async () => {
    expect(await sessionContext()).toEqual(['Package context']);
  });

  it('adds nothing when the secrets file cannot be read', async () => {
    fs.mkdirSync(path.join(teamRepo, 'env'));
    fs.writeFileSync(path.join(teamRepo, 'env', 'secrets.yaml'), 'secrets: [\n');

    expect(await sessionContext()).toEqual(['Package context']);
  });

  it('is a foreground team handler, so a directory without teamai never gets the line', () => {
    const registration = buildHandlerRegistry().find((r) => r.handler.name === 'team-env-hint');
    expect(registration).toMatchObject({ event: 'session-start', matcher: '*', requiresConfig: true });
    expect(registration?.background).not.toBe(true);
    expect(filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name)).not.toContain('team-env-hint');
  });
});

describe('dashboard-report team correction keywords', () => {
  const handler = () => buildHandlerRegistry().find(
    (r) => r.event === 'prompt-submit' && r.handler.name === 'dashboard-report',
  )!.handler;
  let teamRepo: string;

  beforeEach(() => {
    mockParseHookEvent.mockClear();
    teamRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-keywords-'));
  });

  afterEach(() => {
    fs.rmSync(teamRepo, { recursive: true, force: true });
  });

  const scopeWithTeam = (): LocalConfig => ({ ...scope, repo: { localPath: teamRepo, remote: '' } });

  it('passes the scope\'s sharing.intervention.correctionKeywords to parseHookEvent on prompt hooks', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'),
      'team: test\nrepo: r\nsharing:\n  intervention:\n    correctionKeywords: [rehazlo]\n');
    await handler().execute({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'rehazlo' }, 'claude', scopeWithTeam());
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: ['rehazlo'], dataHomeKey: 'key' });
  });

  it('falls back to built-in keywords only when the scope\'s team config cannot be read', async () => {
    await handler().execute({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'wrong' }, 'claude', scopeWithTeam());
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: [], dataHomeKey: 'key' });
  });

  it('uses no team keywords for hooks without a prompt', async () => {
    fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'),
      'team: test\nrepo: r\nsharing:\n  intervention:\n    correctionKeywords: [rehazlo]\n');
    await handler().execute({ hook_event_name: 'Stop', session_id: 's' }, 'claude', scopeWithTeam());
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: [], dataHomeKey: 'key' });
  });

  it("prices a stop with the model aliases of the hook's own scope", async () => {
    const workspace: LocalConfig = { ...scopeWithTeam(), scope: 'project', projectRoot: teamRepo, modelAliases: { 'gw-sonnet': 'claude-sonnet-4' } };
    await handler().execute({ hook_event_name: 'Stop', session_id: 's' }, 'claude', workspace);
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: [], modelAliases: { 'gw-sonnet': 'claude-sonnet-4' }, dataHomeKey: 'key' });
  });
});

// Regression #702 (event mapping) + #701 (field whitelist). The handler used to
// read stdin.event (never sent by hosts) → every event forwarded as `unknown`,
// and forwarded the entire stdin (tool args + tool_response) as `data`.
describe('webhook-dispatch handler (#701, #702)', () => {
  const handler = () => buildHandlerRegistry().find(
    (r) => r.handler.name === 'webhook-dispatch',
  )!.handler;
  const skillUse = () => buildHandlerRegistry().find(
    (r) => r.handler.name === 'skill-use',
  )!.handler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWebhookConfig.mockResolvedValue({
      enabled: true,
      endpoints: [{ url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 3 }],
    });
  });

  it('sends skill-use for a Skill call and forwards only the skill name (#701, #702)', async () => {
    await skillUse().execute(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'demo', args: 'api_key=SYNTHETIC_SECRET_NOT_REAL' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
      },
      'claude', scope,
    );

    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [event, payload] = mockSendWebhook.mock.calls[0];
    expect(event).toBe('skill-use');
    expect(payload.data).toEqual({ skillName: 'demo' });
    // The raw tool args and tool_response must never be forwarded.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('SYNTHETIC_SECRET_NOT_REAL');
    expect(serialized).not.toContain('SYNTHETIC_PRIVATE_OUTPUT');
  });

  it('maps SessionStart to session-start (#702)', async () => {
    await handler().execute({ hook_event_name: 'SessionStart', session_id: 'sid' }, 'claude', scope);
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-start');
  });

  it('maps Stop to session-stop (#702)', async () => {
    await handler().execute({ hook_event_name: 'Stop', session_id: 'sid' }, 'claude', scope);
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-stop');
  });

  it('never emits an "unknown" event for an unmapped hook (#702)', async () => {
    await handler().execute({ hook_event_name: 'PreToolUse', session_id: 'sid' }, 'claude', scope);
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  // Codex review finding 1: hosts that send camelCase hook names (Cursor/
  // CodeBuddy) were silently dropped by the PascalCase-only lookup.
  it('maps camelCase sessionStart to session-start (#702, camelCase host)', async () => {
    await handler().execute({ hook_event_name: 'sessionStart', session_id: 'sid' }, 'cursor', scope);
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-start');
  });

  // Codex review finding 9: Cursor represents skill use as a `Read` of a
  // SKILL.md file (tool_name: 'Read'), NOT a `Skill` tool — and it dispatches
  // via the camelCase `postToolUse` event. The webhook comes from the handler
  // that records the use, so the two cannot disagree.
  it('sends skill-use for a Cursor camelCase postToolUse Read of SKILL.md (#702, #9)', async () => {
    await skillUse().execute(
      {
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
      },
      'cursor', scope,
    );
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [event, payload] = mockSendWebhook.mock.calls[0];
    expect(event).toBe('skill-use');
    expect(payload.data).toEqual({ skillName: 'tdd' });
    expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_PRIVATE_OUTPUT');
  });

  it('sends no webhook for a normal (non-SKILL.md) Read (#9 guard)', async () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { path: '/root/project/src/secrets.ts' },
      tool_response: 'const API_KEY = "SYNTHETIC_SECRET_NOT_REAL";',
    };
    await skillUse().execute(payload, 'cursor', scope);
    await handler().execute(payload, 'cursor', scope);
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  // Codex review finding 2: Copilot fires SessionEnd (not Stop); the handler
  // must be registered on session-end and map it to session-stop.
  it('registers webhook-dispatch on the session-end event (#702, Copilot)', () => {
    const sessionEndWebhook = buildHandlerRegistry().find(
      (r) => r.event === 'session-end' && r.matcher === '*' && r.handler.name === 'webhook-dispatch',
    );
    expect(sessionEndWebhook).toBeDefined();
    expect(sessionEndWebhook!.background).toBe(true);
  });

  it('maps SessionEnd to session-stop (#702, Copilot)', async () => {
    await handler().execute({ hook_event_name: 'SessionEnd', session_id: 'sid' }, 'copilot', scope);
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-stop');
  });

  // Codex review finding 3: an extracted skillName that fails isValidSkillName
  // (e.g. a path-like `command` arg) is no skill use, so nothing is sent.
  it('sends nothing for an invalid skillName (#701)', async () => {
    await skillUse().execute(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { command: '/etc/passwd; rm -rf /' },
      },
      'claude', scope,
    );

    expect(mockSendWebhook).not.toHaveBeenCalled();
  });
});

// Codex review finding 12: the tests above call handler.execute() directly,
// bypassing dispatcher routing. These drive the REAL dispatcher on the
// wildcard post-tool-use pass, the one every tool installs (#1221), to prove a
// Read payload routes through it to the skill-use webhook. skill-use is
// background: true, so it runs in the 'background' dispatch pass. (Cursor's own
// runtime is external and not testable in this repo; this covers the CLI-side
// routing that is.)
describe('post-tool-use wildcard dispatch routes Cursor SKILL.md Read to the webhook (#702, #9, #12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWebhookConfig.mockResolvedValue({
      enabled: true,
      endpoints: [{ url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 3 }],
    });
  });

  it('registers no webhook-dispatch on post-tool-use: skill-use sends it', () => {
    expect(buildHandlerRegistry().filter(
      (r) => r.event === 'post-tool-use' && r.handler.name === 'webhook-dispatch',
    )).toEqual([]);
  });

  it('a Cursor Read of SKILL.md on the wildcard pass produces a skill-use webhook with {skillName}', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    await dispatcher.dispatch(
      'post-tool-use',
      '*',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
      },
      'cursor',
      'background',
    );

    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [event, payload] = mockSendWebhook.mock.calls[0];
    expect(event).toBe('skill-use');
    expect(payload.data).toEqual({ skillName: 'tdd' });
    expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_PRIVATE_OUTPUT');
  });

  it('a normal Read (non-SKILL.md) on the wildcard pass sends no webhook', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry(), localConfig: scope });
    await dispatcher.dispatch(
      'post-tool-use',
      '*',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/project/src/secrets.ts' },
        tool_response: 'const API_KEY = "SYNTHETIC_SECRET_NOT_REAL";',
      },
      'cursor',
      'background',
    );

    expect(mockSendWebhook).not.toHaveBeenCalled();
  });
});

// PostToolUse payloads as Muse Code 1.4.6 sends them, tool_response trimmed.
describe('skill-use handler: Muse Code', () => {
  const musePayload = (toolName: string, toolInput: JsonValue) => ({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'call_14',
    tool_response: '<read-skill-result name="live-skill" status="ok"></read-skill-result>',
    session_id: '01a131d0-7b02-7e90-bd5a-74e6934af652',
    turn_id: '2d808450-3250-42fc-93e5-27b5a7b725ea',
    cwd: '/work/project',
    transcript_path: null,
    model: 'muse-spark-1.3',
    permission_mode: 'bypassPermissions',
    model_provider: 'meta',
  });
  const track = () => buildHandlerRegistry()
    .find((r) => r.event === 'post-tool-use' && r.matcher === '*' && r.handler.name === 'skill-use')!.handler;

  it('records a read_skill call as a use of that skill', async () => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    vi.mocked(appendUsageEvent).mockClear();

    await track().execute(musePayload('read_skill', { name: 'live-skill' }), 'muse', scope);

    expect(appendUsageEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(appendUsageEvent).mock.calls[0][0]).toMatchObject({ skill: 'live-skill', tool: 'muse' });
    expect(updateKnownSkills).toHaveBeenCalledWith('live-skill');
  });

  it('records nothing for a shell call', async () => {
    const { appendUsageEvent } = await import('../usage-tracker.js');
    vi.mocked(appendUsageEvent).mockClear();

    await track().execute(musePayload('bash', { command: 'echo hi', workdir: '/work/project' }), 'muse', scope);

    expect(appendUsageEvent).not.toHaveBeenCalled();
  });
});

describe('skill-mention handler: dotted and colon skill names', () => {
  it('tracks a skill name that contains a dot', async () => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'skill-mention',
    )!.handler;

    vi.mocked(appendUsageEvent).mockClear();
    vi.mocked(updateKnownSkills).mockClear();

    await handler.execute(
      { prompt: '/org.setup some args', hook_event_name: 'UserPromptSubmit' },
      // Registered with requiresConfig: the dispatcher always hands it a scope.
      'claude', scope,
    );

    expect(appendUsageEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(appendUsageEvent).mock.calls[0][0].skill).toBe('org.setup');
    expect(updateKnownSkills).toHaveBeenCalledWith('org.setup');
  });

  it('tracks a skill name that contains a colon', async () => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'skill-mention',
    )!.handler;

    vi.mocked(appendUsageEvent).mockClear();
    vi.mocked(updateKnownSkills).mockClear();

    await handler.execute(
      { prompt: '/ns:deploy some args', hook_event_name: 'UserPromptSubmit' },
      // Registered with requiresConfig: the dispatcher always hands it a scope.
      'claude', scope,
    );

    expect(appendUsageEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(appendUsageEvent).mock.calls[0][0].skill).toBe('ns:deploy');
    expect(updateKnownSkills).toHaveBeenCalledWith('ns:deploy');
  });

  it.each([
    '/Volumes/External/project/.claude/skills/tdd/SKILL.md',
    '/Users/alice/project',
    '/tmp/project',
    '/tdd/notes',
    '/tdd\\notes',
    '//server/share',
    '/tdd+invalid',
  ])('does not record a path or a partial skill name: %s', async (prompt) => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    const handler = buildHandlerRegistry().find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'skill-mention',
    )!.handler;
    vi.mocked(appendUsageEvent).mockClear();
    vi.mocked(updateKnownSkills).mockClear();

    await handler.execute({ prompt, hook_event_name: 'UserPromptSubmit' }, 'claude', scope);

    expect(appendUsageEvent).not.toHaveBeenCalled();
    expect(updateKnownSkills).not.toHaveBeenCalled();
  });
});

describe('buildAdoptedSummary', () => {
  it('lists the adopted doc-ids in English, tagged as a teamai note', () => {
    const msg = buildAdoptedSummary(['auth-retry', 'k8s-oom']);

    expect(msg).toContain('[teamai]');
    expect(msg).toContain('Adopted team knowledge this session');
    expect(msg).toContain('auth-retry, k8s-oom');
    // User-facing CLI output must be English.
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('the MR hint at session start', () => {
  let dir: string;
  const handler = (name: string) => buildHandlerRegistry().find((r) => r.handler.name === name)!.handler;
  const config = (): LocalConfig => ({ ...scope, repo: { localPath: dir, remote: 'https://example.invalid/t.git' } });
  // The session the hint may offer teamai-import-from-mr to.
  const session = { sessionId: expect.any(String), cwd: expect.any(String), run: expect.objectContaining({ runMode: expect.any(String) }) };
  const hint = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Found 1 recently merged MR(s)' } });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-mr-hint-'));
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), 'team: t\nrepo: https://example.invalid/t.git\n');
    mockMrHintOutput.mockReset().mockResolvedValue(hint);
    mockStashMrHint.mockClear();
  });

  afterEach(() => {
    mockMrHintOutput.mockReset().mockResolvedValue(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks for merged MRs only in the detached pass of a tool whose next prompt shows them', async () => {
    expect(await handler('mr-hint').execute({}, 'claude', config())).toBeNull();
    await handler('mr-hint-stash').execute({}, 'claude', config());

    expect(mockMrHintOutput).not.toHaveBeenCalled();
    expect(mockStashMrHint.mock.calls).toEqual([[undefined, expect.objectContaining({ repo: expect.objectContaining({ localPath: dir }) }), session]]);
  });

  it('prints the hint at session start for a tool teamai gives no prompt hook', async () => {
    expect(await handler('mr-hint').execute({}, 'kiro', config())).toBe(hint);
    await handler('mr-hint-stash').execute({}, 'kiro', config());

    expect(mockStashMrHint).not.toHaveBeenCalled();
  });

  it('prints the hint at session start where the team turned the prompt hook off', async () => {
    fs.mkdirSync(path.join(dir, 'hooks'));
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.yaml'), 'builtin:\n  disabled:\n    - Hook dispatch prompt-submit\n');

    expect(await handler('mr-hint').execute({}, 'claude', config())).toBe(hint);
    await handler('mr-hint-stash').execute({}, 'claude', config());

    expect(mockStashMrHint).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'language: en\n'],
    [undefined, ''],
  ])('passes the agent language %s from teamai.yaml into the hint (#1014)', async (language, line) => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), `team: t\nrepo: https://example.invalid/t.git\n${line}`);
    await handler('mr-hint').execute({}, 'kiro', config());
    await handler('mr-hint-stash').execute({}, 'claude', config());

    const call = [language, expect.objectContaining({ repo: expect.objectContaining({ localPath: dir }) }), session];
    expect(mockMrHintOutput.mock.calls).toEqual([call]);
    expect(mockStashMrHint.mock.calls).toEqual([call]);
  });
});

describe('post-checkout from the git hook in a project', () => {
  let root: string;
  let main: string;
  const head = 'a'.repeat(40);
  const config = (dataHome: string): LocalConfig => ({
    scope: 'project', projectRoot: main, username: 'test', additionalRoles: [],
    repo: { kind: 'git', localPath: path.join(root, 'team'), remote: '' }, dataHome,
  });
  const postCheckout = async (cwd: string, gitArgs: string[], localConfig: LocalConfig) => {
    const result = await createDispatcher({ handlers: buildHandlerRegistry(), localConfig })
      .dispatch('post-checkout', '*', { cwd, hook_event_name: 'post-checkout', git_args: gitArgs }, 'git');
    expect(result.errors).toEqual([]);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { execFileSync } = await import('node:child_process');
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-hook-post-checkout-')));
    main = path.join(root, 'main');
    fs.mkdirSync(main);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: main, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a branch switch in an existing checkout syncs nothing', async () => {
    await postCheckout(main, [head, head, '1'], config(path.join(root, 'data')));

    expect(mockPull).not.toHaveBeenCalled();
  });

  it('a worktree teamai creates under its own data home is left alone', async () => {
    const { execFileSync } = await import('node:child_process');
    const dataHome = path.join(root, 'data');
    const wt = path.join(dataHome, 'own-worktree');
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: main, stdio: 'ignore' });

    await postCheckout(wt, ['0'.repeat(40), head, '1'], config(dataHome));

    expect(mockPull).not.toHaveBeenCalled();
  });
});
