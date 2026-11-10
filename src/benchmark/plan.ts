/**
 * The frozen benchmark and the workflow it runs as. Pure, with zod and terms.ts as its only runtime imports.
 *
 * `freezePlan` turns a parsed suite and what `teamai benchmark plan` resolved into the `BenchmarkPlan` that step prints.
 * `compileBundle` turns the plan into the workflow the run's `from` step runs, plus the generated correctness scorers its
 * prompts list. Trials are ordinary steps, so limits, records, snapshot rules, scoring and the dashboard read them as
 * they read any step.
 *
 * The plan is the measurement (hashes, commits, arms, the ordered trial list). The workflow is how it executes
 * (prompts, commands, the step graph). Neither restates the other.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DefaultScorers } from '../default-scorers.js';
import { isRecordableLabel, isRecordableName } from '../agent-observation.js';
import { RoleIdSchema } from '../roles.js';
import type { ScorerLabel } from '../scorers/definition.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { JsonObject } from '../types.js';
import { definedFields } from '../utils/defined-fields.js';
import { defaultsArmOf, type Suite, type Task, type TaskCheck, TaskJudge } from './suite.js';
import type { CommittedSuite } from './trial.js';
import type { PinnedArmWorkflow } from './arm-workflow.js';
import { CommitSchema, TeamSelectionSchema, type CloneTeam, type TeamSelection } from '../workflow/clone.js';
import { AddedSchema, CHECK_RESULTS, type Added } from '../scorers/check.js';
import { ArmTeamSchema, BenchmarkNameSchema, SkillChangesSchema, TrialLimitsSchema, type ArmTeam, type SkillChanges } from './terms.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const PlannedArmSchema = z.object({
  name: BenchmarkNameSchema,
  /** Shaped like the names a record publishes, as start checks, so a run file that holds anything else reads as corrupt. */
  tool: z.string().refine(isRecordableLabel),
  /** The model name the arm's alias resolved to at start, or its model name as written; absent: the tool's default. */
  model: z.string().refine(isRecordableName).optional(),
  /** The alias the suite named, when the model came from one: what arms on different tools share. */
  alias: z.string().refine(isRecordableName).optional(),
  effort: z.string().refine(isRecordableLabel).optional(),
  /** Whose aliases resolved the model: the team's, or the member's with `--member-aliases`. */
  source: z.enum(['team', 'member']),
  /** The team resources the arm's trials get. */
  team: ArmTeamSchema,
  /** The team workflow the arm's trials run on each task instead of one prompt, by the hash of its sources and theirs. */
  workflow: z.object({ name: z.string().min(1), sourceHash: Sha256 }).strict().optional(),
  /** The team role the arm's trial clones run with, as its suite named it, no longer than a record label; absent: the member's roles. */
  role: RoleIdSchema.refine(isRecordableLabel).optional(),
  /** Whether the arm's trial clones get the team's recall deployment; absent: off, as a workflow clone always has been. */
  recall: z.boolean().optional(),
}).strict();

export type PlannedArm = z.infer<typeof PlannedArmSchema>;

const PlannedCheckSchema = z.object({ run: z.string().min(1), protect: z.array(z.string().min(1)).nonempty(), add: z.array(AddedSchema).nonempty().optional() }).strict();

export type PlannedCheck = z.infer<typeof PlannedCheckSchema>;

const PlannedTaskSchema = z.object({
  id: BenchmarkNameSchema,
  sourceHash: Sha256,
  startingCommit: CommitSchema,
  /**
   * How the task's trials are decided: by its check, by a judge on its success criteria, or by both, the judge only
   * when the check passes. `check`, which `teamai benchmark check` reads: the command, the protected paths, and the
   * files check.add writes, by commit and path, never their bytes.
   */
  judge: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('check'), check: PlannedCheckSchema }).strict(),
    z.object({ kind: z.literal('criteria') }).strict(),
    z.object({ kind: z.literal('both'), check: PlannedCheckSchema }).strict(),
  ]),
  /** The team repo paths the task covers, each listed once, sorted, as plan checked them deliverable at the pulled revision. Absent: the task covers none. */
  covers: z.array(z.string().min(1)).nonempty().optional(),
  /** Aligned with `covers`: the bare skill name a trial's load record shows for that path, or null when the revision delivers it as no skill, such as a namespace directory. */
  coversSkills: z.array(z.string().min(1).nullable()).nonempty().optional(),
  /** Aligned with `covers`: the arms whose clone does not receive that path, at its team revision, with its role and without paths, so their trials record no routing for it. Absent: every arm receives each path. */
  coversWithheldFrom: z.array(z.array(BenchmarkNameSchema)).nonempty().optional(),
}).strict();

