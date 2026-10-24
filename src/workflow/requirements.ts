import { z } from 'zod';
import { ENV_KEY_RE, sameEnvName } from '../resources/env-key.js';
import { WORKSPACE_MODES, type WorkflowDefaults, type WorkflowFailure, type WorkflowStep } from './types.js';
import type { WorkspaceMode } from './workspace.js';

/** How far a driver keeps a step from the member's machine, weakest first. A workspace contract is at least `worktree`. */
export const ISOLATION_LEVELS = ['none', 'worktree', 'sandbox'] as const;
const IsolationSchema = z.enum(ISOLATION_LEVELS);
export type Isolation = z.infer<typeof IsolationSchema>;

const EnvKeySchema = z.string().regex(ENV_KEY_RE, 'must be an environment variable name');

/**
 * `requires:` on a step, and `defaults.requires` in a workflow file, which acts as if written on every step of it.
 * A step that needs a person says `interactive: true`. `env` lists team env keys by name; values never enter the run.
 */
export const RequirementsSchema = z.object({
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
  env: z.array(EnvKeySchema).optional(),
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
  env: 'strict',
  network: 'bestEffort',
  isolation: 'bestEffort',
  /** Keeping the run's other env keys from a step, which only a driver with `can.env` does. */
  withhold: 'bestEffort',
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
 * - `env`: the driver resolves `envScope.provide` itself, removes `envScope.withhold`, and keeps the values from
 *   whatever runs the step. A driver whose executor is the agent leaves it out.
 */
export const CanSchema = z.object({
  hitl: z.boolean().optional(),
  workspace: z.array(z.enum(WORKSPACE_MODES)).optional(),
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
  env: z.boolean().optional(),
});
export type DriverCan = z.infer<typeof CanSchema>;

/** The `can` keys this CLI reads; any other key is echoed in `ignored`. */
export const CAN_KEYS: ReadonlySet<string> = new Set(Object.keys(CanSchema.shape));

/**
 * The ceiling `workflows.allow` in the member's config sets for every driver on this machine. An unset key allows.
 */
export const AllowSchema = z.object({
  network: z.boolean().optional(),
  env: z.array(EnvKeySchema).optional(),
}).strict();
export type Allow = z.infer<typeof AllowSchema>;

/** What a held step lacks, as `wait.held[].missing` lists it: a capability, or what the member's policy allows. */
export type Missing = StrictKey | `workspace.${WorkspaceMode}` | `policy.${keyof Allow}`;

/** The failure codes a step's requirements and the run's limits set. Records carry them. */
export const LIMIT_FAILURES = ['missing_env', 'env_unavailable', 'env_conflict', 'timeout'] as const;

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
  /** The run's env keys a driver without `can.env` may have passed to the step. */
  z.object({ requirement: z.literal('withhold'), keys: z.array(z.string()) }),
]) satisfies z.ZodType<{ requirement: BestEffortKey }>;
export type Unenforced = z.infer<typeof UnenforcedSchema>;

/** The env keys a lease gives the step and the ones it keeps from it, by name. */
export const EnvScopeSchema = z.object({ provide: z.array(z.string()), withhold: z.array(z.string()) });
export type EnvScope = z.infer<typeof EnvScopeSchema>;

/** The requirements in effect at a level: each level's keys replace the earlier ones, and `env` lists add up. */
export function mergeRequirements(...levels: ReadonlyArray<Requirements | undefined>): Requirements {
  const merged: Requirements = Object.assign({}, ...levels.map((level) => level ?? {}));
  const env = [...new Set(levels.flatMap((level) => level?.env ?? []))];
  if (env.length > 0) merged.env = env;
  return merged;
}

/**
 * This machine's team env, by name, resolved once per `next` before the run is locked. Values stay with whoever
 * runs the step.
 */
export interface EnvFacts {
  /** Keys env.yaml or env/secrets.yaml declare here. */
  declared: ReadonlySet<string>;
  /** Keys with a value here: team values, or the environment. */
  present: ReadonlySet<string>;
  /** Why the team env cannot be read here, when it cannot. */
  unreadable?: string;
}

/** What the engine knows about the step it is about to offer. */
export interface Offer {
  step: string;
  requires: Requirements;
  interactive: boolean;
  /** The lease runs in a copy of its own, which is at least `worktree` isolation. */
  hasContract: boolean;
  /** The step's own `env:` keys. */
  envKeys: readonly string[];
  /** Every key a step of the run requires, so each other step withholds it. */
  runEnvKeys: ReadonlySet<string>;
}

