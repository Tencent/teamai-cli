/**
 * The dashboard's Benchmarks page: every ended benchmark run of a workspace, from this machine's run files and the
 * team's records, read as a history per suite. Pure over the runs' end records, so the page counts what `jq` over the
 * records counts: a pass rate is passed trials over planned trials, as the run's own table prints it.
 *
 * Runs of one suite compare only while the suite's files stay the same, so what the page pools (an arm's pass rate and
 * usage, the task by arm heatmap) covers the runs of the suite's current version: the run `sourceHash` of the newest
 * run that ran the whole suite, over its suite file and each task file, recorded in the same record schemaVersion. A
 * run of only some tasks or arms is current only while the suite has no whole run.
 * Each run still shows as a point of its own.
 */
import { definedFields } from '../utils/defined-fields.js';
import { compareTrials, formatExcluded, splitPairs, type ExcludedPairs } from './pairing.js';
import { CORRECTNESS_SCORERS, correctnessScorerName, isCorrectnessScorer, runSourceHash, type BenchmarkEstimate, type PlannedJudge } from './plan.js';
import type { Baseline, BenchmarkRecord, BenchmarkRunRecord } from './result.js';
import type { TeamChoice } from './suite.js';
import type { ArmTeam } from './terms.js';
import {
  agentCostsOf, benchmarkTable, calibrationOf, costTotal, deviationsOf, dominanceOf, observedTrials, pairedDifference, selfJudgedOf, usageOf, wilson,
  type ArmAgainst, type ArmResults, type ArmScorerResults, type ArmStanding, type ArmUsage, type BenchmarkTable, type CostTotal, type Dominance, type JudgeCalibration, type ObservedTrial, type PairedInterval, type PassRate,
} from './table.js';
import type { TrialVerdict } from './verdicts.js';

/** One ended benchmark run, as its end record holds it. `source`: this machine's run file, or the team's record. */
export interface BenchmarkRunInput {
  run: string;
  source: 'local' | 'reported';
  username?: string;
  startedAt: string;
  outcome: BenchmarkRunRecord['outcome'];
  /** Runs compare only with runs whose record has the same one. */
  schemaVersion: BenchmarkRunRecord['schemaVersion'];
  benchmark: BenchmarkRecord;
}

/** One arm of a run against an earlier one: how many of its trial pairs compared, and the pairs excluded, by why. */
export interface ArmPairs {
  arm: string;
  pairs: number;
  excluded: ExcludedPairs[];
}

/**
 * What `teamai benchmark run --fail-on-regression` found against the newest earlier comparable run, `against`, each arm
 * with its pairs (`pairing.ts`): an arm whose pass rate over its compared pairs dropped with its whole interval below
 * zero is in `drops`. `no_comparable` names the run it `tried` when that run had no compared pair on any arm.
 */
export type Regression =
  | { kind: 'no_comparable'; tried?: { run: string; arms: ArmPairs[] } }
  | { kind: 'held'; against: string; arms: ArmPairs[] }
  | { kind: 'dropped'; against: string; arms: ArmPairs[]; drops: Array<{ arm: string; pairs: number; rates: ArmComparison['rates']; difference: ArmComparison['difference'] }> };

/** The windows the page offers, in days before now, by when each run started. */
export const BENCHMARK_WINDOWS = [30, 90, 365] as const;

export interface BenchmarkHistoryQuery {
  windowDays: number;
  /** The suite to open; the suite of the newest run when absent or not run in the window. */
  suite?: string;
}

/** One run's pass rate. */
export type RunPoint = PassRate & { run: string; startedAt: string };

export interface SuiteSummary {
  suite: string;
  runs: number;
  lastRunAt: string;
  /** Of the newest run. */
  tasks: number;
  arms: number;
  /** The newest run's arm with the highest pass rate; the first in the suite's order on a tie. */
  leader?: PassRate & { arm: string };
  /** Each run's pass rate over all its trials, oldest first. */
  trend: RunPoint[];
}

/** A pass rate with its 95% Wilson score interval, which stays inside 0–1 and honest for a handful of trials. */
export type PooledRate = PassRate & { low: number; high: number; runs: number };

/**
 * An arm over the runs of the current version, counted as each run's own table counts it. `correctnessScore`: over the
 * runs whose table has one, those whose correctness rubric has more than two labels; absent when none has.
 */
export type PooledArm = PooledRate & Pick<ArmResults, 'deviations' | 'notVerified' | 'correctnessScore'> & { usage: Omit<ArmUsage, 'arm'> };

/**
 * One arm as a configuration: its name, tool, model, effort, team choice, workflow and role. An arm whose model changed
 * between runs is two series, since its runs measured two things. A pulled team that moved to another revision stays one
 * series, as the suite asked for whatever the team pulled: the runs table marks the change.
 */
export interface ArmSeries {
  key: string;
  arm: string;
  tool: string;
  model?: string;
  effort?: string;
  team: TeamChoice;
  /** The team workflow the arm's trials ran instead of one prompt. */
  workflow?: string;
  /** The team role the arm's trial clones ran with; absent: the member's roles. */
  role?: string;
  /** In the newest run that ran the whole suite. */
  isCurrent: boolean;
  /** Over the runs of the current version; absent for a configuration none of them ran. */
  pooled?: PooledArm;
  /** Each run of the configuration in the window, oldest first. */
  points: RunPoint[];
}

export interface SuiteVersion {
  sourceHash: string;
  runs: number;
  lastRunAt: string;
}

/** One suite or task scorer of the current version: each current configuration's labels, as the run's table counts one run's. */
export interface ScorerView {
  scorer: string;
  /** In `arms` order; a configuration the scorer labelled none of has none. */
  arms: Array<{ key: string } & Pick<ArmScorerResults, 'passed' | 'labelled' | 'unscored' | 'interval'>>;
}