export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

const PlannedTrialSchema = z.object({
  order: z.number().int().positive(),
  repetition: z.number().int().positive(),
  task: BenchmarkNameSchema,
  arm: BenchmarkNameSchema,
  /**
   * The trial's work step under the workflow that runs the trials: `r<repetition>.<task>.<arm>.prompt`, or
   * `r<repetition>.<task>.<arm>.workflow` for an arm that runs a workflow.
   */
  step: z.string().min(1),
}).strict();

export type PlannedTrial = z.infer<typeof PlannedTrialSchema>;

/** An estimated cost in one unit: the median, and the quartiles as its range. */
const CostRangeSchema = z.object({ unit: z.string().min(1), low: z.number().nonnegative(), median: z.number().nonnegative(), high: z.number().nonnegative() }).strict();

export type CostRange = z.infer<typeof CostRangeSchema>;

const Count = z.number().int().nonnegative();

/**
 * What the run will cost, as start estimated it (estimate.ts): its trials and judge calls, and, from `basis`, the newest
 * earlier run of the suite that succeeded with this record version, each arm's and the judging's cost. Absent `basis`:
 * there was no such run, so no cost is estimated. It never stops a run.
 */
export const BenchmarkEstimateSchema = z.object({
  trials: Count,
  judgeCalls: Count,
  judgedTrials: Count,
  /** The calibration calls the suite's rate expects, as if every check of a task with success criteria failed. */
  calibrationCalls: Count,
  basis: z.object({ run: z.string().min(1) }).strict().optional(),
  arms: z.array(z.union([
    z.object({ arm: BenchmarkNameSchema, trials: Count, perTrial: CostRangeSchema, total: CostRangeSchema }).strict(),
    /** `no_cost_stated`: the basis ran the arm, and its tool stated no cost in one unit; `not_in_basis`: it did not run it. */
    z.object({ arm: BenchmarkNameSchema, trials: Count, unknown: z.enum(['no_cost_stated', 'not_in_basis']) }).strict(),
  ])).optional(),
  /** Absent when no trial is judged. */
  judges: z.union([z.object({ perJudgedTrial: CostRangeSchema, total: CostRangeSchema }).strict(), z.object({ unknown: z.literal('no_cost_stated') }).strict()]).optional(),
  /** The arms' and the judging's totals in the first unit any of them has; `complete` when every one was known in it. */
  total: CostRangeSchema.extend({ complete: z.boolean() }).strict().optional(),
}).strict();

export type BenchmarkEstimate = z.infer<typeof BenchmarkEstimateSchema>;

/**
 * A scorer that judges the run's trials, or decides them, as the run pinned it: the rubric's hash, and its labels and
 * passing score, which pick the label a check writes and tell a reader of the record whether a label passes.
 */
const PlannedLabelSchema = z.object({ value: z.string().min(1), score: z.number() }).strict();

const PlannedScorerSchema = z.object({
  name: z.string().min(1),
  rubric: z.object({ sourceHash: z.string().min(1) }).strict(),
  labels: z.tuple([PlannedLabelSchema], PlannedLabelSchema),
  passingScore: z.number(),
}).strict();

export type PlannedScorer = z.infer<typeof PlannedScorerSchema>;

/**
 * A scorer the run pins, as start read it: its pin, and its rubric's labels, never none, passing score, and the judge
 * tool and model it names, if any.
 */
export interface PinnedRubric {
  pin: PinnedScorer;
  definition: { labels: readonly [ScorerLabel, ...ScorerLabel[]]; passingScore: number; tool?: string; model?: string };
}

