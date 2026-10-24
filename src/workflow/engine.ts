import { randomBytes } from 'node:crypto';
import { parseReportedAgent, parseReportedUsed, settleObservation, type ReportedAgent, type Used } from '../agent-observation.js';
import { DriverSchema } from '../driver-identity.js';
import { log } from '../utils/logger.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, loadWorkflowTree } from './cache.js';
import { claimRun, publishRunEnd } from './handoff.js';
import {
  evaluateExpression, expressionPaths, isRecord, isTruthy, parseExpression, resolvePath,
  type Expression, type ExpressionPath,
} from './expression.js';
import { outputMismatch } from './output.js';
import type { ResponseInput } from './run-controls.js';
import { publishRunRecords, queueRunRecord, runRecordState } from './records.js';
import {
  parseTemplate, renderStrings, renderText, stepExpressions, templatedTexts, templatePaths,
  type StepExpression, type TemplateError,
} from './template.js';
import { parseStepPath } from './step-path.js';
import {
  ReadSchema, answerHitl, fail, inProgress, lease, release, settled, skip, start, startDelivery, stopAttempt, stopWhere, stopped,
  succeed, waitForAnswer, type ItemResult, type LeasedStep, type StepRead, type StepState,
} from './step-state.js';
import { budgetSpent, countLateTokens, expire, itemsSpent, leaseDeadline, ownDeadline, startLimits } from './limits.js';
import { addItems, afterStanding, expandItems, isItem, itemsAfter, itemsOf, itemsSettled, startedItems } from './fan-out.js';
import { decideRound, decideStepLoop, exhaustedAtStart, firstPass, isUnder, loopSettled } from './loop.js';
import { childScope, contextOf, insertChildren, localId, statesIn, stepDefinitions, topScope, type Scope } from './scope.js';
import { deliverableOf, deliveryProblem, deliveryTarget, planWorkspace, plannedBranch, sessionOf, workLeftUndelivered, type LeaseSession, type SessionRef, type WorkspaceContract, type WorkspacePlan } from './workspace.js';
import {
  deliverPr, deliveryFailure, findDelivered, reportedPrMismatch, type DeliveryJob,
} from './pr-delivery.js';
import { sanitizePrUrl, type PrUrl } from './pr-url.js';
import { completeDelivery, deliveringStep, nextDelivery, resolveCreate, sameCreate, unresolvedCreate } from './delivery-ledger.js';
import type { DeliveryKey, UnresolvedCreate } from './delivery-schema.js';
import {
  CAN_KEYS, CanSchema, ReportedUnenforcedSchema, heldFor, mergeRequirements, negotiate, reportedUnenforced, requiredEnvKeys, unionUnenforced,
  type Allow, type DriverCan, type EnvFacts, type Held, type Negotiation, type ReportedUnenforced, type Terms,
} from './requirements.js';
import { knownSecrets, resolveWorkflowEnv, secretKey, type WorkflowEnv } from '../env-resolution.js';
import { redactJson } from '../utils/redact.js';
import { deliveryLockPath, generateRunId, installOwner, isRunId, readRun, updateRun } from './store.js';
import { withFileLock } from '../update.js';
import { pinScorers } from '../scorers/cache.js';
import { isLeaseRef } from '../scorers/entry.js';
import type {
  DriverIdentity,
  OutputSchema,
  RunState,
  RunStatus,
  StepLease,
  StepOutcome,
  WorkflowEnvelope,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';
import { hasAction } from './types.js';
import type { TokenUsage } from '../tool-launch/stdout.js';

/**
 * Recent settled attempt ids kept for `repeated_report`.
 * Older ids are no longer listed; revision and the active lease still reject them.
 */
export const SETTLED_ATTEMPTS_LIMIT = 32;

export interface ReportInput {
  attempt: string;
  revision: number;
  outcome: StepOutcome;
  driver: DriverIdentity;
  outputs?: unknown;
  exitCode?: number;
  message?: string;
  tool?: string;
  model?: string;
  session?: string;
  /** The lease's `session`, echoed when the attempt continued it, by that id or in a copy, rather than starting a new one. */
  resumed?: SessionRef;
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
  /** The branch this attempt committed, when it ran in a workspace. */
  changes?: { branch: string; base: string; from: string; to: string; commits: string[] };
  /** `changes.pr_url` as the driver sent it: a pull request it opened itself, kept only once it is sanitized. */
  prUrl?: unknown;
  /** The branch and commit this attempt read, when it ran read-only in a workspace. */
  read?: StepRead;
  agent?: ReportedAgent;
  /** The team skills the attempt loaded, by name. */
  used?: Used;
  /** What the attempt's driver learned, once it ran the step, that it did not enforce. */
  unenforced?: ReportedUnenforced;
}

/** A protocol rejection that retains its actionable code and message. */
export function error(code: string, message: string): Extract<WorkflowEnvelope, { error: unknown }> {
  return { error: { code, message } };
}

/** A successful workflow operation envelope. */
export function ok(value: Record<string, unknown>): WorkflowEnvelope {
  return { data: value };
}

/**
 * Attaches the payload fields the CLI did not read to a success envelope. Left out when the list
 * is empty, so the envelope of today's drivers does not change (#1164).
 */
export function withIgnored(envelope: WorkflowEnvelope, ignored: string[]): WorkflowEnvelope {
  if (ignored.length === 0 || 'error' in envelope) return envelope;
  return { data: { ...envelope.data, ignored } };
}

function sameDriver(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

/**
 * Applies one operation under the run lock and saves only when requested. `secrets`, what the run file and records
 * mask, are the ones the operation resolved before the lock, since resolving them can read the team env.
 */
export async function withRun<T extends WorkflowEnvelope>(
  config: LocalConfig,
  runId: string,
  secrets: Record<string, string>,
  mutate: (run: RunState, now: string) => Promise<{ envelope: T; save: boolean }>,
): Promise<T> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 or 16 hex digits') as T;
  const updated = await updateRun(config, runId, secrets, async (loaded) => {
    if (loaded === 'missing') return { value: error('run_not_found', `Run ${runId} was not found`) as T };
    // One timestamp per operation, so a settled run's end record and its run file agree.
    const now = new Date().toISOString();
    const result = await mutate(loaded, now);
    if (!result.save) return { value: result.envelope };
    loaded.updatedAt = now;
    return { value: result.envelope, write: loaded };
  });
  switch (updated.status) {
    case 'done':
      return updated.value;
    case 'busy':
      return error('busy', `Run ${runId} is locked by another process`) as T;
    case 'corrupt':
      return error('run_unreadable', `Run ${runId} could not be read`) as T;
    default: {
      const unhandled: never = updated;
      return unhandled;
    }
  }
}

interface RenderedLease {
  prompt?: string;
  env?: Record<string, string>;
  /** The `defaults.model` in effect for a prompt step, as written. */
  defaultModel?: string;
}

/** The workflow or inline step name used in engine and control diagnostics. */
export function workflowLabel(scope: Scope): string {
  return 'name' in scope.definition ? `workflow "${scope.definition.name}"` : `step "${scope.prefix.slice(0, -1)}" inline workflow`;
}

/** The scope and definition of the step instance at `path`, or undefined when the run file does not describe it. */
export function locateStep(run: RunState, path: string): { scope: Scope; step: WorkflowStep } | undefined {
  let scope = topScope(run);
  const segments = parseStepPath(path);
  for (const [index, segment] of segments.entries()) {
    const step = scope.definition.steps.find((item) => item.id === segment.id);
    if (!step) return undefined;
    if (index === segments.length - 1) return { scope, step };
    const instance = `${scope.prefix}${segment.id}${segment.index === undefined ? '' : `[${segment.index}]`}`;
    const state = run.steps.find((item) => item.id === instance);
    const child = state && childScope(run, scope, statesIn(run, scope), state, step);
    if (!child) return undefined;
    scope = child;
  }
  return undefined;
}

/** A step's `with` holds a template that does not parse. Pull rejects one, so the run file was changed. */
function withTemplateFailure(state: StepState, error: TemplateError): WorkflowFailure {
  return { code: 'invalid_template', message: `step "${state.id}" with template ${error.source}: ${error.message}` };
}

/**
 * Renders a step's prompt and env from its workflow's inputs and settled steps only,
 * so a repeated `next` for the same attempt renders the same text.
 * Pull rejects a template that does not parse, so a failure here means the run file was changed.
 */
function renderLease(scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep): RenderedLease | WorkflowFailure {
  const context = contextOf(scope, states, state);
  // A prompt step's `with` renders first, by the same rules as a workflow step's; its prompt reads it as `with.<name>`.
  if (definition.with !== undefined) {
    const values = renderStrings(definition.with, context);
    if (!values.ok) return withTemplateFailure(state, values.error);
    context.with = values.value;
  }
  const rendered = new Map<string, string>();
  for (const { what, text } of templatedTexts(definition)) {
    if (what.startsWith('with.')) continue;
    const parsed = parseTemplate(text, Object.hasOwn(context, 'item'));
    if (!parsed.ok) {
      const [problem] = parsed.errors;
      return { code: 'invalid_template', message: `step "${state.id}" ${what} template ${problem?.source}: ${problem?.message}` };
    }
    rendered.set(what, renderText(parsed.template, context));
  }
  const env = Object.keys(definition.env ?? {}).map((name) => [name, rendered.get(`env.${name}`) ?? ''] as const);
  return {
    ...(rendered.has('prompt') ? { prompt: rendered.get('prompt') } : {}),
    ...(definition.env ? { env: Object.fromEntries(env) } : {}),
    ...(definition.prompt !== undefined && scope.defaultModel !== undefined ? { defaultModel: scope.defaultModel } : {}),
  };
}

function hitlMessage(scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep): string | WorkflowFailure {
  const context = contextOf(scope, states, state);
  if (definition.with !== undefined) {
    const values = renderStrings(definition.with, context);
    if (!values.ok) return withTemplateFailure(state, values.error);
    context.with = values.value;
  }
  const parsed = parseTemplate(definition.hitl!.message, Object.hasOwn(context, 'item'));
  if (!parsed.ok) return { code: 'invalid_template', message: `Step "${state.id}" ${definition.hitl!.kind}.message template ${parsed.errors[0]?.source}: ${parsed.errors[0]?.message}` };
  return renderText(parsed.template, context);
}

function waitingHitl(run: RunState): Record<string, unknown> | undefined {
  const state = run.steps.find((step) => step.status === 'waiting');
  const located = state && locateStep(run, state.id);
  if (!state || !located?.step.hitl) return undefined;
  const stepArgument = /^[A-Za-z0-9_.-]+$/.test(state.id) ? state.id : `'${state.id}'`;
  return { run: run.id, step: state.id, pass: state.pass ?? 1, ...located.step.hitl,
    respond: `teamai workflow respond ${run.id} ${stepArgument} <option> --pass ${state.pass ?? 1}`,
    message: hitlMessage(located.scope, statesIn(run, located.scope), state, located.step) };
}

function answerWithoutHitl(config: LocalConfig, run: RunState, now: string, autoApprove?: boolean): boolean {
  let changed = false;
  const definitionOf = stepDefinitions(run);
  for (const state of run.steps) {
    if (state.status !== 'waiting') continue;
    const hitl = definitionOf(state.id)?.hitl;
    if (!hitl) continue;
    const auto = autoApprove ?? config.workflows?.auto_approve === true;
    if (hitl.required || (hitl.kind === 'choose' && (!auto || hitl.default === undefined))) {
      const failure = { code: 'hitl_required', message: `Step "${state.id}" needs a person's answer, and the driver declares no HITL (driver.can.hitl). Retry it from a terminal: teamai workflow retry ${run.id} ${state.id}; then teamai workflow resume ${run.id}` };
      log.warn(failure.message);
      failStep(state, failure, run.revision);
    } else {
      if (hitl.kind === 'approve') {
        log.warn(auto ? `Step "${state.id}" was approved by auto_approve.`
          : `Step "${state.id}" was skipped: its approve HITL request needs a person, and the driver declares no HITL (driver.can.hitl). Set workflows.auto_approve, pass --auto-approve, or run the workflow from a terminal.`);
      } else log.warn(`Step "${state.id}" chose "${hitl.default}" by auto_approve.`);
      answerHitl(state, { choice: hitl.kind === 'approve' ? auto ? 'yes' : 'no' : hitl.default!, at: now,
        channel: auto ? 'auto_approve' : 'no_hitl', agent: false });
    }
    changed = true;
  }
  return changed;
}

function leaseData(
  run: RunState, state: LeasedStep, definition: WorkflowStep, rendered: RenderedLease,
  { requires, envScope, maxTurns, setup }: Omit<Terms, 'unenforced'>, plan?: WorkspacePlan,
): Record<string, unknown> {
  const expiresAt = leaseDeadline(run, state);
  return { lease: {
    run: run.id,
    step: state.id,
    attempt: state.lease.attempt,
    revision: state.lease.revision,
    pass: state.pass ?? 1,
    ...(definition.command !== undefined ? { command: definition.command } : {}),
    ...(rendered.env ? { env: rendered.env } : {}),
    ...(rendered.prompt !== undefined ? { prompt: rendered.prompt } : {}),
    ...(definition.agent !== undefined ? { agent: definition.agent } : {}),
    ...(definition.model !== undefined ? { model: definition.model } : {}),
    ...(rendered.defaultModel !== undefined ? { defaultModel: rendered.defaultModel } : {}),
    ...(definition.output ? { output: definition.output } : {}),
    ...(plan?.contract ? { workspace: plan.contract } : {}),
    ...(plan?.session ? { session: plan.session } : {}),
    ...(definition.interactive ? { interactive: true } : {}),
    ...(definition.workspace === 'read-only' ? { readOnly: true } : {}),
    ...(Object.keys(requires).length > 0 ? { requires } : {}),
    ...(envScope ? { envScope } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(setup ? { setup } : {}),
    ...(state.lease.unenforced ? { unenforced: state.lease.unenforced } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  } };
}

/**
 * Records who opened a workspace the first time a driver takes its branch, or who first leases a copy a claim brought in,
 * and, before the copy has a commit, the branch it starts from.
 */
function rememberCopy(run: RunState, plan: WorkspacePlan, driver: DriverIdentity): void {
  const branch = plan.contract?.branch;
  if (!branch) return;
  const from = plan.contract?.start.branch ?? plan.contract?.merge[0]?.branch;
  const copy = (run.copies ??= {})[branch];
  if (copy) {
    copy.owner ??= driver;
    if (!copy.from && !copy.commit && from && from !== branch) copy.from = from;
  }
  else run.copies[branch] = { owner: driver, ...(from && from !== branch ? { from } : {}) };
}

/** Whether a step holds a lease in copy `branch`. */
function leasedIn(run: RunState, branch: string): boolean {
  return run.steps.some((item) => {
    if (item.status !== 'leased') return false;
    const located = locateStep(run, item.id);
    return located !== undefined && plannedBranch(run, located.scope, item, located.step) === branch;
  });
}

/**
 * Fails a step the engine cannot hand out, so the rest of the graph keeps settling. Like a skip, it does not bump
 * `revision`. `settledAt` is the revision the failure is stamped with: the run's current one, or that of an open lease.
 */
function failStep(step: StepState, failure: WorkflowFailure, settledAt: number): void {
  fail(step, { settledAt, message: failure.message, failure });
}

/** The status of a run, or of a workflow inside it, once it has settled. */
type FinalRunStatus = Exclude<RunStatus, 'running'>;

/**
 * How a workflow of the run settled: its outcome, the end it reached, and the outputs it returns. `settledAt` is
 * the run's current revision.
 */
export interface WorkflowResult {
  outcome: FinalRunStatus;
  end?: string;
  outputs?: Record<string, unknown>;
  settledAt: number;
  /** Why a workflow that reached no failed end failed, such as `loop_exhausted`. */
  failure?: WorkflowFailure;
  /** For the items of a `for_each` step, which settle like a workflow: how each one settled. */
  results?: ItemResult[];
}

/** The revision a step settled at; 0 before it settles, or in a run file from an older teamai. */
function settledAtOf(step: StepState | undefined): number {
  return step && 'settledAt' in step ? step.settledAt : 0;
}

/** Ends the run. Every path that settles a run goes through here, so anything that reacts to a settled run hooks in here. */
function settleRun(run: RunState, now: string, { outcome, end, failure }: WorkflowResult): void {
  run.status = outcome;
  if (end !== undefined) run.end = end;
  if (failure) run.failure = failure;
  run.updatedAt = now;
}

/** Settles a run and queues its end record in the same locked operation. */
export async function finishRun(
  config: LocalConfig,
  run: RunState,
  now: string,
  result: WorkflowResult,
  secrets: Record<string, string>,
  driver?: DriverIdentity,
): Promise<boolean> {
  settleRun(run, now, result);
  const queued = await queueRunRecord(config, run, driver, 'end', secrets);
  run.endRecordQueued = queued;
  return queued;
}

/** The run summary returned by manual control operations. */
export function runData(run: RunState): Record<string, unknown> {
  return { id: run.id, status: run.status, revision: run.revision, ...(run.end !== undefined ? { end: run.end } : {}), ...(run.failure ? { failure: run.failure } : {}) };
}

function doneData(run: RunState): Record<string, unknown> {
  return { done: { run: run.id, outcome: run.status, ...(run.end !== undefined ? { end: run.end } : {}), ...(run.failure ? { failure: run.failure } : {}) } };
}

/** The step ids these paths read. */
function stepsRead(paths: ExpressionPath[]): Set<string> {
  return new Set(paths.flatMap((path) => (path.root === 'steps' ? [path.step] : [])));
}

/**
 * The step ids a step reads in its expressions and templates, and, when it runs an inline workflow, the ids that
 * workflow's steps read outside it, at any depth. A `loop.while` or `break` that reads its own step reads it after it
 * ran, so the step is left out. An expression or template that does not parse reads nothing here; settling its own
 * workflow reports it. `item` is whether the step's workflow runs per item, as pull decided which templates read it.
 */
function readsOf(step: WorkflowStep, item: boolean): Set<string> {
  const bindsItem = item || step.forEach !== undefined;
  const paths = [
    ...stepExpressions(step).flatMap(({ source }) => {
      const parsed = parseExpression(source);
      return parsed.ok ? expressionPaths(parsed.expression) : [];
    }),
    ...templatedTexts(step).flatMap(({ text }) => {
      const template = parseTemplate(text, bindsItem);
      return template.ok ? templatePaths(template.template) : [];
    }),
  ];
  const ids = stepsRead(paths);
  if (typeof step.workflow === 'object') {
    const own = new Set(step.workflow.steps.map((item) => item.id));
    for (const inner of step.workflow.steps) for (const id of readsOf(inner, bindsItem)) if (!own.has(id)) ids.add(id);
  }
  ids.delete(step.id);
  return ids;
}

/** Parsed reads and conditions shared by reconciliation and the retry dependency walk. */
export interface RunReads {
  /** Each step's parsed `if`. */
  conditions: Map<string, Expression>;
  /** Each loop owner's parsed `loop.while`. */
  whiles: Map<string, Expression>;
  /** Each step's parsed `break`. */
  breaks: Map<string, Expression>;
  /** Each `for_each` step's parsed list of items. */
  items: Map<string, Expression>;
  /** The step ids each step's `if` and templates read. */
  reads: Map<string, Set<string>>;
  /** The loop owners each step waits for besides what it needs and reads. */
  waits: Map<string, string[]>;
  /** The path each declared output reads. */
  outputs: Map<string, ExpressionPath>;
  /** The workflow's own parsed `loop.while`. */
  loopWhile?: Expression;
}

/** Parses every `if` and template in a workflow of the run. A run file whose `if` does not parse cannot settle; the message names the step. */
export function parseReads(run: RunState, scope: Scope): RunReads | string {
  const conditions = new Map<string, Expression>();
  const whiles = new Map<string, Expression>();
  const breaks = new Map<string, Expression>();
  const items = new Map<string, Expression>();
  const reads = new Map<string, Set<string>>();
  const waits = new Map<string, string[]>();
  const parsedInto: Record<StepExpression['what'], Map<string, Expression>> = { if: conditions, 'loop.while': whiles, break: breaks, for_each: items };
  const own = new Set(scope.definition.steps.map((step) => step.id));
  for (const step of scope.definition.steps) {
    for (const { what, source } of stepExpressions(step)) {
      const parsed = parseExpression(source);
      if (!parsed.ok) return `Run ${run.id} step "${scope.prefix}${step.id}" has ${what === 'if' ? 'an' : 'a'} ${what} that does not parse: ${parsed.message}`;
      parsedInto[what].set(step.id, parsed.expression);
    }
    // A template that does not parse reads nothing; the step fails when it would be leased.
    // An inline workflow's reads of enclosing steps settled before it started, so only its own steps are waited for.
    // A read of a step's previous pass never waits.
    const previous = scope.loops.previous(step.id);
    const read = new Set([...readsOf(step, Object.hasOwn(scope, 'item'))].filter((id) => (!scope.outer || own.has(id)) && !previous.has(id)));
    reads.set(step.id, read);
    waits.set(step.id, scope.loops.waitsFor(step.id, read));
  }
  let loopWhile: Expression | undefined;
  if (scope.definition.loop?.while !== undefined) {
    const parsed = parseExpression(scope.definition.loop.while);
    if (!parsed.ok) return `Run ${run.id} ${workflowLabel(scope)} has a loop.while that does not parse: ${parsed.message}`;
    loopWhile = parsed.expression;
  }
  const outputs = new Map<string, ExpressionPath>();
  for (const [name, source] of Object.entries(scope.definition.outputs ?? {})) {
    const parsed = parseExpression(source);
    if (!parsed.ok || parsed.expression.kind !== 'path') return `Run ${run.id} ${workflowLabel(scope)} output "${name}" is not a path`;
    outputs.set(name, parsed.expression.path);
  }
  return { conditions, whiles, breaks, items, reads, waits, outputs, ...(loopWhile ? { loopWhile } : {}) };
}

/**
 * Marks every pending step of a workflow that can no longer run as `skipped`, until nothing changes:
 * a stopped need its `if` does not read, all needs skipped, or a ready step whose `if` is false. A step that waits for a loop is neither skipped
 * nor ready until that loop is settled.
 * Returns whether a step is ready: everything it needs and everything its `if` and templates read has settled.
 */
function skipUnreachable(run: RunState, scope: Scope, states: StepState[], { conditions, reads, waits }: RunReads): (step: StepState) => boolean {
  const byId = new Map(states.map((step) => [localId(scope, step), step]));
  const declared = new Map(scope.definition.steps.map((step) => [step.id, step.needs ?? []]));
  const needs = (step: StepState): Array<StepState | undefined> => (declared.get(localId(scope, step)) ?? []).map((id) => byId.get(id));
  const waiting = (step: StepState): boolean => (waits.get(localId(scope, step)) ?? []).some((owner) => !loopSettled(byId.get(owner)));
  const ready = (step: StepState): boolean => !waiting(step) && needs(step).every(settled)
    && [...reads.get(localId(scope, step)) ?? []].every((id) => settled(byId.get(id)));
  const conditionHolds = (step: StepState): boolean => {
    const condition = conditions.get(localId(scope, step));
    return !condition || isTruthy(evaluateExpression(condition, contextOf(scope, states, step)));
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const step of states) {
      if (step.status !== 'pending' || waiting(step)) continue;
      const condition = conditions.get(localId(scope, step));
      const read = stepsRead(condition ? expressionPaths(condition) : []);
      const stoppedNeed = needs(step).some((need) => need && stopped(need) && !read.has(localId(scope, need)));
      const allSkipped = needs(step).length > 0 && needs(step).every((need) => need?.status === 'skipped');
      const conditionFalse = ready(step) && !conditionHolds(step);
      if (!stoppedNeed && !allSkipped && !conditionFalse) continue;
      skip(step, run.revision);
      changed = true;
    }
  }
  return ready;
}

/** A leaf step that can be leased, with what its lease renders to. */
interface Ready {
  lease: StepState;
  definition: WorkflowStep;
  rendered: RenderedLease;
}

/**
 * How settling a workflow of the run ended: the steps to lease, in the order they were found, the workflow's outcome,
 * nothing to do until an open lease is reported, or a run file that cannot settle.
 */
type Settled =
  | { ready: Ready[] }
  | WorkflowResult
  | { inProgress: true }
  | { unreadable: string };

/**
 * Starts the workflow a step runs with the values its `with` renders to in the step's own workflow.
 * Its steps join the run right after the step, which is `running` until they settle.
 */
function startWorkflowStep(
  run: RunState, scope: Scope, states: StepState[], state: StepState, step: WorkflowStep, child: Scope, now: string,
): WorkflowFailure | undefined {
  // An inline workflow takes no `with`: it already reads the enclosing inputs.
  let inputs: Record<string, unknown> | undefined;
  if ('name' in child.definition) {
    const rendered = renderStrings(step.with ?? {}, contextOf(scope, states, state));
    if (!rendered.ok) return withTemplateFailure(state, rendered.error);
    const mismatch = inputsMismatch(child.definition.name, child.definition.inputs, rendered.value);
    if (mismatch) return { code: 'invalid_inputs', message: `step "${state.id}" with does not fit workflow "${child.definition.name}": ${mismatch}` };
    if (child.definition.inputs) {
      inputs = rendered.value as Record<string, unknown>;
      child.inputs = inputs;
    }
  }
  start(state, inputs, startLimits(run, state, step, now));
  const steps = child.definition.steps.map((step): StepState => {
    const id = `${child.prefix}${step.id}`;
    const pass = firstPass(run, id);
    return { id, status: 'pending', ...(pass > 1 ? { pass } : {}) };
  });
  insertChildren(run, state, steps);
  return undefined;
}

/**
 * A step takes how what it ran settled: a workflow step, the outcome, the end, and the outputs of its workflow; a
 * `for_each` step, the outcome and the results of its items. A workflow step or `for_each` item that delivers goes on
 * to deliver what it wrote; a `for_each` step delivers nothing of its own, its items do.
 */
function finishStep(run: RunState, state: StepState, definition: WorkflowStep, result: WorkflowResult): void {
  const settlement = {
    settledAt: result.settledAt,
    ...(result.end !== undefined ? { end: result.end } : {}),
    ...(result.outputs !== undefined ? { outputs: result.outputs } : {}),
    ...(result.results ? { results: result.results } : {}),
  };
  if (result.outcome !== 'succeeded') {
    fail(state, { ...settlement, ...(result.failure ? { message: result.failure.message, failure: result.failure } : {}) });
    return;
  }
  const delivers = definition.deliver === 'pr' && (!definition.forEach || isItem(state));
  const delivery = delivers ? deliverableOf(run, state, definition) : undefined;
  // A branch that holds nothing beyond the run base opens no pull request, so work a step inside wrote elsewhere would be lost.
  const left = delivers && !delivery && definition.workflow !== undefined ? workLeftUndelivered(run, state) : undefined;
  if (delivery) startDelivery(state, settlement, delivery);
  else if (left) {
    const key = { step: state.id, pass: state.pass ?? 1, settledAt: result.settledAt, branch: left.branch, head: left.head };
    const failure = deliveryFailure({ runId: run.id, key }, { kind: 'child_work_left_out', step: left.child.step, branch: left.child.branch });
    fail(state, { ...settlement, message: failure.message, failure });
  } else succeed(state, settlement);
}

function childOrUnreadable(run: RunState, scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep): Scope | { unreadable: string } {
  return childScope(run, scope, states, state, definition)
    ?? { unreadable: `Run ${run.id} step "${state.id}" runs workflow "${definition.workflow}", which the run did not keep` };
}

function settleRunning(run: RunState, scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep, now: string): Settled {
  if (definition.forEach && !isItem(state)) return settleItems(run, scope, states, state, definition, now);
  const child = childOrUnreadable(run, scope, states, state, definition);
  return 'unreadable' in child ? child : settleScope(run, child, now);
}

/**
 * Advances one ready instance. A running one settles what it runs. A pending leaf is returned to lease, a pending
 * workflow step starts its workflow, and a pending `for_each` step adds an instance per item of `items`. What the
 * engine cannot hand out or start fails at the current revision. Returns undefined when it changed the run.
 */
function advanceInstance(
  run: RunState, scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep, now: string, items?: Expression,
): Settled | undefined {
  if (state.status === 'running') {
    const result = settleRunning(run, scope, states, state, definition, now);
    if (!('outcome' in result)) return result;
    finishStep(run, state, definition, result);
    return undefined;
  }
  if (definition.forEach && !isItem(state)) {
    const values = expandItems(state.id, items && evaluateExpression(items, contextOf(scope, states, state)));
    if (!Array.isArray(values)) {
      failStep(state, values, run.revision);
      return undefined;
    }
    start(state, undefined, startLimits(run, state, definition, now));
    addItems(run, state, values);
    return undefined;
  }
  if (definition.workflow === undefined) {
    const rendered = renderLease(scope, states, state, definition);
    if (!('code' in rendered)) return { ready: [{ lease: state, definition, rendered }] };
    failStep(state, rendered, run.revision);
    return undefined;
  }
  const child = childOrUnreadable(run, scope, states, state, definition);
  if ('unreadable' in child) return child;
  const failure = startWorkflowStep(run, scope, states, state, definition, child, now);
  if (failure) failStep(state, failure, run.revision);
  return undefined;
}

/**
 * Settles items at the current revision and returns the leaves available to lease. An item waits for its
 * `after` dependencies and for room under `max_parallel`. A ready leaf does not take room until it is leased, and
 * `next` leases one step per call, so a held-back item leaves its room to the next one.
 */
function settleItems(
  run: RunState, scope: Scope, states: StepState[], state: StepState, definition: WorkflowStep, now: string,
): Settled {
  // The step's budget covers all its items: once they spend more together, it stops them and fails.
  const spent = definition.budget === undefined ? 0 : itemsSpent(run, state);
  if (definition.budget !== undefined && spent > definition.budget.tokens) {
    const failure = { code: 'budget_exceeded', message: `step "${state.id}" spent ${spent} of its ${definition.budget.tokens}-token budget` };
    stopWhere(run, isUnder(state.id), failure, run.revision, now);
    return { outcome: 'failed', failure, settledAt: run.revision };
  }
  for (;;) {
    const items = itemsOf(run, state);
    const after = itemsAfter(state.id, items.map((item) => item.item));
    if (!Array.isArray(after)) return { unreadable: `Run ${run.id} ${after.message}` };
    const dependencies = (index: number): StepState[] => after[index]?.map((other) => items[other]!) ?? [];
    const standing = (index: number): ReturnType<typeof afterStanding> => afterStanding(dependencies(index));
    const dependents: number[][] = items.map(() => []);
    after.forEach((others, index) => others.forEach((other) => dependents[other]!.push(index)));
    const maxParallel = definition.forEach?.maxParallel;
    let started = startedItems(items);
    let changed = false;
    const ready: Ready[] = [];
    for (const [index, item] of items.entries()) {
      if (item.status === 'pending' && standing(index) === 'skip') {
        // A skip makes the items after it skippable wherever they are in item order, so it reaches them all now.
        const skippable = [index];
        for (const next of skippable) {
          if (items[next]!.status !== 'pending' || standing(next) !== 'skip') continue;
          skip(items[next]!, run.revision);
          skippable.push(...dependents[next]!);
        }
        changed = true;
        continue;
      }
      if (item.status !== 'running' && (item.status !== 'pending' || standing(index) !== 'ready' || (maxParallel !== undefined && started >= maxParallel))) continue;
      const advanced = advanceInstance(run, scope, states, item, definition, now);
      if (advanced && 'unreadable' in advanced) return advanced;
      if (advanced && 'ready' in advanced) ready.push(...advanced.ready);
      if (advanced) continue;
      changed = true;
      // Starting an item changes no other item's standing, so the scan goes on. Settling one can make an earlier item
      // ready, so the scan starts over.
      if (item.status !== 'running') break;
      started += 1;
    }
    if (changed) continue;
    if (items.every(settled)) return itemsSettled(items, run.revision, run);
    return ready.length > 0 ? { ready } : { inProgress: true };
  }
}

/** The values a workflow returns, read from its own steps; a skipped step reads null. */
function workflowOutputs(scope: Scope, states: StepState[], paths: Map<string, ExpressionPath>): Record<string, unknown> | undefined {
  if (!scope.definition.outputs) return undefined;
  const context = contextOf(scope, states);
  return Object.fromEntries([...paths].map(([name, path]) => [name, resolvePath(path, context)]));
}

/**
 * Settles driverless transitions before applying an end or deciding a loop. The steps ready to lease are returned
 * only after this fixpoint, before another report can advance the revision.
 */
function settleScope(run: RunState, scope: Scope, now: string): Settled {
  const reads = parseReads(run, scope);
  if (typeof reads === 'string') return { unreadable: reads };
  // A workflow that spent more than its budget stops what it still runs and fails: the run, or the step that runs it, so a step
  // around it that reads its outcome can recover.
  const spent = scope.budget === undefined ? 0 : budgetSpent(run, scope);
  if (scope.budget !== undefined && spent > scope.budget) {
    const failure = { code: 'budget_exceeded', message: `${workflowLabel(scope)} spent ${spent} of its ${scope.budget}-token budget` };
    stopWhere(run, (id) => id.startsWith(scope.prefix), failure, run.revision, now);
    return { outcome: 'failed', failure, settledAt: run.revision };
  }
  const states = statesIn(run, scope);
  const defined = new Map(scope.definition.steps.map((item) => [item.id, item]));
  const definitionOf = (state: StepState): WorkflowStep | undefined => defined.get(localId(scope, state));
  for (;;) {
    let changed = false;
    const ready: Ready[] = [];
    const canRun = skipUnreachable(run, scope, states, reads);
    for (const state of states) {
      if (state.status !== 'running' && (state.status !== 'pending' || !canRun(state))) continue;
      const definition = definitionOf(state);
      if (!definition) return { unreadable: `Run ${run.id} has no definition for step "${state.id}"` };
      if (state.status === 'pending' && definition.loop && exhaustedAtStart(state, definition.loop, run.revision)) {
        changed = true;
        break;
      }
      if (state.status === 'pending' && definition.hitl) {
        if (!state.answer) {
          const message = hitlMessage(scope, states, state, definition);
          if (typeof message !== 'string') failStep(state, message, run.revision);
          else waitForAnswer(state);
          changed = true;
          break;
        }
        if (definition.hitl.kind === 'approve' && state.answer.choice === 'no') {
          skip(state, run.revision);
          changed = true;
          break;
        }
        if (definition.hitl.kind === 'choose') {
          succeed(state, { settledAt: run.revision });
          changed = true;
          break;
        }
      }
      if (state.status === 'pending' && !hasAction(definition)) {
        succeed(state, { settledAt: run.revision });
      } else {
        const advanced = advanceInstance(run, scope, states, state, definition, now, reads.items.get(localId(scope, state)));
        if (advanced && 'unreadable' in advanced) return advanced;
        if (advanced && 'ready' in advanced) ready.push(...advanced.ready);
        if (advanced) continue;
      }
      changed = true;
      break;
    }
    if (changed) continue;
    const breaks = (state: StepState): boolean => {
      const condition = reads.breaks.get(localId(scope, state));
      return !!condition && isTruthy(evaluateExpression(condition, contextOf(scope, states, state)));
    };
    const reached = states
      .filter((item) => item.status === 'succeeded' && (definitionOf(item)?.end !== undefined || breaks(item)))
      .sort((left, right) => settledAtOf(left) - settledAtOf(right))[0];
    if (reached) {
      const end = definitionOf(reached)?.end;
      const label = end === undefined ? `the break of step "${reached.id}"` : `end "${end}"`;
      stopWhere(run, (id) => id.startsWith(scope.prefix), { code: 'end_reached', message: `Cancelled: ${workflowLabel(scope)} reached ${label}` }, settledAtOf(reached), now);
      const result = { outputs: workflowOutputs(scope, states, reads.outputs), settledAt: settledAtOf(reached) };
      return end === undefined ? { outcome: 'succeeded', ...result } : { outcome: scope.definition.ends?.[end] ?? 'failed', end, ...result };
    }
    for (const state of states) {
      const loop = definitionOf(state)?.loop;
      if (!loop || state.status !== 'succeeded' || state.loopFinal) continue;
      const condition = reads.whiles.get(localId(scope, state));
      const holds = !condition || isTruthy(evaluateExpression(condition, contextOf(scope, states, state)));
      const range = scope.loops.ranges.get(localId(scope, state)) ?? new Set();
      decideStepLoop(run, state, loop, holds, states.filter((item) => range.has(localId(scope, item))));
      changed = true;
      break;
    }
    if (changed) continue;
    if (states.every(settled)) {
      const result: WorkflowResult = {
        outcome: states.some(stopped) ? 'failed' : 'succeeded',
        outputs: workflowOutputs(scope, states, reads.outputs),
        settledAt: run.revision,
      };
      const { loop } = scope.definition;
      if (!loop) return result;
      const holds = !reads.loopWhile || isTruthy(evaluateExpression(reads.loopWhile, contextOf(scope, states)));
      const decided = decideRound(run, scope.runner, loop, holds, workflowLabel(scope), states);
      if (decided === 'again') continue;
      return decided === 'ended' ? result : { ...result, outcome: 'failed', failure: decided };
    }
    if (ready.length > 0) return { ready };
    if (states.some(inProgress)) return { inProgress: true };
    return { unreadable: `Run ${run.id} has pending steps whose needs cannot be met` };
  }
}

/**
 * Every stored report is reconciled before a later protocol operation can apply another transition. Deadlines `now`
 * has passed apply first: the engine has no clock of its own, so a timeout takes effect on the first operation after it.
 */
export function reconcileRun(run: RunState, now: string): Settled {
  return expire(run, now) ?? settleScope(run, topScope(run), now);
}

/** Why `inputs` do not fit what the workflow declares, naming the field, or null when they fit. Every declared input is required. */
function inputsMismatch(name: string, declared: Record<string, OutputSchema> | undefined, inputs: unknown): string | null {
  if (!isRecord(inputs)) return 'inputs must be a JSON object';
  const mismatch = outputMismatch({ type: 'object', fields: declared ?? {} }, inputs, 'inputs');
  if (mismatch) return mismatch;
  // The shorthand allows extra object keys, so an undeclared input is checked here.
  const extra = Object.keys(inputs).find((key) => !declared || !Object.hasOwn(declared, key));
  return extra === undefined ? null : `inputs.${extra} is not an input workflow "${name}" declares`;
}

/** The name of the first of `secrets` whose value `value` holds, as the run file would mask it. */
function heldSecret(value: unknown, secrets: Record<string, string>): string | undefined {
  const text = JSON.stringify(value);
  return Object.entries(secrets).find(([name, secret]) => JSON.stringify(redactJson(value, { [name]: secret })) !== text)?.[0];
}

/**
 * Why the run file would not keep what `start` was given: masking would change an input that holds a secret value
 * without a word, and the pinned definitions are kept as pulled, unmasked. Names the input and the secret, never the
 * value. An input may share a name with an env key; only values count.
 */
function secretMismatch(
  inputs: unknown,
  pinned: Record<string, unknown>,
  secrets: Record<string, string>,
): string | null {
  for (const [input, value] of isRecord(inputs) ? Object.entries(inputs) : []) {
    const held = heldSecret(value, secrets);
    const secret = held && secretKey(held);
    if (secret) return `inputs.${input} holds the value of ${secret}, a secret on this machine, which a run never stores. Pass the step a way to read ${secret} instead, such as requires.env: [${secret}].`;
  }
  for (const [label, pinnedValue] of Object.entries(pinned)) {
    const held = heldSecret(pinnedValue, secrets);
    const secret = held && secretKey(held);
    if (secret) return `${label} holds the value of ${secret}, a secret on this machine, which a run never stores. Replace the value with requires.env: [${secret}], then pull again.`;
  }
  return null;
}

/** Every scorer name a step of `definitions` lists, inline workflows included. */
function listedScorers(definitions: ReadonlyArray<{ steps: WorkflowStep[] }>): string[] {
  return definitions.flatMap((definition) => definition.steps.flatMap((step) => [
    ...step.scorers?.names ?? [],
    ...(typeof step.workflow === 'object' ? listedScorers([step.workflow]) : []),
  ]));
}

/**
 * Creates a run. `inputs` are checked against the declared inputs before the run file exists. `secrets` are what the
 * caller resolved for the operation.
 */
export async function startRun(
  config: LocalConfig,
  name: string,
  inputs: unknown,
  { secrets, ...options }: { secrets: Record<string, string>; driver?: DriverIdentity; base?: RunState['base']; checkout?: string },
): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) {
    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }
  const mismatch = inputsMismatch(cached.definition.name, cached.definition.inputs, inputs);
  if (mismatch) return error('invalid_inputs', mismatch);
  const tree = await loadWorkflowTree(config, cached);
  if ('failed' in tree) return error(tree.failed.code, tree.failed.message);
  const undeliverable = deliveryProblem(cached.definition, tree.workflows, options.base);
  if (undeliverable) return error(undeliverable.code, undeliverable.message);
  const scorers = await pinScorers(config, listedScorers([cached.definition, ...Object.values(tree.workflows)]));
  const pinned = Object.fromEntries([
    ...[cached.definition, ...Object.values(tree.workflows)].map((definition) => [`workflows/${definition.name}.yaml`, definition]),
    ...Object.entries(scorers).map(([name, scorer]) => [`scorer ${name}`, scorer]),
  ]);
  const holdsSecret = secretMismatch(inputs, pinned, secrets);
  if (holdsSecret) return error('invalid_inputs', holdsSecret);
  const now = new Date().toISOString();
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: generateRunId(),
    name: cached.definition.name,
    revision: 1,
    status: 'running',
    ...(cached.definition.inputs ? { inputs: inputs as Record<string, unknown> } : {}),
    sourceHash: tree.sourceHash,
    ...(tree.teamRevision ? { teamRevision: tree.teamRevision } : {}),
    definition: cached.definition,
    ...(Object.keys(tree.workflows).length > 0 ? { workflows: tree.workflows } : {}),
    ...(Object.keys(scorers).length > 0 ? { scorers } : {}),
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    ...(options.base ? { base: options.base } : {}),
    ...(options.checkout ? { checkout: options.checkout } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const written = await updateRun(config, run.id, secrets, async () => ({ value: undefined, write: run }));
  switch (written.status) {
    case 'done':
      break;
    case 'busy':
      return error('busy', `Run ${run.id} is locked by another process, so it was not started. Start it again.`);
    case 'corrupt':
      return error('run_unreadable', `An unreadable file already holds run ${run.id}, so it was not started. Start it again.`);
    default: {
      const unhandled: never = written;
      return unhandled;
    }
  }
  // #1083: publish the start record; a failed publication is queued locally
  // and retried on the next pull — it never fails the run itself.
  const record = await queueRunRecord(config, run, options.driver, 'start', secrets) ? await publishRunRecords(config) : undefined;
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision, ...(record ? { record } : {}) });
}

