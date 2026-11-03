/**
 * How each scorer of a benchmark trial ended: labelled, or unscored and why. Built when the run's steps ended, from the
 * results of its `workflow: teamai-score` steps, each item of which labels one trial pass, and from the labels those
 * runs wrote on this machine, which hold whether a label passes and what its judge cost.
 */
import { z } from 'zod';
import { LabelStore } from '../scorers/label-store.js';
import type { ScoreLabel } from '../scorers/label.js';
import { LABEL_CODES } from '../scorers/score-labels.js';
import type { LocalConfig } from '../types.js';
import { stepDefinitions } from '../workflow/scope.js';
import { stepWorkflow, type RunState, type WorkflowStep } from '../workflow/types.js';
import type { RunPlan } from './run-plan.js';

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

/** One item of a `teamai-score` step: the subject it labelled and, when it succeeded, the entries of every group. */
const ScoredItemSchema = z.object({
  item: z.string(),
  outputs: z.object({ labels: z.array(z.object({ outputs: z.object({ labels: z.array(LabelEntrySchema) }).optional() })) }).optional(),
}).transform(({ item, outputs }) => ({ item, entries: (outputs?.labels ?? []).flatMap((group) => group.outputs?.labels ?? []) }));

function runsTeamaiScore(step: WorkflowStep | undefined): boolean {
  const child = step ? stepWorkflow(step) : undefined;

  return child?.kind === 'named' && child.name === 'teamai-score';
}

/** The item results of every `teamai-score` step of `run`. */
function scoreResults(run: RunState): unknown[] {
  const definitionOf = stepDefinitions(run);

  return run.steps.flatMap((state) => ('results' in state && runsTeamaiScore(definitionOf(state.id)) ? state.results ?? [] : []));
}

/** The entries of every scorer that a `teamai-score` step of `run` labelled, by subject and then scorer. */
function scoredEntries(run: RunState): Map<string, Map<string, ScoredEntry>> {
  const bySubject = new Map<string, Map<string, ScoredEntry>>();

  for (const result of scoreResults(run)) {
    const scored = ScoredItemSchema.safeParse(result);

    if (!scored.success) continue;
    const entries = bySubject.get(scored.data.item) ?? new Map<string, ScoredEntry>();

    for (const { scorer, label, code } of scored.data.entries) entries.set(scorer, { label, code });
    bySubject.set(scored.data.item, entries);
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
      const entries = scored.get(`run:${run.id}:${step}:${pass}`);

      return (definitionOf(step)?.scorers?.names ?? []).map((scorer) => {
        const entry = entries?.get(scorer);

        const stored = labels.find((label) => label.source === 'workflow' && label.scorer === scorer && label.label === entry?.label
          && label.subject.runId === run.id && label.subject.step === step && label.subject.pass === pass);

        return { scorer, step, pass, ...verdictOf(entry, stored) };
      });
    });
  },
};
