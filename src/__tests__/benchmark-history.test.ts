import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, formatRegression, regressionOf, runComparisons, type BenchmarkRunInput } from '../benchmark/history.js';
import { pairedDifference } from '../benchmark/table.js';
import { runSourceHash } from '../benchmark/plan.js';
import type { Baseline, TrialResult } from '../benchmark/result.js';
import type { TrialVerdict } from '../benchmark/verdicts.js';
import type { ArmTeam } from '../benchmark/terms.js';

const NOW = new Date('2026-10-28T12:00:00Z');

type Decider = NonNullable<TrialVerdict['decider']>;

/** `team`: the pulled revision of the run when absent. */
type Arm = { name: string; tool: string; model?: string; alias?: string; team?: ArmTeam; workflow?: { name: string; sourceHash: string }; role?: string };
const CLAUDE: Arm = { name: 'claude', tool: 'claude', model: 'claude-opus-5-5' };
const CODEX: Arm = { name: 'codex', tool: 'codex' };

/**
 * An ended benchmark run of `suite`. `trials` lists each task's results on each arm, one per repetition, as
 * `{ task: { arm: [results] } }`. A task in `invalid` had an invalid baseline, one in `notRun` none, as the run ended
 * first. A trial of an arm in `usage` ran its prompt, on the arm's tool or on the one `ranOn` names, unless its task is
 * in `unstarted`, and reported the tool version `versions` names for its tool.
 */
function run({ id, suite = 'fix-auth', version = 'v1', taskEdit = '', editedTasks = [], deciders = {}, startedAt, username = 'alice', source = 'reported', arms = [CLAUDE, CODEX], defaultsArm, trials, invalid = [], notRun = [], usage = {}, ranOn = {}, unstarted = [], versions = {}, subset = false, recordVersion = 2 }: {
  id: string;
  /** The arm that changes no `defaults` key. */
  defaultsArm?: string;
  suite?: string;
  version?: string;
  /** Appended to each task file's hash: an edit to the task files that leaves suite.yaml as it was. */
  taskEdit?: string;
  /** Tasks whose file alone changed: their hash gets `-edited`. */
  editedTasks?: string[];
  /** By arm, who decided each of its trials' correctness labels, or by arm and task; a trial not listed has no verdicts. */
  deciders?: Record<string, Decider | { byTask: Record<string, Decider> }>;
  startedAt: string;
  username?: string;
  source?: 'local' | 'reported';
  arms?: Arm[];
  trials: Record<string, Record<string, TrialResult[]>>;
  invalid?: string[];
  notRun?: string[];
  usage?: Record<string, { tokens: number; durationMs: number; cost?: number }>;
  ranOn?: Record<string, string>;
  unstarted?: string[];
  versions?: Record<string, string>;
  /** The run ran only the tasks and arms `--task` and `--arm` chose. */
  subset?: boolean;
  /** The schemaVersion of the run's record. */
  recordVersion?: 1 | 2;
}): BenchmarkRunInput {
  const tasks = [...Object.keys(trials), ...invalid, ...notRun];
  const baseline = (task: string): Baseline => (invalid.includes(task) ? 'invalid' : notRun.includes(task) ? 'not_run' : 'valid');
  let order = 0;
  return {
    run: id, source, username, startedAt, outcome: 'succeeded', schemaVersion: recordVersion,
    benchmark: {
      suite: { name: suite, sourceHash: version }, repetitions: 1, baselineTeamRevision: `team-${id}`, scorers: [], ...(subset ? { subset: true as const } : {}), ...(defaultsArm ? { defaultsArm } : {}),
      tasks: tasks.map((task) => ({ id: task, startingCommit: 'a'.repeat(40), sourceHash: `task-${task}${taskEdit}${editedTasks.includes(task) ? '-edited' : ''}`, baseline: baseline(task) })),
      arms: arms.map(({ team, ...arm }) => ({ ...arm, source: 'team', team: team ?? { kind: 'pulled' as const, revision: `team-${id}` } })),
      trials: Object.entries(trials).flatMap(([task, byArm]) => Object.entries(byArm).flatMap(([arm, results]) => results.map((result, repetition) => {
        const step = `trials.r${repetition + 1}.${task}.${arm}.prompt`;
        const spent = unstarted.includes(task) ? undefined : usage[arm];
        const own = arms.find(({ name }) => name === arm);
        const tool = ranOn[arm] ?? own?.tool;
        const toolVersion = tool === undefined ? undefined : versions[tool];
        const listed = deciders[arm];
        const decider = listed !== undefined && 'byTask' in listed ? listed.byTask[task] : listed;
        const verdicts = decider === undefined ? undefined : [{ scorer: `teamai:correctness:${task}`, outcome: result === 'passed' || result === 'failed' ? { kind: 'labelled' as const, label: result, score: result === 'passed' ? 1 : 0, passed: result === 'passed' } : { kind: 'unscored' as const, because: 'run_ended' as const }, decider }];
        const agent = spent && own && tool !== undefined
          ? { v: 1 as const, tool: { name: tool, ...(toolVersion ? { version: toolVersion } : {}) }, ...(own.model ? { model: { reported: own.model } } : {}), team: { revision: `team-${id}`, localChanges: false }, teamai: '0.0.0', driver: 'local' }
          : undefined;
        return {
          task, arm, repetition: repetition + 1, order: order++, step, result, ...(verdicts ? { verdicts } : {}), ...(agent ? { agent } : {}),
          ...(spent ? { tokens: { input: spent.tokens, output: 0, complete: true }, durationMs: spent.durationMs, ...(spent.cost === undefined ? {} : { cost: { amount: spent.cost, unit: 'USD', complete: true } }) } : {}),
        };
      }))),
    },
  };
}

const versionOf = (input: BenchmarkRunInput | undefined): string | undefined => input && runSourceHash(input.benchmark);