/**
 * The judge of a scorer for every arm of the run: the scorer's `tool`, else the suite's `defaults.tool`, and its `model`
 * as the scorer writes it, an alias staying an alias, `""` for the tool's own default.
 */
export const PlannedJudgeSchema = z.object({ tool: z.string().min(1), model: z.string() }).strict();

export type PlannedJudge = z.infer<typeof PlannedJudgeSchema>;

/** The plan's `schemaVersion`. A plan of another version makes the run unreadable here, so no step reads it. */
export const BENCHMARK_PLAN_SCHEMA_VERSION = 2;

/**
 * What a run freezes at start. In PINNED (store.ts) so masking never rewrites it, parsed by `planOfRun` (run-plan.ts)
 * whenever a step reads it, so a plan of another schemaVersion refuses the run's steps and its resume rather than being
 * read as this one, and `drop` in RUN_RULES (snapshot.ts) because benchmark runs are never published. No prompt,
 * credential URL or local path; the check command is in it, and the record copies no field that holds it.
 */
export const BenchmarkPlanSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_PLAN_SCHEMA_VERSION),
  suite: z.object({ name: BenchmarkNameSchema, sourceHash: Sha256, repo: z.string().url() }).strict(),
  baselineTeamRevision: CommitSchema,
  selection: TeamSelectionSchema,
  /** The run plans only the tasks and arms `--task` and `--arm` chose, not the whole suite; absent: the whole suite. */
  subset: z.literal(true).optional(),
  repetitions: z.number().int().min(1).max(10),
  /** The lanes the trials run in, each one trial at a time; absent: one. A trial's step is under `lane<n>` with more than one. */
  parallel: z.number().int().positive().optional(),
  /** The suite's `trial`: the limits of every trial's prompt. */
  limits: TrialLimitsSchema.optional(),
  tasks: z.array(PlannedTaskSchema).nonempty(),
  arms: z.array(PlannedArmSchema).nonempty(),
  /** The planned arm that changes no `defaults` key, which the results read the others against; absent when every one changes one. */
  defaultsArm: BenchmarkNameSchema.optional(),
  /** Each arm whose team resources differ from the baseline's in skills, with those skills. */
  skillChanges: z.array(SkillChangesSchema).optional(),
  /** Every scorer that judges or decides a trial: the suite's, those tasks list, and each task's correctness scorer, which decides its trials. */
  scorers: z.array(PlannedScorerSchema),
  /** By scorer name, the judge of each scorer a judge labels: the suite's, those tasks list, and the correctness scorer of each task with successCriteria. */
  judges: z.record(z.string(), PlannedJudgeSchema),
  /** The percent of failed checks of tasks with success criteria their correctness judge labels too; absent: none. */
  calibration: z.object({ rate: z.number().min(0).max(100) }).strict().optional(),
  /** What start estimated the run costs; absent on a plan frozen without one. */
  estimate: BenchmarkEstimateSchema.optional(),
  trials: z.array(PlannedTrialSchema),
}).strict();

export type BenchmarkPlan = z.infer<typeof BenchmarkPlanSchema>;

/**
 * One trial per task x arm x repetition, ordered by repetition, then task in file-name order, then arm, with the arms
 * of repetition r rotated by r - 1 (A B C, B C A, C A B). The order is not a dependency: trials never need each other.
 */
export function trialsOf(tasks: readonly Pick<Task, 'id'>[], arms: readonly Pick<PlannedArm, 'name' | 'workflow'>[], repetitions: number, parallel = 1): PlannedTrial[] {
  const trials: PlannedTrial[] = [];

  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const shift = (repetition - 1) % arms.length;
    const rotated = [...arms.slice(shift), ...arms.slice(0, shift)];

    for (const task of tasks) {
      for (const arm of rotated) {
        const lane = parallel > 1 ? `${laneOf((trials.length % parallel) + 1)}.` : '';
        trials.push({ order: trials.length + 1, repetition, task: task.id, arm: arm.name, step: `${lane}${stepOf({ repetition, task: task.id, arm: arm.name, kind: workKind(arm) })}` });
      }
    }
  }

  return trials;
}

