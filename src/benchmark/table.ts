/**
 * The results and usage tables and the task by arm matrix: one pure function over a benchmark record, which
 * `teamai benchmark report` prints and the dashboard shows. It reads the record, not the run, so it works on a
 * published record after the suite left the cache.
 */
import type { AgentObservation } from '../agent-observation.js';
import { ROUTING_PREFIX, routingScorerName } from '../scorers/skill-routing.js';
import { definedFields } from '../utils/defined-fields.js';
import { compareAgent } from './agent-match.js';
import { compareTrials, formatExcluded, splitPairs, type ExcludedPairs } from './pairing.js';
import { isCorrectnessScorer, type BenchmarkEstimate, type CostRange } from './plan.js';
import { TRIAL_RESULTS, type Baseline, type BenchmarkRecord, type TrialResult } from './result.js';
import type { SkillChanges } from './terms.js';
import type { TrialCalibration } from './verdicts.js';

type RecordedArm = BenchmarkRecord['arms'][number];

type RecordedTrial = BenchmarkRecord['trials'][number];

export interface ArmResults extends Pick<RecordedArm, 'tool' | 'model' | 'effort' | 'source' | 'team' | 'role' | 'recall'> {
  arm: string;
  planned: number;
  counts: Record<TrialResult, number>;
  /** Trials whose prompt a limit of the suite's `trial` ended; their check or judge still decided them. In `planned`. */
  stoppedByLimit: number;
  /**
   * Trials whose prompt ran as something other than the arm: another tool, team revision, role or concrete model, or without a
   * limit of the suite's `trial` its driver could not enforce; or a label of which a judge other than the plan's gave. In `planned`.
   */
  deviations: number;
  /** Trials whose prompt ran, but whose record lacks a value the comparison needs, such as the model the tool or a judge's tool reported. */
  notVerified: number;
  /** Absent with no planned trials. */
  passRate?: PassRate;
  /**
   * The mean score of the arm's labelled correctness verdicts, those its check wrote included, and how many there were;
   * `mean` absent with none. Present on every arm, only when a correctness scorer of the record has more than two labels.
   * Never an input of the regression gate.
   */
  correctnessScore?: { labelled: number; mean?: number };
}

/** `passed / planned`, printed `67% (4/6)`. */
export interface PassRate {
  passed: number;
  planned: number;
}

/** A median that leaves unknown values out, and how many values it used. */
export interface Median {
  value?: number;
  used: number;
}

/** A total of the costs the tools stated. An unknown part is never zero: it makes the total incomplete. */
export type CostTotal =
  | { kind: 'known'; amount: number; unit: string; used: number }
  | { kind: 'incomplete'; amount: number; unit: string; used: number; unknown: number }
  /** Parts in more than one unit: not added up, since costs compare only within one unit. */
  | { kind: 'mixed'; units: string[] }
  /** No trial whose prompt ran stated a cost. */
  | { kind: 'unknown' };

export interface ArmUsage {
  arm: string;
  /** Input plus output tokens of each trial's prompt; `components` names what is added. */
  tokens: Median & { components: readonly ['input', 'output'] };
  /** Milliseconds around each trial's tool launch. */
  durationMs: Median;
  cost: CostTotal;
  /** The cost total over the passed trials, as the dashboard's Cost per passed trial; absent with none passed or no total in one unit. */
  costPerPassedTrial?: CostPerPassedTrial;
}

/** What one passed trial cost: a cost total over the passed trials, `incomplete` when the total is. */
export interface CostPerPassedTrial {
  kind: 'known' | 'incomplete';
  amount: number;
  unit: string;
}

/**
 * One arm against the reference arm: the paired difference of their pass rates, and whether either dominates the other.
 * Never an input of the regression gate or the exit code.
 */
export interface ArmAgainst {
  arm: string;
  /** This arm's pass rate minus the reference's over their compared pairs, with its 95% interval; absent when no pair compared. */
  difference?: PairedInterval;
  /** The pairs `compareTrials` left out, by why; absent when none was. */
  excluded?: ExcludedPairs[];
  /** Absent when neither dominates, or when either cost per passed trial is absent, incomplete or in another unit. */
  dominance?: Exclude<Dominance, { kind: 'neither' }>;
}

/**
 * One arm against another by cost per passed trial and pass rate. `dominates`: it costs less per passed trial and its
 * pass rate is at least the other's; `dominated`: the other does that to it; `neither`: their costs compare, and
 * neither does. `costRatio` is its cost per passed trial over the other's.
 */
export type Dominance = { passRate: 'same' | 'higher' | 'lower'; costRatio: number } & ({ kind: 'dominates' } | { kind: 'dominated' } | { kind: 'neither' });

/** One arm's verdicts of one scorer the suite or a task lists, over the arm's trials that ran it. */
export interface ArmScorerResults {
  arm: string;
  scorer: string;
  passed: number;
  labelled: number;
  unscored: number;
  /** The 95% Wilson interval of `passed` out of `labelled`; absent with no label. */
  interval?: { low: number; high: number };
  /** Whether a judge labelled them in a batch, `mixed` when some were and some were not; absent when no judge labelled one. */
  batched?: 'yes' | 'no' | 'mixed';
}

/**
 * One judge of the trials whose check failed that it labelled too, to calibrate it: how many it judged, how many it
 * labelled passing, and the 95% Wilson interval of that false pass rate.
 */
export interface JudgeCalibration {
  judge: Pick<TrialCalibration['decider'], 'tool' | 'model' | 'effort'>;
  judged: number;
  passing: number;
  interval: { low: number; high: number };
}

