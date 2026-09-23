import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────
// Mock the underlying modules so handlers don't do real I/O

const mockPull = vi.fn().mockResolvedValue(undefined);
const mockDashboardReport = vi.fn().mockResolvedValue(undefined);
const mockParseHookEvent = vi.fn().mockResolvedValue({ type: 'session_start', timestamp: '2026-01-01', sessionId: 'test', tool: 'claude' });
const mockAppendEvent = vi.fn().mockResolvedValue(undefined);
const mockTrackFromParsed = vi.fn().mockResolvedValue(undefined);
const mockTrackSlashFromParsed = vi.fn().mockResolvedValue(undefined);
const mockContributeCheckForSession = vi.fn().mockResolvedValue({ hint: null });
const mockTakePendingHint = vi.fn().mockResolvedValue(null);
const mockTakePendingVotesHint = vi.fn().mockResolvedValue(null);
const mockStashVotesHint = vi.fn().mockResolvedValue(undefined);
const mockClaimVotesNudge = vi.fn().mockResolvedValue(true);
const mockParseTranscriptForVotes = vi.fn().mockResolvedValue({ referencedDocIds: [], recalledDocIds: [] });
const mockIncrementUpvoted = vi.fn().mockResolvedValue(undefined);
const mockSyncVotesToTeam = vi.fn().mockResolvedValue(false);
const mockDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockReportAndSyncFromHook = vi.fn().mockResolvedValue(null);
const mockPackageManifestHash = vi.fn().mockResolvedValue('before-hash');
const mockStashPackageHint = vi.fn().mockResolvedValue(undefined);
const mockClaimPackageHint = vi.fn().mockResolvedValue(null);
const mockTakePendingPackageHint = vi.fn().mockResolvedValue(null);

vi.mock('../pull.js', () => ({
  pull: mockPull,
}));

vi.mock('../dashboard-collector.js', () => ({
  parseHookEvent: mockParseHookEvent,
  appendEvent: mockAppendEvent,
  compactEvents: vi.fn().mockResolvedValue(undefined),
  dashboardReport: mockDashboardReport,
}));

// Use the REAL resolveSkillUse (pure Skill/Read+SKILL.md logic, no I/O) so the
// webhook + track tests exercise the actual skill-name resolution shared by both
// callers, rather than a stub that could drift from production behavior.
vi.mock('../usage-tracker.js', async () => {
  const actual = await vi.importActual<typeof import('../usage-tracker.js')>('../usage-tracker.js');
  return {
    trackFromStdin: mockTrackFromParsed,
    trackSlashCommand: mockTrackSlashFromParsed,
    resolveSkillUse: actual.resolveSkillUse,
    extractSkillName: actual.extractSkillName,
    isValidSkillName: actual.isValidSkillName,
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

vi.mock('../contribute-check.js', () => ({
  contributeCheck: vi.fn().mockResolvedValue(undefined),
  contributeCheckForSession: mockContributeCheckForSession,
  takePendingHint: mockTakePendingHint,
  takePendingVotesHint: mockTakePendingVotesHint,
  stashVotesHint: mockStashVotesHint,
  claimVotesNudge: mockClaimVotesNudge,
}));

vi.mock('../update.js', () => ({
  doUpdate: mockDoUpdate,
  checkForUpdate: vi.fn().mockResolvedValue({ available: false, current: '1.0.0' }),
}));

const mockAutoDetectInit = vi.fn().mockResolvedValue({
  localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
  // Recall on: the contribute hint routes to the share workflow, which is
  // refused while recall is off, so the hint is withheld there too.
  teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { recall: { enabled: true } } },
});

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: mockAutoDetectInit,
  resolveConfigForDir: vi.fn().mockResolvedValue({
    repo: { localPath: '/tmp/team-repo', remote: '' }, username: 'test', scope: 'user', additionalRoles: [],
  }),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../local-agent.js', () => ({
  reportAndSyncFromHook: mockReportAndSyncFromHook,
}));

vi.mock('../pkg/pkg-hint.js', () => ({
  packageManifestHashForCwd: mockPackageManifestHash,
  stashPackageHintAfterPull: mockStashPackageHint,
  claimPackageHintOutput: mockClaimPackageHint,
  takePendingPackageHint: mockTakePendingPackageHint,
}));

