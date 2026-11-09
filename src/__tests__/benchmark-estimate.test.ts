import { describe, expect, it } from 'vitest';
import { estimateOf, formatEstimate, judgeCallsOf } from '../benchmark/estimate.js';
import type { BenchmarkRunInput } from '../benchmark/history.js';
import type { BenchmarkPlan, PlannedArm } from '../benchmark/plan.js';
import type { BenchmarkRecord } from '../benchmark/result.js';

const TEAM = 'a'.repeat(40);
const arm = (name: string, tool = 'claude'): PlannedArm => ({ name, tool, source: 'team', team: { kind: 'pulled', revision: TEAM } });

/** A plan of `arms` on two tasks, three repetitions each. */
function planOf(arms: PlannedArm[]): Pick<BenchmarkPlan, 'suite' | 'arms' | 'trials'> {
  const trials = arms.flatMap(({ name }) => ['expired-token', 'login-copy'].flatMap((task) => [1, 2, 3].map((repetition) => ({ order: 1, repetition, task, arm: name, step: `r${repetition}.${task}.${name}.prompt` }))));

  return { suite: { name: 'fix-auth', sourceHash: 'h', repo: 'https://example.com/auth.git' }, arms, trials };
}

type Cost = { amount: number; unit?: string } | undefined;

/** An earlier run of `suite`, each arm's trials costing what `costs` lists, and judging each trial what `scoring` lists. */
function earlierRun({ run, startedAt, outcome = 'succeeded', suite = 'fix-auth', costs, scoring = [] }: {
  run: string; startedAt: string; outcome?: BenchmarkRunInput['outcome']; suite?: string; costs: Record<string, Cost[]>; scoring?: number[];
}): BenchmarkRunInput {
  const trials = Object.entries(costs).flatMap(([name, list]) => list.map((cost, index) => ({
    task: 'expired-token', arm: name, repetition: index + 1, order: index + 1, step: `trials.r${index + 1}.expired-token.${name}.prompt`, result: 'passed' as const,
    ...(cost === undefined ? {} : { cost: { amount: cost.amount, unit: cost.unit ?? 'USD', complete: true } }),
    ...(scoring[index] === undefined ? {} : { scoringCost: { amount: scoring[index], unit: 'USD', complete: true } }),
  })));
  const benchmark: BenchmarkRecord = {
    suite: { name: suite, sourceHash: 'h' }, repetitions: 3, baselineTeamRevision: TEAM, scorers: [],
    tasks: [{ id: 'expired-token', startingCommit: 'b'.repeat(40), sourceHash: 'h', baseline: 'valid' }], arms: Object.keys(costs).map((name) => arm(name)), trials,
  };

  return { run, source: 'local', startedAt, outcome, schemaVersion: 2, benchmark };
}

const usd = (...amounts: number[]): Cost[] => amounts.map((amount) => ({ amount }));
const SHAPE = { suite: 'fix-auth', arms: 1, tasks: 2, repetitions: 3 };