/** A run started before `needs` existed ran its steps in order; settling it as a graph would run every such step as a root. */
function missingNeeds(run: RunState): string | undefined {
  for (const definition of [run.definition, ...Object.values(run.workflows ?? {})]) {
    const step = definition.steps.slice(1).find((item) => item.needs === undefined);
    if (step) return `Run ${run.id} was started by an older teamai: step "${step.id}" in workflow "${definition.name}" has no needs. Start a new run.`;
  }
  return undefined;
}

/** What a `next` request offers against: the driver's capabilities, the member's policy, and this machine's env. */
interface OfferContext {
  can: DriverCan;
  allow: Allow;
  facts: EnvFacts;
}

/**
 * What the driver asking for step instance `id` is offered. Both places that hand out a lease ask here. Setup comes with
 * every lease on a copy, and the driver runs it when it creates the copy or the copy's setup never finished.
 */
function offerTerms(
  run: RunState, id: string, { scope, step }: { scope: Scope; step: WorkflowStep }, plan: WorkspacePlan | undefined, context: OfferContext,
): Negotiation {
  return negotiate({
    step: id,
    requires: mergeRequirements(scope.requires, step.requires),
    interactive: step.interactive === true,
    hasContract: plan?.contract !== undefined,
    envKeys: Object.keys(step.env ?? {}),
    runEnvKeys: requiredEnvKeys([run.definition, ...Object.values(run.workflows ?? {})]),
    budgeted: step.prompt !== undefined && scope.budgeted,
    ...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
    ...(plan?.contract && scope.setup ? { setup: scope.setup } : {}),
  }, context.can, context.allow, context.facts);
}

