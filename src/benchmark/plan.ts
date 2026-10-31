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
import { isLabelShaped, isNameShaped } from '../agent-observation.js';
import type { PinnedScorer } from '../scorers/pin.js';
import type { Suite, Task, TaskJudge } from './suite.js';
import type { CommittedSuite } from './trial.js';
import type { PinnedArmWorkflow } from './arm-workflow.js';
import { CommitSchema, TeamSelectionSchema, type CloneTeam, type TeamSelection } from '../workflow/clone.js';
import { CHECK_RESULTS } from './check.js';
import { AddedSchema, ArmTeamSchema, BenchmarkNameSchema, SkillChangesSchema, TrialLimitsSchema, type Added, type ArmTeam, type SkillChanges } from './terms.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const PlannedArmSchema = z.object({
  name: BenchmarkNameSchema,
  /** Shaped like the names a record publishes, as start checks, so a run file that holds anything else reads as corrupt. */
  tool: z.string().refine(isLabelShaped),
  /** The model name the arm's alias resolved to at start, or its model name as written; absent: the tool's default. */
  model: z.string().refine(isNameShaped).optional(),
  /** The alias the suite named, when the model came from one: what arms on different tools share. */
  alias: z.string().refine(isNameShaped).optional(),
  effort: z.string().refine(isLabelShaped).optional(),
  /** Whose aliases resolved the model: the team's, or the member's with `--member-aliases`. */
  source: z.enum(['team', 'member']),
  /** The team assets the arm's trials get. */
  team: ArmTeamSchema,
  /** The team workflow the arm's trials run on each task instead of one prompt, by the hash of its sources and theirs. */
  workflow: z.object({ name: z.string().min(1), sourceHash: Sha256 }).strict().optional(),
}).strict();
export type PlannedArm = z.infer<typeof PlannedArmSchema>;

const PlannedTaskSchema = z.object({
  id: BenchmarkNameSchema,
  sourceHash: Sha256,
  startingCommit: CommitSchema,
  /**
   * A check task's check, which `teamai benchmark check` reads: the command, the protected paths, and the files check.add
   * writes, by commit and path, never their bytes. A task judged by its success criteria has none.
   */
  judge: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('check'), run: z.string().min(1), protect: z.array(z.string().min(1)).nonempty(), add: z.array(AddedSchema).nonempty().optional() }).strict(),
    z.object({ kind: z.literal('criteria') }).strict(),
  ]),
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

/** The plan's `schemaVersion`. A plan of another version makes the run unreadable here, so no step reads it. */
export const BENCHMARK_PLAN_SCHEMA_VERSION = 1;

/**
 * What a run freezes at start. In PINNED (store.ts) so masking never rewrites it, parsed by RunProgressSchema so a
 * malformed plan makes the run corrupt rather than unplanned, and `drop` in RUN_RULES (snapshot.ts) because benchmark
 * runs are never published. No prompt, credential URL or local path; the check command is in it, and the record copies
 * no field that holds it.
 */
export const BenchmarkPlanSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_PLAN_SCHEMA_VERSION),
  suite: z.object({ name: BenchmarkNameSchema, sourceHash: Sha256, repo: z.string().url() }).strict(),
  baselineTeamRevision: CommitSchema,
  selection: TeamSelectionSchema,
  repetitions: z.number().int().min(1).max(10),
  /** The lanes the trials run in, each one trial at a time; absent: one. A trial's step is under `lane<n>` with more than one. */
  parallel: z.number().int().positive().optional(),
  /** The suite's `trial`: the limits of every trial's prompt. */
  limits: TrialLimitsSchema.optional(),
  tasks: z.array(PlannedTaskSchema).nonempty(),
  arms: z.array(PlannedArmSchema).nonempty(),
  /** Each arm whose team assets differ from the baseline's in skills, with those skills. */
  skillChanges: z.array(SkillChangesSchema).optional(),
  /** Every scorer that judges a trial, the generated correctness scorers included, with the rubric hash it was pinned with. */
  scorers: z.array(z.object({ name: z.string().min(1), rubric: z.object({ sourceHash: z.string().min(1) }).strict() }).strict()),
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
  /** The team scorers the suite lists, as start pinned them. */
  scorers: Record<string, PinnedScorer>;
  skillChanges?: SkillChanges[];
}): BenchmarkPlan {
  const { suite, files } = input.committed;
  const [first, ...rest] = suite.tasks;
  const planned = (task: Task): PlannedTask => ({ id: task.id, sourceHash: task.sourceHash, startingCommit: task.startingCommit, judge: plannedJudge(task.judge, files.get(task.id)) });
  return {
    schemaVersion: BENCHMARK_PLAN_SCHEMA_VERSION,
    suite: { name: suite.name, sourceHash: suite.sourceHash, repo: suite.repo },
    baselineTeamRevision: input.baselineTeamRevision,
    selection: input.selection,
    repetitions: suite.repetitions,
    ...(suite.parallel > 1 ? { parallel: suite.parallel } : {}),
    ...(suite.trial ? { limits: suite.trial } : {}),
    tasks: [planned(first), ...rest.map(planned)],
    arms: input.arms,
    ...(input.skillChanges && input.skillChanges.length > 0 ? { skillChanges: input.skillChanges } : {}),
    scorers: Object.entries({ ...input.scorers, ...correctnessScorers(suite) }).map(([name, pin]) => ({ name, rubric: { sourceHash: pin.sourceHash } })),
    trials: trialsOf(suite.tasks, input.arms, suite.repetitions, suite.parallel),
  };
}

