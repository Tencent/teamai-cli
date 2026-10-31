import { describe, expect, it } from 'vitest';
import { BenchmarkHistory, pairedDifference, regressionOf, runComparisons, type BenchmarkRunInput } from '../benchmark/history.js';
import { runSourceHash } from '../benchmark/plan.js';
import type { Baseline, TrialResult } from '../benchmark/result.js';
import type { ArmTeam } from '../benchmark/terms.js';

const NOW = new Date('2026-10-28T12:00:00Z');

/** `team`: the pulled revision of the run when absent. */
type Arm = { name: string; tool: string; model?: string; alias?: string; team?: ArmTeam; workflow?: { name: string; sourceHash: string } };
const CLAUDE: Arm = { name: 'claude', tool: 'claude', model: 'claude-opus-5-5' };
const CODEX: Arm = { name: 'codex', tool: 'codex' };

/**
 * An ended benchmark run of `suite`. `trials` lists each task's results on each arm, one per repetition, as
 * `{ task: { arm: [results] } }`. A task in `invalid` had an invalid baseline, one in `notRun` none, as the run ended
 * first. A trial of an arm in `usage` ran its prompt, on the arm's tool or on the one `ranOn` names, unless its task is
 * in `unstarted`, and reported the tool version `versions` names for its tool.
 */
