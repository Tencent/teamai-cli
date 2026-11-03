/**
 * The scoring of a run's passes that the driver of the run starts: one root `teamai-score` run per settled pass of a
 * scored step this install judges, as the session-start hook starts one per finished session. A start key per pass,
 * made by an exclusive create under `<dataHome>/scores/started/<run>/`, keeps a retried settle or a second process
 * from starting a pass twice.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { RunMode } from '../launch-context.js';
import type { LocalConfig } from '../types.js';
import { readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { scoredPasses } from '../workflow/judge-work.js';
import type { WorkflowClient } from '../workflow/protocol.js';
import { stepDefinitions } from '../workflow/scope.js';
import { installOwner, readRun, RunIdSchema, type RunId } from '../workflow/store.js';
import type { DriverIdentity, RunState, WorkflowEnvelope, WorkflowFailure } from '../workflow/types.js';
import { scoresDir } from './home.js';
import type { RunSubject } from './label.js';
import { Subject } from './subject.js';

/** What a start did: the `teamai-score` runs of the run's passes still to drive, and the passes whose start was refused. */
export interface PassStarts {
  runs: Array<{ subject: string; run: RunId }>;
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

/** The passes of `run` the scoring module starts: those its step does not leave to the workflow or to the engine's own wait. */
async function startable(config: LocalConfig, run: RunState): Promise<RunSubject[]> {
  const definitionOf = stepDefinitions(run);

  return scoredPasses(run, (await installOwner(config)).id).flatMap(({ subject }) => {
    const scorers = definitionOf(subject.step)?.scorers;

    // `sampling: all` passes are still judged before the run ends, through the engine's judge entries.
    return scorers?.start === 'workflow' || scorers?.sampling === 'all' ? [] : [subject];
  });
}

async function isRunning(config: LocalConfig, runId: RunId): Promise<boolean> {
  const run = await readRun(config, runId);

  return run !== 'missing' && run !== 'corrupt' && run.status === 'running';
}

export const PassScoring = {
  /**
   * Starts a root `teamai-score` run, as the CLI's own start with no agent evidence, for each settled scored pass of
   * `runId` that no call started yet, recorded for the scored run's driver so that driver drives it as its own. Answers
   * those runs and the ones an earlier call started that have not ended, which the caller drives.
   */
  async start(config: LocalConfig, runId: string, { client, mode }: { client: WorkflowClient; mode: RunMode }): Promise<PassStarts> {
    const run = await readRun(config, runId);
    const starts: PassStarts = { runs: [], refused: [] };

    if (run === 'missing' || run === 'corrupt') return starts;
    const driver: DriverIdentity | undefined = run.driver;

    for (const subject of await startable(config, run)) {
      const file = startKey(config, subject);
      const text = Subject.format({ kind: 'run', subject });

      if (!await claimed(file)) {
        const earlier = await startedRun(file);

        if (earlier && await isRunning(config, earlier)) starts.runs.push({ subject: text, run: earlier });
        continue;
      }

      const inputs = { subject: text, scorers: [], label: '', batch: false, demand: 'auto' };
      const answer = await client.start('teamai-score', { inputs, caller: { evidence: { kind: 'none' }, confirmed: false, mode }, startedBy: 'cli', driver });
      const started = 'data' in answer ? RunIdSchema.safeParse(answer.data.run) : undefined;

      if (started?.success) {
        await writeJsonAtomic(file, { subject: text, run: started.data });
        starts.runs.push({ subject: text, run: started.data });
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