/** What a driver tells `next` besides who it is. */
export interface NextOptions {
  /** The attempts of its open leases the driver is still running. An open lease it does not list is handed back to it. */
  running?: string[];
  /** False to reconcile without issuing a new lease: `next` answers `done`, an unlisted lease, `hitl`, or `wait`. */
  canTakeLease?: boolean;
  /** The checkout the run's workspaces start from. It fixes the run's base only when `workflow start` recorded none. */
  base?: { ref?: string; commit: string };
  /** What the driver can do on this request. An omitted `workspace` means read-only, so a `new` or `continue` step waits. */
  can?: DriverCan;
  /** Process-only override of the member's automatic HITL approval setting. */
  autoApprove?: boolean;
  /** Take the run over from the install that published it before leasing; a run this install owns stays as it is. */
  claim?: boolean;
  /** Process-only: the team env the caller resolved for this operation, so `next` does not resolve it again. */
  env?: WorkflowEnv;
}

/**
 * The gate before a pull request is opened: with what reports and controls left pending applied, whether the step still
 * delivers `job`, the branch's recorded commit is still the one `job` checked, and no step that writes the branch is
 * leased. If so, the run lists its request in the same write, so one opened by a process that then stops is looked up,
 * whatever becomes of the step, rather than lost.
 */
