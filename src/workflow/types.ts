/** Workflow types for the v1alpha1 local-driver subset. */

import type { ContractCode, RunOrigin } from '../default-workflows.js';
import type { RunMode } from '../launch-context.js';
import type { TeamPin } from './team-pin.js';
import type { DeliveryReceipt, UnresolvedCreate } from './delivery-schema.js';
import type { ArchivedPass, LimitsFrom, ReleasedTokens, SessionContinuation, StepState, StoppedAttempt } from './step-state.js';
import type { OnLimit, Requirements, Setup, TurnLimits, Unenforced } from './requirements.js';
import type { LeaseSession } from './workspace.js';
import type { ConfinedLease } from './lease-wire.js';
import type { StepModel } from './step-model.js';
import type { ClonePlace } from './clone.js';
import type { JsonValue } from '../types.js';
import type { DriverName } from './driver-name.js';

/** The driver's lease ownership, independent of its per-request capabilities. */
export interface DriverIdentity {
  kind: string;
  machine: string;
  workspace: string;
}

export type OutputSchema =
  | { type: 'string' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'enum'; values: string[] }
  | { type: 'object'; fields: Record<string, OutputSchema> }
  | { type: 'array'; items: OutputSchema }
  /** Any JSON value, which no expression reads into; a workflow's `outputs` may pass it whole. Step outputs only. */
  | { type: 'json' }
  /**
   * A workflow bundle, `{ definition, workflows?, scorers?, teamRevision? }`, admitted when its step reports, which a
   * `from` step runs. Only one field of a step's object output may have it.
   */
  | { type: 'workflow' };

/** A HITL request that must settle before its step can act or reach an end. */
export interface StepHitl {
  /** The YAML declaration, with approve as the yes-or-no case. */
  kind: 'approve' | 'choose';
  /** Template text rendered from the step's ready context. */
  message: string;
  /** The choices an answer must name exactly. */
  options: string[];
  /** The default for an optional choose when a driver without HITL uses auto approval. */
  default?: string;
  /** Whether the answer must come from a person at a terminal or through a driver UI's declared answer. */
  required: boolean;
}

/**
 * Whether only a person can answer `hitl` for a driver without HITL: a required request, or a choice that auto-approve
 * does not answer, as it answers only a choice with a default and only when `autoApprove`. An optional approval nobody
 * answers is skipped instead.
 */
export function onlyPersonAnswers(hitl: Pick<StepHitl, 'kind' | 'required' | 'default'>, { autoApprove }: { autoApprove: boolean }): boolean {
  return hitl.required || (hitl.kind === 'choose' && !(autoApprove && hitl.default !== undefined));
}