describe('BenchmarkHistory', () => {
  it('lists each suite run in the window, newest run first, with its leading arm and its pass rate per run', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', trials: { login: { claude: ['passed', 'failed'], codex: ['failed', 'failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', trials: { login: { claude: ['passed', 'passed'], codex: ['passed', 'failed'] } } }),
      run({ id: 'r3', suite: 'migrate-db', startedAt: '2026-10-25T09:00:00Z', arms: [CODEX], trials: { schema: { codex: ['passed'] }, seed: { codex: ['error'] } } }),
      run({ id: 'r0', startedAt: '2026-06-01T09:00:00Z', trials: { login: { claude: ['failed'], codex: ['failed'] } } }),
    ];

    const view = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW });

    expect(view.window).toEqual({ from: '2026-07-30T12:00:00.000Z', to: '2026-10-28T12:00:00.000Z' });
    expect(view.suites).toEqual([
      { suite: 'migrate-db', runs: 1, lastRunAt: '2026-10-25T09:00:00Z', tasks: 2, arms: 1, leader: { arm: 'codex', passed: 1, planned: 2 }, trend: [{ run: 'r3', startedAt: '2026-10-25T09:00:00Z', passed: 1, planned: 2 }] },
      {
        suite: 'fix-auth', runs: 2, lastRunAt: '2026-10-20T09:00:00Z', tasks: 1, arms: 2, leader: { arm: 'claude', passed: 2, planned: 2 },
        trend: [{ run: 'r1', startedAt: '2026-10-01T09:00:00Z', passed: 1, planned: 4 }, { run: 'r2', startedAt: '2026-10-20T09:00:00Z', passed: 3, planned: 4 }],
      },
    ]);
  });

  // r1 ran suite version v1 with claude on another model; r2 and r3 ran v2, the current version.
  const history = [
    run({ id: 'r1', version: 'v1', startedAt: '2026-10-01T09:00:00Z', arms: [{ ...CLAUDE, model: 'claude-sonnet-5-5' }, CODEX], trials: { login: { claude: ['failed'], codex: ['failed'] } } }),
    run({
      id: 'r2', version: 'v2', startedAt: '2026-10-10T09:00:00Z', username: 'bob',
      trials: { login: { claude: ['passed', 'passed'], codex: ['passed', 'failed'] }, logout: { claude: ['passed'], codex: ['failed'] } },
      usage: { claude: { tokens: 1000, durationMs: 60_000, cost: 0.5 }, codex: { tokens: 400, durationMs: 30_000, cost: 0.1 } },
    }),
    run({
      id: 'r3', version: 'v2', startedAt: '2026-10-20T09:00:00Z', source: 'local',
      trials: { login: { claude: ['passed', 'failed'], codex: ['passed', 'passed'] }, logout: { claude: ['passed'], codex: ['failed'] } },
      usage: { claude: { tokens: 3000, durationMs: 120_000, cost: 1.5 }, codex: { tokens: 600, durationMs: 50_000, cost: 0.3 } },
    }),
  ];

  it("pools each arm of the suite's current version over its runs, with a 95% interval, and keeps every run of each arm as a point", () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });

    expect(view.selected?.suite).toBe('fix-auth');
    // A version is the run's sourceHash, over its suite file and each task file.
    expect(view.selected?.versions).toEqual([
      { sourceHash: versionOf(history[2]), runs: 2, lastRunAt: '2026-10-20T09:00:00Z' },
      { sourceHash: versionOf(history[0]), runs: 1, lastRunAt: '2026-10-01T09:00:00Z' },
    ]);
    const arms = view.selected?.arms ?? [];
    expect(arms.map(({ arm, model, isCurrent, pooled, points }) => ({ arm, model, isCurrent, pooled: pooled && { passed: pooled.passed, planned: pooled.planned, runs: pooled.runs }, points: points.map(({ run: id, passed, planned }) => `${id} ${passed}/${planned}`) }))).toEqual([
      { arm: 'claude', model: 'claude-opus-5-5', isCurrent: true, pooled: { passed: 5, planned: 6, runs: 2 }, points: ['r2 3/3', 'r3 2/3'] },
      { arm: 'codex', model: undefined, isCurrent: true, pooled: { passed: 3, planned: 6, runs: 2 }, points: ['r1 0/1', 'r2 1/3', 'r3 2/3'] },
      { arm: 'claude', model: 'claude-sonnet-5-5', isCurrent: false, pooled: undefined, points: ['r1 0/1'] },
    ]);
    // Wilson score intervals: 5/6 is 43.6%–97.0%, 3/6 is 18.8%–81.2%.
    expect(arms[0]?.pooled?.low).toBeCloseTo(0.436, 3);
    expect(arms[0]?.pooled?.high).toBeCloseTo(0.970, 3);
    expect(arms[1]?.pooled?.low).toBeCloseTo(0.188, 3);
    expect(arms[1]?.pooled?.high).toBeCloseTo(0.812, 3);
    // Medians over every trial of the current version: claude ran three trials at 1000 tokens and three at 3000.
    expect(arms[0]?.pooled?.usage).toEqual({
      tokens: { value: 2000, used: 6, components: ['input', 'output'] },
      durationMs: { value: 90_000, used: 6 },
      cost: { kind: 'known', amount: 6, unit: 'USD', used: 6 },
      costPerPassedTrial: { kind: 'known', amount: 1.2, unit: 'USD' },
    });
  });

  it('starts a new version when a task file changed, though suite.yaml did not', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', trials: { login: { claude: ['failed'], codex: ['failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', taskEdit: '-edited', trials: { login: { claude: ['passed'], codex: ['passed'] } } }),
    ];

    const selected = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected;

    expect(selected?.versions.map(({ runs: count }) => count)).toEqual([1, 1]);
    expect(selected?.arms.map(({ pooled }) => pooled && `${pooled.passed}/${pooled.planned}`)).toEqual(['1/1', '1/1']);
  });

  it("counts an arm's cost over the trials whose prompt ran, and its trials that ran as another tool, as the run's own table does", () => {
    const runs = [run({
      id: 'r1', startedAt: '2026-10-20T09:00:00Z',
      trials: { login: { claude: ['passed', 'passed'], codex: ['passed', 'failed'] }, timeout: { claude: ['error'], codex: ['error'] } },
      usage: { claude: { tokens: 1000, durationMs: 60_000, cost: 0.5 }, codex: { tokens: 400, durationMs: 30_000, cost: 0.1 } },
      ranOn: { codex: 'opencode' }, unstarted: ['timeout'],
    })];

    const selected = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected;
    const [claude, codex] = selected?.arms ?? [];

    // The timeout trials errored before their prompt ran: no cost of theirs is missing.
    expect(claude?.pooled?.usage.cost).toEqual({ kind: 'known', amount: 1, unit: 'USD', used: 2 });
    expect({ arm: 'claude', ...claude?.pooled?.usage }).toEqual(selected?.latest.table.usage[0]);
    expect([claude, codex].map((arm) => ({ deviations: arm?.pooled?.deviations, notVerified: arm?.pooled?.notVerified }))).toEqual([{ deviations: 0, notVerified: 0 }, { deviations: 2, notVerified: 0 }]);
  });

  it("gives each task of the current version its pass rate on each arm and in each run, and counts the runs where an arm's repetitions disagreed", () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });
    const [claude, codex] = view.selected?.arms ?? [];

    expect(view.selected?.tasks).toEqual([
      {
        task: 'login', disagreedRuns: 2, unmeasuredRuns: 0,
        arms: [{ key: claude?.key, passed: 3, planned: 4 }, { key: codex?.key, passed: 3, planned: 4 }],
        runs: [{ run: 'r2', baseline: 'valid', passed: 3, planned: 4 }, { run: 'r3', baseline: 'valid', passed: 3, planned: 4 }],
      },
      {
        task: 'logout', disagreedRuns: 0, unmeasuredRuns: 0,
        arms: [{ key: claude?.key, passed: 2, planned: 2 }, { key: codex?.key, passed: 0, planned: 2 }],
        runs: [{ run: 'r2', baseline: 'valid', passed: 1, planned: 2 }, { run: 'r3', baseline: 'valid', passed: 1, planned: 2 }],
      },
    ]);
  });

  it('counts the runs that did not measure a task: its check passed before any change, or the run ended before its baseline', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['passed'] } }, invalid: ['old-bug'], notRun: ['logout'] }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['failed'] }, 'old-bug': { claude: ['passed'], codex: ['passed'] }, logout: { claude: ['passed'], codex: ['passed'] } } }),
    ];

    const selected = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected;

    expect(selected?.tasks.map(({ task, unmeasuredRuns, runs: perRun }) => ({ task, unmeasuredRuns, runs: perRun.map(({ run: id, baseline }) => `${id} ${baseline}`) }))).toEqual([
      { task: 'login', unmeasuredRuns: 0, runs: ['r1 valid', 'r2 valid'] },
      { task: 'old-bug', unmeasuredRuns: 1, runs: ['r1 invalid', 'r2 valid'] },
      { task: 'logout', unmeasuredRuns: 1, runs: ['r1 not_run', 'r2 valid'] },
    ]);
    expect(selected?.runs.map(({ run: id, unmeasuredTasks }) => `${id} ${unmeasuredTasks}`)).toEqual(['r2 0', 'r1 2']);
  });

  it('lists every run of the suite newest first, with who ran it, its version, whether it is current, its team revision, each arm in it and what it cost, and the table of the newest', () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });
    const [claude, codex, sonnet] = view.selected?.arms ?? [];

    expect(view.selected?.runs).toEqual([
      { run: 'r3', source: 'local', startedAt: '2026-10-20T09:00:00Z', username: 'alice', sourceHash: versionOf(history[2]), isCurrent: true, teamRevision: 'team-r3', passed: 4, planned: 6, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: claude?.key, passed: 2, planned: 3 }, { key: codex?.key, passed: 2, planned: 3 }], spend: { spent: { kind: 'known', amount: expect.closeTo(5.4), unit: 'USD', used: 6 } } },
      { run: 'r2', source: 'reported', startedAt: '2026-10-10T09:00:00Z', username: 'bob', sourceHash: versionOf(history[1]), isCurrent: true, teamRevision: 'team-r2', passed: 4, planned: 6, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: claude?.key, passed: 3, planned: 3 }, { key: codex?.key, passed: 1, planned: 3 }], spend: { spent: { kind: 'known', amount: expect.closeTo(1.8), unit: 'USD', used: 6 } } },
      { run: 'r1', source: 'reported', startedAt: '2026-10-01T09:00:00Z', username: 'alice', sourceHash: versionOf(history[0]), isCurrent: false, teamRevision: 'team-r1', passed: 0, planned: 2, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: sonnet?.key, passed: 0, planned: 1 }, { key: codex?.key, passed: 0, planned: 1 }], spend: { spent: { kind: 'unknown' } } },
    ]);
    expect(view.selected?.latest.run).toBe('r3');
    expect(view.selected?.latest.table.matrix).toEqual([
      { task: 'login', arms: [{ arm: 'claude', passRate: { passed: 1, planned: 2 } }, { arm: 'codex', passRate: { passed: 2, planned: 2 } }] },
      { task: 'logout', arms: [{ arm: 'claude', passRate: { passed: 1, planned: 1 } }, { arm: 'codex', passRate: { passed: 0, planned: 1 } }] },
    ]);
  });

  it('opens the suite the query names, and the suite of the newest run otherwise', () => {
    const runs = [...history, run({ id: 'm1', suite: 'migrate-db', startedAt: '2026-10-25T09:00:00Z', arms: [CODEX], trials: { schema: { codex: ['passed'] } } })];

    expect(BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.suite).toBe('migrate-db');
    expect(BenchmarkHistory.of({ runs, query: { windowDays: 90, suite: 'fix-auth' }, now: NOW }).selected?.suite).toBe('fix-auth');
    expect(BenchmarkHistory.of({ runs, query: { windowDays: 30, suite: 'gone' }, now: NOW }).selected?.suite).toBe('migrate-db');
    expect(BenchmarkHistory.of({ runs: [], query: { windowDays: 30 }, now: NOW })).toEqual({ window: expect.any(Object), suites: [] });
  });
});

