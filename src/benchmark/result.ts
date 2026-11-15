/**
 * How a trial's steps become its result, and the benchmark record. Pure over an ended run: the step states
 * the engine keeps, with what each check step output, the frozen plan, and the verdicts of each trial's scorers
 * (`verdicts.ts`). It classifies nothing: teamai did that once, from the check step's exit code (trial.ts), and stored
 * the correctness label of a check task's trial.
 *
 * Results are never failure codes, and no value here enters record `status` or `steps[].outcome`: an older dashboard
 * drops a whole record on an enum value it does not know.
 */

import path from 'node:path';
import { z } from 'zod';
import { AgentObservationSchema } from '../agent-observation.js';
import { RunOriginSchema } from '../default-workflows.js';
import type { ArchivedPass, StepPass, StepState } from '../workflow/step-state.js';
import { stepDefinitions } from '../workflow/scope.js';
import { LimitSchema } from '../workflow/requirements.js';
import type { RunState } from '../workflow/types.js';
import { definedFields } from '../utils/defined-fields.js';
import { CHECK_CAUSES, CheckOutputSchema, type CheckCause, type CheckOutput } from '../scorers/check.js';
import { compareAgent } from './agent-match.js';
import { baselineStepOf, BenchmarkEstimateSchema, checkStepOf, correctnessScorerName, PlannedJudgeSchema, type BenchmarkPlan, type PlannedArm, type PlannedTask, type PlannedTrial } from './plan.js';
import type { RunPlan } from './run-plan.js';
import { ArmTeamSchema, SkillChangesSchema, TrialLimitsSchema } from './terms.js';
import { leavesOut, skillDefinitionOf } from './team-without.js';
import { TrialCalibrationSchema, TrialScoringCostSchema, TrialVerdictSchema, TrialVerdicts, type EntryCalibration, type EntryVerdict, type TrialVerdict } from './verdicts.js';

export const TRIAL_RESULTS = ['passed', 'failed', 'error', 'unscored', 'not_run'] as const;

export type TrialResult = (typeof TRIAL_RESULTS)[number];

/** What trying a task's check on its clean starting commit showed. Only `valid` lets its trials run. */
const BASELINES = ['valid', 'invalid', 'could_not_run', 'not_run', 'not_needed'] as const;

export type Baseline = (typeof BASELINES)[number];

/**
 * The shape of the record this teamai writes. 2: every trial carries its verdicts, and every scorer its labels and
 * passing score. A record of schemaVersion 1 still parses and shows, but runs compare only within one version.
 */
export const BENCHMARK_RECORD_SCHEMA_VERSION = 2;

/** The not enforced requirements of a trial's prompt that the record keeps: those of the suite's limits. */
const UNENFORCED_LIMITS = ['max_turns', 'budget', 'on_limit'] as const;

type UnenforcedLimit = (typeof UNENFORCED_LIMITS)[number];

/**
 * A benchmark's plan and trial results. A reader rebuilds the comparison from the record alone, after the suite left the
 * cache. No prompts, commands, credential URLs or local paths.
 */
