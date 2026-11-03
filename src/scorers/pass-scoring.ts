/**
 * The scoring of a run's passes that the driver of the run starts: one root `teamai-score` run per settled pass of a
 * scored step this install judges, as the session-start hook starts one per finished session. A start key per pass,
 * made by an exclusive create under `<dataHome>/scores/started/<run>/`, keeps a retried settle or a second process
 * from starting a pass twice. A run that ended more than the 14 days a mark lasts ago starts nothing, so its keys go.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { getFileMtime, listDirs, readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { scoredPasses, type ScorablePass } from '../workflow/judge-work.js';
import type { WorkflowClient } from '../workflow/protocol.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, readRun, RunIdSchema, type RunId } from '../workflow/store.js';
import type { DriverIdentity, RunState, WorkflowEnvelope, WorkflowFailure } from '../workflow/types.js';
import { scoresDir } from './home.js';
import type { RunSubject } from './label.js';
import { MARK_WINDOW_MS } from './marks.js';
import { Subject } from './subject.js';

/** What a start did: the `teamai-score` runs of the run's passes still to drive, and the passes whose start was refused. */
export interface PassStarts {
  runs: Array<{ subject: RunSubject; scorers: string[]; run: RunId }>;
  refused: Array<{ subject: string; failure: WorkflowFailure }>;
}

/** What a teamai-score run gave its pass, as one line: `pending` while the run has not ended. */
export interface ScoredLine {
  kind: 'scored' | 'pending';
  line: string;
}

const StartKeySchema = z.object({ subject: z.string(), run: RunIdSchema });

const EntrySchema = z.object({ scorer: z.string(), label: z.string(), code: z.string() });

/** The label entries of every group a teamai-score run's `done` gives, or none. */
const ScoredSchema = z.object({
  done: z.object({ outcome: z.string(), outputs: z.object({ labels: z.array(z.object({ outputs: z.object({ labels: z.array(EntrySchema) }).catch({ labels: [] }) })) }).catch({ labels: [] }) }),
});

function startKey(config: LocalConfig, subject: RunSubject): string {
  const hash = createHash('sha256').update(Subject.format({ kind: 'run', subject })).digest('hex').slice(0, 32);

  return path.join(scoresDir(config), 'started', subject.runId, hash);
}

/** Whether this call made the start key of the pass: false when another call made it first. */
async function claimed(file: string): Promise<boolean> {
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    await fs.writeFile(file, '', { flag: 'wx' });

    return true;
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') return false;
    throw e;
  }
}

/** The `teamai-score` run an earlier start recorded for the pass; undefined while that start has not recorded it. */
async function startedRun(file: string): Promise<RunId | undefined> {
  const text = await readFileSafe(file);

  if (!text) return undefined;

  try {
    return StartKeySchema.safeParse(JSON.parse(text)).data?.run;
  } catch {
    return undefined;
  }
}

/** The passes of `run` the scoring module starts: those its step does not leave to the workflow's own steps. */
async function startable(config: LocalConfig, run: RunState): Promise<ScorablePass[]> {
  const definitionOf = stepDefinitions(run);

  return scoredPasses(run, (await installOwner(config)).id).filter(({ subject }) => definitionOf(subject.step)?.scorers?.start !== 'workflow');
}

/** Whether `run` ended and last changed longer ago than a mark lasts, so none of its passes is scored again. */
function isPastScoring(run: RunState, now: number): boolean {
  return run.status !== 'running' && Date.parse(run.updatedAt) + MARK_WINDOW_MS <= now;
}

/** Removes the start keys of each run that is gone or past scoring; a run's keys untouched for 14 days are the only ones read. */
async function prune(config: LocalConfig, now: number): Promise<void> {
  const dir = path.join(scoresDir(config), 'started');

  for (const name of await listDirs(dir)) {
    const runId = RunIdSchema.safeParse(name);
    const keys = path.join(dir, name);

    if (!runId.success || await getFileMtime(keys) + MARK_WINDOW_MS > now) continue;
    const run = await readRun(config, runId.data);

    if (run === 'missing' || (run !== 'corrupt' && isPastScoring(run, now))) await fs.rm(keys, { recursive: true, force: true });
  }
}