/** The step a trial of `arm` works the task in: one prompt, or the arm's workflow. */
function workKind(arm: Pick<PlannedArm, 'workflow'>): 'prompt' | 'workflow' {
  return arm.workflow ? 'workflow' : 'prompt';
}

/** `r<repetition>.<task>.<arm>.<kind>`: real nested inline-workflow scopes, so locateStep walks them. */
function stepOf({ repetition, task, arm, kind }: { repetition: number; task: string; arm: string; kind: 'prompt' | 'workflow' }): string {
  return `${trialCopyOf({ repetition, task, arm })}.${kind}`;
}

/** The check step of a check task's trial: beside its work step, in the clone they share. */
export function checkStepOf({ step }: Pick<PlannedTrial, 'step'>): string {
  return `${step.slice(0, step.lastIndexOf('.'))}.check`;
}

/** `baselines.<task>`: the step that tries a check task's check on its clean starting commit. */
export function baselineStepOf(task: string): string {
  return `${BASELINES}.${task}`;
}

/** `r<repetition>.<task>.<arm>`: the step that opens the clone a trial's prompt and check share. */
function trialCopyOf({ repetition, task, arm }: { repetition: number; task: string; arm: string }): string {
  return `r${repetition}.${task}.${arm}`;
}

export function freezePlan(input: {
  /** The suite, with the commit of each task's check files. */
  committed: CommittedSuite;
  baselineTeamRevision: string;
  selection: TeamSelection;
  arms: [PlannedArm, ...PlannedArm[]];
  /** The team scorers the suite and its tasks list, as start pinned them. */
  scorers: Record<string, PinnedRubric>;
  /** The rubric each task's correctness scorer fills in: the team's scorers/teamai-correctness.md pull kept, else teamai's. */
  correctnessRubric: string;
  /** Each covered path's bare skill name as plan checked it at the pulled revision, or null when it delivers no skill. */
  coveredSkills: Record<string, string | null>;
  /** By covered path, the arms whose selection pull does not deliver it to, as plan checked it; absent or empty: none. */
  coveredWithheldFrom?: Record<string, readonly string[]>;
  skillChanges?: SkillChanges[];
  /** The committed suite holds only some of the suite's tasks or arms. */
  isSubset?: boolean;
}): BenchmarkPlan {
  const { suite, files } = input.committed;
  const { coveredSkills, coveredWithheldFrom = {} } = input;
  const [first, ...rest] = suite.tasks;
  const withheldFrom = (covers: readonly string[]) => (covers.some((path) => (coveredWithheldFrom[path] ?? []).length > 0) ? covers.map((path) => [...(coveredWithheldFrom[path] ?? [])]) : undefined);
  const correctness = correctnessScorers(suite, input.correctnessRubric);
  const planned = (task: Task): PlannedTask => ({ id: task.id, sourceHash: task.sourceHash, startingCommit: task.startingCommit, judge: plannedJudge(task.judge, files.get(task.id)), covers: task.covers ? [...task.covers] : undefined, coversSkills: task.covers ? task.covers.map((path) => coveredSkills[path] ?? null) : undefined, coversWithheldFrom: task.covers ? withheldFrom(task.covers) : undefined });

  return definedFields<BenchmarkPlan>({
    schemaVersion: BENCHMARK_PLAN_SCHEMA_VERSION,
    suite: { name: suite.name, sourceHash: suite.sourceHash, repo: suite.repo },
    baselineTeamRevision: input.baselineTeamRevision,
    selection: input.selection,
    subset: input.isSubset === true ? true : undefined,
    repetitions: suite.repetitions,
    parallel: suite.parallel > 1 ? suite.parallel : undefined,
    limits: suite.trial,
    tasks: [planned(first), ...rest.map(planned)],
    arms: input.arms,
    defaultsArm: defaultsArmOf(suite)?.name,
    skillChanges: input.skillChanges && input.skillChanges.length > 0 ? input.skillChanges : undefined,
    scorers: Object.entries({ ...input.scorers, ...correctness }).map(([name, rubric]) => plannedScorer(name, rubric)),
    judges: plannedJudges(suite, { ...input.scorers, ...judgedCorrectness(suite, correctness) }),
    calibration: suite.calibrationRate > 0 ? { rate: suite.calibrationRate } : undefined,
    trials: trialsOf(suite.tasks, input.arms, suite.repetitions, suite.parallel),
  });
}