export const BenchmarkRecordSchema = z.object({
  suite: z.object({ name: z.string(), sourceHash: z.string() }),
  repetitions: z.number().int(),
  /** The limits every trial's prompt ran under; absent when the suite set none. */
  limits: TrialLimitsSchema.optional(),
  baselineTeamRevision: z.string(),
  /** The run ran only the tasks and arms `--task` and `--arm` chose, so it is never its suite's current version; absent: the whole suite. */
  subset: z.literal(true).optional(),
  /** `labels` and `passingScore`, as the run pinned them; absent on a record of schemaVersion 1. */
  scorers: z.array(z.object({
    name: z.string(), rubric: z.object({ sourceHash: z.string() }),
    labels: z.array(z.object({ value: z.string(), score: z.number() })).optional(), passingScore: z.number().optional(),
  })),
  /** By scorer, the judge the run pinned for every arm, as the plan froze it; absent on a record of schemaVersion 1. */
  judges: z.record(z.string(), PlannedJudgeSchema).optional(),
  tasks: z.array(z.object({
    id: z.string(), startingCommit: z.string(), sourceHash: z.string(), baseline: z.enum(BASELINES),
    /** The team repo paths the task covers, each listed once, sorted; absent when it covers none. */
    covers: z.array(z.string().min(1)).nonempty().optional(),
    coversSkills: z.array(z.string().min(1).nullable()).nonempty().optional(),
    /** Aligned with `covers`: the arms whose clone did not receive that path, as plan read it; absent on older records and when every arm received each path. */
    coversWithheldFrom: z.array(z.array(z.string())).nonempty().optional(),
    /** What decides the task's trials: its check, a judge on its success criteria, or both; absent on records written before it was kept. */
    judge: z.enum(['check', 'criteria', 'both']).optional(),
  })),
  arms: z.array(z.object({
    name: z.string(), tool: z.string(), model: z.string().optional(), alias: z.string().optional(), effort: z.string().optional(),
    source: z.enum(['team', 'member']), team: ArmTeamSchema,
    /** The team workflow the arm's trials ran on each task instead of one prompt. */
    workflow: z.object({ name: z.string(), sourceHash: z.string() }).optional(),
    /** The team role the arm's trial clones ran with; absent: the member's roles. */
    role: z.string().optional(),
    /**
     * Whether the arm's trial clones got the team's recall deployment; absent: off. A record is read back through this
     * schema, so a field the writer puts on the arm and this omits is dropped without a word: the arm's recall would
     * read as never on, in every reader.
     */
    recall: z.boolean().optional(),
  })),
  /** The arm that changes no `defaults` key, which the results read the others against; absent when the plan had none. */
  defaultsArm: z.string().optional(),
  /** What start estimated the run costs, which the usage table shows beside what it cost; absent on a plan without one. */
  estimate: BenchmarkEstimateSchema.optional(),
  /** The suite's calibration rate, 0 when it calibrates nothing; absent on records written before it was kept. */
  calibration: z.object({ rate: z.number().min(0).max(100) }).strict().optional(),
  /** The team skills each arm adds, removes or changes against the baseline team revision; absent when no arm changes one. */
  skillChanges: z.array(SkillChangesSchema).optional(),
  trials: z.array(z.object({
    task: z.string(), arm: z.string(), repetition: z.number().int(), order: z.number().int(), step: z.string(),
    result: z.enum(TRIAL_RESULTS),
    /** How each of the trial's scorers ended, its correctness scorer first; absent on a record of schemaVersion 1. */
    verdicts: z.array(TrialVerdictSchema).optional(),
    /** What its correctness judge labelled the work its check failed, to calibrate that judge; absent when none did. Never decides `result`. */
    calibration: TrialCalibrationSchema.optional(),
    /** Why the trial's check could not run, which made it `error`. */
    failure: z.object({ cause: z.enum(CHECK_CAUSES) }).strict().optional(),
    /** The suite limit that ended the prompt; the check or judge still decided `result`. */
    limit: LimitSchema.optional(),
    /**
     * The suite limits the prompt's driver did not enforce, which make the trial a deviation: `on_limit` when the driver
     * could not end the turn at them at all.
     */
    unenforced: z.array(z.enum(UNENFORCED_LIMITS)).optional(),
    /** The prompt's, as its driver measured them around the tool launch and the tool stated them. */
    durationMs: z.number().int().nonnegative().optional(),
    /** `complete: false` when a pass of the trial stated none. */
    tokens: z.object({ input: z.number().optional(), output: z.number().optional(), cachedInput: z.number().optional(), complete: z.boolean() }).optional(),
    /** What the tool stated the prompt cost; absent when it stated none, never zero. `complete: false` when a pass of the trial stated none. */
    cost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).optional(),
    /** What the trial's prompt ran as, as teamai observed it; absent for a prompt that never reported. */
    agent: AgentObservationSchema.optional(),
    /** The team skills the trial loaded, each `loaded`, or `unknown` when a pass that did not load it went unobserved. */
    used: z.record(z.string().min(1), z.enum(['loaded', 'unknown'])).optional(),
    /**
     * Each covered skill's routing value on this trial, in #1469's terms from the task instead of a judge: `fit` loaded
     * and the task covers it, `idle` not loaded and it does not, `extra` loaded and it does not, `missed` not loaded and
     * it does, `unknown` when no pass reported its loads. Absent when no task covers a skill.
     */
    routing: z.record(z.string().min(1), z.enum(['fit', 'idle', 'extra', 'missed', 'unknown'])).optional(),
    /** What every judge launch of the trial stated it cost (`TrialScoringCostSchema`); absent when no judge launched. */
    scoringCost: TrialScoringCostSchema.optional(),
  })),
});

