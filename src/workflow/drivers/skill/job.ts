/** The lease each runner runs, saved masked beside its attempt by the tick that spawns the runner. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../../../types.js';
import { readFileSafe, writeJsonAtomic } from '../../../utils/fs.js';
import { redactJson } from '../../../utils/redact.js';
import { attemptDir, type AttemptId, type RunId } from '../../store.js';
import { readLease } from './engine-replies.js';
import type { ReadLease } from './transitions.js';

const JobSchema = z.object({ lease: z.unknown() });
/** What a runner runs: its attempt's lease, masked, as the engine sent it (`raw`) and as this driver reads it. */
export interface Job {
  raw: unknown;
  lease: ReadLease;
}

function jobPath(config: LocalConfig, run: RunId, attempt: AttemptId): string {
  return path.join(attemptDir(config, run, attempt), 'job.json');
}

export async function readJob(config: LocalConfig, run: RunId, attempt: AttemptId): Promise<Job | undefined> {
  try {
    const parsed = JobSchema.safeParse(JSON.parse(await readFileSafe(jobPath(config, run, attempt)) ?? 'null'));
    const lease = parsed.success ? readLease(parsed.data.lease) : undefined;
    return parsed.success && lease ? { raw: parsed.data.lease, lease } : undefined;
  } catch {
    return undefined;
  }
}

/** Saves the lease `raw` of `attempt` for its runner, masked with `secrets`. */
export async function writeJob(input: { config: LocalConfig; run: RunId; attempt: AttemptId; raw: unknown; secrets: Record<string, string> }): Promise<void> {
  const { config, run, attempt, raw, secrets } = input;
  await fs.mkdir(attemptDir(config, run, attempt), { recursive: true });
  await writeJsonAtomic(jobPath(config, run, attempt), redactJson({ lease: raw }, secrets));
}