describe('BenchmarkHistory comparisons', () => {
  const REV = 'b'.repeat(40);
  const matrix: Arm[] = [
    { name: 'claude-pulled', tool: 'claude', team: { kind: 'pulled', revision: REV } },
    { name: 'claude-none', tool: 'claude', team: { kind: 'none' } },
    { name: 'codex-pulled', tool: 'codex', team: { kind: 'pulled', revision: REV } },
    { name: 'codex-none', tool: 'codex', team: { kind: 'none' } },
  ];

  it('compares every two current arms that differ in one dimension trial by trial, measuring the team from none to the pulled revision', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: matrix, trials: {
        login: { 'claude-pulled': ['passed', 'passed'], 'claude-none': ['failed', 'passed'], 'codex-pulled': ['passed', 'failed'], 'codex-none': ['failed', 'failed'] },
        logout: { 'claude-pulled': ['passed'], 'claude-none': ['failed'], 'codex-pulled': ['failed'], 'codex-none': ['passed'] },
      } }),
    ];

    const { comparisons = [], arms = [] } = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected ?? {};
    const nameOf = (key: string): string | undefined => arms.find((arm) => arm.key === key)?.arm;

    expect(comparisons.map(({ dimension, from, to, pairs }) => ({ dimension, from: nameOf(from), to: nameOf(to), pairs }))).toEqual([
      { dimension: 'team', from: 'claude-none', to: 'claude-pulled', pairs: 3 },
      { dimension: 'team', from: 'codex-none', to: 'codex-pulled', pairs: 3 },
      { dimension: 'tool', from: 'claude-pulled', to: 'codex-pulled', pairs: 3 },
      { dimension: 'tool', from: 'claude-none', to: 'codex-none', pairs: 3 },
    ]);
    expect(comparisons[0]).toMatchObject({
      rates: { from: { passed: 1, planned: 3 }, to: { passed: 3, planned: 3 } },
      difference: { value: expect.closeTo(2 / 3) },
      tasks: [{ task: 'login', from: { passed: 1, planned: 2 }, to: { passed: 2, planned: 2 } }, { task: 'logout', from: { passed: 0, planned: 1 }, to: { passed: 1, planned: 1 } }],
    });
    expect(arms.map(({ arm, team }) => ({ arm, team }))).toEqual(matrix.map(({ name, team }) => ({ arm: name, team: { kind: team?.kind } })));
  });

  it('keeps the newest whole-suite run as the current version after a run of some tasks and arms, and shows that run as the latest', () => {
    const whole = run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: matrix, trials: {
      login: { 'claude-pulled': ['passed'], 'claude-none': ['failed'], 'codex-pulled': ['passed'], 'codex-none': ['failed'] },
      logout: { 'claude-pulled': ['passed'], 'claude-none': ['failed'], 'codex-pulled': ['failed'], 'codex-none': ['passed'] },
    } });
    const chosen = run({ id: 'r2', startedAt: '2026-10-21T09:00:00Z', subset: true, arms: matrix.slice(0, 1), trials: { login: { 'claude-pulled': ['failed'] } } });

    const selected = BenchmarkHistory.of({ runs: [whole, chosen], query: { windowDays: 90 }, now: NOW }).selected;

    expect(selected?.versions[0]?.sourceHash).toBe(versionOf(whole));
    expect(selected?.arms.map(({ arm, isCurrent }) => `${arm} ${isCurrent}`)).toEqual(matrix.map(({ name }) => `${name} true`));
    expect(selected?.tasks.map(({ task }) => task)).toEqual(['login', 'logout']);
    expect(selected?.comparisons.map(({ dimension, pairs }) => `${dimension} ${pairs}`)).toEqual(['team 2', 'team 2', 'tool 2', 'tool 2']);
    expect(selected?.latest.run).toBe('r2');
    expect(selected?.runs.map(({ run: id }) => id)).toEqual(['r2', 'r1']);
  });

  it("pools only the runs whose record has the current version's schemaVersion, and keeps an older record's run as a point", () => {
    const older = run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', arms: [CLAUDE], trials: { login: { claude: ['passed', 'passed'] } }, recordVersion: 1 });
    const newer = run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', arms: [CLAUDE], trials: { login: { claude: ['failed', 'passed'] } } });

    const { selected } = BenchmarkHistory.of({ runs: [older, newer], query: { windowDays: 90 }, now: NOW });

    expect(selected?.arms.map(({ arm, pooled, points }) => ({ arm, pooled: pooled && { passed: pooled.passed, planned: pooled.planned, runs: pooled.runs }, points: points.map(({ run: id }) => id) }))).toEqual([
      { arm: 'claude', pooled: { passed: 1, planned: 2, runs: 1 }, points: ['r1', 'r2'] },
    ]);
    expect(selected?.runs.map(({ run: id }) => id)).toEqual(['r2', 'r1']);
  });

  it('takes the newest run as the current version while every run of the suite ran only some of it', () => {
    const chosen = run({ id: 'r1', startedAt: '2026-10-21T09:00:00Z', subset: true, arms: matrix.slice(0, 2), trials: { login: { 'claude-pulled': ['passed'], 'claude-none': ['failed'] } } });

    const selected = BenchmarkHistory.of({ runs: [chosen], query: { windowDays: 90 }, now: NOW }).selected;

    expect(selected?.versions.map(({ sourceHash }) => sourceHash)).toEqual([versionOf(chosen)]);
    expect(selected?.comparisons.map(({ dimension, pairs }) => `${dimension} ${pairs}`)).toEqual(['team 1']);
  });

  it("pairs two arms that differ only in team over every trial, an error counted as not passed, in a run's pairs as in its history", () => {
    const a: Arm = { name: 'a', tool: 'claude' }, b: Arm = { name: 'b', tool: 'claude', team: { kind: 'none' } };
    const input = run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: [a, b], trials: {
      one: { a: ['passed', 'passed', 'passed'], b: ['passed', 'error', 'passed'] },
      two: { a: ['passed', 'passed', 'passed'], b: ['passed', 'passed', 'passed'] },
    } });

    const fromRun = runComparisons(input);
    const fromHistory = BenchmarkHistory.of({ runs: [input], query: { windowDays: 90 }, now: NOW }).selected?.comparisons ?? [];

    for (const comparisons of [fromRun, fromHistory]) {
      expect(comparisons).toHaveLength(1);
      expect(comparisons[0]).toMatchObject({ dimension: 'team', pairs: 6, rates: { from: { passed: 5, planned: 6 }, to: { passed: 6, planned: 6 } } });
    }
  });

  describe('pairs two arms of one run by who decided their trials', () => {
    // Both sides of a pair in one run read the same record's task, so a changed task (row 1) cannot split them.
    const a: Arm = { name: 'a', tool: 'claude' }, b: Arm = { name: 'b', tool: 'claude', team: { kind: 'none' } };
    const OPUS = { by: 'judge', rubric: 'rubric-a', tool: 'claude', model: 'claude-opus-5-5', batched: true } as const;
    const SONNET = { ...OPUS, model: 'claude-sonnet-5-5' } as const;
    const trials = { one: { a: ['passed', 'passed', 'passed'], b: ['passed', 'failed', 'passed'] }, two: { a: ['passed', 'passed', 'passed'], b: ['passed', 'passed', 'passed'] } } satisfies Record<string, Record<string, TrialResult[]>>;

    // A team pair runs from the arm without team resources, b, to the pulled one, a.
    it('leaves out and lists the pairs another model judged (row 2)', () => {
      const input = run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: [a, b], trials, deciders: { a: OPUS, b: { byTask: { one: SONNET, two: OPUS } } } });

      for (const comparisons of [runComparisons(input), BenchmarkHistory.of({ runs: [input], query: { windowDays: 90 }, now: NOW }).selected?.comparisons ?? []]) {
        expect(comparisons).toHaveLength(1);
        expect(comparisons[0]).toMatchObject({ pairs: 3, rates: { from: { passed: 3, planned: 3 }, to: { passed: 3, planned: 3 } }, excluded: [{ pairs: 3, because: { kind: 'judge_changed', from: SONNET, to: OPUS } }] });
      }
    });

    it('compares the pairs a check decided on one arm and the judge on the other (row 3)', () => {
      const input = run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: [a, b], trials, deciders: { a: { by: 'check', task: 'task-one' }, b: OPUS } });

      const [comparison] = runComparisons(input);

      expect(comparison).toMatchObject({ pairs: 6, rates: { from: { passed: 5, planned: 6 }, to: { passed: 6, planned: 6 } } });
      expect(comparison).not.toHaveProperty('excluded');
    });
  });

  it("keeps an arm whose workflow changed apart from its earlier runs, under the workflow it runs now", () => {
    const planFirst: Arm = { name: 'flow', tool: 'claude', workflow: { name: 'plan-then-fix', sourceHash: 'p1' } };
    const direct: Arm = { name: 'flow', tool: 'claude', workflow: { name: 'direct-fix', sourceHash: 'd1' } };
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: [planFirst], trials: { login: { flow: ['failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-21T09:00:00Z', arms: [direct], trials: { login: { flow: ['passed'] } } }),
    ];

    const arms = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.arms ?? [];

    expect(arms.map(({ workflow, isCurrent, points }) => ({ workflow, isCurrent, runs: points.map(({ run: id }) => id) }))).toEqual([
      { workflow: 'direct-fix', isCurrent: true, runs: ['r2'] },
      { workflow: 'plan-then-fix', isCurrent: false, runs: ['r1'] },
    ]);
  });

  it('counts a comparison\'s usage over its paired trials, leaving out a run only one of the arms ran', () => {
    const claude: Arm = { name: 'claude', tool: 'claude' }, codex: Arm = { name: 'codex', tool: 'codex' };
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', arms: [claude], trials: { login: { claude: ['passed'] } }, usage: { claude: { tokens: 900, durationMs: 9000, cost: 9 } } }),
      run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', arms: [claude, codex], trials: { login: { claude: ['passed'], codex: ['failed'] } }, usage: { claude: { tokens: 100, durationMs: 1000, cost: 1 }, codex: { tokens: 200, durationMs: 2000, cost: 2 } } }),
    ];

    const [comparison] = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.comparisons ?? [];

    expect(comparison).toMatchObject({
      dimension: 'tool', pairs: 1,
      usage: {
        from: { tokens: { value: 100 }, durationMs: { value: 1000 }, cost: { kind: 'known', amount: 1, unit: 'USD', used: 1 } },
        to: { tokens: { value: 200 }, durationMs: { value: 2000 }, cost: { kind: 'known', amount: 2, unit: 'USD', used: 1 } },
      },
    });
  });

  it('compares two tools on one model alias, which resolved to each tool\'s own model', () => {
    const arms: Arm[] = [
      { name: 'claude', tool: 'claude', model: 'claude-opus-5-5', alias: 'strong' },
      { name: 'codex', tool: 'codex', model: 'gpt-5.5-codex', alias: 'strong' },
      { name: 'codex-fast', tool: 'codex', model: 'gpt-5.5-mini', alias: 'fast' },
    ];
    const runs = [run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms, trials: { login: { claude: ['passed'], codex: ['failed'], 'codex-fast': ['failed'] } } })];

    const { comparisons = [], arms: series = [] } = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected ?? {};
    const nameOf = (key: string): string | undefined => series.find((arm) => arm.key === key)?.arm;

    expect(comparisons.map(({ dimension, from, to }) => ({ dimension, from: nameOf(from), to: nameOf(to) }))).toEqual([
      { dimension: 'tool', from: 'claude', to: 'codex' },
      { dimension: 'model', from: 'codex', to: 'codex-fast' },
    ]);
  });

  it('compares two arms that differ only in the workflow they run, and never reads a tool and workflow difference as the tool', () => {
    const planned = { name: 'plan-then-fix', sourceHash: 'w1' };
    const arms: Arm[] = [
      { name: 'prompt', tool: 'claude' },
      { name: 'planned', tool: 'claude', workflow: planned },
      { name: 'codex-planned', tool: 'codex', workflow: planned },
    ];
    const runs = [run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms, trials: { login: { prompt: ['failed'], planned: ['passed'], 'codex-planned': ['failed'] } } })];

    const { comparisons = [], arms: series = [] } = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected ?? {};
    const nameOf = (key: string): string | undefined => series.find((arm) => arm.key === key)?.arm;

    expect(comparisons.map(({ dimension, from, to }) => ({ dimension, from: nameOf(from), to: nameOf(to) }))).toEqual([
      { dimension: 'tool', from: 'planned', to: 'codex-planned' },
      { dimension: 'workflow', from: 'prompt', to: 'planned' },
    ]);
    expect(series.map(({ arm, workflow }) => ({ arm, workflow }))).toEqual([
      { arm: 'prompt', workflow: undefined }, { arm: 'planned', workflow: 'plan-then-fix' }, { arm: 'codex-planned', workflow: 'plan-then-fix' },
    ]);
  });

  it('compares two arms that differ only in role on the role, and never reads a tool and role difference as the tool', () => {
    const arms: Arm[] = [
      { name: 'claude-frontend', tool: 'claude', role: 'frontend' },
      { name: 'claude-review', tool: 'claude', role: 'review' },
      { name: 'codex-frontend', tool: 'codex', role: 'frontend' },
      { name: 'codex-review', tool: 'codex', role: 'review' },
    ];
    const runs = [run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms, trials: { login: { 'claude-frontend': ['failed'], 'claude-review': ['passed'], 'codex-frontend': ['failed'], 'codex-review': ['passed'] } } })];

    const { comparisons = [], arms: series = [] } = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected ?? {};
    const nameOf = (key: string): string | undefined => series.find((arm) => arm.key === key)?.arm;

    expect(comparisons.map(({ dimension, from, to }) => ({ dimension, from: nameOf(from), to: nameOf(to) }))).toEqual([
      { dimension: 'tool', from: 'claude-frontend', to: 'codex-frontend' },
      { dimension: 'tool', from: 'claude-review', to: 'codex-review' },
      { dimension: 'role', from: 'claude-frontend', to: 'claude-review' },
      { dimension: 'role', from: 'codex-frontend', to: 'codex-review' },
    ]);
    expect(series.map(({ arm, role }) => ({ arm, role }))).toEqual(arms.map(({ name, role }) => ({ arm: name, role })));
  });

  it('gives a difference of paired trials its 95% interval, which reaches past zero only when the pairs do not tell the arms apart', () => {
    // Wilson bounds of 10/10 and 0/10 are 0.7225 and 0.2775, so the lower bound is 1 - sqrt(2) * 0.2775.
    expect(pairedDifference({ both: 0, toOnly: 10, fromOnly: 0, neither: 0 })).toEqual({ value: 1, low: expect.closeTo(0.6075, 3), high: 1 });
    expect(pairedDifference({ both: 0, toOnly: 0, fromOnly: 10, neither: 0 })).toEqual({ value: -1, low: -1, high: expect.closeTo(-0.6075, 3) });
    const even = pairedDifference({ both: 5, toOnly: 2, fromOnly: 2, neither: 5 });
    expect(even.value).toBe(0);
    expect(even.low).toBeLessThan(0);
    expect(even.high).toBeGreaterThan(0);
  });

  it('follows each tool and model across the team revisions its whole-team arms installed, from run to run and within one run', () => {
    const [first, second] = ['1'.repeat(40), '2'.repeat(40)];
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', arms: [{ name: 'team', tool: 'claude', team: { kind: 'pulled', revision: first } }], trials: { login: { team: ['passed', 'failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-10T09:00:00Z', arms: [
        { name: 'team', tool: 'claude', team: { kind: 'pulled', revision: second } },
        { name: 'before', tool: 'claude', team: { kind: 'ref', ref: 'stable', revision: first } },
        { name: 'bare', tool: 'claude', team: { kind: 'none' } },
      ], trials: { login: { team: ['passed', 'passed'], before: ['failed', 'failed'], bare: ['failed', 'failed'] } } }),
    ];

    const changes = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.teamChanges;

    expect(changes?.configs).toEqual([{ key: '["claude",null,null,null]', tool: 'claude' }]);
    expect(changes?.revisions.map(({ revision, firstRunAt, configs }) => ({ revision, firstRunAt, configs: configs.map(({ runs: count, passed, planned, tasks }) => ({ runs: count, passed, planned, tasks })) }))).toEqual([
      { revision: first, firstRunAt: '2026-10-01T09:00:00Z', configs: [{ runs: 2, passed: 1, planned: 4, tasks: [{ task: 'login', passed: 1, planned: 4 }] }] },
      { revision: second, firstRunAt: '2026-10-10T09:00:00Z', configs: [{ runs: 1, passed: 2, planned: 2, tasks: [{ task: 'login', passed: 2, planned: 2 }] }] },
    ]);
  });

  it('follows each role across team revisions as a line of its own, so two roles on one tool never pool', () => {
    const [first, second] = ['1'.repeat(40), '2'.repeat(40)];
    const roleArms = (revision: string): Arm[] => [
      { name: 'frontend', tool: 'claude', role: 'frontend', team: { kind: 'pulled', revision } },
      { name: 'review', tool: 'claude', role: 'review', team: { kind: 'pulled', revision } },
    ];
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', arms: roleArms(first), trials: { login: { frontend: ['failed'], review: ['passed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-10T09:00:00Z', arms: roleArms(second), trials: { login: { frontend: ['passed'], review: ['passed'] } } }),
    ];

    const changes = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.teamChanges;

    expect(changes?.configs).toEqual([
      { key: '["claude",null,null,null,"frontend"]', tool: 'claude', role: 'frontend' },
      { key: '["claude",null,null,null,"review"]', tool: 'claude', role: 'review' },
    ]);
    expect(changes?.revisions.map(({ revision, configs }) => ({ revision, configs: configs.map(({ key, passed, planned }) => ({ key, passed, planned })) }))).toEqual([
      { revision: first, configs: [{ key: '["claude",null,null,null,"frontend"]', passed: 0, planned: 1 }, { key: '["claude",null,null,null,"review"]', passed: 1, planned: 1 }] },
      { revision: second, configs: [{ key: '["claude",null,null,null,"frontend"]', passed: 1, planned: 1 }, { key: '["claude",null,null,null,"review"]', passed: 1, planned: 1 }] },
    ]);
  });

  it('keeps the keys of arms and configurations without a role as they were before roles', () => {
    const [first, second] = ['1'.repeat(40), '2'.repeat(40)];
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', arms: [{ ...CLAUDE, team: { kind: 'pulled', revision: first } }], trials: { login: { claude: ['passed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-10T09:00:00Z', arms: [{ ...CLAUDE, team: { kind: 'pulled', revision: second } }], trials: { login: { claude: ['passed'] } } }),
    ];

    const selected = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected;

    expect(selected?.arms.map(({ key }) => key)).toEqual(['["claude","claude","claude-opus-5-5",null,{"kind":"pulled"},null]']);
    expect(selected?.teamChanges.configs.map(({ key }) => key)).toEqual(['["claude","claude-opus-5-5",null,null]']);
    expect(selected?.runs.map(({ arms }) => arms.map(({ key }) => key))).toEqual([
      ['["claude","claude","claude-opus-5-5",null,{"kind":"pulled"},null]'], ['["claude","claude","claude-opus-5-5",null,{"kind":"pulled"},null]'],
    ]);
  });

  it('follows a tool and model across team revisions only under one workflow, so a workflow change is not a team change', () => {
    const [first, second] = ['1'.repeat(40), '2'.repeat(40)];
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', arms: [{ name: 'team', tool: 'claude', team: { kind: 'pulled', revision: first } }], trials: { login: { team: ['failed'] } } }),
      run({ id: 'r2', startedAt: '2026-10-10T09:00:00Z', arms: [{ name: 'team', tool: 'claude', workflow: { name: 'plan-then-fix', sourceHash: 'p1' }, team: { kind: 'pulled', revision: second } }], trials: { login: { team: ['passed'] } } }),
    ];

    const changes = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.teamChanges;

    expect(changes).toEqual({ configs: [], revisions: [] });
  });

  it('names the tool version each run reported, so the page can mark a run whose tool changed', () => {
    const runs = [
      run({ id: 'r1', startedAt: '2026-10-01T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['passed'] } }, usage: { claude: { tokens: 1, durationMs: 1 }, codex: { tokens: 1, durationMs: 1 } }, versions: { claude: '2.1.0', codex: '0.40.0' } }),
      run({ id: 'r2', startedAt: '2026-10-10T09:00:00Z', trials: { login: { claude: ['passed'], codex: ['passed'] } }, usage: { claude: { tokens: 1, durationMs: 1 } }, versions: { claude: '2.2.0' } }),
    ];

    expect(BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.runs.map(({ run: id, toolVersions }) => ({ id, toolVersions }))).toEqual([
      { id: 'r2', toolVersions: { claude: '2.2.0' } },
      { id: 'r1', toolVersions: { claude: '2.1.0', codex: '0.40.0' } },
    ]);
  });
});

