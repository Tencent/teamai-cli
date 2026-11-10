/**
 * Which two trials of one task and repetition compare: the regression gate, Compare and the resource effect tables count a
 * pair only when the same instrument decided both sides, so a difference in pass rate is a change in the agent, not in
 * the task or its judge. The first rule that matches decides:
 *
 *   1. the task's sourceHash differs                                   → excluded, task_changed
 *   2. both decided by a judge, and its rubric, tool, model, effort or batched differs → excluded, judge_changed
 *   3. anything else: both by the check, one by the check and one by a judge, the same judge, or a side nothing
 *      decided (error, not_run or unscored, which count as not passed)  → compared
 */
import { correctnessScorerName } from './plan.js';
import type { BenchmarkRecord } from './result.js';
import type { TrialVerdict } from './verdicts.js';

type Decider = NonNullable<TrialVerdict['decider']>;

type JudgeDecider = Extract<Decider, { by: 'judge' }>;

/** One trial of a pair: its task's sourceHash, and who decided its correctness label; no decider when nothing did. */
export interface PairSide {
  taskHash: string;
  decider?: Decider;
}

/** Why a pair does not compare. */
export type PairExclusion =
  | { kind: 'task_changed' }
  | { kind: 'judge_changed'; from: JudgeDecider; to: JudgeDecider };

export type PairComparison = { kind: 'compared' } | { kind: 'excluded'; because: PairExclusion };

/** The pairs excluded for one reason. */
export interface ExcludedPairs {
  pairs: number;
  because: PairExclusion;
}

const JUDGE_FACETS = ['rubric', 'tool', 'model', 'effort', 'batched'] as const satisfies ReadonlyArray<keyof JudgeDecider>;

/** Whether `from` and `to` compare, by the rules above. */
export function comparePair(from: PairSide, to: PairSide): PairComparison {
  if (from.taskHash !== to.taskHash) return { kind: 'excluded', because: { kind: 'task_changed' } };
  const [left, right] = [from.decider, to.decider];

  if (left?.by === 'judge' && right?.by === 'judge' && JUDGE_FACETS.some((facet) => left[facet] !== right[facet])) {
    return { kind: 'excluded', because: { kind: 'judge_changed', from: left, to: right } };
  }

  return { kind: 'compared' };
}

type Trial = BenchmarkRecord['trials'][number];

/**
 * Whether two recorded trials compare, each read with the tasks of the record that ran it: its task's sourceHash, and
 * the decider of its correctness label. None when a record does not list its trial's task.
 */
export function compareTrials({ from, fromTasks, to, toTasks }: { from: Trial; fromTasks: BenchmarkRecord['tasks']; to: Trial; toTasks: BenchmarkRecord['tasks'] }): PairComparison | undefined {
  const [left, right] = [pairSideOf(fromTasks, from), pairSideOf(toTasks, to)];

  return left && right ? comparePair(left, right) : undefined;
}

function pairSideOf(tasks: BenchmarkRecord['tasks'], trial: Trial): PairSide | undefined {
  const taskHash = tasks.find(({ id }) => id === trial.task)?.sourceHash;

  if (taskHash === undefined) return undefined;
  const decider = trial.verdicts?.find(({ scorer }) => scorer === correctnessScorerName(trial.task))?.decider;

  return decider === undefined ? { taskHash } : { taskHash, decider };
}

/** The pairs `pairs` holds, compared and excluded: each excluded reason counted once, in first-seen order. */
export function splitPairs<TPair>(pairs: ReadonlyArray<{ pair: TPair; comparison: PairComparison }>) {
  const compared: TPair[] = [];
  const excluded = new Map<string, ExcludedPairs>();

  for (const { pair, comparison } of pairs) {
    if (comparison.kind === 'compared') {
      compared.push(pair);
      continue;
    }

    const key = JSON.stringify(comparison.because);
    const seen = excluded.get(key);
    excluded.set(key, { pairs: (seen?.pairs ?? 0) + 1, because: comparison.because });
  }

  return { compared, excluded: [...excluded.values()] };
}

/**
 * `9 excluded: their judge changed (claude claude-opus-5-5 → claude claude-sonnet-5-5)`: how many pairs were excluded and
 * why, each reason counted when there is more than one.
 */
export function formatExcluded(excluded: readonly ExcludedPairs[]): string {
  const total = excluded.reduce((sum, { pairs }) => sum + pairs, 0);
  const reasons = excluded.length === 1 ? excluded.map(({ because }) => reasonText(because)) : excluded.map(({ pairs, because }) => `${pairs} as ${reasonText(because)}`);

  return `${total} excluded: ${reasons.join(', ')}`;
}

function reasonText(because: PairExclusion): string {
  switch (because.kind) {
    case 'task_changed':
      return 'their task changed';
    case 'judge_changed':
      return `their judge changed (${judgeText(because.from, because.to)} → ${judgeText(because.to, because.from)})`;
    default: {
      const unhandled: never = because;

      return unhandled;
    }
  }
}

/** A judge as its tool and model, then each other facet that differs from `other`'s. */
function judgeText(judge: JudgeDecider, other: JudgeDecider): string {
  return [
    judge.tool, judge.model ?? 'an unreported model',
    ...(judge.effort !== other.effort ? [`effort ${judge.effort ?? 'unset'}`] : []),
    ...(judge.batched !== other.batched ? [judge.batched ? 'batched' : 'alone'] : []),
    ...(judge.rubric !== other.rubric ? [`rubric ${judge.rubric.slice(0, 7)}`] : []),
  ].join(' ');
}
