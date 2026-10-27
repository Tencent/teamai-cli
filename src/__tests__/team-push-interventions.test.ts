import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import type { LocalConfig } from '../types.js';

// Stub out reports-branch writes so we exercise reportUsage's reporting
// logic (delta → stats yaml → reported snapshot) without a real remote.
const reportsMocks = vi.hoisted(() => ({
  updateReports: vi.fn(),
}));
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: (...args: unknown[]) => reportsMocks.updateReports(...args),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// VOTES_LOCAL_DIR is resolved at module load against the real HOME, so isolate
// vote staging from the developer's actual ~/.teamai/votes to keep the test hermetic.
vi.mock('../utils/fs.js', async (importActual) => {
  const actual = await importActual<typeof import('../utils/fs.js')>();
  return {
    ...actual,
    pathExists: vi.fn(async (p: string) => (p.includes(`${path.sep}votes`) ? false : actual.pathExists(p))),
  };
});

import { reportUsage } from '../team-push.js';
import { dataHomeKey } from '../dashboard-collector.js';
import { withTimeout } from '../utils/async.js';

let tmpDir: string;
let repoDir: string;
let originalHome: string;
/** `dataHomeKey()` of the user scope that `gitConfig()` reports. */
let userKey: string;

function gitConfig(): LocalConfig {
  return {
    repo: { localPath: repoDir, remote: 'https://example.com/team.git', kind: 'git' },
    username: 'me',
    scope: 'user',
    additionalRoles: [],
  };
}

function reportsStatsPath(): string {
  return path.join(tmpDir, 'reports-wt', 'stats', 'me.yaml');
}

/**
 * A reported snapshot as the report left it, `{}` when it wrote none: the user
 * scope's own (#786), or the shared one for a caller without a scope config.
 */