/** One task of the current version, over its runs. */
export interface TaskView {
  task: string;
  /** Each current configuration's pass rate on the task, in `arms` order; a configuration with no planned trial has none. */
  arms: Array<{ key: string } & Partial<PassRate>>;
  /** Each run of the current version, oldest first: what its baseline showed and the task's pass rate over every arm. */
  runs: Array<{ run: string; baseline: Baseline } & Partial<PassRate>>;
  /** Runs in which one arm both passed and did not pass the task: its repetitions disagreed, so one trial says little. */
  disagreedRuns: number;
  /** Runs that did not measure the task: see isMeasured. */
  unmeasuredRuns: number;
}

/** What two arms of the current version differ in: exactly one of these, so the difference has one cause. */
export const ARM_DIMENSIONS = ['team', 'tool', 'model', 'workflow', 'role'] as const;

export type ArmDimension = (typeof ARM_DIMENSIONS)[number];

/**
 * Two current arms that differ in exactly one dimension, compared trial by trial: each pair is both arms' trial of one
 * task and repetition in one run of the current version, counted when `compareTrials` compares it. `from` is the arm the
 * difference is measured from: for the team, none before the pulled revision without some paths, before a named ref,
 * before the pulled revision; otherwise the first in the suite's order. Two arms whose every pair was excluded have no
 * comparison: there is no difference to show.
 */
export interface ArmComparison {
  dimension: ArmDimension;
  from: string;
  to: string;
  pairs: number;
  /** Each arm's pass rate over the pairs. */
  rates: { from: PassRate; to: PassRate };
  /** Each arm's usage over the pairs, as the run table counts it. */
  usage: { from: Omit<ArmUsage, 'arm'>; to: Omit<ArmUsage, 'arm'> };
  /** To's pass rate minus from's, with its 95% interval for paired proportions (Newcombe), as fractions. */
  difference: { value: number; low: number; high: number };
  /** Each task's pass rate on both arms over its pairs, in the newest run's task order. */
  tasks: Array<{ task: string; from: PassRate; to: PassRate }>;
  /** The pairs left out, by why; absent when none was. */
  excluded?: ExcludedPairs[];
}

/** Two current arms that differ in one dimension and have trial pairs, every one of them left out, by why: no rate compares them. */
export interface UncomparedArms {
  dimension: ArmDimension;
  from: string;
  to: string;
  excluded: ExcludedPairs[];
}

/**
 * A current arm against the suite's reference arm, as the run's table reads one (`ArmAgainst`), by arm key, over the
 * pairs of their trials in the runs of the current version, with dominance by their pooled pass rate and cost per passed
 * trial, `neither` included.
 */
export type PooledAgainst = Omit<ArmAgainst, 'dominance'> & { key: string; dominance?: Dominance };

/** A judge as a label names it: the tool it ran in, and the model and effort its tool reported, else those it was launched with. */
export type JudgeName = Pick<Extract<NonNullable<TrialVerdict['decider']>, { by: 'judge' }>, 'tool' | 'model' | 'effort'>;

/**
 * Who labelled one scorer's trials over the runs of the current version, those whose work ran: the judges the runs
 * pinned it to for every arm, how many of its labels a check decided and how many each judge did, how many of a judge's
 * labels came from another judge than the plan's (`asPlanned` deviation) or could not be compared with it, and how
 * many verdicts have no label. A label no check or judge decided, such as a person's, counts in none of them.
 */
export interface ScorerJudging {
  /** The scorer the suite or a task lists, or `teamai:correctness` for every task's correctness scorer, which fill in one rubric. */
  scorer: string;
  /** Each once, in run order. */
  planned: PlannedJudge[];
  byCheck: number;
  /** Each judge once, in the order it first labelled. */
  byJudge: Array<{ judge: JudgeName; labels: number }>;
  deviations: number;
  notVerified: number;
  unscored: number;
}

/**
 * Each correctness judge's calibration over the runs of the current version, as the run's table counts one run's
 * (`JudgeCalibration`). To say why there is none: the newest whole run's calibration rate, absent on a record that does
 * not keep it, its tasks with both a check and success criteria, the only ones a judge is calibrated on, and how many of
 * their trials failed the check in those runs.
 */
export interface SuiteCalibration {
  judges: JudgeCalibration[];
  rate?: number;
  mixedTasks: number;
  failedChecks: number;
}

/** A tool, model, effort, workflow and role, whatever the team: one line of the team changes chart. */
export interface TeamConfig {
  key: string;
  tool: string;
  model?: string;
  effort?: string;
  /** The team workflow the arm runs; absent: the trial's own prompt. */
  workflow?: string;
  /** The team role the arm's clones run with; absent: the member's roles. */
  role?: string;
}

/**
 * One team revision the current version's runs installed, oldest run first: each configuration's pass rate on it, over
 * the trials of arms that installed it whole, from a pulled team or a named ref.
 */
export interface TeamRevisionView {
  revision: string;
  firstRunAt: string;
  configs: Array<{ key: string; runs: number; tasks: Array<{ task: string } & PassRate> } & PooledRate>;
}