async function isRunning(config: LocalConfig, runId: RunId): Promise<boolean> {
  const run = await readRun(config, runId);

  return run !== 'missing' && run !== 'corrupt' && run.status === 'running';
}

export const PassScoring = {
  /**
   * Starts a root `teamai-score` run, as the CLI's own start with no agent evidence, for each settled scored pass of
   * `runId` that no call started yet, recorded for the scored run's driver and from its checkout, so that driver drives
   * it as its own, its commands in the same checkout. Answers
   * those runs and the ones an earlier call started that have not ended, which the caller drives. Removes the start keys
   * of every run that is gone or ended more than 14 days ago first.
   */
  async start(config: LocalConfig, runId: string, { client, mode }: { client: Pick<WorkflowClient, 'start'>; mode: RunMode }): Promise<PassStarts> {
    const now = Date.now();
    await prune(config, now);
    const run = await readRun(config, runId);
    const starts: PassStarts = { runs: [], refused: [] };

    if (run === 'missing' || run === 'corrupt' || isPastScoring(run, now)) return starts;
    const driver: DriverIdentity | undefined = run.driver;

    for (const { subject, scorers } of await startable(config, run)) {
      const file = startKey(config, subject);
      const text = Subject.format({ kind: 'run', subject });

      if (!await claimed(file)) {
        const earlier = await startedRun(file);

        if (earlier && await isRunning(config, earlier)) starts.runs.push({ subject, scorers, run: earlier });
        continue;
      }

      const inputs = { subject: text, scorers: [], label: '', batch: false, demand: 'auto' };
      const options: Parameters<WorkflowClient['start']>[1] = { inputs, caller: { evidence: { kind: 'none' }, confirmed: false, mode }, startedBy: 'cli', driver };

      if (run.checkout !== undefined) options.checkout = run.checkout;
      const answer = await client.start('teamai-score', options);
      const started = 'data' in answer ? RunIdSchema.safeParse(answer.data.run) : undefined;

      if (started?.success) {
        await writeJsonAtomic(file, { subject: text, run: started.data });
        starts.runs.push({ subject, scorers, run: started.data });
        continue;
      }

      await fs.rm(file, { force: true });
      starts.refused.push({ subject: text, failure: 'error' in answer ? answer.error : { code: 'run_unreadable', message: 'The new teamai-score run id was missing' } });
    }

    return starts;
  },

  /** Whether the scoring module started the scoring of `subject`, so no judge lease takes it. */
  async started(config: LocalConfig, subject: RunSubject): Promise<boolean> {
    return (await readFileSafe(startKey(config, subject))) !== null;
  },

  /** The line that says what teamai-score run `run` gave `subject`: each scorer's label or code, or why the run has not ended. */
  said(subject: string, run: RunId, envelope: WorkflowEnvelope): ScoredLine {
    if ('error' in envelope) return { kind: 'pending', line: `${subject} is not labelled yet (${envelope.error.code}): ${envelope.error.message}` };
    const scored = ScoredSchema.safeParse(envelope.data);

    if (scored.success && scored.data.done.outcome !== 'succeeded') return { kind: 'pending', line: `${subject} is not labelled: teamai-score run ${run} ended ${scored.data.done.outcome}.` };
    const entries = scored.success ? scored.data.done.outputs.labels.flatMap((group) => group.outputs.labels) : [];
    const given = entries.length === 0 ? 'no scorer sampled it' : entries.map(({ scorer, label, code }) => `${scorer} ${label || code}`).join(', ');

    return { kind: 'scored', line: `${subject}: ${given} (teamai-score run ${run}).` };
  },
};