function plannedScorer(name: string, { pin, definition: { labels: [first, ...rest], passingScore } }: PinnedRubric): PlannedScorer {
  const planned = ({ value, score }: ScorerLabel) => ({ value, score });

  return { name, rubric: { sourceHash: pin.sourceHash }, labels: [planned(first), ...rest.map(planned)], passingScore };
}

/** The judge of each of `judged`, the scorers a judge labels: its rubric's tool, else the suite's defaults.tool, and its model. */
function plannedJudges(suite: Suite, judged: Record<string, PinnedRubric>): Record<string, PlannedJudge> {
  return Object.fromEntries(Object.entries(judged).map(([name, { definition: { tool, model } }]) => [name, { tool: tool ?? suite.defaults.tool, model: model ?? '' }]));
}

/** The correctness scorers of `correctness` a judge labels: those of the tasks with success criteria. */
function judgedCorrectness(suite: Suite, correctness: Record<string, PinnedRubric>): Record<string, PinnedRubric> {
  const judged = new Set(suite.tasks.filter((task) => task.judge.kind !== 'check').map((task) => correctnessScorerName(task.id)));

  return Object.fromEntries(Object.entries(correctness).filter(([name]) => judged.has(name)));
}

function plannedJudge(judge: TaskJudge, checkFiles: Added | undefined): PlannedTask['judge'] {
  if (judge.kind === 'criteria') return { kind: 'criteria' };
  const [added, ...more] = addedOf(judge.check, checkFiles);
  const check: PlannedCheck = { run: judge.check.run, protect: judge.check.protect };

  if (added) check.add = [added, ...more];

  return { kind: judge.kind, check };
}

/**
 * The run's `sourceHash`: over the suite file's hash and each task file's, so editing any of them changes it. A plan
 * and a record's benchmark block give the same hash.
 */
export function runSourceHash({ suite, tasks }: { suite: Pick<BenchmarkPlan['suite'], 'sourceHash'>; tasks: ReadonlyArray<Pick<BenchmarkPlan['tasks'][number], 'id' | 'sourceHash'>> }): string {
  return createHash('sha256').update(JSON.stringify([suite.sourceHash, ...tasks.map((task) => [task.id, task.sourceHash])])).digest('hex');
}

const BASELINES = 'baselines';

/** The end the generated workflow reaches once every trial step settled, whatever the trials' results. */
const SETTLED_END = 'settled';

/** A workflow step as a workflow file writes it, which admission parses. */
type FileStep = { id: string } & JsonObject;

/** What `compileBundle` answers: the workflow, as a workflow file writes it, its arms' workflow copies by key, and the generated scorers. */
export interface CompiledBundle {
  definition: JsonObject;
  workflows: Record<string, JsonObject>;
  scorers: Record<string, PinnedScorer>;
}

