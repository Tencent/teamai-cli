import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
}));

import {
  buildTurnLimitHintMessage,
  resolveTurnLimit,
  isTurnHintDisabled,
  recordTurnAndShouldHint,
  hasPendingTurnLimitHint,
  acknowledgeTurnLimitHint,
  isMuteSignal,
  getTurnLimitCachePath,
} from '../turn-limit-hint.js';

describe('buildTurnLimitHintMessage', () => {
  it('contains the [teamai:turn-limit-hint] prefix', () => {
    expect(buildTurnLimitHintMessage()).toContain('[teamai:turn-limit-hint]');
  });

  it('uses concise Chinese copy', () => {
    const msg = buildTurnLimitHintMessage();
    expect(msg).toMatch(/当前会话/);
    expect(msg).not.toMatch(/Long sessions/);
  });

  it('tells the user how to disable the reminder', () => {
    const msg = buildTurnLimitHintMessage();
    expect(msg).toContain('TEAMAI_TURN_HINT_DISABLED=1');
    expect(msg).toMatch(/关闭轮次提醒/);
  });

  it('does not instruct the model to repeat already-visible Stop feedback', () => {
    expect(buildTurnLimitHintMessage()).not.toContain('Print the following message verbatim to the user');
  });
});

describe('resolveTurnLimit', () => {
  const original = process.env.TEAMAI_TURN_LIMIT;

  afterEach(() => {
    if (original === undefined) delete process.env.TEAMAI_TURN_LIMIT;
    else process.env.TEAMAI_TURN_LIMIT = original;
  });

  it('defaults to 20 when unset', () => {
    delete process.env.TEAMAI_TURN_LIMIT;
    expect(resolveTurnLimit()).toBe(20);
  });

  it('respects TEAMAI_TURN_LIMIT when set to a valid number', () => {
    process.env.TEAMAI_TURN_LIMIT = '5';
    expect(resolveTurnLimit()).toBe(5);
  });

  it('falls back to 20 for non-numeric values', () => {
    process.env.TEAMAI_TURN_LIMIT = 'abc';
    expect(resolveTurnLimit()).toBe(20);
  });

  it('falls back to 20 for zero or negative', () => {
    process.env.TEAMAI_TURN_LIMIT = '0';
    expect(resolveTurnLimit()).toBe(20);
    process.env.TEAMAI_TURN_LIMIT = '-5';
    expect(resolveTurnLimit()).toBe(20);
  });
});

describe('isTurnHintDisabled', () => {
  const original = process.env.TEAMAI_TURN_HINT_DISABLED;

  afterEach(() => {
    if (original === undefined) delete process.env.TEAMAI_TURN_HINT_DISABLED;
    else process.env.TEAMAI_TURN_HINT_DISABLED = original;
  });

  it('returns false when unset', () => {
    delete process.env.TEAMAI_TURN_HINT_DISABLED;
    expect(isTurnHintDisabled()).toBe(false);
  });

  it('returns true when set to 1', () => {
    process.env.TEAMAI_TURN_HINT_DISABLED = '1';
    expect(isTurnHintDisabled()).toBe(true);
  });
});

