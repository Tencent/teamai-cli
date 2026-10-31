import { z } from 'zod';
import { ENV_KEY_RE, sameEnvName } from '../resources/env-key.js';
import { stepWorkflow, WORKSPACE_MODES, type WorkflowDefaults, type WorkflowFailure, type WorkflowStep } from './types.js';
import type { WorkspaceMode } from './workspace.js';

/** How far a driver keeps a step from the member's machine, weakest first. A workspace contract is at least `worktree`. */
export const ISOLATION_LEVELS = ['none', 'worktree', 'sandbox'] as const;
const IsolationSchema = z.enum(ISOLATION_LEVELS);
export type Isolation = z.infer<typeof IsolationSchema>;

const EnvKeySchema = z.string().regex(ENV_KEY_RE, 'must be an environment variable name');

/**
 * `requires:` on a step, and `defaults.requires` in a workflow file, which acts as if written on every step of it.
 * A step that needs a person says `interactive: true`. `env` lists team env keys by name; values never enter the run.
 * `strict: true` makes the block's `isolation` and `network` strict, and a floor for every level inside it.
 */
export const RequirementsSchema = z.object({
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
  env: z.array(EnvKeySchema).optional(),
  strict: z.boolean().optional(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/**
 * What reaching a step's `timeout`, `max_turns` or `budget` does. `fail`, the default, fails the step. `end_turn` ends
 * the agent's turn there, and the step succeeds with the limit it reached.
 */
export const ON_LIMIT = ['end_turn', 'fail'] as const;
export type OnLimit = typeof ON_LIMIT[number];

/** The limit that ended an agent's turn under `on_limit: end_turn`, as a report names it. */
export const LimitSchema = z.enum(['timeout', 'budget', 'max_turns']);
export type Limit = z.infer<typeof LimitSchema>;

/**
 * The lease `limits` of a prompt under `on_limit: end_turn`, for a driver with `can.end_turn`: they count from the
 * tool's launch, and the driver stops the tool at the first it reaches and reports it as `limit`, or reports each it
 * cannot hold the tool to in `unenforced`. An absent key is no limit.
 */
export const TurnLimitsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  /** Input plus output tokens, as a budget counts them. */
  budget: z.object({ tokens: z.number().int().positive() }).optional(),
  onLimit: z.literal('end_turn'),
});
export type TurnLimits = z.infer<typeof TurnLimitsSchema>;

/** Whether `limits` sets `limit`. */
export function setsLimit(limits: TurnLimits, limit: Limit): boolean {
  switch (limit) {
    case 'timeout':
      return limits.timeoutMs !== undefined;
    case 'budget':
      return limits.budget !== undefined;
    case 'max_turns':
      return limits.maxTurns !== undefined;
    default: {
      const unhandled: never = limit;
      return unhandled;
    }
  }
}

/** What strict levels set: the `isolation` and `network` no level inside them goes below. */
export type Floor = Pick<Requirements, 'isolation' | 'network'>;

/** The requirements in effect at a level, each at least its `floor`, which only strict levels set. */
export type InEffect = Omit<Requirements, 'strict'> & { floor?: Floor };

/**
 * The names a strict `isolation: sandbox` keeps from every process teamai starts for the step, setup and the clone's
 * git included: what the step could push, publish or authenticate with. They win over any `requires.env`.
 */
export const SANDBOX_WITHHELD_ENV = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS',
] as const;

/** The keys `requires:` takes; pull reports any other as `unknown_key`. */
export const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(Object.keys(RequirementsSchema.shape));

const SetupRequirementsSchema = z.object({ env: z.array(EnvKeySchema).optional() }).strict();

/**
 * `setup:` in a workflow file: a command the driver runs in each workspace it creates for a step of the file, before
 * the step. Its `requires.env` keys reach only setup; the step gets them only if it requires them too. The step's
 * deadline bounds it.
 */
export const SetupSchema = z.object({ command: z.string().trim().min(1), requires: SetupRequirementsSchema.optional() }).strict();
export type Setup = z.infer<typeof SetupSchema>;

