import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────
// Mock the underlying modules so handlers don't do real I/O

const mockPull = vi.fn().mockResolvedValue(undefined);
const mockDashboardReport = vi.fn().mockResolvedValue(undefined);
const mockParseHookEvent = vi.fn().mockResolvedValue({ type: 'session_start', timestamp: '2026-01-01', sessionId: 'test', tool: 'claude' });
const mockAppendEvent = vi.fn().mockResolvedValue(undefined);
const mockTrackFromParsed = vi.fn().mockResolvedValue(undefined);
const mockTrackSlashFromParsed = vi.fn().mockResolvedValue(undefined);
const mockAutoRecallFromParsed = vi.fn().mockResolvedValue(null);
const mockContributeCheckForSession = vi.fn().mockResolvedValue({ hint: null });
const mockDoUpdate = vi.fn().mockResolvedValue(undefined);

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

vi.mock('../auto-recall.js', async (importOriginal) => {
  // Keep the real parseHookInput (and other helpers); only stub autoRecall so
  // we can assert what the handler passes to it.
  const actual = await importOriginal<typeof import('../auto-recall.js')>();
  return { ...actual, autoRecall: mockAutoRecallFromParsed };
});

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

import { buildHandlerRegistry, type HandlerRegistration } from '../hook-handlers.js';

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

  it('post-tool-use Bash/Grep/WebSearch/WebFetch have auto-recall', () => {
    const registry = buildHandlerRegistry();
    for (const matcher of ['Bash', 'Grep', 'WebSearch', 'WebFetch']) {
      const handlers = registry
        .filter((r) => r.event === 'post-tool-use' && r.matcher === matcher)
        .map((r) => r.handler.name);
      expect(handlers).toContain('auto-recall');
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

  it('pull handler has a longer timeout than dashboard-report', () => {
    const registry = buildHandlerRegistry();
    const pull = registry.find((r) => r.handler.name === 'pull');
    const dashboard = registry.find((r) => r.handler.name === 'dashboard-report');
    expect(pull!.timeoutMs).toBeGreaterThan(dashboard!.timeoutMs!);
  });

  it('auto-recall handler parses STDIN and passes it to autoRecall (does not re-read process.stdin)', async () => {
    // Regression: the handler used to call autoRecall() with NO arguments,
    // expecting it to re-read process.stdin. But the dispatcher reads STDIN
    // once and drains the stream, so autoRecall() saw no data and auto-recall
    // never fired through the hook-dispatch path. The handler must now build
    // the input from the dispatcher's already-parsed object and pass it in.
    const registry = buildHandlerRegistry();
    const reg = registry.find((r) => r.event === 'post-tool-use' && r.matcher === 'Bash');
    expect(reg).toBeDefined();

    const stdin = {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'Error: tests failed', stderr: '' },
      session_id: 'sess-abc',
    };

    await reg!.handler.execute(stdin, 'claude');

    expect(mockAutoRecallFromParsed).toHaveBeenCalledTimes(1);
    const passed = mockAutoRecallFromParsed.mock.calls[0][0];
    // Before the fix this was `undefined` (autoRecall called with no args).
    expect(passed).toBeDefined();
    expect(passed.toolName).toBe('Bash');
    expect(passed.toolInput).toEqual({ command: 'npm test' });
    expect(passed.toolOutput).toContain('Error: tests failed');
    expect(passed.sessionId).toBe('sess-abc');
  });
});
