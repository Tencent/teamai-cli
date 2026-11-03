/**
 * How judging stands for a run on this machine: the labels of each pass, and why every other scorer of a pass this
 * install judges has no label, from its mark and the scorer's sampling. Read only: nothing here opens or closes a mark.
 */
import type { LocalConfig } from '../types.js';
import { scoredPasses } from '../workflow/judge-work.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, readRuns } from '../workflow/store.js';
import type { RunState, RunStatus } from '../workflow/types.js';
import type { JudgeFailureCode, RunSubject } from './label.js';
import { LabelStore, type PassScore, type ScoringTotal } from './label-store.js';
import { MARK_WINDOW_MS, Marks, type MarkKey, type MarkState } from './marks.js';
import { pinnedDefinition } from './pin.js';
import { isSampled } from './sampling.js';
import { markFacts } from './score-plan.js';
import { Subject } from './subject.js';

/** The name every judging entry point starts; a team file of that name replaces the shipped one. */
const SCORE_WORKFLOW = 'teamai-score';

/**
 * Why a scorer of a pass has no label. `queued`: it is sampled and no score run took it yet. `judging`: score run `run`
 * holds it. `lapsed`: score runs ended without labelling it `lapses` times; automatic judging starts it again until the
 * fourth, and not after `expiresAt`. `expired`: past that window.
 */
export type Unlabelled =
  | { kind: 'queued' }
  | { kind: 'not_sampled'; samplingRate: number }
  | { kind: 'judging'; run: string; since: string }
  | { kind: 'waiting_ci' }
  | { kind: 'lapsed'; lapses: number; expiresAt: string }
  | { kind: 'failed'; code: JudgeFailureCode }
  | { kind: 'expired' };

/** A pass as the run page shows its judging: its labels, the scorers without one and why, and the score runs of it. */
export interface PassJudging {
  scores: PassScore[];
  unlabelled: Array<{ scorer: string; state: Unlabelled }>;
  scoreRuns: Array<{ run: string; status: RunStatus }>;
}

const passKey = (subject: Pick<RunSubject, 'step' | 'pass'>): string => `${subject.step}#${subject.pass}`;

/** Why `state` leaves a scorer without a label, when it is `sampled`; undefined for a labelled mark, whose label shows. */
function unlabelledOf(state: MarkState, sampled: { is: boolean; rate: number }, expiresAt: string): Unlabelled | undefined {
  switch (state.kind) {
    case 'unmarked':
      return sampled.is ? { kind: 'queued' } : { kind: 'not_sampled', samplingRate: sampled.rate };
    case 'expired':
      return sampled.is ? { kind: 'expired' } : { kind: 'not_sampled', samplingRate: sampled.rate };
    case 'open':
      return { kind: 'judging', run: state.run, since: state.at };
    case 'waiting':
      return { kind: 'waiting_ci' };
    case 'lapsed':
      return { kind: 'lapsed', lapses: state.lapses, expiresAt };
    case 'failed':
      return { kind: 'failed', code: state.code };
    case 'labelled':
      return undefined;
    default: {
      const unhandled: never = state;

      return unhandled;
    }
  }
}

/** The root runs of the score workflow on this machine, by the subject they label, oldest first. */
function scoreRunsBySubject(runs: readonly RunState[]): Map<string, PassJudging['scoreRuns']> {
  const bySubject = new Map<string, PassJudging['scoreRuns']>();

  for (const run of [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const subject = run.inputs?.subject;

    if (run.definition.name !== SCORE_WORKFLOW || typeof subject !== 'string') continue;
    bySubject.set(subject, [...bySubject.get(subject) ?? [], { run: run.id, status: run.status }]);
  }

  return bySubject;
}

export const RunJudging = {
  /**
   * Each pass of `run` with labels or scorers this install judges, and what judging it cost: each judge call its labels
   * record, a batch's tokens once, and each failed attempt but one whose check could not run, since no judge ran for it.
   */
  async of(config: LocalConfig, run: RunState, now: string): Promise<{ passes: Map<string, PassJudging>; total: ScoringTotal }> {
    const scored = scoredPasses(run, (await installOwner(config)).id);
    const keys = scored.flatMap(({ subject, scorers }) => scorers.map((scorer): MarkKey => ({ scorer, subject: { kind: 'run', subject } })));
    const stateKey = (subject: RunSubject, scorer: string) => `${passKey(subject)}\n${scorer}`;

    const [labels, states, labelled, runs] = await Promise.all([
      LabelStore.ofRuns(config, [run.id], { published: false }),
      Marks.states(config, keys, markFacts(config, now)),
      LabelStore.scoringTotal(config, run.id, 'local'),
      readRuns(config),
    ]);

    const scoreRuns = scoreRunsBySubject(runs);
    const definitionOf = stepDefinitions(run);
    const expiresAt = new Date(Date.parse(run.updatedAt) + MARK_WINDOW_MS).toISOString();
    const passes = new Map<string, PassJudging>([...labels.get(run.id) ?? []].map(([key, scores]) => [key, { scores, unlabelled: [], scoreRuns: [] }]));
    const stateOf = new Map(keys.flatMap((key, at) => {
      const state = states[at];

      return state && key.subject.kind === 'run' ? [[stateKey(key.subject.subject, key.scorer), state] as const] : [];
    }));

    for (const { subject, scorers } of scored) {
      const pass = passes.get(passKey(subject)) ?? { scores: [], unlabelled: [], scoreRuns: [] };
      const all = definitionOf(subject.step)?.scorers?.sampling === 'all';
      passes.set(passKey(subject), pass);
      pass.scores.sort((left, right) => scorers.indexOf(left.scorer) - scorers.indexOf(right.scorer));
      pass.scoreRuns = scoreRuns.get(Subject.format({ kind: 'run', subject })) ?? [];

      for (const scorer of scorers) {
        const state = stateOf.get(stateKey(subject, scorer));
        const pin = run.scorers?.[scorer];
        const rate = (pin && pinnedDefinition(scorer, pin)?.samplingRate) ?? 0;
        const why = state && !pass.scores.some((score) => score.scorer === scorer) ? unlabelledOf(state, { is: all || isSampled(scorer, subject, rate), rate }, expiresAt) : undefined;

        if (why) pass.unlabelled.push({ scorer, state: why });
      }
    }

    const failed = states.filter((state) => state.kind === 'failed' && state.code !== 'check_could_not_run').length;

    return { passes, total: { ...labelled, judged: labelled.judged + failed } };
  },
} as const;
