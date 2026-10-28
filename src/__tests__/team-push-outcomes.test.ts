import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import type { LocalConfig, UserStats } from '../types.js';

// Reports-branch writes are stubbed, so the test reads what the report wrote into stats/<user>.yaml without a remote.
const reportsMocks = vi.hoisted(() => ({ updateReports: vi.fn() }));
vi.mock('../utils/reports-branch.js', () => ({
  updateReports: (...args: unknown[]) => reportsMocks.updateReports(...args),
}));
// The pull request host is stubbed; the checkout and its origin are real.
const prMocks = vi.hoisted(() => ({ findDelivered: vi.fn() }));
vi.mock('../workflow/pr-delivery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../workflow/pr-delivery.js')>(),
  findDelivered: (...args: unknown[]) => prMocks.findDelivered(...args),
}));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { reportUsage } from '../team-push.js';
import { dataHomeKey, readSessionOutcomes } from '../dashboard-collector.js';
import { resolveAnchors } from '../utils/git.js';

const HOUR = 3_600_000;

let tmpDir: string;
let repoDir: string;
let originalHome: string;
let userKey: string;

function gitConfig(): LocalConfig {
  return {
    repo: { localPath: repoDir, remote: 'https://example.com/team.git', kind: 'git' },
    username: 'me',
    scope: 'user',
    additionalRoles: [],
  };
}

function statsText(): string {
  const file = path.join(tmpDir, 'reports-wt', 'stats', 'me.yaml');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

function stats(): UserStats {
  return YAML.parse(statsText()) as UserStats;
}

function writeEvents(lines: object[]): void {
  const file = path.join(tmpDir, '.teamai', 'dashboard', 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify({ dataHomeKey: userKey, ...line })).join('\n') + '\n');
}

const at = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * HOUR).toISOString();

/** An attended Claude session that stopped `hoursAgo` hours ago, with one interrupt and 10 input / 5 output tokens. */
function session(sessionId: string, hoursAgo: number, extra: Record<string, unknown> = {}): object[] {
  return [
    { type: 'session_start', timestamp: at(hoursAgo + 1), sessionId, tool: 'claude', cwd: '/p', runMode: 'attended', ...extra },
    { type: 'stop', timestamp: at(hoursAgo), sessionId, tool: 'claude', cwd: '/p', runMode: 'attended', ...extra,
      interventions: { interrupt: 1, toolReject: 0 }, tokens: { input: 10, output: 5, cacheRead: 3, cacheCreation: 0 } },
  ];
}

function learning(sessionId: string, hoursAgo: number, id: string): object {
  return { type: 'session_outcome', timestamp: at(hoursAgo), sessionId, tool: 'claude', outcomes: [{ kind: 'learning', id }] };
}

const ME = 'me@example.com';

function gitIn(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf-8' }).trim();
}

