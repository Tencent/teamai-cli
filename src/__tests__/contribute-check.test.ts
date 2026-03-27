import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readContributeState,
  writeContributeState,
  computeSmartScore,
} from '../contribute-check.js';
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

// ─── contributeState read/write ────────────────────────────

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

  it('returns defaults when state file is missing', async () => {
    const state = await readContributeState('session-abc');
    expect(state).toEqual({
      sessionId: 'session-abc',
      toolCount: 0,
      hinted: false,
      contributed: false,
    });
  });

  it('returns defaults when state file is corrupted JSON', async () => {
    const statePath = path.join(tmpDir, '.teamai', 'contribute-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{broken json!!!}', 'utf-8');

    const state = await readContributeState('session-abc');
    expect(state.sessionId).toBe('session-abc');
    expect(state.toolCount).toBe(0);
  });

  it('reads back written state for same session', async () => {
    const state: ContributeState = {
      sessionId: 'session-xyz',
      toolCount: 42,
      hinted: true,
      contributed: false,
    };
    await writeContributeState(state);

    const read = await readContributeState('session-xyz');
    expect(read).toEqual(state);
  });

  it('returns defaults when sessionId differs from stored state', async () => {
    const state: ContributeState = {
      sessionId: 'old-session',
      toolCount: 99,
      hinted: true,
      contributed: false,
    };
    await writeContributeState(state);

    const read = await readContributeState('new-session');
    expect(read.sessionId).toBe('new-session');
    expect(read.toolCount).toBe(0);
    expect(read.hinted).toBe(false);
  });
});

// ─── computeSmartScore ─────────────────────────────────────

describe('computeSmartScore', () => {
  it('returns 0 for empty events', () => {
    expect(computeSmartScore([])).toBe(0);
  });

  it('scores low for single-tool repetitive session', () => {
    // 100 calls of the same tool — low diversity
    const events = Array.from({ length: 100 }, () =>
      makeEvent({ toolName: 'Bash' }),
    );
    const score = computeSmartScore(events);
    // diversity: 1/20 * 30 = 1.5 → round to 2
    // No skills, no errors, no duration
    expect(score).toBeLessThan(30);
  });

  it('scores high for diverse session with skills and errors', () => {
    const now = Date.now();
    const events: DashboardEvent[] = [
      // 40 min ago
      makeEvent({ toolName: 'Read', timestamp: new Date(now - 40 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Edit', timestamp: new Date(now - 35 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Bash', timestamp: new Date(now - 30 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Skill', timestamp: new Date(now - 25 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Write', timestamp: new Date(now - 20 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Grep', timestamp: new Date(now - 15 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Agent', timestamp: new Date(now - 10 * 60 * 1000).toISOString() }),
      // Error in prompt
      makeEvent({
        type: 'prompt_submit',
        promptSummary: 'fix the build error',
        timestamp: new Date(now - 5 * 60 * 1000).toISOString(),
      }),
      // Recent
      makeEvent({ toolName: 'Edit', timestamp: new Date(now).toISOString() }),
    ];

    const score = computeSmartScore(events);
    // diversity: high (7 unique / 8 tool_use = 0.875 → 26)
    // hasSkills: +25
    // hasErrors: +25
    // duration > 30 min: +20
    // Total: ~96
    expect(score).toBeGreaterThanOrEqual(60);
  });

  it('gives 25 points for skill usage', () => {
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
    expect(scoreWithSkill - scoreBase).toBeGreaterThanOrEqual(20); // ~25 but diversity changes too
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
    // error: +25, some diversity points
    expect(score).toBeGreaterThanOrEqual(25);
  });

  it('gives 20 points for long sessions', () => {
    const now = Date.now();
    const events: DashboardEvent[] = [
      makeEvent({ toolName: 'Bash', timestamp: new Date(now - 60 * 60 * 1000).toISOString() }),
      makeEvent({ toolName: 'Bash', timestamp: new Date(now).toISOString() }),
    ];
    const score = computeSmartScore(events);
    // 1 unique tool / 2 calls → diversity low
    // duration > 30 min → +20
    expect(score).toBeGreaterThanOrEqual(20);
  });
});