/**
 * The workflow a benchmark run's `from` step runs, as a workflow file writes it, with the generated correctness scorers
 * its prompts list. No `requires`, `timeout` or `invoke`: the step that runs it holds the strict sandbox, so every step
 * beneath it inherits that, and a team's own `teamai-benchmark` workflow may relax it; the run's own timeout bounds it.
 *
 *   baselines                     (tasks with a check only) outputs { <task>: its baseline's result }
 *     <task>                      needs the baseline `parallel` before it; command teamai benchmark check --baseline; workspace:
 *                                 a clone of the starting commit with team none; output { result }
 *   r<rep>                        one per repetition; the first needs [baselines] and an `if` that reads it when there are
 *                                 baselines, else needs []; each later one needs the one before it
 *     <task>                      needs the task before it
 *       <arm>                     needs the arm before it; a task with a check: if steps.baselines.outputs.<task> == 'failed';
 *                                 workspace: a clone of the starting commit with the arm's team; role: the arm's, when it has one
 *         prompt                  workspace continue; tool, exact model, limits under on_limit: end_turn; scorers;
 *                                 permissions: unattended when `unattended`
 *         | workflow              for an arm that runs one: its pinned copy, with { task }; workspace continue; the limits
 *                                 but max_turns as its allowance under on_limit: end_turn; scorers
 *         check                   needs [the one above]; command teamai benchmark check --trial; workspace continue (tasks with a check only)
 *   settled                       needs every scope above; an `if` that reads them; end: settled
 *
 * With `parallel` above 1, the repetitions sit in `lane<n>` scopes, one per lane a trial is in, each needing [baselines] as the first
 * repetition does, and each holding its share of the trials in plan order, the trial of order o in lane ((o - 1) mod n) + 1.
 *
 * Step ids are those `stepOf` and `baselineStepOf` name, under the step that runs the workflow. `unattended`: the step
 * that runs it is a strict sandbox, so its prompts may run unattended; an arm's workflow copies say so of their own.
 */