function plannedJudge(judge: TaskJudge, checkFiles: Added | undefined): PlannedTask['judge'] {
  switch (judge.kind) {
    case 'check': {
      const [added, ...more] = addedOf(judge, checkFiles);
      return { kind: 'check', run: judge.run, protect: judge.protect, ...(added ? { add: [added, ...more] } : {}) };
    }
    case 'criteria':
      return { kind: 'criteria' };
    default: {
      const unhandled: never = judge;
      return unhandled;
    }
  }
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
type FileStep = { id: string } & Record<string, unknown>;

/**
 * The workflow a benchmark run's `from` step runs, as a workflow file writes it, with the generated correctness scorers
 * its prompts list. No `requires`, `timeout` or `invoke`: the step that runs it holds the strict sandbox, so every step
 * beneath it inherits that, and a team's own `teamai-benchmark` workflow may relax it; the run's own timeout bounds it.
 *
 *   baselines                     (check tasks only) outputs { <task>: its baseline's result }
 *     <task>                      needs the baseline `parallel` before it; command teamai benchmark check --baseline; workspace:
 *                                 a clone of the starting commit with team none; output { result }
 *   r<rep>                        one per repetition; the first needs [baselines] and an `if` that reads it when there are
 *                                 baselines, else needs []; each later one needs the one before it
 *     <task>                      needs the task before it
 *       <arm>                     needs the arm before it; a check task's: if steps.baselines.outputs.<task> == 'failed';
 *                                 workspace: a clone of the starting commit with the arm's team
 *         prompt                  workspace continue; tool, exact model, limits under on_limit: end_turn; scorers;
 *                                 permissions: unattended when `unattended`
 *         | workflow              for an arm that runs one: its pinned copy, with { task }; workspace continue; the limits
 *                                 but max_turns as its allowance under on_limit: end_turn; scorers
 *         check                   needs [the one above]; command teamai benchmark check --trial; workspace continue (check tasks only)
 *   settled                       needs every scope above; an `if` that reads them; end: settled
 *
 * With `parallel` above 1, the repetitions sit in `lane<n>` scopes, one per lane a trial is in, each needing [baselines] as the first
 * repetition does, and each holding its share of the trials in plan order, the trial of order o in lane ((o - 1) mod n) + 1.
 *
 * Step ids are those `stepOf` and `baselineStepOf` name, under the step that runs the workflow. `unattended`: the step
 * that runs it is a strict sandbox, so its prompts may run unattended; an arm's workflow copies say so of their own.
 */
export function compileBundle(
  plan: BenchmarkPlan, { suite }: CommittedSuite, { armWorkflows = new Map(), unattended }: { armWorkflows?: ReadonlyMap<string, PinnedArmWorkflow>; unattended: boolean },
): {
  definition: Record<string, unknown>; workflows: Record<string, Record<string, unknown>>; scorers: Record<string, PinnedScorer>;
} {
  const tasks = new Map(suite.tasks.map((task) => [task.id, task]));
  const arms = new Map(plan.arms.map((arm) => [arm.name, arm]));
  const checkOutput = { result: CHECK_RESULTS.join(' | ') };
  const baselines = chained(suite.tasks.flatMap((task): FileStep[] => (task.judge.kind === 'check'
    ? [{ id: task.id, command: 'teamai benchmark check --baseline', workspace: { clone: { commit: task.startingCommit, repo: suite.repo, team: { treatment: 'none' } } }, output: checkOutput }]
    : [])), plan.parallel ?? 1);
  const tried = baselines.length > 0;
  const workOf = (arm: PlannedArm, task: Task): FileStep => {
    const names = [...suite.scorers, ...(task.judge.kind === 'criteria' ? [correctnessScorerName(task.id)] : [])];
    const limits = plan.limits;
    const pinned = armWorkflows.get(arm.name);
    // A workflow step's timeout and budget are an allowance its prompts spend; no allowance caps turns.
    const ends = { ...limits, ...(pinned ? { maxTurns: undefined } : {}) };
    return {
      ...(pinned
        ? { id: 'workflow', workflow: pinned.key, with: { task: task.prompt } }
        : { id: 'prompt', prompt: task.prompt, tool: arm.tool, ...(arm.model ? { model: { name: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) } } : {}), ...(unattended ? { permissions: 'unattended' } : {}) }),
      workspace: 'continue',
      ...(ends.timeoutMs !== undefined ? { timeout: `${ends.timeoutMs}ms` } : {}),
      ...(ends.maxTurns !== undefined ? { max_turns: ends.maxTurns } : {}),
      ...(ends.tokens !== undefined ? { budget: { tokens: ends.tokens } } : {}),
      ...(ends.timeoutMs !== undefined || ends.maxTurns !== undefined || ends.tokens !== undefined ? { on_limit: 'end_turn' } : {}),
      ...(names.length > 0 ? { scorers: { names, sampling: 'all' } } : {}),
    };
  };
  const trialOf = (trial: PlannedTrial): FileStep[] => {
    const task = tasks.get(trial.task);
    const arm = arms.get(trial.arm);
    if (!task || !arm) return [];
    const work = workOf(arm, task);
    const check = task.judge.kind === 'check' ? [{ id: 'check', needs: [work.id], command: 'teamai benchmark check --trial', workspace: 'continue', output: checkOutput }] : [];
    return [{
      id: arm.name, ...(task.judge.kind === 'check' ? { if: `steps.${BASELINES}.outputs.${task.id} == 'failed'` } : {}),
      // The arm's tool, not the first step's: a workflow arm may open its clone with a command.
      workspace: { clone: { commit: task.startingCommit, repo: suite.repo, team: cloneTeamOf(arm.team, { ...plan.selection, enabledAgents: [arm.tool] }) } },
      workflow: { steps: [work, ...check] },
    }];
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
  const afterBaselines = tried ? { needs: [BASELINES], if: `steps.${BASELINES}.outcome != null` } : { needs: [] };
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
  return {
    definition: {
      schemaVersion: 'v1alpha1',
      name: suite.name,
      description: suite.description ?? `Benchmark suite ${suite.name}`,
      ...(suite.setup ? { setup: suite.setup } : {}),
      ends: { [SETTLED_END]: 'succeeded' },
      steps: [...scopes, { id: SETTLED_END, needs, if: needs.map((id) => `steps.${id}.outcome != null`).join(' && '), end: SETTLED_END }],
    },
    workflows: Object.fromEntries([...armWorkflows.values()].flatMap(({ files }) => Object.entries(files))),
    scorers: correctnessScorers(suite),
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
    return { ...step, needs: [before.id], if: typeof step.if === 'string' ? `${ran} && ${step.if}` : ran };
  });
}