/** An empty commit by `email`, dated `date` when given; its sha. */
function commitIn(cwd: string, message: string, email: string, date?: string): string {
  gitIn(cwd, ['commit', '-q', '--allow-empty', '-m', message, `--author=Someone <${email}>`], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
  return gitIn(cwd, ['rev-parse', 'HEAD']);
}

/** A checkout whose git identity is the member's. */
function checkout(): string {
  const work = path.join(tmpDir, 'work');
  fs.mkdirSync(work);
  gitIn(work, ['init', '-q', '-b', 'main']);
  gitIn(work, ['config', 'user.email', ME]);
  gitIn(work, ['config', 'user.name', 'Me']);
  return work;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-tp-outcomes-'));
  originalHome = process.env.HOME ?? '';
  process.env.HOME = tmpDir;
  userKey = await dataHomeKey(path.join(tmpDir, '.teamai'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  reportsMocks.updateReports.mockReset().mockImplementation(async (cfg: LocalConfig, write: (wt: string, ctx: { onDelivered: (fn: () => Promise<void>) => void }) => Promise<{ files: string[]; message: string } | null>) => {
    const dir = path.join(path.dirname(cfg.repo.localPath), 'reports-wt');
    fs.mkdirSync(dir, { recursive: true });
    const change = await write(dir, { onDelivered: () => {} });
    return { status: change != null ? 'published' : 'already-present' };
  });
  prMocks.findDelivered.mockReset().mockResolvedValue({ kind: 'none' });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the first report on a release that counts outcomes (#1387)', () => {
  it('leaves out the sessions an earlier release recorded and finished before it, and adds the ones still going', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeEvents([...session('before-upgrade', 30), ...session('also-before-upgrade', 8), ...session('still-going', 1)]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toBeUndefined();

    vi.setSystemTime(Date.now() + 6 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });
});

describe('the usage report counts what finished sessions delivered (#1387)', () => {
  // The member's first report on this release came before any of these sessions.
  beforeEach(async () => {
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
  });

  it('adds a finished session to the row of its run mode and outcome, with counts only', async () => {
    writeEvents([...session('7c1e-finished', 7), learning('7c1e-finished', 7.5, 'k8s/pod-startup-timeouts-2026-10-24-k3x9q2')]);

    expect(await reportUsage(repoDir, 'me', { selfConfig: gitConfig() })).toBe('reported');

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
    expect(statsText()).not.toContain('7c1e-finished');
    expect(statsText()).not.toContain('pod-startup-timeouts');
  });

  it('adds a session once it has been idle for 6 hours, and never a second time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeEvents(session('quiet-2h', 2));

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toBeUndefined();

    vi.setSystemTime(Date.now() + 5 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('still adds a session whose events compaction dropped before it was finished, with what the report saw of it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeEvents([...session('compacted', 1), learning('compacted', 1.5, 'retry-backoff')]);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    // Compaction keeps the outcome and drops the session's own events.
    writeEvents([learning('compacted', 1.5, 'retry-backoff')]);

    vi.setSystemTime(Date.now() + 6 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('counts a resumed session with the usage the report kept of a rollout compaction dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const rollout = (transcriptPath: string, input: number, interrupt: number): object =>
      ({ type: 'stop', timestamp: at(1), sessionId: 'resumed', tool: 'codex', cwd: '/p', runMode: 'attended', transcriptPath,
        tokenScope: 'transcript', tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0 }, interventions: { interrupt, toolReject: 0 } });
    writeEvents([rollout('/rollouts/a.jsonl', 100, 2)]);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    // Compaction dropped rollout A; the resume wrote rollout B.
    writeEvents([rollout('/rollouts/b.jsonl', 10, 1)]);

    vi.setSystemTime(Date.now() + 7 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 110, output: 0 }, interventions: 3 } } });
  });

  it('counts the commits the member made during the session, and keeps their shas on this machine only', async () => {
    const work = checkout();
    const start = commitIn(work, 'base', ME);
    commitIn(work, 'pulled in, written before the session', ME, at(20));
    commitIn(work, 'a teammate', 'other@example.com');
    const mine = commitIn(work, 'mine', ME);
    const [first, stop] = session('with-commit', 7, { cwd: work });
    writeEvents([{ ...first, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { commit: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
    expect(statsText()).not.toContain(mine);
    expect((await readSessionOutcomes()).map((event) => [event.sessionId, event.outcomes])).toEqual([['with-commit', [{ kind: 'commit', sha: mine }]]]);
  });

  it('finds the commits of a session whose worktree was removed before it was finished, in its repository', async () => {
    const work = checkout();
    const start = commitIn(work, 'base', ME);
    const tree = path.join(tmpDir, 'task-tree');
    gitIn(work, ['worktree', 'add', '-q', '-b', 'task', tree]);
    const mine = commitIn(tree, 'in the worktree', ME);
    const anchor = (await resolveAnchors(tree))?.projectAnchor;
    const [first, stop] = session('in-worktree', 7, { cwd: tree, projectAnchor: anchor });
    writeEvents([{ ...first, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine, gitBranch: 'task' }]);
    gitIn(work, ['worktree', 'remove', tree]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }]]);
  });

  it('finds the first commits of a session that started in a repository with no commit yet', async () => {
    const work = checkout();
    const mine = commitIn(work, 'the first commit', ME, at(7.5));
    const [first, stop] = session('first-commits', 7, { cwd: work });
    writeEvents([first, { ...stop, gitHead: mine }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }]]);
  });

  it('finds the commits of a member whose git email has a + tag', async () => {
    const work = checkout();
    gitIn(work, ['config', 'user.email', 'me+team@example.com']);
    const start = commitIn(work, 'base', 'me+team@example.com');
    const mine = commitIn(work, 'mine', 'me+team@example.com');
    const [first, stop] = session('tagged-email', 7, { cwd: work });
    writeEvents([{ ...first, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }]]);
  });

  it('counts the open pull request that holds a commit of each session, as it was first looked up', async () => {
    const work = checkout();
    const origin = path.join(tmpDir, 'origin.git');
    gitIn(tmpDir, ['init', '-q', '--bare', origin]);
    const start = commitIn(work, 'base', ME);
    gitIn(work, ['remote', 'add', 'origin', origin]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['remote', 'set-head', 'origin', 'main']);
    gitIn(work, ['checkout', '-q', '-b', 'fix-retry']);
    const first = commitIn(work, 'first session', ME);
    const second = commitIn(work, 'second session', ME);
    gitIn(work, ['push', '-q', 'origin', 'fix-retry']);
    const url = 'https://github.com/acme/app/pull/42';
    const lookup = async (cwd: string, ref: { branch: string; target: string }) =>
      (cwd === work && ref.branch === 'fix-retry' && ref.target === 'main' ? { kind: 'found', pr: url } : { kind: 'none' });
    prMocks.findDelivered.mockImplementationOnce(lookup).mockImplementationOnce(lookup);
    const withHeads = ([begin, stop]: object[], head: string, gitHead: string): object[] =>
      [{ ...begin, gitAtStart: { head, dirty: false } }, { ...stop, gitHead, gitBranch: 'fix-retry' }];
    writeEvents([
      ...withHeads(session('first', 8, { cwd: work }), start, first),
      ...withHeads(session('second', 7, { cwd: work }), first, second),
    ]);

    // The first report's push fails; by the next one the pull request has merged, and an open one is no longer found.
    reportsMocks.updateReports.mockResolvedValueOnce({ status: 'failed' });
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    const counted = { sessions: 2, tokens: { input: 20, output: 10 }, interventions: 2 };
    expect(stats().outcomes).toEqual({ attended: { commit: counted, pr: counted } });
    expect(statsText()).not.toContain('pull/42');
    expect(Object.fromEntries((await readSessionOutcomes()).map((event) => [event.sessionId, event.outcomes]))).toEqual({
      first: [{ kind: 'commit', sha: first }, { kind: 'pr', url }],
      second: [{ kind: 'commit', sha: second }, { kind: 'pr', url }],
    });
  });

  it('counts the pull request a report found while the session was still going, though it merged before the session finished', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const work = checkout();
    const origin = path.join(tmpDir, 'origin.git');
    gitIn(tmpDir, ['init', '-q', '--bare', origin]);
    const start = commitIn(work, 'base', ME);
    gitIn(work, ['remote', 'add', 'origin', origin]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['checkout', '-q', '-b', 'fix-retry']);
    const mine = commitIn(work, 'the session', ME);
    gitIn(work, ['push', '-q', 'origin', 'fix-retry']);
    const url = 'https://github.com/acme/app/pull/42';
    let isOpen = true;
    prMocks.findDelivered.mockImplementation(async (cwd: string, ref: { branch: string; target: string }) =>
      (isOpen && cwd === work && ref.branch === 'fix-retry' && ref.target === 'main' ? { kind: 'found', pr: url } : { kind: 'none' }));
    const [begin, stop] = session('merged-early', 1, { cwd: work });
    writeEvents([{ ...begin, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine, gitBranch: 'fix-retry' }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });
    // Merged by the next report, which finds no open one.
    isOpen = false;
    vi.setSystemTime(Date.now() + 6 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }, { kind: 'pr', url }]]);
  });

  it.each([
    { secondPushed: true, pr: 'https://github.com/acme/app/pull/42' },
    { secondPushed: false, pr: undefined },
  ])('counts the pull request of the branch the session last stopped on, not one a report found on an earlier branch (pushed: $secondPushed)', async ({ secondPushed, pr }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const work = checkout();
    const origin = path.join(tmpDir, 'origin.git');
    gitIn(tmpDir, ['init', '-q', '--bare', origin]);
    const start = commitIn(work, 'base', ME);
    gitIn(work, ['remote', 'add', 'origin', origin]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['checkout', '-q', '-b', 'fix-retry']);
    const first = commitIn(work, 'the first branch', ME);
    gitIn(work, ['push', '-q', 'origin', 'fix-retry']);
    const urls: Record<string, string> = { 'fix-retry': 'https://github.com/acme/app/pull/41', 'fix-timeout': 'https://github.com/acme/app/pull/42' };
    prMocks.findDelivered.mockImplementation(async (_cwd: string, ref: { branch: string }) =>
      (urls[ref.branch] ? { kind: 'found', pr: urls[ref.branch] } : { kind: 'none' }));
    const [begin, stop] = session('switched-branch', 1, { cwd: work });
    const startedOn = { ...begin, gitAtStart: { head: start, dirty: false } };
    const stoppedOnFirst = { ...stop, gitHead: first, gitBranch: 'fix-retry' };
    writeEvents([startedOn, stoppedOnFirst]);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    // The session goes on, on another branch.
    vi.setSystemTime(Date.now() + HOUR);
    gitIn(work, ['checkout', '-q', '-b', 'fix-timeout']);
    const second = commitIn(work, 'the second branch', ME);
    if (secondPushed) gitIn(work, ['push', '-q', 'origin', 'fix-timeout']);
    const [, laterStop] = session('switched-branch', 0, { cwd: work });
    writeEvents([startedOn, stoppedOnFirst, { ...laterStop, gitHead: second, gitBranch: 'fix-timeout' }]);
    vi.setSystemTime(Date.now() + 6 * HOUR);
    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[
      { kind: 'commit', sha: first }, { kind: 'commit', sha: second }, ...(pr ? [{ kind: 'pr', url: pr }] : []),
    ]]);
  });

  it('looks up the pull request of the branch the session last stopped on, after the checkout moved on', async () => {
    const work = checkout();
    const origin = path.join(tmpDir, 'origin.git');
    gitIn(tmpDir, ['init', '-q', '--bare', origin]);
    const start = commitIn(work, 'base', ME);
    gitIn(work, ['remote', 'add', 'origin', origin]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['remote', 'set-head', 'origin', 'main']);
    gitIn(work, ['checkout', '-q', '-b', 'fix-retry']);
    const mine = commitIn(work, 'the session', ME);
    gitIn(work, ['push', '-q', 'origin', 'fix-retry']);
    gitIn(work, ['checkout', '-q', 'main']);
    const url = 'https://github.com/acme/app/pull/42';
    prMocks.findDelivered.mockImplementation(async (cwd: string, ref: { branch: string; target: string }) =>
      (cwd === work && ref.branch === 'fix-retry' && ref.target === 'main' ? { kind: 'found', pr: url } : { kind: 'none' }));
    const [begin, stop] = session('moved-on', 7, { cwd: work });
    writeEvents([{ ...begin, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine, gitBranch: 'fix-retry' }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }, { kind: 'pr', url }]]);
  });

  it('looks up the pull request of a repository pushed to its origin rather than cloned, which has no origin HEAD', async () => {
    const work = checkout();
    const origin = path.join(tmpDir, 'origin.git');
    gitIn(tmpDir, ['init', '-q', '--bare', origin]);
    const start = commitIn(work, 'base', ME);
    gitIn(work, ['remote', 'add', 'origin', origin]);
    gitIn(work, ['push', '-q', 'origin', 'main']);
    gitIn(work, ['checkout', '-q', '-b', 'fix-retry']);
    const mine = commitIn(work, 'the session', ME);
    gitIn(work, ['push', '-q', 'origin', 'fix-retry']);
    const url = 'https://github.com/acme/app/pull/42';
    prMocks.findDelivered.mockImplementation(async (cwd: string, ref: { branch: string; target: string }) =>
      (cwd === work && ref.branch === 'fix-retry' && ref.target === 'main' ? { kind: 'found', pr: url } : { kind: 'none' }));
    const [begin, stop] = session('pushed', 7, { cwd: work });
    writeEvents([{ ...begin, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine, gitBranch: 'fix-retry' }]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect((await readSessionOutcomes()).map((event) => event.outcomes)).toEqual([[{ kind: 'commit', sha: mine }, { kind: 'pr', url }]]);
  });

  it('counts a session known only by the learning recorded for it, when it was recorded under this data home', async () => {
    writeEvents([
      { ...learning('no-hooks', 7, 'retry-backoff'), tool: 'pi', runMode: 'attended' },
      { ...learning('another-home', 7, 'retry-backoff'), tool: 'pi', runMode: 'attended', dataHomeKey: 'elsewhere' },
    ]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 0, output: 0 }, interventions: 0 } } });
  });

  it('puts a session recorded before run modes under notRecorded', async () => {
    writeEvents(session('older-hooks', 7).map((event) => ({ ...event, runMode: undefined })));

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ notRecorded: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('leaves out the sessions teamai launched', async () => {
    writeEvents([
      ...session('mine', 7),
      ...session('workflow-step', 7, { launchedBy: 'workflow' }),
      { ...learning('workflow-step', 7.5, 'retry-backoff'), launchedBy: 'workflow' },
      { ...learning('step-without-hooks', 7.5, 'retry-backoff'), launchedBy: 'workflow' },
    ]);

    await reportUsage(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });
});
