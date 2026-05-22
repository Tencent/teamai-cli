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

vi.mock('../auto-recall.js', () => ({
  autoRecall: mockAutoRecallFromParsed,
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
});
