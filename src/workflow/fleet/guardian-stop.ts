import { z } from 'zod';
import { autoDetectInit } from '../../config.js';
import { AttemptIdSchema, RunIdSchema, takeRunLock } from '../store.js';
import { stopLeftOfClaim } from './member.js';

/**
 * What a claim's guardian stops through teamai once its fence passed: the claim, and the checkout its member ran in,
 * whose config the member loaded. The member writes it (`fence.ts` fenceStep); this module, which teamai builds as
 * `fleet-guardian.js`, reads it.
 */
export const GuardianStopSchema = z.object({
  root: z.string().min(1),
  run: RunIdSchema,
  attempt: AttemptIdSchema,
  pool: z.string().min(1),
  step: z.string().min(1),
}).strict();

export type GuardianStop = z.infer<typeof GuardianStopSchema>;

/**
 * Stops what the claim `claim` names left (the JSON of a `GuardianStop`, as the guardian got it on its command line), as
 * a restarted member does before it finishes it (`stopLeftOfClaim`), once the member that holds the run's lock is gone:
 * `busy` while a live process still holds it, as a live member stops its own step. A stop that is not confirmed keeps
 * the attempt's place recorded, so the member's next recovery stops it again.
 */
export async function stopLeftForGuardian(claim: string): Promise<'stopped' | 'left' | 'busy' | 'unreadable'> {
  let json: unknown;

  try {
    json = JSON.parse(claim);
  } catch {
    return 'unreadable';
  }

  const parsed = GuardianStopSchema.safeParse(json);

  if (!parsed.success) return 'unreadable';
  const { root, run, attempt, pool, step } = parsed.data;
  // The config the member's `workflow resume --next` loaded in this checkout, read only, as its restart would.
  const { localConfig: config } = await autoDetectInit(root, { dryRun: true, selfHeal: false, suppressMigrationNotice: true });
  const taken = await takeRunLock(config, run, async () => stopLeftOfClaim(config, { claim: { run, attempt, pool, lease: { step } }, root, isEnded: false }), { waitMs: 0 });

  if (taken.kind === 'busy') return 'busy';

  return taken.value.kind;
}