/** `lane<n>`: the scope of the trials a suite with `parallel` above 1 runs in lane n. */
function laneOf(lane: number): string {
  return `lane${lane}`;
}

/** What check.add writes before a check of `judge`: its fix's files, then `checkFiles`, the suite directory's as committed. */
export function addedOf(judge: Extract<TaskJudge, { kind: 'check' }>, checkFiles: Added | undefined): Added[] {
  return [...(judge.add ? [{ kind: 'fix' as const, ...judge.add }] : []), ...(checkFiles ? [checkFiles] : [])];
}

/** The team a trial's clone installs: the arm's, with the run's asset selection. */
function cloneTeamOf(team: ArmTeam, selection: TeamSelection): CloneTeam {
  switch (team.kind) {
    case 'none':
      return { treatment: 'none' };
    case 'pulled':
      return { revision: team.revision, selection, treatment: 'pulled' };
    case 'ref':
      return { revision: team.revision, selection, treatment: team.ref };
    case 'without':
      return { revision: team.revision, selection, treatment: { without: team.paths } };
    default: {
      const unhandled: never = team;
      return unhandled;
    }
  }
}

/**
 * The scorer that labels a task judged by success criteria `correct` or `incorrect` on each of its trials. Its name has a
 * ":", which no scorer file name may have, so no team scorer can take it, and one per task keeps one pin per name.
 */
export function correctnessScorerName(task: string): string {
  return `teamai:correctness:${task}`;
}

/**
 * The correctness scorer of each task judged by success criteria, as the run pins it: `generated`, so it is read as
 * `scorers/correctness.md` and named by its key, and `relativePath` is the task file, so a message names a file that
 * exists. Its hash covers the task's prompt and success criteria. No `model`: the judge tool's default model runs it.
 */
function correctnessScorers(suite: Suite): Record<string, PinnedScorer> {
  return Object.fromEntries(suite.tasks.flatMap((task) => (task.judge.kind === 'criteria' ? [[correctnessScorerName(task.id), correctnessPin(task, task.judge.successCriteria)]] : [])));
}

function correctnessPin(task: Task, successCriteria: string): PinnedScorer {
  const content = [
    '---',
    'labels:',
    '  - { value: correct, score: 1, description: The change meets every success criterion. }',
    '  - { value: incorrect, score: 0, description: The change misses at least one success criterion. }',
    'passingScore: 1',
    'samplingRate: 100',
    '---',
    'Judge whether the change made from the starting commit, commits included, meets the success criteria.',
    'Read the task to understand the intent. Decide only on the success criteria.',
    '',
    '## Task',
    '',
    task.prompt,
    '',
    '## Success criteria',
    '',
    successCriteria,
    '',
  ].join('\n');
  return { sourceHash: createHash('sha256').update(content).digest('hex'), relativePath: task.relativePath, content, generated: true };
}