export type BenchmarkRecord = z.infer<typeof BenchmarkRecordSchema>;

/** A benchmark run's record: its plan's trials, classified, with the run they ran in. No prompt, command, URL or path. */
export const BenchmarkRunRecordSchema = BenchmarkRecordSchema.extend({
  schemaVersion: z.union([z.literal(1), z.literal(BENCHMARK_RECORD_SCHEMA_VERSION)]),
  run: z.string().min(1),
  /** How the run's steps ended, before its `finally` steps ran. */
  outcome: z.enum(['succeeded', 'failed', 'cancelled']),
  teamaiVersion: z.string().min(1),
  startedAt: z.string(),
  /** When the run's steps ended. */
  finishedAt: z.string(),
  username: z.string().optional(),
  /** The workflow the run ran: the team's `teamai-benchmark`, or teamai's default, by the hash of its bytes. */
  workflow: z.object({ name: z.string(), origin: RunOriginSchema, sourceHash: z.string() }),
});

export type BenchmarkRunRecord = z.infer<typeof BenchmarkRunRecordSchema>;

/** `runs/<run>/benchmark.json`: where a run's benchmark record is kept on this machine. */
export function benchmarkRecordFile(runsRoot: string, run: string): string {
  return path.join(runsRoot, run, 'benchmark.json');
}

/**
 * The block buildEndRecord adds for a benchmark run that has ended, with `verdicts`, those of its trials, and
 * `calibrations`, what their correctness judges labelled work a check failed. Pure, so the `done` envelope and a run
 * with recording off get the same block a published record holds.
 */
