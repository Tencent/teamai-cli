/**
 * How each scorer of a benchmark trial ended: labelled, by whom, or unscored and why. Built when the run's steps ended.
 * A check task's correctness label is the one its check step stored, named by the version the step output; every other
 * scorer's comes from the results of the run's `workflow: teamai-score` steps, each item of which labels one trial
 * pass. Both are read from the labels on this machine, which hold a label's score, whether it passes, who decided it,
 * and what its judge cost.
 */
import { z } from 'zod';
import { definedFields } from '../utils/defined-fields.js';
import { CheckOutputSchema, type CheckOutput } from '../scorers/check.js';
import { LabelStore } from '../scorers/label-store.js';
import { isStageDecider, labelVersion, type ScoreLabel } from '../scorers/label.js';
import { LABEL_CODES, ScoreLabels } from '../scorers/score-labels.js';
import type { LocalConfig } from '../types.js';
import { stepDefinitions } from '../workflow/scope.js';
import { ConfinedRunReportSchema, wasLeased, type ConfinedRunReport, type ItemResult, type StepState } from '../workflow/step-state.js';
import { stepWorkflow, type RunState, type WorkflowStep } from '../workflow/types.js';
import { COMPARISONS, compareJudge } from './agent-match.js';
import { isCalibrationCandidate } from './calibration.js';
import { checkStepOf, correctnessScorerName, type PlannedJudge, type PlannedTask } from './plan.js';
import type { RunPlan } from './run-plan.js';
import { SCORE_WORKFLOW } from '../scorers/judging-workflows.js';
import { Subject } from '../scorers/subject.js';

/** No label and no code: no check or `teamai-score` step labelled the scorer before the run's steps ended. */
const RUN_ENDED = 'run_ended';

/** No label: no driver of the run offered the judge tool the plan requires, so the skill driver gave the judge step up. */
const JUDGE_TOOL_UNAVAILABLE = 'judge_tool_unavailable';

/**
 * A judge that decided a label: its rubric's hash, the tool it ran in, the model and effort its tool reported, else those
 * it was launched with, and whether it judged in a batch.
 */
const JudgeDeciderSchema = z.object({
  by: z.literal('judge'), rubric: z.string().min(1), tool: z.string().min(1), model: z.string().min(1).optional(), effort: z.string().min(1).optional(), batched: z.boolean(),
}).strict();

type JudgeDecider = z.infer<typeof JudgeDeciderSchema>;

/** Who decided a label: a task's check, named by the task's hash, or a judge. */
const VerdictDeciderSchema = z.discriminatedUnion('by', [z.object({ by: z.literal('check'), task: z.string().min(1) }).strict(), JudgeDeciderSchema]);

/**
 * How one scorer of a recorded trial ended. `decider`: absent for an unscored scorer, and for a label no check or judge
 * decided, such as a person's.
 */
export const TrialVerdictSchema = z.object({
  scorer: z.string().min(1),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('labelled'), label: z.string().min(1), score: z.number(), passed: z.boolean() }).strict(),
    z.object({ kind: z.literal('unscored'), because: z.enum([...LABEL_CODES, RUN_ENDED, JUDGE_TOOL_UNAVAILABLE]) }).strict(),
  ]),
  decider: VerdictDeciderSchema.optional(),
  /** How a judge's label compares with the judge the plan pins its scorer to (`compareJudge`); absent for a check's label. */
  asPlanned: z.enum(COMPARISONS).optional(),
}).strict();

export type TrialVerdict = z.infer<typeof TrialVerdictSchema>;

/** What a judge's tool stated judging a trial cost; `complete`: the tool stated all of it. */
const ScoringCostSchema = z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).strict();

export const EntryVerdictSchema = TrialVerdictSchema.extend({
  step: z.string().min(1),
  pass: z.number().int().positive(),
}).strict();

/**
 * What judging a trial cost, from every judge launch of it: the cost the launches stated, `complete: false` when one
 * stated none or another unit; `{ complete: false }` alone when launches ran and none stated a cost.
 */
export const TrialScoringCostSchema = z.union([ScoringCostSchema, z.object({ complete: z.literal(false) }).strict()]);