function reportedSnapshot(name: string, scoped = true): Record<string, unknown> {
  const p = path.join(tmpDir, '.teamai', 'dashboard', `${scoped ? 'user-' : ''}reported-${name}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : {};
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tp-iv-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  userKey = await dataHomeKey(path.join(tmpDir, '.teamai'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  // The 'review' skill these tests record usage for must be part of the team's
  // shared catalog: #1055 filters published stats to catalog names, and these
  // tests exercise reporting mechanics, not the privacy filter.
  fs.mkdirSync(path.join(repoDir, 'skills', 'review'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'skills', 'review', 'SKILL.md'), '# review\n');
  reportsMocks.updateReports.mockReset().mockImplementation(async (cfg: LocalConfig, write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<{ files: string[]; message: string } | null>) => {
    const dir = path.join(path.dirname(cfg.repo.localPath), 'reports-wt');
    fs.mkdirSync(dir, { recursive: true });
    const delivered: (() => Promise<void>)[] = [];
    const change = await write(dir, { onDelivered: (fn) => { delivered.push(fn); } });
    for (const fn of delivered) await fn();
    return { status: change != null ? 'published' : 'already-present' };
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Sessions the user scope recorded (#785), the scope `gitConfig()` reports. */
function writeDashboardEvents(lines: object[]): void {
  const p = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.map((l) => JSON.stringify({ ...l, dataHomeKey: userKey })).join('\n') + '\n');
}

describe('reportUsage — intervention reporting', () => {
  function seedReport(): string {
    const timestamp = new Date().toISOString();
    writeDashboardEvents([
      { type: 'session_start', timestamp, sessionId: 'slow', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp, sessionId: 'slow', tool: 'claude', promptSummary: 'hi' },
      { type: 'stop', timestamp, sessionId: 'slow', tool: 'claude',
        interventions: { interrupt: 1, toolReject: 0 },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 } },
    ]);
    const usagePath = path.join(tmpDir, '.teamai', 'user-usage.jsonl');
    fs.writeFileSync(usagePath, JSON.stringify({ skill: 'review', timestamp, tool: 'claude' }) + '\n');
    return usagePath;
  }

  it('skips HTTP repos', async () => {
    const config = gitConfig();
    config.repo.kind = 'http';

    expect(await reportUsage(repoDir, 'me', { selfConfig: config })).toBe('unreported');
    expect(reportsMocks.updateReports).not.toHaveBeenCalled();
  });

  it('finishes acknowledgement after the caller times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const usagePath = seedReport();
    let finish!: (value: { status: 'published' }) => void;
    let started!: () => void;
    const pushStarted = new Promise<void>((resolve) => { started = resolve; });
    const pushResult = new Promise<{ status: 'published' }>((resolve) => { finish = resolve; });
    const delayedPush = () => { started(); return pushResult; };
    reportsMocks.updateReports.mockImplementationOnce(async (cfg: LocalConfig, write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<{ files: string[]; message: string } | null>) => {
      const dir = path.join(path.dirname(cfg.repo.localPath), 'reports-wt');
      fs.mkdirSync(dir, { recursive: true });
      const delivered: (() => Promise<void>)[] = [];
      await write(dir, { onDelivered: (fn) => { delivered.push(fn); } });
      const result = await delayedPush();
      for (const fn of delivered) await fn();
      return result;
    });

    const operation = reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    const timeout = expect(withTimeout(operation, 5000, 'report pending')).rejects.toThrow('report pending');
    await pushStarted;
    await vi.advanceTimersByTimeAsync(5000);
    await timeout;
    expect(fs.readFileSync(usagePath, 'utf-8')).toContain('review');
    expect(reportedSnapshot('prompt-tokens').slow).toBeUndefined();

    finish({ status: 'published' });
    expect(await operation).toBe('reported');
    expect(fs.readFileSync(usagePath, 'utf-8')).toBe('');
    for (const name of ['interventions', 'prompt-tokens', 'daily-sessions']) {
      expect(reportedSnapshot(name).slow).toBeDefined();
    }
    const statsPath = reportsStatsPath();
    const before = fs.readFileSync(statsPath, 'utf-8');
    expect(await reportUsage(repoDir, 'me', { selfConfig: gitConfig() })).toBe('nothing');
    expect(fs.readFileSync(statsPath, 'utf-8')).toBe(before);
  });

  it.each(['false', 'rejection'])('retains events and snapshots when push returns %s', async (failure) => {
    const usagePath = seedReport();
    const before = fs.readFileSync(usagePath, 'utf-8');
    if (failure === 'false') reportsMocks.updateReports.mockResolvedValueOnce({ status: 'failed', reason: 'not confirmed' });
    else reportsMocks.updateReports.mockRejectedValueOnce(new Error('offline'));
    expect(await reportUsage(repoDir, 'me', { selfConfig: gitConfig() })).toBe('unreported');
    expect(fs.readFileSync(usagePath, 'utf-8')).toBe(before);
    for (const name of ['interventions', 'prompt-tokens', 'daily-sessions']) {
      expect(reportedSnapshot(name).slow).toBeUndefined();
    }
    expect(await reportUsage(repoDir, 'me', { selfConfig: gitConfig() })).toBe('reported');
    const stats = YAML.parse(fs.readFileSync(reportsStatsPath(), 'utf-8'));
    expect(stats.skills.review.count).toBe(1);
    expect(stats.prompts).toBe(1);
    expect(stats.tokens.input).toBe(10);
  });

  it('writes intervention totals into stats/<user>.yaml and advances the reported snapshot', async () => {
    const ts = new Date().toISOString();
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude', interventions: { interrupt: 2, toolReject: 1 } },
    ]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    // stats yaml carries the merged intervention totals on the reports worktree
    const statsPath = reportsStatsPath();
    expect(fs.existsSync(statsPath)).toBe(true);
    const stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.interventions).toEqual({ sessions: 1, interrupt: 2, toolReject: 1, correction: 0 });
    expect(stats.daily[ts.slice(0, 10)]).toMatchObject({ sessionsEnded: 1, sessionsSucceeded: 0 });

    expect(reportsMocks.updateReports).toHaveBeenCalledTimes(1);

    // reported snapshot persisted so a second run reports nothing new
    expect(reportedSnapshot('interventions')).toEqual({
      s1: { interrupt: 2, toolReject: 1, correction: 0 },
    });
    expect(reportedSnapshot('daily-sessions').s1).toMatchObject({ date: ts.slice(0, 10) });

    reportsMocks.updateReports.mockClear();
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    // Nothing new (no usage, no intervention delta, no votes) → no push
    expect(reportsMocks.updateReports).not.toHaveBeenCalled();
  });

  it('does nothing when there are no events, interventions, or votes', async () => {
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    expect(reportsMocks.updateReports).not.toHaveBeenCalled();
    expect(fs.existsSync(reportsStatsPath())).toBe(false);
  });
});

describe('reportUsage — preserve fields across partial reports (Issue #425)', () => {
  it('keeps interventions when a follow-up report is tokens-only', async () => {
    const ts = new Date().toISOString();
    // Report 1: interventions + prompts/tokens together
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'hi' },
      {
        type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude',
        interventions: { interrupt: 2, toolReject: 1 },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    const statsPath = reportsStatsPath();
    let stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.interventions).toEqual({ sessions: 1, interrupt: 2, toolReject: 1, correction: 0 });
    expect(stats.prompts).toBe(1);
    expect(stats.tokens).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });

    // Report 2: tokens/prompts advance only — same intervention counts (no intervention delta)
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'hi' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'more' },
      {
        type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude',
        interventions: { interrupt: 2, toolReject: 1 },
        tokens: { input: 50, output: 20, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
    reportsMocks.updateReports.mockClear();
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    // Must still have interventions after a tokens-only report
    expect(stats.interventions).toEqual({ sessions: 1, interrupt: 2, toolReject: 1, correction: 0 });
    expect(stats.prompts).toBe(2);
    expect(stats.tokens).toEqual({ input: 50, output: 20, cacheRead: 0, cacheCreation: 0 });
    expect(reportsMocks.updateReports).toHaveBeenCalledTimes(1);
  });

  it('keeps prompts/tokens when a follow-up report is intervention-only', async () => {
    const ts = new Date().toISOString();
    // Report 1: prompts/tokens only (no intervention counts yet)
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'hi' },
      {
        type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude',
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    const statsPath = reportsStatsPath();
    let stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.prompts).toBe(1);
    expect(stats.tokens).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });

    // Report 2: interventions only — same prompts/tokens (no prompt/token delta)
    writeDashboardEvents([
      { type: 'session_start', timestamp: ts, sessionId: 's1', tool: 'claude', cwd: '/p' },
      { type: 'prompt_submit', timestamp: ts, sessionId: 's1', tool: 'claude', promptSummary: 'hi' },
      {
        type: 'stop', timestamp: ts, sessionId: 's1', tool: 'claude',
        interventions: { interrupt: 1, toolReject: 0 },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0 },
      },
    ]);
    reportsMocks.updateReports.mockClear();
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    stats = YAML.parse(fs.readFileSync(statsPath, 'utf-8'));
    expect(stats.interventions).toEqual({ sessions: 1, interrupt: 1, toolReject: 0, correction: 0 });
    // Must still have prompts/tokens after an intervention-only report
    expect(stats.prompts).toBe(1);
    expect(stats.tokens).toEqual({ input: 10, output: 5, cacheRead: 0, cacheCreation: 0 });
    expect(reportsMocks.updateReports).toHaveBeenCalledTimes(1);
  });
});

describe('reportUsage — usage recorded while the usage lock was held (#788)', () => {
  it('reports the event without the side file id it was folded in with', async () => {
    const timestamp = new Date().toISOString();
    const usagePath = path.join(tmpDir, '.teamai', 'user-usage.jsonl');
    fs.mkdirSync(path.dirname(usagePath), { recursive: true });
    fs.writeFileSync(usagePath, JSON.stringify({ skill: 'review', timestamp, tool: 'claude', pendingId: '0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6' }) + '\n');

    expect(await reportUsage(repoDir, 'me', { selfConfig: gitConfig() })).toBe('reported');

    const yaml = fs.readFileSync(reportsStatsPath(), 'utf-8');
    expect(YAML.parse(yaml).skills.review.count).toBe(1);
    expect(yaml).not.toContain('pendingId');
    expect(yaml).not.toContain('0f8e2c1a');
  });
});