export function benchmarkRecord(run: RunState, { plan, prefix }: RunPlan, verdicts: readonly EntryVerdict[], calibrations: readonly EntryCalibration[] = []): BenchmarkRecord {
  const stateOf = (step: string): StepState | undefined => run.steps.find((state) => state.id === `${prefix}${step}`);

  const verdictsOf = (trial: PlannedTrial): EntryVerdict[] => {
    const pass = stateOf(trial.step)?.pass ?? 1;

    return verdicts.filter((verdict) => verdict.step === `${prefix}${trial.step}` && verdict.pass === pass);
  };

  const namesOf = ({ covers, coversSkills }: PlannedTask): string[] => (covers ?? []).flatMap((covered, index) => {
    const name = coversSkills?.[index];

    return name !== undefined && name !== null ? [name] : [];
  });

  const coveredSkills = [...new Set(plan.tasks.flatMap(namesOf))];

  const watched = [...new Set([...(plan.skillChanges ?? []).flatMap(({ skills }) => skills.map(({ name }) => name)), ...coveredSkills])];
  const judgingCostOf = TrialVerdicts.judgingCosts(run);

  return definedFields<BenchmarkRecord>({
    suite: { name: plan.suite.name, sourceHash: plan.suite.sourceHash },
    repetitions: plan.repetitions,
    limits: plan.limits,
    baselineTeamRevision: plan.baselineTeamRevision,
    subset: plan.subset,
    scorers: plan.scorers,
    judges: plan.judges,
    tasks: plan.tasks.map((task) => ({ id: task.id, startingCommit: task.startingCommit, sourceHash: task.sourceHash, baseline: baselineOf(stateOf(baselineStepOf(task.id)), task), covers: task.covers ? [...task.covers] : undefined, coversSkills: task.coversSkills ? [...task.coversSkills] : undefined, coversWithheldFrom: task.coversWithheldFrom?.map((arms) => [...arms]), judge: task.judge.kind })),
    arms: plan.arms,
    defaultsArm: plan.defaultsArm,
    estimate: plan.estimate,
    calibration: { rate: plan.calibration?.rate ?? 0 },
    skillChanges: plan.skillChanges,
    trials: plan.trials.map((trial) => {
      const judged = verdictsOf(trial);
      const task = plan.tasks.find(({ id }) => id === trial.task);
      const checkState = stateOf(checkStepOf(trial));
      const check = checkOutputOf(checkState);
      const work = stateOf(trial.step);
      const result = trialResultOf({ prompt: work, work: workOf(run, `${prefix}${trial.step}`), check, verdicts: judged }, plan, trial);
      const arm = plan.arms.find(({ name }) => name === trial.arm);

      const covers = task === undefined ? [] : namesOf(task);
      // An arm that runs without a covered skill by design, alone, with the directory holding it, with its definition
      // file, or with no team resources at all, or whose selection pull does not deliver it to, reports no routing for it:
      // the resource is absent, not misrouted.
      const left = arm?.team.kind === 'without' ? arm.team.paths : arm?.team.kind === 'none' ? ['skills'] : [];

      const absent = new Set(plan.tasks.flatMap((one) => (one.covers ?? []).flatMap((covered, index) => {
        const name = one.coversSkills?.[index];
        const withheld = arm !== undefined && (one.coversWithheldFrom?.[index] ?? []).includes(arm.name);

        return name !== undefined && name !== null && (withheld || leavesOut(left, skillDefinitionOf(covered))) ? [name] : [];
      })));

      const entry = arm?.workflow
        ? projectionOf(promptPassesUnder(run, `${prefix}${trial.step}`), { arm, watched, routingSkills: coveredSkills.filter((name) => !absent.has(name)), covers, unenforced: plan.limits?.maxTurns !== undefined ? ['max_turns'] : [] })
        : projectionOf(settledPass(work), { arm, watched, routingSkills: coveredSkills.filter((name) => !absent.has(name)), covers, unenforced: [] });

      const recorded: BenchmarkRecord['trials'][number] = {
        ...trial, step: `${prefix}${trial.step}`, result, verdicts: judged.map(({ scorer, outcome, decider, asPlanned }) => definedFields<TrialVerdict>({ scorer, outcome, decider, asPlanned })), ...entry,
      };

      const cause = result === 'error' ? (check?.result === 'could_not_run' ? check.cause : failedCheckCause(checkState)) : undefined;

      if (cause !== undefined) recorded.failure = { cause };
      const calibration = calibrations.find((one) => one.step === recorded.step && one.pass === (work?.pass ?? 1));

      if (calibration) recorded.calibration = definedFields({ label: calibration.label, passed: calibration.passed, decider: calibration.decider, scoringCost: calibration.scoringCost });
      const scoringCost = judgingCostOf({ step: recorded.step, pass: work?.pass ?? 1, isCalibrated: calibration !== undefined });

      if (scoringCost) recorded.scoringCost = scoringCost;

      return recorded;
    }),
  });
}


/** What one prompt pass reported, as a step keeps it. */
type PromptPass = Pick<StepPass, 'limit' | 'unenforced' | 'durationMs' | 'tokens' | 'cost' | 'agent' | 'used'>;

