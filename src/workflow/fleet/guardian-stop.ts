import { z } from 'zod';
import { autoDetectInit } from '../../config.js';
import { stopLeftOperationOnRuntime } from '../runtimes/cancelled.js';
import { AttemptIdSchema, RunIdSchema, takeRunLock } from '../store.js';
import { isFenceHeld } from './fence.js';
import { stopLeftOfClaim } from './member.js';

/** The claim a step's guardian stops what was left of: the checkout its member ran in, whose config the member loaded. */
export const GuardianStopSchema = z.object({
  root: z.string().min(1),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  pool: z.string().min(1),
  step: z.string().min(1),
}).strict();

export type GuardianStop = z.infer<typeof GuardianStopSchema>;

/** What teamai's CLI bundle in its guardian mode (FLEET_GUARDIAN_ENV) stops: the claim, and the fence and token of the guardian that loaded it (`fence.ts` fenceStep). */
export const GuardianInputSchema = GuardianStopSchema.extend({ fence: z.string().min(1), owner: z.string().min(1) }).strict();

export type GuardianInput = z.infer<typeof GuardianInputSchema>;

/** How long the guardian waits between two tries of the run's lock, which a live member holds for the whole step. */
const LOCK_RETRY_MS = 1_000;

/**
 * Stops what a claim left once its fence passed, as the guardian of its step asks (`input`, the JSON of a
 * `GuardianInput`). First its exec or prompt on the member's step runtime, without the run's lock: a live member may
 * be stopping it too, and a runtime's stop of what already stopped answers so. Then the rest, as a restarted member does
 * before it finishes the claim (`stopLeftOfClaim`), under the run's lock, once the member that holds it is gone. It stops
 * trying once its fence is no longer the guardian's. A stop that is not confirmed keeps the attempt's place recorded,
 * so the member's next recovery stops it again.
 */
export async function runFleetGuardian(input: string): Promise<void> {
  let json: unknown;

  try {
    json = JSON.parse(input);
  } catch {
    return;
  }

  const parsed = GuardianInputSchema.safeParse(json);

  if (!parsed.success) return;
  const { root, run, attempt, pool, step, fence, owner } = parsed.data;
  // The config the member's `workflow resume --next` loaded in this checkout, read only, as its restart would.
  const { localConfig: config } = await autoDetectInit(root, { dryRun: true, selfHeal: false, suppressMigrationNotice: true });

  await stopLeftOperationOnRuntime(config, { run, attempt, checkout: root });

  while (await isFenceHeld(fence, owner)) {
    const taken = await takeRunLock(config, run, async () => stopLeftOfClaim(config, { claim: { run, attempt, pool, lease: { step } }, root, isEnded: false }), { waitMs: 0 });

    if (taken.kind !== 'busy') return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}