async function markCreating(config: LocalConfig, runId: string, secrets: Record<string, string>, job: DeliveryJob): Promise<'open' | 'refused' | 'busy'> {
  const marked = await updateRun(config, runId, secrets, async (run): Promise<{ value: 'open' | 'refused' | 'busy'; write?: RunState }> => {
    if (run === 'missing' || run.status !== 'running') return { value: 'refused' };
    const now = new Date().toISOString();
    const settledRun = reconcileRun(run, now);
    const step = 'unreadable' in settledRun || 'outcome' in settledRun ? undefined : deliveringStep(run, job.key);
    if (!step) return { value: 'refused' };
    if (run.copies?.[job.key.branch]?.commit !== job.recordedHead || branchWriterLeased(run, job.key.branch)) return { value: 'busy' };
    const create = { ...job.key, target: job.target };
    const listed = run.creating?.find((item) => sameCreate(item, create));
    // A request listed before is asked again now, so its lookups count from this create.
    const lookups = { total: 0, none: 0, failed: 0 };
    if (listed) listed.lookups = lookups;
    else (run.creating ??= []).push({ ...create, lookups });
    return { value: 'open', write: { ...run, updatedAt: now } };
  });
  return marked.status === 'done' ? marked.value : 'busy';
}

/**
 * Delivers the run's delivering steps one at a time, before `next` answers, whichever driver called it, then looks up
 * each request in `run.creating` once, on an ended run too. The run lock is held to pick a delivery and to apply its
 * outcome, never across git or a provider. While another process of this machine delivers, it holds the delivery lock,
 * and this call leaves the work to it.
 */