type TrialEntry = Pick<BenchmarkRecord['trials'][number], 'limit' | 'unenforced' | 'durationMs' | 'tokens' | 'cost' | 'agent' | 'used' | 'routing'>;


/** What `state` reported of its current pass, or nothing when that pass settled no report. */
function settledPass(state: StepState | undefined): PromptPass[] {
  switch (state?.status) {
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'delivering':
      return [state];
    case undefined:
    case 'pending':
    case 'waiting':
    case 'leased':
    case 'running':
    case 'skipped':
      return [];
    default: {
      const unhandled: never = state;

      return unhandled;
    }
  }
}

/** Every launched pass of a prompt step under workflow step `step`: earlier passes a loop kept or archived, and the current one. */
function promptPassesUnder(run: RunState, step: string): PromptPass[] {
  const definitionOf = stepDefinitions(run);
  const isPromptUnder = (id: string): boolean => id.startsWith(`${step}.`) && definitionOf(id)?.prompt !== undefined;
  const launched = (pass: StepPass): boolean => pass.attempt !== undefined;

  return [
    ...(run.archive ?? []).filter((pass) => isPromptUnder(pass.step) && launched(pass)),
    ...run.steps.flatMap((state) => (isPromptUnder(state.id) ? [...(state.passes ?? []).filter(launched), ...settledPass(state)] : [])),
  ];
}

/**
 * One trial's measures over the prompt passes it ran, the one-trial projection: tokens and cost summed, incomplete when
 * a pass stated none, or for tokens not both input and output; duration summed, absent when a pass stated none; the first pass that ran as something other than `arm`, else the first
 * observed; each skill a pass loaded; the first limit that ended a turn; and the limits a driver did not enforce, with
 * `unenforced`, those no step of the trial could. Each `watched` skill no observed pass loaded is `unknown` when a pass went
 * unobserved; `used` is absent when none was observed. Empty for a trial whose work never ran.
 */
function projectionOf(passes: readonly PromptPass[], { arm, watched, routingSkills, covers, unenforced }: { arm: PlannedArm | undefined; watched: readonly string[]; routingSkills: readonly string[]; covers: readonly string[]; unenforced: readonly UnenforcedLimit[] }): TrialEntry {
  const sum = (values: ReadonlyArray<number | undefined>): number | undefined => (values.some((value) => value !== undefined) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : undefined);
  const stated = passes.flatMap(({ tokens }) => (tokens ? [tokens] : []));
  const [costed] = passes.flatMap(({ cost }) => (cost ? [cost] : []));
  const inUnit = passes.flatMap(({ cost }) => (cost && cost.unit === costed?.unit ? [cost] : []));
  const agents = passes.flatMap(({ agent }) => (agent ? [agent] : []));
  const agent = (arm ? agents.find((observed) => compareAgent(arm, observed) === 'deviation') : undefined) ?? agents[0];
  const observed = passes.flatMap(({ used }) => (used ? [used] : []));
  const limit = passes.find((pass) => pass.limit !== undefined)?.limit;
  const notEnforced = [...new Set([...unenforced, ...passes.flatMap((pass) => (pass.unenforced ?? []).flatMap(({ requirement }) => UNENFORCED_LIMITS.filter((known) => known === requirement)))])];
  const durationMs = passes.every((pass) => pass.durationMs !== undefined) ? sum(passes.map((pass) => pass.durationMs)) : undefined;
  const [input, output, cachedInput] = (['input', 'output', 'cachedInput'] as const).map((field) => sum(stated.map((one) => one[field])));
  const entry: TrialEntry = {};

  if (limit) entry.limit = limit;

  if (notEnforced.length > 0) entry.unenforced = notEnforced;

  if (durationMs !== undefined) entry.durationMs = durationMs;

  if (stated.length > 0) {
    entry.tokens = definedFields<NonNullable<TrialEntry['tokens']>>({
      input, output, cachedInput,
      complete: passes.every((pass) => pass.tokens?.input !== undefined && pass.tokens.output !== undefined),
    });
  }

  if (costed) entry.cost = { amount: inUnit.reduce((total, cost) => total + cost.amount, 0), unit: costed.unit, complete: inUnit.length === passes.length };

  if (agent) entry.agent = agent;

  if (observed.length > 0) entry.used = usedOf(observed.flatMap(({ skills }) => skills), observed.length < passes.length ? watched : []);

  if (routingSkills.length > 0) entry.routing = routingOf(routingSkills, covers, entry.used);

  return entry;
}