/** What a granted lease carries besides the step itself. */
export interface Terms {
  requires: Requirements;
  envScope?: EnvScope;
  unenforced: Unenforced[];
}

export type Negotiation =
  | { kind: 'grant'; terms: Terms }
  /** A driver that declares what is missing can take the step, so it stays pending for one. */
  | { kind: 'hold'; missing: [Missing, ...Missing[]] }
  /** No driver can run the step on this machine as it is written or as its env stands. */
  | { kind: 'fail'; failure: WorkflowFailure };

/**
 * Decides whether this driver may take the step, and on what terms. Pure: the engine calls it at both places it hands
 * out a lease. In order: an `env:` key that shadows a team or required key fails; what the member's policy refuses
 * holds; every strict capability the driver lacks holds; a required key with no value here fails, for a driver that
 * would provide it; else the step is granted, with each best-effort gap listed in `unenforced`.
 */
export function negotiate(offer: Offer, can: DriverCan, allow: Allow, env: EnvFacts): Negotiation {
  const guarded = [...env.declared, ...offer.runEnvKeys];
  const shadowed = offer.envKeys.filter((key) => sameEnvName(guarded, key) !== undefined);
  if (shadowed.length > 0) {
    return { kind: 'fail', failure: { code: 'env_conflict', message: `Step "${offer.step}" sets env ${shadowed.join(', ')}, which the team env or a requires.env of the run names. Rename the step's variable, or remove it from env:.` } };
  }
  const required = offer.requires.env ?? [];
  const policy: Missing[] = [];
  if (allow.network === false && offer.requires.network === true) policy.push('policy.network');
  if (allow.env && required.some((key) => sameEnvName(allow.env ?? [], key) === undefined)) policy.push('policy.env');
  const gaps: Missing[] = policy.length > 0 ? policy : [
    ...(offer.interactive && !can.hitl ? ['hitl' as const] : []),
    ...(required.length > 0 && !can.env ? ['env' as const] : []),
  ];
  const [first, ...rest] = gaps;
  if (first !== undefined) return { kind: 'hold', missing: [first, ...rest] };
  if (can.env && required.length > 0) {
    if (env.unreadable) {
      return { kind: 'fail', failure: { code: 'env_unavailable', message: `Step "${offer.step}" requires env ${required.join(', ')}, and the team env cannot be read here: ${env.unreadable}. Run teamai env list, fix what it reports, then retry the step.` } };
    }
    const absent = required.filter((key) => sameEnvName(env.present, key) === undefined);
    if (absent.length > 0) {
      const one = absent.length === 1;
      return { kind: 'fail', failure: { code: 'missing_env', message: `Step "${offer.step}" requires env ${absent.join(', ')}, which ${one ? 'has' : 'have'} no value on this machine. Run ${absent.map((key) => `teamai env set ${key}`).join(', ')}, or set ${one ? 'it' : 'them'} in the environment, then retry the step.` } };
    }
  }
  const unenforced: Unenforced[] = [];
  if (offer.requires.network === false && !can.network) unenforced.push({ requirement: 'network', asked: false });
  const asked = offer.requires.isolation;
  const provided = providedIsolation(can, offer.hasContract);
  if (asked !== undefined && asked !== 'none' && rank(asked) > rank(provided)) unenforced.push({ requirement: 'isolation', asked, provided });
  const withhold = [...new Set(guarded)].filter((key) => sameEnvName(required, key) === undefined).sort();
  if (!can.env && withhold.length > 0) unenforced.push({ requirement: 'withhold', keys: withhold });
  const envScope = can.env && (required.length > 0 || withhold.length > 0) ? { envScope: { provide: required, withhold } } : {};
  return { kind: 'grant', terms: { requires: offer.requires, ...envScope, unenforced } };
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

/** Every key a step of these workflow files requires, `defaults.requires` and inline workflows included. */
export function requiredEnvKeys(definitions: ReadonlyArray<{ defaults?: WorkflowDefaults; steps: WorkflowStep[] }>): Set<string> {
  const keys = new Set<string>();
  const visit = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      for (const key of step.requires?.env ?? []) keys.add(key);
      if (typeof step.workflow === 'object') visit(step.workflow.steps);
    }
  };
  for (const definition of definitions) {
    for (const key of definition.defaults?.requires?.env ?? []) keys.add(key);
    visit(definition.steps);
  }
  return keys;
}

/** The `wait.held` entry for a step held for what it misses. */
export function heldFor(step: string, missing: readonly Missing[]): Held {
  return { step, reason: `step "${step}" needs ${missing.join(', ')}, which this driver does not declare`, missing: [...missing] };
}