describe('BenchmarkHistory arms against the defaults arm', () => {
  const CHEAP: Arm = { name: 'cheap', tool: 'claude', model: 'claude-haiku-5-5' };
  const usage = { claude: { tokens: 100, durationMs: 1000, cost: 0.5 }, cheap: { tokens: 100, durationMs: 1000, cost: 0.1 }, codex: { tokens: 100, durationMs: 1000 } };

  // Over both runs, claude and cheap pass 3 of 4 trials each, cheap for a fifth of claude's cost; codex passes 1 of 4 and states no cost.
  const runs = [
    run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', arms: [CLAUDE, CHEAP, CODEX], defaultsArm: 'claude', usage, trials: { login: { claude: ['passed', 'failed'], cheap: ['passed', 'passed'], codex: ['failed', 'failed'] } } }),
    run({ id: 'r2', startedAt: '2026-10-20T09:00:00Z', arms: [CLAUDE, CHEAP, CODEX], defaultsArm: 'claude', usage, trials: { login: { claude: ['passed', 'passed'], cheap: ['passed', 'failed'], codex: ['passed', 'failed'] } } }),
  ];

  it('reads each current arm against the defaults arm over the runs of the current version, with the paired difference and dominance by cost per passed trial', () => {
    const selected = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected;
    const [claude, cheap, codex] = selected?.arms ?? [];

    // Newcombe intervals: cheap 0 pp (-55 to +55) from 2 pairs both passed and one each way; codex -50 pp (-79 to +14).
    expect(selected?.against).toEqual({
      reference: claude?.key, isDefaultsArm: true,
      arms: [
        { arm: 'cheap', key: cheap?.key, difference: { value: 0, low: expect.closeTo(-0.55, 2), high: expect.closeTo(0.55, 2) }, dominance: { kind: 'dominates', passRate: 'same', costRatio: expect.closeTo(0.2, 6) } },
        { arm: 'codex', key: codex?.key, difference: { value: -0.5, low: expect.closeTo(-0.79, 2), high: expect.closeTo(0.14, 2) } },
      ],
    });
  });

  it('reads the newest run on its own too, as its table reads it, for the last run', () => {
    const latest = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.latest;

    // In r2 alone cheap passes 1 of 2 for 0.20 USD, claude 2 of 2 for 1.00 USD: cheaper per passed trial, but lower.
    expect(latest?.against?.arms[0]).toEqual({
      arm: 'cheap', key: expect.any(String), difference: { value: -0.5, low: expect.closeTo(-0.91, 2), high: expect.closeTo(0.27, 2) }, dominance: { kind: 'neither', passRate: 'lower', costRatio: expect.closeTo(0.4, 6) },
    });
  });

  it('reads the arms against the first arm in a suite without a defaults arm, and marks neither an arm that costs less per passed trial but passes less', () => {
    const cheaper = [run({ id: 'r1', startedAt: '2026-10-20T09:00:00Z', arms: [CLAUDE, CHEAP], usage, trials: { login: { claude: ['passed', 'passed', 'failed'], cheap: ['passed', 'failed', 'failed'] } } })];
    const selected = BenchmarkHistory.of({ runs: cheaper, query: { windowDays: 90 }, now: NOW }).selected;
    const [claude, cheap] = selected?.arms ?? [];

    // claude: 1.50 USD over 2 passed trials, 0.75 each; cheap: 0.30 USD over 1, 0.30.
    expect(selected?.against).toMatchObject({ reference: claude?.key, isDefaultsArm: false, arms: [{ key: cheap?.key, dominance: { kind: 'neither', passRate: 'lower', costRatio: expect.closeTo(0.4, 6) } }] });
  });

  /** `input` judged by a correctness rubric of `labels`, each arm's correctness verdicts scored `scores` in trial order. */
  const scored = (input: BenchmarkRunInput, labels: Array<{ value: string; score: number }>, scores: Record<string, number[]>): BenchmarkRunInput => {
    const seen = new Map<string, number>();

    return { ...input, benchmark: { ...input.benchmark,
      scorers: [{ name: 'teamai:correctness:login', rubric: { sourceHash: 'rubric' }, labels, passingScore: 1 }],
      trials: input.benchmark.trials.map((trial) => {
        const index = seen.get(trial.arm) ?? 0;
        seen.set(trial.arm, index + 1);

        return { ...trial, verdicts: trial.verdicts?.map((verdict) => (verdict.outcome.kind === 'labelled' ? { ...verdict, outcome: { ...verdict.outcome, score: scores[trial.arm]?.[index] ?? 0 } } : verdict)) };
      }) } };
  };

  it("pools each arm's mean correctness score over the runs whose correctness rubric has more than two labels, as each run's table shows it", () => {
    const CHECK: Decider = { by: 'check', task: 'task-login' };
    const graded = [{ value: 'correct', score: 1 }, { value: 'partial', score: 0.5 }, { value: 'incorrect', score: 0 }];
    const passFail = [{ value: 'correct', score: 1 }, { value: 'incorrect', score: 0 }];
    const deciders = { claude: CHECK, codex: CHECK };
    const scoredRuns = [
      scored(run({ id: 'r1', startedAt: '2026-10-10T09:00:00Z', deciders, trials: { login: { claude: ['passed', 'failed'], codex: ['failed', 'failed'] } } }), graded, { claude: [1, 0.5], codex: [0.5, 0] }),
      scored(run({ id: 'r2', startedAt: '2026-10-15T09:00:00Z', deciders, trials: { login: { claude: ['passed', 'failed'], codex: ['passed', 'failed'] } } }), graded, { claude: [1, 0], codex: [1, 0.5] }),
      // A run judged with a pass or fail rubric: its scores are a pass rate again, so no mean reads them.
      scored(run({ id: 'r3', startedAt: '2026-10-20T09:00:00Z', deciders, trials: { login: { claude: ['failed'], codex: ['passed'] } } }), passFail, { claude: [0], codex: [1] }),
    ];

    const arms = BenchmarkHistory.of({ runs: scoredRuns, query: { windowDays: 90 }, now: NOW }).selected?.arms ?? [];

    expect(arms.map(({ pooled }) => pooled?.correctnessScore)).toEqual([{ labelled: 4, mean: 0.625 }, { labelled: 4, mean: 0.5 }]);
  });
});

