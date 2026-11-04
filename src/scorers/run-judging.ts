/**
 * How judging stands for a run on this machine: the labels of each pass, and why every other scorer of a pass this
 * install judges has no label, from its mark and the scorer's sampling. Read only: nothing here opens or closes a mark.
 */
import { z } from 'zod';
import type { ConfinedUsage } from '../tool-launch/confined-level.js';
import type { LocalConfig } from '../types.js';
import { scoredPasses, type ScorablePass } from '../workflow/judge-work.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, readRuns } from '../workflow/store.js';
import type { RunState, RunStatus } from '../workflow/types.js';
import type { JudgeFailureCode, RunSubject } from './label.js';
import { LabelStore, type PassScore, type ScoringTotal } from './label-store.js';
import { MARK_WINDOW_MS, Marks, type MarkKey, type MarkState } from './marks.js';
import { pinnedDefinition, type PinnedScorer } from './pin.js';
import { RunScorers } from './run-scorers.js';
import { isSampled } from './sampling.js';
import { markFacts } from './score-plan.js';
import { Subject } from './subject.js';
import { SCORE_WORKFLOW } from './judging-workflows.js';

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

/** Whether automatic judging samples `scorer` on `subject`, at the rate of the run's `pins`; a step that judges every pass samples all. */
function samplingOf(pins: Readonly<Record<string, PinnedScorer>>, subject: RunSubject, scorer: string, isAll: boolean) {
  const pin = pins[scorer];
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
  /** What each failed attempt spent, but those whose check could not run: a judge ran for each, and no label records it. */
  failedJudgeCalls: ConfinedUsage[];
}

const stateKey = (subject: RunSubject, scorer: string): string => JSON.stringify([subject.runId, subject.step, subject.pass, scorer]);

/** Adds to `pass` why each of `scorers` this install judges has no label, and gives the failed judge calls among them. */
function addUnlabelled(pass: PassJudging, subject: RunSubject, scorers: readonly string[], context: { pins: Readonly<Record<string, PinnedScorer>>; stateOf: ReadonlyMap<string, MarkState>; expiresAt: string; isAll: boolean }): ConfinedUsage[] {
  const failedJudgeCalls: ConfinedUsage[] = [];

  for (const scorer of scorers) {
    const state = context.stateOf.get(stateKey(subject, scorer));

    if (!state) continue;

    if (state.kind === 'failed' && state.code !== 'check_could_not_run') failedJudgeCalls.push(state.usage ?? {});
    const why = pass.scores.some((score) => score.scorer === scorer) ? undefined : unlabelledOf(state, samplingOf(context.pins, subject, scorer, context.isAll), context.expiresAt);

    if (why) pass.unlabelled.push({ scorer, state: why });
  }

  return failedJudgeCalls;
}

/** `run`'s passes from its `labels`, and why every other scorer of a pass this install judges has no label. */
function judgingOf(run: RunState, { scored, pins }: Scored, labels: ReadonlyMap<string, PassScore[]>, stateOf: ReadonlyMap<string, MarkState>, scoreRuns: ReadonlyMap<string, PassJudging['scoreRuns']>): RunJudgingState {
  const definitionOf = stepDefinitions(run);
  const expiresAt = new Date(Date.parse(run.updatedAt) + MARK_WINDOW_MS).toISOString();
  const passes = new Map<string, PassJudging>([...labels].map(([key, scores]) => [key, { scores, unlabelled: [], scoreRuns: [] }]));
  const failedJudgeCalls: ConfinedUsage[] = [];

  for (const { subject, scorers } of scored) {
    const pass = passes.get(passKey(subject)) ?? { scores: [], unlabelled: [], scoreRuns: [] };
    passes.set(passKey(subject), pass);
    pass.scores.sort((left, right) => scorers.indexOf(left.scorer) - scorers.indexOf(right.scorer));
    pass.scoreRuns = scoreRuns.get(Subject.format({ kind: 'run', subject })) ?? [];
    failedJudgeCalls.push(...addUnlabelled(pass, subject, scorers, { pins, stateOf, expiresAt, isAll: definitionOf(subject.step)?.scorers?.sampling === 'all' }));
  }

  return { passes, failedJudgeCalls };
}

/** A run's scored passes, and its scorers as its team pin holds them, which give the sampling rate of a scorer no mark took. */
interface Scored {
  scored: ScorablePass[];
  pins: Readonly<Record<string, PinnedScorer>>;
}

/**
 * `scored` with the scorers of `run` that have a version at its team pin, read only when a scorer of it has no mark or
 * an expired one: a listed name with no valid version is never marked, and the read clones the pin.
 */
async function withPins(config: LocalConfig, run: RunState, scored: ScorablePass[], stateOf: ReadonlyMap<string, MarkState>): Promise<Scored> {
  const isUnmarked = scored.some(({ subject, scorers }) => scorers.some((scorer) => {
    const kind = stateOf.get(stateKey(subject, scorer))?.kind;

    return kind === 'unmarked' || kind === 'expired';
  }));

  const read = isUnmarked ? await RunScorers.of(config, run) : undefined;

  if (!read?.ok) return { scored, pins: {} };

  return { scored: scored.flatMap((pass) => {
    const scorers = pass.scorers.filter((name) => Object.hasOwn(read.pins, name));

    return scorers.length > 0 ? [{ ...pass, scorers }] : [];
  }), pins: read.pins };
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

    const judged = await Promise.all(runs.map(async (run) => [run, await withPins(config, run, scored.get(run.id) ?? [], stateOf)] as const));

    return new Map(judged.map(([run, withRates]) => [run.id, judgingOf(run, withRates, labels.get(run.id) ?? new Map(), stateOf, scoreRuns)]));
  },

  /** What judging run `runId` cost: each judge call its labels record, a batch's tokens once, and each failed judge call. */
  async total(config: LocalConfig, runId: string, judging: RunJudgingState | undefined): Promise<ScoringTotal> {
    const total = await LabelStore.scoringTotal(config, runId, 'local');

    for (const usage of judging?.failedJudgeCalls ?? []) {
      total.judged += 1;
      total.inputTokens += usage.inputTokens ?? 0;
      total.outputTokens += usage.outputTokens ?? 0;
    }

    return total;
  },
} as const;
