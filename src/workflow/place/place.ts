import path from 'node:path';
import type { LocalConfig } from '../../types.js';
import type { WorkflowFailure } from '../types.js';
import { attemptDir, type AttemptId, type RunLock } from '../store.js';
import { finishReader, stageReader } from './reader.js';
import { readPlaceRecord, writePlaceRecord } from './record.js';

/** The lease fields a place reads. A lease with a workspace contract does not come here yet. */
export interface PlaceLease {
  attempt: AttemptId;
  executor: 'command' | 'prompt';
  interactive?: true;
  readOnly?: true;
}

export type PlacePrepared = { kind: 'prepared'; dir: string } | { kind: 'failed'; failure: WorkflowFailure };

/**
 * Prepares the place of `lease` in `root`, the member's checkout, and records it in `attempts/<a>/place.json`, so any
 * process can finish it. A second prepare of the attempt returns the recorded place and keeps its first snapshot.
 */
export async function preparePlace(input: { config: LocalConfig; lock: RunLock; root: string; lease: PlaceLease }): Promise<PlacePrepared> {
  const { config, lock: { run }, root, lease } = input;
  const recorded = await readPlaceRecord(config, run, lease.attempt);
  if ('kind' in recorded && recorded.kind === 'unreadable') {
    return { kind: 'failed', failure: { code: 'workspace_base', message: `The place record of attempt ${lease.attempt} cannot be read (${recorded.reason}). Retry the step with teamai workflow retry ${run} <step>.` } };
  }
  if (!('kind' in recorded)) return { kind: 'prepared', dir: recorded.dir };
  const dir = path.resolve(root);
  await stageReader(dir, path.join(attemptDir(config, run, lease.attempt), 'before.json'));
  await writePlaceRecord(config, {
    version: 1, run, attempt: lease.attempt, source: 'checkout', dir, phase: 'ready',
    place: { role: 'reader', executor: lease.executor, snapshot: 'before.json', ...(lease.interactive ? { interactive: true } : {}), ...(lease.readOnly ? { readOnly: true } : {}) },
  });
  return { kind: 'prepared', dir };
}

/** What finishing a place adds to its attempt's report. */
export interface PlaceFinished {
  failure?: WorkflowFailure;
}

/**
 * Finishes the place `preparePlace` recorded for `attempt`: a reader in the checkout fails when it changed it. A second
 * finish returns the first one's result. `unmanaged` when no place was prepared for the attempt.
 */
export async function finishPlace(input: { config: LocalConfig; lock: RunLock; attempt: AttemptId; outcome: 'success' | 'failed' | 'released' }): Promise<PlaceFinished | 'unmanaged'> {
  const { config, lock: { run }, attempt, outcome } = input;
  const recorded = await readPlaceRecord(config, run, attempt);
  if ('kind' in recorded) {
    return recorded.kind === 'missing' ? 'unmanaged'
      : { failure: { code: 'workspace_base', message: `The place record of attempt ${attempt} cannot be read (${recorded.reason}), so the step's changes cannot be checked.` } };
  }
  if (recorded.phase === 'finished') return recorded.finished.failure ? { failure: recorded.finished.failure } : {};
  const failure = await finishReader({
    dir: recorded.dir, file: path.join(attemptDir(config, run, attempt), recorded.place.snapshot), executor: recorded.place.executor, outcome,
    ...(recorded.place.interactive ? { interactive: true } : {}), ...(recorded.place.readOnly ? { readOnly: true } : {}),
  });
  await writePlaceRecord(config, { ...recorded, phase: 'finished', finished: { outcome, at: new Date().toISOString(), ...(failure ? { failure } : {}) } });
  return failure ? { failure } : {};
}
