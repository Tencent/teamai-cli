/**
 * The scoring the engine and its protocol reach: starting the scoring of settled passes, staging a clone pass's tree as
 * evidence, and describe's judging line. `src/workflow/` imports `src/scorers/` only through this module, so the engine
 * never learns how a pass is scored.
 */
import type { RunMode } from '../launch-context.js';
import type { JsonValue, LocalConfig } from '../types.js';
import { log } from '../utils/logger.js';
import type { StartedRun, WorkflowClient } from '../workflow/protocol.js';
import type { RunState } from '../workflow/types.js';
import { removeSubjectEvidence } from './evidence.js';
import { scoresDir } from './home.js';
import { verifiedScorers as verifiedAmong } from './judges-here.js';
import { PassScoring, type ScoredLabels } from './pass-scoring.js';
import { RunScorers } from './run-scorers.js';

export { scoringUnavailable } from './home.js';

export type { ScoredLabels } from './pass-scoring.js';

export { stageEvidence } from './scoring-evidence.js';

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

/** What a teamai-score run's `done` `outputs` gave each scorer, or why this teamai cannot read them. */
export function scoredLabels(outputs: Record<string, JsonValue> | undefined): ScoredLabels {
  return PassScoring.labelsOf(outputs);
}

/**
 * The scorers among `names` whose judge must be `verified` here, for describe's judging line. Once `run` has started,
 * they are read at its team pin, and none when that pin cannot be read here; before, as cached now.
 */
export async function verifiedScorers(config: LocalConfig, names: readonly string[], run?: RunState): Promise<{ ok: true; scorers: string[] } | { ok: false; reason: string }> {
  if (!run) return verifiedAmong(config, names);
  const read = await RunScorers.of(config, run);

  return verifiedAmong(config, names, read.ok ? read.pins : {});
}

/** Removes the evidence staged for each of `subjects`, passes that will never be judged. */
export async function removeStagedEvidence(config: LocalConfig, subjects: ReadonlyArray<{ runId: string; step: string; pass: number }>): Promise<void> {
  await removeSubjectEvidence(scoresDir(config), subjects);
}
