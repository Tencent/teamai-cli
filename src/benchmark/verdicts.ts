/**
 * How each scorer of a benchmark trial ended: labelled, or unscored and why. Built when the run's steps ended, from the
 * results of its `workflow: teamai-score` steps, each item of which labels one trial pass, and from the labels those
 * runs wrote on this machine, which hold whether a label passes and what its judge cost.
 */
import { z } from 'zod';
import { LabelStore } from '../scorers/label-store.js';
import { labelVersion, type ScoreLabel } from '../scorers/label.js';
import { LABEL_CODES } from '../scorers/score-labels.js';
import type { LocalConfig } from '../types.js';
import { stepDefinitions } from '../workflow/scope.js';
import { stepWorkflow, type RunState, type WorkflowStep } from '../workflow/types.js';
import type { RunPlan } from './run-plan.js';
import { SCORE_WORKFLOW } from '../scorers/judging-workflows.js';

/** No label and no code: the trial's `teamai-score` step never labelled the scorer before the run's steps ended. */
const RUN_ENDED = 'run_ended';

export const EntryVerdictSchema = z.object({
  scorer: z.string().min(1),
  step: z.string().min(1),
  pass: z.number().int().positive(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('labelled'), label: z.string().min(1), passed: z.boolean() }).strict(),
    z.object({ kind: z.literal('unscored'), because: z.enum([...LABEL_CODES, RUN_ENDED]) }).strict(),
  ]),
  /** What the label's judge stated it cost; absent when it stated none. */
  scoringCost: z.object({ amount: z.number().nonnegative(), unit: z.string().min(1), complete: z.boolean() }).strict().optional(),
}).strict();

export type EntryVerdict = z.infer<typeof EntryVerdictSchema>;

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

function verdictOf(entry: ScoredEntry | undefined, stored: ScoreLabel | undefined): Pick<EntryVerdict, 'outcome' | 'scoringCost'> {
  if (entry?.code) return { outcome: { kind: 'unscored', because: entry.code } };

  // A label the write never recorded is no label.
  if (!entry || !stored) return { outcome: { kind: 'unscored', because: RUN_ENDED } };
  const cost = stored.judge.kind === 'model' ? stored.judge.usage?.cost : undefined;
  const verdict: Pick<EntryVerdict, 'outcome' | 'scoringCost'> = { outcome: { kind: 'labelled', label: stored.label, passed: stored.passed } };

  if (cost) verdict.scoringCost = { ...cost, complete: true };

  return verdict;
}

export const TrialVerdicts = {
  /** A verdict for each scorer each trial of `plan` pinned, on the pass the trial ran, as its steps ended. */
  async of(config: LocalConfig, run: RunState, { plan, prefix }: RunPlan): Promise<EntryVerdict[]> {
    const definitionOf = stepDefinitions(run);
    const scored = scoredEntries(run);
    const labels = await LabelStore.local(config);

    return plan.trials.flatMap((trial) => {
      const step = `${prefix}${trial.step}`;
      const state = run.steps.find(({ id }) => id === step);
      const pass = state?.pass ?? 1;
      const subject = scored.get(`run:${run.id}:${step}:${pass}`);

      return (definitionOf(step)?.scorers?.names ?? []).map((scorer) => {
        const entry = subject?.entries.get(scorer);
        const stored = labels.find((label) => label.scorer === scorer && subject?.written.has(labelVersion(label)) === true);

        return { scorer, step, pass, ...verdictOf(entry, stored) };
      });
    });
  },
};