describe('benchmark cost estimate', () => {
  it('estimates each arm from the median and quartiles of a trial of it in the newest earlier succeeded run of the suite, and the judging from a judged trial', () => {
    const earlier = [
      earlierRun({ run: 'r-old', startedAt: '2026-11-01T09:00:00Z', costs: { claude: usd(9, 9, 9) } }),
      earlierRun({ run: 'r-new', startedAt: '2026-11-05T09:00:00Z', costs: { claude: usd(1, 2, 3, 5) }, scoring: [0.1, 0.2, 0.3] }),
      earlierRun({ run: 'r-failed', startedAt: '2026-11-06T09:00:00Z', outcome: 'failed', costs: { claude: usd(50) } }),
      earlierRun({ run: 'r-other', startedAt: '2026-11-07T09:00:00Z', suite: 'other', costs: { claude: usd(50) } }),
    ];

    const estimate = estimateOf({ plan: planOf([arm('claude')]), calls: { calls: 5, judgedTrials: 3, calibrationCalls: 1 }, earlier });

    expect(estimate).toEqual({
      trials: 6, judgeCalls: 5, judgedTrials: 3, calibrationCalls: 1, basis: { run: 'r-new' },
      arms: [{ arm: 'claude', trials: 6, perTrial: { unit: 'USD', low: 1.75, median: 2.5, high: 3.5 }, total: { unit: 'USD', low: 10.5, median: 15, high: 21 } }],
      judges: { perJudgedTrial: { unit: 'USD', low: expect.closeTo(0.15), median: expect.closeTo(0.2), high: expect.closeTo(0.25) }, total: { unit: 'USD', low: expect.closeTo(0.6), median: expect.closeTo(0.8), high: expect.closeTo(1) } },
      total: { unit: 'USD', low: expect.closeTo(11.1), median: expect.closeTo(15.8), high: expect.closeTo(22), complete: true },
    });
    expect(formatEstimate(estimate, SHAPE)).toEqual([
      'Suite fix-auth: 6 trials (1 arm × 2 tasks × 3 repetitions), 5 judge calls, 1 calibration judge call.',
      'Estimated 11.1–22 USD (agents 10.5–21, judges 0.6–1), from run r-new.',
      'claude 2.5 USD per trial',
    ]);
  });

  it('calls an arm with no stated cost, or not in the earlier run, unknown, leaves another unit out of the total, and says it is incomplete', () => {
    const earlier = [earlierRun({ run: 'r-new', startedAt: '2026-11-05T09:00:00Z', costs: { claude: usd(2, 2), codex: [undefined, undefined], euro: [{ amount: 3, unit: 'EUR' }] } })];

    const estimate = estimateOf({ plan: planOf([arm('claude'), arm('codex'), arm('fresh'), arm('euro')]), calls: { calls: 0, judgedTrials: 0, calibrationCalls: 0 }, earlier });

    expect(estimate.arms).toEqual([
      { arm: 'claude', trials: 6, perTrial: { unit: 'USD', low: 2, median: 2, high: 2 }, total: { unit: 'USD', low: 12, median: 12, high: 12 } },
      { arm: 'codex', trials: 6, unknown: 'no_cost_stated' },
      { arm: 'fresh', trials: 6, unknown: 'not_in_basis' },
      { arm: 'euro', trials: 6, perTrial: { unit: 'EUR', low: 3, median: 3, high: 3 }, total: { unit: 'EUR', low: 18, median: 18, high: 18 } },
    ]);
    expect(estimate.total).toEqual({ unit: 'USD', low: 12, median: 12, high: 12, complete: false });
    expect(formatEstimate(estimate, { ...SHAPE, arms: 4 }).slice(1)).toEqual([
      'Estimated 12–12 USD, incomplete (agents 12–12), from run r-new.',
      'claude 2 USD · codex unknown (no cost stated) · fresh unknown (not in that run) · euro 3 EUR per trial',
    ]);
  });

  it('prices the judging from what calibrating cost too, when no trial of the earlier run was judged', () => {
    // Every check failed, so no judge labelled a trial, and the correctness judge only calibrated three of them.
    const basis = earlierRun({ run: 'r-new', startedAt: '2026-11-05T09:00:00Z', costs: { claude: usd(2, 2, 2) } });
    const decider = { by: 'judge' as const, rubric: 'rc', tool: 'claude', model: 'claude-haiku-5-5', batched: false };
    const calibrated = { ...basis, benchmark: { ...basis.benchmark, trials: basis.benchmark.trials.map((trial, index) => ({
      ...trial, result: 'failed' as const, calibration: { label: 'incorrect', passed: false, decider, scoringCost: { amount: [0.1, 0.2, 0.3][index] ?? 0, unit: 'USD', complete: true } },
    })) } };

    const estimate = estimateOf({ plan: planOf([arm('claude')]), calls: { calls: 0, judgedTrials: 0, calibrationCalls: 6 }, earlier: [calibrated] });

    expect(estimate.judges).toEqual({ perJudgedTrial: { unit: 'USD', low: expect.closeTo(0.15), median: expect.closeTo(0.2), high: expect.closeTo(0.25) }, total: { unit: 'USD', low: expect.closeTo(0.9), median: expect.closeTo(1.2), high: expect.closeTo(1.5) } });
  });

  it('says no earlier run of the suite gives an estimate, and estimates no cost', () => {
    const estimate = estimateOf({ plan: planOf([arm('claude')]), calls: { calls: 6, judgedTrials: 6, calibrationCalls: 0 }, earlier: [earlierRun({ run: 'r-failed', startedAt: '2026-11-05T09:00:00Z', outcome: 'failed', costs: { claude: usd(2) } })] });

    expect(estimate).toEqual({ trials: 6, judgeCalls: 6, judgedTrials: 6, calibrationCalls: 0 });
    expect(formatEstimate(estimate, SHAPE)).toEqual(['Suite fix-auth: 6 trials (1 arm × 2 tasks × 3 repetitions), 6 judge calls.', 'No earlier run of fix-auth to estimate from.']);
  });
});

describe('benchmark judge calls', () => {
  const tasks = [
    { id: 'mixed', scorers: ['review-quality', 'test-coverage', 'teamai:correctness:mixed'], isMixed: true },
    { id: 'check', scorers: ['review-quality', 'test-coverage'], isMixed: false },
    { id: 'own', scorers: ['review-quality', 'test-coverage', 'security-review'], isMixed: false },
    { id: 'plain', scorers: [], isMixed: false },
  ];
  const trials = ['claude', 'codex'].flatMap((name) => tasks.map(({ id }) => ({ task: id, arm: name })));
  const judges = Object.fromEntries(['review-quality', 'test-coverage', 'security-review', 'teamai:correctness:mixed'].map((name) => [name, { tool: 'claude', model: '' }]));
  const definitions = { 'review-quality': { model: 'judge' }, 'test-coverage': { model: 'judge' }, 'security-review': { model: 'fast' } };

  it('counts one call per trial and group of scorers sharing a model and tools when batched, a correctness scorer always alone, and none for a trial no judge labels', () => {
    expect(judgeCallsOf({ trials, tasks, judges, definitions, calibrationRate: 50, batch: true })).toEqual({ calls: 10, judgedTrials: 6, calibrationCalls: 1 });
  });

  it('counts one call per trial and scorer without batching', () => {
    expect(judgeCallsOf({ trials, tasks, judges, definitions, calibrationRate: 0, batch: false })).toEqual({ calls: 16, judgedTrials: 6, calibrationCalls: 0 });
  });
});
