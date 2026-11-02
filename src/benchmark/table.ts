/**
 * The results and usage tables and the task by arm matrix: one pure function over a benchmark record, which
 * `teamai benchmark report` prints and the dashboard shows. It reads the record, not the run, so it works on a
 * published record after the suite left the cache.
 */
import type { AgentObservation } from '../agent-observation.js';
import { compareAgent } from './agent-match.js';
import { TRIAL_RESULTS, type Baseline, type BenchmarkRecord, type TrialResult } from './result.js';
import type { SkillChanges } from './terms.js';

type RecordedArm = BenchmarkRecord['arms'][number];
type RecordedTrial = BenchmarkRecord['trials'][number];

export interface ArmResults extends Pick<RecordedArm, 'tool' | 'model' | 'effort' | 'source' | 'team'> {
  arm: string;
  planned: number;
  counts: Record<TrialResult, number>;
  /** Trials whose prompt a limit of the suite's `trial` ended; their check or judge still decided them. In `planned`. */
  stoppedByLimit: number;
  /**
   * Trials whose prompt ran as something other than the arm: another tool, team revision, or concrete model, or without a
   * limit of the suite's `trial` its driver could not enforce. In `planned`.
   */
  deviations: number;
  /** Trials whose prompt ran, but whose record lacks a value the comparison needs, such as the model the tool reported. */
  notVerified: number;
  /** Absent with no planned trials. */
  passRate?: PassRate;
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
}

