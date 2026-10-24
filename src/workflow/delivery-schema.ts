/** What a run file and a snapshot keep of delivery, as schemas only, so neither loads delivery code or a provider. */
import { z } from 'zod';
import { PrUrlSchema } from './pr-url.js';

/** A claim hands every commit a snapshot names to git, so each is only ever a full commit id. */
export const CommitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** A pull request delivered on a run: its URL, the branch it was opened from and into, and the step pass it delivered. */
export const DeliveryReceiptSchema = z.object({
  url: PrUrlSchema,
  branch: z.string(),
  base: z.string(),
  step: z.string(),
  pass: z.number().int(),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

/** Which delivery an outcome belongs to while the step still delivers this pass of this commit. */
const DeliveryKeySchema = z.object({
  step: z.string(), pass: z.number().int(), settledAt: z.number().int(), branch: z.string().min(1), head: CommitIdSchema,
});
export type DeliveryKey = z.infer<typeof DeliveryKeySchema>;

/** A create the host may have accepted, retained independently of the step's lifecycle. */
export const UnresolvedCreateSchema = DeliveryKeySchema.extend({
  target: z.string().min(1),
  lookups: z.object({ total: z.number().int().nonnegative(), none: z.number().int().nonnegative(), failed: z.number().int().nonnegative() }).default({ total: 0, none: 0, failed: 0 }),
});
export type UnresolvedCreate = z.infer<typeof UnresolvedCreateSchema>;
