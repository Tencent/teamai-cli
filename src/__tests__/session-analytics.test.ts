import { describe, it, expect } from 'vitest';
import { canonicalRepo, attributeRepo } from '../utils/repo-attribution.js';
import { attributeByRepo, timeAnalytics, renderHourSparkline } from '../session-analytics.js';
import type { DashboardEvent, TokenUsage } from '../types.js';

function ev(p: Partial<DashboardEvent> & { type: DashboardEvent['type']; timestamp: string; sessionId: string }): DashboardEvent {
  return { tool: 'claude', ...p } as DashboardEvent;
}
function tok(input: number, output: number): TokenUsage {
  return { input, output, cacheRead: 0, cacheCreation: 0 };
}

describe('canonicalRepo', () => {
  it('drops host and keeps owner/repo across platforms', () => {
    expect(canonicalRepo('github.com/Eyre921/new-api')).toBe('Eyre921/new-api');
    expect(canonicalRepo('cnb.cool/Eyre921/new-api')).toBe('Eyre921/new-api');
    expect(canonicalRepo('https://github.com/Tencent/teamai-cli.git')).toBe('Tencent/teamai-cli');
    expect(canonicalRepo('git@github.com:Tencent/teamai-cli.git')).toBe('Tencent/teamai-cli');
  });
  it('handles the legacy owner_repo underscore form', () => {
    expect(canonicalRepo('Eyre921_new-api')).toBe('Eyre921/new-api');
  });
  it('returns null when no owner can be derived', () => {
    expect(canonicalRepo('new-api')).toBeNull();
  });
});

describe('attributeRepo', () => {
  it('uses the project directory name for filesystem paths', () => {
    expect(attributeRepo('/home/u/new-api')).toBe('new-api');
    expect(attributeRepo('/opt/teamai-cli/')).toBe('teamai-cli');
  });
  it('canonicalizes remote-form cwds to owner/repo', () => {
    expect(attributeRepo('github.com/Tencent/teamai-cli')).toBe('Tencent/teamai-cli');
  });
  it('maps home/root/ops/empty dirs to no_repo', () => {
    expect(attributeRepo('/home')).toBe('no_repo');
    expect(attributeRepo('/root')).toBe('no_repo');
    expect(attributeRepo('/opt')).toBe('no_repo');
    expect(attributeRepo('')).toBe('no_repo');
    expect(attributeRepo(undefined)).toBe('no_repo');
  });
});

describe('attributeByRepo', () => {
  const events: DashboardEvent[] = [
    // Session A in /home/u/alpha: 2 tools, 1 prompt, tokens 100/50
    ev({ type: 'session_start', timestamp: '2026-07-01T10:00:00.000Z', sessionId: 'A', cwd: '/home/u/alpha' }),
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T10:00:01.000Z', sessionId: 'A', cwd: '/home/u/alpha', promptSummary: 'hi' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T10:00:02.000Z', sessionId: 'A', cwd: '/home/u/alpha', toolName: 'Edit' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T10:00:03.000Z', sessionId: 'A', cwd: '/home/u/alpha', toolName: 'Bash' }),
    ev({ type: 'stop', timestamp: '2026-07-01T10:00:10.000Z', sessionId: 'A', cwd: '/home/u/alpha', tokens: tok(100, 50), prompts: 1, interventions: { interrupt: 1, toolReject: 0 } }),
    // Session B also in /home/u/alpha: 1 tool
    ev({ type: 'tool_use', timestamp: '2026-07-01T11:00:00.000Z', sessionId: 'B', cwd: '/home/u/alpha', toolName: 'Read' }),
    ev({ type: 'stop', timestamp: '2026-07-01T11:00:05.000Z', sessionId: 'B', cwd: '/home/u/alpha', tokens: tok(10, 5), prompts: 0 }),
    // Session C in /home/u/beta: 1 tool
    ev({ type: 'tool_use', timestamp: '2026-07-01T12:00:00.000Z', sessionId: 'C', cwd: '/home/u/beta', toolName: 'Grep' }),
  ];

  it('groups sessions by repo and rolls up totals', () => {
    const repos = attributeByRepo(events);
    const alpha = repos.find((r) => r.repo === 'alpha')!;
    const beta = repos.find((r) => r.repo === 'beta')!;
    expect(alpha.sessions).toBe(2);
    expect(alpha.tools).toBe(3); // Edit + Bash + Read
    expect(alpha.prompts).toBe(1);
    expect(alpha.interventions).toBe(1);
    expect(alpha.tokens.input).toBe(110);
    expect(beta.sessions).toBe(1);
    expect(beta.tools).toBe(1);
  });

  it('sorts repos by total tokens then sessions (alpha before beta)', () => {
    const repos = attributeByRepo(events);
    expect(repos[0].repo).toBe('alpha');
  });
});

describe('timeAnalytics', () => {
  const events: DashboardEvent[] = [
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T02:00:00.000Z', sessionId: 'A' }),
    ev({ type: 'tool_use', timestamp: '2026-07-01T02:02:00.000Z', sessionId: 'A' }), // +2min (active)
    ev({ type: 'tool_use', timestamp: '2026-07-01T02:30:00.000Z', sessionId: 'A' }), // +28min (idle, not counted)
    ev({ type: 'prompt_submit', timestamp: '2026-07-01T14:00:00.000Z', sessionId: 'B' }),
  ];

  it('counts active minutes only for sub-idle gaps', () => {
    const ta = timeAnalytics(events);
    expect(ta.activeMinutes).toBe(2);
    expect(ta.totalEvents).toBe(4);
  });

  it('byHour sums to total and peakHour is the argmax (TZ-independent checks)', () => {
    const ta = timeAnalytics(events);
    expect(ta.byHour.reduce((a, b) => a + b, 0)).toBe(4);
    const max = Math.max(...ta.byHour);
    expect(ta.byHour[ta.peakHour]).toBe(max);
  });

  it('night-owl ratio matches the local-hour split of the same timestamps', () => {
    const ta = timeAnalytics(events);
    const expectedNight = events.filter((e) => new Date(e.timestamp).getHours() < 6).length / events.length;
    expect(ta.nightOwlRatio).toBeCloseTo(expectedNight, 5);
  });

  it('returns empty analytics for no events', () => {
    const ta = timeAnalytics([]);
    expect(ta).toEqual({ byHour: new Array(24).fill(0), peakHour: -1, nightOwlRatio: 0, activeMinutes: 0, totalEvents: 0 });
  });
});

describe('renderHourSparkline', () => {
  it('renders 24 characters', () => {
    const spark = renderHourSparkline(new Array(24).fill(0).map((_, i) => i));
    expect(spark.length).toBe(24);
  });

  it('renders all-zero input as 24 dots (idle is distinct from low activity)', () => {
    expect(renderHourSparkline(new Array(24).fill(0))).toBe('·'.repeat(24));
  });

  it('renders a single peak as a full bar and empty hours as dots', () => {
    const byHour = new Array(24).fill(0);
    byHour[9] = 42;
    const spark = renderHourSparkline(byHour);
    expect(spark[9]).toBe('█');
    expect(spark[0]).toBe('·');
    expect(spark.replace(/[·█]/g, '')).toBe(''); // only dots and the one full bar
  });
});