export interface SuiteView {
  suite: string;
  /** Newest first: the first is the current version. */
  versions: SuiteVersion[];
  /** Current configurations in the suite's order, then the others, the one run last first. */
  arms: ArmSeries[];
  /** The tasks of the newest run that ran the whole suite, in its order. */
  tasks: TaskView[];
  /** The suite and task scorers of the current version, the correctness scorers aside; empty on records without verdicts. */
  scorers: ScorerView[];
  /** Newest first. */
  runs: RunRow[];
  /** The newest run's own table, as it printed it, and its arms against its reference arm, read as `against` reads the runs. */
  latest: { run: string; source: BenchmarkRunInput['source']; table: BenchmarkTable; against?: SuiteView['against'] };
  /** Every pair of current arms that differ in one dimension, team first. */
  comparisons: ArmComparison[];
  /** Every such pair of arms whose trial pairs were all left out, in the same order. */
  uncompared: UncomparedArms[];
  /**
   * The arm the others are read against, by key, the defaults arm of the newest run that ran the whole suite, else its
   * first, and each other current arm against it; absent with one arm.
   */
  against?: { reference: string; isDefaultsArm: boolean; arms: PooledAgainst[] };
  /**
   * Who judged the runs of the current version: each scorer, the correctness scorers first, each judge tool that is
   * also an arm's tool, as the run's table warns of it, and each correctness judge's calibration. Empty on runs whose
   * records keep no verdicts.
   */
  judging: { scorers: ScorerJudging[]; selfJudged: BenchmarkTable['selfJudged']; calibration: SuiteCalibration };
  /** The team revisions of the current version, for configurations that ran on two or more. */
  teamChanges: { configs: TeamConfig[]; revisions: TeamRevisionView[] };
}

/** One run of the suite. `teamRevision`: the team revision its trials installed team resources from. */
export interface RunRow extends PassRate {
  run: string;
  source: BenchmarkRunInput['source'];
  startedAt: string;
  username?: string;
  sourceHash: string;
  /** It ran the suite's current version, in the record version of its newest whole run: the runs its rates pool. */
  isCurrent: boolean;
  teamRevision: string;
  /** Tasks the run did not measure: see isMeasured. */
  unmeasuredTasks: number;
  /** The version of each tool its prompts reported, the most reported one when they differ. */
  toolVersions: Record<string, string>;
  /** Each arm of the run as a configuration, in the run's order. */
  arms: Array<{ key: string } & PassRate>;
  /**
   * What start estimated the run costs, from an earlier run, beside what it cost: each trial's agent, judging and
   * calibration as they stated it, `used` counting each. `outside` when that falls outside the estimate's range, only for a complete
   * estimate in the same unit, and `below` only for a cost every part stated. `estimated` absent when start had no earlier
   * run to estimate from.
   */
  spend: { estimated?: NonNullable<BenchmarkEstimate['total']>; spent: CostTotal; outside?: 'above' | 'below' };
}

export interface BenchmarkHistoryView {
  window: { from: string; to: string };
  /** Newest run first. */
  suites: SuiteSummary[];
  selected?: SuiteView;
}

type Trial = BenchmarkRecord['trials'][number];

type Arm = BenchmarkRecord['arms'][number];

const DAY_MS = 24 * 60 * 60 * 1000;

function passRate(trials: readonly Trial[]): PassRate {
  return { passed: trials.filter(({ result }) => result === 'passed').length, planned: trials.length };
}

/**
 * Whether a run measured a task: its baseline let the task's trials run. Otherwise its check passed before any change or
 * could not run, or the run ended before its baseline.
 */
function isMeasured(baseline: Baseline): boolean {
  return baseline === 'valid' || baseline === 'not_needed';
}

/** `left` beats `right` on pass rate, compared without division so 2/3 and 4/6 tie. */
function beats(left: PassRate, right: PassRate): boolean {
  return left.passed * right.planned > right.passed * left.planned;
}

/** An arm's identity across runs. The role joins it only when set, so an arm without one keeps the key it had before roles. */
export function armKey({ name, tool, model, effort, team, workflow, role }: Pick<Arm, 'name' | 'tool' | 'model' | 'effort' | 'team' | 'workflow' | 'role'>): string {
  return JSON.stringify([name, tool, model ?? null, effort ?? null, teamChoiceOf(team), workflow?.name ?? null, ...(role !== undefined ? [role] : [])]);
}

/** A configuration whatever its team, for the team changes chart; the role joins it only when set, as in `armKey`. */
function configKey({ tool, model, effort, workflow, role }: Pick<Arm, 'tool' | 'model' | 'effort' | 'workflow' | 'role'>): string {
  return JSON.stringify([tool, model ?? null, effort ?? null, workflow?.name ?? null, ...(role !== undefined ? [role] : [])]);
}

/** What the suite asked of an arm's team, without the commit start resolved it to. */
function teamChoiceOf(team: ArmTeam): TeamChoice {
  switch (team.kind) {
    case 'pulled':
    case 'none':
      return { kind: team.kind };
    case 'ref':
      return { kind: 'ref', ref: team.ref };
    case 'without':
      return { kind: 'without', paths: team.paths };
    default: {
      const unhandled: never = team;

      return unhandled;
    }
  }
}

function leaderOf({ arms, trials }: BenchmarkRecord): SuiteSummary['leader'] {
  let leader: SuiteSummary['leader'];

  for (const { name } of arms) {
    const rate = passRate(trials.filter(({ arm }) => arm === name));

    if (rate.planned > 0 && (!leader || beats(rate, leader))) leader = { arm: name, ...rate };
  }

  return leader;
}

function summaryOf(suite: string, runs: readonly BenchmarkRunInput[], newest: BenchmarkRunInput): SuiteSummary {
  const leader = leaderOf(newest.benchmark);

  return definedFields<SuiteSummary>({
    suite,
    runs: runs.length,
    lastRunAt: newest.startedAt,
    tasks: newest.benchmark.tasks.length,
    arms: newest.benchmark.arms.length,
    leader,
    trend: runs.map(({ run, startedAt, benchmark }) => ({ run, startedAt, ...passRate(benchmark.trials) })),
  });
}

function versionsOf(runs: readonly BenchmarkRunInput[]): SuiteVersion[] {
  const versions = new Map<string, SuiteVersion>();

  for (const { startedAt, benchmark } of runs) {
    const sourceHash = runSourceHash(benchmark);
    const seen = versions.get(sourceHash);
    versions.set(sourceHash, { sourceHash, runs: (seen?.runs ?? 0) + 1, lastRunAt: startedAt });
  }

  return [...versions.values()].sort((left, right) => right.lastRunAt.localeCompare(left.lastRunAt));
}