export interface WorkflowStep {
  id: string;
  /** Step ids this step waits for. Absent only on the first step, which is a root. */
  needs?: string[];
  /** Expression source; a false value skips the step. */
  if?: string;
  command?: string;
  /** Resolved, revision-bound prompt text. */
  prompt?: string;
  /** Original team-repo-relative source path for a cached prompt. */
  promptFile?: string;
  /**
   * A prompt the member's AI tool answers with text, or with JSON that matches `output`, in the checkout read-only: the tool the
   * member's `ai.tool` names, else the first installed one, on its one-shot call launch.
   */
  answer?: string;
  /** On a command step: the paths, relative to the checkout, under which a change the command makes is kept, not `read_only_dirty`. */
  writes?: string[];
  /** A person works in the prompt tool; only a driver with HITL can take the lease. */
  interactive?: true;
  /** The question answered before this step's action or end. */
  hitl?: StepHitl;
  agent?: string;
  /** The tool a prompt step runs on, as written. Only a driver that lists it in `can.tools` takes the step. */
  tool?: string;
  /**
   * The model a prompt step runs on: an alias from `models/aliases.yaml` or a model name, as written, which the driver
   * resolves; or the exact model, which every driver passes to the tool as is.
   */
  model?: string | StepModel;
  /** The scorers that judge this prompt or workflow step's succeeded passes. */
  scorers?: StepScorers;
  output?: OutputSchema;
  /** Variables a command step receives, as written; `{{ inputs.… }}` and `{{ steps.… }}` render when the step is leased. */
  env?: Record<string, string>;
  /**
   * The workflow this step runs, as written: a name, which the cache keeps and `start` snapshots into the run; an inline
   * workflow, kept in place; or `{ from }`, the workflow output of a step it needs, admitted when that step reports.
   * Read it through {@link stepWorkflow}.
   */
  workflow?: string | InlineWorkflow | WorkflowFrom;
  /** Values for the inputs of the workflow this step runs, as written; every string inside follows the template rules. */
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- YAML toJSON can hold values JSON cannot, such as the Uint8Array a !!binary tag decodes to; the inputs check at start types them
  with?: Record<string, unknown>;
  /** Name in `ends` this step finishes the workflow with when it succeeds. A step with no action only ends the workflow and is never leased. */
  end?: string;
  /** Runs the steps from `backTo` to this step again after this step succeeds. */
  loop?: StepLoop;
  /** Expression source, evaluated when this step succeeds; when true, its workflow, or that workflow's loop, ends as success. */
  break?: string;
  /** Runs the step's action once per item of a list, each as an instance such as `build[2]`. */
  forEach?: ForEach;
  /**
   * The step, or any of its items, may end failed, timed out or cancelled without failing the workflow it is in. Its
   * outcome still reads as it ended, and its dependents follow the usual rules.
   */
  continueOnFailure?: true;
  /**
   * Where the step runs. A command that omits it uses the active checkout and is read-only.
   * A prompt that omits it continues an enclosing `new`, `continue` or clone copy, or stays read-only.
   */
  workspace?: StepWorkspace;
  /**
   * The team role from `manifest/roles.yaml` the copy this step runs in gets: the role's skills, rules, agents and other
   * knowledge, with the member's hooks, MCP, env and models. On a step that opens a copy, every step continuing that
   * copy runs with it; on a `workflow` step, it is the role of each step inside that names none (`resolvedRoleOf`).
   * Where an item is bound it may be a template of it, such as `{{ item.role }}`, which each item's lease renders. Kept
   * as written, as run files and the cache store it; read it through `roleLevelOf`, which tells an id from a template.
   */
  role?: string;
  /**
   * `pr`: opens a review request after the branch's work succeeds; TeamAI never merges it. `publish`: pushes what the
   * step staged to the teamai data branch of its team workspace, only the member's own files.
   */
  deliver?: 'pr' | 'publish';
  /** A session this step resumes. `continue` uses this step's previous pass. `from` names another step. */
  session?: { continue: true } | { from: string };
  /** What the driver that runs this step, or every step of the workflow it runs, must provide. */
  requires?: Requirements;
  /** Milliseconds the step's lease, or the workflow or items it runs, may take before the step fails with `timeout`. */
  timeout?: number;
  /**
   * On a workflow step: the tokens its workflow may spend each time the step starts, a loop's next pass or a retry
   * included. Spending more fails the step with `budget_exceeded`.
   */
  budget?: Budget;
  /** On a prompt step: the most agent turns its tool may take, for a driver that can cap them. */
  maxTurns?: number;
  /**
   * On a prompt step: `unattended` lets its tool edit and run commands without asking. Valid only under a strict
   * `isolation: sandbox` floor, and leased only to a driver with `can.unattended`.
   */
  permissions?: 'unattended';
  /**
   * What reaching `timeout`, `max_turns` or `budget` does. `fail`, the default, fails the step. `end_turn` ends the
   * agent's turn: on a prompt step the limits count from tool launch and the step succeeds with the limit it reached;
   * on a workflow step `timeout` and `budget` are an allowance its prompt turns spend.
   */
  onLimit?: OnLimit;
}

/**
 * The input and output tokens a workflow may spend over every pass of its steps, counted from when it starts: the run's
 * from its start, or from the retry that reopened it, and a workflow step's from each time the step starts.
 */