export interface BenchmarkTable {
  results: ArmResults[];
  usage: ArmUsage[];
  /**
   * The arm the others are read against, the defaults arm, else the first arm, and each other arm against it, in record
   * order; absent with one arm.
   */
  against?: { reference: string; isDefaultsArm: boolean; arms: ArmAgainst[] };
  /** What start estimated the run costs, from the record; absent on a record without one. */
  estimate?: BenchmarkEstimate;
  /** Each task's pass rate on each arm, tasks and arms in record order; a cell with no planned trials has no rate. */
  matrix: Array<{ task: string; arms: Array<{ arm: string; passRate?: PassRate }> }>;
  /**
   * A row per arm and per scorer the suite or a task lists, never a correctness scorer, in record order, over the arm's
   * trials that ran and that scorer judged. These scorers never decide a trial's result.
   */
  scorers: ArmScorerResults[];
  /** A row per judge, by tool, model and effort, in record order, of the trials it calibrated. These labels never decide a trial. */
  calibration: JudgeCalibration[];
  /** The tasks whose check, tried on the starting commit, did not fail there as the task expects: none of their trials ran. */
  invalid: Array<{ task: string; baseline: Extract<Baseline, 'invalid' | 'could_not_run'> }>;
  /**
   * Each skill an arm's team resources change, with how many of that arm's trials, and of the defaults arm's, loaded it;
   * record order. Absent `defaults`: the suite has no defaults arm.
   */
  skills: Array<{ arm: string; skill: string; change: SkillChanges['skills'][number]['change']; here: SkillLoads; defaults?: SkillLoads }>;
  /** A table per covered team resource an arm leaves out; absent when no task covers a path. */
  resources: ResourceEffect[];
  /** Whether a team scorer of the run judges skill routing, #1469's `teamai:routing:`. */
  routing: boolean;
  /** Each judge tool the record pins that is also an arm's tool, with the first such arm, when the arms vary the tool. */
  selfJudged: Array<{ tool: string; arm: string }>;
  /** Each judge tool the plan required that no driver of the run offered, with how many trials it left unscored. */
  unavailableJudges: Array<{ tool: string; trials: number }>;
}

/** Of the trials whose work ran: how many were seen to load a skill, how many were seen and did not, and how many went unseen. */
export interface SkillLoads {
  loaded: number;
  observed: number;
  unknown: number;
}

/** A table as the text of its cells. */
export interface TextTable {
  header: string[];
  rows: string[][];
}

/** What formatBenchmarkTable prints, as cells, so the dashboard shows the text a terminal and a CI job summary show. */
export interface BenchmarkCells {
  results: TextTable;
  usage: TextTable;
  matrix: TextTable;
  /** Absent when no suite or task scorer judged a trial. */
  scorers?: TextTable;
  /** Absent when no judge labelled a trial whose check failed. */
  calibration?: TextTable & { title: string };
  /** Absent when every task's baseline let its trials run. */
  invalid?: TextTable;
  /** Absent when no arm changes a team skill. */
  skills?: TextTable;
  /** Absent when no task covers a team repo path. One table's text per covered resource. */
  resources?: string[];
  /** Lines above the caption that qualify the tables, such as a judge that is also an arm's tool; absent when none does. */
  notes?: string[];
  caption: string;
}

/** The sentence under every table. */
const BENCHMARK_CAPTION = 'These results hold for these tasks, this run and this machine.';

const RESULT_COLUMNS = { passed: 'Passed', failed: 'Failed', error: 'Error', unscored: 'Unscored', not_run: 'Not run' } as const satisfies Record<TrialResult, string>;
const INVALID_REASONS = { invalid: 'invalid: check passes without changes', could_not_run: 'check could not run' } as const satisfies Record<BenchmarkTable['invalid'][number]['baseline'], string>;
const TOKEN_COMPONENTS = ['input', 'output'] as const;

/** What benchmarkTable reads: a benchmark record, whose trials carry what each prompt ran as. */
export interface BenchmarkTableInput {
  benchmark: BenchmarkRecord;
}

/** A trial, and what its prompt ran as. Absent `ranAs`: its prompt did not run, as teamai observes every prompt a driver reported. */
export interface ObservedTrial {
  trial: RecordedTrial;
  ranAs?: AgentObservation;
}

/** Each trial of `record`, in record order, with what its prompt ran as. */
export function observedTrials(record: BenchmarkTableInput): ObservedTrial[] {
  return record.benchmark.trials.map((trial) => (trial.agent ? { trial, ranAs: trial.agent } : { trial }));
}

/**
 * The usage of `trials`: medians of what their tools stated, and the cost of the trials whose prompt ran. A trial whose
 * passes did not all state its tokens or cost has only part of it, so it counts as one that stated none.
 */
export function usageOf(trials: readonly ObservedTrial[]): Omit<ArmUsage, 'arm'> {
  const cost = costTotal(agentCostsOf(trials));

  return definedFields<Omit<ArmUsage, 'arm'>>({
    tokens: { ...median(trials.flatMap(({ trial: { tokens } }) => (tokens?.complete && tokens.input !== undefined && tokens.output !== undefined ? [tokens.input + tokens.output] : []))), components: TOKEN_COMPONENTS },
    durationMs: median(trials.flatMap(({ trial: { durationMs } }) => (durationMs !== undefined ? [durationMs] : []))),
    cost,
    costPerPassedTrial: costPerPassedTrialOf(cost, trials.filter(({ trial }) => trial.result === 'passed').length),
  });
}

/** The cost each of `trials` whose prompt ran stated, undefined for one that stated none or only part of it. */
export function agentCostsOf(trials: readonly ObservedTrial[]): Array<RecordedTrial['cost']> {
  return trials.flatMap(({ trial, ranAs }) => (ranAs ? [trial.cost?.complete ? trial.cost : undefined] : []));
}

function costPerPassedTrialOf(cost: CostTotal, passed: number): CostPerPassedTrial | undefined {
  if (passed === 0) return undefined;

  switch (cost.kind) {
    case 'known':
    case 'incomplete':
      return { kind: cost.kind, amount: cost.amount / passed, unit: cost.unit };
    case 'mixed':
    case 'unknown':
      return undefined;
    default: {
      const unhandled: never = cost;

      return unhandled;
    }
  }
}

/**
 * How many of `arm`'s `trials` ran as something other than the arm, or were labelled by another judge than the plan's,
 * and how many could not be compared with them. A deviation outweighs a value that could not be compared.
 */
export function deviationsOf(arm: RecordedArm, trials: readonly ObservedTrial[]): Pick<ArmResults, 'deviations' | 'notVerified'> {
  const compared = trials.flatMap(({ trial, ranAs }) => {
    if (!ranAs) return [];
    const comparisons = new Set([trial.unenforced ? 'deviation' as const : compareAgent(arm, ranAs), ...(trial.verdicts ?? []).flatMap(({ asPlanned }) => asPlanned ?? [])]);

    return [comparisons.has('deviation') ? 'deviation' as const : comparisons.has('not_verified') ? 'not_verified' as const : 'match' as const];
  });

  return {
    deviations: compared.filter((comparison) => comparison === 'deviation').length,
    notVerified: compared.filter((comparison) => comparison === 'not_verified').length,
  };
}