async function drainDeliveries(config: LocalConfig, runId: string, secrets: Record<string, string>): Promise<void> {
  if (!isRunId(runId)) return;
  const loaded = await readRun(config, runId);
  if (typeof loaded === 'string') return;
  const delivering = loaded.status === 'running' && loaded.steps.some((step) => step.status === 'delivering');
  if (!delivering && !unresolvedCreate(loaded, [])) return;
  const drained = await withFileLock(deliveryLockPath(config, runId), { attempts: 1, delayMs: 0 }, async () => {
    let requeued = false;
    const tried: Array<Omit<UnresolvedCreate, 'lookups'>> = [];
    const waiting: DeliveryKey[] = [];
    for (;;) {
      const picked = await updateRun(config, runId, secrets, async (run) => {
        if (run === 'missing') return { value: undefined };
        const before = JSON.stringify(run);
        const now = new Date().toISOString();
        const job = nextDelivery(run, (item) => reconcileRun(item, now), branchWriterLeased, waiting);
        const value = job ? { job } : unresolvedCreate(run, tried);
        return { value, ...(JSON.stringify(run) !== before ? { write: { ...run, updatedAt: now } } : {}) };
      });
      if (picked.status !== 'done' || !picked.value) return requeued;
      let apply: (run: RunState, now: string) => { requeueEnd: boolean };
      if ('job' in picked.value) {
        const { job } = picked.value;
        tried.push({ ...job.key, target: job.target });
        const outcome = await deliverPr(job, () => markCreating(config, runId, secrets, job));
        // As when the pick is busy: the step still delivers, and a later call checks and delivers it.
        if (outcome === 'busy') return requeued;
        if (!outcome.ok && outcome.fault.kind === 'branch_ahead') waiting.push(job.key);
        apply = (run, now) => completeDelivery(run, job, outcome, (item) => reconcileRun(item, now), branchWriterLeased);
      } else {
        const { create, checkout } = picked.value;
        tried.push(create);
        const found = await findDelivered(checkout, create);
        apply = (run) => resolveCreate(run, create, found);
      }
      const applied = await updateRun(config, runId, secrets, async (run) => {
        if (run === 'missing') return { value: undefined };
        const before = JSON.stringify(run);
        const now = new Date().toISOString();
        const { requeueEnd } = apply(run, now);
        // Queued under the lock with the receipt, as finishRun queues an end; it publishes once the lock is released.
        if (requeueEnd) run.endRecordQueued = await queueRunRecord(config, run, run.driver, 'end', secrets);
        return { value: requeueEnd, ...(JSON.stringify(run) !== before ? { write: { ...run, updatedAt: now } } : {}) };
      });
      if (applied.status !== 'done' || applied.value === undefined) return requeued;
      requeued ||= applied.value;
    }
  });
  if (drained.held && drained.value) await publishRunRecords(config);
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity, options: NextOptions = {}): Promise<WorkflowEnvelope> {
  driver = { kind: driver.kind, machine: driver.machine, workspace: driver.workspace };
  if (options.claim) {
    const claimed = await claimRun(config, runId, { checkout: driver.workspace });
    if (!claimed.ok) return { error: claimed.error };
  }
  // Resolved once, so the env this `next` offers against and the secrets its writes, deliveries' included, mask agree.
  const env = options.env ?? await resolveWorkflowEnv(config);
  await drainDeliveries(config, runId, env.secrets);
  const running = new Set(options.running);
  const can = options.can ?? {};
  const context: OfferContext = { can, allow: config.workflows?.allow ?? {}, facts: env.facts };
  const maxParallel = config.workflows?.max_parallel;
  // The end record is queued under the run lock, so the run stores whether it
  // was in the same save. It publishes AFTER withRun releases the lock (#1126
  // P3): publication does a reports-branch push, and no network I/O may hold
  // the lock other engine operations wait on.
  let queued = false;
  let alreadySettled: RunState | undefined;
  const envelope = await withRun(config, runId, env.secrets, async (run, now) => {
    const before = JSON.stringify(run);
    // Whatever settling changed is saved. `cancelled` is derived after settling: the attempts the driver runs that
    // are no longer its open leases.
    const answer = (data: Record<string, unknown>): { save: boolean; envelope: WorkflowEnvelope } => ({
      save: JSON.stringify(run) !== before,
      envelope: ok({
        ...data,
        cancelled: [...running].filter((attempt) => !run.steps.some((step) => step.status === 'leased'
          && step.lease.attempt === attempt && sameDriver(step.lease.driver, driver))),
      }),
    });
    const done = async (result: WorkflowResult): Promise<{ save: boolean; envelope: WorkflowEnvelope }> => {
      queued = await finishRun(config, run, now, result, env.secrets, driver);
      return answer(doneData(run));
    };
    const wait = (open = run.steps.find((step) => step.status === 'leased')): { save: boolean; envelope: WorkflowEnvelope } => {
      // Steps still delivering here are being delivered by another process of this machine, waited for a busy run
      // lock, or wait for a report: of the commit their branch is ahead at on origin, or of a leased step that writes
      // their branch. A driver polls until they settle.
      const delivering = run.steps.filter((step) => step.status === 'delivering').map((step) => step.id);
      const reason = open ? `${open.id} is leased` : delivering.length > 0 ? `${delivering[0]} is delivering` : 'canTakeLease is false';
      return answer({ wait: { reason, ...(delivering.length > 0 ? { delivering } : {}) } });
    };
    if (run.status !== 'running') {
      // Settled by an earlier next, which queued the end record unless usage
      // reporting was off; the done envelope reports that record's state.
      alreadySettled = run;
      return answer(doneData(run));
    }
    const older = missingNeeds(run);
    if (older) return { save: false, envelope: error('run_unreadable', older) };
    for (;;) {
      // Ends reached through reports, and deadlines passed, apply before an open lease is handed back, so a restarted
      // driver does not run again what they already stopped, and a lease past its timeout no longer holds the run.
      const result = reconcileRun(run, now);
      if ('unreadable' in result) return { save: false, envelope: error('run_unreadable', result.unreadable) };
      if ('outcome' in result) return done(result);
      const other = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !sameDriver(step.lease.driver, driver));
      if (other) return wait(other);
      run.driver = driver;
      if (options.canTakeLease !== false && !can.hitl && answerWithoutHitl(config, run, now, options.autoApprove)) continue;
      // An open lease the driver does not list is handed back before another lease is issued, as a restarted driver expects.
      const leased = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !running.has(step.lease.attempt));
      if (!leased) {
        if (options.canTakeLease === false || 'inProgress' in result) {
          const hitl = can.hitl ? waitingHitl(run) : undefined;
          return hitl ? answer({ hitl }) : wait();
        }
        const open = run.steps.filter((step) => step.status === 'leased').length;
        if (maxParallel !== undefined && open >= maxParallel) {
          return answer({ wait: { reason: `${open} steps are leased, as many as workflows.max_parallel allows on this machine` } });
        }
        // A step this driver must not take is held back, and the next ready one is tried. A failed step can change
        // what is ready, so the run settles again.
        const held: Held[] = [];
        let failed = false;
        for (const { lease: state, definition, rendered } of result.ready) {
          const located = locateStep(run, state.id);
          if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${state.id}"`) };
          const plan = planWorkspace(run, located.scope, state, definition, {
            driver, modes: can.workspace, base: run.base ?? options.base,
          });
          if (plan.defer) {
            held.push({ step: state.id, reason: plan.defer.reason, missing: plan.defer.needs ? [`workspace.${plan.defer.needs}`] : [] });
            continue;
          }
          if (plan.fail) {
            failStep(state, plan.fail, run.revision);
            failed = true;
            break;
          }
          const terms = offerTerms(run, state.id, located, plan, context);
          if (terms.kind === 'hold') {
            held.push(heldFor(state.id, terms.missing));
            continue;
          }
          if (terms.kind === 'fail') {
            failStep(state, terms.failure, run.revision);
            failed = true;
            break;
          }
          if (plan.contract && options.base && !run.base) run.base = options.base;
          const { unenforced } = terms.terms;
          const expiresAt = ownDeadline(run, state, definition, now);
          const step = lease(state, offering({
            attempt: `a${randomBytes(4).toString('hex')}`, revision: run.revision, driver,
            ...(unenforced.length > 0 ? { unenforced } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}),
          }, plan.session));
          rememberCopy(run, plan, driver);
          return answer(leaseData(run, step, definition, rendered, terms.terms, plan));
        }
        if (failed) continue;
        return answer({ wait: { reason: held.map((item) => item.reason).join('; '), held } });
      }
      const located = locateStep(run, leased.id);
      if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${leased.id}"`) };
      const rendered = renderLease(located.scope, statesIn(run, located.scope), leased, located.step);
      if (!('code' in rendered)) {
        const plan = planWorkspace(run, located.scope, leased, located.step, {
          driver, modes: can.workspace, base: run.base ?? options.base,
        }, true);
        const offered = plan.fail ? undefined : plan;
        const terms = offerTerms(run, leased.id, located, offered, context);
        // A driver that can no longer run its lease gives it up, so the step waits for one that can instead of looping.
        // No step has run in an unused copy, so the driver gives up the copy too, and another driver may take the step,
        // unless the driver still holds another lease in it.
        if (terms.kind === 'hold') {
          stopAttempt(run, leased, now);
          release(leased);
          const branch = offered?.contract?.branch;
          const copy = branch !== undefined ? run.copies?.[branch] : undefined;
          if (branch !== undefined && copy && !copy.used && !leasedIn(run, branch)) delete copy.owner;
          continue;
        }
        if (terms.kind === 'fail') {
          stopAttempt(run, leased, now);
          failStep(leased, terms.failure, leased.lease.revision);
          continue;
        }
        const unenforced = unionUnenforced(leased.lease.unenforced ?? [], terms.terms.unenforced);
        leased.lease = offering({ ...leased.lease, ...(unenforced.length > 0 ? { unenforced } : {}) }, offered?.session);
        if (offered) rememberCopy(run, offered, driver);
        return answer(leaseData(run, leased, located.step, rendered, terms.terms, offered));
      }
      failStep(leased, rendered, leased.lease.revision);
    }
  });
  const done = (envelope as { data?: { done?: Record<string, unknown> } }).data?.done;
  // Every `next` that answers `done` publishes the end again, so an end saved by a process that stopped before it was
  // published still reaches teamai-reports; an end already there writes nothing.
  const notPublished = done ? await publishRunEnd(config, runId, driver.workspace) : undefined;
  const record = queued
    ? await publishRunRecords(config)
    : alreadySettled && await runRecordState(config, alreadySettled);
  // A run another install owns had its record dropped, not published.
  if (done && record && notPublished?.code !== 'not_owner') done.record = record;
  if (done && notPublished) done.notPublished = notPublished;
  return envelope;
}