describe('BenchmarkHistory judging', () => {
  const SONNET = { by: 'judge' as const, rubric: 'rq', tool: 'claude', model: 'claude-sonnet-5-5', batched: false };
  const HAIKU = { by: 'judge' as const, rubric: 'rc', tool: 'claude', model: 'claude-haiku-5-5', batched: false };
  const labelled = (passed: boolean) => ({ kind: 'labelled' as const, label: passed ? 'good' : 'poor', score: passed ? 1 : 0, passed });

  /**
   * A run of a check-only task, expired-token, and a task with a check and success criteria, login-copy, whose
   * correctness the plan pins to claude `fast` and review-quality to claude `judge`. Each trial's verdicts: its
   * correctness label, by the check or, on login-copy's passing check, by claude-haiku-5-5; then `review`'s.
   */
  const judgedRun = (id: string, startedAt: string, review: (trial: { task: string; arm: string }) => TrialVerdict) => {
    const input = run({ id, startedAt, trials: { 'expired-token': { claude: ['passed'], codex: ['failed'] }, 'login-copy': { claude: ['passed'], codex: ['failed'] } } });

    return { ...input, benchmark: { ...input.benchmark,
      calibration: { rate: 0 },
      tasks: input.benchmark.tasks.map((task) => ({ ...task, judge: task.id === 'login-copy' ? 'both' as const : 'check' as const })),
      judges: { 'teamai:correctness:login-copy': { tool: 'claude', model: 'fast' }, 'review-quality': { tool: 'claude', model: 'judge' } },
      trials: input.benchmark.trials.map((trial) => ({ ...trial, verdicts: [
        { scorer: `teamai:correctness:${trial.task}`, outcome: labelled(trial.result === 'passed'), ...(trial.task === 'login-copy' && trial.result === 'passed' ? { decider: HAIKU, asPlanned: 'match' as const } : { decider: { by: 'check' as const, task: `task-${trial.task}` } }) },
        review(trial),
      ] })) } };
  };

  const runs = [
    judgedRun('r1', '2026-10-10T09:00:00Z', () => ({ scorer: 'review-quality', outcome: labelled(true), decider: SONNET, asPlanned: 'match' })),
    // In r2 codex judged codex's login-copy trial, and nothing labelled its expired-token trial.
    judgedRun('r2', '2026-10-20T09:00:00Z', ({ task, arm }) => (arm !== 'codex' ? { scorer: 'review-quality', outcome: labelled(true), decider: SONNET, asPlanned: 'match' }
      : task === 'login-copy' ? { scorer: 'review-quality', outcome: labelled(false), decider: { ...SONNET, tool: 'codex', model: 'gpt-6-sol' }, asPlanned: 'deviation' }
        : { scorer: 'review-quality', outcome: { kind: 'unscored', because: 'run_ended' } })),
  ];

  it('says, per scorer over the runs of the current version, the judge the runs pinned, who decided its labels, and how many deviated', () => {
    const judging = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.judging;

    expect(judging?.scorers).toEqual([
      { scorer: 'teamai:correctness', planned: [{ tool: 'claude', model: 'fast' }], byCheck: 6, byJudge: [{ judge: { tool: 'claude', model: 'claude-haiku-5-5' }, labels: 2 }], deviations: 0, notVerified: 0, unscored: 0 },
      {
        scorer: 'review-quality', planned: [{ tool: 'claude', model: 'judge' }], byCheck: 0,
        byJudge: [{ judge: { tool: 'claude', model: 'claude-sonnet-5-5' }, labels: 6 }, { judge: { tool: 'codex', model: 'gpt-6-sol' }, labels: 1 }], deviations: 1, notVerified: 0, unscored: 1,
      },
    ]);
    // The arms vary the tool, and claude judges: the run's table says so too.
    expect(judging?.selfJudged).toEqual([{ tool: 'claude', arm: 'claude' }]);
  });

  it('says why no judge was calibrated: the suite\'s calibration rate, how many tasks have a check and success criteria, and how many of their trials failed the check', () => {
    const judging = BenchmarkHistory.of({ runs, query: { windowDays: 90 }, now: NOW }).selected?.judging;

    // login-copy has both, as its record says; codex failed its check in each run, and the suite calibrates nothing.
    expect(judging?.calibration).toEqual({ judges: [], rate: 0, mixedTasks: 1, failedChecks: 2 });
  });

  it("pools each correctness judge's calibration over the runs, with the false pass rate's 95% interval", () => {
    const HIGH = { ...HAIKU, model: 'claude-opus-5-5', effort: 'high' };
    const calibrated = (input: BenchmarkRunInput, calibrations: Array<{ passed: boolean; decider: typeof HAIKU }>): BenchmarkRunInput => {
      let index = 0;

      return { ...input, benchmark: { ...input.benchmark, trials: input.benchmark.trials.map((trial) => {
        const calibration = trial.task === 'login-copy' && trial.result === 'failed' ? undefined : calibrations[index++];

        return calibration ? { ...trial, calibration: { label: calibration.passed ? 'correct' : 'incorrect', ...calibration } } : trial;
      }) } };
    };
    const calibratedRuns = [
      calibrated(judgedRun('r1', '2026-10-10T09:00:00Z', () => ({ scorer: 'review-quality', outcome: labelled(true) })), [{ passed: true, decider: HAIKU }, { passed: false, decider: HAIKU }]),
      calibrated(judgedRun('r2', '2026-10-20T09:00:00Z', () => ({ scorer: 'review-quality', outcome: labelled(true) })), [{ passed: false, decider: HAIKU }, { passed: false, decider: HIGH }]),
    ];

    const { judges } = BenchmarkHistory.of({ runs: calibratedRuns, query: { windowDays: 90 }, now: NOW }).selected?.judging.calibration ?? { judges: [] };

    // Wilson: 1 of 3 is 6% to 79%; 0 of 1 is 0% to 79%.
    expect(judges).toEqual([
      { judge: { tool: 'claude', model: 'claude-haiku-5-5' }, judged: 3, passing: 1, interval: { low: expect.closeTo(0.061, 3), high: expect.closeTo(0.792, 3) } },
      { judge: { tool: 'claude', model: 'claude-opus-5-5', effort: 'high' }, judged: 1, passing: 0, interval: { low: 0, high: expect.closeTo(0.793, 3) } },
    ]);
  });
});

