/**
 * How judging stands for a run on this machine: the mark of every scorer on every pass this install judges, joined with
 * the labels, read only. Nothing here opens or closes a mark.
 */
import type { LocalConfig } from '../types.js';
import { scoredPasses } from '../workflow/judge-work.js';
import { installOwner } from '../workflow/store.js';
import type { RunState } from '../workflow/types.js';
import { LabelStore, type ScoringTotal } from './label-store.js';
import { Marks, type MarkKey } from './marks.js';
import { markFacts } from './score-plan.js';

export const RunJudging = {
  /**
   * What judging `run` cost: each judge call its labels record, a batch's tokens once, and each failed attempt but one
   * whose check could not run, since no judge ran for that one and no label records it.
   */
  async total(config: LocalConfig, run: RunState, now: string): Promise<ScoringTotal> {
    const keys: MarkKey[] = scoredPasses(run, (await installOwner(config)).id)
      .flatMap(({ subject, scorers }) => scorers.map((scorer) => ({ scorer, subject: { kind: 'run', subject } })));
    const [labelled, states] = await Promise.all([LabelStore.scoringTotal(config, run.id, 'local'), Marks.states(config, keys, markFacts(config, now))]);
    const failed = states.filter((state) => state.kind === 'failed' && state.code !== 'check_could_not_run').length;

    return { ...labelled, judged: labelled.judged + failed };
  },
} as const;