export interface Budget {
  tokens: number;
}

/** A `for_each`: the list of items, and how many of them may run at once. */
export interface ForEach {
  /** Expression source that gives the list. */
  items: string;
  /**
   * At most this many items are started and not yet settled: a whole number from 1, or the source of a template that
   * reads one number input, rendered when the step starts its items. No limit when absent.
   */
  maxParallel?: number | { template: string };
}

/**
 * A workflow loop. When a round reaches no end, every step of the workflow runs again, while `while` is true, or
 * always when there is none. The workflow runs at most `maxIterations` rounds; one more fails it with `loop_exhausted`.
 */
export interface WorkflowLoop {
  /** Expression source, evaluated when a round has nothing left to run. */
  while?: string;
  maxIterations: number;
}

/**
 * A step loop. After its step succeeds, every step from `backTo` to it runs again, while `while` is true, or always
 * when there is none. The step runs at most `maxIterations` times; a run past that fails it with `loop_exhausted`.
 */
export interface StepLoop {
  /** The step itself, or a step it needs, directly or not. */
  backTo: string;
  /** Expression source, evaluated when the step succeeds. */
  while?: string;
  maxIterations: number;
}

/**
 * Where a step runs: in the checkout as it is, in a new copy, in the copy an enclosing step opened, in a fresh clone
 * teamai prepares, or in a fresh clone of the team repo. A driver lists the ones it provides in `can.workspace`.
 */
export const WORKSPACE_MODES = ['read-only', 'new', 'continue', 'clone', 'team'] as const;

/**
 * The team repo branch a step commits to, `{ team: { branch } }`: a template that reads only `inputs`, so every run
 * with the same inputs goes on with the same branch and its one pull request. Without `branch`, the run's own.
 */
export interface TeamPlace {
  branch?: string;
}

/**
 * The directory a prompt step runs confined to, `{ confined: <dir> }`: a template of the inputs, the item and the outputs
 * of steps it needs, rendered when the step is leased. A relative directory is under the run's `$TEAMAI_RUN_DIR`.
 */
export interface ConfinedPlace {
  confined: string;
}

/** A step's `workspace` as written: a mode, the clone it opens, the team repo branch it commits to, or the directory it is confined to. */
export type StepWorkspace = Exclude<typeof WORKSPACE_MODES[number], 'clone' | 'team'> | { clone: ClonePlace } | { team: TeamPlace } | ConfinedPlace;

/** The keys that give a step its action, as YAML writes them, each with the definition field it fills. */
export const STEP_ACTIONS = { command: 'command', prompt: 'prompt', prompt_file: 'promptFile', answer: 'answer', workflow: 'workflow' } as const satisfies Record<string, keyof WorkflowStep>;

/** Whether a step runs work rather than only a HITL request or end. */
export function hasAction(step: WorkflowStep): boolean {
  return Object.values(STEP_ACTIONS).some((field) => step[field] !== undefined);
}

export type EndOutcome = 'succeeded' | 'failed';

/** `workflow: { from: <step> }`: the step runs the `workflow` output of step `from`, which it needs. */
export interface WorkflowFrom {
  from: string;
}

/** What a step's `workflow` names: a workflow file, an inline workflow, or the workflow output of a step it needs. */
export type StepWorkflow =
  | { kind: 'named'; name: string }
  | { kind: 'inline'; workflow: InlineWorkflow }
  | { kind: 'from'; step: string };

/** The workflow `step` runs, as its `workflow` names it, or undefined for a step that runs none. Every reader of `workflow` goes through here. */
export function stepWorkflow({ workflow }: Pick<WorkflowStep, 'workflow'>): StepWorkflow | undefined {
  if (workflow === undefined) return undefined;

  if (!(workflow instanceof Object)) return { kind: 'named', name: workflow };

  return 'from' in workflow ? { kind: 'from', step: workflow.from } : { kind: 'inline', workflow };
}