/**
 * Each covered skill's routing value on this trial, over every skill the suite's tasks cover: `fit` or `extra` when it
 * loaded, by whether this trial's task covers it, `missed` or `idle` when an observed pass did not load it, by the same,
 * `unknown` when no pass reported its loads. A trial with no `used` at all reported nothing: every covered skill is
 * `unknown`, never `idle` or `missed`.
 */
function routingOf(skills: readonly string[], covers: readonly string[], used: TrialEntry['used']): NonNullable<TrialEntry['routing']> {
  return Object.fromEntries(skills.map((skill): [string, NonNullable<TrialEntry['routing']>[string]] => {
    const load = used === undefined ? 'unknown' : used[skill] === 'loaded' ? 'loaded' : used[skill] === 'unknown' ? 'unknown' : 'not_loaded';

    return [skill, load === 'loaded' ? (covers.includes(skill) ? 'fit' : 'extra') : load === 'not_loaded' ? (covers.includes(skill) ? 'missed' : 'idle') : 'unknown'];
  }));
}

/** Each skill in `loaded`, and each of `unsure` not in it as `unknown`. */
function usedOf(loaded: readonly string[], unsure: readonly string[]): NonNullable<TrialEntry['used']> {
  return Object.fromEntries([...unsure.flatMap((skill) => (loaded.includes(skill) ? [] : [[skill, 'unknown'] as const])), ...loaded.map((skill) => [skill, 'loaded'] as const)]);
}

/**
 * A task's baseline, from the result its step output, first match wins:
 *   task with no check                              -> not_needed: it has no check to try
 *   result failed                                   -> valid
 *   result passed                                   -> invalid: the check passes without changes
 *   result could_not_run, or failed without one     -> could_not_run: its clone or setup failed, or the check did not run
 *   cancelled once leased, without a result         -> could_not_run: the run ended while it ran, such as at its timeout
 *   no result otherwise                             -> not_run: no driver took it before the run ended
 * Its trials need no rule of their own: a task whose baseline is not valid skips them, and a skipped prompt is not_run.
 */
function baselineOf(state: StepState | undefined, task: PlannedTask): Baseline {
  if (task.judge.kind === 'criteria') return 'not_needed';
  const result = checkOutputOf(state)?.result;

  switch (result) {
    case 'failed':
      return 'valid';
    case 'passed':
      return 'invalid';
    case 'could_not_run':
      return 'could_not_run';
    case undefined:
      return state?.status === 'failed' || (state?.status === 'cancelled' && state.attempt !== undefined) ? 'could_not_run' : 'not_run';
    default: {
      const unhandled: never = result;

      return unhandled;
    }
  }
}

/**
 * A trial's work: its work step and every step under it, where a workflow arm's prompts run, the passes a loop archived
 * of them, and which of them prompt a tool.
 */
type TrialWork = { states: StepState[]; archived: ArchivedPass[]; isPrompt: (id: string) => boolean };

/** The trial's work of work step `step`: a workflow arm's own step has no attempt, so its children's attempts count. */
function workOf(run: RunState, step: string): TrialWork {
  const isWork = (id: string): boolean => id === step || id.startsWith(`${step}.`);
  const definitionOf = stepDefinitions(run);

  return {
    states: run.steps.filter((state) => isWork(state.id)),
    archived: (run.archive ?? []).filter((pass) => isWork(pass.step)),
    isPrompt: (id) => definitionOf(id)?.prompt !== undefined,
  };
}