vi.mock('../transcript-parser.js', () => ({
  parseTranscriptForVotes: mockParseTranscriptForVotes,
}));

const voteMocks = vi.hoisted(() => ({
  hasPendingVoteDeltas: vi.fn().mockResolvedValue(false),
}));
vi.mock('../votes.js', () => ({
  incrementUpvoted: mockIncrementUpvoted,
  syncVotesToTeam: mockSyncVotesToTeam,
  hasPendingVoteDeltas: (...args: unknown[]) => voteMocks.hasPendingVoteDeltas(...args),
}));

const reportsBranchMocks = vi.hoisted(() => ({
  updateReports: vi.fn().mockResolvedValue(true),
}));
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: (...args: unknown[]) => reportsBranchMocks.updateReports(...args),
}));

const mockSeedProjectAgentRoot = vi.fn().mockResolvedValue(undefined);
vi.mock('../project-agent-root.js', () => ({
  seedProjectAgentRoot: mockSeedProjectAgentRoot,
}));

import { buildHandlerRegistry, buildVotesNudge, filterHandlersForConfig, type HandlerRegistration } from '../hook-handlers.js';
import { createDispatcher } from '../hook-dispatch.js';

// ── Tests ────────────────────────────────────────────────

describe('hook-handlers registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockParseTranscriptForVotes.mockResolvedValue({ referencedDocIds: [], recalledDocIds: [] });
    mockClaimVotesNudge.mockResolvedValue(true);
    mockPackageManifestHash.mockResolvedValue('before-hash');
    mockTakePendingPackageHint.mockResolvedValue(null);
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

  it('session-end records the final dashboard snapshot and dispatches the webhook, both in the background', () => {
    const handlers = buildHandlerRegistry().filter((r) => r.event === 'session-end');
    // Copilot fires SessionEnd (not Stop), so the webhook handler must run here
    // too — otherwise those sessions emit no session-stop notification (#702).
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
    ]);
  });

  it('session-start has pull and dashboard-report handlers', () => {
    const registry = buildHandlerRegistry();
    const sessionStartHandlers = registry
      .filter((r) => r.event === 'session-start' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(sessionStartHandlers).toContain('pull');
    expect(sessionStartHandlers).toContain('dashboard-report');
  });

  it('session-start pull seeds the hook tool root before pulling', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute({ session_id: 's-pull', cwd: '/tmp/some-project' }, 'claude');

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('claude', '/tmp/some-project');
    expect(mockPull).toHaveBeenCalledWith({ silent: true });
    expect(mockStashPackageHint).toHaveBeenCalledWith(
      '/tmp/some-project',
      's-pull',
      'before-hash',
    );
    expect(mockSeedProjectAgentRoot.mock.invocationCallOrder[0]).toBeLessThan(
      mockPull.mock.invocationCallOrder[0],
    );
  });

  it('session-start pull seeds from workspace_roots when cwd is absent', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute({ workspace_roots: ['/tmp/cursor-project'] }, 'cursor');

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('cursor', '/tmp/cursor-project');
  });

  it('session-start pull prefers cwd over workspace_roots', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'session-start' && r.handler.name === 'pull',
    )!.handler;

    await handler.execute(
      { cwd: '/from-cwd', workspace_roots: ['/from-roots'] },
      'claude',
    );

    expect(mockSeedProjectAgentRoot).toHaveBeenCalledWith('claude', '/from-cwd');
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
      const result = await handler.execute({ cwd: '/tmp/some-project' }, 'claude');
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

    await handler.execute({ session_id: 'sid-abc', cwd: '/x' }, 'claude');
    // transcriptPath is the third arg; absent from this stdin so it is undefined.
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('sid-abc', '/x', undefined, false);
  });

  it('contribute-check handler forwards transcript_path so friction is read live', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    await handler.execute(
      { session_id: 'sid-abc', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('sid-abc', '/x', '/t/transcript.jsonl', false);
  });

  it('contribute-check handler routes hint through formatStopHookOutput for cursor', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] hello' });

    const result = await handler.execute({ session_id: 's', cwd: '/x' }, 'cursor');
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
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

    const result = await handler.execute({ session_id: 's', cwd: '/x' }, 'claude');
    const parsed = JSON.parse(result!);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] hello');
  });

  it.each(['codebuddy', 'codex', 'codex-internal', 'tcodex'])('contribute-check handler asks to stash (not stdout) for %s', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    // codebuddy stashes: contributeCheckForSession is called with stash=true and
    // returns hint:null (it persisted the hint as pendingHint itself).
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: null });

    const result = await handler.execute({ session_id: 's1', cwd: '/x' }, tool);
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('s1', '/x', undefined, true);
  });

  it('contribute-check handler returns stdout hint for claude (unchanged)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;

    mockContributeCheckForSession.mockResolvedValueOnce({ hint: '[teamai] do share' });

    const result = await handler.execute({ session_id: 's2', cwd: '/x' }, 'claude');
    expect(result).not.toBeNull();
    expect(result).toContain('do share');
    // claude is not a stash tool: called with stash=false.
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('s2', '/x', undefined, false);
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

    const result = await handler.execute({ session_id: 's3', cwd: '/x' }, 'claude');
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

    const result = await handler.execute({ session_id: 's4', cwd: '/x' }, 'claude');
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

    const result = await handler.execute({ session_id: 's3b', cwd: '/x' }, 'claude');
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

    const result = await handler.execute({ session_id: 's3c', cwd: '/x' }, 'claude');
    expect(result).toBeNull();
    expect(mockContributeCheckForSession).not.toHaveBeenCalled();
  });

  it('contribute-check handler stays silent when there is no config at all (#748)', async () => {
    const { NotInitializedError } = await import('../config.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'contribute-check',
    )!.handler;
    // A directory without teamai has no team to share with.
    mockAutoDetectInit.mockRejectedValueOnce(new NotInitializedError('teamai is not initialized. Run `teamai init` first.'));
    mockContributeCheckForSession.mockClear();

    const result = await handler.execute({ session_id: 's5', cwd: '/x' }, 'claude');
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

    const result = await handler.execute({ session_id: 's5b', cwd: '/x' }, 'claude');
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
      const result = await handler.execute({ session_id: 's6', cwd: '/x' }, 'claude');
      expect(result).toBeNull();
      expect(mockContributeCheckForSession).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED;
      else process.env.TEAMAI_CONTRIBUTE_HINT_DISABLED = previous;
    }
  });

  it('pending-hint handler drops a stashed hint when the team turned the hint off but still delivers votes hints', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { contributeHint: { enabled: false } } },
    });
    mockTakePendingHint.mockResolvedValueOnce('[teamai] stashed');
    mockTakePendingVotesHint.mockResolvedValueOnce('[teamai] votes nudge');

    const result = await handler.execute({ session_id: 's7', cwd: '/x' }, 'codebuddy');
    // The stash is consumed (so it is not delivered later) but not shown.
    expect(mockTakePendingHint).toHaveBeenCalledWith(expect.any(String));
    expect(result).not.toBeNull();
    expect(result).not.toContain('stashed');
    expect(result).toContain('votes nudge');
  });

  it.each(['codebuddy', 'codex'])('pending-hint handler injects stashed hint for %s on prompt-submit', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce('[teamai] stashed');

    const result = await handler.execute({ session_id: 's3', cwd: '/x' }, tool);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] stashed');
  });

  it('package-pending-hint checks package hints for claude', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'package-pending-hint',
    )!.handler;

    const result = await handler.execute({ session_id: 's4', cwd: '/x' }, 'claude');
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

    const result = await handler.execute({ session_id: 's5', cwd: '/x' }, 'codebuddy');
    expect(result).toBeNull();
  });

  it('delivers a post-pull package hint on prompt-submit for Claude', async () => {
    mockTakePendingPackageHint.mockResolvedValue('Run `teamai packages`');
    const handler = buildHandlerRegistry().find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'package-pending-hint',
    )!.handler;

    const output = await handler.execute({ session_id: 's6', cwd: '/x' }, 'claude');

    expect(JSON.parse(output!).hookSpecificOutput.additionalContext)
      .toBe('Run `teamai packages`');
  });

  it('post-tool-use wildcard has dashboard-report', () => {
    const registry = buildHandlerRegistry();
    const wildcardHandlers = registry
      .filter((r) => r.event === 'post-tool-use' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(wildcardHandlers).toContain('dashboard-report');
  });

  it('post-tool-use Skill matcher has track', () => {
    const registry = buildHandlerRegistry();
    const skillHandlers = registry
      .filter((r) => r.event === 'post-tool-use' && r.matcher === 'Skill')
      .map((r) => r.handler.name);
    expect(skillHandlers).toContain('track');
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

  // post-tool-use dashboard-report stays foreground: it is a fast local file
  // append with no network I/O, so detaching it would add spawn overhead for
  // no benefit.
  it('post-tool-use wildcard dashboard-report stays foreground', () => {
    const registry = buildHandlerRegistry();
    const dashboard = registry.find(
      (r) => r.event === 'post-tool-use' && r.matcher === '*' && r.handler.name === 'dashboard-report',
    );
    expect(dashboard).toBeDefined();
    expect(dashboard!.background).not.toBe(true);
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

  it('prompt-submit has track-slash and dashboard-report', () => {
    const registry = buildHandlerRegistry();
    const handlers = registry
      .filter((r) => r.event === 'prompt-submit' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(handlers).toContain('track-slash');
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
  // host, so they may keep longer budgets.
  it('every foreground handler timeout is under 5s', () => {
    const registry = buildHandlerRegistry();
    const foreground = registry.filter((r) => r.background !== true);
    expect(foreground.length).toBeGreaterThan(0);
    for (const reg of foreground) {
      expect(reg.timeoutMs).toBeLessThan(5_000);
    }
  });

  it('TodoWrite hint stays under its 3s PostToolUse host cap', () => {
    const registry = buildHandlerRegistry();
    const todo = registry.find(
      (r) => r.event === 'post-tool-use' && r.matcher === 'TodoWrite',
    );
    expect(todo!.timeoutMs).toBeLessThan(3_000);
  });

  it('marks contribute-check, mr-hint, and votes-sync as gitOnly', () => {
    const registry = buildHandlerRegistry();
    const gitOnly = registry.filter((r) => r.gitOnly === true).map((r) => r.handler.name);
    expect(gitOnly).toContain('contribute-check');
    expect(gitOnly).toContain('mr-hint');
    expect(gitOnly).toContain('votes-sync');
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

  it('filterHandlersForConfig drops the share nudge where teamai is not set up (#748)', () => {
    const names = filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name);
    expect(names).not.toContain('contribute-check');
  });

  it('only machine-level handlers run where teamai is not set up (#748)', () => {
    // A new handler must decide: team handlers set requiresConfig, the rest join this list.
    const names = new Set(filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name));
    expect([...names].sort()).toEqual([
      'local-agent-sync',
      'package-pending-hint',
      'pull',
      'update',
    ]);
  });

  it('TodoWrite gets no recall nudge where teamai is not set up (#748)', async () => {
    const registry = buildHandlerRegistry();
    expect(registry.some((r) => r.matcher === 'TodoWrite' && r.handler.name === 'todowrite-hint')).toBe(true);
    const dispatcher = createDispatcher({ handlers: filterHandlersForConfig(registry, null) });

    const result = await dispatcher.dispatch(
      'post-tool-use', 'TodoWrite', { session_id: 'td-748', tool_name: 'TodoWrite' }, 'claude', 'foreground',
    );
    expect(result.output).toBeNull();
  });

  // ── Change 2: votes-sync nudge — marker guard removed, nudge every time declared===0 ──

  it('votes-sync nudges on every Stop when recalled>0 and declared===0 (no once-per-session guard)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    // recalled>0, declared===0 → should always nudge
    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-a'],
    });

    const result1 = await handler.execute(
      { session_id: 'sid-votes-1', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(result1).not.toBeNull();

    // Same session, same conditions — should nudge again (no marker blocks repeat)
    const result2 = await handler.execute(
      { session_id: 'sid-votes-1', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(result2).not.toBeNull();
  });

  it('votes-sync does not nudge when recalled===0', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: [],
    });

    const result = await handler.execute(
      { session_id: 'sid-votes-2', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(result).toBeNull();
  });

  it('votes-sync does not nudge when the model declared an empty [] (recalled>0, declared===0)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-a'],
      hasReferencedDocIdsDeclaration: true,
    });

    const result = await handler.execute(
      { session_id: 'sid-votes-3', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(result).toBeNull();
  });

  // ── upvote intersection filter: only recalled docs count ──

  it('votes-sync: incrementUpvoted receives only the intersection of referenced and recalled doc-ids', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: ['doc-a', 'doc-b', 'doc-c'],
      recalledDocIds: ['doc-a', 'doc-b'],
    });

    await handler.execute(
      { session_id: 'sid-filter-1', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );

    expect(mockIncrementUpvoted).toHaveBeenCalledOnce();
    expect(mockIncrementUpvoted).toHaveBeenCalledWith(expect.any(String), ['doc-a', 'doc-b']);
  });

  it('votes-sync: incrementUpvoted is not called when no referenced doc-id was actually recalled', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: ['doc-x'],
      recalledDocIds: ['doc-a', 'doc-b'],
    });

    await handler.execute(
      { session_id: 'sid-filter-2', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );

    expect(mockIncrementUpvoted).not.toHaveBeenCalled();
  });

  it('votes-sync skips updateReports when there are no pending vote deltas', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    reportsBranchMocks.updateReports.mockClear();
    await handler.execute(
      { session_id: 'sid-skip-reports', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(reportsBranchMocks.updateReports).not.toHaveBeenCalled();
  });

  it('votes-sync writes votes through updateReports when deltas are pending', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    voteMocks.hasPendingVoteDeltas.mockResolvedValueOnce(true);
    mockSyncVotesToTeam.mockResolvedValueOnce(true);
    reportsBranchMocks.updateReports.mockClear();
    reportsBranchMocks.updateReports.mockImplementationOnce(
      async (_cfg: unknown, write: (wt: string) => Promise<unknown>) => {
        await write('/wt');
        return true;
      },
    );

    await handler.execute(
      { session_id: 'sid-write-reports', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );

    expect(reportsBranchMocks.updateReports).toHaveBeenCalledOnce();
    expect(mockSyncVotesToTeam).toHaveBeenCalledWith('/wt', 'test', expect.any(String));
  });

  it('votes-sync: incrementUpvoted receives all ids when referenced and recalled are identical', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: ['doc-p', 'doc-q'],
      recalledDocIds: ['doc-p', 'doc-q'],
    });

    await handler.execute(
      { session_id: 'sid-filter-3', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );

    expect(mockIncrementUpvoted).toHaveBeenCalledOnce();
    expect(mockIncrementUpvoted).toHaveBeenCalledWith(expect.any(String), ['doc-p', 'doc-q']);
  });

  it('votes-sync: incrementUpvoted is not called when recalledDocIds is empty', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: ['doc-a'],
      recalledDocIds: [],
    });

    await handler.execute(
      { session_id: 'sid-filter-empty-recalled', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );

    expect(mockIncrementUpvoted).not.toHaveBeenCalled();
  });

  // ── Change 3: votes-sync stash branch (STOP_STDOUT_UNSUPPORTED_TOOLS) ──

  it.each(['codebuddy', 'codex'])('votes-sync stashes nudge via stashVotesHint for %s (stdout ignored)', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-b'],
    });

    const result = await handler.execute(
      { session_id: 'sid-votes-stash', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      tool,
    );
    // Stash path returns null (hint goes to the votes-hint sidecar)
    expect(result).toBeNull();
    expect(mockStashVotesHint).toHaveBeenCalledOnce();
    const [calledSessionId, calledMsg] = mockStashVotesHint.mock.calls[0];
    expect(calledSessionId).toBe('sid-votes-stash');
    expect(calledMsg).toContain('doc-b');
  });

  it('votes-sync returns stdout nudge for claude (not a stash tool)', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;

    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-c'],
    });

    const result = await handler.execute(
      { session_id: 'sid-votes-stdout', cwd: '/x', transcript_path: '/t/transcript.jsonl' },
      'claude',
    );
    expect(result).not.toBeNull();
    expect(mockStashVotesHint).not.toHaveBeenCalled();
  });

  it('votes-sync caps Cursor follow-up nudges to once per session', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'stop' && r.handler.name === 'votes-sync',
    )!.handler;
    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-cursor'],
    });
    mockClaimVotesNudge
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const stdin = { session_id: 'sid-cursor', cwd: '/x', transcript_path: '/t/transcript.jsonl' };
    expect(await handler.execute(stdin, 'cursor')).not.toBeNull();
    expect(await handler.execute(stdin, 'cursor')).toBeNull();
    expect(mockClaimVotesNudge).toHaveBeenCalledTimes(2);
  });

  it('stop dispatcher preserves both votes and contribute hints', async () => {
    mockParseTranscriptForVotes.mockResolvedValue({
      referencedDocIds: [],
      recalledDocIds: ['doc-a'],
    });
    mockContributeCheckForSession.mockResolvedValueOnce({ hint: 'CONTRIBUTE-HINT' });
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });

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

  // ── Change 3: pending-hint replays and merges the votes hint ──

  it.each(['codebuddy', 'codex'])('pending-hint merges contribute hint and votes hint for %s', async (tool) => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce('[teamai] contribute hint');
    mockTakePendingVotesHint.mockResolvedValueOnce('[teamai] votes hint');

    const result = await handler.execute({ session_id: 'sid-merge', cwd: '/x' }, tool);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[teamai] contribute hint');
    expect(ctx).toContain('[teamai] votes hint');
  });

  it('pending-hint delivers only votes hint when contribute hint is absent', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce(null);
    mockTakePendingVotesHint.mockResolvedValueOnce('[teamai] votes only');

    const result = await handler.execute({ session_id: 'sid-votes-only', cwd: '/x' }, 'codebuddy');
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.hookSpecificOutput.additionalContext).toBe('[teamai] votes only');
  });

  it('pending-hint returns null when both hints are absent', async () => {
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'pending-hint',
    )!.handler;

    mockTakePendingHint.mockResolvedValueOnce(null);
    mockTakePendingVotesHint.mockResolvedValueOnce(null);

    const result = await handler.execute({ session_id: 'sid-both-absent', cwd: '/x' }, 'codebuddy');
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
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    expect(dispatcher.hasBackground('post-tool-use', '*')).toBe(true);
  });

  it('foreground pass does NOT invoke local-agent-sync (host is not blocked on HTTP)', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'foreground');
    expect(mockReportAndSyncFromHook).not.toHaveBeenCalled();
  });

  it('background pass DOES invoke local-agent-sync (report/sync still happen)', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'background');
    expect(mockReportAndSyncFromHook).toHaveBeenCalledOnce();
  });

  it('foreground pass still runs the fast local dashboard-report handler', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    await dispatcher.dispatch('post-tool-use', '*', stdin, 'claude', 'foreground');
    // dashboard-report parses the event and appends locally — it must stay inline.
    expect(mockParseHookEvent).toHaveBeenCalled();
  });
});