/** Whether `workflow` is a workflow file, named or admitted, rather than an inline workflow, which has no name. */
export function isWorkflowFile(workflow: WorkflowDefinition | InlineWorkflow): workflow is WorkflowDefinition {
  return 'name' in workflow;
}

/**
 * The workflow `step` runs in `run`, where `prefix` is the path of the workflow the step is in (`''` at the top): an
 * inline one as written, a file as the run pinned it, or the workflow its `from` step's output was admitted as.
 * Undefined when the run holds none of those.
 */
export function workflowRunBy(
  run: Pick<RunState, 'workflows' | 'admitted'>, step: Pick<WorkflowStep, 'workflow'>, prefix: string,
): WorkflowDefinition | InlineWorkflow | undefined {
  const runs = stepWorkflow(step);

  switch (runs?.kind) {
    case undefined:
      return undefined;
    case 'named':
      return run.workflows?.[runs.name];
    case 'inline':
      return runs.workflow;
    case 'from':
      return run.admitted?.[`${prefix}${runs.step}`]?.definition;
    default: {
      const unhandled: never = runs;

      return unhandled;
    }
  }
}

/**
 * A workflow written inside a step. It has no inputs of its own: its steps read the enclosing workflow's inputs
 * and the steps the enclosing step needs, directly or through their needs.
 */
export interface InlineWorkflow {
  ends?: Record<string, EndOutcome>;
  outputs?: Record<string, string>;
  loop?: WorkflowLoop;
  steps: WorkflowStep[];
}


/** Values a workflow file sets for its steps. */
export interface WorkflowDefaults {
  /** The model of a prompt step whose step and definition choose none, as written. */
  model?: string;
  /** Whether a step's scorers share one judge call when the step does not say. */
  scorers?: { batch: boolean };
  /** Requirements as if written on every step of the file. */
  requires?: Requirements;
  /** The role of a step of the file that names none and runs inside no `workflow` step that names one. */
  role?: string;
  /** The value of each input it names when a start or a step's `with` leaves that input out; of the input's type. */
  inputs?: Record<string, JsonValue>;
}

/** `scorers: [a, b]`, or `scorers: { names: [a, b], batch: true }`. Each name is a file in `scorers/`. */
export interface StepScorers {
  names: string[];
  batch?: boolean;
  /** `all`: every pass is judged, whatever the scorers sample. */
  sampling?: 'all';
  /** Who starts the scoring of the step's passes: teamai after each pass (`auto`), or the workflow's own steps (`workflow`). */
  start?: ScoringStart;
}

export const SCORING_STARTS = ['auto', 'workflow'] as const;

export type ScoringStart = (typeof SCORING_STARTS)[number];

/**
 * Who started a run: a person, from a process with no agent evidence; an agent session; or one of the CLI's own automatic
 * starts, which pass no agent evidence and take no inputs from an agent.
 */
export const STARTED_BY = ['person', 'agent', 'cli'] as const;

export type StartedBy = typeof STARTED_BY[number];

/** Whether an agent session may start a workflow: on its own (`allow`), after the person's yes (`ask`), or never (`deny`). */
export const INVOKE_VALUES = ['allow', 'ask', 'deny'] as const;

export type Invoke = typeof INVOKE_VALUES[number];