type TrialScoringCost = z.infer<typeof TrialScoringCostSchema>;

export type EntryVerdict = z.infer<typeof EntryVerdictSchema>;

/**
 * What a trial's correctness judge labelled work its check failed, storing nothing (calibration.ts): the label, whether
 * it passes by the scorer's labels and passing score, the judge, and what its tool reported judging it cost. Never one
 * of the trial's verdicts.
 */
export const TrialCalibrationSchema = z.object({
  label: z.string().min(1), passed: z.boolean(), decider: JudgeDeciderSchema,
  scoringCost: ScoringCostSchema.optional(),
}).strict();

export type TrialCalibration = z.infer<typeof TrialCalibrationSchema>;

export type EntryCalibration = TrialCalibration & { step: string; pass: number };

type Judged = Pick<EntryVerdict, 'outcome' | 'decider' | 'asPlanned'>;

/** What `teamai score label` printed of one scorer: its label, or the code of why it has none; the other is ''. */
const LabelEntrySchema = z.object({ scorer: z.string(), label: z.string(), code: z.union([z.enum(LABEL_CODES), z.literal('')]) });

type ScoredEntry = Omit<z.infer<typeof LabelEntrySchema>, 'scorer'>;

/** What one group of a `teamai-score` item gave: its entries, and the version of each label its write stored, if it did. */
const GroupOutputsSchema = z.object({ labels: z.array(LabelEntrySchema), written: z.array(z.string()).nullish() });

/** One item of a `teamai-score` step: the subject it labelled, the entries of every group, and the labels they stored. */
const ScoredItemSchema = z.object({
  item: z.string(),
  outputs: z.object({ labels: z.array(z.object({ outputs: GroupOutputsSchema.optional() })) }).optional(),
}).transform(({ item, outputs }) => {
  const groups = (outputs?.labels ?? []).flatMap((group) => (group.outputs ? [group.outputs] : []));

  return { item, entries: groups.flatMap((group) => group.labels), written: groups.flatMap((group) => group.written ?? []) };
});

/** What a `teamai-score` step gave a subject: the entry of each scorer, and the version of each label its writes stored. */
interface Scored {
  entries: Map<string, ScoredEntry>;
  written: Set<string>;
}

function runsTeamaiScore(step: WorkflowStep | undefined): boolean {
  const child = step ? stepWorkflow(step) : undefined;

  return child?.kind === 'named' && child.name === SCORE_WORKFLOW;
}

/** A `teamai-score` instance whose `store` input is false: its labels were only tried, and none was stored. */
const TriedInstanceSchema = z.object({ inputs: z.object({ store: z.literal(false) }) });

/** The item results of every `teamai-score` step of `run` whose instance stores its labels. */
function scoreResults(run: RunState): ItemResult[] {
  const definitionOf = stepDefinitions(run);
  const stateOf = (id: string): StepState | undefined => run.steps.find((state) => state.id === id);

  return run.steps.flatMap((state) => ('results' in state && runsTeamaiScore(definitionOf(state.id))
    ? (state.results ?? []).filter((_, index) => !TriedInstanceSchema.safeParse(stateOf(`${state.id}[${index}]`)).success)
    : []));
}

/** What the `teamai-score` steps of `run` gave each subject they labelled. */
function scoredEntries(run: RunState): Map<string, Scored> {
  const bySubject = new Map<string, Scored>();

  for (const result of scoreResults(run)) {
    const scored = ScoredItemSchema.safeParse(result);

    if (!scored.success) continue;
    const kept = bySubject.get(scored.data.item) ?? { entries: new Map<string, ScoredEntry>(), written: new Set<string>() };

    for (const { scorer, label, code } of scored.data.entries) kept.entries.set(scorer, { label, code });

    for (const version of scored.data.written) kept.written.add(version);
    bySubject.set(scored.data.item, kept);
  }

  return bySubject;
}

/** The group a `teamai-score` instance judges, as `teamai score plan` printed it: its subject and its scorers, joined by `,`. */
const GroupItemSchema = z.object({ subject: z.string(), scorers: z.string() });

