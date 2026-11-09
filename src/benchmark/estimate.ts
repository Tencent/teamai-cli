/**
 * What a benchmark run will cost, estimated before it starts from the newest earlier run of the suite that succeeded
 * with this record version, on this machine or published: each arm's trials times what one of its trials cost there,
 * matched by `armKey`, and the judged trials and calibration calls times what judging one or calibrating one cost there,
 * each the median with the quartiles as its range. Start freezes it in the plan and the record keeps it; it never stops a run or changes its exit code.
 */
import { judgeCallKey } from '../scorers/batch.js';
import type { ScorerDefinition } from '../scorers/definition.js';
import { armKey, type BenchmarkRunInput } from './history.js';
import { isCorrectnessScorer, type BenchmarkEstimate, type BenchmarkPlan, type CostRange, type PlannedTrial } from './plan.js';
import { BENCHMARK_RECORD_SCHEMA_VERSION, type BenchmarkRecord } from './result.js';
import { definedFields } from '../utils/defined-fields.js';
import { formatCostRange, formatEstimateAmount } from './table.js';

type ArmEstimate = NonNullable<BenchmarkEstimate['arms']>[number];

/** The judge calls of a plan's trials, how many of its trials a judge labels, and the calibration calls its rate expects. */
export interface JudgeCalls {
  calls: number;
  judgedTrials: number;
  calibrationCalls: number;
}

/**
 * The judge calls of `trials` as `teamai score plan` groups them, `batch` as the benchmark workflow asks: one per trial
 * and group of its scorers sharing a model, a preferred and a required tool, a correctness scorer alone. A trial's work
 * delivers nothing, so no scorer takes a stage. A task with a check and success criteria counts its correctness call as
 * if its check passed, and its calibration calls as if every check failed, so both are the most they can be.
 */
export function judgeCallsOf({ trials, tasks, judges, definitions, calibrationRate, batch }: {
  trials: ReadonlyArray<Pick<PlannedTrial, 'task'>>;
  /** By task: the scorers that judge its trials (`trialScorersOf`), and whether it has a check and success criteria. */
  tasks: ReadonlyArray<{ id: string; scorers: readonly string[]; isMixed: boolean }>;
  judges: BenchmarkPlan['judges'];
  /** The team scorers among them, as start pinned them. */
  definitions: Record<string, Pick<ScorerDefinition, 'model' | 'tool'>>;
  calibrationRate: number;
  batch: boolean;
}): JudgeCalls {
  const perTrial = trials.map(({ task: id }) => new Set((tasks.find((task) => task.id === id)?.scorers ?? []).map((name) => judgeCallKey({
    name, model: definitions[name]?.model, tool: definitions[name]?.tool, require: judges[name]?.tool, stages: [], isAlone: isCorrectnessScorer(name),
  }, batch))).size);

  const mixed = trials.filter(({ task: id }) => tasks.some((task) => task.id === id && task.isMixed)).length;

  return {
    calls: perTrial.reduce((sum, calls) => sum + calls, 0),
    judgedTrials: perTrial.filter((calls) => calls > 0).length,
    calibrationCalls: Math.round((mixed * calibrationRate) / 100),
  };
}

/** `plan`'s estimate from the newest of `earlier` that is a succeeded run of its suite with this record version. */
export function estimateOf({ plan, calls, earlier }: { plan: Pick<BenchmarkPlan, 'suite' | 'arms' | 'trials'>; calls: JudgeCalls; earlier: readonly BenchmarkRunInput[] }): BenchmarkEstimate {
  const [basis] = earlier
    .filter(({ benchmark, schemaVersion, outcome }) => benchmark.suite.name === plan.suite.name && schemaVersion === BENCHMARK_RECORD_SCHEMA_VERSION && outcome === 'succeeded')
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  const counts = { trials: plan.trials.length, judgeCalls: calls.calls, judgedTrials: calls.judgedTrials, calibrationCalls: calls.calibrationCalls };

  if (basis === undefined) return counts;

  const arms = plan.arms.map((arm): ArmEstimate => {
    const trials = plan.trials.filter((trial) => trial.arm === arm.name).length;
    const ran = basis.benchmark.arms.find((one) => armKey(one) === armKey(arm));

    if (ran === undefined) return { arm: arm.name, trials, unknown: 'not_in_basis' };
    const perTrial = rangeOf(basis.benchmark.trials.flatMap((trial) => (trial.arm === ran.name && trial.cost?.complete ? [trial.cost] : [])));

    return perTrial ? { arm: arm.name, trials, perTrial, total: times(perTrial, trials) } : { arm: arm.name, trials, unknown: 'no_cost_stated' };
  });

  const judged = calls.judgedTrials + calls.calibrationCalls;
  // A calibration call is priced as a judged trial, so what one cost is a sample of it too.
  const perJudgedTrial = judged > 0 ? rangeOf(basis.benchmark.trials.flatMap(({ scoringCost, calibration }) => [scoringCost, calibration?.scoringCost].flatMap((cost) => (cost?.complete ? [cost] : [])))) : undefined;
  const judges = judged === 0 ? undefined : perJudgedTrial ? { perJudgedTrial, total: times(perJudgedTrial, judged) } : { unknown: 'no_cost_stated' as const };

  return definedFields<BenchmarkEstimate>({ ...counts, basis: { run: basis.run }, arms, judges, total: sumOf([...arms.map(totalOf), ...(judges === undefined ? [] : [totalOf(judges)])]) });
}