/** The runs of one suite in the window, oldest first: those of its current version, and the newest that ran the whole suite, or the newest when none did. */
interface SuiteRuns {
  runs: readonly BenchmarkRunInput[];
  current: readonly BenchmarkRunInput[];
  newest: BenchmarkRunInput;
}

function armsOf({ runs, current, newest }: SuiteRuns): ArmSeries[] {
  const configs = new Map<string, { arm: Arm; points: RunPoint[]; pooledTrials: ObservedTrial[]; pooledRuns: number; deviations: number; notVerified: number; scores: Array<NonNullable<ArmResults['correctnessScore']>> }>();

  for (const input of runs) {
    const isPooled = current.includes(input);
    const observed = isPooled ? observedTrials(input) : [];
    const results = isPooled ? benchmarkTable(input).results : [];

    for (const arm of input.benchmark.arms) {
      const key = armKey(arm);
      const config = configs.get(key) ?? { arm, points: [], pooledTrials: [], pooledRuns: 0, deviations: 0, notVerified: 0, scores: [] };
      config.points.push({ run: input.run, startedAt: input.startedAt, ...passRate(input.benchmark.trials.filter((trial) => trial.arm === arm.name)) });

      if (isPooled) {
        // Each run's arm is compared on its own team revision, as that run's table compares it.
        const own = observed.filter(({ trial }) => trial.arm === arm.name);
        const { deviations, notVerified } = deviationsOf(arm, own);
        const score = results.find((result) => result.arm === arm.name)?.correctnessScore;
        config.pooledTrials.push(...own);
        config.pooledRuns += 1;
        config.deviations += deviations;
        config.notVerified += notVerified;
        config.scores.push(...score ? [score] : []);
      }

      configs.set(key, config);
    }
  }

  const order = newest.benchmark.arms.map(armKey);

  const rank = (key: string, points: readonly RunPoint[]): [number, string] => {
    const index = order.indexOf(key);

    return [index < 0 ? order.length : index, index < 0 ? points.at(-1)?.startedAt ?? '' : ''];
  };

  return [...configs].sort(([leftKey, left], [rightKey, right]) => {
    const [leftRank, leftLast] = rank(leftKey, left.points);
    const [rightRank, rightLast] = rank(rightKey, right.points);

    return leftRank - rightRank || rightLast.localeCompare(leftLast);
  }).map(([key, { arm, points, pooledTrials, pooledRuns, deviations, notVerified, scores }]) => {
    const pooled = passRate(pooledTrials.map(({ trial }) => trial));

    return definedFields<ArmSeries>({
      key, arm: arm.name, tool: arm.tool, model: arm.model || undefined, effort: arm.effort || undefined, team: teamChoiceOf(arm.team), workflow: arm.workflow?.name,
      role: arm.role,
      isCurrent: order.includes(key),
      pooled: pooled.planned > 0
        ? definedFields<PooledArm>({ ...pooled, ...wilson(pooled), runs: pooledRuns, deviations, notVerified, usage: usageOf(pooledTrials), correctnessScore: pooledScore(scores) })
        : undefined,
      points,
    });
  });
}

/** The mean of the runs' mean correctness scores, each weighed by its labels; undefined with no run's. */
function pooledScore(scores: ReadonlyArray<NonNullable<ArmResults['correctnessScore']>>): ArmResults['correctnessScore'] {
  if (scores.length === 0) return undefined;
  const labelled = scores.reduce((sum, score) => sum + score.labelled, 0);
  const total = scores.reduce((sum, { labelled: count, mean }) => sum + (mean ?? 0) * count, 0);

  return definedFields<NonNullable<ArmResults['correctnessScore']>>({ labelled, mean: labelled > 0 ? total / labelled : undefined });
}

/** `rate` as optional fields, absent when nothing was planned. */
function rateFields(rate: PassRate): Partial<PassRate> {
  return rate.planned > 0 ? rate : {};
}

function tasksOf({ current, newest }: SuiteRuns): TaskView[] {
  return newest.benchmark.tasks.map(({ id }) => {
    const trialsIn = (input: BenchmarkRunInput) => input.benchmark.trials.filter((trial) => trial.task === id);

    const runs = current.flatMap((input) => {
      const baseline = input.benchmark.tasks.find((task) => task.id === id)?.baseline;

      return baseline ? [{ input, baseline, trials: trialsIn(input) }] : [];
    });

    const disagreedRuns = runs.filter(({ input, trials }) => input.benchmark.arms.some(({ name }) => {
      const results = new Set(trials.filter((trial) => trial.arm === name).map(({ result }) => result));

      return results.has('passed') && (results.has('failed') || results.has('error'));
    })).length;

    return {
      task: id,
      arms: newest.benchmark.arms.map((arm) => ({
        key: armKey(arm),
        ...rateFields(passRate(runs.flatMap(({ input, trials }) => (input.benchmark.arms.some((ran) => armKey(ran) === armKey(arm)) ? trials.filter((trial) => trial.arm === arm.name) : [])))),
      })),
      runs: runs.map(({ input, baseline, trials }) => ({ run: input.run, baseline, ...rateFields(passRate(trials)) })),
      disagreedRuns,
      unmeasuredRuns: runs.filter(({ baseline }) => !isMeasured(baseline)).length,
    };
  });
}

/** Which of two current arms, if exactly one, the pair differs in. */
/** The model the suite asked of an arm: its alias, which resolves to each tool's own model, or the model and effort. */
function requestedModel({ alias, model, effort }: Arm): [string] | [string | null, string | null] {
  return alias !== undefined ? [alias] : [model ?? null, effort ?? null];
}

