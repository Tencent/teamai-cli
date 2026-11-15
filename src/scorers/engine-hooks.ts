/**
 * The scoring the engine and its protocol reach: starting the scoring of settled passes, staging a clone pass's tree as
 * evidence, describe's judging line, what teamai does on this machine around a benchmark check step, whose command
 * runs where its runtime runs it, and why no step of a benchmark run whose plan this teamai cannot read is leased.
 * `src/workflow/` imports `src/scorers/` only through this module, so the engine never learns how a pass is scored.
 */
import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import type { JsonValue } from '@teamai/shared/json';
import { log } from '@teamai/shared/log';
import type * as BenchmarkChecks from '../benchmark/trial.js';
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

let loadingChecks: Promise<typeof BenchmarkChecks> | undefined;

// Loaded on call: the benchmark's checks reach place.ts and engine.ts, which import this module. Loaded once, so a
// call made while they load waits for that load: the module runner Vitest runs tests in answers a second import of a
// module in a cycle with its exports before they are initialized.
const benchmarkChecks = (): Promise<typeof BenchmarkChecks> => (loadingChecks ??= import('../benchmark/trial.js'));

/** `prepareCheckPlace` of the benchmark's checks: what teamai does in a check step's place before its command runs. */
export async function prepareCheckPlace(input: Parameters<typeof BenchmarkChecks.prepareCheckPlace>[0]): ReturnType<typeof BenchmarkChecks.prepareCheckPlace> {
  return (await benchmarkChecks()).prepareCheckPlace(input);
}

/** `outdatedBenchmarkPlan` of the benchmark's checks: why no driver may lease a step of a run whose plan teamai cannot read. */
export async function outdatedBenchmarkPlan(run: RunState): Promise<ReturnType<typeof BenchmarkChecks.outdatedBenchmarkPlan>> {
  // A plan is the output of a step the run admitted, so a run that admitted none loads no benchmark code.
  return run.admitted === undefined ? undefined : (await benchmarkChecks()).outdatedBenchmarkPlan(run);
}

/** `decideCheckReport` of the benchmark's checks: a check step's output, decided from its exit code. */
export async function decideCheckReport(input: Parameters<typeof BenchmarkChecks.decideCheckReport>[0]): ReturnType<typeof BenchmarkChecks.decideCheckReport> {
  return (await benchmarkChecks()).decideCheckReport(input);
}

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