/** A group of a `teamai-score` instance, with the entries its `score label` step gave. */
const LabelledGroupSchema = z.object({ item: GroupItemSchema, outputs: z.object({ labels: z.array(LabelEntrySchema) }) });

const JudgedStepSchema = z.object({ confined: ConfinedRunReportSchema });

/** A label a tried `teamai-score` instance gave a scorer: its value, the run of the judge that gave it, and whether that judge batched. */
interface TriedLabel {
  label: string;
  judge: ConfinedRunReport;
  batched: boolean;
}

/**
 * By subject, the label each tried `teamai-score` instance of `run` gave each scorer: an entry of a group's `labels`
 * output, whose judge step reported the confined run that gave it. A group a stage decided ran no judge, so it gives none.
 */
function triedLabels(run: RunState): Map<string, Map<string, TriedLabel>> {
  const definitionOf = stepDefinitions(run);
  const instances = run.steps.filter((state) => runsTeamaiScore(definitionOf(state.id)) && TriedInstanceSchema.safeParse(state).success);
  const bySubject = new Map<string, Map<string, TriedLabel>>();

  for (const state of run.steps) {
    const group = instances.some(({ id }) => state.id.startsWith(`${id}.`)) ? LabelledGroupSchema.safeParse(state).data : undefined;
    const [judge] = group ? run.steps.flatMap((one) => (one.id.startsWith(`${state.id}.`) ? JudgedStepSchema.safeParse(one).data?.confined ?? [] : [])) : [];

    if (!group || !judge) continue;
    const kept = bySubject.get(group.item.subject) ?? new Map<string, TriedLabel>();
    const batched = group.item.scorers.split(',').length > 1;

    for (const { scorer, label } of group.outputs.labels) if (label !== '') kept.set(scorer, { label, judge, batched });
    bySubject.set(group.item.subject, kept);
  }

  return bySubject;
}

/**
 * By subject, the scorers whose `teamai-score` group the skill driver cancelled because no driver of the run could take
 * a step of it confined to a directory: its judge, held for a tool no driver offered.
 */
function givenUpJudges(run: RunState): Map<string, Set<string>> {
  const givenUp = new Map<string, Set<string>>();

  for (const state of run.steps) {
    const group = GroupItemSchema.safeParse(state.item);

    if (state.status !== 'cancelled' || state.failure.code !== 'confined_unoffered' || !group.success) continue;
    const scorers = givenUp.get(group.data.subject) ?? new Set<string>();

    for (const scorer of group.data.scorers.split(',')) scorers.add(scorer);
    givenUp.set(group.data.subject, scorers);
  }

  return givenUp;
}

function labelledOf(stored: ScoreLabel, decider: TrialVerdict['decider']): Judged {
  return definedFields<Judged>({ outcome: { kind: 'labelled', label: stored.label, score: stored.score, passed: stored.passed }, decider });
}

/** A judge that decided `stored`: its model judge, unless a stage decided it before any judge ran. */
function judgeOf(stored: ScoreLabel): JudgeDecider | undefined {
  const { judge } = stored;

  if (judge.kind !== 'model' || (stored.source === 'workflow' && isStageDecider(stored.decidedBy))) return undefined;

  return judgeDecider(stored.rubric.sourceHash, { ...judge, batched: judge.batched === true });
}

/** The judge of a label of rubric `rubric`, from the run that gave it: the model and effort its tool reported, else those it was launched with. */
function judgeDecider(rubric: string, { tool, model, effort, batched }: Pick<ConfinedRunReport, 'tool' | 'model' | 'effort'> & { batched: boolean }): JudgeDecider {
  return definedFields<JudgeDecider>({ by: 'judge', rubric, tool, model: model?.reported ?? model?.requested, effort: effort?.reported ?? effort?.requested, batched });
}

function verdictOf(entry: ScoredEntry | undefined, stored: ScoreLabel | undefined, { planned, isGivenUp }: { planned: PlannedJudge | undefined; isGivenUp: boolean }): Judged {
  if (entry?.code) return { outcome: { kind: 'unscored', because: entry.code } };

  // A label the write never recorded is no label.
  if (!entry || !stored) return { outcome: { kind: 'unscored', because: isGivenUp ? JUDGE_TOOL_UNAVAILABLE : RUN_ENDED } };
  const verdict = labelledOf(stored, judgeOf(stored));

  if (planned && verdict.decider?.by === 'judge' && stored.judge.kind === 'model') verdict.asPlanned = compareJudge(planned, stored.judge);

  return verdict;
}

