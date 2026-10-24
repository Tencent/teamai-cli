import { z } from 'zod';
import { WORKSPACE_MODES, type WorkspaceMode } from './workspace.js';

/**
 * What a step needs from the driver that runs it. A strict requirement holds the step until a driver that declares it
 * asks; a best-effort one is granted anyway and recorded as not enforced. The `satisfies` makes a new requirement fail
 * the type check until it is classified.
 */
const ENFORCEMENT = {
  /** `interactive: true`: a person in the tool. */
  hitl: 'strict',
} as const satisfies Record<string, 'strict' | 'bestEffort'>;
type Enforcement = typeof ENFORCEMENT;
export type StrictKey = { [K in keyof Enforcement]: Enforcement[K] extends 'strict' ? K : never }[keyof Enforcement];

/**
 * `driver.can`: what the driver declares it can do on this request. An omitted key means "not offered". The engine
 * never stores it. Parsed by `parseNextPayload`; the local driver builds every key.
 */
export const CanSchema = z.object({
  hitl: z.boolean().optional(),
  workspace: z.array(z.enum(WORKSPACE_MODES)).optional(),
});
export type DriverCan = z.infer<typeof CanSchema>;

/** The `can` keys this CLI reads; any other key is echoed in `ignored`. */
export const CAN_KEYS: ReadonlySet<string> = new Set(Object.keys(CanSchema.shape));

/** What a held step lacks, as `wait.held[].missing` lists it. */
export type Missing = StrictKey | `workspace.${WorkspaceMode}`;

/** One step `next` did not hand to this driver. An empty `missing` means another driver holds what it needs. */
export interface Held {
  step: string;
  reason: string;
  missing: Missing[];
}

/** What the engine knows about the step it is about to offer. */
export interface Offer {
  interactive: boolean;
}

export type Negotiation =
  | { kind: 'grant' }
  /** A driver that declares what is missing can take the step, so it stays pending for one. */
  | { kind: 'hold'; missing: [Missing, ...Missing[]] };

/** Decides whether this driver may take the step. Pure: the engine calls it at both places it hands out a lease. */
export function negotiate(offer: Offer, can: DriverCan): Negotiation {
  if (offer.interactive && !can.hitl) return { kind: 'hold', missing: ['hitl'] };
  return { kind: 'grant' };
}

/** The `wait.held` entry for a step held for what it misses. */
export function heldFor(step: string, missing: readonly Missing[]): Held {
  return { step, reason: `step "${step}" needs ${missing.join(', ')}, which this driver does not declare`, missing: [...missing] };
}