export function benchmarkTable(record: BenchmarkTableInput): BenchmarkTable {
  const { arms, trials, tasks, scorers } = record.benchmark;
  const observed = observedTrials(record);
  // Two labels make the mean the pass rate again; a third, such as partial, is what it tells apart.
  const isGraded = scorers.some(({ name, labels }) => isCorrectnessScorer(name) && (labels?.length ?? 0) > 2);

  const results = arms.map((arm) => {
    const own = trials.filter((trial) => trial.arm === arm.name);
    const count = (result: TrialResult): number => own.filter((trial) => trial.result === result).length;
    const counts = { passed: count('passed'), failed: count('failed'), error: count('error'), unscored: count('unscored'), not_run: count('not_run') } satisfies Record<TrialResult, number>;

    return definedFields<ArmResults>({
      arm: arm.name, tool: arm.tool, model: arm.model || undefined, effort: arm.effort || undefined, source: arm.source, team: arm.team,
      role: arm.role, recall: arm.recall || undefined,
      planned: own.length, counts,
      stoppedByLimit: own.filter((trial) => trial.limit !== undefined).length,
      ...deviationsOf(arm, observed.filter(({ trial }) => trial.arm === arm.name)),
      ...passRateOf(own),
      correctnessScore: isGraded ? correctnessScoreOf(own) : undefined,
    });
  });

  const usage = arms.map(({ name }) => ({ arm: name, ...usageOf(observed.filter(({ trial }) => trial.arm === name)) }));

  return definedFields<BenchmarkTable>({
    invalid: tasks.flatMap(({ id, baseline }) => (baseline === 'invalid' || baseline === 'could_not_run' ? [{ task: id, baseline }] : [])),
    results,
    matrix: tasks.map(({ id }) => ({
      task: id,
      arms: arms.map(({ name }) => ({ arm: name, ...passRateOf(trials.filter((trial) => trial.task === id && trial.arm === name)) })),
    })),
    usage,
    against: againstOf(record.benchmark, results, usage),
    estimate: record.benchmark.estimate,
    scorers: scorerResultsOf(record.benchmark),
    calibration: calibrationOf(trials),
    skills: (record.benchmark.skillChanges ?? []).flatMap(({ arm, defaults, skills }) => skills.map(({ name, change }) => definedFields<BenchmarkTable['skills'][number]>({
      arm, skill: name, change, here: skillLoadsOf(trials, arm, name), defaults: defaults ? skillLoadsOf(trials, defaults, name) : undefined,
    }))),
    resources: resourceEffects(record), routing: record.benchmark.scorers.some(({ name }) => name.startsWith(ROUTING_PREFIX)),
    selfJudged: selfJudgedOf(record.benchmark),
    unavailableJudges: unavailableJudgesOf(record.benchmark),
  });
}

/**
 * Each arm of `record` but the reference, the defaults arm, else the first, against it: the paired difference over the
 * trials of one task and repetition `compareTrials` compares, and dominance by cost per passed trial and pass rate.
 */
function againstOf(record: BenchmarkRecord, results: readonly ArmResults[], usage: readonly ArmUsage[]): BenchmarkTable['against'] {
  const { arms, trials, tasks, defaultsArm } = record;
  const [first] = arms;

  if (first === undefined || arms.length < 2) return undefined;
  const reference = arms.find(({ name }) => name === defaultsArm) ?? first;
  const standingOf = (name: string): ArmStanding => ({ rate: results.find(({ arm }) => arm === name)?.passRate, cost: usage.find(({ arm }) => arm === name)?.costPerPassedTrial });

  return {
    reference: reference.name, isDefaultsArm: reference.name === defaultsArm,
    arms: arms.filter((arm) => arm !== reference).map(({ name }) => {
      const candidates = trials.filter((trial) => trial.arm === name).flatMap((to) => {
        const from = trials.find((trial) => trial.arm === reference.name && trial.task === to.task && trial.repetition === to.repetition);
        const comparison = from && compareTrials({ from, fromTasks: tasks, to, toTasks: tasks });

        return from && comparison ? [{ pair: { from: from.result === 'passed', to: to.result === 'passed' }, comparison }] : [];
      });

      const { compared, excluded } = splitPairs(candidates);
      const count = (test: (pair: { from: boolean; to: boolean }) => boolean): number => compared.filter(test).length;
      const dominance = dominanceOf({ mine: standingOf(name), theirs: standingOf(reference.name) });

      return definedFields<ArmAgainst>({
        arm: name,
        difference: compared.length > 0
          ? pairedDifference({ both: count((p) => p.from && p.to), toOnly: count((p) => p.to && !p.from), fromOnly: count((p) => p.from && !p.to), neither: count((p) => !p.from && !p.to) })
          : undefined,
        excluded: excluded.length > 0 ? excluded : undefined,
        dominance: dominance?.kind === 'neither' ? undefined : dominance,
      });
    }),
  };
}

/** An arm's pass rate and cost per passed trial, what dominance reads. */
export interface ArmStanding {
  rate?: PassRate;
  cost?: CostPerPassedTrial;
}

/**
 * Whether `mine` dominates `theirs`, is dominated by it, or neither: less per passed trial at a pass rate at least as
 * high. Undefined when either cost per passed trial is absent, incomplete or in another unit.
 */
export function dominanceOf({ mine, theirs }: { mine: ArmStanding; theirs: ArmStanding }): Dominance | undefined {
  if (mine.rate === undefined || theirs.rate === undefined || mine.cost?.kind !== 'known' || theirs.cost?.kind !== 'known') return undefined;

  if (mine.cost.unit !== theirs.cost.unit || theirs.cost.amount === 0) return undefined;
  const order = Math.sign(mine.rate.passed * theirs.rate.planned - theirs.rate.passed * mine.rate.planned);
  const passRate = order === 0 ? 'same' : order > 0 ? 'higher' : 'lower';
  const costRatio = mine.cost.amount / theirs.cost.amount;

  if (costRatio < 1 && order >= 0) return { kind: 'dominates', passRate, costRatio };

  return { kind: costRatio > 1 && order <= 0 ? 'dominated' : 'neither', passRate, costRatio };
}

