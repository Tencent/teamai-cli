/**
 * The names of teamai's default workflows that judge. A team file of either name replaces teamai's, and a step that runs
 * one is never judged itself.
 */

/** Labels one subject with the scorers that apply to it; every judging entry point runs it. */
export const SCORE_WORKFLOW = 'teamai-score';

/** Archives and judges a data home's finished sessions, each through a teamai-score step. */
export const FINISHED_WORKFLOW = 'teamai-finished-sessions';

export const JUDGING_WORKFLOWS: readonly string[] = [SCORE_WORKFLOW, FINISHED_WORKFLOW];

/** The steps of each plan group of teamai-score, its `score` for_each, that teamai reads by id, and a team file keeps. */
export type ScoreItemStep = 'evidence' | 'judge' | 'label' | 'write' | 'publish' | 'settle';

/** `step` of plan group `index` in a teamai-score run: `score[<index>].<step>`. */
function stepOf(index: number, step: ScoreItemStep): string {
  return `score[${index}].${step}`;
}

/** The plan group a teamai-score run's step `id` is `step` of, `score[<index>]`; undefined for any other step. */
function groupOf(id: string, step: ScoreItemStep): string | undefined {
  const suffix = `.${step}`;
  const group = id.endsWith(suffix) ? id.slice(0, -suffix.length) : undefined;

  return group !== undefined && /^score\[\d+\]$/u.test(group) ? group : undefined;
}

/** The ids of the steps of a teamai-score run's plan groups. */
export const ScoreItem = { stepOf, groupOf } as const;