function dimensionOf(left: Arm, right: Arm): ArmDimension | undefined {
  const differs = {
    team: JSON.stringify(teamChoiceOf(left.team)) !== JSON.stringify(teamChoiceOf(right.team)),
    tool: left.tool !== right.tool,
    model: JSON.stringify(requestedModel(left)) !== JSON.stringify(requestedModel(right)),
    workflow: (left.workflow?.name ?? null) !== (right.workflow?.name ?? null),
    role: (left.role ?? null) !== (right.role ?? null),
  } satisfies Record<ArmDimension, boolean>;

  const [only, ...more] = ARM_DIMENSIONS.filter((dimension) => differs[dimension]);

  return more.length === 0 ? only : undefined;
}

/** For the team: none, then without some paths, then a named ref, then the pulled revision. */
const TEAM_ORDER = { none: 0, without: 1, ref: 2, pulled: 3 } as const satisfies Record<ArmTeam['kind'], number>;

function comparisonsOf({ current, newest }: SuiteRuns): Pick<SuiteView, 'comparisons' | 'uncompared'> {
  const arms = newest.benchmark.arms;

  const ordered = (left: Arm, right: Arm, dimension: ArmDimension): [Arm, Arm] => {
    if (dimension !== 'team') return [left, right];

    return TEAM_ORDER[right.team.kind] < TEAM_ORDER[left.team.kind] ? [right, left] : [left, right];
  };

  const comparisons: ArmComparison[] = [];
  const uncompared: UncomparedArms[] = [];
  arms.forEach((left, index) => {
    for (const right of arms.slice(index + 1)) {
      const dimension = dimensionOf(left, right);

      if (dimension === undefined) continue;
      const [from, to] = ordered(left, right, dimension);
      const [fromKey, toKey] = [armKey(from), armKey(to)];

      const { compared, excluded } = pairsOf(current, { from: fromKey, to: toKey });
      const pairs = compared.map(({ one, other }) => ({ task: one.trial.task, from: one.trial.result === 'passed', to: other.trial.result === 'passed' }));
      const [observedFrom, observedTo] = [compared.map(({ one }) => one), compared.map(({ other }) => other)];

      if (pairs.length === 0) {
        if (excluded.length > 0) uncompared.push({ dimension, from: fromKey, to: toKey, excluded });

        continue;
      }

      const rate = (of: typeof pairs, side: 'from' | 'to'): PassRate => ({ passed: of.filter((pair) => pair[side]).length, planned: of.length });
      comparisons.push(definedFields<ArmComparison>({
        dimension, from: fromKey, to: toKey, pairs: pairs.length,
        rates: { from: rate(pairs, 'from'), to: rate(pairs, 'to') },
        usage: { from: usageOf(observedFrom), to: usageOf(observedTo) },
        difference: differenceOf(pairs),
        tasks: newest.benchmark.tasks.flatMap(({ id }) => {
          const own = pairs.filter((pair) => pair.task === id);

          return own.length > 0 ? [{ task: id, from: rate(own, 'from'), to: rate(own, 'to') }] : [];
        }),
        excluded: excluded.length > 0 ? excluded : undefined,
      }));
    }
  });

  const byDimension = (left: { dimension: ArmDimension }, right: { dimension: ArmDimension }): number => ARM_DIMENSIONS.indexOf(left.dimension) - ARM_DIMENSIONS.indexOf(right.dimension);

  return { comparisons: comparisons.sort(byDimension), uncompared: uncompared.sort(byDimension) };
}

/**
 * The trials of arm keys `from` and `to` of one task and repetition in one run of `current`, compared and excluded by
 * `compareTrials`: a run that ran only one of the arms gives none.
 */
function pairsOf(current: readonly BenchmarkRunInput[], { from, to }: { from: string; to: string }) {
  return splitPairs(current.flatMap((record) => {
    const named = (key: string): string | undefined => record.benchmark.arms.find((arm) => armKey(arm) === key)?.name;
    const [fromName, toName] = [named(from), named(to)];

    if (fromName === undefined || toName === undefined) return [];
    const trials = observedTrials(record);

    return trials.filter(({ trial }) => trial.arm === fromName).flatMap((one) => {
      const other = trials.find(({ trial: { arm, task, repetition } }) => arm === toName && task === one.trial.task && repetition === one.trial.repetition);
      const comparison = other && compareTrials({ from: one.trial, fromTasks: record.benchmark.tasks, to: other.trial, toTasks: record.benchmark.tasks });

      return other && comparison ? [{ pair: { one, other }, comparison }] : [];
    });
  }));
}

/** To's pass rate minus from's over `pairs`, not empty, with its 95% interval. */
function differenceOf(pairs: ReadonlyArray<{ from: boolean; to: boolean }>): PairedInterval {
  const count = (test: (pair: { from: boolean; to: boolean }) => boolean): number => pairs.filter(test).length;

  return pairedDifference({ both: count((p) => p.from && p.to), toOnly: count((p) => p.to && !p.from), fromOnly: count((p) => p.from && !p.to), neither: count((p) => !p.from && !p.to) });
}

/**
 * Each current arm of `newest` but the reference, its defaults arm, else its first, against it over the pairs of their
 * trials in `current`, read with each arm's pooled pass rate and cost per passed trial in `arms`, as the run's table
 * reads one run (`ArmAgainst`); absent with one arm.
 */
