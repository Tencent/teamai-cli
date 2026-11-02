/**
 * The dashboard's Benchmarks page: every ended benchmark run of a workspace, from this machine's run files and the
 * team's records, read as a history per suite. Pure over the runs' end records, so the page counts what `jq` over the
 * records counts: a pass rate is passed trials over planned trials, as the run's own table prints it.
 *
 * Runs of one suite compare only while the suite's files stay the same, so what the page pools (an arm's pass rate and
 * usage, the task by arm heatmap) covers the runs of the suite's current version: the run `sourceHash` of the newest
 * run, over its suite file and each task file.
 * Each run still shows as a point of its own.
 */
import { runSourceHash } from './plan.js';
import type { Baseline, BenchmarkRecord, BenchmarkRunRecord } from './result.js';
import type { TeamChoice } from './suite.js';
import type { ArmTeam } from './terms.js';
import {
  benchmarkTable, deviationsOf, observedTrials, usageOf, type ArmResults, type ArmUsage, type BenchmarkTable, type ObservedTrial, type PassRate,
} from './table.js';

/** One ended benchmark run, as its end record holds it. `source`: this machine's run file, or the team's record. */
export interface BenchmarkRunInput {
  run: string;
  source: 'local' | 'reported';
  username?: string;
  startedAt: string;
  outcome: BenchmarkRunRecord['outcome'];
  benchmark: BenchmarkRecord;
}

/**
 * What `teamai benchmark run --fail-on-regression` found against the newest earlier comparable run, `against`: an arm
 * whose pass rate over the trials paired by task and repetition dropped with its whole interval below zero has `dropped`.
 */
export type Regression =
  | { kind: 'no_comparable' }
  | { kind: 'held'; against: string }
  | { kind: 'dropped'; against: string; arms: Array<{ arm: string; pairs: number; rates: ArmComparison['rates']; difference: ArmComparison['difference'] }> };

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

/** An arm over the runs of the current version, counted as each run's own table counts it. */
export type PooledArm = PooledRate & Pick<ArmResults, 'deviations' | 'notVerified'> & { usage: Omit<ArmUsage, 'arm'> };

/**
 * One arm as a configuration: its name, tool, model, effort and team choice. An arm whose model changed between runs is
 * two series, since its runs measured two things. A pulled team that moved to another revision stays one series, as the
 * suite asked for whatever the team pulled: the runs table marks the change.
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
  /** In the newest run of the suite. */
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
export const ARM_DIMENSIONS = ['team', 'tool', 'model', 'workflow'] as const;
export type ArmDimension = (typeof ARM_DIMENSIONS)[number];

/**
 * Two current arms that differ in exactly one dimension, compared trial by trial: each pair is both arms' trial of one
 * task and repetition in one run of the current version. `from` is the arm the difference is measured from: for the team,
 * none before the pulled revision without some paths, before a named ref, before the pulled revision; otherwise the
 * first in the suite's order.
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
}

/** A tool, model, effort and workflow, whatever the team: one line of the team changes chart. */
export interface TeamConfig {
  key: string;
  tool: string;
  model?: string;
  effort?: string;
  /** The team workflow the arm runs; absent: the trial's own prompt. */
  workflow?: string;
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
  /** The newest run's tasks, in its order. */
  tasks: TaskView[];
  /** Newest first. */
  runs: RunRow[];
  /** The newest run's own table, as it printed it. */
  latest: { run: string; source: BenchmarkRunInput['source']; table: BenchmarkTable };
  /** Every pair of current arms that differ in one dimension, team first. */
  comparisons: ArmComparison[];
  /** The team revisions of the current version, for configurations that ran on two or more. */
  teamChanges: { configs: TeamConfig[]; revisions: TeamRevisionView[] };
}

