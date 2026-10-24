import { z } from 'zod';
import { WORKSPACE_MODES } from './types.js';
import type { WorkspaceMode } from './workspace.js';

/** How far a driver keeps a step from the member's machine, weakest first. A workspace contract is at least `worktree`. */
export const ISOLATION_LEVELS = ['none', 'worktree', 'sandbox'] as const;
const IsolationSchema = z.enum(ISOLATION_LEVELS);
export type Isolation = z.infer<typeof IsolationSchema>;

/**
 * `requires:` on a step, and `defaults.requires` in a workflow file, which acts as if written on every step of it.
 * A step that needs a person says `interactive: true`.
 */
export const RequirementsSchema = z.object({
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** The keys `requires:` takes; pull reports any other as `unknown_key`. */
export const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(Object.keys(RequirementsSchema.shape));

/**
 * What a step needs from the driver that runs it. A strict requirement holds the step until a driver that declares it
 * asks; a best-effort one is granted anyway and recorded as not enforced. The `satisfies` makes a new requirement fail
 * the type check until it is classified.
 */
const ENFORCEMENT = {
  /** `interactive: true`: a person in the tool. */
  hitl: 'strict',
  network: 'bestEffort',
  isolation: 'bestEffort',
} as const satisfies Record<string, 'strict' | 'bestEffort'> & Record<keyof Requirements, 'strict' | 'bestEffort'>;
type Enforcement = typeof ENFORCEMENT;
type KeysOf<E extends Enforcement[keyof Enforcement]> = { [K in keyof Enforcement]: Enforcement[K] extends E ? K : never }[keyof Enforcement];
export type StrictKey = KeysOf<'strict'>;
type BestEffortKey = KeysOf<'bestEffort'>;

/**
 * `driver.can`: what the driver declares it can do on this request. An omitted key means "not offered". The engine
 * never stores it. Parsed by `parseNextPayload`; the local driver builds every key.
 * - `network`: the driver can deny a step the network.
 * - `isolation`: the level the driver keeps every step it runs at.
 */
export const CanSchema = z.object({
  hitl: z.boolean().optional(),
  workspace: z.array(z.enum(WORKSPACE_MODES)).optional(),
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
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

/**
 * A best-effort requirement the driver did not declare it can enforce: what was asked, and for isolation, what it got.
 * A strict requirement is never granted without the driver, so the `satisfies` keeps it out of this list.
 */
export const UnenforcedSchema = z.discriminatedUnion('requirement', [
  z.object({ requirement: z.literal('network'), asked: z.literal(false) }),
  z.object({ requirement: z.literal('isolation'), asked: z.enum(['worktree', 'sandbox']), provided: IsolationSchema }),
]) satisfies z.ZodType<{ requirement: BestEffortKey }>;
export type Unenforced = z.infer<typeof UnenforcedSchema>;

/** The requirements in effect at a level: each level's keys replace the earlier ones. */
export function mergeRequirements(...levels: ReadonlyArray<Requirements | undefined>): Requirements {
  return Object.assign({}, ...levels.map((level) => level ?? {}));
}

/** What the engine knows about the step it is about to offer. */
export interface Offer {
  requires: Requirements;
  interactive: boolean;
  /** The lease runs in a copy of its own, which is at least `worktree` isolation. */
  hasContract: boolean;
}

/** What a granted lease carries besides the step itself. */
export interface Terms {
  requires: Requirements;
  unenforced: Unenforced[];
}

export type Negotiation =
  | { kind: 'grant'; terms: Terms }
  /** A driver that declares what is missing can take the step, so it stays pending for one. */
  | { kind: 'hold'; missing: [Missing, ...Missing[]] };

/**
 * Decides whether this driver may take the step, and on what terms. Pure: the engine calls it at both places it hands
 * out a lease. A strict gap holds the step; a best-effort gap is granted and listed in `unenforced`.
 */
export function negotiate(offer: Offer, can: DriverCan): Negotiation {
  if (offer.interactive && !can.hitl) return { kind: 'hold', missing: ['hitl'] };
  const unenforced: Unenforced[] = [];
  if (offer.requires.network === false && !can.network) unenforced.push({ requirement: 'network', asked: false });
  const asked = offer.requires.isolation;
  const provided = providedIsolation(can, offer.hasContract);
  if (asked !== undefined && asked !== 'none' && rank(asked) > rank(provided)) unenforced.push({ requirement: 'isolation', asked, provided });
  return { kind: 'grant', terms: { requires: offer.requires, unenforced } };
}

function rank(level: Isolation): number {
  return ISOLATION_LEVELS.indexOf(level);
}

function providedIsolation(can: DriverCan, hasContract: boolean): Isolation {
  const declared = can.isolation ?? 'none';
  return hasContract && rank(declared) < rank('worktree') ? 'worktree' : declared;
}

/** What a handed-back lease records: what it already had, then what this driver adds. The list only grows. */
export function unionUnenforced(stored: readonly Unenforced[], added: readonly Unenforced[]): Unenforced[] {
  const has = (entry: Unenforced): boolean => stored.some((item) => item.requirement === entry.requirement);
  return [...stored, ...added.filter((entry) => !has(entry))];
}

/** The `wait.held` entry for a step held for what it misses. */
export function heldFor(step: string, missing: readonly Missing[]): Held {
  return { step, reason: `step "${step}" needs ${missing.join(', ')}, which this driver does not declare`, missing: [...missing] };
}