describe('BenchmarkHistory scorers by arm', () => {
  const SONNET = { by: 'judge' as const, rubric: 'rq', tool: 'claude', model: 'claude-sonnet-5-5', batched: true };
  const REVIEW = { name: 'review-quality', rubric: { sourceHash: 'rq' }, labels: [{ value: 'good', score: 1 }, { value: 'poor', score: 0 }], passingScore: 1 };
  const verdict = (passed: boolean | undefined): TrialVerdict => (passed === undefined
    ? { scorer: 'review-quality', outcome: { kind: 'unscored', because: 'run_ended' } }
    : { scorer: 'review-quality', outcome: { kind: 'labelled', label: passed ? 'good' : 'poor', score: passed ? 1 : 0, passed }, decider: SONNET, asPlanned: 'match' });

  /** A run of task fix whose review-quality scorer labelled each arm's trials passing as `labels` says in trial order; undefined leaves one unscored. */
  const reviewed = (id: string, startedAt: string, labels: Record<string, Array<boolean | undefined>>): BenchmarkRunInput => {
    const input = run({ id, startedAt, trials: { fix: { claude: ['passed', 'passed'], codex: ['failed', 'failed'] } } });
    const seen = new Map<string, number>();

    return { ...input, benchmark: { ...input.benchmark, scorers: [REVIEW], trials: input.benchmark.trials.map((trial) => {
      const index = seen.get(trial.arm) ?? 0;
      seen.set(trial.arm, index + 1);

      return { ...trial, verdicts: [verdict(labels[trial.arm]?.[index])] };
    }) } };
  };

  it("pools each suite and task scorer's labels per arm over the runs of the current version, with the 95% interval", () => {
    const reviewedRuns = [
      reviewed('r1', '2026-10-10T09:00:00Z', { claude: [true, true], codex: [false, true] }),
      reviewed('r2', '2026-10-20T09:00:00Z', { claude: [true, false], codex: [false, undefined] }),
    ];
    const selected = BenchmarkHistory.of({ runs: reviewedRuns, query: { windowDays: 90 }, now: NOW }).selected;
    const [claude, codex] = selected?.arms ?? [];

    // Wilson: claude's 3 of 4 is 30% to 95%; codex's 1 of 3 is 6% to 79%, beside the one nothing labelled.
    expect(selected?.scorers).toEqual([{ scorer: 'review-quality', arms: [
      { key: claude?.key, passed: 3, labelled: 4, unscored: 0, interval: { low: expect.closeTo(0.301, 3), high: expect.closeTo(0.954, 3) } },
      { key: codex?.key, passed: 1, labelled: 3, unscored: 1, interval: { low: expect.closeTo(0.061, 3), high: expect.closeTo(0.792, 3) } },
    ] }]);
  });
});