export interface WorkflowDefinition {
  /** Absent means `deny`. */
  invoke?: Invoke;
  /** Another name `workflow start` accepts. It starts nothing while another workflow has it as alias or name. */
  alias?: string;
  /**
   * The workflow's own steps, and those of every workflow they run, stay on this machine: their sessions are never
   * archived and their outputs never published. A run of it as the root run publishes nothing and is never claimed.
   */
  private?: true;
  schemaVersion: 'v1alpha1';
  name: string;
  description: string;
  /** Values `start --inputs` must pass, each typed with the output shorthand: all but those `defaults.inputs` gives. */
  inputs?: Record<string, OutputSchema>;
  /** Named ends a step can finish this workflow with, each with the run outcome it gives. */
  ends?: Record<string, EndOutcome>;
  /** Values this workflow returns to a step that runs it, each a path such as `steps.<id>.outputs.<field>`. */
  outputs?: Record<string, string>;
  /** Runs the workflow's steps again, round after round. */
  loop?: WorkflowLoop;
  defaults?: WorkflowDefaults;
  /** Milliseconds a run of this file may take, counted from its start, or from the step that runs it. */
  timeout?: number;
  budget?: Budget;
  /** Runs in each workspace a driver creates for a step of this file, or of a workflow it runs that has no setup. */
  setup?: Setup;
  /**
   * `new`: the steps work in one copy. A run of this file opens it (the run copy); a step that runs it continues the copy
   * it has or is in, and opens one, as with `workspace: new`, when it has none.
   */
  workspace?: 'new';
  steps: WorkflowStep[];
  /**
   * Read-only command steps that run once the run's steps end, whatever the outcome, a timeout or a cancel included.
   * Only the run's own workflow runs them, never a workflow a step runs.
   */
  finally?: WorkflowStep[];
}

export interface WorkflowDiagnostic {
  file: string;
  line: number;
  column: number;
  field: string;
  message: string;
  /**
   * The cache must not keep an older runnable copy of a file with any code.
   * `unknown_key`: a key this version does not know.
   * `missing_needs`: a step after the first has no `needs`; a copy cached under the old linear rules must not run as a graph.
   * `false_if`: an `if` is always false; an older copy would still run the step the author turned off.
   * `bad_template`: a `{{ inputs.… }}` or `{{ steps.… }}` that does not read a valid path; a prompt cached before
   *   templates existed would now render it as empty text instead of the text it was written as.
   * `dotted_name`: a step id or an `inputs` or `output` field name contains "."; no path can read it, and a
   *   step id would clash with the dotted paths that address steps inside a sub-workflow.
   * `undeclared_output`: a read names an output the workflow a step runs does not declare;
   *   the file may be unchanged while that workflow changed, and the kept copy would read null where it expects a value.
   * `undeclared_end`: an `if` compares `steps.<id>.end` with a name the workflow step `<id>` runs does not declare in `ends`;
   *   for the same reason, the kept copy would take a branch that can never match.
   * `bad_loop`: a `loop`, `break` or `for_each` pull rejects; the kept copy would run once the steps the author wrote
   *   to repeat or to run per item, or run on past the point the author wrote to stop at.
   * `bad_session`: a `session.from` pull rejects, one naming a step that runs with another role included; the kept copy
   *   would resume a step the author did not name, or a session with the knowledge of another role.
   * `bad_workspace`: `workspace` is not read-only, new, or continue; the kept copy would run the step in the wrong place.
   * `bad_role`: a step or `defaults` `role` pull rejects; the kept copy would run the step with the knowledge of a role
   *   the author did not name, or without the one the author named.
   * `bad_delivery`: delivery is not PR creation on a writable branch; the kept copy would apply a different policy.
   * `bad_invoke`, `bad_alias`: the kept copy would let agents start the workflow, or start it by a name, the author
   *   changed.
   * `alias_conflict`: another workflow has the same alias, or takes it as its name. The workflow is cached and starts by
   *   name; only the alias starts nothing.
   * `ContractCode`: a team file breaks the contract of a default it replaces or runs (`DefaultWorkflows.overrideProblems`);
   *   teamai's default runs, never an older team copy.
   */
  code?: 'unknown_key' | 'missing_needs' | 'false_if' | 'bad_template' | 'dotted_name' | 'undeclared_output' | 'undeclared_end' | 'bad_loop' | 'bad_session' | 'bad_workspace' | 'bad_role' | 'workflow_namespace_conflict' | 'prompt_namespace_conflict' | 'benchmark_namespace_conflict' | 'bad_delivery' | 'bad_invoke' | 'bad_alias' | 'alias_conflict'
    | ContractCode;
}