function againstOf({ current, newest }: SuiteRuns, arms: readonly ArmSeries[]): SuiteView['against'] {
  const { arms: ran, defaultsArm } = newest.benchmark;
  const reference = ran.find(({ name }) => name === defaultsArm) ?? ran[0];

  if (reference === undefined || ran.length < 2) return undefined;

  const standingOf = (key: string): ArmStanding => {
    const pooled = arms.find((arm) => arm.key === key)?.pooled;

    return definedFields<ArmStanding>({ rate: pooled && { passed: pooled.passed, planned: pooled.planned }, cost: pooled?.usage.costPerPassedTrial });
  };

  return {
    reference: armKey(reference), isDefaultsArm: reference.name === defaultsArm,
    arms: ran.filter((arm) => arm !== reference).map((arm) => {
      const key = armKey(arm);
      const { compared, excluded } = pairsOf(current, { from: armKey(reference), to: key });

      return definedFields<PooledAgainst>({
        arm: arm.name, key,
        difference: compared.length > 0 ? differenceOf(compared.map(({ one, other }) => ({ from: one.trial.result === 'passed', to: other.trial.result === 'passed' }))) : undefined,
        excluded: excluded.length > 0 ? excluded : undefined,
        dominance: dominanceOf({ mine: standingOf(key), theirs: standingOf(armKey(reference)) }),
      });
    }),
  };
}

function judgingOf({ current, newest }: SuiteRuns): SuiteView['judging'] {
  const scorers = new Map<string, Omit<ScorerJudging, 'planned' | 'byJudge'> & { planned: Map<string, PlannedJudge>; byJudge: Map<string, ScorerJudging['byJudge'][number]> }>();

  const entry = (name: string) => {
    const scorer = isCorrectnessScorer(name) ? CORRECTNESS_SCORERS : name;
    const kept = scorers.get(scorer) ?? { scorer, planned: new Map(), byCheck: 0, byJudge: new Map(), deviations: 0, notVerified: 0, unscored: 0 };
    scorers.set(scorer, kept);

    return kept;
  };

  for (const { benchmark } of current) {
    for (const [name, judge] of Object.entries(benchmark.judges ?? {})) entry(name).planned.set(JSON.stringify([judge.tool, judge.model]), judge);

    for (const { scorer, outcome, decider, asPlanned } of benchmark.trials.flatMap((trial) => (trial.result === 'not_run' ? [] : trial.verdicts ?? []))) {
      const kept = entry(scorer);

      if (outcome.kind === 'unscored') kept.unscored += 1;
      else if (decider?.by === 'check') kept.byCheck += 1;
      else if (decider?.by === 'judge') {
        const judge = definedFields<JudgeName>({ tool: decider.tool, model: decider.model, effort: decider.effort });
        const key = JSON.stringify([judge.tool, judge.model ?? null, judge.effort ?? null]);
        const seen = kept.byJudge.get(key);
        kept.byJudge.set(key, { judge, labels: (seen?.labels ?? 0) + 1 });
      }

      if (asPlanned === 'deviation') kept.deviations += 1;

      if (asPlanned === 'not_verified') kept.notVerified += 1;
    }
  }

  const selfJudged = new Map<string, BenchmarkTable['selfJudged'][number]>();

  for (const judged of current.flatMap(({ benchmark }) => selfJudgedOf(benchmark))) if (!selfJudged.has(judged.tool)) selfJudged.set(judged.tool, judged);

  return {
    scorers: [...scorers.values()].sort((left, right) => Number(right.scorer === CORRECTNESS_SCORERS) - Number(left.scorer === CORRECTNESS_SCORERS))
      .map(({ planned, byJudge, ...counts }) => ({ ...counts, planned: [...planned.values()], byJudge: [...byJudge.values()] })),
    selfJudged: [...selfJudged.values()],
    calibration: definedFields<SuiteCalibration>({
      judges: calibrationOf(current.flatMap(({ benchmark }) => benchmark.trials)),
      rate: newest.benchmark.calibration?.rate,
      mixedTasks: newest.benchmark.tasks.filter((task) => isMixedTaskIn(newest.benchmark, task.id)).length,
      failedChecks: current.flatMap(({ benchmark }) => benchmark.trials.filter((trial) => isMixedTaskIn(benchmark, trial.task) && trial.verdicts?.some(({ scorer, outcome, decider }) => (
        scorer === correctnessScorerName(trial.task) && decider?.by === 'check' && outcome.kind === 'labelled' && !outcome.passed
      )))).length,
    }),
  };
}

/** `isMixedTask` as the record keeps it: the task has a check and success criteria. */
function isMixedTaskIn(record: BenchmarkRecord, task: string): boolean {
  const judge = record.tasks.find(({ id }) => id === task)?.judge;

  return judge === 'both';
}

function scorersOf({ current, newest }: SuiteRuns): ScorerView[] {
  const rows = current.flatMap((input) => benchmarkTable(input).scorers.flatMap((row) => {
    const arm = input.benchmark.arms.find(({ name }) => name === row.arm);

    return arm ? [{ ...row, key: armKey(arm) }] : [];
  }));

  return [...new Set(rows.map(({ scorer }) => scorer))].map((scorer) => ({
    scorer,
    arms: newest.benchmark.arms.flatMap((arm) => {
      const key = armKey(arm);
      const pooled = rows.filter((row) => row.scorer === scorer && row.key === key);

      if (pooled.length === 0) return [];
      const total = (count: 'passed' | 'labelled' | 'unscored') => pooled.reduce((sum, row) => sum + row[count], 0);
      const passed = total('passed'), labelled = total('labelled');

      return [definedFields<ScorerView['arms'][number]>({ key, passed, labelled, unscored: total('unscored'), interval: labelled > 0 ? wilson({ passed, planned: labelled }) : undefined })];
    }),
  }));
}