/**
 * What a step needs from the driver that runs it. A strict requirement holds the step until a driver that declares it
 * asks; a best-effort one is granted anyway and recorded as not enforced. `isolation` and `network` are strict where a
 * `strict` level sets them. The `satisfies` makes a new requirement fail the type check until it is classified.
 */
const ENFORCEMENT = {
  /** `interactive: true`: a person in the tool. */
  hitl: 'strict',
  env: 'strict',
  network: 'bestEffort',
  isolation: 'bestEffort',
  /** Keeping the run's other env keys from a step, which only a driver with `can.env` does. */
  withhold: 'bestEffort',
  /** Reporting the tokens a headless prompt step under a budget spent. */
  tokens: 'strict',
  /** Counting an interactive prompt step against its budget: a person drives it, and no driver meters that session. */
  budget: 'bestEffort',
  /** Capping the agent turns of a prompt step's tool. */
  max_turns: 'bestEffort',
  /** Ending a prompt's turn at its limits under `on_limit: end_turn`, which only a driver with `can.end_turn` does. */
  on_limit: 'bestEffort',
  /** Running the workflow's `setup` in each workspace the driver creates, before the step. */
  setup: 'strict',
  /** A prompt step that names its `tool`: `can.tools` lists it. */
  tools: 'strict',
  /** A prompt step with `permissions: unattended`: the driver launches its tool in that tool's unattended mode. */
  unattended: 'strict',
  /** A step in a clone is leased only through `next --prepare`, so teamai made its clone. Process-only. */
  prepare: 'strict',
} as const satisfies Record<string, 'strict' | 'bestEffort'> & Record<keyof Floor | 'env', 'strict' | 'bestEffort'>;
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
 *   whatever runs the step. `true` covers every step; `'commands'` only command steps and setup, which run in the
 *   driver's own processes, so a prompt step that requires env is held. A driver whose executor is the agent leaves it out.
 * - `tokens`: every success report of a headless prompt step carries the tokens it spent.
 * - `max_turns`: the driver passes `maxTurns` to the tools it can cap, and reports `unenforced: ['max_turns']` for the others.
 * - `setup`: in each workspace it creates, the driver runs `lease.setup` before the step with only setup's keys, and
 *   fails the step without running it when setup exits non-zero (`setup_failed`), changes a tracked or non-ignored path
 *   (`setup_dirty`), or leaves a value of one of its keys in a file it created or changed (`setup_secret`).
 * - `tools`: the tools the driver launches a prompt step on that names its `tool`. Omitted: no such step.
 * - `end_turn`: the driver holds a prompt leased with `limits` to them from its tool's launch, stops the tool at the
 *   first it reaches and reports it as `limit`, with `durationMs`. Without it, such a prompt gets the `on_limit: fail`
 *   lease, and its pass records `on_limit` as not enforced.
 * - `unattended`: the driver launches a prompt leased with `permissions: 'unattended'` in its tool's own mode for
 *   editing and running commands without asking, and fails the step rather than launch a tool that has none.
 */
export const CanSchema = z.object({
  hitl: z.boolean().optional(),
  workspace: z.array(z.enum(WORKSPACE_MODES)).optional(),
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
  env: z.union([z.boolean(), z.literal('commands')], { error: "Expected true, false or 'commands'" }).optional(),
  tokens: z.boolean().optional(),
  max_turns: z.boolean().optional(),
  setup: z.boolean().optional(),
  tools: z.array(z.string().min(1)).optional(),
  end_turn: z.boolean().optional(),
  unattended: z.boolean().optional(),
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
export type Missing = StrictKey | keyof Floor | `workspace.${WorkspaceMode}` | `policy.${keyof Allow}`;

/** The failure codes a step's requirements and the run's limits set. Records carry them. */
export const LIMIT_FAILURES = [
  'missing_env', 'env_unavailable', 'env_conflict', 'timeout', 'budget_exceeded', 'budget_unmeasured', 'setup_failed', 'setup_dirty', 'setup_secret',
] as const;

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
  /** The run's env keys a driver whose `can.env` does not cover the step may have passed to it. */
  z.object({ requirement: z.literal('withhold'), keys: z.array(z.string()) }),
  z.object({ requirement: z.literal('max_turns'), asked: z.number().int().positive() }),
  /**
   * A budget nothing held the step to: an interactive prompt's whose report had no tokens, or a benchmark trial's whose
   * tool its driver could not stop once it passed the budget.
   */
  z.object({ requirement: z.literal('budget') }),
  /** A prompt under `on_limit: end_turn` leased to a driver that cannot end its turn, so it ran under `on_limit: fail`. */
  z.object({ requirement: z.literal('on_limit') }),
]) satisfies z.ZodType<{ requirement: BestEffortKey }>;
export type Unenforced = z.infer<typeof UnenforcedSchema>;