describe('dashboard-report team correction keywords', () => {
  const handler = () => buildHandlerRegistry().find(
    (r) => r.event === 'prompt-submit' && r.handler.name === 'dashboard-report',
  )!.handler;

  beforeEach(() => {
    mockParseHookEvent.mockClear();
    mockAutoDetectInit.mockClear();
  });

  it('passes sharing.intervention.correctionKeywords to parseHookEvent on prompt hooks', async () => {
    mockAutoDetectInit.mockResolvedValueOnce({
      localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
      teamConfig: { team: 'test', repo: '', toolPaths: {}, sharing: { intervention: { correctionKeywords: ['rehazlo'] } } },
    });
    await handler().execute({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'rehazlo' }, 'claude');
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: ['rehazlo'] });
  });

  it('falls back to built-in keywords only when team config cannot be read', async () => {
    mockAutoDetectInit.mockRejectedValueOnce(new Error('not initialized'));
    await handler().execute({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'wrong' }, 'claude');
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: [] });
  });

  it('does not read team config for hooks without a prompt', async () => {
    await handler().execute({ hook_event_name: 'Stop', session_id: 's' }, 'claude');
    expect(mockAutoDetectInit).not.toHaveBeenCalled();
    expect(mockParseHookEvent).toHaveBeenCalledWith(expect.any(String), 'claude', { correctionKeywords: [] });
  });
});