function correctnessScoreOf(trials: RecordedTrial[]): NonNullable<ArmResults['correctnessScore']> {
  const scores = trials.flatMap(({ verdicts }) => (verdicts ?? []).flatMap(({ scorer, outcome }) => (isCorrectnessScorer(scorer) && outcome.kind === 'labelled' ? [outcome.score] : [])));

  return definedFields({ labelled: scores.length, mean: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined });
}

/** Each arm's verdicts of each scorer `record` pins but the correctness scorers, over its trials that ran and listed it. */
function scorerResultsOf({ arms, trials, scorers }: BenchmarkRecord): ArmScorerResults[] {
  const listed = scorers.map(({ name }) => name).filter((name) => !isCorrectnessScorer(name));

  return arms.flatMap(({ name: arm }) => listed.flatMap((scorer) => {
    const verdicts = trials.flatMap((trial) => (trial.arm === arm && trial.result !== 'not_run' ? (trial.verdicts ?? []).filter((one) => one.scorer === scorer) : []));

    if (verdicts.length === 0) return [];
    const labelled = verdicts.flatMap(({ outcome, decider }) => (outcome.kind === 'labelled' ? [{ passed: outcome.passed, decider }] : []));
    const passed = labelled.filter((label) => label.passed).length;
    const batches = new Set(labelled.flatMap(({ decider }) => (decider?.by === 'judge' ? [decider.batched] : [])));

    return [definedFields<ArmScorerResults>({
      arm, scorer, passed, labelled: labelled.length, unscored: verdicts.length - labelled.length,
      interval: labelled.length > 0 ? wilson({ passed, planned: labelled.length }) : undefined,
      batched: batches.size === 0 ? undefined : batches.size > 1 ? 'mixed' : batches.has(true) ? 'yes' : 'no',
    })];
  }));
}

/** The judges of `trials`' calibrations, by tool, model and effort, each over the trials it calibrated. */
export function calibrationOf(trials: readonly RecordedTrial[]): JudgeCalibration[] {
  const byJudge = new Map<string, { judge: JudgeCalibration['judge']; passed: boolean[] }>();

  for (const { calibration } of trials) {
    if (!calibration) continue;
    const { tool, model, effort } = calibration.decider;
    const key = JSON.stringify([tool, model ?? null, effort ?? null]);
    const kept = byJudge.get(key) ?? { judge: definedFields<JudgeCalibration['judge']>({ tool, model, effort }), passed: [] };
    kept.passed.push(calibration.passed);
    byJudge.set(key, kept);
  }

  return [...byJudge.values()].map(({ judge, passed }) => {
    const passing = passed.filter(Boolean).length;

    return { judge, judged: passed.length, passing, interval: wilson({ passed: passing, planned: passed.length }) };
  });
}

/** Each judge tool `record` pins that no driver of its run offered, with how many trials it left unscored for that. */
function unavailableJudgesOf({ trials, judges = {} }: BenchmarkRecord): BenchmarkTable['unavailableJudges'] {
  const unscored = new Map<string, number>();

  for (const { verdicts = [] } of trials) {
    const tools = new Set(verdicts.flatMap(({ scorer, outcome }) => (outcome.kind === 'unscored' && outcome.because === 'judge_tool_unavailable' ? judges[scorer]?.tool ?? [] : [])));

    for (const tool of tools) unscored.set(tool, (unscored.get(tool) ?? 0) + 1);
  }

  return [...unscored].map(([tool, count]) => ({ tool, trials: count }));
}

/** Each judge tool `record` pins that is also an arm's tool, with the first such arm, when its arms vary the tool. */
export function selfJudgedOf({ arms, judges = {} }: BenchmarkRecord): BenchmarkTable['selfJudged'] {
  if (new Set(arms.map(({ tool }) => tool)).size < 2) return [];

  return [...new Set(Object.values(judges).map(({ tool }) => tool))].flatMap((tool) => {
    const arm = arms.find((one) => one.tool === tool);

    return arm ? [{ tool, arm: arm.name }] : [];
  });
}

/** How `arm`'s trials whose work ran loaded `skill`: a trial with no `used` went unseen. */
function skillLoadsOf(trials: readonly RecordedTrial[], arm: string, skill: string): SkillLoads {
  const seen = trials.flatMap(({ arm: ran, agent, used }) => (ran === arm && agent ? [used ? used[skill] ?? 'not_loaded' : 'unknown'] : []));

  return { loaded: seen.filter((load) => load === 'loaded').length, observed: seen.filter((load) => load !== 'unknown').length, unknown: seen.filter((load) => load === 'unknown').length };
}

/**
 * The results, the usage, the task by arm matrix, the pass rate per scorer, then the invalid tasks. A median or a total
 * says in parentheses how many values it used.
 */
