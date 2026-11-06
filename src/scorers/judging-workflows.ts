/**
 * The names of teamai's default workflows that judge. A team file of one of these names replaces teamai's, and a step that runs
 * one is never judged itself.
 */

/** Labels one subject with the scorers that apply to it; every judging entry point runs it. */
export const SCORE_WORKFLOW = 'teamai-score';

/** Archives and judges a data home's finished sessions, each through a teamai-score step. */
export const FINISHED_WORKFLOW = 'teamai-finished-sessions';

/** Tries scorer files on a finished session and on its control, through two teamai-score steps that store nothing. */
export const TRY_SCORER_WORKFLOW = 'teamai-try-scorer';

export const JUDGING_WORKFLOWS: readonly string[] = [SCORE_WORKFLOW, FINISHED_WORKFLOW, TRY_SCORER_WORKFLOW];

/** The steps of each plan group of teamai-score, its `score` for_each, that teamai reads by id, and a team file keeps. */
export type ScoreItemStep = 'evidence' | 'judge' | 'label' | 'write' | 'publish' | 'settle';

/** `step` of plan group `index` in a teamai-score run: `score[<index>].<step>`. */
function stepOf(index: number, step: ScoreItemStep): string {
  return `score[${index}].${step}`;
}

/**
 * The plan group a run's step `id` is `step` of: `score[<index>]`, under the scope of the step that runs teamai-score
 * when another workflow runs it, such as `share-session.score.score[0]`; undefined for any other step.
 */
function groupOf(id: string, step: ScoreItemStep): string | undefined {
  const suffix = `.${step}`;
  const group = id.endsWith(suffix) ? id.slice(0, -suffix.length) : undefined;

  return group !== undefined && /(?:^|\.)score\[\d+\]$/u.test(group) ? group : undefined;
}

/** The ids of the steps of a teamai-score instance's plan groups. */
export const ScoreItem = { stepOf, groupOf } as const;