// Regression #702 (event mapping) + #701 (field whitelist). The handler used to
// read stdin.event (never sent by hosts) → every event forwarded as `unknown`,
// and forwarded the entire stdin (tool args + tool_response) as `data`.
describe('webhook-dispatch handler (#701, #702)', () => {
  const handler = () => buildHandlerRegistry().find(
    (r) => r.handler.name === 'webhook-dispatch',
  )!.handler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWebhookConfig.mockResolvedValue({
      enabled: true,
      endpoints: [{ url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 3 }],
    });
  });

  it('maps PostToolUse/Skill to skill-use and forwards only the skill name (#701, #702)', async () => {
    await handler().execute(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { skill: 'demo', args: 'api_key=SYNTHETIC_SECRET_NOT_REAL' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
        session_id: 'sid',
      },
      'claude',
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
    await handler().execute({ hook_event_name: 'SessionStart', session_id: 'sid' }, 'claude');
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-start');
  });

  it('maps Stop to session-stop (#702)', async () => {
    await handler().execute({ hook_event_name: 'Stop', session_id: 'sid' }, 'claude');
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-stop');
  });

  it('never emits an "unknown" event for an unmapped hook (#702)', async () => {
    await handler().execute({ hook_event_name: 'PreToolUse', session_id: 'sid' }, 'claude');
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });

  // Codex review finding 1: hosts that send camelCase hook names (Cursor/
  // CodeBuddy) were silently dropped by the PascalCase-only lookup.
  it('maps camelCase sessionStart to session-start (#702, camelCase host)', async () => {
    await handler().execute({ hook_event_name: 'sessionStart', session_id: 'sid' }, 'cursor');
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-start');
  });

  // Codex review finding 9: Cursor represents skill use as a `Read` of a
  // SKILL.md file (tool_name: 'Read'), NOT a `Skill` tool — and it dispatches
  // via the camelCase `postToolUse` event. The webhook must reach the same
  // parity trackHandler has (shared resolveSkillUse), forwarding {skillName}.
  it('maps a Cursor camelCase postToolUse Read of SKILL.md to skill-use (#702, #9)', async () => {
    await handler().execute(
      {
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
        session_id: 'sid',
      },
      'cursor',
    );
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [event, payload] = mockSendWebhook.mock.calls[0];
    expect(event).toBe('skill-use');
    expect(payload.data).toEqual({ skillName: 'tdd' });
    expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_PRIVATE_OUTPUT');
  });

  // Finding 9 guard: a NORMAL (non-SKILL.md) Read must NOT produce a skill-use
  // webhook — data must be empty so a plain file read never leaks or fires.
  it('does NOT emit skill-use data for a normal (non-SKILL.md) Read (#9 guard)', async () => {
    await handler().execute(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/project/src/secrets.ts' },
        tool_response: 'const API_KEY = "SYNTHETIC_SECRET_NOT_REAL";',
        session_id: 'sid',
      },
      'cursor',
    );
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [event, payload] = mockSendWebhook.mock.calls[0];
    expect(event).toBe('skill-use');
    expect(payload.data).toEqual({});
    expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_SECRET_NOT_REAL');
    expect(JSON.stringify(payload)).not.toContain('secrets.ts');
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
    await handler().execute({ hook_event_name: 'SessionEnd', session_id: 'sid' }, 'copilot');
    expect(mockSendWebhook).toHaveBeenCalledOnce();
    expect(mockSendWebhook.mock.calls[0][0]).toBe('session-stop');
  });

  // Codex review finding 3: an extracted skillName that fails isValidSkillName
  // (e.g. a path-like `command` arg) must be dropped, not forwarded. Uses the
  // real resolveSkillUse, which validates with isValidSkillName.
  it('drops an invalid skillName instead of forwarding it (#701)', async () => {
    await handler().execute(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Skill',
        tool_input: { command: '/etc/passwd; rm -rf /' },
        session_id: 'sid',
      },
      'claude',
    );

    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [, payload] = mockSendWebhook.mock.calls[0];
    expect(payload.data).toEqual({});
    expect(JSON.stringify(payload)).not.toContain('passwd');
  });
});