export function benchmarkCells(table: BenchmarkTable): BenchmarkCells {
  // Every arm on the pulled revision, as most suites run: the column would repeat one commit on every row.
  const namesTeam = table.results.some(({ team }) => team.kind !== 'pulled');
  // Only a suite that compares roles: an arm without one runs with the member's own roles.
  const namesRole = table.results.some(({ role }) => role !== undefined);
  // Only a suite that runs some arm with recall: the column says which arms it was on.
  const namesRecall = table.results.some(({ recall }) => recall !== undefined);
  const namesScore = table.results.some(({ correctnessScore }) => correctnessScore !== undefined);
  // Only an estimate from an earlier run: without one there is no cost to put beside the run's.
  const estimated = table.estimate?.basis === undefined ? undefined : table.estimate.arms ?? [];

  return definedFields<BenchmarkCells>({
    results: {
      header: ['Arm', 'Tool', 'Model (source)', ...(namesTeam ? ['Team'] : []), ...(namesRole ? ['Role'] : []), ...(namesRecall ? ['Recall'] : []), 'Planned', ...TRIAL_RESULTS.map((result) => RESULT_COLUMNS[result]), 'Stopped by a limit', 'Deviations', 'Not verified', 'Pass rate', ...(namesScore ? ['Mean correctness score'] : [])],
      rows: table.results.map((arm) => [
        arm.arm, arm.tool, `${arm.model ? [arm.model, ...(arm.effort ? [arm.effort] : [])].join(' ') : 'tool default'} (${arm.source})`, ...(namesTeam ? [formatTeam(arm.team)] : []),
        ...(namesRole ? [arm.role ?? "member's roles"] : []), ...(namesRecall ? [arm.recall ? 'on' : 'off'] : []), String(arm.planned),
        ...TRIAL_RESULTS.map((result) => String(arm.counts[result])), String(arm.stoppedByLimit), String(arm.deviations), String(arm.notVerified), formatPassRate(arm.passRate),
        ...(namesScore ? [arm.correctnessScore?.mean === undefined ? '-' : arm.correctnessScore.mean.toFixed(2)] : []),
      ]),
    },
    usage: {
      header: [
        'Arm', `Median tokens (${TOKEN_COMPONENTS.join(' + ')})`, 'Median duration', 'Cost', ...(estimated ? ['Estimated'] : []), 'Cost per passed trial',
        ...(table.against ? [`Against ${table.against.reference} (${table.against.isDefaultsArm ? 'defaults arm' : 'first arm'})`] : []),
      ],
      rows: table.usage.map(({ arm, tokens, durationMs, cost, costPerPassedTrial }) => [
        arm, formatMedian(tokens, (value) => String(Math.round(value))), formatMedian(durationMs, (value) => `${(value / 1000).toFixed(1)} s`), formatCost(cost),
        ...(estimated ? [formatArmEstimate(estimated.find((one) => one.arm === arm))] : []),
        costPerPassedTrial ? `${formatAmount(costPerPassedTrial.amount)} ${costPerPassedTrial.unit}${costPerPassedTrial.kind === 'incomplete' ? ', incomplete' : ''}` : '—',
        ...(table.against ? [formatAgainst(table.against.arms.find((one) => one.arm === arm))] : []),
      ]),
    },
    matrix: {
      header: ['Task', ...table.results.map(({ arm }) => arm)],
      rows: table.matrix.map(({ task, arms }) => [task, ...arms.map(({ passRate }) => formatPassRate(passRate))]),
    },
    scorers: table.scorers.length > 0 ? {
      header: ['Arm', 'Scorer', 'Passed', 'Labelled', 'Unscored', 'Pass rate', '95% interval', 'Batched'],
      rows: table.scorers.map(({ arm, scorer, passed, labelled, unscored, interval, batched }) => [
        arm, scorer, String(passed), String(labelled), String(unscored), formatPassRate(labelled > 0 ? { passed, planned: labelled } : undefined),
        interval ? formatInterval(interval) : '-', batched ?? '-',
      ]),
    } : undefined,
    calibration: table.calibration.length > 0 ? {
      title: 'Judge calibration · teamai:correctness',
      header: ['Judge', 'Judged with a failed check', 'Labelled passing', 'False pass rate', '95% interval'],
      rows: table.calibration.map(({ judge: { tool, model, effort }, judged, passing, interval }) => [
        [tool, model, effort].filter((part) => part !== undefined).join(' '), String(judged), String(passing), `${Math.round((passing / judged) * 100)}%`, formatInterval(interval),
      ]),
    } : undefined,
    invalid: table.invalid.length > 0 ? { header: ['Task', 'Baseline'], rows: table.invalid.map(({ task, baseline }) => [task, INVALID_REASONS[baseline]]) } : undefined,
    skills: table.skills.length > 0 ? {
      header: ['Arm', 'Skill', 'Change', 'Loaded in this arm', 'Loaded in the defaults arm'],
      rows: table.skills.map(({ arm, skill, change, here, defaults }) => [arm, skill, change, formatSkillLoads(here), defaults ? formatSkillLoads(defaults) : '-']),
    } : undefined,
    resources: table.resources.length > 0 ? table.resources.map(formatResourceEffect) : undefined,
    notes: notesOf(table),
    caption: BENCHMARK_CAPTION,
  });
}

/**
 * `dominates: same pass rate, 56% cheaper per passed trial; 0 pp (-30 to +30, not separated)`: an arm against the
 * reference, blank on the reference's own row.
 */
function formatAgainst(against: ArmAgainst | undefined): string {
  if (against === undefined) return '';
  const { dominance, difference, excluded } = against;
  const change = dominance && (dominance.costRatio < 1 ? `${Math.round((1 - dominance.costRatio) * 100)}% cheaper` : `${Math.round((dominance.costRatio - 1) * 100)}% more expensive`);

  const parts = [
    dominance && `${dominance.kind}: ${dominance.passRate} pass rate, ${change} per passed trial`,
    difference && `${formatDifference(difference)} (${formatBound(difference.low)} to ${formatBound(difference.high)}${difference.low > 0 || difference.high < 0 ? '' : ', not separated'})`,
    excluded && formatExcluded(excluded),
  ].filter((part) => part !== undefined);

  return parts.length > 0 ? parts.join('; ') : '-';
}

/** A 95% interval of a rate: `11% to 60%`. */
function formatInterval({ low, high }: { low: number; high: number }): string {
  return `${Math.round(low * 100)}% to ${Math.round(high * 100)}%`;
}

/** The lines under the tables that qualify them: a judge that is also an arm's tool, and one no driver offered. */
function notesOf({ selfJudged, unavailableJudges }: BenchmarkTable): string[] | undefined {
  const notes = [
    ...selfJudged.map(({ tool, arm }) => `Judge ${tool} is also arm ${arm}'s tool; set tool in the scorer to judge with another.`),
    ...unavailableJudges.map(({ tool, trials }) => `No driver of the run offered judge ${tool}, so ${trials === 1 ? '1 trial' : `${trials} trials`} went unscored; drive the run where ${tool} is installed, or set tool in the scorer.`),
  ];

  return notes.length > 0 ? notes : undefined;
}

/**
 * One resource effect table as text, led by its title line: the path, the arm that runs without it, the arm that leaves
 * nothing out, and the tool. `not separated` names a 95% interval that crosses zero: more tasks or repetitions, not a
 * failed run.
 */
