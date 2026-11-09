/**
 * How each scorer of a benchmark trial ended: labelled, by whom, or unscored and why. Built when the run's steps ended.
 * A check task's correctness label is the one its check step stored, named by the version the step output; every other
 * scorer's comes from the results of the run's `workflow: teamai-score` steps, each item of which labels one trial
 * pass. Both are read from the labels on this machine, which hold a label's score, whether it passes, who decided it,
 * and what its judge cost.
 */
import { z } from 'zod';
import { definedFields } from '../utils/defined-fields.js';
import { CheckOutputSchema } from '../scorers/check.js';
import { LabelStore } from '../scorers/label-store.js';
import { isStageDecider, labelVersion, type ScoreLabel } from '../scorers/label.js';
import { LABEL_CODES } from '../scorers/score-labels.js';
import type { LocalConfig } from '../types.js';
import { isUnder } from '../workflow/loop.js';
import { confinedGiveUpMessage } from '../workflow/protocol.js';
import { stepDefinitions } from '../workflow/scope.js';
import type { StepState } from '../workflow/step-state.js';
import { stepWorkflow, type RunState, type WorkflowStep } from '../workflow/types.js';
import { COMPARISONS, compareJudge } from './agent-match.js';
import { checkStepOf, correctnessScorerName, type PlannedJudge, type PlannedTask } from './plan.js';
import type { RunPlan } from './run-plan.js';
import { SCORE_WORKFLOW } from '../scorers/judging-workflows.js';

/** No label and no code: no check or `teamai-score` step labelled the scorer before the run's steps ended. */
const RUN_ENDED = 'run_ended';

/** No label: no driver of the run offered the judge tool the plan requires, so the skill driver gave the judge step up. */
const JUDGE_TOOL_UNAVAILABLE = 'judge_tool_unavailable';

/**
 * Who decided a label: a task's check, named by the task's hash, or a judge, by its rubric's hash, the tool it ran in,
 * the model and effort its tool reported, else those it was launched with, and whether it judged in a batch.
 */
const VerdictDeciderSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('check'), task: z.string().min(1) }).strict(),
  z.object({
    by: z.literal('judge'), rubric: z.string().min(1), tool: z.string().min(1), model: z.string().min(1).optional(), effort: z.string().min(1).optional(), batched: z.boolean(),
  }).strict(),
]);

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

export const EntryVerdictSchema = TrialVerdictSchema.extend({
  step: z.string().min(1),
  pass: z.number().int().positive(),
  /** What the label's judge stated it cost; absent when it stated none. */
  scoringCost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).strict().optional(),
}).strict();

export type EntryVerdict = z.infer<typeof EntryVerdictSchema>;

type Judged = Pick<EntryVerdict, 'outcome' | 'decider' | 'scoringCost' | 'asPlanned'>;

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

/** The item results of every `teamai-score` step of `run`. */
function scoreResults(run: RunState): unknown[] {
  const definitionOf = stepDefinitions(run);

  return run.steps.flatMap((state) => ('results' in state && runsTeamaiScore(definitionOf(state.id)) ? state.results ?? [] : []));
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

/**
 * By subject, the scorers whose `teamai-score` group the skill driver cancelled because no driver of the run could take
 * a step of it confined to a directory: its judge, held for a tool no driver offered.
 */
function givenUpJudges(run: RunState): Map<string, Set<string>> {
  const givenUp = new Map<string, Set<string>>();

  for (const state of run.steps) {
    const group = GroupItemSchema.safeParse(state.item);

    if (state.status !== 'cancelled' || !group.success) continue;
    const { message } = state.failure;

    if (!run.steps.some(({ id }) => isUnder(state.id)(id) && message === confinedGiveUpMessage(id))) continue;
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
function judgeOf(stored: ScoreLabel): TrialVerdict['decider'] {
  const { judge } = stored;

  if (judge.kind !== 'model' || (stored.source === 'workflow' && isStageDecider(stored.decidedBy))) return undefined;

  return definedFields<NonNullable<TrialVerdict['decider']>>({
    by: 'judge', rubric: stored.rubric.sourceHash, tool: judge.tool, model: judge.model?.reported ?? judge.model?.requested, effort: judge.effort?.reported ?? judge.effort?.requested, batched: judge.batched === true,
  });
}

function verdictOf(entry: ScoredEntry | undefined, stored: ScoreLabel | undefined, { planned, isGivenUp }: { planned: PlannedJudge | undefined; isGivenUp: boolean }): Judged {
  if (entry?.code) return { outcome: { kind: 'unscored', because: entry.code } };

  // A label the write never recorded is no label.
  if (!entry || !stored) return { outcome: { kind: 'unscored', because: isGivenUp ? JUDGE_TOOL_UNAVAILABLE : RUN_ENDED } };
  const cost = stored.judge.kind === 'model' ? stored.judge.usage?.cost : undefined;
  const verdict = labelledOf(stored, judgeOf(stored));

  if (cost) verdict.scoringCost = { ...cost, complete: true };

  if (planned && verdict.decider?.by === 'judge' && stored.judge.kind === 'model') verdict.asPlanned = compareJudge(planned, stored.judge);

  return verdict;
}

/**
 * The correctness verdict of a check task's trial, from what its check step output: the label whose version it names,
 * decided by the task's check; `check_could_not_run` when the check could not run; `run_ended` when the step output
 * nothing, or named a label this machine does not hold.
 */
function checkedOf(check: StepState | undefined, labels: readonly ScoreLabel[], task: PlannedTask): Judged {
  const output = CheckOutputSchema.safeParse(check && 'outputs' in check ? check.outputs : undefined);

  if (!output.success) return { outcome: { kind: 'unscored', because: RUN_ENDED } };
  const checked = output.data;

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
      const item = `run:${run.id}:${step}:${pass}`;
      const subject = scored.get(item);
      const task = plan.tasks.find(({ id }) => id === trial.task);
      const correctness = correctnessScorerName(trial.task);
      const checked = task?.judge.kind === 'check' ? [{ scorer: correctness, step, pass, ...checkedOf(stateOf(`${prefix}${checkStepOf(trial)}`), labels, task) }] : [];

      const judged = (definitionOf(step)?.scorers?.names ?? []).map((scorer) => {
        const entry = subject?.entries.get(scorer);
        const stored = labels.find((label) => label.scorer === scorer && subject?.written.has(labelVersion(label)) === true);

        return { scorer, step, pass, ...verdictOf(entry, stored, { planned: plan.judges[scorer], isGivenUp: givenUp.get(item)?.has(scorer) === true }) };
      });

      return [...checked, ...judged.filter(({ scorer }) => scorer === correctness), ...judged.filter(({ scorer }) => scorer !== correctness)];
    });
  },
};