/**
 * Whether a trial's check, not a judge, gives its correctness label, from what its check step `output`: always for a
 * task with no success criteria, and for one with them unless its check passed, since a judge decides only after a
 * check that passed. A check that could not run, or never ran, leaves the trial unscored, whatever a judge said.
 */
export function isDecidedByCheck(task: PlannedTask, output: CheckOutput | undefined): boolean {
  return task.judge.kind === 'check' || (task.judge.kind === 'both' && output?.result !== 'passed');
}

/**
 * The correctness verdict of a trial its check decides, from what its check step output: the label whose version it
 * names, decided by the task's check; `check_could_not_run` when the check could not run; `run_ended` when the step
 * output nothing, or named a label this machine does not hold.
 */
function checkedOf(checked: CheckOutput | undefined, labels: readonly ScoreLabel[], task: PlannedTask): Judged {
  if (!checked) return { outcome: { kind: 'unscored', because: RUN_ENDED } };

  switch (checked.result) {
    case 'could_not_run':
      return { outcome: { kind: 'unscored', because: 'check_could_not_run' } };
    case 'passed':
    case 'failed': {
      const stored = labels.find((label) => labelVersion(label) === checked.label);

      return stored ? labelledOf(stored, { by: 'check', task: task.sourceHash }) : { outcome: { kind: 'unscored', because: RUN_ENDED } };
    }

    default: {
      const unhandled: never = checked;

      return unhandled;
    }
  }
}

/** One judge launch of a `teamai-score` group: the subject it judged, whether its instance only tried its labels, and what its tool stated it cost. */
interface JudgeLaunch {
  subject: string;
  isTried: boolean;
  cost: { amount: number; unit: string } | undefined;
}

/**
 * Every judge launch of `run`'s `teamai-score` instances: the judge step of each group that ran, whether it succeeded,
 * failed or was cancelled once started, so a launch whose label was refused or left out still counts. A group a stage
 * decided launched no judge.
 */
function judgeLaunches(run: RunState): JudgeLaunch[] {
  const definitionOf = stepDefinitions(run);
  const instances = run.steps.filter((state) => runsTeamaiScore(definitionOf(state.id)));
  const hasRun = (judge: StepState | undefined): judge is StepState => judge?.status === 'succeeded' || judge?.status === 'failed' || (judge?.status === 'cancelled' && wasLeased(judge));

  return run.steps.flatMap((state) => {
    const instance = instances.find(({ id }) => state.id.startsWith(`${id}.`));
    const group = instance ? GroupItemSchema.safeParse(state.item).data : undefined;
    const judge = group ? run.steps.find(({ id }) => id === `${state.id}.judge`) : undefined;

    if (!instance || !group || !hasRun(judge)) return [];

    return [{ subject: group.subject, isTried: TriedInstanceSchema.safeParse(instance).success, cost: ScoreLabels.spent(run, judge.id)?.cost }];
  });
}

/** What `launches` cost in the unit the first that stated a cost used: incomplete when another stated none or another unit; undefined when none ran. */
function costOfLaunches(launches: readonly JudgeLaunch[]): TrialScoringCost | undefined {
  const [first] = launches.flatMap(({ cost }) => cost ?? []);

  if (launches.length === 0) return undefined;

  if (!first) return { complete: false };
  const inUnit = launches.flatMap(({ cost }) => (cost?.unit === first.unit ? [cost] : []));

  return { amount: inUnit.reduce((sum, cost) => sum + cost.amount, 0), unit: first.unit, complete: inUnit.length === launches.length };
}