export type StepOutcome = 'success' | 'failed' | 'released';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StepLease {
  attempt: string;
  revision: number;
  driver: DriverIdentity;
  /** The session the lease offers the step: the report may name it, or one it continued, as `resumed`. */
  session?: LeaseSession;
  /** The best-effort requirements the driver could not enforce, decided when the lease was issued; a hand-back only adds. */
  unenforced?: Unenforced[];
  /** When the step's own `timeout` ends this lease, counted from `leasedAt` so a hand-back does not extend it. */
  expiresAt?: string;
  /** When the attempt was first leased, or last listed `queued` by its driver. Absent on a lease issued before teamai recorded it. */
  leasedAt?: string;
  /** The run mode the driver runs the lease in, as its `next` reported it, so the pass keeps it however it settles. */
  runMode?: RunMode;
  /** The turn limits the lease carried, for a driver that ends the turn at them. */
  limits?: TurnLimits;
  /** The terms a confined step was last leased with, which its report is checked against. Absent on a lease issued before teamai kept them. */
  confined?: LeasedConfined;
}

/** Of the terms a confined step is leased with, the tools it may run on and the least level it must reach. */
export type LeasedConfined = Pick<ConfinedLease, 'level' | 'tools'>;

export interface WorkflowFailure {
  code: string;
  message: string;
}

/**
 * A run whose steps ended while its `finally` steps run: the outcome, end and failure it ends with once they settle,
 * whatever they do, and when they must settle by.
 */
export interface Finalizing {
  outcome: Exclude<RunStatus, 'running'>;
  end?: string;
  failure?: WorkflowFailure;
  /** When the run's steps ended. */
  since: string;
  until: string;
}