/**
 * What a report's `unenforced` may name: a best-effort requirement whose enforcement the driver learns only once it
 * runs the step, such as the tool it picked not capping turns.
 */
export const ReportedUnenforcedSchema = z.array(z.enum(['max_turns', 'budget'])) satisfies z.ZodType<BestEffortKey[]>;
export type ReportedUnenforced = z.infer<typeof ReportedUnenforcedSchema>;

/**
 * The entries a report's `unenforced` adds, or why it names a requirement the step did not ask for. `tokens` is a
 * benchmark trial's budget: a run's budget is counted by teamai, never by a driver.
 */
export function reportedUnenforced(keys: ReportedUnenforced, asked: { maxTurns?: number; tokens?: number }): Unenforced[] | string {
  const entries: Unenforced[] = [];
  for (const key of keys) {
    switch (key) {
      case 'max_turns':
        if (asked.maxTurns === undefined) return 'unenforced names max_turns, which the step does not set';
        entries.push({ requirement: 'max_turns', asked: asked.maxTurns });
        break;
      case 'budget':
        if (asked.tokens === undefined) return 'unenforced names budget, which the step does not set';
        entries.push({ requirement: 'budget' });
        break;
      default: {
        const unknown: never = key;
        return unknown;
      }
    }
  }
  return entries;
}

/** The env keys a lease gives the step and the ones it keeps from it, by name. */
export const EnvScopeSchema = z.object({ provide: z.array(z.string()), withhold: z.array(z.string()) });
export type EnvScope = z.infer<typeof EnvScopeSchema>;

/** The setup a lease carries: the command, and for a driver with `can.env`, the keys it gets and the ones kept from it. */
export const LeaseSetupSchema = z.object({ command: z.string(), envScope: EnvScopeSchema.optional() });
export type LeaseSetup = z.infer<typeof LeaseSetupSchema>;

/**
 * The requirements in effect at a level: each level's keys replace the earlier ones, and `env` lists add up. The
 * `isolation` and `network` of a strict level, or of a level's `floor`, join the floor, and a value below it is raised.
 */
export function mergeRequirements(...levels: ReadonlyArray<(Requirements & Pick<InEffect, 'floor'>) | undefined>): InEffect {
  const given = levels.filter((level) => level !== undefined);
  const merged: InEffect = {};
  let floor: Floor = {};
  for (const { network, isolation, strict, floor: inner = {} } of given) {
    if (network !== undefined) merged.network = network;
    if (isolation !== undefined) merged.isolation = isolation;
    floor = raised(raised(floor, inner), strict ? { network, isolation } : {});
  }
  const env = [...new Set(given.flatMap((level) => level.env ?? []))];
  if (env.length > 0) merged.env = env;
  if (floor.isolation === undefined && floor.network === undefined) return merged;
  return { ...raised(merged, floor), floor };
}

/** `values` with each of `isolation` and `network` raised to `floor`'s, where `floor` sets it higher. */
function raised<T extends Floor>(values: T, floor: Floor): T {
  const isolation = floor.isolation !== undefined && (values.isolation === undefined || rank(values.isolation) < rank(floor.isolation)) ? floor.isolation : values.isolation;
  // Denying the network keeps a step further from the member's machine, so only a floor of `false` raises a value.
  const network = floor.network === false ? false : values.network;
  return { ...values, ...(isolation !== undefined ? { isolation } : {}), ...(network !== undefined ? { network } : {}) };
}