describe('recordTurnAndShouldHint — counting and recurring hints', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-turnlimit-test-'));
    await fse.ensureDir(path.join(tmpHome, '.teamai', 'sessions'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  it('returns false before reaching the limit', () => {
    for (let i = 1; i < 20; i++) {
      expect(recordTurnAndShouldHint('session-A', 20)).toBe(false);
    }
  });

  it('returns true the first time count reaches the limit', () => {
    for (let i = 1; i < 20; i++) {
      recordTurnAndShouldHint('session-B', 20);
    }
    expect(recordTurnAndShouldHint('session-B', 20)).toBe(true);
  });

  it('returns true every 3 turns after the limit (recurring, not one-shot)', () => {
    // limit=3, interval=3 → hint at count 3, 6, 9, ...
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=1
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=2
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(true);  // count=3 (limit)
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=4
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=5
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(true);  // count=6 (limit+3)
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=7
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(false); // count=8
    expect(recordTurnAndShouldHint('session-recur', 3)).toBe(true);  // count=9 (limit+6)
  });

  it('keeps a scheduled reminder pending until Stop delivery acknowledges it', () => {
    recordTurnAndShouldHint('session-pending', 3); // count=1
    recordTurnAndShouldHint('session-pending', 3); // count=2
    expect(recordTurnAndShouldHint('session-pending', 3)).toBe(true); // count=3
    expect(hasPendingTurnLimitHint('session-pending')).toBe(true);

    // Further turns do not lose the pending reminder before Stop can deliver it.
    expect(recordTurnAndShouldHint('session-pending', 3)).toBe(false); // count=4
    expect(hasPendingTurnLimitHint('session-pending')).toBe(true);

    acknowledgeTurnLimitHint('session-pending');
    expect(hasPendingTurnLimitHint('session-pending')).toBe(false);

    // The next interval schedules another reminder.
    recordTurnAndShouldHint('session-pending', 3); // count=5
    expect(recordTurnAndShouldHint('session-pending', 3)).toBe(true); // count=6
    expect(hasPendingTurnLimitHint('session-pending')).toBe(true);
  });

  it('treats different sessions independently', () => {
    for (let i = 1; i < 20; i++) {
      recordTurnAndShouldHint('session-D', 20);
    }
    expect(recordTurnAndShouldHint('session-D', 20)).toBe(true);
    // session-E is fresh
    expect(recordTurnAndShouldHint('session-E', 20)).toBe(false);
  });

  it('respects a custom limit', () => {
    expect(recordTurnAndShouldHint('session-F', 3)).toBe(false);
    expect(recordTurnAndShouldHint('session-F', 3)).toBe(false);
    expect(recordTurnAndShouldHint('session-F', 3)).toBe(true);
    expect(recordTurnAndShouldHint('session-F', 3)).toBe(false);
  });

  it('writes the cache file under ~/.teamai/sessions/<sid>-turn-count.json', () => {
    recordTurnAndShouldHint('session-path-test', 20);
    const expectedPath = getTurnLimitCachePath('session-path-test');
    expect(expectedPath).toContain(path.join('.teamai', 'sessions'));
    expect(expectedPath).toContain('session-path-test-turn-count.json');
    expect(fse.pathExistsSync(expectedPath)).toBe(true);
  });

  it('sanitizes session IDs before using them in cache paths', () => {
    const cachePath = getTurnLimitCachePath('../../outside');
    expect(cachePath).toContain('.._.._outside-turn-count.json');
    expect(cachePath).toContain(path.join('.teamai', 'sessions'));
  });

  it('persists count across calls (simulating process restart)', () => {
    // Simulate 19 calls in one "process"
    for (let i = 1; i < 20; i++) {
      recordTurnAndShouldHint('session-restart', 20);
    }
    // The 20th call in a new "process" should still see count=19 and trigger
    expect(recordTurnAndShouldHint('session-restart', 20)).toBe(true);
  });
});

describe('recordTurnAndShouldHint — TTL reset', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-turnlimit-ttl-'));
    await fse.ensureDir(path.join(tmpHome, '.teamai', 'sessions'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  it('treats cache older than 24h as fresh (resets count)', async () => {
    // Write a stale cache: count=19, 25h ago
    const cachePath = getTurnLimitCachePath('session-stale');
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await fse.writeJson(cachePath, { count: 19, updatedAt: staleTime });

    // Should NOT hint on first call (stale cache ignored, count starts at 1)
    expect(recordTurnAndShouldHint('session-stale', 20)).toBe(false);
  });

  it('treats cache older than 24h as fresh (resets count past limit)', async () => {
    // Write a stale cache: count=25 (already past limit), 25h ago
    const cachePath = getTurnLimitCachePath('session-stale-past');
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await fse.writeJson(cachePath, { count: 25, updatedAt: staleTime });

    // Should be able to hint again after TTL reset (count starts at 1)
    for (let i = 1; i < 20; i++) {
      recordTurnAndShouldHint('session-stale-past', 20);
    }
    expect(recordTurnAndShouldHint('session-stale-past', 20)).toBe(true);
  });
});

describe('isMuteSignal', () => {
  it('detects Chinese mute keyword', () => {
    expect(isMuteSignal('请关闭轮次提醒，太烦了')).toBe(true);
    expect(isMuteSignal('别再提醒了')).toBe(true);
  });

  it('detects English mute keyword (case-insensitive)', () => {
    expect(isMuteSignal('please disable turn hint')).toBe(true);
    expect(isMuteSignal('DISABLE TURN HINT')).toBe(true);
    expect(isMuteSignal('turn hint off')).toBe(true);
  });

  it('returns false for normal prompts', () => {
    expect(isMuteSignal('帮我写一个函数')).toBe(false);
    expect(isMuteSignal('how does this work?')).toBe(false);
  });
});

describe('recordTurnAndShouldHint — per-session mute', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-mute-test-'));
    await fse.ensureDir(path.join(tmpHome, '.teamai', 'sessions'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpHome);
  });

  it('mutes the current session when user sends mute keyword', () => {
    // limit=3, reach the limit first
    recordTurnAndShouldHint('session-mute', 3); // count=1
    recordTurnAndShouldHint('session-mute', 3); // count=2
    expect(recordTurnAndShouldHint('session-mute', 3)).toBe(true); // count=3, hint!

    // User says "关闭轮次提醒" → this turn is muted, no hint, and any
    // reminder waiting for Stop delivery is discarded.
    expect(recordTurnAndShouldHint('session-mute', 3, '请关闭轮次提醒')).toBe(false); // count=4
    expect(hasPendingTurnLimitHint('session-mute')).toBe(false);

    // Subsequent turns in the same session stay muted
    expect(recordTurnAndShouldHint('session-mute', 3, '继续工作')).toBe(false); // count=5
    expect(recordTurnAndShouldHint('session-mute', 3, '继续工作')).toBe(false); // count=6 (would have hinted)
  });

  it('does not affect other sessions', () => {
    // Mute session-X
    recordTurnAndShouldHint('session-X', 3, '关闭轮次提醒');

    // session-Y is independent and still gets hints
    expect(recordTurnAndShouldHint('session-Y', 3)).toBe(false); // count=1
    expect(recordTurnAndShouldHint('session-Y', 3)).toBe(false); // count=2
    expect(recordTurnAndShouldHint('session-Y', 3)).toBe(true);  // count=3, hint!
  });

  it('mute keyword in a normal-length prompt works', () => {
    // Long prompt that happens to contain the keyword
    const prompt = '我正在调试一个问题，顺便说一下请关闭轮次提醒，谢谢';
    expect(recordTurnAndShouldHint('session-long', 3, prompt)).toBe(false);

    // Session is now muted
    recordTurnAndShouldHint('session-long', 3); // count=2
    recordTurnAndShouldHint('session-long', 3); // count=3 (would have hinted)
    // Verify via cache
    const cache = JSON.parse(
      fse.readFileSync(getTurnLimitCachePath('session-long'), 'utf-8'),
    );
    expect(cache.muted).toBe(true);
  });
});