export const TrialVerdicts = {
  /**
   * A verdict for each scorer each trial of `plan` pinned, on the pass the trial ran, as its steps ended: its
   * correctness scorer first, whether its check or a judge decided it, then the suite's scorers.
   */
  async of(config: LocalConfig, run: RunState, { plan, prefix }: RunPlan): Promise<EntryVerdict[]> {
    const definitionOf = stepDefinitions(run);
    const scored = scoredEntries(run);
    const givenUp = givenUpJudges(run);
    const labels = await LabelStore.local(config);
    const stateOf = (id: string): StepState | undefined => run.steps.find((state) => state.id === id);

    return plan.trials.flatMap((trial) => {
      const step = `${prefix}${trial.step}`;
      const pass = stateOf(step)?.pass ?? 1;
      const item = Subject.format({ kind: 'run', subject: { runId: run.id, step, pass } });
      const subject = scored.get(item);
      const task = plan.tasks.find(({ id }) => id === trial.task);
      const correctness = correctnessScorerName(trial.task);
      const check = stateOf(`${prefix}${checkStepOf(trial)}`);
      const output = CheckOutputSchema.safeParse(check && 'outputs' in check ? check.outputs : undefined).data;
      const checked = task !== undefined && isDecidedByCheck(task, output) ? [{ scorer: correctness, step, pass, ...checkedOf(output, labels, task) }] : [];

      const judged = (definitionOf(step)?.scorers?.names ?? []).map((scorer) => {
        const entry = subject?.entries.get(scorer);
        const stored = labels.find((label) => label.scorer === scorer && subject?.written.has(labelVersion(label)) === true);

        return { scorer, step, pass, ...verdictOf(entry, stored, { planned: plan.judges[scorer], isGivenUp: givenUp.get(item)?.has(scorer) === true }) };
      });

      // A failed check of a task with success criteria leaves its correctness scorer no judge, so only the check's verdict.
      return [...checked, ...judged.filter(({ scorer }) => scorer === correctness && checked.length === 0), ...judged.filter(({ scorer }) => scorer !== correctness)];
    });
  },

  /**
   * What judging each trial pass of `run` cost, from every judge launch of it rather than from the labels kept: those that
   * stored its labels, and those that only tried one unless its calibration carries that cost. A batched launch counts
   * once for every scorer it judged; a launch whose label was refused, or left out because the check could not run, counts
   * too. Undefined when no launch ran.
   */
  judgingCosts(run: RunState): (trial: { step: string; pass: number; isCalibrated: boolean }) => TrialScoringCost | undefined {
    const launches = judgeLaunches(run);

    return ({ step, pass, isCalibrated }) => {
      const item = Subject.format({ kind: 'run', subject: { runId: run.id, step, pass } });

      return costOfLaunches(launches.filter(({ subject, isTried }) => subject === item && !(isTried && isCalibrated)));
    };
  },

  /**
   * The calibration of each trial of `plan` its correctness judge labelled though its check failed, on the pass the trial
   * ran: the label a tried `teamai-score` instance gave its correctness scorer, never one a stage decided.
   */
  calibrations(run: RunState, { plan, prefix }: RunPlan): EntryCalibration[] {
    const labels = triedLabels(run);
    const stateOf = (id: string): StepState | undefined => run.steps.find((state) => state.id === id);

    return plan.trials.flatMap((trial) => {
      const step = `${prefix}${trial.step}`;
      const pass = stateOf(step)?.pass ?? 1;
      const task = plan.tasks.find(({ id }) => id === trial.task);
      const check = stateOf(`${prefix}${checkStepOf(trial)}`);
      const output = CheckOutputSchema.safeParse(check && 'outputs' in check ? check.outputs : undefined).data;
      const scorer = plan.scorers.find(({ name }) => name === correctnessScorerName(trial.task));
      const tried = labels.get(Subject.format({ kind: 'run', subject: { runId: run.id, step, pass } }))?.get(correctnessScorerName(trial.task));
      const given = scorer?.labels.find(({ value }) => value === tried?.label);

      if (!task || !isCalibrationCandidate(task, output) || !tried || !scorer || !given) return [];

      const cost = tried.judge.usage?.cost;

      return [definedFields<EntryCalibration>({
        step, pass, label: given.value, passed: given.score >= scorer.passingScore, decider: judgeDecider(scorer.rubric.sourceHash, { ...tried.judge, batched: tried.batched }),
        scoringCost: cost ? { ...cost, complete: true } : undefined,
      })];
    });
  },
};