/**
 * This machine's team env, by name, resolved once per `next` before the run is locked. Values stay with whoever
 * runs the step.
 */
export interface EnvFacts {
  /** Keys env.yaml or env/secrets.yaml declare here. */
  declared: ReadonlySet<string>;
  /** The keys among them env/secrets.yaml declares. */
  secrets: ReadonlySet<string>;
  /** Keys with a value here: team values, or the environment. */
  present: ReadonlySet<string>;
  /** Why the team env cannot be read here, when it cannot. */
  unreadable?: string;
}

/** What runs a step: a process of the driver's own, or an agent. */
export type Executor = 'command' | 'prompt';

/** Whether `can.env` covers a step run by `executor`, and the setup before it. */
function envCovers(env: DriverCan['env'], executor: Executor): { step: boolean; setup: boolean } {
  switch (env) {
    case undefined:
    case false:
      return { step: false, setup: false };
    case true:
      return { step: true, setup: true };
    case 'commands':
      return { step: executor === 'command', setup: true };
    default: {
      const unhandled: never = env;
      return unhandled;
    }
  }
}

/** What the engine knows about the step it is about to offer. */
export interface Offer {
  step: string;
  executor: Executor;
  requires: InEffect;
  interactive: boolean;
  /** The lease runs in a copy of its own, which is at least `worktree` isolation. */
  hasContract: boolean;
  /** The step's own `env:` keys. */
  envKeys: readonly string[];
  /** Every key a step of the run requires, so each other step withholds it. */
  runEnvKeys: ReadonlySet<string>;
  /** A prompt step under a token budget, whose report must say what it spent unless it is interactive. */
  budgeted: boolean;
  /** The step's `max_turns`. */
  maxTurns?: number;
  /** The limits that end the prompt's turn, under its own `on_limit: end_turn` or a workflow step's allowance. */
  endTurn?: TurnLimits;
  /** The workflow's setup, when the lease names a workspace the driver may create. */
  setup?: Setup;
  /** The tool a prompt step names. */
  tool?: string;
  /** A prompt step with `permissions: unattended`. */
  unattended: boolean;
  /** The lease runs in a clone, which only teamai prepares. */
  clone: boolean;
  /** The caller asked `next --prepare`. */
  prepare: boolean;
}