export function compileBundle(
  plan: BenchmarkPlan, { suite }: CommittedSuite, { armWorkflows = new Map(), unattended, correctnessRubric }: { armWorkflows?: ReadonlyMap<string, PinnedArmWorkflow>; unattended: boolean; correctnessRubric: string },
): CompiledBundle {
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const arms = new Map(plan.arms.map((arm) => [arm.name, arm]));
  const checkOutput = { result: CHECK_RESULTS.join(' | '), cause: 'string', label: 'string' };

  const baselines = chained(suite.tasks.flatMap((task): FileStep[] => (task.judge.kind !== 'criteria'
    ? [{ id: task.id, command: 'teamai benchmark check --baseline', workspace: { clone: { commit: task.startingCommit, repo: suite.repo, team: { treatment: 'none' } } }, output: checkOutput }]
    : [])), plan.parallel ?? 1);

  const tried = baselines.length > 0;

  const workOf = (arm: PlannedArm, task: Task): FileStep => {
    const names = trialScorersOf(suite, task);
    const pinned = armWorkflows.get(arm.name);
    const timeoutMs = plan.limits?.timeoutMs;
    const tokens = plan.limits?.tokens;
    // A workflow step's timeout and budget are an allowance its prompts spend; no allowance caps turns.
    const maxTurns = pinned ? undefined : plan.limits?.maxTurns;
    // Both fields are templates; escaped, the task's text renders as written, braces and all.
    const text = task.prompt.replaceAll('{{', '\\{{');
    const step: FileStep = pinned ? { id: 'workflow', workflow: pinned.key, with: { task: text } } : { id: 'prompt', prompt: text, tool: arm.tool };

    if (!pinned && arm.model) {
      const model: JsonObject = { name: arm.model };

      if (arm.effort) model.effort = arm.effort;
      step.model = model;
    }

    if (!pinned && unattended) step.permissions = 'unattended';
    step.workspace = 'continue';

    if (timeoutMs !== undefined) step.timeout = `${timeoutMs}ms`;

    if (maxTurns !== undefined) step.max_turns = maxTurns;

    if (tokens !== undefined) step.budget = { tokens };

    if (timeoutMs !== undefined || maxTurns !== undefined || tokens !== undefined) step.on_limit = 'end_turn';

    // The workflow's own teamai-score steps judge every trial, with the pins the trial ran under.
    if (names.length > 0) step.scorers = { names, sampling: 'all', start: 'workflow' };

    return step;
  };

  const trialOf = (trial: PlannedTrial): FileStep[] => {
    const task = tasks.get(trial.task);
    const arm = arms.get(trial.arm);

    if (!task || !arm) return [];
    const work = workOf(arm, task);
    const check = task.judge.kind !== 'criteria' ? [{ id: 'check', needs: [work.id], command: 'teamai benchmark check --trial', workspace: 'continue', output: checkOutput }] : [];
    const step: FileStep = { id: arm.name };

    if (task.judge.kind !== 'criteria') step.if = `steps.${BASELINES}.outputs.${task.id} == 'failed'`;
    // The arm's tool, not the first step's: a workflow arm may open its clone with a command.
    step.workspace = { clone: { commit: task.startingCommit, repo: suite.repo, team: cloneTeamOf(arm.team, { ...plan.selection, enabledAgents: [arm.tool] }, arm.recall) } };

    // On the step that opens the clone, so the prompt, a workflow arm's steps and the check all continue it with the role.
    if (arm.role !== undefined) step.role = arm.role;
    step.workflow = { steps: [work, ...check] };

    return [step];
  };

  // A lane's trials, in plan order, nested by repetition and task, each step after the one before it. A trial, not its
  // task, reads the baseline, so a task whose baseline skips its trials still settles, and the next one in the lane runs.
  const laneSteps = (trials: readonly PlannedTrial[]): FileStep[] => chained([...new Set(trials.map((trial) => trial.repetition))].map((repetition): FileStep => {
    const ofRepetition = trials.filter((trial) => trial.repetition === repetition);

    const taskSteps = [...new Set(ofRepetition.map((trial) => trial.task))].map((id): FileStep => ({
      id, workflow: { steps: chained(ofRepetition.filter((trial) => trial.task === id).flatMap(trialOf)) },
    }));

    return { id: `r${repetition}`, workflow: { steps: chained(taskSteps) } };
  }));

  const parallel = plan.parallel ?? 1;
  const afterBaselines: JsonObject = tried ? { needs: [BASELINES], if: `steps.${BASELINES}.outcome != null` } : { needs: [] };
  const [firstStep, ...laterSteps] = parallel > 1 ? [] : laneSteps(plan.trials);

  const repetitions: FileStep[] = parallel > 1
    // Only the lanes a trial is in: a suite may allow more than it has trials, and a workflow has no empty step list.
    ? Array.from({ length: parallel }, (_, index) => laneOf(index + 1)).flatMap((lane) => {
      const trials = plan.trials.filter((trial) => trial.step.startsWith(`${lane}.`));

      return trials.length > 0 ? [{ id: lane, ...afterBaselines, workflow: { steps: laneSteps(trials) } }] : [];
    })
    : [...(firstStep ? [{ ...firstStep, ...afterBaselines }] : []), ...laterSteps];

  const scopes: FileStep[] = [
    ...(tried ? [{ id: BASELINES, workflow: { outputs: Object.fromEntries(baselines.map(({ id }) => [id, `steps.${id}.outputs.result`])), steps: baselines } }] : []),
    ...repetitions,
  ];

  const needs = scopes.map(({ id }) => id);
  const definition: JsonObject = { schemaVersion: 'v1alpha1', name: suite.name, description: suite.description ?? `Benchmark suite ${suite.name}` };

  if (suite.setup) definition.setup = suite.setup;
  definition.ends = { [SETTLED_END]: 'succeeded' };
  definition.steps = [...scopes, { id: SETTLED_END, needs, if: needs.map((id) => `steps.${id}.outcome != null`).join(' && '), end: SETTLED_END }];

  return {
    definition,
    workflows: Object.fromEntries([...armWorkflows.values()].flatMap(({ files }) => Object.entries(files))),
    scorers: Object.fromEntries(Object.entries(correctnessScorers(suite, correctnessRubric)).map(([name, { pin }]) => [name, pin])),
  };
}

/**
 * `steps` in lanes of `lanes`: each needs the step `lanes` before it, whatever that one's outcome, so a lane runs one step
 * at a time; the first of each lane needs nothing.
 */
function chained(steps: readonly FileStep[], lanes = 1): FileStep[] {
  return steps.map((step, index) => {
    const before = steps[index - lanes];

    if (!before) return { ...step, needs: [] };
    const ran = `steps.${before.id}.outcome != null`;
    const condition = z.string().safeParse(step.if).data;

    return { ...step, needs: [before.id], if: condition === undefined ? ran : `${ran} && ${condition}` };
  });
}

/** `lane<n>`: the scope of the trials a suite with `parallel` above 1 runs in lane n. */
function laneOf(lane: number): string {
  return `lane${lane}`;
}