function driverFrom(value: unknown): DriverIdentity | undefined {
  const parsed = DriverSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const driver = parsed.data;
  if (driver.kind === '' || driver.machine === '' || driver.workspace === '') return undefined;
  return driver;
}

/** Known driver fields shared by next, report and respond. Any other driver field is reported back as `driver.<field>`. */
const DRIVER_FIELDS = new Set(['kind', 'machine', 'workspace', 'can']);

/** The top-level payload fields `parseNextPayload` reads. */
const NEXT_PAYLOAD_FIELDS = new Set(['driver', 'running', 'canTakeLease', 'base', 'claim']);

/** The top-level payload fields `parseReport` reads. Keep in sync with the fields it picks. */
const REPORT_FIELDS = new Set([
  'attempt', 'revision', 'outcome', 'driver', 'outputs', 'exitCode', 'message', 'tool', 'model', 'session', 'resumed', 'tokens', 'failure', 'changes', 'read', 'agent', 'used',
  'unenforced',
]);

/**
 * The payload fields this CLI does not read: top-level names first, then `driver.<field>` names.
 * Names only, never values, because an unknown field may hold anything (#1164).
 */
function unreadFields(record: Record<string, unknown>, known: ReadonlySet<string>): string[] {
  const ignored = Object.keys(record).filter((key) => !known.has(key));
  const driver = record.driver;
  if (driver !== null && typeof driver === 'object' && !Array.isArray(driver)) {
    for (const key of Object.keys(driver)) {
      if (!DRIVER_FIELDS.has(key)) ignored.push(`driver.${key}`);
    }
  }
  return ignored;
}

/** A declared driver UI answer's provenance and unread payload fields. */
export interface ParsedResponsePayload {
  response: Pick<ResponseInput, 'channel' | 'agent' | 'driver'>;
  ignored: string[];
}