// Codex review finding 12: the tests above call handler.execute() directly,
// bypassing dispatcher routing. These drive the REAL dispatcher for the
// post-tool-use `Skill` matcher — the matcher Cursor's SKILL.md Read is wired to
// (git f0ab4eb switched Cursor tracking from Read to the Skill matcher;
// BUILTIN_HOOK_SPECS has no Read matcher) — to prove a Read payload routes
// through it to webhookHandler. webhookHandler is background: true, so it runs in
// the 'background' dispatch pass. (Cursor's own runtime is external and not
// testable in this repo; this covers the CLI-side routing that is.)
describe('post-tool-use Skill-matcher dispatch routes Cursor SKILL.md Read to the webhook (#702, #9, #12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadWebhookConfig.mockResolvedValue({
      enabled: true,
      endpoints: [{ url: 'https://example.test/hook', type: 'json', events: ['*'], timeout: 5000, retries: 3 }],
    });
  });

  it('registers webhook-dispatch under the post-tool-use Skill matcher', () => {
    const reg = buildHandlerRegistry().find(
      (r) => r.event === 'post-tool-use' && r.matcher === 'Skill' && r.handler.name === 'webhook-dispatch',
    );
    expect(reg).toBeDefined();
    expect(reg!.background).toBe(true);
  });

  it('a Cursor Read of SKILL.md dispatched via the Skill matcher produces a skill-use webhook with {skillName}', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    await dispatcher.dispatch(
      'post-tool-use',
      'Skill',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/.cursor/skills/tdd/SKILL.md' },
        tool_response: 'SYNTHETIC_PRIVATE_OUTPUT',
        session_id: 'sid',
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

  it('a normal Read (non-SKILL.md) dispatched via the Skill matcher produces empty skill-use data', async () => {
    const dispatcher = createDispatcher({ handlers: buildHandlerRegistry() });
    await dispatcher.dispatch(
      'post-tool-use',
      'Skill',
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { path: '/root/project/src/secrets.ts' },
        tool_response: 'const API_KEY = "SYNTHETIC_SECRET_NOT_REAL";',
        session_id: 'sid',
      },
      'cursor',
      'background',
    );

    expect(mockSendWebhook).toHaveBeenCalledOnce();
    const [, payload] = mockSendWebhook.mock.calls[0];
    expect(payload.data).toEqual({});
    expect(JSON.stringify(payload)).not.toContain('SYNTHETIC_SECRET_NOT_REAL');
    expect(JSON.stringify(payload)).not.toContain('secrets.ts');
  });
});

