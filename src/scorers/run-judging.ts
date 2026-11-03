/**
 * How judging stands for a run on this machine: the labels of each pass, and why every other scorer of a pass this
 * install judges has no label, from its mark and the scorer's sampling. Read only: nothing here opens or closes a mark.
 */
import { z } from 'zod';
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

/** Why a mark a score run took leaves its scorer without a label. */
function startedWhy(state: Extract<MarkState, { kind: 'open' | 'waiting' | 'lapsed' | 'failed' }>, expiresAt: string): Unlabelled {
  switch (state.kind) {
    case 'open':
      return { kind: 'judging', run: state.run, since: state.at };
    case 'waiting':
      return { kind: 'waiting_ci' };
    case 'lapsed':
      return { kind: 'lapsed', lapses: state.lapses, expiresAt };
    case 'failed':
      return { kind: 'failed', code: state.code };
    default: {
      const unhandled: never = state;

      return unhandled;
    }
  }
}

/** Why `state` leaves a scorer without a label, when it is `sampled`; undefined for a labelled mark, whose label shows. */
function unlabelledOf(state: MarkState, sampled: { is: boolean; rate: number }, expiresAt: string): Unlabelled | undefined {
  if (state.kind === 'labelled') return undefined;

  if (state.kind !== 'unmarked' && state.kind !== 'expired') return startedWhy(state, expiresAt);

  if (!sampled.is) return { kind: 'not_sampled', samplingRate: sampled.rate };

  return state.kind === 'unmarked' ? { kind: 'queued' } : { kind: 'expired' };
}

/** Whether automatic judging samples `scorer` on `subject`, at the rate `run` pinned; a step that judges every pass samples all. */
function samplingOf(run: RunState, subject: RunSubject, scorer: string, isAll: boolean) {
  const pin = run.scorers?.[scorer];
  const rate = (pin && pinnedDefinition(scorer, pin)?.samplingRate) ?? 0;

  return { is: isAll || isSampled(scorer, subject, rate), rate };
}

/** The root runs of the score workflow on this machine, by the subject they label, oldest first. */
function scoreRunsBySubject(runs: readonly RunState[]): Map<string, PassJudging['scoreRuns']> {
  const bySubject = new Map<string, PassJudging['scoreRuns']>();

  for (const run of [...runs].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const subject = z.string().safeParse(run.inputs?.subject);

    if (run.definition.name !== SCORE_WORKFLOW || !subject.success) continue;
    bySubject.set(subject.data, [...bySubject.get(subject.data) ?? [], { run: run.id, status: run.status }]);
  }

  return bySubject;
}

/** How judging stands for one run: each pass with labels or scorers this install judges, and its failed judge attempts. */
export interface RunJudgingState {
  passes: Map<string, PassJudging>;
  /** Failed attempts but those whose check could not run: a judge ran for each, and no label records it. */
  failedJudgeCalls: number;
}

const stateKey = (subject: RunSubject, scorer: string): string => JSON.stringify([subject.runId, subject.step, subject.pass, scorer]);

/** Adds to `pass` why each of `scorers` this install judges has no label, and gives the failed judge calls among them. */
function addUnlabelled(pass: PassJudging, subject: RunSubject, scorers: readonly string[], context: { run: RunState; stateOf: ReadonlyMap<string, MarkState>; expiresAt: string; isAll: boolean }): number {
  let failedJudgeCalls = 0;

  for (const scorer of scorers) {
    const state = context.stateOf.get(stateKey(subject, scorer));

    if (!state) continue;

    if (state.kind === 'failed' && state.code !== 'check_could_not_run') failedJudgeCalls += 1;
    const why = pass.scores.some((score) => score.scorer === scorer) ? undefined : unlabelledOf(state, samplingOf(context.run, subject, scorer, context.isAll), context.expiresAt);

    if (why) pass.unlabelled.push({ scorer, state: why });
  }

  return failedJudgeCalls;
}

/** `run`'s passes from its `labels`, and why every other scorer of a pass this install judges has no label. */
function judgingOf(run: RunState, scored: ReturnType<typeof scoredPasses>, labels: ReadonlyMap<string, PassScore[]>, stateOf: ReadonlyMap<string, MarkState>, scoreRuns: ReadonlyMap<string, PassJudging['scoreRuns']>): RunJudgingState {
  const definitionOf = stepDefinitions(run);
  const expiresAt = new Date(Date.parse(run.updatedAt) + MARK_WINDOW_MS).toISOString();
  const passes = new Map<string, PassJudging>([...labels].map(([key, scores]) => [key, { scores, unlabelled: [], scoreRuns: [] }]));
  let failedJudgeCalls = 0;

  for (const { subject, scorers } of scored) {
    const pass = passes.get(passKey(subject)) ?? { scores: [], unlabelled: [], scoreRuns: [] };
    passes.set(passKey(subject), pass);
    pass.scores.sort((left, right) => scorers.indexOf(left.scorer) - scorers.indexOf(right.scorer));
    pass.scoreRuns = scoreRuns.get(Subject.format({ kind: 'run', subject })) ?? [];
    failedJudgeCalls += addUnlabelled(pass, subject, scorers, { run, stateOf, expiresAt, isAll: definitionOf(subject.step)?.scorers?.sampling === 'all' });
  }

  return { passes, failedJudgeCalls };
}

export const RunJudging = {
  /** How judging stands for each of `runs` on this machine, by run id. */
  async of(config: LocalConfig, runs: readonly RunState[], now: string): Promise<Map<string, RunJudgingState>> {
    const install = (await installOwner(config)).id;
    const scored = new Map(runs.map((run) => [run.id, scoredPasses(run, install)]));
    const keys = [...scored.values()].flat().flatMap(({ subject, scorers }) => scorers.map((scorer): MarkKey => ({ scorer, subject: { kind: 'run', subject } })));

    const [labels, states, all] = await Promise.all([
      LabelStore.ofRuns(config, runs.map((run) => run.id), { published: false }),
      Marks.states(config, keys, markFacts(config, now)),
      readRuns(config),
    ]);

    const stateOf = new Map(keys.flatMap((key, at) => {
      const state = states[at];

      return state && key.subject.kind === 'run' ? [[stateKey(key.subject.subject, key.scorer), state] as const] : [];
    }));

    const scoreRuns = scoreRunsBySubject(all);

    return new Map(runs.map((run) => [run.id, judgingOf(run, scored.get(run.id) ?? [], labels.get(run.id) ?? new Map(), stateOf, scoreRuns)]));
  },

  /** What judging run `runId` cost: each judge call its labels record, a batch's tokens once, and each failed judge call. */
  async total(config: LocalConfig, runId: string, judging: RunJudgingState | undefined): Promise<ScoringTotal> {
    const labelled = await LabelStore.scoringTotal(config, runId, 'local');

    return { ...labelled, judged: labelled.judged + (judging?.failedJudgeCalls ?? 0) };
  },
} as const;