export function formatResourceEffect(effect: ResourceEffect): string {
  const title = ['Resource effect', effect.path, effect.without !== undefined && effect.has !== undefined ? `${effect.without} -> ${effect.has}` : effect.has, effect.tool].filter((part) => part !== undefined).join(' · ');

  const rows = effect.rows.map((row) => [
    row.task, row.covers ? 'yes' : 'no', formatPassRate(row.without), formatPassRate(row.with),
    row.loaded === undefined ? 'not observed' : formatLoads(row.loaded),
  ]);

  const split = (label: string, line: ResourceSplit | undefined): string | undefined => (line === undefined ? undefined : [
    label, formatDifference(line.difference), `${line.from.passed}/${line.from.planned} -> ${line.to.passed}/${line.to.planned}`,
    line.separated ? `95% ${formatBound(line.difference.low)} to ${formatBound(line.difference.high)} pp` : 'not separated',
  ].join('   '));

  const compared = effect.rows.reduce((sum, row) => sum + (row.without?.planned ?? 0), 0);

  const lines = [
    [['task', 'covers', 'passed without', 'passed with', 'loaded with'].join('   '), ...rows.map((cells) => cells.join('   '))].join('\n'),
    effect.excluded === undefined ? undefined : `${compared} comparable ${compared === 1 ? 'pair' : 'pairs'}; ${formatExcluded(effect.excluded)}`,
    [split('tasks that cover it', effect.coversDifference), split('other tasks', effect.othersDifference)].filter((line) => line !== undefined).join('\n'),
    effect.skill !== undefined
      ? `passed when loaded ${effect.passedWhenLoaded ? `${effect.passedWhenLoaded.passed}/${effect.passedWhenLoaded.planned}` : '-'} · passed when not loaded ${effect.passedWhenNotLoaded ? `${effect.passedWhenNotLoaded.passed}/${effect.passedWhenNotLoaded.planned}` : '-'}`
      : undefined,
  ];

  return [title, ...lines.filter((line) => line !== undefined && line !== '')].join('\n\n');
}

/**
 * `2/3 fit, 1 missed`-style: the loads over the trials, then every routing value the trials have. The loaded value
 * (`fit` or `extra`, which the loads count) comes first, then the others counted, in `ROUTING_VALUES` order; `unknown`
 * alone when no trial's tool reported its loads.
 */
function formatLoads({ loaded, planned, byValue }: NonNullable<ResourceEffectRow['loaded']>): string {
  const isLoaded = (value: RoutingValue): boolean => value === 'fit' || value === 'extra';
  const present = ROUTING_VALUES.filter((value) => (byValue[value] ?? 0) > 0);
  const parts = [...present.filter(isLoaded), ...present.flatMap((value) => (isLoaded(value) ? [] : [`${byValue[value]} ${value}`]))];

  return `${loaded}/${planned} ${present.every((value) => value === 'unknown') ? 'unknown' : parts.join(', ')}`;
}

/** `+33 pp`, `-8 pp`, `0 pp`: the difference in percentage points. */
function formatDifference({ value }: { value: number }): string {
  const points = Math.round(value * 100);

  return `${points > 0 ? '+' : ''}${points} pp`;
}

/** A bound of an interval in percentage points, signed: `+4`, `-2`. */
function formatBound(bound: number): string {
  return `${bound >= 0 ? '+' : ''}${Math.round(bound * 100)}`;
}

/** benchmarkCells as Markdown pipe tables, so the same text reads in a terminal and renders in a CI job summary. */
export function formatBenchmarkTable(table: BenchmarkTable): string {
  const { results, usage, matrix, scorers, calibration, invalid, skills, resources, notes, caption } = benchmarkCells(table);
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  const markdown = ({ header, rows }: TextTable): string => [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');

  return [
    ...[results, usage, matrix, ...(scorers ? [scorers] : [])].map(markdown), ...(calibration ? [`${calibration.title}\n\n${markdown(calibration)}`] : []),
    ...[...(invalid ? [invalid] : []), ...(skills ? [skills] : [])].map(markdown), ...(resources ?? []), ...(notes ?? []), caption,
  ].join('\n\n');
}

/** `1/2` loaded of the trials seen, `1/2, 1 unknown` with some unseen, `unknown (3)` with none seen. */
function formatSkillLoads({ loaded, observed, unknown }: SkillLoads): string {
  if (observed === 0) return `unknown (${unknown})`;

  return unknown > 0 ? `${loaded}/${observed}, ${unknown} unknown` : `${loaded}/${observed}`;
}

function passRateOf(trials: readonly RecordedTrial[]): { passRate?: PassRate } {
  return trials.length > 0 ? { passRate: { passed: trials.filter(({ result }) => result === 'passed').length, planned: trials.length } } : {};
}

/** An arm's team resources: `pulled 62432de`, `main 1a2b3c4`, `62432de without rules/commits.md, skills/fixer` or `none`. */
function formatTeam(team: RecordedArm['team']): string {
  switch (team.kind) {
    case 'pulled':
      return `pulled ${team.revision.slice(0, 7)}`;
    case 'ref':
      return `${team.ref} ${team.revision.slice(0, 7)}`;
    case 'without':
      return `${team.revision.slice(0, 7)} without ${team.paths.join(', ')}`;
    case 'none':
      return 'none';
    default: {
      const unhandled: never = team;

      return unhandled;
    }
  }
}

/** Divides before it multiplies, as the documented `jq` command does, so both round an exact half the same way. */
function formatPassRate(rate: PassRate | undefined): string {
  return rate ? `${Math.round((rate.passed / rate.planned) * 100)}% (${rate.passed}/${rate.planned})` : '-';
}

function median(values: readonly number[]): Median {
  const sorted = [...values].sort((left, right) => left - right);
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];
  const upper = sorted[Math.floor(sorted.length / 2)];

  return lower === undefined || upper === undefined ? { used: 0 } : { value: (lower + upper) / 2, used: sorted.length };
}

/** The sum of `parts` in their one unit, `incomplete` with how many are undefined; `mixed` in more than one unit. */
export function costTotal(parts: ReadonlyArray<RecordedTrial['cost']>): CostTotal {
  const known = parts.flatMap((part) => (part ? [part] : []));
  const units = [...new Set(known.map(({ unit }) => unit))].sort();
  const [unit, ...others] = units;

  if (unit === undefined) return { kind: 'unknown' };

  if (others.length > 0) return { kind: 'mixed', units };
  const amount = known.reduce((sum, part) => sum + part.amount, 0);
  const unknown = parts.length - known.length;

  return unknown > 0 ? { kind: 'incomplete', amount, unit, used: known.length, unknown } : { kind: 'known', amount, unit, used: known.length };
}

