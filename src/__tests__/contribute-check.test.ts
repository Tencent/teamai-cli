import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readContributeState,
  writeContributeState,
  computeSmartScore,
  contributeCheckForSession,
} from '../contribute-check.js';
import { appendEvent } from '../dashboard-collector.js';
import {
  CONTRIBUTE_BASE_THRESHOLD,
  CONTRIBUTE_FASTPATH_TTL_MS,
  CONTRIBUTE_SMART_THRESHOLD,
} from '../types.js';
import type { ContributeState, DashboardEvent } from '../types.js';

// ─── Test helpers ──────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-contribute-test-'));
}

function makeEvent(overrides: Partial<DashboardEvent> = {}): DashboardEvent {
  return {
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    sessionId: 'test-session-123',
    tool: 'claude',
    ...overrides,
  };
}

// ─── contributeState read/write (per-session files) ─────────

describe('contributeState', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two sessions read/write without interfering', async () => {
    const stateA: ContributeState = { contributed: false };
    await writeContributeState('session-aaa', stateA);

    const stateB: ContributeState = { contributed: true };
    await writeContributeState('session-bbb', stateB);

    const readA = await readContributeState('session-aaa');
    expect(readA.contributed).toBe(false);

    const readB = await readContributeState('session-bbb');
    expect(readB.contributed).toBe(true);
  });

  it('returns defaults when session file does not exist', async () => {
    const state = await readContributeState('nonexistent-session');
    expect(state).toEqual({ contributed: false });
  });

  it('returns defaults when session file contains corrupted JSON', async () => {
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'broken-session.json'), '{not valid!!!}', 'utf-8');

    const state = await readContributeState('broken-session');
    expect(state).toEqual({ contributed: false });
  });

  it('backward compat: legacy fields ignored, modern fields preserved', async () => {
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Legacy `evaluated: boolean` is ignored (we use `lastEvaluated: number` now);
    // `toolCount` is still meaningful and is preserved.
    fs.writeFileSync(
      path.join(sessionsDir, 'legacy-session.json'),
      JSON.stringify({ toolCount: 50, evaluated: true, contributed: true, smartScore: 42 }),
      'utf-8',
    );

    const state = await readContributeState('legacy-session');
    expect(state.contributed).toBe(true);
    expect(state.smartScore).toBe(42);
    expect(state.toolCount).toBe(50);
    expect(state.lastEvaluated).toBeUndefined();
  });

  it('round-trip: write→read preserves toolCount, lastEvaluated, hinted', async () => {
    const original: ContributeState = {
      contributed: false,
      smartScore: 42,
      toolCount: 25,
      lastEvaluated: 1234567890,
      hinted: true,
    };
    await writeContributeState('rt-session', original);
    const read = await readContributeState('rt-session');
    expect(read).toEqual(original);
  });

  it('rejects malformed types: non-number toolCount/lastEvaluated falls back to undefined', async () => {
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'malformed-session.json'),
      JSON.stringify({
        contributed: false,
        toolCount: 'not-a-number',
        lastEvaluated: { weird: 'object' },
        hinted: 'truthy-string',
      }),
      'utf-8',
    );

    const state = await readContributeState('malformed-session');
    expect(state.toolCount).toBeUndefined();
    expect(state.lastEvaluated).toBeUndefined();
    expect(state.hinted).toBeUndefined();
  });

  it('cleans up session files older than 24 hours on write', async () => {
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const oldFile = path.join(sessionsDir, 'old-session.json');
    fs.writeFileSync(oldFile, JSON.stringify({ contributed: false }));
    const pastTime = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, new Date(pastTime), new Date(pastTime));

    const recentFile = path.join(sessionsDir, 'recent-session.json');
    fs.writeFileSync(recentFile, JSON.stringify({ contributed: false }));

    await writeContributeState('new-session', { contributed: false });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, 'new-session.json'))).toBe(true);
  });
});

// ─── computeSmartScore ─────────────────────────────────────

