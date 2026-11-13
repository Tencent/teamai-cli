/**
 * The level a confined run reaches and what it spent, as offers, leases, reports and labels name them. What its tool can
 * do there (`ACCESS_LEVELS`) is part of each tool's launch profile, in `@teamai/tool-core/launch`. It imports only zod,
 * so the workflow's schemas read it without loading the scorers.
 */
import { z } from 'zod';

/** `verified`: the tool's confined profile is known to keep it to its directory on this machine. */
export const CONFINED_LEVELS = ['best-effort', 'verified'] as const;

export type ConfinedLevel = (typeof CONFINED_LEVELS)[number];

/** What a tool stated a run cost, in its own unit. */
export const CostSchema = z.object({ amount: z.number().finite().nonnegative(), unit: z.string().min(1) });

/** What a confined run's tool reports it used, as far as it reports it. */
export const ConfinedUsageSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  cost: CostSchema.optional(),
});

export type ConfinedUsage = z.infer<typeof ConfinedUsageSchema>;