function formatMedian({ value, used }: Median, format: (value: number) => string): string {
  return value === undefined ? 'unknown (0)' : `${format(value)} (${used})`;
}

/** An arm's estimated total, `13.1–16.8 USD`, or `unknown`. */
function formatArmEstimate(estimate: NonNullable<BenchmarkEstimate['arms']>[number] | undefined): string {
  return estimate !== undefined && 'total' in estimate ? formatCostRange(estimate.total) : 'unknown';
}

/** An estimated amount, to three significant digits: `0.82`, `13.1`, `41.2`. */
export function formatEstimateAmount(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/** `13.1–16.8 USD`: an estimated cost's range. */
export function formatCostRange({ low, high, unit }: Pick<CostRange, 'low' | 'high' | 'unit'>): string {
  return `${formatEstimateAmount(low)}–${formatEstimateAmount(high)} ${unit}`;
}

/** An amount to four decimals at most: `0.455`, `4.1`. */
function formatAmount(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

function formatCost(cost: CostTotal): string {
  switch (cost.kind) {
    case 'known':
      return `${formatAmount(cost.amount)} ${cost.unit} (${cost.used})`;
    case 'incomplete':
      return `${formatAmount(cost.amount)} ${cost.unit} (${cost.used}), incomplete: ${cost.unknown} unknown`;
    case 'mixed':
      return `mixed units: ${cost.units.join(', ')}`;
    case 'unknown':
      return 'unknown (0)';
    default: {
      const unhandled: never = cost;

      return unhandled;
    }
  }
}

/** The normal quantile of a two-sided 95% interval. */
const Z = 1.96;

/** The 95% Wilson score interval of `passed` out of `planned`, planned above 0: a benchmark arm's, and a Scorers group's. */
export function wilson({ passed, planned }: PassRate) {
  const p = passed / planned;
  const z2 = Z * Z;
  const denominator = 1 + z2 / planned;
  const center = (p + z2 / (2 * planned)) / denominator;
  const margin = (Z * Math.sqrt((p * (1 - p)) / planned + z2 / (4 * planned * planned))) / denominator;

  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** The 95% interval of a difference over paired trials: its value, then its lower and upper bound. */
export interface PairedInterval {
  value: number;
  low: number;
  high: number;
}

/**
 * The 95% interval of `to - from` over paired trials (Newcombe 1998, method 10): `both` passed on both arms, `toOnly`
 * only on to, `fromOnly` only on from, `neither` on neither.
 */
export function pairedDifference({ both, toOnly, fromOnly, neither }: { both: number; toOnly: number; fromOnly: number; neither: number }): PairedInterval {
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


/** A covered skill's routing value on a trial, #1469's terms read from the task instead of a judge. */
export const ROUTING_VALUES = ['fit', 'idle', 'extra', 'missed', 'unknown'] as const;

export type RoutingValue = (typeof ROUTING_VALUES)[number];

/** One line of a resource effect's split: the paired pass-rate difference over a set of the pair's tasks. */
export interface ResourceSplit {
  difference: { value: number; low: number; high: number };
  from: PassRate;
  to: PassRate;
  /** Whether the 95% interval leaves zero: the difference reads as a number, not `not separated`. */
  separated: boolean;
}

/** One row of a resource effect table: one task, both arms' pass rates over their paired trials, and the loads with the resource. */
export interface ResourceEffectRow {
  task: string;
  covers: boolean;
  /** The arm that runs without the path; absent, with the rates, when no arm leaves it out. */
  without?: PassRate;
  with?: PassRate;
  /**
   * How many of the `with` arm's trials of this task loaded the skill, each trial counted under its routing value.
   * Undefined for a path that is not a skill: teamai observes no load for it.
   */
  loaded?: { loaded: number; planned: number; byValue: Partial<Record<RoutingValue, number>> };
}

/** A table per covered team resource: the arm that runs without exactly it against the arm that leaves nothing out. */
export interface ResourceEffect {
  /** The covered team repo path. */
  path: string;
  /** The arm that runs without exactly this path; absent when no arm leaves it out. */
  without?: string;
  /** The arm that differs from `without` only by leaving nothing out: same tool, model, workflow and team revision. */
  has?: string;
  tool: string;
  /** The skill's bare name, when the path is under `skills/`: the key of a trial's `used` and `routing`. */
  skill?: string;
  /** For a skill, the name of its routing question on real sessions: `teamai:routing:[<namespace>:]<skill>`. */
  routingScorer?: string;
  /** One row per task, in the record's task order. */
  rows: ResourceEffectRow[];
  /** The difference over the tasks that cover the path, and over the others; absent when no arm leaves it out. */
  coversDifference?: ResourceSplit;
  othersDifference?: ResourceSplit;
  /** For a skill, over the `with` arm's trials: how many passed when it loaded and when it did not. */
  passedWhenLoaded?: PassRate;
  passedWhenNotLoaded?: PassRate;
  /** The pairs `compareTrials` left out of the rows and splits, by why; absent when none was. */
  excluded?: ExcludedPairs[];
}

/**
 * A table per path the record's tasks cover, in first-covered order: for each arm whose `without` is exactly that path,
 * against the arm that differs from it only by leaving nothing out. An arm that leaves out more than one path compares
 * as itself, so it gets no table here. Pure over the record, so a published record answers without a rerun.
 */
export function resourceEffects(record: BenchmarkTableInput): ResourceEffect[] {
  const { arms, tasks, trials } = record.benchmark;
  const paths = [...new Map(tasks.flatMap(({ covers }) => (covers ?? []).map((listed) => [listed, listed]))).keys()];

  const nameOf = (path: string): string | undefined => {
    const entry = tasks.flatMap(({ covers, coversSkills }) => (covers ?? []).map((covered, index) => [covered, coversSkills?.[index] ?? null] as const)).find(([covered]) => covered === path);

    return entry === undefined ? undefined : entry[1] ?? undefined;
  };

  const effects: ResourceEffect[] = [];

  paths.forEach((path) => {
    const skill = nameOf(path);
    // The arms whose clone did not receive the path, as plan read it; none on a record from before plan kept them.
    const withheld = new Set(tasks.flatMap(({ covers, coversWithheldFrom }) => (covers ?? []).flatMap((covered, index) => (covered === path ? coversWithheldFrom?.[index] ?? [] : []))));
    // One table per arm that runs without exactly this path; a covered path no arm leaves out still shows its rows.
    const withoutArms = arms.filter(({ team }) => team.kind === 'without' && team.paths.length === 1 && team.paths[0] === path);

    for (const without of withoutArms.length > 0 ? withoutArms : [undefined]) {
      // The arm that leaves nothing out: the pulled arm that differs from `without` only by that, or, when no arm
      // leaves the path out, the first pulled arm that receives the path, else the first other arm with team resources that
      // does (on another ref, or without other paths), so the rows and loads still show.
      const receives = (arm: (typeof arms)[number]): boolean => !withheld.has(arm.name);

      const has = without === undefined
        ? arms.find((arm) => arm.team.kind === 'pulled' && receives(arm)) ?? arms.find((arm) => arm.team.kind !== 'none' && receives(arm))
        : arms.find((arm) => arm !== without && arm.tool === without.tool && (arm.model ?? undefined) === (without.model ?? undefined)
          && (arm.effort ?? undefined) === (without.effort ?? undefined) && (arm.role ?? undefined) === (without.role ?? undefined)
          && (arm.workflow?.sourceHash ?? undefined) === (without.workflow?.sourceHash ?? undefined) && arm.team.kind === 'pulled');

      const own = (arm: string | undefined, task: string): RecordedTrial[] => (arm === undefined ? [] : trials.filter((trial) => trial.arm === arm && trial.task === task));

      // The pair's trials of one task, paired by repetition; a trial whose pair did not run counts in no pair, and a
      // pair compareTrials excludes counts only in `excluded`.
      const candidates = (task: string) => {
        const to = new Map(own(has?.name, task).map((trial) => [trial.repetition, trial]));

        return own(without?.name, task).flatMap((trial) => {
          const other = to.get(trial.repetition);
          const comparison = other && compareTrials({ from: trial, fromTasks: tasks, to: other, toTasks: tasks });

          // SAFETY: `other` comes from the same `trials` array, so the pair is two of its entries in repetition order.
          return other !== undefined && comparison ? [{ pair: [trial, other] as [RecordedTrial, RecordedTrial], comparison }] : [];
        });
      };

      const paired = (task: string): Array<[RecordedTrial, RecordedTrial]> => splitPairs(candidates(task)).compared;
      const { excluded } = splitPairs(tasks.flatMap(({ id }) => candidates(id)));

      const rows: ResourceEffectRow[] = tasks.flatMap(({ id, covers }): ResourceEffectRow[] => {
        const covered = covers?.includes(path) ?? false;
        const pair = paired(id);

        const rates = pair.length > 0 && without !== undefined && has !== undefined
          ? {
            without: { passed: pair.filter(([one]) => one.result === 'passed').length, planned: pair.length },
            with: { passed: pair.filter(([, to]) => to.result === 'passed').length, planned: pair.length },
          }
          : { without: undefined, with: passRateOf(own(has?.name, id)).passRate } as const;

        const row: ResourceEffectRow = { task: id, covers: covered, ...rates, loaded: skill === undefined || has === undefined ? undefined : routingLoads(own(has.name, id), skill) };

        return row.without !== undefined || row.with !== undefined ? [row] : [];
      });

      const split = (covered: boolean): ResourceSplit | undefined => {
        if (without === undefined || has === undefined) return undefined;

        const pairs = tasks.filter(({ covers }) => (covers?.includes(path) ?? false) === covered).flatMap(({ id }) => paired(id));

        if (pairs.length === 0) return undefined;

        const difference = pairedDifference({
          both: pairs.filter(([one, to]) => one.result === 'passed' && to.result === 'passed').length,
          toOnly: pairs.filter(([one, to]) => one.result !== 'passed' && to.result === 'passed').length,
          fromOnly: pairs.filter(([one, to]) => one.result === 'passed' && to.result !== 'passed').length,
          neither: pairs.filter(([one, to]) => one.result !== 'passed' && to.result !== 'passed').length,
        });

        return {
          difference, separated: difference.low > 0 || difference.high < 0,
          from: { passed: pairs.filter(([one]) => one.result === 'passed').length, planned: pairs.length },
          to: { passed: pairs.filter(([, to]) => to.result === 'passed').length, planned: pairs.length },
        };
      };

      // A skill's pass rates on the arm that has it, over its trials of every task, by whether they loaded it.
      const whenLoaded = (loaded: boolean): PassRate | undefined => {
        if (skill === undefined || has === undefined) return undefined;

        const ofArm = trials.filter((trial) => trial.arm === has.name && trial.routing?.[skill] !== undefined
          && (loaded ? ['fit', 'extra'] : ['missed', 'idle']).includes(trial.routing[skill]));

        return ofArm.length > 0 ? { passed: ofArm.filter((trial) => trial.result === 'passed').length, planned: ofArm.length } : undefined;
      };

      const effect = definedFields<ResourceEffect>({
        path, without: without?.name, has: has?.name, tool: (without ?? has)?.tool ?? '', skill, routingScorer: skill === undefined ? undefined : routingScorerName({ name: skill, ...skillNamespaceOf(path) }),
        rows, coversDifference: split(true), othersDifference: split(false),
        passedWhenLoaded: whenLoaded(true), passedWhenNotLoaded: whenLoaded(false),
        excluded: excluded.length > 0 ? excluded : undefined,
      });

      effects.push(...effect.rows.length > 0 ? [effect] : []);
    }
  });

  return effects;
}

/** The skills namespace of a covered skill directory: none for `skills/<name>`, `<namespace>` for `skills/<namespace>/<name>`. */
function skillNamespaceOf(covered: string): { namespace?: string } {
  const parent = covered.split('/').slice(1, -1);

  return parent.length === 1 ? { namespace: parent[0] } : {};
}

/** How the `with` arm's trials of one task loaded `skill`, each counted under its routing value. */
function routingLoads(trials: readonly RecordedTrial[], skill: string): ResourceEffectRow['loaded'] {
  const values = trials.map((trial) => trial.routing?.[skill]);

  return {
    loaded: values.filter((value) => value === 'fit' || value === 'extra').length,
    planned: values.length,
    byValue: Object.fromEntries([...new Set(values.filter((value) => value !== undefined))].map((value) => [value, values.filter((one) => one === value).length])),
  };
}