describe('BenchmarkHistory spend against the estimate', () => {
  const RANGE = { unit: 'USD', low: 1, median: 1.5, high: 2, complete: true };
  /** A run of task fix whose agents stated `costs` and whose judge cost 0.25 USD a trial, and what start estimated it from r0; null when it had no earlier run to estimate from. */
  const spending = (id: string, day: number, costs: { claude: number; codex?: number }, total: typeof RANGE | null = RANGE): BenchmarkRunInput => {
    const input = run({ id, startedAt: `2026-10-${day}T09:00:00Z`, trials: { fix: { claude: ['passed'], codex: ['failed'] } }, usage: { claude: { tokens: 1, durationMs: 1, cost: costs.claude }, codex: { tokens: 1, durationMs: 1, cost: costs.codex } } });

    return { ...input, benchmark: { ...input.benchmark,
      ...(total ? { estimate: { trials: 2, judgeCalls: 2, judgedTrials: 2, calibrationCalls: 0, basis: { run: 'r0' }, total } } : {}),
      trials: input.benchmark.trials.map((trial) => ({ ...trial, scoringCost: { amount: 0.25, unit: 'USD', complete: true } })) } };
  };

  it("puts what each run's agents and judges cost beside the estimate, when start made one, flagged outside its range only when the estimate is complete and the cost could be too low", () => {
    const spendingRuns = [
      spending('within', 10, { claude: 0.5, codex: 0.5 }),
      spending('above', 11, { claude: 1, codex: 1 }),
      spending('below', 12, { claude: 0.125, codex: 0.125 }),
      // codex stated no cost: what it spent is at least 0.75 USD, which may be within the range.
      spending('unstated', 13, { claude: 0.25 }),
      spending('partial', 14, { claude: 1, codex: 1 }, { ...RANGE, complete: false }),
      spending('unestimated', 15, { claude: 1, codex: 1 }, null),
    ];
    const rows = BenchmarkHistory.of({ runs: spendingRuns, query: { windowDays: 90 }, now: NOW }).selected?.runs ?? [];

    expect(rows.map(({ run: id, spend }) => [id, spend?.spent, spend?.outside])).toEqual([
      ['unestimated', { kind: 'known', amount: 2.5, unit: 'USD', used: 4 }, undefined],
      ['partial', { kind: 'known', amount: 2.5, unit: 'USD', used: 4 }, undefined],
      ['unstated', { kind: 'incomplete', amount: 0.75, unit: 'USD', used: 3, unknown: 1 }, undefined],
      ['below', { kind: 'known', amount: 0.75, unit: 'USD', used: 4 }, 'below'],
      ['above', { kind: 'known', amount: 2.5, unit: 'USD', used: 4 }, 'above'],
      ['within', { kind: 'known', amount: 1.5, unit: 'USD', used: 4 }, undefined],
    ]);
    expect(rows.find(({ run: id }) => id === 'within')?.spend?.estimated).toEqual(RANGE);
    expect(rows.find(({ run: id }) => id === 'unestimated')?.spend?.estimated).toBeUndefined();
  });

  it('counts what calibrating a judge cost in what the run spent, as the estimate counts its calls', () => {
    const plain = spending('calibrated', 16, { claude: 0.5, codex: 0.5 });
    const decider = { by: 'judge' as const, rubric: 'rc', tool: 'claude', model: 'claude-haiku-5-5', batched: false };
    const calibrated = { ...plain, benchmark: { ...plain.benchmark, trials: plain.benchmark.trials.map((trial) => (trial.arm === 'codex'
      ? { ...trial, calibration: { label: 'incorrect', passed: false, decider, scoringCost: { amount: 0.5, unit: 'USD', complete: true } } } : trial)) } };
    const [row] = BenchmarkHistory.of({ runs: [calibrated], query: { windowDays: 90 }, now: NOW }).selected?.runs ?? [];

    // The agents' 1 USD, the two trials' judging 0.5 USD, and the calibration 0.5 USD.
    expect(row?.spend.spent).toEqual({ kind: 'known', amount: 2, unit: 'USD', used: 5 });
  });

  it('leaves what the run spent incomplete, never below the estimate, when a judge or a calibration that ran stated no cost', () => {
    const plain = spending('cheap', 17, { claude: 0.125, codex: 0.125 });
    const decider = { by: 'judge' as const, rubric: 'rc', tool: 'claude', model: 'claude-haiku-5-5', batched: false };
    // claude's judge launched and stated nothing, as its record says; codex's calibration stated nothing either.
    const unstated = (trial: BenchmarkRunInput['benchmark']['trials'][number]) => (trial.arm === 'claude'
      ? { ...trial, scoringCost: { complete: false as const }, verdicts: [{ scorer: 'quality', outcome: { kind: 'labelled' as const, label: 'good', score: 1, passed: true }, decider }] }
      : { ...trial, calibration: { label: 'incorrect', passed: false, decider } });
    const judged = { ...plain, benchmark: { ...plain.benchmark, trials: plain.benchmark.trials.map(unstated) } };
    const [row] = BenchmarkHistory.of({ runs: [judged], query: { windowDays: 90 }, now: NOW }).selected?.runs ?? [];

    // The agents' 0.25 USD and codex's judging 0.25 USD are known; claude's judge and codex's calibration stated nothing.
    expect(row?.spend).toEqual({ estimated: RANGE, spent: { kind: 'incomplete', amount: 0.5, unit: 'USD', used: 3, unknown: 2 } });
  });
});

