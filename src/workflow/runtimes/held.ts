import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { LocalConfig } from '../../types.js';
import { writeJsonAtomic } from '../../utils/fs.js';
import { runsDir, type RunId } from '../store.js';
import { readRegularFile } from '@teamai/shared/regular-file';

// ─── Steps a driver's runtimes hold back ─────────────────
//
//  runs/<run>/held.json says, for the last time the local driver offered each runtime of its definition, which ready
//  steps that runtime held back and why. The run's details show it, so a run that stopped `busy`, or waits while other
//  steps run, says what each runtime lacks. The driver removes it once a runtime takes a step or the run ends.
//

export const HeldStepsSchema = z.object({
  driver: z.string(),
  runtimes: z.array(z.object({
    runtime: z.string(),
    held: z.array(z.object({ step: z.string(), reason: z.string() })),
  })),
});

export type HeldSteps = z.infer<typeof HeldStepsSchema>;

function heldFile(config: LocalConfig, run: RunId): string {
  return path.join(runsDir(config), run, 'held.json');
}

export async function readHeldSteps(config: LocalConfig, run: RunId): Promise<HeldSteps | undefined> {
  try {
    return HeldStepsSchema.parse(JSON.parse(await readRegularFile(heldFile(config, run), 'utf8')));
  } catch {
    return undefined;
  }
}

/** Records what each runtime held back, or removes the record when `held` holds no step. */
export async function writeHeldSteps(config: LocalConfig, run: RunId, held: HeldSteps): Promise<void> {
  if (held.runtimes.some((runtime) => runtime.held.length > 0)) await writeJsonAtomic(heldFile(config, run), held);
  else await fs.rm(heldFile(config, run), { force: true });
}