describe('track-slash handler: dotted and colon skill names', () => {
  it('tracks a skill name that contains a dot', async () => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'track-slash',
    )!.handler;

    vi.mocked(appendUsageEvent).mockClear();
    vi.mocked(updateKnownSkills).mockClear();

    await handler.execute(
      { prompt: '/org.setup some args', hook_event_name: 'UserPromptSubmit' },
      'claude',
    );

    expect(appendUsageEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(appendUsageEvent).mock.calls[0][0].skill).toBe('org.setup');
    expect(updateKnownSkills).toHaveBeenCalledWith('org.setup');
  });

  it('tracks a skill name that contains a colon', async () => {
    const { appendUsageEvent, updateKnownSkills } = await import('../usage-tracker.js');
    const registry = buildHandlerRegistry();
    const handler = registry.find(
      (r) => r.event === 'prompt-submit' && r.handler.name === 'track-slash',
    )!.handler;

    vi.mocked(appendUsageEvent).mockClear();
    vi.mocked(updateKnownSkills).mockClear();

    await handler.execute(
      { prompt: '/ns:deploy some args', hook_event_name: 'UserPromptSubmit' },
      'claude',
    );

    expect(appendUsageEvent).toHaveBeenCalledOnce();
    expect(vi.mocked(appendUsageEvent).mock.calls[0][0].skill).toBe('ns:deploy');
    expect(updateKnownSkills).toHaveBeenCalledWith('ns:deploy');
  });
});

describe('buildVotesNudge', () => {
  it('names the candidates, the marker and the empty case, in English', () => {
    const msg = buildVotesNudge(['auth-retry', 'k8s-oom']);

    expect(msg).toContain('auth-retry, k8s-oom');
    expect(msg).toContain('<!-- teamai:referenced-doc-ids:');
    expect(msg).toContain('empty list');
    // Claude Code prints the Stop payload, so this reaches the terminal. The
    // repository rule is that user-facing CLI output is English (#719).
    expect(msg).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