/** One run of the suite. `teamRevision`: the team revision its trials installed team assets from. */
export interface RunRow extends PassRate {
  run: string;
  source: BenchmarkRunInput['source'];
  startedAt: string;
  username?: string;
  sourceHash: string;
  teamRevision: string;
  /** Tasks the run did not measure: see isMeasured. */
  unmeasuredTasks: number;
  /** The version of each tool its prompts reported, the most reported one when they differ. */
  toolVersions: Record<string, string>;
  /** Each arm of the run as a configuration, in the run's order. */
  arms: Array<{ key: string } & PassRate>;
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
/** The normal quantile of a two-sided 95% interval. */
const Z = 1.96;

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

/** The Wilson score interval of `passed` out of `planned`, planned above 0. */
function wilson({ passed, planned }: PassRate): { low: number; high: number } {
  const p = passed / planned;
  const z2 = Z * Z;
  const denominator = 1 + z2 / planned;
  const center = (p + z2 / (2 * planned)) / denominator;
  const margin = (Z * Math.sqrt((p * (1 - p)) / planned + z2 / (4 * planned * planned))) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function armKey({ name, tool, model, effort, team, workflow }: Pick<Arm, 'name' | 'tool' | 'model' | 'effort' | 'team' | 'workflow'>): string {
  return JSON.stringify([name, tool, model ?? null, effort ?? null, teamChoiceOf(team), workflow?.name ?? null]);
}

function configKey({ tool, model, effort, workflow }: Pick<Arm, 'tool' | 'model' | 'effort' | 'workflow'>): string {
  return JSON.stringify([tool, model ?? null, effort ?? null, workflow?.name ?? null]);
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
  return {
    suite,
    runs: runs.length,
    lastRunAt: newest.startedAt,
    tasks: newest.benchmark.tasks.length,
    arms: newest.benchmark.arms.length,
    ...(leader ? { leader } : {}),
    trend: runs.map(({ run, startedAt, benchmark }) => ({ run, startedAt, ...passRate(benchmark.trials) })),
  };
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

/** The runs of one suite in the window, oldest first: those of its current version, and the newest. */
interface SuiteRuns {
  runs: readonly BenchmarkRunInput[];
  current: readonly BenchmarkRunInput[];
  newest: BenchmarkRunInput;
}

function armsOf({ runs, current, newest }: SuiteRuns): ArmSeries[] {
  const configs = new Map<string, { arm: Arm; points: RunPoint[]; pooledTrials: ObservedTrial[]; pooledRuns: number; deviations: number; notVerified: number }>();
  for (const input of runs) {
    const isPooled = current.includes(input);
    const observed = isPooled ? observedTrials(input) : [];
    for (const arm of input.benchmark.arms) {
      const key = armKey(arm);
      const config = configs.get(key) ?? { arm, points: [], pooledTrials: [], pooledRuns: 0, deviations: 0, notVerified: 0 };
      config.points.push({ run: input.run, startedAt: input.startedAt, ...passRate(input.benchmark.trials.filter((trial) => trial.arm === arm.name)) });
      if (isPooled) {
        // Each run's arm is compared on its own team revision, as that run's table compares it.
        const own = observed.filter(({ trial }) => trial.arm === arm.name);
        const { deviations, notVerified } = deviationsOf(arm, own);
        config.pooledTrials.push(...own);
        config.pooledRuns += 1;
        config.deviations += deviations;
        config.notVerified += notVerified;
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
  }).map(([key, { arm, points, pooledTrials, pooledRuns, deviations, notVerified }]) => {
    const pooled = passRate(pooledTrials.map(({ trial }) => trial));
    return {
      key, arm: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), ...(arm.effort ? { effort: arm.effort } : {}), team: teamChoiceOf(arm.team), ...(arm.workflow ? { workflow: arm.workflow.name } : {}),
      isCurrent: order.includes(key),
      ...(pooled.planned > 0 ? { pooled: { ...pooled, ...wilson(pooled), runs: pooledRuns, deviations, notVerified, usage: usageOf(pooledTrials) } } : {}),
      points,
    };
  });
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
  } satisfies Record<ArmDimension, boolean>;
  const [only, ...more] = ARM_DIMENSIONS.filter((dimension) => differs[dimension]);
  return more.length === 0 ? only : undefined;
}

/** For the team: none, then without some paths, then a named ref, then the pulled revision. */
const TEAM_ORDER = { none: 0, without: 1, ref: 2, pulled: 3 } as const satisfies Record<ArmTeam['kind'], number>;

/**
 * The 95% interval of `to - from` over paired trials (Newcombe 1998, method 10): `both` passed on both arms, `toOnly`
 * only on to, `fromOnly` only on from, `neither` on neither.
 */
export function pairedDifference({ both, toOnly, fromOnly, neither }: { both: number; toOnly: number; fromOnly: number; neither: number }): ArmComparison['difference'] {
  const n = both + toOnly + fromOnly + neither;
  const to = { passed: both + toOnly, planned: n };
  const from = { passed: both + fromOnly, planned: n };
  const [pTo, pFrom] = [to.passed / n, from.passed / n];
  const [toCi, fromCi] = [wilson(to), wilson(from)];
  const product = (both + toOnly) * (fromOnly + neither) * (both + fromOnly) * (toOnly + neither);
  const cross = both * neither - toOnly * fromOnly;
  // Newcombe's continuity correction of the correlation, applied when it is positive.
  const phi = product === 0 ? 0 : (cross > 0 ? Math.max(cross - n / 2, 0) : cross) / Math.sqrt(product);
  const value = pTo - pFrom;
  const below = Math.sqrt(Math.max(0, (pTo - toCi.low) ** 2 - 2 * phi * (pTo - toCi.low) * (fromCi.high - pFrom) + (fromCi.high - pFrom) ** 2));
  const above = Math.sqrt(Math.max(0, (toCi.high - pTo) ** 2 - 2 * phi * (toCi.high - pTo) * (pFrom - fromCi.low) + (pFrom - fromCi.low) ** 2));
  return { value, low: Math.max(-1, value - below), high: Math.min(1, value + above) };
}

function comparisonsOf({ current, newest }: SuiteRuns): ArmComparison[] {
  const arms = newest.benchmark.arms;
  const ordered = (left: Arm, right: Arm, dimension: ArmDimension): [Arm, Arm] => {
    if (dimension !== 'team') return [left, right];
    return TEAM_ORDER[right.team.kind] < TEAM_ORDER[left.team.kind] ? [right, left] : [left, right];
  };
  const comparisons: ArmComparison[] = [];
  arms.forEach((left, index) => {
    for (const right of arms.slice(index + 1)) {
      const dimension = dimensionOf(left, right);
      if (dimension === undefined) continue;
      const [from, to] = ordered(left, right, dimension);
      const [fromKey, toKey] = [armKey(from), armKey(to)];
      const pairs: Array<{ task: string; from: boolean; to: boolean }> = [];
      const observed: { from: ObservedTrial[]; to: ObservedTrial[] } = { from: [], to: [] };
      for (const record of current) {
        const named = (key: string): string | undefined => record.benchmark.arms.find((arm) => armKey(arm) === key)?.name;
        const [fromName, toName] = [named(fromKey), named(toKey)];
        if (fromName === undefined || toName === undefined) continue;
        const trials = observedTrials(record);
        for (const one of trials.filter(({ trial }) => trial.arm === fromName)) {
          const other = trials.find(({ trial: { arm, task, repetition } }) => arm === toName && task === one.trial.task && repetition === one.trial.repetition);
          if (!other) continue;
          pairs.push({ task: one.trial.task, from: one.trial.result === 'passed', to: other.trial.result === 'passed' });
          observed.from.push(one);
          observed.to.push(other);
        }
      }
      if (pairs.length === 0) continue;
      const count = (test: (pair: { from: boolean; to: boolean }) => boolean): number => pairs.filter(test).length;
      const rate = (of: typeof pairs, side: 'from' | 'to'): PassRate => ({ passed: of.filter((pair) => pair[side]).length, planned: of.length });
      comparisons.push({
        dimension, from: fromKey, to: toKey, pairs: pairs.length,
        rates: { from: rate(pairs, 'from'), to: rate(pairs, 'to') },
        usage: { from: usageOf(observed.from), to: usageOf(observed.to) },
        difference: pairedDifference({ both: count((p) => p.from && p.to), toOnly: count((p) => p.to && !p.from), fromOnly: count((p) => p.from && !p.to), neither: count((p) => !p.from && !p.to) }),
        tasks: newest.benchmark.tasks.flatMap(({ id }) => {
          const own = pairs.filter((pair) => pair.task === id);
          return own.length > 0 ? [{ task: id, from: rate(own, 'from'), to: rate(own, 'to') }] : [];
        }),
      });
    }
  });
  return comparisons.sort((left, right) => ARM_DIMENSIONS.indexOf(left.dimension) - ARM_DIMENSIONS.indexOf(right.dimension));
}

function teamChangesOf({ current }: SuiteRuns): SuiteView['teamChanges'] {
  const configs = new Map<string, TeamConfig>();
  const revisions = new Map<string, { firstRunAt: string; byConfig: Map<string, { runs: Set<string>; trials: Trial[] }> }>();
  for (const { run, startedAt, benchmark } of current) {
    for (const arm of benchmark.arms) {
      if (arm.team.kind !== 'pulled' && arm.team.kind !== 'ref') continue;
      const key = configKey(arm);
      configs.set(key, { key, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), ...(arm.effort ? { effort: arm.effort } : {}), ...(arm.workflow ? { workflow: arm.workflow.name } : {}) });
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

function runRow(input: BenchmarkRunInput): RunRow {
  const { run, source, startedAt, username, benchmark } = input;
  return {
    run, source, startedAt, ...(username ? { username } : {}),
    sourceHash: runSourceHash(benchmark),
    teamRevision: benchmark.baselineTeamRevision,
    ...passRate(benchmark.trials),
    unmeasuredTasks: benchmark.tasks.filter(({ baseline }) => !isMeasured(baseline)).length,
    toolVersions: toolVersionsOf(input),
    arms: benchmark.arms.map((arm) => ({ key: armKey(arm), ...passRate(benchmark.trials.filter((trial) => trial.arm === arm.name)) })),
  };
}

/**
 * `current` against the newest of `earlier` that started before it, ended `succeeded`, and ran the same suite, the same
 * tasks by source hash, and the same arms: each arm's name, tool, model, effort, workflow and team choice, never the
 * revision a team resolved to. Each arm's trials pair by task and repetition, as Compare pairs two arms of one run.
 */
export function regressionOf(current: BenchmarkRunInput, earlier: readonly BenchmarkRunInput[]): Regression {
  const taskVersions = ({ tasks }: BenchmarkRecord): string => JSON.stringify(tasks.map(({ id, sourceHash }) => [id, sourceHash]).sort());
  const treatments = ({ arms }: BenchmarkRecord): string => JSON.stringify(arms.map(armKey).sort());
  const [against] = earlier.filter(({ run, outcome, startedAt, benchmark }) => run !== current.run && outcome === 'succeeded' && startedAt < current.startedAt
    && benchmark.suite.name === current.benchmark.suite.name && taskVersions(benchmark) === taskVersions(current.benchmark) && treatments(benchmark) === treatments(current.benchmark))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  if (!against) return { kind: 'no_comparable' };
  const arms = current.benchmark.arms.flatMap(({ name }) => {
    const pairs = current.benchmark.trials.filter(({ arm }) => arm === name).flatMap((to) => {
      const from = against.benchmark.trials.find(({ arm, task, repetition }) => arm === name && task === to.task && repetition === to.repetition);
      return from ? [{ from: from.result === 'passed', to: to.result === 'passed' }] : [];
    });
    const count = (test: (pair: { from: boolean; to: boolean }) => boolean): number => pairs.filter(test).length;
    const difference = pairedDifference({ both: count((p) => p.from && p.to), toOnly: count((p) => p.to && !p.from), fromOnly: count((p) => p.from && !p.to), neither: count((p) => !p.from && !p.to) });
    const rate = (side: 'from' | 'to'): PassRate => ({ passed: count((pair) => pair[side]), planned: pairs.length });
    return difference.high < 0 ? [{ arm: name, pairs: pairs.length, rates: { from: rate('from'), to: rate('to') }, difference }] : [];
  });
  return arms.length > 0 ? { kind: 'dropped', against: against.run, arms } : { kind: 'held', against: against.run };
}

/** The paired comparisons of one run's arms, as Compare derives them over a suite's runs: never stored, always derived. */
export function runComparisons(input: BenchmarkRunInput): ArmComparison[] {
  return comparisonsOf({ runs: [input], current: [input], newest: input });
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
    const version = runSourceHash(newest.benchmark);
    const suiteRuns = { runs: own, current: own.filter(({ benchmark }) => runSourceHash(benchmark) === version), newest };
    return {
      window,
      suites,
      selected: {
        suite: chosen.suite,
        versions: versionsOf(own),
        arms: armsOf(suiteRuns),
        tasks: tasksOf(suiteRuns),
        runs: own.map(runRow).toReversed(),
        latest: { run: newest.run, source: newest.source, table: benchmarkTable(newest) },
        comparisons: comparisonsOf(suiteRuns),
        teamChanges: teamChangesOf(suiteRuns),
      },
    };
  },
} as const;
