/**
 * The names of teamai's default workflows that judge. A team file of either name replaces teamai's, and a step that runs
 * one is never judged itself.
 */

/** Labels one subject with the scorers that apply to it; every judging entry point runs it. */
export const SCORE_WORKFLOW = 'teamai-score';

/** Archives and judges a data home's finished sessions, each through a teamai-score step. */
export const FINISHED_WORKFLOW = 'teamai-finished-sessions';

export const JUDGING_WORKFLOWS: readonly string[] = [SCORE_WORKFLOW, FINISHED_WORKFLOW];