/** Durable run file. `revision` rejects stale reports; `definition` is the cached snapshot. */
export interface RunState {
  schemaVersion: 'v1alpha1';
  id: string;
  name: string;
  revision: number;
  status: RunStatus;
  /** Identity of the latest driver that called next, retained so resume can recover its workspace. */
  driver?: DriverIdentity;
  /** The end this run reached, set when it settles. */
  end?: string;
  /** Set while the run's `finally` steps run, from when its steps end until it settles. Its status stays `running`. */
  finalizing?: Finalizing;
  /** Milliseconds `workflow start --timeout` gave the run; the shorter of it and the workflow's `timeout` applies. */
  timeout?: number;
  /** Why the run failed when no end says it, such as `loop_exhausted` on a looping top-level workflow. */
  failure?: WorkflowFailure;
  /** The validated `--inputs`, stored when the workflow declares inputs. */
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- engine.ts and handoff.ts write the inputs they checked as Record<string, unknown>
  inputs?: Record<string, unknown>;
  /** The alias that started the workflow when the run started: the name people use for it. Absent when it had none, or its alias started another workflow. */
  alias?: string;
  /** Covers `definition` and every workflow in `workflows`. */
  sourceHash: string;
  /** Remote-reachable team commit shared by every cached workflow in this run. */
  teamRevision?: string;
  /** The team revision the run started from, with a patch of the checkout's changes past it. Absent on older runs, and where the team checkout is no git repository. */
  teamPin?: TeamPin;
  /** The run mode `workflow start` resolved. A claim keeps it. Absent on runs started before it was recorded. */
  runMode?: RunMode;
  /** Whether `definition` is the team's or teamai's default. A claim keeps it. Absent on runs started before it was recorded, all team runs. */
  origin?: RunOrigin;
  /** Who started the run. A claim keeps it. Absent on runs started before it was recorded. */
  startedBy?: StartedBy;
  /** The driver `workflows.driver` started the run for, which the machine that started it does not run. Absent on a run started for no driver in particular. */
  awaits?: { driver: DriverName };
  definition: WorkflowDefinition;
  /** The sub-workflows the run uses, by name, as they were cached when it started. */
  workflows?: Record<string, WorkflowDefinition>;
  /**
   * The `workflow` outputs of the steps a `from` step runs, by the path of the producing step, admitted when it reported
   * and frozen for the run's life. The named workflows each brought are in `workflows`.
   */
  admitted?: Record<string, AdmittedWorkflow>;
  /**
   * Step instances in declaration order; a sub-workflow's steps follow the step that runs it. Never changed in place:
   * adding or removing an instance assigns a new array, so an index the engine keeps per array never goes stale.
   */
  steps: readonly StepState[];
  settledAttempts: string[];
  /** Cumulative settled-attempt count; settledAttempts is bounded at 32 for dedup. */
  settledCount?: number;
  /** Whether the run queued its end record when it settled. A run settled with usage reporting off, or before this field, queued none. */
  endRecordQueued?: boolean;
  /** Attempts whose lease the engine cancelled; a report of one is answered `lease_cancelled`. */
  cancelledAttempts?: string[];
  /** Passes of child and item instances a loop removed from `steps`. */
  archive?: ArchivedPass[];
  /** The tokens of attempts their driver released, or reported after the engine stopped them, which no pass keeps. */
  releasedTokens?: ReleasedTokens[];
  /** Attempts the engine stopped whose driver has not reported their tokens yet. Local run state only. */
  stoppedAttempts?: StoppedAttempt[];
  /** The round of a looping top-level workflow. */
  round?: number;
  /**
   * The commit the run's workspaces and agent configuration start from, and the branch it was on. Set by `workflow start`
   * in a git checkout, else by the first `next` that sends `base`. A later `base` does not change it.
   */
  base?: { ref?: string; commit: string };
  /** The checkout `workflow start` ran in, or the one a claim took the run into. Local run state only: never on a lease or a record. */
  checkout?: string;
  /** How the local driver of this install last drove the run, which a resume without those flags drives it with again. Local run state only. */
  driveOptions?: DriveOptions;
  /**
   * Workspaces this run has handed out, by branch. A `continue` step stays with the driver that opened the copy. A copy a
   * claim brought from another machine has no owner until a driver leases it. `from` is the run branch the copy started
   * from, `after` items before other needs, so a pull request from it targets the nearest delivered branch it grew from.
   * `used` is set once a step ran in the copy: a report on a lease of it was accepted, neither `released` nor a setup
   * failure. Only a lease on an unused copy carries setup, and only an unused copy's owner gives it up when it hands its
   * lease back. `used` is local run state only. `kind: clone` is a clone a step opened, which teamai prepared on its
   * owner's machine: it is never pushed. `kind: team` is a branch of the team repo, and `base` the commit of the team
   * repo's default branch its last step started from, which a pull request from it is compared with.
   */
  copies?: Record<string, { owner?: DriverIdentity; commit?: string; from?: string; used?: true } & ({ kind?: 'clone' } | { kind: 'team'; base?: string })>;
  /**
   * The pull requests delivered on this run, once each, in the order they first appeared. Append-only: a receipt says a
   * request was opened, never that it is still open, so whether a delivery reuses one is its host's lookup to say.
   */
  deliveries?: DeliveryReceipt[];
  /**
   * The pull requests TeamAI asked a host to open and has no receipt for, listed under the run lock right before each
   * create. A receipt or a lookup removes one; a retry, a cancel or an archive of its step does not.
   */
  creating?: UnresolvedCreate[];
  /**
   * Sessions a step resumed and continued under another id, in report order: a copy on another machine or in another
   * tool. `to` holds the turns of `from` and the ones that step added, so a step that would resume `from` resumes `to`.
   */
  sessionContinuations?: SessionContinuation[];
  /** How this machine last published the run, or took it from another machine. Local run state only. */
  publication?: RunPublication;
  /** What teamai removed of the run's branches once it settled, and what it kept. Local run state only. */
  leftovers?: RunLeftovers;
  createdAt: string;
  /**
   * Where the workflow's `timeout` and `budget` count from once a retry reopened the run, so the reopened run gets a whole
   * window and a whole budget. Absent, they count from `createdAt`, with nothing spent.
   */
  limitsFrom?: LimitsFrom;
  updatedAt: string;
  /**
   * Until when what the run left is kept: the time it first settled plus the `workflows.retention` its owner had then. A
   * later end does not change it. Past it a retry does not reopen the run, and `teamai doctor --fix` may remove what it
   * left. Absent until the run first settles, under `never`, and on runs settled before it was recorded.
   */
  retainedUntil?: string;
}