export function parseResponsePayload(value: unknown): ParsedResponsePayload | string {
  if (!isRecord(value)) return 'respond payload must be a JSON object';
  const driver = driverFrom(value.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  return { response: { channel: 'driver', agent: false, driver }, ignored: unreadFields(value, new Set(['driver'])) };
}

/** A parsed report and the payload fields the CLI did not read from it. */
export interface ParsedReport {
  report: ReportInput;
  ignored: string[];
}

/** A parsed `next` payload and the fields the CLI did not read from it. */
export interface ParsedNextPayload {
  request: NextRequest;
  ignored: string[];
}

export function parseReport(value: unknown): ParsedReport | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'report must be a JSON object';
  const record = value as Record<string, unknown>;
  if (typeof record.attempt !== 'string' || record.attempt === '') return 'attempt must be a string';
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision)) return 'revision must be an integer';
  if (record.outcome !== 'success' && record.outcome !== 'failed' && record.outcome !== 'released') {
    return 'outcome must be success, failed, or released';
  }
  const driver = driverFrom(record.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  const report: ReportInput = { attempt: record.attempt, revision: record.revision, outcome: record.outcome, driver };
  if ('outputs' in record) report.outputs = record.outputs;
  if (record.exitCode !== undefined) {
    if (typeof record.exitCode !== 'number' || !Number.isInteger(record.exitCode)) return 'exitCode must be an integer';
    report.exitCode = record.exitCode;
  }
  if (record.message !== undefined) {
    if (typeof record.message !== 'string') return 'message must be a string';
    report.message = record.message;
  }
  for (const field of ['tool', 'model', 'session'] as const) {
    if (record[field] === undefined) continue;
    if (typeof record[field] !== 'string') return `${field} must be a string`;
    report[field] = record[field];
  }
  if (record.resumed !== undefined) {
    const resumed = record.resumed;
    if (!isRecord(resumed) || typeof resumed.tool !== 'string' || resumed.tool === '' || typeof resumed.id !== 'string' || resumed.id === '') {
      return 'resumed must be a session: a tool and an id';
    }
    report.resumed = { tool: resumed.tool, id: resumed.id };
  }
  if (record.tokens !== undefined) {
    if (!record.tokens || typeof record.tokens !== 'object' || Array.isArray(record.tokens)) return 'tokens must be an object';
    const value = record.tokens as Record<string, unknown>;
    const tokens: TokenUsage = {};
    for (const field of ['input', 'output', 'cachedInput'] as const) {
      if (value[field] === undefined) continue;
      if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) return `tokens.${field} must be a finite number`;
      tokens[field] = value[field];
    }
    report.tokens = tokens;
  }
  if (record.failure !== undefined) {
    if (!record.failure || typeof record.failure !== 'object' || Array.isArray(record.failure)) return 'failure must be an object';
    const value = record.failure as Record<string, unknown>;
    if (typeof value.code !== 'string') return 'failure.code must be a string';
    if (typeof value.message !== 'string') return 'failure.message must be a string';
    report.failure = { code: value.code, message: value.message };
  }
  if (record.changes !== undefined) {
    if (!record.changes || typeof record.changes !== 'object' || Array.isArray(record.changes)) return 'changes must be an object';
    const value = record.changes as Record<string, unknown>;
    if (typeof value.branch !== 'string' || typeof value.base !== 'string' || typeof value.from !== 'string' || typeof value.to !== 'string') {
      return 'changes must include branch, base, from, and to';
    }
    if (!Array.isArray(value.commits) || !value.commits.every((commit): commit is string => typeof commit === 'string')) {
      return 'changes.commits must be an array of strings';
    }
    report.changes = { branch: value.branch, base: value.base, from: value.from, to: value.to, commits: value.commits };
    if (value.pr_url !== undefined) report.prUrl = value.pr_url;
  }
  if (record.read !== undefined) {
    const read = ReadSchema.safeParse(record.read);
    if (!read.success) return 'read must include branch, base, and commit';
    report.read = read.data;
  }
  if (record.agent !== undefined) {
    const agent = parseReportedAgent(record.agent);
    if (typeof agent === 'string') return agent;
    report.agent = agent;
  }
  if (record.used !== undefined) {
    const used = parseReportedUsed(record.used);
    if (typeof used === 'string') return used;
    if (used) report.used = used;
  }
  if (record.unenforced !== undefined) {
    const unenforced = ReportedUnenforcedSchema.safeParse(record.unenforced);
    if (!unenforced.success) return 'unenforced must list the requirements the driver did not enforce: max_turns';
    report.unenforced = unenforced.data;
  }
  const ignored = unreadFields(record, REPORT_FIELDS);
  if (isRecord(record.changes)) {
    const known = new Set(['branch', 'base', 'from', 'to', 'commits', 'pr_url']);
    ignored.push(...Object.keys(record.changes).filter((key) => !known.has(key)).map((key) => `changes.${key}`));
  }
  return { report, ignored };
}

/** A `next` payload: who the driver is, and what else it tells `next`. */
export interface NextRequest extends NextOptions {
  driver: DriverIdentity;
}

export function parseNextPayload(value: unknown): ParsedNextPayload | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'next payload must be a JSON object';
  const record = value as Record<string, unknown>;
  const driver = driverFrom(record.driver);
  if (!driver) return 'driver must include kind, machine, and workspace';
  const request: NextRequest = { driver };
  if (record.running !== undefined) {
    if (!Array.isArray(record.running) || !record.running.every((attempt): attempt is string => typeof attempt === 'string')) {
      return 'running must be an array of attempt ids';
    }
    request.running = record.running;
  }
  if (record.canTakeLease !== undefined) {
    if (typeof record.canTakeLease !== 'boolean') return 'canTakeLease must be a boolean';
    request.canTakeLease = record.canTakeLease;
  }
  if (record.base !== undefined) {
    if (!record.base || typeof record.base !== 'object' || Array.isArray(record.base)) return 'base must be an object';
    const base = record.base as Record<string, unknown>;
    if ((base.ref !== undefined && (typeof base.ref !== 'string' || base.ref === '')) || typeof base.commit !== 'string' || base.commit === '') {
      return 'base must include commit, and ref when it is set must not be empty';
    }
    request.base = { ...(typeof base.ref === 'string' ? { ref: base.ref } : {}), commit: base.commit };
  }
  if (record.claim !== undefined) {
    if (typeof record.claim !== 'boolean') return 'claim must be a boolean';
    request.claim = record.claim;
  }
  const ignored = unreadFields(record, NEXT_PAYLOAD_FIELDS);
  const can = isRecord(record.driver) ? record.driver.can : undefined;
  if (can !== undefined) {
    if (!isRecord(can)) return 'driver.can must be an object';
    const parsed = CanSchema.safeParse(can);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      return `driver.can.${issue?.path.join('.')}: ${issue?.message}`;
    }
    request.can = parsed.data;
    ignored.push(...Object.keys(can).filter((key) => !CAN_KEYS.has(key)).map((key) => `driver.can.${key}`));
  }
  return { request, ignored };
}

function rememberSettledAttempt(run: RunState, attempt: string): void {
  // settledAttempts is a bounded dedup history; the cumulative count feeds the
  // run record's iterations field, which must not cap at SETTLED_ATTEMPTS_LIMIT.
  // A run file from before settledCount starts from its history.
  run.settledCount = (run.settledCount ?? run.settledAttempts.length) + 1;
  run.settledAttempts.push(attempt);
  const extra = run.settledAttempts.length - SETTLED_ATTEMPTS_LIMIT;
  if (extra > 0) run.settledAttempts.splice(0, extra);
}

/**
 * Why a report's `changes` or `read` do not fit the workspace its attempt was leased, or undefined when they fit.
 * A step that writes reports `changes`. A read-only step in a copy reports `read`, and a success must carry it.
 */
function workspaceMismatch(report: ReportInput, contract: WorkspaceContract | undefined): string | undefined {
  const readOnly = contract?.mode === 'read-only';
  const leased = contract ? `${readOnly ? 'read-only ' : ''}branch ${contract.branch} on base ${contract.base.commit}` : 'no workspace';
  const elsewhere = (branch: string, base: string): boolean => !contract || branch !== contract.branch || base !== contract.base.commit;
  if (report.changes && (readOnly || elsewhere(report.changes.branch, report.changes.base))) {
    return `changes name branch ${report.changes.branch} on base ${report.changes.base}, but attempt ${report.attempt} was leased ${leased}`;
  }
  if (report.read && (!readOnly || elsewhere(report.read.branch, report.read.base))) {
    return `read names branch ${report.read.branch} on base ${report.read.base}, but attempt ${report.attempt} was leased ${leased}`;
  }
  if (readOnly && report.outcome === 'success' && !report.read) {
    return `attempt ${report.attempt} was leased ${leased}, and its success report has no read`;
  }
  return undefined;
}

/**
 * Whether a step that can still run uses `branch`. It reads the run as the next `next` settles it, so a loop that runs
 * steps again has made them pending, and a workflow or fan-out that can start has added its steps. A running workflow
 * or `for_each` step is skipped, since its steps are in the run; one that has not started counts by what it would run.
 */
function branchStillUsed(run: RunState, branch: string, now: string): boolean {
  const ahead = structuredClone(run);
  if ('unreadable' in reconcileRun(ahead, now)) return true;
  for (const item of ahead.steps) {
    if (item.status === 'running' || item.status === 'delivering' || settled(item)) continue;
    const located = locateStep(ahead, item.id);
    if (located && plannedBranch(ahead, located.scope, item, located.step) === branch) return true;
  }
  return false;
}

/** Whether a leased step writes `branch`, so a commit it pushed before it reported may already be on origin. */
function branchWriterLeased(run: RunState, branch: string): boolean {
  return run.steps.some((item) => {
    if (item.status !== 'leased') return false;
    const located = locateStep(run, item.id);
    const plan = located && planWorkspace(run, located.scope, item, located.step, {
      driver: item.lease.driver, modes: ['read-only', 'new', 'continue'],
    }, true);
    return plan !== undefined && plan.mode !== 'read-only' && plan.contract?.branch === branch;
  });
}

/**
 * The session chains the steps that have not settled will continue, once each: each chain is the session a step resumes
 * with the sessions it continued before, newest first. Like `branchStillUsed`, it reads the run as the next `next` settles
 * it, so a step a loop runs again counts. The steps of a workflow that has not started count by their definitions: such a
 * step continues a pass a loop archived, or resumes the step it names around its workflow.
 */