function teamChangesOf({ current }: SuiteRuns): SuiteView['teamChanges'] {
  const configs = new Map<string, TeamConfig>();
  const revisions = new Map<string, { firstRunAt: string; byConfig: Map<string, { runs: Set<string>; trials: Trial[] }> }>();

  for (const { run, startedAt, benchmark } of current) {
    for (const arm of benchmark.arms) {
      if (arm.team.kind !== 'pulled' && arm.team.kind !== 'ref') continue;
      const key = configKey(arm);
      configs.set(key, definedFields<TeamConfig>({ key, tool: arm.tool, model: arm.model || undefined, effort: arm.effort || undefined, workflow: arm.workflow?.name, role: arm.role }));
      const revision = revisions.get(arm.team.revision) ?? { firstRunAt: startedAt, byConfig: new Map() };
      const config = revision.byConfig.get(key) ?? { runs: new Set<string>(), trials: [] };
      config.runs.add(run);
      config.trials.push(...benchmark.trials.filter((trial) => trial.arm === arm.name));
      revision.byConfig.set(key, config);
      revisions.set(arm.team.revision, revision);
    }
  }

  const spanning = [...configs.values()].filter(({ key }) => [...revisions.values()].filter(({ byConfig }) => byConfig.has(key)).length > 1);

  if (spanning.length === 0) return { configs: [], revisions: [] };

  return {
    configs: spanning,
    revisions: [...revisions].sort(([, left], [, right]) => left.firstRunAt.localeCompare(right.firstRunAt)).map(([revision, { firstRunAt, byConfig }]) => ({
      revision, firstRunAt,
      configs: spanning.flatMap(({ key }) => {
        const config = byConfig.get(key);

        if (!config) return [];
        const rate = passRate(config.trials);

        if (rate.planned === 0) return [];
        const tasks = [...new Set(config.trials.map(({ task }) => task))].map((task) => ({ task, ...passRate(config.trials.filter((trial) => trial.task === task)) }));

        return [{ key, runs: config.runs.size, ...rate, ...wilson(rate), tasks }];
      }),
    })),
  };
}

/** The version of each tool the run's prompts reported, the most reported one when they differ. */
function toolVersionsOf(input: BenchmarkRunInput): Record<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const { ranAs } of observedTrials(input)) {
    const { name, version } = ranAs?.tool ?? {};

    if (name === undefined || version === undefined) continue;
    const versions = counts.get(name) ?? new Map<string, number>();
    versions.set(version, (versions.get(version) ?? 0) + 1);
    counts.set(name, versions);
  }

  return Object.fromEntries([...counts].map(([tool, versions]) => [tool, [...versions].sort(([, left], [, right]) => right - left)[0]?.[0] ?? '']));
}

function runRow(input: BenchmarkRunInput, isCurrent: boolean): RunRow {
  const { run, source, startedAt, username, benchmark } = input;

  return definedFields<RunRow>({
    run, source, startedAt, username: username || undefined,
    sourceHash: runSourceHash(benchmark),
    isCurrent,
    teamRevision: benchmark.baselineTeamRevision,
    ...passRate(benchmark.trials),
    unmeasuredTasks: benchmark.tasks.filter(({ baseline }) => !isMeasured(baseline)).length,
    toolVersions: toolVersionsOf(input),
    arms: benchmark.arms.map((arm) => ({ key: armKey(arm), ...passRate(benchmark.trials.filter((trial) => trial.arm === arm.name)) })),
    spend: spendOf(input),
  });
}

function spendOf(input: BenchmarkRunInput): RunRow['spend'] {
  const estimated = input.benchmark.estimate?.total;
  // A judge that ran and stated no cost, or not all of it, leaves the total unknown rather than lower.
  const stated = (cost: Trial['scoringCost']) => (cost?.complete ? cost : undefined);

  const judging = input.benchmark.trials.flatMap(({ scoringCost, calibration }) => [
    ...(scoringCost ? [stated(scoringCost)] : []),
    ...(calibration ? [stated(calibration.scoringCost)] : []),
  ]);

  const spent = costTotal([...agentCostsOf(observedTrials(input)), ...judging]);

  return definedFields<RunRow['spend']>({ estimated, spent, outside: estimated === undefined ? undefined : outsideOf(estimated, spent) });
}

function outsideOf(estimated: NonNullable<BenchmarkEstimate['total']>, spent: CostTotal): 'above' | 'below' | undefined {
  if (!estimated.complete || (spent.kind !== 'known' && spent.kind !== 'incomplete') || spent.unit !== estimated.unit) return undefined;

  if (spent.amount > estimated.high) return 'above';

  return spent.kind === 'known' && spent.amount < estimated.low ? 'below' : undefined;
}

/**
 * `current` against the newest of `earlier` that started before it, ended `succeeded`, has a record of the same
 * schemaVersion, and ran the same suite and the same arms: each arm's name, tool, model, effort, workflow, role and team
 * choice, never the revision a team resolved to. Each arm's trials pair by task and repetition, and a pair counts only
 * when `comparePair` compares it. An arm with no compared pair cannot drop; no older run is searched when that run has
 * none on any arm.
 */
