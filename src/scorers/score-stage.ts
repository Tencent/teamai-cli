/**
 * `teamai score stage check|ci|protected`: one stage of a delivered pass, decided before its judge. Each writes its
 * record into the group's evidence directory, which `score label` reads in the order check, CI, protected, and answers
 * whether it decided the group, so the later stages and the judge do not run.
 */
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../types.js';
import { writeFileAtomic } from '../utils/fs.js';
import { findRunConfig } from '../workflow/run-location.js';
import { STAGES, type Stage } from './definition.js';
import { readRecord, rubricsOf, type GroupRecord } from './evidence-dir.js';
import { scoresDir } from './home.js';
import type { ScoreAttempt } from './score-attempt.js';
import { scorerStages, type Refusal } from './score-plan.js';
import { checkStage, ciStage, passOf, protectedStage, type CiVerdict } from './scoring-stages.js';

/** How long a scorer's check may run on a delivered commit before it is stopped and could not run. */
export const CHECK_TIMEOUT_MS = 30 * 60 * 1000;

/** A stage's record: it decided the group, with the reasoning its label keeps; it handed the group on; the check could not run; or CI has not finished. */
export const StageRecordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('decided'), by: z.enum(STAGES), reasoning: z.string() }),
  z.object({ kind: z.literal('judge') }),
  z.object({ kind: z.literal('unrunnable'), message: z.string() }),
  z.object({ kind: z.literal('pending'), head: z.string() }),
]);

export type StageRecord = z.infer<typeof StageRecordSchema>;

/** What a stage step outputs: `pending` only when CI has not finished. */
/** `pending` only for `ci`, which always prints it, as the step declares it. */
export type StageOutput = { decided: boolean; pending?: boolean };

const recordFile = (dir: string, stage: Stage) => path.join(dir, `stage-${stage}.json`);

const readStage = (file: string) => readRecord(file, StageRecordSchema);

/** The CI verdict of each delivered commit this run read, so its groups read CI once. */
const ciCacheFile = (attempt: ScoreAttempt, head: string) => path.join(path.dirname(attempt.dir), 'ci', `${head}.json`);

/**
 * When this machine first saw the CI of a delivered commit pending, which `--wait` counts from, and when the last ci
 * step's `--wait` passes, which `score subjects --lapsed` reads.
 */
const CiWaitSchema = z.object({ since: z.string(), until: z.string() });

const ciWaitFile = (config: LocalConfig, head: string) => path.join(scoresDir(config), 'ci-pending', head);

async function cachedCi(attempt: ScoreAttempt, read: () => Promise<CiVerdict>, head: string | undefined): Promise<CiVerdict> {
  if (head === undefined) return read();
  const file = ciCacheFile(attempt, head);
  const cached = await readStage(file);

  if (cached) return cached;
  const verdict = await read();
  await writeFileAtomic(file, JSON.stringify(verdict));

  return verdict;
}

/** A pending CI past `waitMs` since this machine first saw it pending reads as no CI, so the judge decides without it. */
async function pastWait(attempt: ScoreAttempt, head: string, waitMs: number, now: string): Promise<boolean> {
  const file = ciWaitFile(attempt.config, head);
  const since = (await readRecord(file, CiWaitSchema))?.since ?? now;
  const until = new Date(Date.parse(since) + waitMs).toISOString();
  await writeFileAtomic(file, JSON.stringify({ since, until }));

  return Date.parse(until) <= Date.parse(now);
}

function outputOf(record: StageRecord): StageOutput {
  switch (record.kind) {
    case 'decided':
    case 'unrunnable':
      return { decided: true };
    case 'judge':
      return { decided: false };
    case 'pending':
      return { decided: false, pending: true };
    default: {
      const unhandled: never = record;

      return unhandled;
    }
  }
}

export const ScoreStage = {
  /**
   * Runs `stage` for the group in `dir` and writes its record there. A stage no scorer of the group takes, or a subject
   * that delivers nothing, decides nothing and runs nothing.
   */
  async run(attempt: ScoreAttempt, dir: string, group: GroupRecord, stage: Stage, { waitMs, now }: { waitMs: number; now: string }): Promise<{ ok: true; output: StageOutput } | Refusal> {
    const answered = (output: StageOutput) => ({ ok: true as const, output: stage === 'ci' ? { pending: false, ...output } : output });
    const rubrics = rubricsOf(group.scorers);

    if (!rubrics) return { ok: false, code: 'evidence_unreadable', message: `${dir} names a scorer that does not parse.` };
    const takes = rubrics.some((definition) => scorerStages(attempt, definition).includes(stage));

    if (!takes || !group.delivers || group.judged.kind !== 'run') return answered({ decided: false });
    const { subject } = group.judged;
    const found = await findRunConfig(subject.runId, attempt.config);

    if ('error' in found) return { ok: false, code: found.error.code, message: found.error.message };
    const { run } = found;
    const pass = passOf(run, subject);
    let record: StageRecord;

    switch (stage) {
      case 'check': {
        // Plan keeps a scorer with a check alone in its group on a delivered pass.
        const checked = rubrics.find((definition) => definition.check !== undefined);
        // A deadline for a process this machine runs: the wall clock's, never the verb's `now`, which records use.
        const expiresAt = new Date(Date.now() + CHECK_TIMEOUT_MS).toISOString();

        record = checked?.check ? await checkStage(run, subject, pass, { scorer: checked.name, check: checked.check, expiresAt }) : { kind: 'judge' };
        break;
      }

      case 'ci': {
        const verdict = await cachedCi(attempt, () => ciStage(run, subject, pass), pass?.delivery?.head);

        record = verdict.kind === 'pending' && await pastWait(attempt, verdict.head, waitMs, now) ? { kind: 'judge' } : verdict;
        break;
      }

      case 'protected':
        record = protectedStage(pass);
        break;
      default: {
        const unhandled: never = stage;

        return unhandled;
      }
    }

    await writeFileAtomic(recordFile(dir, stage), JSON.stringify(record));

    return answered(outputOf(record));
  },

  /** Whether the pending CI of delivered commit `head` has waited past the `--wait` the last ci step gave it. */
  async isCiWaitOver(config: LocalConfig, head: string, now: string): Promise<boolean> {
    const wait = await readRecord(ciWaitFile(config, head), CiWaitSchema);

    return wait !== undefined && Date.parse(wait.until) <= Date.parse(now);
  },

  /** The records the group's stages wrote, in the order they decide. */
  async records(dir: string): Promise<Array<{ stage: Stage; record: StageRecord }>> {
    const read = await Promise.all(STAGES.map(async (stage) => ({ stage, record: await readStage(recordFile(dir, stage)) })));

    return read.flatMap(({ stage, record }) => (record ? [{ stage, record }] : []));
  },
} as const;
