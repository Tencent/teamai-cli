/**
 * The judge entries of a run: how the entries of its `sampling: all` scorers stand, over the passes `judge-work.ts`
 * lists. It imports neither engine.ts nor local-driver.ts, so the engine can import it without a cycle.
 */
import { AttemptStore, isDecidedBeforeJudge, type AttemptRecord } from '../scorers/attempts.js';
import { entryIdOf, entryState, type EntryState, type EntryVerdict } from '../scorers/entry.js';
import type { RunSubject, ScoreLabel } from '../scorers/label.js';
import { LabelStore } from '../scorers/label-store.js';
import { pinnedDefinition, type PinnedScorer } from '../scorers/pin.js';
import type { LocalConfig } from '../types.js';
import { judgeablePasses, scoredPasses } from './judge-work.js';
import { stepDefinitions } from './scope.js';
import { installOwner } from './store.js';
import type { RunState } from './types.js';

export function sameSubject(label: ScoreLabel, scorer: string, sourceHash: string, subject: RunSubject): boolean {
  return label.source === 'workflow' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.runId === subject.runId && label.subject.step === subject.step && label.subject.pass === subject.pass;
}

/** One (scorer, pass) of a step whose scorers judge every pass, with the labels and attempts of this install that decide it. */
export interface VerdictEntry {
  scorer: string;
  pin: PinnedScorer;
  subject: RunSubject;
  state: EntryState;
  labels: ScoreLabel[];
  attempts: AttemptRecord[];
}

/** Whether `run`'s steps ended, which froze the verdicts of its `sampling: all` entries: it settled, or runs `finally`. */
export function verdictsFrozen(run: RunState): boolean {
  return run.status !== 'running' || run.finalizing !== undefined;
}

/** Whether a judge may still settle `entry`. */
export function isUnsettled(entry: VerdictEntry): boolean {
  return entry.state.kind === 'open' || entry.state.kind === 'leased';
}

/**
 * Every entry this install judges of `run`'s steps whose scorers have `sampling: all`: one per pinned scorer this
 * teamai can read and pass of such a step. None for a run whose definition has no such step.
 */
export async function verdictEntries(config: LocalConfig, run: RunState, now: string): Promise<VerdictEntry[]> {
  if (!judgeablePasses(run).some(({ definition }) => definition.scorers?.sampling === 'all')) return [];
  const definitionOf = stepDefinitions(run);
  const passes = scoredPasses(run, (await installOwner(config)).id).filter(({ subject }) => definitionOf(subject.step)?.scorers?.sampling === 'all');
  const labels = await LabelStore.local(config);

  const entries = passes.flatMap(({ subject, scorers }) => scorers.flatMap((scorer) => {
    const pin = run.scorers?.[scorer];

    return pin && pinnedDefinition(scorer, pin) ? [{ scorer, pin, subject }] : [];
  }));

  return Promise.all(entries.map(async ({ scorer, pin, subject }) => {
    const id = entryIdOf(scorer, subject);
    const [attempts, request] = await Promise.all([AttemptStore.ofEntry(config, id), AttemptStore.request(config, id)]);
    const own = labels.filter((label) => sameSubject(label, scorer, pin.sourceHash, subject));
    const state = entryState({ labels: own, attempts, subjectChangedAt: run.updatedAt, requestedAt: request?.requestedAt, now });

    return { scorer, pin, subject, state, labels: own, attempts };
  }));
}

/**
 * What `finishRun` keeps in `run.verdicts`: every entry `verdictEntries` lists as it stands when the run's steps end,
 * so a timeout, a limit and a cancel all freeze an entry still open or leased as `unscored / run_ended`. No attempt is
 * written for it: a judge failure code an older teamai does not know would make it skip that attempt file and see the
 * entry open again.
 */
export async function freezeVerdicts(config: LocalConfig, run: RunState, now: string): Promise<EntryVerdict[]> {
  return (await verdictEntries(config, run, now)).map((entry) => {
    const scoringCost = scoringCostOf(entry);

    const verdict: EntryVerdict = { scorer: entry.scorer, step: entry.subject.step, pass: entry.subject.pass, outcome: outcomeOf(entry) };

    if (scoringCost) verdict.scoringCost = scoringCost;

    return verdict;
  });
}

function outcomeOf({ state }: VerdictEntry): EntryVerdict['outcome'] {
  switch (state.kind) {
    case 'labelled':
      return { kind: 'labelled', ...state.verdict };
    case 'failed':
      return { kind: 'unscored', because: state.code };
    case 'expired':
      return { kind: 'unscored', because: 'expired' };
    case 'open':
    case 'leased':
      return { kind: 'unscored', because: 'run_ended' };
    default: {
      const unhandled: never = state;

      return unhandled;
    }
  }
}

/**
 * What this install's attempts on the entry stated they cost, failed ones included. A batch's spend is on its first
 * entry's attempt, so the others count as stating theirs there. Incomplete when an attempt that ran a judge stated no
 * cost, or one in another unit, or when no attempt here gave the entry its label; absent when none stated a cost.
 */
function scoringCostOf({ state, attempts }: VerdictEntry): EntryVerdict['scoringCost'] {
  const spending = attempts.filter((attempt) => attempt.batch === undefined || attempt.batch[0] === attempt.entry);
  const [first] = spending.flatMap((attempt) => attempt.usage?.cost ?? []);

  if (!first) return undefined;
  const inUnit = spending.flatMap((attempt) => (attempt.usage?.cost?.unit === first.unit ? [attempt.usage.cost.amount] : []));

  // A label a stage decided before the judge (#1247) ran none, so it states no cost.
  const ranJudge = (attempt: AttemptRecord) => (attempt.status === 'succeeded' && !isDecidedBeforeJudge(attempt))
    || (attempt.status === 'failed' && (attempt.code === 'judge_failed' || attempt.code === 'judge_answer_invalid'));

  const complete = spending.every((attempt) => (attempt.usage?.cost ? attempt.usage.cost.unit === first.unit : !ranJudge(attempt)))
    && (state.kind !== 'labelled' || attempts.some((attempt) => attempt.status === 'succeeded'));

  return { amount: inUnit.reduce((sum, amount) => sum + amount, 0), unit: first.unit, complete };
}
