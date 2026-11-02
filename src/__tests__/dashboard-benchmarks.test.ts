import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The team's reports checkout is refreshed from origin before it is read; these fixtures have no origin.
vi.mock('../utils/reports-branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/reports-branch.js')>();
  const { getReportsDir } = await import('../types.js');
  return { ...actual, readableReportsWorktree: async (config: Parameters<typeof getReportsDir>[0]) => getReportsDir(config) };
});

import { benchmarkHistory, parseBenchmarkQuery } from '../dashboard/benchmarks.js';
import { HttpError } from '../dashboard/http.js';
import { getReportsDir, type LocalConfig } from '../types.js';
import type { TrialResult } from '../benchmark/result.js';
import { queueBenchmarkRecord } from '../workflow/records.js';
import { runsDir } from '../workflow/store.js';
import { benchmarkRunConfig, fixRecord } from './helpers/benchmark-fixture.js';

// A run this machine starts is dated by the clock, so the window ends just after it.
const NOW = new Date(Date.now() + 60_000);
const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
let root = '';
let config: LocalConfig;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-dashboard-benchmarks-')));
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  config = benchmarkRunConfig(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function recordFile(run: string): string {
  return path.join(getReportsDir(config), 'benchmarks', 'runs', `${run}.json`);
}

/**
 * The benchmark record the team published for a run of suite `fix` by `username`, whose one trial on each arm of
 * `tools`, on team revision `team`, got `result`. Without `benchmark`, the run's workflow record instead.
 */
function publish(run: string, { username = 'bob', startedAt = YESTERDAY, result = 'passed' as TrialResult, benchmark = true, team = 'b'.repeat(40), tools = ['claude'] } = {}): void {
  const file = benchmark ? recordFile(run) : path.join(getReportsDir(config), 'workflows', 'runs', `${run}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(benchmark
    ? fixRecord(run, { username, startedAt, result, team, tools })
    : { schemaVersion: 'v1alpha1', run, workflow: 'fix', sourceHash: 'f'.repeat(64), phase: 'end', status: 'succeeded', startedAt, username, isolated: true }));
}

/** A benchmark run this machine reported, whose one trial did not run: its record in its run directory. */
function reportedLocally(run: string): void {
  const file = path.join(runsDir(config), run, 'benchmark.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fixRecord(run, { username: 'tester', startedAt: new Date().toISOString(), result: 'not_run' })));
}

describe('benchmarkHistory', () => {
  it("reads this machine's ended benchmark runs and the team's benchmark records, this machine's copy of a run first", async () => {
    const local = 'r10ca1000';
    reportedLocally(local);
    publish(local, { username: 'tester', result: 'passed' });
    publish('rb0b00001', { username: 'bob' });
    publish('rb0b00003', { benchmark: false });
    fs.writeFileSync(recordFile('rb0b00002'), '{"benchmark": ');

    const view = await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.suites.map(({ suite, runs }) => ({ suite, runs }))).toEqual([{ suite: 'fix', runs: 2 }]);
    expect(view.selected?.runs.map(({ run, source, username, passed, planned }) => ({ run, source, username, passed, planned }))).toEqual([
      { run: local, source: 'local', username: 'tester', passed: 0, planned: 1 },
      { run: 'rb0b00001', source: 'reported', username: 'bob', passed: 1, planned: 1 },
    ]);
  });

  it("leaves out a record the reports checkout keeps while this machine's queue still holds it, as its push was refused", async () => {
    publish('rb0b00001', { username: 'bob' });
    publish('r10ca1001', { username: 'tester' });
    // A member who reports usage, so the record is queued; nothing here publishes it.
    const reporting = { ...config, usageReportEnabled: true };
    expect(await queueBenchmarkRecord(reporting, fixRecord('r10ca1001', { username: 'tester', startedAt: YESTERDAY }), {})).toBe(true);

    const view = await benchmarkHistory({ config: reporting, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.selected?.runs.map(({ run }) => run)).toEqual(['rb0b00001']);
  });

  it('reads a record again once it changed on disk', async () => {
    publish('rb0b00001', { result: 'failed' });
    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).selected?.runs[0]).toMatchObject({ passed: 0 });

    publish('rb0b00001', { result: 'passed' });
    fs.utimesSync(recordFile('rb0b00001'), new Date(), new Date(Date.now() + 5000));

    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).selected?.runs[0]).toMatchObject({ passed: 1 });
    fs.rmSync(recordFile('rb0b00001'));
    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).suites).toEqual([]);
  });

  // Windows has no read permission to take away, and root reads any file.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reads a record again when it could not be read last time, though it did not change', async () => {
    publish('rb0b00001');
    fs.chmodSync(recordFile('rb0b00001'), 0o000);
    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).suites).toEqual([]);

    fs.chmodSync(recordFile('rb0b00001'), 0o644);

    expect((await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false })).selected?.runs.map(({ run }) => run)).toEqual(['rb0b00001']);
  });
});

describe('benchmarkHistory team revisions', () => {
  /** Commits `files` to the team clone as `subject` at `date`, and returns the commit. */
  function commitTeam(files: Record<string, string>, subject: string, date: string): string {
    const team = config.repo.localPath;
    const run = (args: string[]): string => execFileSync('git', args, { cwd: team, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } }).trim();
    if (!fs.existsSync(team)) {
      fs.mkdirSync(team, { recursive: true });
      run(['init', '-q']);
    }
    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(team, file)), { recursive: true });
      fs.writeFileSync(path.join(team, file), text);
    }
    run(['add', '-A']);
    run(['-c', 'user.name=Team', '-c', 'user.email=team@example.com', 'commit', '-qm', subject]);
    return run(['rev-parse', 'HEAD']);
  }

  it('names each team revision the runs installed from the team clone, in commit order, with the asset files each changed', async () => {
    const first = commitTeam({ 'skills/auth/SKILL.md': 'Refresh tokens.\n', 'benchmarks/fix/suite.yaml': 'v1\n' }, 'Add the auth skill', '2026-10-01T09:00:00Z');
    const second = commitTeam({ 'skills/auth/SKILL.md': 'Refresh tokens.\nReject expired ones.\n', 'rules/testing.md': 'Run the tests.\n', 'benchmarks/fix/suite.yaml': 'v2\n' }, 'Tighten the auth skill', '2026-10-07T09:00:00Z');
    // The newer revision ran first, so only the commit dates put them in order.
    publish('rb0b00001', { team: second, startedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    publish('rb0b00002', { team: first, startedAt: YESTERDAY, result: 'failed' });

    const view = await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.selected?.teamChanges.revisions.map(({ revision }) => revision)).toEqual([first, second]);
    expect(view.teamCommits).toEqual({
      [first]: { committedAt: '2026-10-01T09:00:00.000Z', subject: 'Add the auth skill' },
      [second]: { committedAt: '2026-10-07T09:00:00.000Z', subject: 'Tighten the auth skill' },
    });
    expect(view.teamDiffs).toEqual({
      [`${first}..${second}`]: { files: [{ path: 'rules/testing.md', added: 1, removed: 0 }, { path: 'skills/auth/SKILL.md', added: 1, removed: 0 }], more: 0 },
    });
  });

  it('keeps a team revision the team clone lacks, unnamed and in the order its runs ran', async () => {
    const known = commitTeam({ 'skills/auth/SKILL.md': 'Refresh tokens.\n' }, 'Add the auth skill', '2026-10-01T09:00:00Z');
    publish('rb0b00001', { team: 'e'.repeat(40), startedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() });
    publish('rb0b00002', { team: known, startedAt: YESTERDAY });

    const view = await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.selected?.teamChanges.revisions.map(({ revision }) => revision)).toEqual(['e'.repeat(40), known]);
    expect(view.teamCommits).toEqual({ [known]: { committedAt: '2026-10-01T09:00:00.000Z', subject: 'Add the auth skill' } });
    expect(view.teamDiffs).toEqual({});
  });

  it('lists what changed between the revisions each tool ran on in turn, skipping a revision only another tool ran on', async () => {
    const a = commitTeam({ 'skills/auth/SKILL.md': 'Refresh tokens.\n' }, 'Add the auth skill', '2026-10-01T09:00:00Z');
    const b = commitTeam({ 'rules/testing.md': 'Run the tests.\n' }, 'Add the testing rule', '2026-10-03T09:00:00Z');
    const c = commitTeam({ 'agents/reviewer.md': 'Review.\n' }, 'Add the reviewer', '2026-10-05T09:00:00Z');
    const daysAgo = (days: number): string => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    publish('rb0b00001', { team: a, tools: ['claude'], startedAt: daysAgo(3) });
    publish('rb0b00002', { team: b, tools: ['codex'], startedAt: daysAgo(2) });
    publish('rb0b00003', { team: c, tools: ['claude', 'codex'], startedAt: YESTERDAY });

    const view = await benchmarkHistory({ config, query: { windowDays: 365 }, now: NOW, refresh: false });

    expect(view.teamDiffs).toEqual({
      [`${a}..${c}`]: { files: [{ path: 'agents/reviewer.md', added: 1, removed: 0 }, { path: 'rules/testing.md', added: 1, removed: 0 }], more: 0 },
      [`${b}..${c}`]: { files: [{ path: 'agents/reviewer.md', added: 1, removed: 0 }], more: 0 },
    });
  });
});

describe('parseBenchmarkQuery', () => {
  it('takes a window the page offers and a suite name, and 90 days by default', () => {
    expect(parseBenchmarkQuery(new URLSearchParams('suite=fix-auth&window=30'))).toEqual({ windowDays: 30, suite: 'fix-auth' });
    expect(parseBenchmarkQuery(new URLSearchParams(''))).toEqual({ windowDays: 90 });
    expect(() => parseBenchmarkQuery(new URLSearchParams('window=7'))).toThrow(HttpError);
  });
});
