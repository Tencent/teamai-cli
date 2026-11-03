/**
 * The scoring the engine and its protocol reach. `src/workflow/` imports `src/scorers/` through this module, so the
 * engine knows only that settled passes may start runs, never how a pass is scored.
 */
import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import type { StartedRun, WorkflowClient } from '../workflow/protocol.js';
import { PassScoring } from './pass-scoring.js';

export { verifiedScorers } from './judges-here.js';

/**
 * Starts the scoring of every settled scored pass of run `runId` that none started yet, and answers each run that
 * scores a pass of it and has not ended, for the driver of `runId` to drive. A start that is refused is logged and
 * leaves the pass to a later drain: it never fails the report that settled the pass.
 */
export async function startedByPasses(config: LocalConfig, runId: string, options: { client: Pick<WorkflowClient, 'start'>; mode: RunMode }): Promise<StartedRun[]> {
  const starts = await PassScoring.start(config, runId, options);

  for (const { subject, failure } of starts.refused) log.warn(`The scoring of ${subject} did not start (${failure.code}): ${failure.message}`);

  return starts.runs.map(({ subject, scorers, run }) => ({ run, step: subject.step, pass: subject.pass, scorers }));
}
