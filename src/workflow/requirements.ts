import { z } from 'zod';
import { ENV_KEY_RE, sameEnvName } from '../resources/env-key.js';
import { CanSchema, ISOLATION_LEVELS, type Can } from '@teamai/runtime-protocol';
import { stepWorkflow, type WorkflowDefaults, type WorkflowFailure, type WorkflowStep } from './types.js';
import type { WorkspaceMode } from './workspace.js';

const IsolationSchema = z.enum(ISOLATION_LEVELS);

export type Isolation = z.infer<typeof IsolationSchema>;

const EnvKeySchema = z.string().regex(ENV_KEY_RE, 'must be an environment variable name');

/** A label a machine declares for what teamai does not model, such as `computer-use` or `gpu`, as a CI runner's are. */
export const LabelSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'must be lowercase letters, digits, dot, dash or underscore');

/**
 * `requires:` on a step, and `defaults.requires` in a workflow file, which acts as if written on every step of it.
 * A step that needs a person says `interactive: true`. `env` lists team env keys by name; values never enter the run.
 * `strict: true` makes the block's `isolation` and `network` strict, and a floor for every level inside it. `labels`
 * names what the machine that runs the step must declare, in `workflows.labels` or a fleet entry's `labels`. `host: true`
 * keeps the step on this machine (`isPinnedToHost`), a strict requirement: the host command slot runs a command, a
 * runtime of the definition that runs here a prompt.
 */