/**
 * A producer's output as admission accepted it: the whole output its report gave, never rewritten, with a hash over it;
 * the output field that held the workflow; and the workflow that field defines, which a `from` step runs.
 */
export interface AdmittedWorkflow {
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- the output as the producer's report held it, kept and hashed as is; admission parses only the field it reads
  output: Record<string, unknown>;
  hash: string;
  field: string;
  definition: WorkflowDefinition;
}

/**
 * The flags `workflow start --driver local` or `workflow resume` drove a run with on this install: `--tools`, by name,
 * `--auto-approve` and `--sandbox`. They describe this install, so a claim on another machine starts without them.
 */
export interface DriveOptions {
  tools?: Record<string, string>;
  /** `false` after `resume --no-auto-approve`, which overrides `workflows.auto_approve` as the flag does. */
  autoApprove?: boolean;
  sandbox?: true;
}

/**
 * Why a branch of a settled run stays: a pull request uses it, it holds the run's final copy, no branch that stays holds
 * its tip, or the host has it checked out in the checkout, which keeps it there though origin deleted it.
 */
export type KeptBranchReason = 'pr' | 'final' | 'unmerged' | 'host';

/**
 * What teamai did with the `teamai/<run>/…` branches of a settled run, at run revision `revision`. `success`: the run
 * succeeded and the branches a kept branch holds went. `retention`: `teamai doctor --fix` removed what the run left past
 * `workflows.retention`. `failed` lists the deletions that did not go through, which `doctor --fix` tries again.
 */
export interface RunLeftovers {
  by: 'success' | 'retention';
  at: string;
  revision: number;
  kept: Array<{ branch: string; why: KeptBranchReason }>;
  deleted: string[];
  failed: Array<{ branch: string; reason: string }>;
}

/** What this machine knows of the run's snapshot on `teamai-reports`. */
export interface RunPublication {
  /** The snapshot's state revision when this machine last wrote it or took the run, as origin confirmed it. */
  stateRevision: number;
  /** The `write` of a snapshot this machine committed whose delivery it has not seen. Another reports write may push it later. */
  pending?: string;
  /** Set when this machine takes the run over: the local driver brings its copies' local branches to the recorded commits once. */
  reconcileCopies?: true;
}

export interface CachedWorkflow {
  relativePath: string;
  sourceHash: string;
  /** Remote-reachable team commit that stores the workflow and prompt bytes exactly. */
  teamRevision?: string;
  /**
   * The YAML the definition was parsed from, so a kept copy can be checked again against the workflows it runs.
   * Absent in a cache written before a workflow could run another file.
   */
  content?: string;
  definition: WorkflowDefinition;
  validatedAt: string;
}

/** Where a workflow `start` runs comes from: a team file `teamai pull` validated, or a default this teamai ships. */
export type WorkflowSource = 'team' | 'default';

/** A workflow as the cache resolves a name: a team version first, else teamai's default. */
export type ResolvedWorkflow = CachedWorkflow & { source: WorkflowSource };

export type WorkflowEnvelope =
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- engine.ts ok() and the session-flow commands put typed records here, which are not JsonValue
  | { data: Record<string, unknown> }
  // oxlint-disable-next-line teamai/no-unsafe-dictionary-type -- scoring and engine label records carry typed fields the error renders as JSON
  | { error: { code: string; message: string; labels?: Array<Record<string, unknown>> } };

export function isWorkflowError(
  envelope: WorkflowEnvelope,
): envelope is Extract<WorkflowEnvelope, { error: unknown }> {
  return 'error' in envelope;
}
