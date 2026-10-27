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

import { reportUsageToTeam } from '../team-push.js';
import { dataHomeKey, readSessionOutcomes } from '../dashboard-collector.js';

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

describe('the usage report counts what finished sessions delivered (#1387)', () => {
  it('adds a finished session to the row of its run mode and outcome, with counts only', async () => {
    writeEvents([...session('7c1e-finished', 7), learning('7c1e-finished', 7.5, 'k8s/pod-startup-timeouts-2026-10-24-k3x9q2')]);

    expect(await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() })).toBe(true);

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
    expect(statsText()).not.toContain('7c1e-finished');
    expect(statsText()).not.toContain('pod-startup-timeouts');
  });

  it('adds a session once it has been idle for 6 hours, and never a second time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeEvents(session('quiet-2h', 2));

    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toBeUndefined();

    vi.setSystemTime(Date.now() + 5 * HOUR);
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });
    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('still adds a session whose events compaction dropped before it was finished, with what the report saw of it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    writeEvents([...session('compacted', 1), learning('compacted', 1.5, 'retry-backoff')]);
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });
    // Compaction keeps the outcome and drops the session's own events.
    writeEvents([learning('compacted', 1.5, 'retry-backoff')]);

    vi.setSystemTime(Date.now() + 6 * HOUR);
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('counts the commits the member made during the session, and keeps their shas on this machine only', async () => {
    const work = checkout();
    const start = commitIn(work, 'base', ME);
    commitIn(work, 'pulled in, written before the session', ME, at(20));
    commitIn(work, 'a teammate', 'other@example.com');
    const mine = commitIn(work, 'mine', ME);
    const [first, stop] = session('with-commit', 7, { cwd: work });
    writeEvents([{ ...first, gitAtStart: { head: start, dirty: false } }, { ...stop, gitHead: mine }]);

    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { commit: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
    expect(statsText()).not.toContain(mine);
    expect((await readSessionOutcomes()).map((event) => [event.sessionId, event.outcomes])).toEqual([['with-commit', [{ kind: 'commit', sha: mine }]]]);
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
      [{ ...begin, gitAtStart: { head, dirty: false } }, { ...stop, gitHead }];
    writeEvents([
      ...withHeads(session('first', 8, { cwd: work }), start, first),
      ...withHeads(session('second', 7, { cwd: work }), first, second),
    ]);

    // The first report's push fails; by the next one the pull request has merged, and an open one is no longer found.
    reportsMocks.updateReports.mockResolvedValueOnce({ status: 'failed' });
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });
    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    const counted = { sessions: 2, tokens: { input: 20, output: 10 }, interventions: 2 };
    expect(stats().outcomes).toEqual({ attended: { commit: counted, pr: counted } });
    expect(statsText()).not.toContain('pull/42');
    expect(Object.fromEntries((await readSessionOutcomes()).map((event) => [event.sessionId, event.outcomes]))).toEqual({
      first: [{ kind: 'commit', sha: first }, { kind: 'pr', url }],
      second: [{ kind: 'commit', sha: second }, { kind: 'pr', url }],
    });
  });

  it('counts a session known only by the learning recorded for it, when it was recorded under this data home', async () => {
    writeEvents([
      { ...learning('no-hooks', 7, 'retry-backoff'), tool: 'pi', runMode: 'attended' },
      { ...learning('another-home', 7, 'retry-backoff'), tool: 'pi', runMode: 'attended', dataHomeKey: 'elsewhere' },
    ]);

    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { learning: { sessions: 1, tokens: { input: 0, output: 0 }, interventions: 0 } } });
  });

  it('puts a session recorded before run modes under notRecorded', async () => {
    writeEvents(session('older-hooks', 7).map((event) => ({ ...event, runMode: undefined })));

    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ notRecorded: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });

  it('leaves out the sessions teamai launched', async () => {
    writeEvents([
      ...session('mine', 7),
      ...session('workflow-step', 7, { launchedBy: 'workflow' }),
      { ...learning('workflow-step', 7.5, 'retry-backoff'), launchedBy: 'workflow' },
      { ...learning('step-without-hooks', 7.5, 'retry-backoff'), launchedBy: 'workflow' },
    ]);

    await reportUsageToTeam(repoDir, 'me', { selfConfig: gitConfig() });

    expect(stats().outcomes).toEqual({ attended: { none: { sessions: 1, tokens: { input: 10, output: 5 }, interventions: 1 } } });
  });
});