describe('computeSmartScore', () => {
  it('returns 0 for empty events', () => {
    expect(computeSmartScore([])).toBe(0);
  });

  it('scores low for single-tool repetitive session', () => {
    const events = Array.from({ length: 20 }, () =>
      makeEvent({ toolName: 'Bash' }),
    );
    const score = computeSmartScore(events);
    expect(score).toBeLessThan(10);
  });

  it('scores high for diverse session with skills and errors', () => {
    const now = Date.now();
    const events: DashboardEvent[] = [
      makeEvent({ toolName: 'Read', timestamp: new Date(now - 40 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Edit', timestamp: new Date(now - 35 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Bash', timestamp: new Date(now - 30 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Skill', timestamp: new Date(now - 25 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Write', timestamp: new Date(now - 20 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Grep', timestamp: new Date(now - 15 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Agent', timestamp: new Date(now - 10 * 60 * 1000).toISOString() }),
      makeEvent({
        type: 'prompt_submit',
        promptSummary: 'fix the build error',
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
      makeEvent({ toolName: 'Edit', timestamp: new Date(now).toISOString() }),
    ];

    const score = computeSmartScore(events);
    expect(score).toBeGreaterThanOrEqual(35);
  });

  it('gives 15 points for skill usage', () => {
    const base = [
      makeEvent({ toolName: 'Bash' }),
      makeEvent({ toolName: 'Read' }),
    ];
    const withSkill = [
      ...base,
      makeEvent({ toolName: 'Skill' }),
    ];

    const scoreBase = computeSmartScore(base);
    const scoreWithSkill = computeSmartScore(withSkill);
    expect(scoreWithSkill - scoreBase).toBeGreaterThanOrEqual(10);
  });

  it('detects error keywords in prompts', () => {
    const events: DashboardEvent[] = [
      makeEvent({ toolName: 'Bash' }),
      makeEvent({
        type: 'prompt_submit',
        promptSummary: 'there was an error in the build',
      }),
    ];
    const score = computeSmartScore(events);
    expect(score).toBeGreaterThanOrEqual(15);
  });

  it('gives 20 points for long sessions', () => {
    const now = Date.now();
    const events: DashboardEvent[] = [
      makeEvent({ toolName: 'Bash', timestamp: new Date(now - 60 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Bash', timestamp: new Date(now).toISOString() }),
    ];
    const score = computeSmartScore(events);
    expect(score).toBeGreaterThanOrEqual(20);
  });

  it('gives toolCount gradient points for 30+ calls', () => {
    const events30 = Array.from({ length: 30 }, () =>
      makeEvent({ toolName: 'Bash' }),
    );
    const score30 = computeSmartScore(events30);

    const events80 = Array.from({ length: 80 }, () =>
      makeEvent({ toolName: 'Bash' }),
    );
    const score80 = computeSmartScore(events80);

    expect(score80).toBeGreaterThan(score30);
    expect(score30).toBeGreaterThanOrEqual(10);
  });

  it('typical session (50 calls, 3 tools, 40min) exceeds threshold of 35', () => {
    const now = Date.now();
    const events: DashboardEvent[] = [];
    for (let i = 0; i < 50; i++) {
      const tools = ['Bash', 'Read', 'Edit'];
      const minutesAgo = 40 - (i * 40) / 50;
      events.push(
        makeEvent({
          toolName: tools[i % 3],
          timestamp: new Date(now - minutesAgo * 60 * 1000).toISOString(),
        }),
      );
    }

    const score = computeSmartScore(events);
    expect(score).toBeGreaterThanOrEqual(35);
  });
});

// ─── contributeCheckForSession (Stop hook integration) ─────

/**
 * Build a high-scoring session worth of events on disk.
 * Score must comfortably clear CONTRIBUTE_SMART_THRESHOLD (35).
 */
async function seedHighScoreSession(sessionId: string, opts?: { count?: number }): Promise<void> {
  const count = opts?.count ?? 50;
  const now = Date.now();
  const tools = ['Bash', 'Read', 'Edit', 'Skill', 'Grep'];
  for (let i = 0; i < count; i++) {
    await appendEvent({
      type: 'tool_use',
      sessionId,
      tool: 'claude',
      toolName: tools[i % tools.length],
      timestamp: new Date(now - ((count - i) * 60 * 1000)).toISOString(),
    });
  }
}

describe('contributeCheckForSession', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fast-path: low toolCount + fresh cache → no hint, no events read, state untouched', async () => {
    const sessionId = 'fp-fresh';
    const initialState: ContributeState = {
      contributed: false,
      toolCount: CONTRIBUTE_BASE_THRESHOLD - 1,
      lastEvaluated: Date.now(),
      smartScore: 5,
    };
    await writeContributeState(sessionId, initialState);

    // Seed events that *would* score high if read — but fast-path should skip.
    await seedHighScoreSession(sessionId);

    const before = await readContributeState(sessionId);
    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(result.hint).toBeNull();
    // Proof that events were not read & re-scored: state is unchanged.
    expect(after.toolCount).toBe(before.toolCount);
    expect(after.lastEvaluated).toBe(before.lastEvaluated);
    expect(after.smartScore).toBe(before.smartScore);
  });

  it('fast-path expires: low toolCount + STALE cache → re-evaluate (state updated)', async () => {
    const sessionId = 'fp-stale';
    // Snapshot far outside the debounce window (much older than 5 min).
    const veryOld = Date.now() - CONTRIBUTE_FASTPATH_TTL_MS - 60 * 60 * 1000;
    await writeContributeState(sessionId, {
      contributed: false,
      toolCount: CONTRIBUTE_BASE_THRESHOLD - 1,
      lastEvaluated: veryOld,
      smartScore: 5,
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    // Re-evaluation happened: lastEvaluated advanced, toolCount reflects real events,
    // and the high-scoring session produced a hint.
    expect(after.lastEvaluated).toBeGreaterThan(veryOld);
    expect(after.toolCount).toBeGreaterThanOrEqual(50);
    expect(after.smartScore).toBeGreaterThanOrEqual(CONTRIBUTE_SMART_THRESHOLD);
    expect(result.hint).not.toBeNull();
  });

  // Regression: a stale toolCount=0 snapshot must not suppress evaluation
  // once it falls outside the debounce window.
  it('fast-path debounce: low-toolCount snapshot older than 5min → re-evaluate (regression)', async () => {
    const sessionId = 'fp-debounce-expired';
    const tenMinAgo = Date.now() - CONTRIBUTE_FASTPATH_TTL_MS - 5 * 60 * 1000;
    await writeContributeState(sessionId, {
      contributed: false,
      toolCount: 0,                    // snapshot captured before tools ran
      lastEvaluated: tenMinAgo,        // 10 min ago — past the 5-min debounce
      smartScore: 0,
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(after.toolCount).toBeGreaterThanOrEqual(50);
    expect(after.smartScore).toBeGreaterThanOrEqual(CONTRIBUTE_SMART_THRESHOLD);
    expect(result.hint).not.toBeNull();
  });

  // Regression: even when all display fields (smartScore/toolCount/uniqueTools)
  // are present in state, they must not be reused as a "cache hit" past the
  // debounce window — Layer 2 now shares the same debounce as Layer 1.
  it('layer-2 cache-hit expiry: stale (smartScore=0, toolCount=0) past debounce → re-scan events', async () => {
    const sessionId = 'l2-cache-stale';
    const tenMinAgo = Date.now() - CONTRIBUTE_FASTPATH_TTL_MS - 5 * 60 * 1000;
    await writeContributeState(sessionId, {
      contributed: false,
      toolCount: 0,
      uniqueTools: 0,
      smartScore: 0,
      lastEvaluated: tenMinAgo,
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    // Must have re-scanned events, not reused the stale (score=0) cache.
    expect(after.toolCount).toBeGreaterThanOrEqual(50);
    expect(after.smartScore).toBeGreaterThan(0);
    expect(after.smartScore).toBeGreaterThanOrEqual(CONTRIBUTE_SMART_THRESHOLD);
    expect(result.hint).not.toBeNull();
  });

  it('cache hit: high cached score + fresh display fields → reuse cache, emit hint', async () => {
    const sessionId = 'cache-hit';
    const now = Date.now();
    await writeContributeState(sessionId, {
      contributed: false,
      toolCount: 100,
      uniqueTools: 7,
      lastEvaluated: now,
      smartScore: 80,
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(result.hint).not.toBeNull();
    // Hint message uses cached display values (not recomputed from events)
    expect(result.hint).toContain('100 次工具调用');
    expect(result.hint).toContain('7 种不同工具');
    // Cached score preserved
    expect(after.smartScore).toBe(80);
    expect(after.toolCount).toBe(100);
    expect(after.uniqueTools).toBe(7);
    // lastEvaluated unchanged on cache hit + only-hinted-flag write
    expect(after.lastEvaluated).toBe(now);
    expect(after.hinted).toBe(true);
  });

  it('hint dedup: once hinted=true, subsequent calls return null even with fresh cache', async () => {
    const sessionId = 'dedup';
    await writeContributeState(sessionId, {
      contributed: false,
      toolCount: 100,
      lastEvaluated: Date.now(),
      smartScore: 80,
      hinted: true,
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    expect(result.hint).toBeNull();
  });

  it('contributed=true short-circuits before any I/O', async () => {
    const sessionId = 'contributed';
    await writeContributeState(sessionId, { contributed: true });

    const result = await contributeCheckForSession(sessionId);
    expect(result.hint).toBeNull();
  });

  it('first run on empty state: no cache → reads events, persists toolCount/lastEvaluated/smartScore', async () => {
    const sessionId = 'first-run';
    await seedHighScoreSession(sessionId);

    const before = await readContributeState(sessionId);
    expect(before.lastEvaluated).toBeUndefined();

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(result.hint).not.toBeNull();
    expect(after.lastEvaluated).toBeDefined();
    expect(after.toolCount).toBeGreaterThan(0);
    expect(after.smartScore).toBeGreaterThanOrEqual(CONTRIBUTE_SMART_THRESHOLD);
    expect(after.hinted).toBe(true);
  });

  it('M3: cache hit emits hint WITHOUT reading events.jsonl (display from cache)', async () => {
    const sessionId = 'cache-no-events';
    const now = Date.now();
    // Cache fully primed
    await writeContributeState(sessionId, {
      contributed: false,
      smartScore: 80,
      toolCount: 42,
      uniqueTools: 9,
      lastEvaluated: now,
    });
    // Intentionally do NOT seed any events; no file at all.
    // If the implementation tried to readEvents() it would get [] and
    // computeSmartScore would yield 0 < threshold → no hint.

    const result = await contributeCheckForSession(sessionId);

    expect(result.hint).not.toBeNull();
    expect(result.hint).toContain('42 次工具调用');
    expect(result.hint).toContain('9 种不同工具');
  });

  it('M3: cache fresh but uniqueTools missing → falls back to cache miss (re-reads events)', async () => {
    const sessionId = 'cache-partial';
    const now = Date.now();
    // Legacy state (pre-uniqueTools): smartScore + toolCount + lastEvaluated
    // present, uniqueTools absent. Code must re-evaluate to get a complete
    // display rather than emit hint with bogus uniqueTools=0.
    await writeContributeState(sessionId, {
      contributed: false,
      smartScore: 80,
      toolCount: 100,
      lastEvaluated: now,
      // uniqueTools intentionally omitted
    });
    await seedHighScoreSession(sessionId);

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(result.hint).not.toBeNull();
    expect(after.uniqueTools).toBeGreaterThan(0);
    // smartScore is now the freshly computed value, not the legacy 80
    expect(after.smartScore).not.toBe(80);
  });

  it('M1: cache miss + high score performs exactly ONE writeContributeState (not two)', async () => {
    const sessionId = 'cache-miss-one-write';
    // Fresh session — no prior state; will go through cache-miss + high-score path.
    await seedHighScoreSession(sessionId);

    // cleanupStaleSessions runs exactly once per writeContributeState and is the
    // only consumer of fs.promises.readdir on the sessions dir. So the readdir
    // count on that dir == number of writes.
    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');

    await contributeCheckForSession(sessionId);

    const writesOnSessionsDir = readdirSpy.mock.calls.filter(
      ([target]) => typeof target === 'string' && target === sessionsDir,
    );
    // Pre-fix: 2 writes (smartScore then hinted=true) → 2 readdirs.
    // Post-fix: 1 combined write → 1 readdir.
    expect(writesOnSessionsDir.length).toBe(1);

    readdirSpy.mockRestore();
  });

  it('M1: cache hit + low score performs ZERO writes (state already current)', async () => {
    const sessionId = 'zero-write';
    const originalLastEvaluated = Date.now() - 1000;
    await writeContributeState(sessionId, {
      contributed: false,
      smartScore: 5, // below threshold
      toolCount: 100, // ≥ BASE_THRESHOLD so fast-path doesn't kick
      uniqueTools: 1,
      lastEvaluated: originalLastEvaluated,
    });

    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');

    await contributeCheckForSession(sessionId);

    const writesOnSessionsDir = readdirSpy.mock.calls.filter(
      ([target]) => typeof target === 'string' && target === sessionsDir,
    );
    // Cache hit + low score → no write needed at all.
    expect(writesOnSessionsDir.length).toBe(0);

    readdirSpy.mockRestore();
  });

  it('low-score session: events read, score below threshold → no hint, hinted not set', async () => {
    const sessionId = 'low-score';
    // Tiny session — single tool, no diversity, no skill/error/duration
    for (let i = 0; i < 3; i++) {
      await appendEvent({
        type: 'tool_use',
        sessionId,
        tool: 'claude',
        toolName: 'Bash',
        timestamp: new Date().toISOString(),
      });
    }

    const result = await contributeCheckForSession(sessionId);
    const after = await readContributeState(sessionId);

    expect(result.hint).toBeNull();
    expect(after.smartScore).toBeLessThan(CONTRIBUTE_SMART_THRESHOLD);
    expect(after.hinted).toBeUndefined();
    // toolCount persisted so future fast-path can kick in
    expect(after.toolCount).toBe(3);
  });
});

// ─── Race / dedup edge cases (M2 + L4) ─────────────────────

describe('contributeCheckForSession concurrency safety', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('M2: contributed=true set during evaluation is NOT clobbered by the score write', async () => {
    const sessionId = 'race-contributed';
    await writeContributeState(sessionId, { contributed: false });
    await seedHighScoreSession(sessionId);

    // Inject /contribute racing: between contribute-check's first read and its
    // write, simulate the user running /contribute (markContributed equivalent).
    // We hook into readEvents because it's the await between read and write
    // in the cache-miss path.
    const dashboardCollector = await import('../dashboard-collector.js');
    const realReadEvents = dashboardCollector.readEvents;
    const spy = vi
      .spyOn(dashboardCollector, 'readEvents')
      .mockImplementationOnce(async () => {
        const cur = await readContributeState(sessionId);
        await writeContributeState(sessionId, { ...cur, contributed: true });
        return await realReadEvents();
      });

    await contributeCheckForSession(sessionId);
    spy.mockRestore();

    const final = await readContributeState(sessionId);
    expect(final.contributed).toBe(true);
  });

  it('L4: markContributed preserves hinted flag', async () => {
    const { markContributed } = await import('../contribute-check.js');
    const sessionId = 'preserve-hinted';
    await writeContributeState(sessionId, {
      contributed: false,
      hinted: true,
      smartScore: 80,
      toolCount: 100,
      lastEvaluated: Date.now(),
    });

    await markContributed(sessionId);
    const after = await readContributeState(sessionId);

    expect(after.contributed).toBe(true);
    // Crucial: pre-existing fields not wiped
    expect(after.hinted).toBe(true);
    expect(after.smartScore).toBe(80);
    expect(after.toolCount).toBe(100);
  });
});

// ─── L2: sessionId path safety ─────────────────────────────

describe('sessionId filesystem safety (L2)', () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PID-fallback sessionId containing "/" does NOT create nested directories', async () => {
    // Mirrors the readStdinAndDeriveSession PID fallback shape.
    const sessionId = 'pid-12345-/Users/jeff/projects/foo';

    await writeContributeState(sessionId, { contributed: false, smartScore: 5 });

    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    const entries = fs.readdirSync(sessionsDir);

    // Exactly one .json file, no nested directories
    expect(entries.length).toBe(1);
    const entry = entries[0];
    const stat = fs.statSync(path.join(sessionsDir, entry));
    expect(stat.isFile()).toBe(true);
    expect(entry.endsWith('.json')).toBe(true);
    // The file name must not contain a path separator
    expect(entry.includes('/')).toBe(false);
    expect(entry.includes(path.sep)).toBe(false);
  });

  it('round-trips state for a sessionId with "/"', async () => {
    const sessionId = 'pid-99999-/some/cwd/path';
    const original: ContributeState = {
      contributed: false,
      smartScore: 42,
      toolCount: 25,
      lastEvaluated: 1234567890,
      hinted: true,
    };

    await writeContributeState(sessionId, original);
    const read = await readContributeState(sessionId);

    expect(read).toEqual(original);
  });

  it('cleanupStaleSessions skips the current session even when its filename was sanitized', async () => {
    const { cleanupStaleSessions } = await import('../contribute-check.js');

    // Raw sessionId with "/" → sanitized to "_" on disk.
    const sessionId = 'pid-12345-/Users/jeff/proj';
    await writeContributeState(sessionId, { contributed: false });

    const sessionsDir = path.join(tmpDir, '.teamai', 'sessions');
    const files = fs.readdirSync(sessionsDir);
    expect(files.length).toBe(1);
    const filePath = path.join(sessionsDir, files[0]);

    // Backdate the file to look stale (>24h old). cleanup uses mtime to decide
    // staleness, but MUST still skip the file because it belongs to the
    // currently-active session — otherwise a long-running session that has not
    // re-written its state file in 24h would have its state silently deleted
    // out from under it.
    const past = Date.now() - 25 * 60 * 60 * 1000;
    fs.utimesSync(filePath, new Date(past), new Date(past));

    await cleanupStaleSessions(sessionsDir, sessionId);

    expect(fs.existsSync(filePath)).toBe(true);
  });
});