/** What an arm's trials, or the judging, cost in all; undefined when it is unknown. */
function totalOf(estimate: ArmEstimate | NonNullable<BenchmarkEstimate['judges']>): CostRange | undefined {
  return 'total' in estimate ? estimate.total : undefined;
}

/** The sum of `parts` in the unit of the first known one, and whether every part was known in it; undefined with none known. */
function sumOf(parts: ReadonlyArray<CostRange | undefined>): (CostRange & { complete: boolean }) | undefined {
  const [unit] = parts.flatMap((part) => part?.unit ?? []);

  if (unit === undefined) return undefined;
  const known = parts.flatMap((part) => (part?.unit === unit ? [part] : []));
  const sum = (key: 'low' | 'median' | 'high'): number => known.reduce((total, part) => total + part[key], 0);

  return { unit, low: sum('low'), median: sum('median'), high: sum('high'), complete: known.length === parts.length };
}

/** The median and quartiles of `costs`, all in one unit; undefined with none, or in more than one unit. */
function rangeOf(costs: ReadonlyArray<NonNullable<BenchmarkRecord['trials'][number]['cost']>>): CostRange | undefined {
  const [first] = costs;

  if (first === undefined || costs.some(({ unit }) => unit !== first.unit)) return undefined;
  const sorted = costs.map(({ amount }) => amount).sort((left, right) => left - right);

  return { unit: first.unit, low: quantile(sorted, 0.25), median: quantile(sorted, 0.5), high: quantile(sorted, 0.75) };
}

/** The `p` quantile of `sorted`, not empty, interpolated between its two nearest values. */
function quantile(sorted: readonly number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const [below, above] = [sorted[Math.floor(at)], sorted[Math.ceil(at)]];

  return below + (above - below) * (at - Math.floor(at));
}

function times({ unit, low, median, high }: CostRange, count: number): CostRange {
  return { unit, low: low * count, median: median * count, high: high * count };
}

/**
 * The lines `teamai benchmark run` prints before the run starts: the trials and judge calls, then the estimate with
 * the run it comes from and each arm's median per trial, or that no earlier run of `suite` succeeded.
 */
export function formatEstimate(estimate: BenchmarkEstimate, { suite, arms, tasks, repetitions }: { suite: string; arms: number; tasks: number; repetitions: number }): string[] {
  const calibration = estimate.calibrationCalls > 0 ? `, ${counted(estimate.calibrationCalls, 'calibration judge call')}` : '';
  const counts = `Suite ${suite}: ${counted(estimate.trials, 'trial')} (${counted(arms, 'arm')} × ${counted(tasks, 'task')} × ${counted(repetitions, 'repetition')}), ${counted(estimate.judgeCalls, 'judge call')}${calibration}.`;

  if (estimate.basis === undefined) return [counts, `No earlier run of ${suite} to estimate from.`];

  const amounts = (parts: ReadonlyArray<CostRange | undefined>): string => {
    const sum = sumOf(parts);

    return sum === undefined ? 'unknown' : `${formatEstimateAmount(sum.low)}–${formatEstimateAmount(sum.high)}`;
  };

  const estimated = estimate.arms ?? [];
  const split = [`agents ${amounts(estimated.map(totalOf))}`, ...(estimate.judges ? [`judges ${amounts([totalOf(estimate.judges)])}`] : [])].join(', ');
  const total = estimate.total ? `${formatCostRange(estimate.total)}${estimate.total.complete ? '' : ', incomplete'}` : 'unknown';
  const units = new Set(estimated.flatMap((one) => ('perTrial' in one ? [one.perTrial.unit] : [])));
  const [unit] = units;

  const perTrial = estimated.map((one) => {
    if (!('perTrial' in one)) return `${one.arm} unknown (${one.unknown === 'not_in_basis' ? 'not in that run' : 'no cost stated'})`;

    return `${one.arm} ${formatEstimateAmount(one.perTrial.median)}${units.size > 1 ? ` ${one.perTrial.unit}` : ''}`;
  });

  return [counts, `Estimated ${total} (${split}), from run ${estimate.basis.run}.`, `${perTrial.join(' · ')}${units.size === 1 && unit !== undefined ? ` ${unit}` : ''} per trial`];
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