function run({ id, suite = 'fix-auth', version = 'v1', taskEdit = '', startedAt, username = 'alice', source = 'reported', arms = [CLAUDE, CODEX], trials, invalid = [], notRun = [], usage = {}, ranOn = {}, unstarted = [], versions = {} }: {
  id: string;
  suite?: string;
  version?: string;
  /** Appended to each task file's hash: an edit to the task files that leaves suite.yaml as it was. */
  taskEdit?: string;
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
}): BenchmarkRunInput {
  const tasks = [...Object.keys(trials), ...invalid, ...notRun];
  const baseline = (task: string): Baseline => (invalid.includes(task) ? 'invalid' : notRun.includes(task) ? 'not_run' : 'valid');
  let order = 0;
  return {
    run: id, source, username, startedAt, outcome: 'succeeded',
    benchmark: {
      suite: { name: suite, sourceHash: version }, repetitions: 1, baselineTeamRevision: `team-${id}`, scorers: [],
      tasks: tasks.map((task) => ({ id: task, startingCommit: 'a'.repeat(40), sourceHash: `task-${task}${taskEdit}`, baseline: baseline(task) })),
      arms: arms.map(({ team, ...arm }) => ({ ...arm, source: 'team', team: team ?? { kind: 'pulled' as const, revision: `team-${id}` } })),
      trials: Object.entries(trials).flatMap(([task, byArm]) => Object.entries(byArm).flatMap(([arm, results]) => results.map((result, repetition) => {
        const step = `trials.r${repetition + 1}.${task}.${arm}.prompt`;
        const spent = unstarted.includes(task) ? undefined : usage[arm];
        const own = arms.find(({ name }) => name === arm);
        const tool = ranOn[arm] ?? own?.tool;
        const toolVersion = tool === undefined ? undefined : versions[tool];
        const agent = spent && own && tool !== undefined
          ? { v: 1 as const, tool: { name: tool, ...(toolVersion ? { version: toolVersion } : {}) }, ...(own.model ? { model: { reported: own.model } } : {}), team: { revision: `team-${id}`, localChanges: false }, teamai: '0.0.0', driver: 'local' }
          : undefined;
        return {
          task, arm, repetition: repetition + 1, order: order++, step, result, ...(agent ? { agent } : {}),
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

  it('lists every run of the suite newest first, with who ran it, its version and team revision, and each arm in it, and the table of the newest', () => {
    const view = BenchmarkHistory.of({ runs: history, query: { windowDays: 90 }, now: NOW });
    const [claude, codex, sonnet] = view.selected?.arms ?? [];

    expect(view.selected?.runs).toEqual([
      { run: 'r3', source: 'local', startedAt: '2026-10-20T09:00:00Z', username: 'alice', sourceHash: versionOf(history[2]), teamRevision: 'team-r3', passed: 4, planned: 6, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: claude?.key, passed: 2, planned: 3 }, { key: codex?.key, passed: 2, planned: 3 }] },
      { run: 'r2', source: 'reported', startedAt: '2026-10-10T09:00:00Z', username: 'bob', sourceHash: versionOf(history[1]), teamRevision: 'team-r2', passed: 4, planned: 6, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: claude?.key, passed: 3, planned: 3 }, { key: codex?.key, passed: 1, planned: 3 }] },
      { run: 'r1', source: 'reported', startedAt: '2026-10-01T09:00:00Z', username: 'alice', sourceHash: versionOf(history[0]), teamRevision: 'team-r1', passed: 0, planned: 2, unmeasuredTasks: 0, toolVersions: {}, arms: [{ key: sonnet?.key, passed: 0, planned: 1 }, { key: codex?.key, passed: 0, planned: 1 }] },
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

describe('benchmark regression', () => {
  const ONE = [CLAUDE];
  const passes = (results: TrialResult[]) => ({ fix: { claude: results } });
  const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T09:00:00Z`;
  const current = run({ id: 'now', startedAt: at(20), arms: ONE, trials: passes(['failed', 'failed', 'failed']) });

  it('compares with the newest earlier succeeded run of the same suite, tasks and arms, whatever revision its team resolved to', () => {
    const regression = regressionOf(current, [
      run({ id: 'older', startedAt: at(10), arms: ONE, trials: passes(['passed', 'failed', 'failed']) }),
      run({ id: 'newest', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
      { ...run({ id: 'failed-run', startedAt: at(14), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }), outcome: 'failed' },
      run({ id: 'other-model', startedAt: at(15), arms: [{ ...CLAUDE, model: 'claude-sonnet-5-5' }], trials: passes(['passed', 'passed', 'passed']) }),
      run({ id: 'other-task', startedAt: at(16), taskEdit: '-edited', arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
      run({ id: 'other-suite', suite: 'other', startedAt: at(17), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
      run({ id: 'later', startedAt: at(25), arms: ONE, trials: passes(['passed', 'passed', 'passed']) }),
    ]);

    expect(regression).toEqual({
      kind: 'dropped', against: 'newest',
      arms: [{ arm: 'claude', pairs: 3, rates: { from: { passed: 3, planned: 3 }, to: { passed: 0, planned: 3 } }, difference: { value: -1, low: -1, high: expect.closeTo(-0.206, 3) } }],
    });
  });

  it('pairs each trial with the earlier trial of its task and repetition', () => {
    // By repetition: the first only now, the next seven only before, two both times, the last three neither time.
    const now = run({ id: 'now', startedAt: at(20), arms: ONE, trials: passes(['passed', ...Array<TrialResult>(7).fill('failed'), 'passed', 'passed', 'failed', 'failed', 'failed']) });
    const before = run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['failed', ...Array<TrialResult>(7).fill('passed'), 'passed', 'passed', 'failed', 'failed', 'failed']) });

    expect(regressionOf(now, [before])).toEqual({
      kind: 'dropped', against: 'before',
      arms: [{ arm: 'claude', pairs: 13, rates: { from: { passed: 9, planned: 13 }, to: { passed: 3, planned: 13 } }, difference: pairedDifference({ both: 2, toOnly: 1, fromOnly: 7, neither: 3 }) }],
    });
  });

  it('holds when the paired drop is within chance', () => {
    expect(regressionOf(current, [run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'failed', 'failed']) })])).toEqual({ kind: 'held', against: 'before' });
  });

  it('finds nothing to compare with when an arm ran another workflow or team choice before', () => {
    const before = run({ id: 'before', startedAt: at(12), arms: ONE, trials: passes(['passed', 'passed', 'passed']) });
    const withWorkflow = { ...before, benchmark: { ...before.benchmark, arms: before.benchmark.arms.map((arm) => ({ ...arm, workflow: { name: 'fixer', sourceHash: 'h' } })) } };
    const without = run({ id: 'without', startedAt: at(12), arms: [{ ...CLAUDE, team: { kind: 'without', paths: ['skills/fixer'], revision: 'team-without' } }], trials: passes(['passed', 'passed', 'passed']) });

    expect(regressionOf(current, [withWorkflow, without])).toEqual({ kind: 'no_comparable' });
  });
});