/** What a granted lease carries besides the step itself. */
export interface Terms {
  /** The values in effect, raised to their floor. */
  requires: Omit<Requirements, 'strict'>;
  envScope?: EnvScope;
  /** Only for a driver that can cap turns, on a lease without `limits`. */
  maxTurns?: number;
  /** Only for a driver that can end the turn. */
  limits?: TurnLimits;
  setup?: LeaseSetup;
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
 * out a lease. In order: an `env:` key that shadows a team secret or a required key fails; what the member's policy refuses
 * holds; every strict capability the driver lacks holds; a required key with no value here fails, for a driver that
 * would provide it; else the step is granted, with each best-effort gap listed in `unenforced`.
 */
export function negotiate(offer: Offer, can: DriverCan, allow: Allow, env: EnvFacts): Negotiation {
  const { floor = {}, ...requires } = offer.requires;
  const sealed = floor.isolation === 'sandbox';
  // A strict sandbox's strip list wins over every requires.env, so no step under it is handed a credential.
  const stripped: readonly string[] = sealed ? SANDBOX_WITHHELD_ENV : [];
  const guarded = [...env.declared, ...offer.runEnvKeys, ...stripped];
  const shadowed = offer.envKeys.filter((key) => sameEnvName([...env.secrets, ...offer.runEnvKeys], key) !== undefined);
  if (shadowed.length > 0) {
    return { kind: 'fail', failure: { code: 'env_conflict', message: `Step "${offer.step}" sets env ${shadowed.join(', ')}, which a team secret or a requires.env of the run names. Rename the step's variable, or remove it from env:.` } };
  }
  const allowed = (keys: readonly string[]): string[] => keys.filter((key) => sameEnvName(stripped, key) === undefined);
  const required = allowed(requires.env ?? []);
  const setupKeys = allowed(offer.setup?.requires?.env ?? []);
  const covers = envCovers(can.env, offer.executor);
  const policy: Missing[] = [];
  if (allow.network === false && requires.network === true) policy.push('policy.network');
  if (allow.env && [...required, ...setupKeys].some((key) => sameEnvName(allow.env ?? [], key) === undefined)) policy.push('policy.env');
  const provided = providedIsolation(can, offer.hasContract);
  const gaps: Missing[] = policy.length > 0 ? policy : [
    ...(offer.tool !== undefined && lacksTool(offer.tool, can) ? ['tools' as const] : []),
    ...(offer.unattended && !can.unattended ? ['unattended' as const] : []),
    ...(floor.isolation !== undefined && rank(floor.isolation) > rank(provided) ? ['isolation' as const] : []),
    ...(floor.network === false && !can.network ? ['network' as const] : []),
    ...(offer.clone && !offer.prepare ? ['prepare' as const] : []),
    ...(offer.interactive && !can.hitl ? ['hitl' as const] : []),
    ...(offer.setup && !can.setup ? ['setup' as const] : []),
    // A strict sandbox keeps its strip list from every process of the step, which only a driver with `can.env: true` does.
    ...((required.length > 0 && !covers.step) || (setupKeys.length > 0 && !covers.setup) || (sealed && can.env !== true) ? ['env' as const] : []),
    ...(offer.budgeted && !offer.interactive && !can.tokens ? ['tokens' as const] : []),
  ];
  const [first, ...rest] = gaps;
  if (first !== undefined) return { kind: 'hold', missing: [first, ...rest] };
  if (covers.step || covers.setup) {
    const unavailable = envUnavailable(`Step "${offer.step}"`, required, env) ?? envUnavailable(`The setup of step "${offer.step}"`, setupKeys, env);
    if (unavailable) return { kind: 'fail', failure: unavailable };
  }
  const unenforced: Unenforced[] = [];
  if (requires.network === false && !can.network) unenforced.push({ requirement: 'network', asked: false });
  const asked = requires.isolation;
  if (asked !== undefined && asked !== 'none' && rank(asked) > rank(provided)) unenforced.push({ requirement: 'isolation', asked, provided });
  const withhold = [...new Set(guarded)].filter((key) => sameEnvName(required, key) === undefined).sort();
  if (!covers.step && withhold.length > 0) unenforced.push({ requirement: 'withhold', keys: withhold });
  if (offer.maxTurns !== undefined && !can.max_turns) unenforced.push({ requirement: 'max_turns', asked: offer.maxTurns });
  if (offer.endTurn && !can.end_turn) unenforced.push({ requirement: 'on_limit' });
  const limits = offer.endTurn && can.end_turn ? { limits: offer.endTurn } : {};
  const envScope = covers.step && (required.length > 0 || withhold.length > 0) ? { envScope: { provide: required, withhold } } : {};
  const maxTurns = offer.maxTurns !== undefined && can.max_turns && !limits.limits ? { maxTurns: offer.maxTurns } : {};
  const setupWithhold = [...new Set(guarded)].filter((key) => sameEnvName(setupKeys, key) === undefined).sort();
  const setup = offer.setup && {
    setup: { command: offer.setup.command, ...(covers.setup && (setupKeys.length > 0 || setupWithhold.length > 0) ? { envScope: { provide: setupKeys, withhold: setupWithhold } } : {}) },
  };
  return { kind: 'grant', terms: { requires, ...envScope, ...maxTurns, ...limits, ...setup, unenforced } };
}

/**
 * How a member gives `keys`, which this machine has no value for, a value: `teamai env set` only takes a key the team
 * declares as a secret or an env variable, so it is offered for those alone; the rest are set in the environment, or
 * declared in the team repo first (#1513).
 */
export function envAdvice(keys: readonly string[], declared: ReadonlySet<string>): string {
  const known = keys.filter((key) => sameEnvName(declared, key) !== undefined);
  const unknown = keys.filter((key) => sameEnvName(declared, key) === undefined);
  const advice: string[] = [];
  if (known.length > 0) {
    advice.push(`run ${known.map((key) => `teamai env set ${key}`).join(', ')}, or set ${known.length > 1 ? 'them' : 'it'} in the environment`);
  }
  if (unknown.length > 0) {
    const them = unknown.length > 1 ? 'them' : 'it';
    const adds = unknown.map((key) => `teamai env add ${key} --secret`).join(', ');
    const sets = unknown.map((key) => `teamai env set ${key}`).join(', ');
    advice.push(`set ${unknown.join(', ')} in the environment, or declare ${them} in the team repo with ${adds} and give ${them} a value with ${sets}`);
  }
  return advice.join('; ');
}

/** Whether a driver that declares `can` is held from a step that names `tool`. */
export function lacksTool(tool: string, can: Pick<DriverCan, 'tools'>): boolean {
  return !(can.tools ?? []).includes(tool);
}

/** Why `keys`, which `who` requires, cannot be given here: the team env cannot be read, or a key has no value. */
function envUnavailable(who: string, keys: readonly string[], env: EnvFacts): WorkflowFailure | undefined {
  if (keys.length === 0) return undefined;
  if (env.unreadable) {
    return { code: 'env_unavailable', message: `${who} requires env ${keys.join(', ')}, and the team env cannot be read here: ${env.unreadable}. Run teamai env list, fix what it reports, then retry the step.` };
  }
  const absent = keys.filter((key) => sameEnvName(env.present, key) === undefined);
  if (absent.length === 0) return undefined;
  const one = absent.length === 1;
  const advice = envAdvice(absent, env.declared);
  return { code: 'missing_env', message: `${who} requires env ${absent.join(', ')}, which ${one ? 'has' : 'have'} no value on this machine. ${advice.charAt(0).toUpperCase()}${advice.slice(1)}, then retry the step.` };
}

function rank(level: Isolation): number {
  return ISOLATION_LEVELS.indexOf(level);
}

function providedIsolation(can: DriverCan, hasContract: boolean): Isolation {
  const declared = can.isolation ?? 'none';
  return hasContract && rank(declared) < rank('worktree') ? 'worktree' : declared;
}

/** What a handed-back lease records: what it already had, then what this driver adds, each requirement once. The list only grows. */
export function unionUnenforced(stored: readonly Unenforced[], added: readonly Unenforced[]): Unenforced[] {
  const union = [...stored];
  for (const entry of added) if (!union.some((item) => item.requirement === entry.requirement)) union.push(entry);
  return union;
}

/** Every key a step or the setup of these workflow files requires, `defaults.requires` and inline workflows included. */
export function requiredEnvKeys(definitions: ReadonlyArray<{ defaults?: WorkflowDefaults; setup?: Setup; steps: WorkflowStep[] }>): Set<string> {
  const keys = new Set<string>();
  const visit = (steps: readonly WorkflowStep[]): void => {
    for (const step of steps) {
      for (const key of step.requires?.env ?? []) keys.add(key);
      const child = stepWorkflow(step);
      if (child?.kind === 'inline') visit(child.workflow.steps);
    }
  };
  for (const definition of definitions) {
    for (const key of [...definition.defaults?.requires?.env ?? [], ...definition.setup?.requires?.env ?? []]) keys.add(key);
    visit(definition.steps);
  }
  return keys;
}

/** The `wait.held` entry for a step held for what it misses: what the member's policy refuses, or what the driver lacks. */
export function heldFor(step: string, missing: readonly Missing[]): Held {
  const refused = missing.flatMap((item) => (item.startsWith('policy.') ? [item.slice('policy.'.length)] : []));
  const reason = refused.length > 0
    ? `step "${step}" needs ${refused.join(', ')}, which workflows.allow in local config does not allow on this machine`
    : `step "${step}" needs ${missing.join(', ')}, which this driver does not declare`;
  return { step, reason, missing: [...missing] };
}