/**
 * Whether no step of `work` that `counted` keeps was ever leased: no current attempt, and none on a pass a loop kept
 * or archived.
 */
function unleased({ states, archived }: TrialWork, counted: (id: string) => boolean = () => true): boolean {
  const leased = (pass: StepPass): boolean => pass.attempt !== undefined;

  return !states.some((state) => counted(state.id) && (('attempt' in state && state.attempt !== undefined) || (state.passes ?? []).some(leased)))
    && !archived.some((pass) => counted(pass.step) && leased(pass));
}

/**
 * Whether `work` failed tool_unavailable before any of its prompts was leased: the run's driver could not launch its
 * tool. A command a workflow arm runs first may have been leased.
 */
function unlaunched(work: TrialWork): boolean {
  return unleased(work, work.isPrompt) && work.states.some((state) => state.status === 'failed' && state.failure?.code === 'tool_unavailable');
}

/**
 * A line for each check of `run` that said nothing: a baseline whose check could not run on its starting commit, and a
 * trial whose work ended but whose check never ran to a verdict, each with why, as its step output or failed it. The run
 * measured nothing for them, so its report names them, and teamai's benchmark workflow fails its `checks` gate on them.
 */
export function uncheckedChecks(run: RunState, { plan, prefix }: RunPlan): string[] {
  const stateOf = (step: string): StepState | undefined => run.steps.find((state) => state.id === `${prefix}${step}`);

  const why = (state: StepState | undefined): string => {
    const output = checkOutputOf(state);

    if (output?.result === 'could_not_run') return output.cause;

    if (state === undefined) return 'its step never ran';

    if (state.status === 'failed') return state.failure ? `${state.failure.code}: ${state.failure.message}` : 'its step failed';

    return state.status === 'cancelled' ? 'the run ended while it ran' : `its step is ${state.status}`;
  };

  const baselines = plan.tasks.flatMap((task) => {
    const state = stateOf(baselineStepOf(task.id));

    return baselineOf(state, task) === 'could_not_run' ? [`Baseline ${task.id}: ${why(state)}`] : [];
  });

  const trials = plan.trials.flatMap((trial) => {
    const judge = plan.tasks.find((task) => task.id === trial.task)?.judge;
    const state = stateOf(checkStepOf(trial));
    const check = checkOutputOf(state);

    if (judge === undefined || judge.kind === 'criteria' || stateOf(trial.step)?.status !== 'succeeded' || (check !== undefined && check.result !== 'could_not_run')) return [];

    return [`Trial ${trial.order}/${plan.trials.length} ${trial.task} ${trial.arm}: ${why(state)}`];
  });

  return [...baselines, ...trials];
}

/** The results that measured a trial: its work ran to an end that a check, a judge or no judge decided. */
const MEASURED: ReadonlySet<TrialResult> = new Set(['passed', 'failed', 'unscored']);

/**
 * A line for each of the record's `trials` whose work ended in an error, with why, when none produced a result: every
 * trial is `error` or `not_run`, so the run measured nothing. A trial whose work succeeded and whose check could not run
 * is left to `uncheckedChecks`, and one whose work the run's cancel or timeout stopped did not break. Empty once any
 * trial passed, failed or is unscored. teamai's benchmark workflow fails its `results` gate on them.
 */
export function unmeasuredTrials(run: RunState, trials: BenchmarkRecord['trials']): string[] {
  if (trials.some(({ result }) => MEASURED.has(result))) return [];

  return trials.flatMap((trial) => {
    const work = run.steps.find((state) => state.id === trial.step);

    if (trial.result !== 'error' || work?.status === 'succeeded' || work?.status === 'cancelled') return [];

    return [`Trial ${trial.order}/${trials.length} ${trial.task} ${trial.arm}: ${whyErrored(workOf(run, trial.step), work)}`];
  });
}