export interface BenchmarkTable {
  results: ArmResults[];
  usage: ArmUsage[];
  /** Each task's pass rate on each arm, tasks and arms in record order; a cell with no planned trials has no rate. */
  matrix: Array<{ task: string; arms: Array<{ arm: string; passRate?: PassRate }> }>;
  /** The tasks whose check, tried on the starting commit, did not fail there as the task expects: none of their trials ran. */
  invalid: Array<{ task: string; baseline: Extract<Baseline, 'invalid' | 'could_not_run'> }>;
  /**
   * Each skill an arm's team assets change, with how many of that arm's trials, and of the defaults arm's, loaded it;
   * record order. Absent `defaults`: the suite has no defaults arm.
   */
  skills: Array<{ arm: string; skill: string; change: SkillChanges['skills'][number]['change']; here: SkillLoads; defaults?: SkillLoads }>;
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
  /** Absent when every task's baseline let its trials run. */
  invalid?: TextTable;
  /** Absent when no arm changes a team skill. */
  skills?: TextTable;
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

/** The usage of `trials`: medians of what their tools stated, and the cost of the trials whose prompt ran. */
export function usageOf(trials: readonly ObservedTrial[]): Omit<ArmUsage, 'arm'> {
  return {
    tokens: { ...median(trials.flatMap(({ trial: { tokens } }) => (tokens?.input !== undefined && tokens.output !== undefined ? [tokens.input + tokens.output] : []))), components: TOKEN_COMPONENTS },
    durationMs: median(trials.flatMap(({ trial: { durationMs } }) => (durationMs !== undefined ? [durationMs] : []))),
    cost: costTotal(trials.flatMap(({ trial, ranAs }) => (ranAs ? [trial.cost] : []))),
  };
}

/** How many of `arm`'s `trials` ran as something other than the arm, and how many could not be compared with it. */
export function deviationsOf(arm: RecordedArm, trials: readonly ObservedTrial[]): Pick<ArmResults, 'deviations' | 'notVerified'> {
  const compared = trials.flatMap(({ trial, ranAs }) => (ranAs ? [trial.unenforced ? 'deviation' as const : compareAgent(arm, ranAs)] : []));
  return {
    deviations: compared.filter((comparison) => comparison === 'deviation').length,
    notVerified: compared.filter((comparison) => comparison === 'not_verified').length,
  };
}

export function benchmarkTable(record: BenchmarkTableInput): BenchmarkTable {
  const { arms, trials, tasks } = record.benchmark;
  const observed = observedTrials(record);
  return {
    invalid: tasks.flatMap(({ id, baseline }) => (baseline === 'invalid' || baseline === 'could_not_run' ? [{ task: id, baseline }] : [])),
    results: arms.map((arm) => {
      const own = trials.filter((trial) => trial.arm === arm.name);
      const count = (result: TrialResult): number => own.filter((trial) => trial.result === result).length;
      const counts = { passed: count('passed'), failed: count('failed'), error: count('error'), unscored: count('unscored'), not_run: count('not_run') } satisfies Record<TrialResult, number>;
      return {
        arm: arm.name, tool: arm.tool, ...(arm.model ? { model: arm.model } : {}), ...(arm.effort ? { effort: arm.effort } : {}), source: arm.source, team: arm.team,
        planned: own.length, counts,
        stoppedByLimit: own.filter((trial) => trial.limit !== undefined).length,
        ...deviationsOf(arm, observed.filter(({ trial }) => trial.arm === arm.name)),
        ...passRateOf(own),
      };
    }),
    matrix: tasks.map(({ id }) => ({
      task: id,
      arms: arms.map(({ name }) => ({ arm: name, ...passRateOf(trials.filter((trial) => trial.task === id && trial.arm === name)) })),
    })),
    usage: arms.map(({ name }) => ({ arm: name, ...usageOf(observed.filter(({ trial }) => trial.arm === name)) })),
    skills: (record.benchmark.skillChanges ?? []).flatMap(({ arm, defaults, skills }) => skills.map(({ name, change }) => ({
      arm, skill: name, change, here: skillLoadsOf(trials, arm, name), ...(defaults ? { defaults: skillLoadsOf(trials, defaults, name) } : {}),
    }))),
  };
}

/** How `arm`'s trials whose work ran loaded `skill`: a trial with no `used` went unseen. */
function skillLoadsOf(trials: readonly RecordedTrial[], arm: string, skill: string): SkillLoads {
  const seen = trials.filter((trial) => trial.arm === arm && trial.agent).map(({ used }) => (used ? used[skill] ?? 'not_loaded' : 'unknown'));
  return { loaded: seen.filter((load) => load === 'loaded').length, observed: seen.filter((load) => load !== 'unknown').length, unknown: seen.filter((load) => load === 'unknown').length };
}

/** The results, the usage, the task by arm matrix, then the invalid tasks. A median or a total says in parentheses how many values it used. */
export function benchmarkCells(table: BenchmarkTable): BenchmarkCells {
  // Every arm on the pulled revision, as most suites run: the column would repeat one commit on every row.
  const namesTeam = table.results.some(({ team }) => team.kind !== 'pulled');
  return {
    results: {
      header: ['Arm', 'Tool', 'Model (source)', ...(namesTeam ? ['Team'] : []), 'Planned', ...TRIAL_RESULTS.map((result) => RESULT_COLUMNS[result]), 'Stopped by a limit', 'Deviations', 'Not verified', 'Pass rate'],
      rows: table.results.map((arm) => [
        arm.arm, arm.tool, `${arm.model ? [arm.model, ...(arm.effort ? [arm.effort] : [])].join(' ') : 'tool default'} (${arm.source})`, ...(namesTeam ? [formatTeam(arm.team)] : []), String(arm.planned),
        ...TRIAL_RESULTS.map((result) => String(arm.counts[result])), String(arm.stoppedByLimit), String(arm.deviations), String(arm.notVerified), formatPassRate(arm.passRate),
      ]),
    },
    usage: {
      header: ['Arm', `Median tokens (${TOKEN_COMPONENTS.join(' + ')})`, 'Median duration', 'Cost'],
      rows: table.usage.map(({ arm, tokens, durationMs, cost }) => [
        arm, formatMedian(tokens, (value) => String(Math.round(value))), formatMedian(durationMs, (value) => `${(value / 1000).toFixed(1)} s`), formatCost(cost),
      ]),
    },
    matrix: {
      header: ['Task', ...table.results.map(({ arm }) => arm)],
      rows: table.matrix.map(({ task, arms }) => [task, ...arms.map(({ passRate }) => formatPassRate(passRate))]),
    },
    ...(table.invalid.length > 0 ? { invalid: { header: ['Task', 'Baseline'], rows: table.invalid.map(({ task, baseline }) => [task, INVALID_REASONS[baseline]]) } } : {}),
    ...(table.skills.length > 0 ? {
      skills: {
        header: ['Arm', 'Skill', 'Change', 'Loaded in this arm', 'Loaded in the defaults arm'],
        rows: table.skills.map(({ arm, skill, change, here, defaults }) => [arm, skill, change, formatSkillLoads(here), defaults ? formatSkillLoads(defaults) : '-']),
      },
    } : {}),
    caption: BENCHMARK_CAPTION,
  };
}

/** benchmarkCells as Markdown pipe tables, so the same text reads in a terminal and renders in a CI job summary. */
export function formatBenchmarkTable(table: BenchmarkTable): string {
  const { results, usage, matrix, invalid, skills, caption } = benchmarkCells(table);
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  const markdown = ({ header, rows }: TextTable): string => [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
  return [...[results, usage, matrix, ...(invalid ? [invalid] : []), ...(skills ? [skills] : [])].map(markdown), caption].join('\n\n');
}

/** `1/2` loaded of the trials seen, `1/2, 1 unknown` with some unseen, `unknown (3)` with none seen. */
function formatSkillLoads({ loaded, observed, unknown }: SkillLoads): string {
  if (observed === 0) return `unknown (${unknown})`;
  return unknown > 0 ? `${loaded}/${observed}, ${unknown} unknown` : `${loaded}/${observed}`;
}

function passRateOf(trials: readonly RecordedTrial[]): { passRate?: PassRate } {
  return trials.length > 0 ? { passRate: { passed: trials.filter(({ result }) => result === 'passed').length, planned: trials.length } } : {};
}

/** An arm's team assets: `pulled 62432de`, `main 1a2b3c4`, `62432de without rules/commits.md, skills/fixer` or `none`. */
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

/** The total of `parts`, one per trial whose prompt ran: the cost it stated, or undefined when it stated none. */
function costTotal(parts: ReadonlyArray<RecordedTrial['cost']>): CostTotal {
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

function formatCost(cost: CostTotal): string {
  const amount = (value: number): string => String(Math.round(value * 10_000) / 10_000);
  switch (cost.kind) {
    case 'known':
      return `${amount(cost.amount)} ${cost.unit} (${cost.used})`;
    case 'incomplete':
      return `${amount(cost.amount)} ${cost.unit} (${cost.used}), incomplete: ${cost.unknown} unknown`;
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