describe('benchmark regression', () => {
  const ONE = [CLAUDE];
  const passes = (results: TrialResult[]) => ({ fix: { claude: results } });
  const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`;
  const current = run({ id: 'now', startedAt: at(20), arms: ONE, trials: passes(['failed', 'failed', 'failed']) });

  it('compares with the newest earlier succeeded run of the same suite and arms, whatever revision its team resolved to', () => {
    const regression = regressionOf(current, [
      run({ id: 'older', startedAt: at(10), arms: ONE, trials: passes(['passed', 'failed', 'failed']) }),
      run({ id: 'newest', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
      { ...run({ id: 'failed-run', startedAt: at(14), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }), outcome: 'failed' },
      run({ id: 'other-model', startedAt: at(15), arms: [{ ...CLAUDE, model: 'claude-sonnet-5-5' }], trials: passes(['passed', 'passed', 'passed']) }),
      run({ id: 'other-suite', suite: 'other', startedAt: at(17), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
      run({ id: 'later', startedAt: at(25), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
    ]);

    expect(regression).toEqual({
      kind: 'dropped', against: 'newest', arms: [{ arm: 'claude', pairs: 3, excluded: [] }],
      drops: [{ arm: 'claude', pairs: 3, rates: { from: { passed: 3, planned: 3 }, to: { passed: 0, planned: 3 } }, difference: { value: -1, low: -1, high: expect.closeTo(-0.206, 3) } }],
    });
  });

  it('pairs each trial with the earlier trial of its task and repetition', () => {
    // By repetition: the first only now, the next seven only before, two both times, the last three neither time.
    const now = run({ id: 'now', startedAt: at(20), arms: ONE, trials: passes(['passed', ...Array<TrialResult>(7).fill('failed'), 'passed', 'passed', 'failed', 'failed', 'failed']) });
    const before = run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['failed', ...Array<TrialResult>(7).fill('passed'), 'passed', 'passed', 'failed', 'failed', 'failed']) });

    expect(regressionOf(now, [before])).toEqual({
      kind: 'dropped', against: 'before', arms: [{ arm: 'claude', pairs: 13, excluded: [] }],
      drops: [{ arm: 'claude', pairs: 13, rates: { from: { passed: 9, planned: 13 }, to: { passed: 3, planned: 13 } }, difference: pairedDifference({ both: 2, toOnly: 1, fromOnly: 7, neither: 3 }) }],
    });
  });

  const OPUS = { by: 'judge', rubric: 'rubric-a', tool: 'claude', model: 'claude-opus-5-5', batched: true } as const;
  const SONNET = { ...OPUS, model: 'claude-sonnet-5-5' } as const;
  const CHECKED = { by: 'check', task: 'task-fix' } as const;

  it('excludes the pairs of a task whose file changed, and compares the others (row 1)', () => {
    const both = (results: TrialResult[]) => ({ fix: { claude: results }, login: { claude: results } });
    const now = run({ id: 'now', startedAt: at(20), arms: ONE, trials: both(['failed', 'failed', 'failed']) });
    const before = run({ id: 'before', startedAt: at(12), editedTasks: ['login'], arms: ONE, trials: both(['passed', 'passed', 'passed']) });

    expect(regressionOf(now, [before])).toMatchObject({ kind: 'dropped', against: 'before', arms: [{ arm: 'claude', pairs: 3, excluded: [{ pairs: 3, because: { kind: 'task_changed' } }] }] });
    expect(regressionOf(current, [run({ id: 'other-task', startedAt: at(16), taskEdit: '-edited', arms: ONE, trials: passes(['passed', 'passed', 'passed']) })])).toEqual({
      kind: 'no_comparable', tried: { run: 'other-task', arms: [{ arm: 'claude', pairs: 0, excluded: [{ pairs: 3, because: { kind: 'task_changed' } }] }] },
    });
  });

  it('finds nothing comparable, naming the run it tried and why, when another model judged every pair (row 2)', () => {
    const nine = (passed: number): TrialResult[] => Array.from({ length: 9 }, (_, index) => (index < passed ? 'passed' : 'failed'));
    const before = run({ id: 'rA', startedAt: at(12), arms: ONE, trials: passes(nine(8)), deciders: { claude: OPUS } });
    const now = run({ id: 'rB', startedAt: at(13), arms: ONE, trials: passes(nine(4)), deciders: { claude: SONNET } });

    const regression = regressionOf(now, [before]);

    expect(regression).toEqual({ kind: 'no_comparable', tried: { run: 'rA', arms: [{ arm: 'claude', pairs: 0, excluded: [{ pairs: 9, because: { kind: 'judge_changed', from: OPUS, to: SONNET } }] }] } });
    expect(formatRegression(regression, 'fix-auth')).toEqual([
      'Arm claude: 0 comparable pairs against run rA; 9 excluded: their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5).',
      'No arm has a comparable pair against run rA, so --fail-on-regression has nothing to compare with.',
    ]);
  });

  it.each([
    ['by the check before and by the judge now, as a mixed task whose check flipped', CHECKED, OPUS, ['failed', 'failed', 'failed']],
    ['by the same judge', OPUS, OPUS, ['failed', 'failed', 'failed']],
    ['by the judge before and by nothing now, as an unscored trial counts as not passed', OPUS, undefined, ['unscored', 'unscored', 'unscored']],
  ] as const)('compares the pairs decided %s (row 3)', (_pair, from, to, results) => {
    const before = run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']), deciders: { claude: from } });
    const now = run({ id: 'now', startedAt: at(20), arms: ONE, trials: passes([...results]), deciders: to === undefined ? {} : { claude: to } });

    const regression = regressionOf(now, [before]);

    expect(regression).toMatchObject({ kind: 'dropped', against: 'before', arms: [{ arm: 'claude', pairs: 3, excluded: [] }], drops: [{ arm: 'claude', pairs: 3 }] });
    expect(formatRegression(regression, 'fix-auth')).toEqual([
      'Arm claude: 3 comparable pairs against run before.',
      expect.stringMatching(/^Arm "claude" passed 0\/3 paired trials, against 3\/3 in run before: a drop of 100 points/),
    ]);
  });

  it('holds when the paired drop is within chance', () => {
    expect(regressionOf(current, [run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'failed', 'failed']) })])).toEqual({ kind: 'held', against: 'before', arms: [{ arm: 'claude', pairs: 3, excluded: [] }] });
  });

  it('finds nothing to compare with in a run whose record has another schemaVersion', () => {
    expect(regressionOf(current, [run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']), recordVersion: 1 })])).toEqual({ kind: 'no_comparable' });
  });

  it('finds nothing to compare with when an arm ran another workflow or team choice before', () => {
    const before = run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']) });
    const withWorkflow = { ...before, benchmark: { ...before.benchmark, arms: before.benchmark.arms.map((arm) => ({ ...arm, workflow: { name: 'fixer', sourceHash: 'h' } })) } };
    const without = run({ id: 'without', startedAt: at(12), arms: [{ ...CLAUDE, team: { kind: 'without', paths: ['skills/fixer'], revision: 'team-without' } }], trials: passes(['passed', 'passed', 'passed']) });

    expect(regressionOf(current, [withWorkflow, without])).toEqual({ kind: 'no_comparable' });
  });
});