export function resumableSessions(run: RunState): LeaseSession[] {
  const ahead = structuredClone(run);
  reconcileRun(ahead, new Date().toISOString());
  const sessions = new Map<string, LeaseSession>();
  const visit = (scope: Scope, state: StepState, step: WorkflowStep, unstarted: boolean): void => {
    // A step of a workflow that has not started reads none of that workflow's steps yet.
    const from = step.session && 'from' in step.session ? step.session.from : undefined;
    const own = unstarted && scope.definition.steps.some((item) => item.id === from);
    const session = own ? undefined : sessionOf(ahead, scope, state, step);
    if (session && !('code' in session)) sessions.set(`${session.tool}\0${session.id}`, session);
    if (state.status !== 'pending' || step.forEach) return;
    const child = childScope(ahead, scope, statesIn(ahead, scope), state, step);
    if (!child) return;
    for (const inner of child.definition.steps) visit(child, { id: `${child.prefix}${inner.id}`, status: 'pending' }, inner, true);
  };
  for (const state of ahead.steps) {
    if (settled(state)) continue;
    const located = locateStep(ahead, state.id);
    if (located) visit(located.scope, state, located.step, false);
  }
  return [...sessions.values()];
}

/** Why `resumed` is not a session the lease of `step` offered: its session, or one of the earlier ones it names. */
function resumedMismatch(step: LeasedStep, resumed: SessionRef | undefined): string | undefined {
  if (!resumed) return undefined;
  const offered = step.lease.session;
  if (!offered) return `step "${step.id}" resumes no session, so its report cannot name one as resumed`;
  if ([offered, ...(offered.earlier ?? [])].some((session) => session.tool === resumed.tool && session.id === resumed.id)) return undefined;
  return `resumed names ${resumed.tool} session ${resumed.id}, which attempt ${step.lease.attempt} did not offer. Report the lease's session, or an earlier one it names, or leave resumed out for a new session`;
}

/** `held` offering `session`, the session its report may name as resumed; a lease that offers none keeps none. */
function offering(held: StepLease, session: LeaseSession | undefined): StepLease {
  const { session: _previous, ...rest } = held;
  return session ? { ...rest, session } : rest;
}

/** Records that the session the attempt ran in continues the one it resumed, when that is another session. */
function continueSession(run: RunState, report: ReportInput): void {
  const from = report.resumed;
  if (!from || !report.tool || !report.session) return;
  const to = { tool: report.tool, id: report.session };
  if (from.tool === to.tool && from.id === to.id) return;
  (run.sessionContinuations ??= []).push({ from, to });
}

/**
 * Why the URL a delivering step's report keeps after sanitizing is still dropped, read from the run before its lock is
 * taken, since the provider's lookup is a network call. The locked report checks the step again.
 */
async function reportedPrUnmatched(config: LocalConfig, runId: string, report: ReportInput, url: PrUrl): Promise<string | undefined> {
  if (report.outcome !== 'success' || !report.changes || !isRunId(runId)) return undefined;
  const run = await readRun(config, runId);
  if (typeof run === 'string' || !run.checkout) return undefined;
  const target = deliveryTarget(run, report.changes.branch);
  const step = run.steps.find((item) => item.status === 'leased' && item.lease.attempt === report.attempt);
  if (!step || target === undefined || locateStep(run, step.id)?.step.deliver !== 'pr') return undefined;
  return reportedPrMismatch({ checkout: run.checkout, url, branch: report.changes.branch, target });
}

/**
 * Counts the tokens a report of an attempt the engine stopped says it spent, so a budget does not undercount the work a
 * stop cut short. Only the driver that held the lease counts, and only once. Returns whether it counted them.
 */
function countStoppedTokens(run: RunState, report: ReportInput): boolean {
  const stopped = run.stoppedAttempts?.find((entry) => entry.attempt === report.attempt);
  if (!report.tokens || !stopped || !sameDriver(stopped.driver, report.driver)) return false;
  countLateTokens(run, stopped, report.tokens);
  return true;
}

/** `secrets`: what the run file masks, when the caller already resolved them for this operation. */
export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput, secrets?: Record<string, string>): Promise<WorkflowEnvelope> {
  if (isLeaseRef(report.attempt)) {
    return error('judge_lease', `Attempt ${report.attempt} is a judge lease, which workflow report does not settle. Submit its answer with: teamai score --lease ${report.attempt} --submit --stdin`);
  }
  const install = await installOwner(config);
  const reported = report.prUrl === undefined ? undefined : sanitizePrUrl(report.prUrl);
  const unmatched = reported?.url ? await reportedPrUnmatched(config, runId, report, reported.url) : undefined;
  return withRun(config, runId, secrets ?? await knownSecrets(config), async (run, now) => {
    // Settled membership wins. An old revision of a settled attempt is still repeated_report.
    if (run.settledAttempts.includes(report.attempt)) {
      return { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) };
    }
    // Before the driver check, so any driver learns that the attempt was cancelled.
    if (run.cancelledAttempts?.includes(report.attempt)) {
      return { save: countStoppedTokens(run, report), envelope: error('lease_cancelled', `Attempt ${report.attempt} was cancelled; its report is not recorded`) };
    }
    const step = run.steps.find((item): item is LeasedStep => item.status === 'leased' && item.lease.attempt === report.attempt);
    if (!step) {
      if (report.revision !== run.revision) {
        return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
      }
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    const reconciled = reconcileRun(run, now);
    if ('unreadable' in reconciled) return { save: false, envelope: error('run_unreadable', reconciled.unreadable) };
    if (run.cancelledAttempts?.includes(report.attempt)) {
      countStoppedTokens(run, report);
      return { save: true, envelope: error('lease_cancelled', `Attempt ${report.attempt} was cancelled; its report is not recorded`) };
    }

    // A lease is checked against the revision it was handed out at, so a report of a parallel lease does not make it stale.
    if (report.revision !== step.lease.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; attempt ${report.attempt} was leased at ${step.lease.revision}`) };
    }
    if (!sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    const located = locateStep(run, step.id);
    const defined = located?.step;
    const plan = located && planWorkspace(run, located.scope, step, located.step, {
      driver: step.lease.driver, modes: ['read-only', 'new', 'continue'],
    }, true);
    const contract = plan?.contract;
    const mismatch = workspaceMismatch(report, contract) ?? resumedMismatch(step, report.resumed);
    if (mismatch) return { save: false, envelope: error('invalid_report', mismatch) };
    const added = reportedUnenforced(report.unenforced ?? [], { maxTurns: defined?.maxTurns });
    if (typeof added === 'string') return { save: false, envelope: error('invalid_report', `Attempt ${report.attempt} of step "${step.id}": ${added}`) };
    let outcome = report.outcome;
    let message = report.message;
    let failure = report.failure;
    const measured = report.tokens?.input !== undefined || report.tokens?.output !== undefined;
    const unmeasured = outcome === 'success' && defined?.prompt !== undefined && located?.scope.budgeted === true && !measured;
    // A person drives an interactive prompt, so its spend is recorded as not counted rather than failing their work.
    const unenforced = unionUnenforced(step.lease.unenforced ?? [], [...added, ...(unmeasured && defined.interactive ? [{ requirement: 'budget' as const }] : [])]);
    if (unmeasured && !defined.interactive) {
      outcome = 'failed';
      message = `Step "${step.id}" runs under a token budget, and its report has no tokens, so the budget cannot count what it spent. Run it with a driver that reports tokens (driver.can.tokens), then retry the step.`;
      failure = { code: 'budget_unmeasured', message };
    }
    if (outcome === 'success' && defined?.output && (!defined.interactive || report.outputs !== undefined)) {
      const mismatch = outputMismatch(defined.output, report.outputs);
      if (mismatch) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${mismatch}`;
        failure = { code: 'invalid_output', message };
      }
    }

    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;
    const settlement = {
      settledAt: run.revision,
      attempt: report.attempt,
      exitCode: report.exitCode,
      message,
      tool: report.tool,
      model: report.model,
      session: report.session,
      tokens: report.tokens,
      ...(report.changes ? { changes: report.changes } : {}),
      ...(report.read ? { read: report.read } : {}),
      agent: settleObservation(report, defined?.agent),
      ...(report.used ? { used: report.used } : {}),
      ...(unenforced.length > 0 ? { unenforced } : {}),
      installId: install.id,
    };
    if (outcome !== 'released') continueSession(run, report);
    else if (report.tokens) (run.releasedTokens ??= []).push({ step: step.id, attempt: report.attempt, tokens: report.tokens });
    if (report.changes) {
      const copy = (run.copies ??= {})[report.changes.branch] ?? { owner: report.driver };
      copy.owner ??= report.driver;
      copy.commit = report.changes.to;
      run.copies[report.changes.branch] = copy;
    }
    // The step itself ran in the copy, not only its staging or setup.
    if (contract && (report.outcome === 'success' || report.exitCode !== undefined || report.changes || report.read)) {
      ((run.copies ??= {})[contract.branch] ??= { owner: report.driver }).used = true;
    }
    const successful = { ...settlement, ...(report.outputs !== undefined ? { outputs: report.outputs } : {}) };
    const delivery = outcome === 'success' && defined?.deliver === 'pr' ? deliverableOf(run, step, defined, report.changes) : undefined;
    const settledStep = outcome === 'released' ? release(step)
      : outcome !== 'success' ? fail(step, { ...settlement, failure })
        : delivery ? startDelivery(step, successful, { ...delivery, ...(reported?.url && !unmatched ? { reported: reported.url } : {}) })
          : succeed(step, successful);
    // From the lease, so a reader that was the copy's last user lets the driver remove the worktree. Delivery reads the
    // pushed branch, so it does not keep the worktree.
    const cleanup = outcome === 'success' && contract !== undefined && !branchStillUsed(run, contract.branch, now);
    // A URL that is not kept, or that no delivery uses, is named without its value, which may hold a token, and the
    // report still counts.
    const dropReason = reported?.reason ?? unmatched ?? (reported?.url === undefined || delivery ? undefined
      : defined?.deliver !== 'pr' ? 'the step has no deliver: pr'
        : outcome === 'released' ? 'the step was released'
          : outcome !== 'success' ? 'the step failed'
            : 'the branch has no changes beyond the run base');
    return {
      save: true,
      envelope: ok({
        accepted: true,
        revision: run.revision,
        step: { id: settledStep.id, status: settledStep.status, outcome, ...(settlement.unenforced ? { unenforced: settlement.unenforced } : {}) },
        ...(cleanup ? { cleanup: true } : {}),
        ...(dropReason ? { dropped: [{ field: 'changes.pr_url', reason: dropReason }] } : {}),
      }),
    };
  });
}