/** What check.add writes before `check`: its solution commit's files, then `checkFiles`, the suite directory's as committed. */
export function addedOf(check: TaskCheck, checkFiles: Added | undefined): Added[] {
  return [...(check.add ? [{ kind: 'solution' as const, ...check.add }] : []), ...(checkFiles ? [checkFiles] : [])];
}

/**
 * The team a trial's clone installs: the arm's, with the run's resource selection
 * and the arm's recall setting. The `never` branch is the point — a new ArmTeam
 * kind has to be handled here rather than fall through to the last treatment.
 */
function cloneTeamOf(team: ArmTeam, selection: TeamSelection, recall: boolean | undefined): CloneTeam {
  // Only the arm's setting adds the key; an arm that named none leaves the
  // team exactly as every other workflow clone has it.
  const asked = <T extends CloneTeam>(clone: T): T | (T & { recall: boolean }) => (recall === undefined || clone.treatment === 'none' ? clone : { ...clone, recall });

  switch (team.kind) {
    case 'none':
      return { treatment: 'none' };
    case 'pulled':
      return asked({ revision: team.revision, selection, treatment: 'pulled' });
    case 'ref':
      return asked({ revision: team.revision, selection, treatment: team.ref });
    case 'without':
      return asked({ revision: team.revision, selection, treatment: { without: team.paths } });
    default: {
      const unhandled: never = team;

      return unhandled;
    }
  }
}

/** The scorers that judge a trial of `task`: the suite's, the task's own, then its correctness scorer when it has success criteria. */
export function trialScorersOf(suite: Pick<Suite, 'scorers'>, task: Pick<Task, 'id' | 'scorers' | 'judge'>): string[] {
  return [...new Set([...suite.scorers, ...(task.scorers ?? [])]), ...(task.judge.kind !== 'check' ? [correctnessScorerName(task.id)] : [])];
}

/**
 * The scorer whose label decides each trial of a task, one that passes or one that fails: written by the trial's check,
 * or by a judge on its success criteria. Its name has a ":", which no scorer file name may have, so no team scorer can take it,
 * and one per task keeps one pin per name.
 */
export function correctnessScorerName(task: string): string {
  return `${CORRECTNESS_PREFIX}${task}`;
}

/** What every task's correctness scorer is named under; the judging shows them together by it. */
export const CORRECTNESS_SCORERS = 'teamai:correctness';

const CORRECTNESS_PREFIX = `${CORRECTNESS_SCORERS}:`;

/** Whether `scorer` is a task's correctness scorer, whose label decides a trial. */
export function isCorrectnessScorer(scorer: string): boolean {
  return scorer.startsWith(CORRECTNESS_PREFIX);
}

/**
 * The correctness scorer of each task, as the run pins it: `rubric`, teamai's default scorer teamai-correctness or the
 * team's file of that name, filled in with the task's prompt and success criteria, empty for a task judged only by its
 * check. `generated`, so it is read as `scorers/correctness.md` and named by its key, and `relativePath` is the task
 * file, so a message names a file that exists. Its hash covers the filled-in text, so a team's rubric is a new rubric.
 */
function correctnessScorers(suite: Suite, rubric: string): Record<string, PinnedRubric> {
  return Object.fromEntries(suite.tasks.map((task) => [correctnessScorerName(task.id), correctnessPin(task, rubric)]));
}

function correctnessPin(task: Task, rubric: string): PinnedRubric {
  const scorer = correctnessScorerName(task.id);
  const values = { 'task.prompt': task.prompt, 'task.successCriteria': TaskJudge.criteriaOf(task.judge) ?? '' };
  const { content, definition: { labels: [first, ...rest], passingScore, tool, model } } = DefaultScorers.fillIn('teamai-correctness', { file: `scorers/${scorer.replaceAll(':', '-')}.md`, content: rubric }, values);

  return {
    pin: { sourceHash: createHash('sha256').update(content).digest('hex'), relativePath: task.relativePath, content, generated: true },
    definition: definedFields<PinnedRubric['definition']>({ labels: [first, ...rest], passingScore, tool, model }),
  };
}
