/** What the judge lease reads of a run's labels and its end. */
import type { RunSubject, ScoreLabel } from '../scorers/label.js';
import type { RunState } from './types.js';

export function sameSubject(label: ScoreLabel, scorer: string, sourceHash: string, subject: RunSubject): boolean {
  return label.source === 'workflow' && label.scorer === scorer && label.rubric.sourceHash === sourceHash
    && label.subject.runId === subject.runId && label.subject.step === subject.step && label.subject.pass === subject.pass;
}

/** Whether `run`'s steps ended: it settled, or runs `finally`. A `sampling: all` pass is leased only before then. */
export function verdictsFrozen(run: RunState): boolean {
  return run.status !== 'running' || run.finalizing !== undefined;
}

