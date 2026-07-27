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
const mockDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockReportAndSyncFromHook = vi.fn().mockResolvedValue(null);

vi.mock('../pull.js', () => ({
  pull: mockPull,
}));

vi.mock('../dashboard-collector.js', () => ({
  parseHookEvent: mockParseHookEvent,
  appendEvent: mockAppendEvent,
  compactEvents: vi.fn().mockResolvedValue(undefined),
  dashboardReport: mockDashboardReport,
}));

vi.mock('../usage-tracker.js', () => ({
  trackFromStdin: mockTrackFromParsed,
  trackSlashCommand: mockTrackSlashFromParsed,
  extractSkillName: vi.fn(),
  isValidSkillName: vi.fn().mockReturnValue(true),
  appendUsageEvent: vi.fn().mockResolvedValue(undefined),
  updateKnownSkills: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../contribute-check.js', () => ({
  contributeCheck: vi.fn().mockResolvedValue(undefined),
  contributeCheckForSession: mockContributeCheckForSession,
}));

vi.mock('../update.js', () => ({
  doUpdate: mockDoUpdate,
  checkForUpdate: vi.fn().mockResolvedValue({ available: false, current: '1.0.0' }),
}));

vi.mock('../config.js', () => ({
  autoDetectInit: vi.fn().mockResolvedValue({
    localConfig: { repo: { localPath: '/tmp', remote: '' }, username: 'test', scope: 'user' },
    teamConfig: { team: 'test', repo: '', toolPaths: {} },
  }),
}));

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../local-agent.js', () => ({
  reportAndSyncFromHook: mockReportAndSyncFromHook,
}));

import { buildHandlerRegistry, filterHandlersForConfig, type HandlerRegistration } from '../hook-handlers.js';
import { createDispatcher } from '../hook-dispatch.js';

// ── Tests ────────────────────────────────────────────────

describe('hook-handlers registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns registrations for all expected events', () => {
    const registry = buildHandlerRegistry();
    const events = new Set(registry.map((r) => r.event));
    expect(events).toContain('session-start');
    expect(events).toContain('stop');
    expect(events).toContain('post-tool-use');
    expect(events).toContain('prompt-submit');
  });

  it('session-start has pull and dashboard-report handlers', () => {
    const registry = buildHandlerRegistry();
    const sessionStartHandlers = registry
      .filter((r) => r.event === 'session-start' && r.matcher === '*')
      .map((r) => r.handler.name);
    expect(sessionStartHandlers).toContain('pull');
    expect(sessionStartHandlers).toContain('dashboard-report');
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
    expect(mockContributeCheckForSession).toHaveBeenCalledWith('sid-abc', '/x');
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
    expect(parsed.followup_message).toBe('[teamai] hello');
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
    expect(names).toContain('local-agent-sync');
  });

  it('filterHandlersForConfig keeps all handlers for git source and when uninitialized', () => {
    const registry = buildHandlerRegistry();
    const full = registry.length;
    expect(filterHandlersForConfig(registry, { repo: { kind: 'git' } } as never).length).toBe(full);
    expect(filterHandlersForConfig(registry, { repo: {} } as never).length).toBe(full);
    expect(filterHandlersForConfig(registry, null).length).toBe(full);
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