/**
 * Why `work`, whose work step is `step`, ended in an error: the failure of its deepest failed step, else of its deepest
 * cancelled one, as `code: message`, else how its work step stands. A step cancelled beside one that failed is a
 * consequence, not the cause.
 */
function whyErrored({ states }: TrialWork, step: StepState | undefined): string {
  const deepestFirst = states.toSorted((left, right) => right.id.split('.').length - left.id.split('.').length);
  const [failure] = (['failed', 'cancelled'] as const).flatMap((ended) => deepestFirst.flatMap((state) => (state.status === ended && state.failure ? [state.failure] : [])));

  if (failure) return `${failure.code}: ${failure.message}`;

  return step ? `its step is ${step.status}` : 'its step never ran';
}

/** `unlaunched` of the trial whose work step is `step`. */
export function unlaunchedTrial(run: RunState, step: string): boolean {
  return unlaunched(workOf(run, step));
}

/**
 * The result of one planned trial, first match wins. Its work is its prompt, or a workflow arm's workflow step and the
 * steps under it:
 *   work never leased: absent, pending, skipped, or cancelled before any lease      -> not_run
 *   work failed tool_unavailable before any prompt's lease: the driver cannot launch
 *               its tool, though a command a workflow arm runs first may have run     -> not_run
 *   work cancelled after a lease, or failed                                         -> error
 *   check task whose check could not run, or never ran to an output                 -> error
 *   otherwise its correctness verdict, whether its check or a judge decided it:
 *               labelled passing -> passed, labelled not passing -> failed;
 *               unscored, or none                                                   -> unscored, never passed
 */
function trialResultOf({ prompt, work, check, verdicts }: { prompt: StepState | undefined; work: TrialWork; check: CheckOutput | undefined; verdicts: readonly EntryVerdict[] }, plan: BenchmarkPlan, trial: PlannedTrial): TrialResult {
  switch (prompt?.status) {
    case undefined:
    case 'pending':
    case 'waiting':
    case 'skipped':
      return 'not_run';
    case 'cancelled':
      return unleased(work) ? 'not_run' : 'error';
    case 'failed':
      return unlaunched(work) ? 'not_run' : 'error';
    case 'leased':
    case 'running':
    case 'delivering':
      return 'error';
    case 'succeeded':
      break;
    default: {
      const unhandled: never = prompt;

      return unhandled;
    }
  }

  const judge = plan.tasks.find((task) => task.id === trial.task)?.judge;

  if (judge !== undefined && judge.kind !== 'criteria' && (check === undefined || check.result === 'could_not_run')) return 'error';

  return correctnessResult(verdicts.find((verdict) => verdict.scorer === correctnessScorerName(trial.task)));
}

function correctnessResult(verdict: EntryVerdict | undefined): TrialResult {
  if (!verdict) return 'unscored';
  const { outcome } = verdict;

  switch (outcome.kind) {
    case 'labelled':
      return outcome.passed ? 'passed' : 'failed';
    case 'unscored':
      return 'unscored';
    default: {
      const unhandled: never = outcome;

      return unhandled;
    }
  }
}

/**
 * Why a check step that ended before its command ran to an exit could not check: it ran out of time, its own or the
 * run's, or teamai could not put back `protect` or write `check.add` in its place. The record's cause, as the check's
 * output would carry it.
 */
function failedCheckCause(state: StepState | undefined): CheckCause | undefined {
  if (state?.status !== 'failed' && state?.status !== 'cancelled') return undefined;

  switch (state.failure?.code) {
    case 'timeout':
      return 'timeout';
    case 'trial_prepare_failed':
      return 'prepare_failed';
    default:
      return undefined;
  }
}

/** What a check step output; undefined when it output none, as one that never ran to a verdict. */
function checkOutputOf(state: StepState | undefined): CheckOutput | undefined {
  const output = CheckOutputSchema.safeParse(state && 'outputs' in state ? state.outputs : undefined);

  return output.success ? output.data : undefined;
}