export function regressionOf(current: BenchmarkRunInput, earlier: readonly BenchmarkRunInput[]): Regression {
  const treatments = ({ arms }: BenchmarkRecord): string => JSON.stringify(arms.map(armKey).sort());

  const [against] = earlier.filter(({ run, outcome, startedAt, schemaVersion, benchmark }) => run !== current.run && outcome === 'succeeded' && startedAt < current.startedAt
    && schemaVersion === current.schemaVersion && benchmark.suite.name === current.benchmark.suite.name && treatments(benchmark) === treatments(current.benchmark))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  if (!against) return { kind: 'no_comparable' };

  const paired = current.benchmark.arms.map(({ name }) => {
    const candidates = current.benchmark.trials.filter(({ arm }) => arm === name).flatMap((to) => {
      const from = against.benchmark.trials.find(({ arm, task, repetition }) => arm === name && task === to.task && repetition === to.repetition);
      const comparison = from && compareTrials({ from, fromTasks: against.benchmark.tasks, to, toTasks: current.benchmark.tasks });

      return from && comparison ? [{ pair: { from: from.result === 'passed', to: to.result === 'passed' }, comparison }] : [];
    });

    return { arm: name, ...splitPairs(candidates) };
  });

  const arms = paired.map(({ arm, compared, excluded }) => ({ arm, pairs: compared.length, excluded }));

  if (paired.every(({ compared }) => compared.length === 0)) return { kind: 'no_comparable', tried: { run: against.run, arms } };

  const drops = paired.flatMap(({ arm, compared: pairs }) => {
    if (pairs.length === 0) return [];
    const count = (test: (pair: { from: boolean; to: boolean }) => boolean): number => pairs.filter(test).length;
    const difference = pairedDifference({ both: count((p) => p.from && p.to), toOnly: count((p) => p.to && !p.from), fromOnly: count((p) => p.from && !p.to), neither: count((p) => !p.from && !p.to) });
    const rate = (side: 'from' | 'to'): PassRate => ({ passed: count((pair) => pair[side]), planned: pairs.length });

    return difference.high < 0 ? [{ arm, pairs: pairs.length, rates: { from: rate('from'), to: rate('to') }, difference }] : [];
  });

  return drops.length > 0 ? { kind: 'dropped', against: against.run, arms, drops } : { kind: 'held', against: against.run, arms };
}

/** What `--fail-on-regression` found, as the report prints it: a line per arm with its pairs, then what they show. */
export function formatRegression(regression: Regression, suite: string): string[] {
  const points = (fraction: number): number => Math.round(fraction * 100);

  const armLines = (against: string, arms: readonly ArmPairs[]): string[] => arms.map(({ arm, pairs, excluded }) => (
    `Arm ${arm}: ${pairs} comparable ${pairs === 1 ? 'pair' : 'pairs'} against run ${against}${excluded.length > 0 ? `; ${formatExcluded(excluded)}` : ''}.`
  ));

  switch (regression.kind) {
    case 'no_comparable':
      return regression.tried === undefined
        ? [`No earlier succeeded run of suite ${suite} ran the same arms on teamai-reports in a record of this version: recording is off, nothing comparable has been published yet, or the earlier runs ran on a teamai that recorded them another way. --fail-on-regression has nothing to compare with.`]
        : [...armLines(regression.tried.run, regression.tried.arms), `No arm has a comparable pair against run ${regression.tried.run}, so --fail-on-regression has nothing to compare with.`];
    case 'held':
      return [...armLines(regression.against, regression.arms), `No arm's pass rate dropped by more than chance against run ${regression.against}.`];
    case 'dropped':
      return [
        ...armLines(regression.against, regression.arms),
        ...regression.drops.map(({ arm, pairs, rates, difference }) => `Arm "${arm}" passed ${rates.to.passed}/${pairs} paired trials, against ${rates.from.passed}/${pairs} in run ${regression.against}: a drop of ${points(-difference.value)} points, with a 95% interval of ${points(difference.low)} to ${points(difference.high)} points.`),
      ];
    default: {
      const unhandled: never = regression;

      return unhandled;
    }
  }
}

/** The paired comparisons of one run's arms, as Compare derives them over a suite's runs: never stored, always derived. */
export function runComparisons(input: BenchmarkRunInput): ArmComparison[] {
  return comparisonsOf({ runs: [input], current: [input], newest: input }).comparisons;
}

export const BenchmarkHistory = {
  of({ runs, query, now }: { runs: readonly BenchmarkRunInput[]; query: BenchmarkHistoryQuery; now: Date }): BenchmarkHistoryView {
    const window = { from: new Date(now.getTime() - query.windowDays * DAY_MS).toISOString(), to: now.toISOString() };

    const inWindow = runs.filter(({ startedAt }) => startedAt >= window.from && startedAt <= window.to)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));

    const bySuite = new Map<string, BenchmarkRunInput[]>();

    for (const input of inWindow) bySuite.set(input.benchmark.suite.name, [...bySuite.get(input.benchmark.suite.name) ?? [], input]);

    const suites = [...bySuite].flatMap(([suite, own]) => {
      const newest = own.at(-1);

      return newest ? [summaryOf(suite, own, newest)] : [];
    }).sort((left, right) => right.lastRunAt.localeCompare(left.lastRunAt));

    const chosen = suites.find(({ suite }) => suite === query.suite) ?? suites[0];
    const own = chosen ? bySuite.get(chosen.suite) ?? [] : [];
    const newest = own.at(-1);

    if (!chosen || !newest) return { window, suites };
    const whole = own.filter(({ benchmark }) => benchmark.subset === undefined);
    const versioned = whole.length > 0 ? whole : own;
    const reference = versioned.at(-1) ?? newest;
    const version = runSourceHash(reference.benchmark);
    const isCurrent = ({ schemaVersion, benchmark }: BenchmarkRunInput): boolean => schemaVersion === reference.schemaVersion && runSourceHash(benchmark) === version;
    const suiteRuns = { runs: own, current: own.filter(isCurrent), newest: reference };
    const arms = armsOf(suiteRuns);
    const alone = { runs: [newest], current: [newest], newest };

    return {
      window,
      suites,
      selected: definedFields<SuiteView>({
        suite: chosen.suite,
        versions: versionsOf(versioned),
        arms,
        tasks: tasksOf(suiteRuns),
        scorers: scorersOf(suiteRuns),
        runs: own.map((input) => runRow(input, isCurrent(input))).toReversed(),
        latest: definedFields<SuiteView['latest']>({ run: newest.run, source: newest.source, table: benchmarkTable(newest), against: againstOf(alone, armsOf(alone)) }),
        ...comparisonsOf(suiteRuns),
        against: againstOf(suiteRuns, arms),
        judging: judgingOf(suiteRuns),
        teamChanges: teamChangesOf(suiteRuns),
      }),
    };
  },
} as const;