export const RequirementsSchema = z.object({
  network: z.boolean().optional(),
  isolation: IsolationSchema.optional(),
  env: z.array(EnvKeySchema).optional(),
  labels: z.array(LabelSchema).optional(),
  strict: z.boolean().optional(),
  host: z.literal(true).optional(),
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
  /** A command step: the driver runs commands (`can.exec` is not false). Setup is a command too. */
  exec: 'strict',
  /** Running the workflow's `setup` in each workspace the driver creates, before the step. */
  setup: 'strict',
  /** A prompt step: `can.tools` lists the tool it names, or the one the driver picks for it. */
  tools: 'strict',
  /** A prompt step with `permissions: unattended`: the driver launches its tool in that tool's unattended mode. */
  unattended: 'strict',
  /** A step in a clone or with a role is leased only through `next --prepare`, so teamai made its copy. Process-only. */
  prepare: 'strict',
  /** A step that runs with a team `role`: the driver runs it with what teamai delivered into its copy for that role. */
  role: 'strict',
  /** A step confined to a directory: an offer in `can.confined` at a level its `confined.json` asks for, or above. */
  confined: 'strict',
  /** A confined step whose model a tool of those offers resolves. */
  model: 'strict',
  /** A step pinned to this host (`Offer.pinned`): a driver here (`can.remote` is not set). */
  host: 'strict',
  /** A prompt step: the driver takes prompts (`can.prompt` is not false); an answer step: it takes answers (`can.answer` is not false). */
  prompt: 'strict',
  /** A command step that is not pinned to the host: the driver takes it (`can.commands` is not `pinned`). */
  commands: 'strict',
  /** `requires.labels`: the driver declares every label (`can.labels`), a promise teamai does not check. */
  labels: 'strict',
  /** A `workflow:` step leased whole: the driver runs its sub-graph as one attempt (`can.workflow`). Process-only. */
  workflow: 'strict',
} as const satisfies Record<string, 'strict' | 'bestEffort'> & Record<keyof Floor | 'env', 'strict' | 'bestEffort'>;

type Enforcement = typeof ENFORCEMENT;

type KeysOf<E extends Enforcement[keyof Enforcement]> = { [K in keyof Enforcement]: Enforcement[K] extends E ? K : never }[keyof Enforcement];

export type StrictKey = KeysOf<'strict'>;

type BestEffortKey = KeysOf<'bestEffort'>;

/**
 * A driver's `can` as the engine reads it: the protocol's keys, and those the local loop sets on the runtimes of a
 * driver definition, which no driver or runtime declares in `can`.
 * - `remote`: the runtime runs steps away from this host, so it takes no command step pinned to the host.
 * - `prompt: false`: it takes no prompt step, only answer steps, as the host command slot of a definition with no `local`.
 * - `answer: false`: it takes no answer step either, which calls the member's tool, as the host slot of a definition
 *   with no runtime open, such as the built-in `host`.
 * - `commands: 'pinned'`: of command steps, it takes only those pinned to the host, since another runtime of the
 *   definition runs commands. A prompt it takes still brings its setup, which runs where the prompt runs.
 * - `fullAccess`: the tools its init reports in `permissions` as running without permission prompts. Of a runtime
 *   that reports it, `unattended` holds only for those tools.
 * - `labels`: what the machine that runs its steps declares: `workflows.labels` for this host, a fleet entry's `labels`.
 * - `workflow`: it runs a whole `workflow:` step as one attempt, as the fleet runtime does, so `next` leases such a step
 *   to it whole instead of starting its workflow (`whole-workflow.ts`).
 * - `env: 'member'`: as `true`, but the machine that runs the step gives each `requires.env` its value, as a fleet
 *   member does from its own team env, so this host needs none for the step, only for its setup, which runs here.
 */
export type DriverCan = Omit<Can, 'env'> & {
  env?: DriverEnv; remote?: true; prompt?: false; answer?: false; commands?: 'pinned'; fullAccess?: readonly string[]; labels?: readonly string[]; workflow?: true;
};

/** How far a driver's `env` reaches, none first: the protocol's values, then `member`, which a fleet entry declares. */
export const DRIVER_ENV_REACH = [false, 'commands', true, 'member'] as const satisfies ReadonlyArray<Can['env'] | 'member'>;

export type DriverEnv = (typeof DRIVER_ENV_REACH)[number];

/** A fleet entry's `can.env`: the protocol's values, or `member`. */
export const DriverEnvSchema = z.literal(DRIVER_ENV_REACH, { error: "Expected true, false, 'commands' or 'member'" });

/**
 * A `can` that decides every key a driver or runtime declares over the wire, as the local driver and each skill host do.
 * `default_tool` is no capability but the app's own default, which a driver that drives no app leaves out.
 */
export type DecidedCan = Required<Omit<Can, 'default_tool'>> & Pick<Can, 'default_tool'>;

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
  /** The tool whose usage limit holds the step until it resets, as the driver named it in `limitedTools`. */
  limitedTool?: string;
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
 * The requirements in effect at a level: each level's keys replace the earlier ones, `env` and `labels` lists add up, and
 * `host` holds once any level sets it. The
 * `isolation` and `network` of a strict level, or of a level's `floor`, join the floor, and a value below it is raised.
 */
export function mergeRequirements(...levels: ReadonlyArray<(Requirements & Pick<InEffect, 'floor'>) | undefined>): InEffect {
  const given = levels.filter((level) => level !== undefined);
  const merged: InEffect = {};
  let floor: Floor = {};

  for (const { host, network, isolation, strict, floor: inner = {} } of given) {
    if (host) merged.host = true;

    if (network !== undefined) merged.network = network;

    if (isolation !== undefined) merged.isolation = isolation;
    floor = raised(raised(floor, inner), strict ? { network, isolation } : {});
  }

  const env = [...new Set(given.flatMap((level) => level.env ?? []))];

  if (env.length > 0) merged.env = env;
  const labels = [...new Set(given.flatMap((level) => level.labels ?? []))];

  if (labels.length > 0) merged.labels = labels;

  if (floor.isolation === undefined && floor.network === undefined) return merged;

  return { ...raised(merged, floor), floor };
}

/**
 * The labels of `requires` that `declared` does not name: what keeps a step from the machine, runtime or fleet member that
 * declares `declared`. The one reading of `requires.labels` the owner's negotiation, a fleet member and a published run's
 * taker share.
 */
export function lackedLabels(requires: Pick<InEffect, 'labels'>, declared: readonly string[] | undefined): string[] {
  return (requires.labels ?? []).filter((label) => !(declared ?? []).includes(label));
}

/** `values` with each of `isolation` and `network` raised to `floor`'s, where `floor` sets it higher. */
function raised<T extends Floor>(values: T, floor: Floor): T {
  const isolation = floor.isolation !== undefined && (values.isolation === undefined || rank(values.isolation) < rank(floor.isolation)) ? floor.isolation : values.isolation;
  // Denying the network keeps a step further from the member's machine, so only a floor of `false` raises a value.
  const network = floor.network === false ? false : values.network;

  const result = { ...values };

  if (isolation !== undefined) result.isolation = isolation;

  if (network !== undefined) result.network = network;

  return result;
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

/** What runs a step: a process of the driver's own, an agent, or a whole workflow's steps, as one attempt. */
export type Executor = 'command' | 'prompt' | 'workflow';

/** Whether `can.env` covers a step run by `executor`, and the setup before it. */
interface EnvCover {
  step: boolean;
  setup: boolean;
}

function envCovers(env: DriverCan['env'], executor: Executor): EnvCover {
  switch (env) {
    case undefined:
    case false:
      return { step: false, setup: false };
    case true:
    case 'member':
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
  /** The tool a prompt step runs on: the one it names, or the one the driver picks for it. */
  tool?: string;
  /** A prompt step with `permissions: unattended`. */
  unattended: boolean;
  /** The lease runs in a clone, which only teamai prepares. */
  clone: boolean;
  /** The caller asked `next --prepare`. */
  prepare: boolean;
  /** The step runs only on this host (`isPinnedToHost`). Absent: not pinned, unless `requires.host` pins it. */
  pinned?: boolean;
  /** An answer step, which a slot that runs no prompt step takes. Absent: not one. */
  answer?: boolean;
  /** The team role the step's copy runs with: its clone's, or the step's own in a worktree copy. */
  role?: string;
}

/**
 * The runtime that runs a step in teamai's process, as its records name it: `tools` for a prompt, `host` for a command
 * or an answer, which the member's tool answers on the host slot.
 */
export function inProcessRuntimeOf({ isPrompt, isAnswer }: { isPrompt: boolean; isAnswer: boolean }): 'tools' | 'host' {
  return isPrompt && !isAnswer ? 'tools' : 'host';
}

/**
 * Whether a step runs only on this host, so no runtime that runs steps away from it (`can.remote`) takes it:
 * - an answer step, which the local loop answers with the member's tool here, whatever runtime takes its lease;
 * - a command step of a workflow teamai ships, which does its bookkeeping against the run's files, this machine's
 *   sessions and the team repo;
 * - a step that publishes to a teamai data branch;
 * - a step that declares `requires.host`, or whose file's `defaults.requires` does: each shipped workflow sets it once
 *   there when every step it reaches runs here and it runs no workflow by name, which a team may replace, and on each
 *   command step otherwise, so a team copy of one under another name keeps the pin. The pins above stay as a floor for a shipped step that forgets the key.
 */
export function isPinnedToHost({ step, executor, inShippedWorkflow, requires }: {
  step: Pick<WorkflowStep, 'answer' | 'deliver'>; executor: Executor; inShippedWorkflow: boolean; requires: Pick<InEffect, 'host'>;
}): boolean {
  return step.answer !== undefined || (executor === 'command' && inShippedWorkflow) || step.deliver === 'publish' || requires.host === true;
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

/** What an interactive step lacks on a driver that cannot ask a person. */
function personGap(interactive: boolean, can: Pick<DriverCan, 'hitl'>): Missing[] {
  return interactive && !can.hitl ? ['hitl'] : [];
}

/** What a step that runs on `tool` lacks on a driver that cannot launch it. */
function toolGap(tool: string | undefined, can: Pick<DriverCan, 'tools'>): Missing[] {
  return tool !== undefined && lacksTool(tool, can) ? ['tools'] : [];
}

/**
 * The env scope of a process that requires `keys` under `floor`: it gets each, but what a strict sandbox strips, and is
 * kept from `guarded` (the team's declared keys and the run's `requires.env` keys) and the strip list, but what it gets.
 * The one reading the owner's negotiation and a fleet member share.
 */
export function envScopeOf(keys: readonly string[], { floor = {}, guarded }: { floor?: Floor; guarded: readonly string[] }): EnvScope {
  // A strict sandbox's strip list wins over every requires.env, so no step under it is handed a credential.
  const stripped: readonly string[] = floor.isolation === 'sandbox' ? SANDBOX_WITHHELD_ENV : [];
  const provide = keys.filter((key) => sameEnvName(stripped, key) === undefined);
  const withhold = [...new Set([...guarded, ...stripped])].filter((key) => sameEnvName(provide, key) === undefined).sort();

  return { provide, withhold };
}

/**
 * Decides whether this driver may take the step, and on what terms. Pure: the engine calls it at both places it hands
 * out a lease. In order: an `env:` key that shadows a team secret or a required key fails; what the member's policy refuses
 * holds; every strict capability the driver lacks holds; a required key with no value here fails, for a driver that
 * would provide it; else the step is granted, with each best-effort gap listed in `unenforced`.
 */
export function negotiate(offer: Offer, can: DriverCan, allow: Allow, env: EnvFacts): Negotiation {
  const { floor = {}, ...requires } = offer.requires;
  const sealed = floor.isolation === 'sandbox';
  const guarded = [...env.declared, ...offer.runEnvKeys];
  const shadowed = offer.envKeys.filter((key) => sameEnvName([...env.secrets, ...offer.runEnvKeys], key) !== undefined);

  if (shadowed.length > 0) {
    return { kind: 'fail', failure: { code: 'env_conflict', message: `Step "${offer.step}" sets env ${shadowed.join(', ')}, which a team secret or a requires.env of the run names. Rename the step's variable, or remove it from env:.` } };
  }

  const { provide: required, withhold } = envScopeOf(requires.env ?? [], { floor, guarded });
  const { provide: setupKeys, withhold: setupWithhold } = envScopeOf(offer.setup?.requires?.env ?? [], { floor, guarded });
  const covers = envCovers(can.env, offer.executor);
  const policy: Missing[] = [];

  if (allow.network === false && requires.network === true) policy.push('policy.network');

  if (allow.env && [...required, ...setupKeys].some((key) => sameEnvName(allow.env ?? [], key) === undefined)) policy.push('policy.env');
  const provided = providedIsolation(can, offer.hasContract);
  // A step that requires the host is pinned whether or not its caller derived the pin.
  const pinned = offer.pinned === true || requires.host === true;

  const gaps: Missing[] = policy.length > 0 ? policy : [
    ...toolGap(offer.tool, can),
    ...(offer.unattended && !runsUnattended(offer.tool, can) ? ['unattended' as const] : []),
    ...(floor.isolation !== undefined && rank(floor.isolation) > rank(provided) ? ['isolation' as const] : []),
    ...(floor.network === false && !can.network ? ['network' as const] : []),
    // Only teamai delivers a role into a copy: one a driver makes itself gets the member's resources.
    ...((offer.clone || offer.role !== undefined) && !offer.prepare ? ['prepare' as const] : []),
    ...(offer.role !== undefined && !can.role ? ['role' as const] : []),
    ...personGap(offer.interactive, can),
    ...(offer.executor === 'command' && can.exec === false ? ['exec' as const] : []),
    ...(offer.executor === 'workflow' && can.workflow !== true ? ['workflow' as const] : []),
    ...(pinned && can.remote ? ['host' as const] : []),
    ...(offer.executor === 'prompt' && (offer.answer === true ? can.answer === false : can.prompt === false) ? ['prompt' as const] : []),
    ...(can.commands === 'pinned' && offer.executor === 'command' && !pinned ? ['commands' as const] : []),
    // Setup runs as a command, so a driver that runs none runs no setup either, whatever it says of setup.
    ...(offer.setup && (!can.setup || can.exec === false) ? ['setup' as const] : []),
    // A strict sandbox keeps its strip list from every process of the step, which only a driver with `can.env: true` or `member` does.
    ...((required.length > 0 && !covers.step) || (setupKeys.length > 0 && !covers.setup) || (sealed && can.env !== true && can.env !== 'member') ? ['env' as const] : []),
    ...(offer.budgeted && !offer.interactive && !can.tokens ? ['tokens' as const] : []),
    ...(lackedLabels(requires, can.labels).length > 0 ? ['labels' as const] : []),
  ];

  const [first, ...rest] = gaps;

  if (first !== undefined) return { kind: 'hold', missing: [first, ...rest] };

  // A step whose values the machine that runs it gives needs none here; its setup still runs here.
  const isGivenThere = can.env === 'member';

  if (covers.step || covers.setup) {
    const unavailable = (isGivenThere ? undefined : envUnavailable(`Step "${offer.step}"`, required, env)) ?? envUnavailable(`The setup of step "${offer.step}"`, setupKeys, env);

    if (unavailable) return { kind: 'fail', failure: unavailable };
  }

  const unenforced: Unenforced[] = [];

  if (requires.network === false && !can.network) unenforced.push({ requirement: 'network', asked: false });
  const asked = requires.isolation;

  if (asked !== undefined && asked !== 'none' && rank(asked) > rank(provided)) unenforced.push({ requirement: 'isolation', asked, provided });

  if (!covers.step && withhold.length > 0) unenforced.push({ requirement: 'withhold', keys: withhold });

  if (offer.maxTurns !== undefined && !can.max_turns) unenforced.push({ requirement: 'max_turns', asked: offer.maxTurns });

  if (offer.endTurn && !can.end_turn) unenforced.push({ requirement: 'on_limit' });
  const limits = offer.endTurn && can.end_turn ? { limits: offer.endTurn } : {};
  const envScope = covers.step && (required.length > 0 || withhold.length > 0) ? { envScope: { provide: isGivenThere ? [] : required, withhold } } : {};
  const maxTurns = offer.maxTurns !== undefined && can.max_turns && !limits.limits ? { maxTurns: offer.maxTurns } : {};
  const setup: Pick<Terms, 'setup'> = {};

  if (offer.setup) {
    const leased: LeaseSetup = { command: offer.setup.command };

    if (covers.setup && (setupKeys.length > 0 || setupWithhold.length > 0)) leased.envScope = { provide: setupKeys, withhold: setupWithhold };
    setup.setup = leased;
  }

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

/** Whether a driver that declares `can` is held from a step that runs on `tool`. */
/** Whether a driver runs a prompt on `tool` unattended: it offers it, and on a runtime that reports full access, for that tool. */
function runsUnattended(tool: string | undefined, can: Pick<DriverCan, 'unattended' | 'fullAccess'>): boolean {
  return can.unattended === true && (can.fullAccess === undefined || (tool !== undefined && can.fullAccess.includes(tool)));
}

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
