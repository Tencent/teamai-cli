// A run that is part of a step: the run a `command` step's process started and drove, as the shortcut of `teamai score`
// or `recall maintenance --update-quality` does there. It ends with that step's attempt, however the attempt ends.
//
//   start     commandStepPart  the attempt the start's process runs in, recorded as the run's `partOf`
//             recordPart       the run listed under that attempt's directory, so whoever stops the attempt finds it
//   stop      partsOf          the runs listed under an attempt a driver stops (`endRunsPartOf`, run-controls.ts)
//   any next  judgeStepAttempt whether the attempt still runs, as the run's own `next` asks before it settles
//
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeRegularFile } from '@teamai/shared/regular-file';
import type { LocalConfig } from '../types.js';
import { errnoCode } from '../utils/fs.js';
import { isCommandStep, markedAttempt } from './attempt-marker.js';
import { expire } from './limits.js';
import { attemptDir, readRun, RunIdSchema, type PartOfStep, type RunId } from './store.js';
import type { RunState, WorkflowFailure } from './types.js';

/** The directory under an attempt's own that lists, one empty file each, the runs part of that attempt. */
function partsDir(config: LocalConfig, { run, attempt }: PartOfStep): string {
  return path.join(attemptDir(config, run, attempt), 'parts');
}

/**
 * The attempt `env`'s process runs in, when it is a `command` step's process (`isCommandStep`) whose attempt runs on this
 * machine in `config`'s scope: its directory is there, as every driver that launches a command step makes it. A run that
 * process starts and drives is part of that attempt. Undefined for any other process, and for a step whose run is in
 * another scope, such as one a run with no teamai init builds for itself, which ends with its process.
 */
export async function commandStepPart(config: LocalConfig, env: NodeJS.ProcessEnv): Promise<PartOfStep | undefined> {
  const marked = isCommandStep(env) ? markedAttempt(env) : undefined;

  if (!marked) return undefined;
  const isHere = await fs.stat(attemptDir(config, marked.run, marked.attempt)).then((found) => found.isDirectory(), () => false);

  return isHere ? marked : undefined;
}

/** Lists run `run` under the attempt it is part of, so a driver that stops that attempt ends it (`partsOf`). */
export async function recordPart(config: LocalConfig, partOf: PartOfStep, run: RunId): Promise<void> {
  const dir = partsDir(config, partOf);
  await fs.mkdir(dir, { recursive: true });
  await writeRegularFile(path.join(dir, run), '');
}

/** The runs listed as part of attempt `partOf`: none when it lists none. Each one's own `partOf` is the record to trust. */
export async function partsOf(config: LocalConfig, partOf: PartOfStep): Promise<RunId[]> {
  const names = await fs.readdir(partsDir(config, partOf)).catch((cause: unknown) => {
    if (errnoCode(cause) === 'ENOENT') return [];
    throw cause;
  });

  return names.sort().flatMap((name) => {
    const run = RunIdSchema.safeParse(name);

    return run.success ? [run.data] : [];
  });
}

/** Whether `partOf` names attempt `attempt` of run `run`. */
export function isPartOf(partOf: PartOfStep | undefined, { run, attempt }: PartOfStep): boolean {
  return partOf?.run === run && partOf.attempt === attempt;
}

/** How the attempt a run is part of stands: it still runs, or it ended, with the failure the run is cancelled with. */
export type StepAttempt = { kind: 'running' } | { kind: 'ended'; failure: WorkflowFailure };

/** The step of `run` that holds attempt `attempt`, leased or settled, in any pass. */
function stepOfAttempt(run: RunState, attempt: string): string | undefined {
  const held = run.steps.find((state) => ('attempt' in state && state.attempt === attempt) || (state.passes ?? []).some((pass) => pass.attempt === attempt));

  return held?.id ?? run.stoppedAttempts?.find((stopped) => stopped.attempt === attempt)?.step ?? run.archive?.find((pass) => pass.attempt === attempt)?.step;
}

/** Why the attempt ended, as its step's state says: the failure code its step ended with, else that state. */
function endOf(run: RunState, attempt: string): string {
  const held = run.steps.find((state) => 'attempt' in state && state.attempt === attempt);

  if (held === undefined) return run.status === 'running' ? 'ended' : run.status;

  switch (held.status) {
    case 'leased':
      return run.status;
    case 'failed':
      return held.failure?.code ?? 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'waiting':
    case 'running':
    case 'delivering':
    case 'succeeded':
    case 'skipped':
      return held.status;
    default: {
      const unhandled: never = held;

      return unhandled;
    }
  }
}

/** What a run part of `partOf` is cancelled with, naming the step that attempt ran when the record here says it. */
function endedFailure(partOf: PartOfStep, step: string | undefined, why: string): WorkflowFailure {
  return { code: 'cancelled', message: step === undefined
    ? `Ended: attempt ${partOf.attempt} of run ${partOf.run} stopped (${why})`
    : `Ended: step ${step} of run ${partOf.run} stopped (${why})` };
}

/**
 * Whether attempt `partOf` still runs at `now`, as this scope's records say. The run file of its run is here: it runs
 * while that run runs and its step still holds the attempt once the deadlines passed at `now` apply, as the next
 * operation on that run would apply them. Only the attempt's directory is here: a fleet member runs it for a run another
 * machine keeps, and removes that directory once the attempt ended. Neither: the attempt and its run are gone.
 */
export async function judgeStepAttempt(config: LocalConfig, partOf: PartOfStep, now: string): Promise<StepAttempt> {
  const outer = await readRun(config, partOf.run);

  if (outer === 'missing' || outer === 'corrupt') {
    const isHere = await fs.stat(attemptDir(config, partOf.run, partOf.attempt)).then(() => true, () => false);

    if (outer === 'missing' && isHere) return { kind: 'running' };

    return { kind: 'ended', failure: endedFailure(partOf, undefined, outer === 'missing' ? 'its run is gone' : 'its run file cannot be read') };
  }

  // A copy: this read changes nothing of the run it reads, whose own next applies its deadlines.
  const read = structuredClone(outer);

  if (read.status === 'running') expire(read, now);
  const isLeased = read.status === 'running' && read.steps.some((state) => state.status === 'leased' && state.attempt === partOf.attempt);

  return isLeased ? { kind: 'running' } : { kind: 'ended', failure: endedFailure(partOf, stepOfAttempt(read, partOf.attempt), endOf(read, partOf.attempt)) };
}

/**
 * What a driver that stopped attempt `partOf` ends the runs part of it with: why the attempt ended, as the records here
 * say, else that its driver stopped it.
 */
export async function stoppedFailure(config: LocalConfig, partOf: PartOfStep, now: string): Promise<WorkflowFailure> {
  const judged = await judgeStepAttempt(config, partOf, now);

  if (judged.kind === 'ended') return judged.failure;
  const outer = await readRun(config, partOf.run);

  return endedFailure(partOf, outer === 'missing' || outer === 'corrupt' ? undefined : stepOfAttempt(outer, partOf.attempt), 'its driver stopped it');
}
