import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { parseReportedAgent, parseReportedUsed, settleObservation, type ReportedAgent, type Used } from '../agent-observation.js';
import { loadTeamConfig } from '../config.js';
import { DefaultWorkflows } from '../default-workflows.js';
import { DriverSchema, sameDriver } from '../driver-identity.js';
import { RunModeSchema, type RunMode } from '../launch-context.js';
import { log } from '../utils/logger.js';
import { getDefaultBranch } from '../utils/git.js';
import { getDataHome, SYNC_LOCK_FILENAME, type JsonValue, type LocalConfig } from '../types.js';
import { acquireLock, releaseLock } from '../update.js';
import { loadCachedWorkflow, loadWorkflowTree, namespaceConflictOf, startingAlias } from './cache.js';
import { claimedAway, claimRun, publishRunEnd, reconcileTakenCopies } from './handoff.js';
import {
  evaluateExpression, expressionPaths, isRecord, isTruthy, parseExpression, pathValue, resolvePath,
  type Expression, type ExpressionPath,
} from './expression.js';
import { outputMismatch } from './output.js';
import { publishPendingRecords, publishRunRecords, queueRunRecord, runRecordState, type RecordState } from './records.js';
import { resolveRetention, retentionEnds } from './retention.js';
import {
  parseTemplate, renderLeaseText, renderStrings, renderText, stepExpressions, templatedTexts, templatePaths,
  type StepExpression, type TemplateError,
} from './template.js';
import { stageSettledEvidence } from './place/place.js';
import { parseStepPath } from './step-path.js';
import type { ConfinedLease, LeaseWire } from './lease-wire.js';
import { decideConfined, type ConfinedDecision } from './confined-place.js';
import {
  ConfinedRunReportSchema, ReadSchema, answerHitl, fail, inProgress, lease, release, settled, skip, start, startDelivery, stopAttempt, stopWhere, stopped,
  succeed, waitForAnswer, type ConfinedRunReport, type ItemResult, type LeasedStep, type StepRead, type StepState,
} from './step-state.js';
import { allowanceInUse, budgetSpent, countLateTokens, expire, itemsSpent, leaseDeadline, ownDeadline, spendAllowances, spentAllowances, startLimits, turnLimits } from './limits.js';
import { addItems, afterStanding, expandItems, isItem, itemLimit, itemLimitMismatch, itemsAfter, itemsOf, itemsSettled, startedItems } from './fan-out.js';
import { decideRound, decideStepLoop, exhaustedAtStart, firstPass, isUnder, loopSettled } from './loop.js';
import { childScope, contextOf, finallyScope, insertChildren, localId, statesIn, stepDefinitions, topScope, type Scope } from './scope.js';
import { contractClone, deliverableOf, deliveryTarget, isIsolated, isPublishContract, planWorkspace, plannedBranch, sessionOf, stepRoleOf, workLeftUndelivered, type LeaseSession, type SessionRef, type WorkspaceContract, type WorkspacePlan } from './workspace.js';
import {
  deliverPr, deliveryFailure, findDelivered, reportedPrMismatch, type DeliveryJob,
} from './pr-delivery.js';
import { sanitizePrUrl, type PrUrl } from './pr-url.js';
import { completeDelivery, deliveringStep, nextDelivery, resolveCreate, sameCreate, unresolvedCreate } from './delivery-ledger.js';
import type { DeliveryKey, UnresolvedCreate } from './delivery-schema.js';
import {
  CAN_KEYS, CanSchema, LimitSchema, ReportedUnenforcedSchema, heldFor, setsLimit, mergeRequirements, negotiate, reportedUnenforced, requiredEnvKeys, unionUnenforced,
  type Allow, type DriverCan, type EnvFacts, type Held, type InEffect, type Limit, type Negotiation, type ReportedUnenforced, type Terms, type TurnLimits,
} from './requirements.js';
import { knownSecrets, resolveWorkflowEnv, secretKey, type WorkflowEnv } from '../env-resolution.js';
import { TeamPin } from './team-pin.js';
import { deliveryLockPath, generateRunId, installOwner, isRunId, readAttemptOutcomes, readRun, runScratchDir, updateRun } from './store.js';
import { cleanUpSucceededRun } from './leftovers.js';
import { withFileLock } from '../update.js';
import { admitWorkflow, heldSecret, type Admitted } from './admission.js';
import { workflowField } from './parse.js';
import type {
  DriverIdentity,
  OutputSchema,
  RunState,
  RunStatus,
  StartedBy,
  StepHitl,
  StepLease,
  StepOutcome,
  WorkflowDefinition,
  WorkflowEnvelope,
  AdmittedWorkflow,
  Finalizing,
  LeasedConfined,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';
import { hasAction, onlyPersonAnswers, stepWorkflow } from './types.js';
import { Writes } from './writes.js';
import { describeWorkflow } from './describe.js';
import { CONFINED_LEVELS, CostSchema } from '../tool-launch/confined-level.js';
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
  /** Milliseconds around the tool launch only, as the driver measured it. */
  durationMs?: number;
  /** What the tool stated the attempt cost, in its own unit. Never estimated. */
  cost?: z.infer<typeof CostSchema>;
  failure?: WorkflowFailure;
  /** The branch this attempt committed, when it ran in a workspace. */
  changes?: { branch: string; base: string; from: string; to: string; commits: string[] };
  /** As `next`'s `queued`: the driver's other open leases it holds but has not started, whose own timeout counts from this report. */
  queued?: string[];
  /** `changes.pr_url` as the driver sent it: a pull request it opened itself, kept only once it is sanitized. */
  prUrl?: unknown;
  /** The branch and commit this attempt read, when it ran read-only in a workspace. */
  read?: StepRead;
  agent?: ReportedAgent;
  /** The team skills the attempt loaded, by name. */
  used?: Used;
  /** What the attempt's driver learned, once it ran the step, that it did not enforce. */
  unenforced?: ReportedUnenforced;
  /** The lease limit that ended the prompt's turn, which then succeeded. */
  limit?: Limit;
  /** What the run of a step leased with `confined` measured. */
  confined?: ConfinedRunReport;
  /** The lines the step said as it ran, such as a command's stderr, which a shortcut of the run shows. */
  progress?: string[];
}

/** The most progress lines a pass keeps: its last ones, which say how it ended. */
const PROGRESS_LINES = 200;

/** A protocol rejection that retains its actionable code and message. */
export function error(code: string, message: string): Extract<WorkflowEnvelope, { error: unknown }> {
  return { error: { code, message } };
}

/** What a successful envelope carries. */
type EnvelopeData = Extract<WorkflowEnvelope, { data: unknown }>['data'];

/** A successful workflow operation envelope. */
export function ok(value: EnvelopeData): WorkflowEnvelope {
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

function passKey(step: StepState): string {
  return `${step.id}#${step.pass ?? 1}`;
}

/** The pass of each step of `run` that succeeded. */
function succeededPasses(run: RunState): Set<string> {
  return new Set(run.steps.filter((step) => step.status === 'succeeded').map(passKey));
}

/** What one operation under the run lock answers, and whether it changed the run. */
type RunOperation = { envelope: WorkflowEnvelope; save: boolean };

/**
 * Applies one operation under the run lock and saves only when requested. `secrets`, what the run file and records
 * mask, are the ones the operation resolved before the lock, since resolving them can read the team env.
 */
export async function withRun(
  config: LocalConfig,
  runId: string,
  secrets: Record<string, string>,
  mutate: (run: RunState, now: string) => Promise<RunOperation>,
): Promise<WorkflowEnvelope> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 or 16 hex digits');

  const updated = await updateRun(config, runId, secrets, async (loaded) => {
    if (loaded === 'missing') return { value: error('run_not_found', `Run ${runId} was not found`) };
    // One timestamp per operation, so a settled run's end record and its run file agree.
    const now = new Date().toISOString();
    const before = succeededPasses(loaded);
    const result = await mutate(loaded, now);

    if (!result.save) return { value: result.envelope };
    // Before the save, so what the steps that settled now left in a clone is judged, not what a later step left there.
    const succeeded = loaded.steps.filter((step) => step.status === 'succeeded' && !before.has(passKey(step))).map((step) => step.id);

    if (succeeded.length > 0) await stageSettledEvidence(config, loaded, succeeded);
    loaded.updatedAt = now;

    return { value: result.envelope, write: loaded };
  });

  switch (updated.status) {
    case 'done':
      return updated.value;
    case 'busy':
      return error('busy', `Run ${runId} is locked by another process`);
    case 'corrupt':
      return error('run_unreadable', `Run ${runId} could not be read`);
    default: {
      const unhandled: never = updated;

      return unhandled;
    }
  }
}

interface RenderedLease {
  /** A prompt step's prompt, or an answer step's `answer`, as its template rendered. */
  prompt?: string;
  env?: Record<string, string>;
  /** A command step's `writes`, as each template rendered. */
  writes?: string[];
  /** The step's `model` as its template rendered; an empty one means the tool's default. */
  model?: string;
  /** The `defaults.model` in effect for a prompt step, as written. */
  defaultModel?: string;
  /** The directory of a step with `workspace: { confined }`, as its template rendered. */
  confined?: string;
}

/** Whether a result that is a plain object or a message is the message. Not for arrays, which are not plain objects. */
function isMessage<Result extends object>(result: Result | string): result is string {
  return !isRecord(result);
}

/** The workflow or inline step name used in engine and control diagnostics. */
export function workflowLabel(scope: Scope): string {
  return 'name' in scope.definition ? `workflow "${scope.definition.name}"` : `step "${scope.prefix.slice(0, -1)}" inline workflow`;
}

/** The scope and definition of the step instance at `path`, or undefined when the run file does not describe it. */
export function locateStep(run: RunState, path: string): { scope: Scope; step: WorkflowStep } | undefined {
  const segments = parseStepPath(path);
  let scope = run.definition.finally?.some((step) => step.id === segments[0]?.id) ? finallyScope(run) : topScope(run);

  for (const [index, segment] of segments.entries()) {
    const step = scope.definition.steps.find((item) => item.id === segment.id);

    if (!step) return undefined;

    if (index === segments.length - 1) return { scope, step };
    const instance = `${scope.prefix}${segment.id}${segment.index === undefined ? '' : `[${segment.index}]`}`;
    const states = statesIn(run, scope);
    // statesIn holds no for_each item.
    const state = (segment.index === undefined ? states : run.steps).find((item) => item.id === instance);
    const child = state && childScope(run, scope, states, state, step);

    if (!child) return undefined;
    scope = child;
  }

  return undefined;
}

/** The requirements in effect at each `from` step that runs the workflow producer `path` outputs. */
export function fromRequirements(run: RunState, path: string): InEffect[] {
  const located = locateStep(run, path);

  if (!located) return [];
  const { scope, step: producer } = located;

  return scope.definition.steps.flatMap((step) => {
    const runs = stepWorkflow(step);

    return runs?.kind === 'from' && runs.step === producer.id ? [mergeRequirements(scope.requires, step.requires)] : [];
  });
}

/** A step's `with` holds a template that does not parse. Pull rejects one, so the run file was changed. */
function withTemplateFailure(state: StepState, templateError: TemplateError): WorkflowFailure {
  return { code: 'invalid_template', message: `step "${state.id}" with template ${templateError.source}: ${templateError.message}` };
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

  for (const templated of templatedTexts(definition)) {
    if (templated.what.startsWith('with.')) continue;
    const value = renderLeaseText(context, state, templated);

    if (!isMessage(value)) return value;
    rendered.set(templated.what, value);
  }

  const env = Object.keys(definition.env ?? {}).map((name) => [name, rendered.get(`env.${name}`) ?? ''] as const);

  const texts: RenderedLease = {};
  const prompt = rendered.get('prompt') ?? rendered.get('answer');
  const writes = (definition.writes ?? []).map((_, index) => rendered.get(`writes[${index}]`) ?? '');
  const outside = writes.find((written) => !Writes.isRenderedPath(written));

  if (outside !== undefined) return { code: 'invalid_template', message: `step "${state.id}" writes ${JSON.stringify(outside)}, which is neither a path inside the checkout nor an absolute path; give writes a path relative to the checkout, such as docs/, or an input that names a directory` };

  if (definition.writes) texts.writes = writes;
  const model = rendered.get('model');
  const confined = rendered.get('workspace.confined');

  if (prompt !== undefined) texts.prompt = prompt;

  if (confined !== undefined) texts.confined = confined;

  if (definition.env) texts.env = Object.fromEntries(env);

  if (model !== undefined) texts.model = model;

  // A model that rendered empty asks for the tool's default, so the defaults' model does not stand in for it.
  if (definition.prompt !== undefined && scope.defaultModel !== undefined && model !== '') texts.defaultModel = scope.defaultModel;

  return texts;
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

/**
 * The command the person runs to answer step `step` of run `run` at `pass`, with `choice` written as it should appear:
 * a placeholder such as `<option>`. A fan-out step path such as `items[0].ask` is quoted.
 */
export function respondCommand(run: string, step: string, choice: string, pass: number): string {
  return `teamai workflow respond ${run} ${stepArgument(step)} ${choice} --pass ${pass}`;
}

/** The command the person runs to retry step `step` of run `run`, quoted as `respondCommand` quotes it. */
export function retryCommand(run: string, step: string): string {
  return `teamai workflow retry ${run} ${stepArgument(step)}`;
}

function stepArgument(step: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(step) ? step : `'${step}'`;
}

/** The first gate of `run` that waits, as a driver with HITL is asked it; with `byAgent`, only one an agent may answer. */
function waitingHitl(run: RunState, { byAgent }: { byAgent: boolean }) {
  const state = run.steps.find((step) => {
    const hitl = step.status === 'waiting' ? locateStep(run, step.id)?.step.hitl : undefined;

    return hitl !== undefined && !(byAgent && onlyPersonAnswers(hitl, { autoApprove: true }));
  });

  const located = state && locateStep(run, state.id);

  if (!state || !located?.step.hitl) return undefined;

  return { run: run.id, step: state.id, pass: state.pass ?? 1, ...located.step.hitl,
    respond: respondCommand(run.id, state.id, '<option>', state.pass ?? 1),
    message: hitlMessage(located.scope, statesIn(run, located.scope), state, located.step) };
}

/** Answers each waiting optional approval `yes` and each waiting choice with a default by it, as auto-approve. */
function answerOptionalGates(run: RunState, now: string): boolean {
  let changed = false;
  const definitionOf = stepDefinitions(run);

  for (const state of run.steps) {
    if (state.status !== 'waiting') continue;
    const hitl = definitionOf(state.id)?.hitl;

    if (!hitl || hitl.required) continue;

    if (hitl.kind === 'approve') {
      log.warn(`Step "${state.id}" was approved by auto_approve.`);
      answerHitl(state, { choice: 'yes', at: now, channel: 'auto_approve', agent: false });
    } else if (hitl.default !== undefined) {
      log.warn(`Step "${state.id}" chose "${hitl.default}" by auto_approve.`);
      answerHitl(state, { choice: hitl.default, at: now, channel: 'auto_approve', agent: false });
    } else continue;
    changed = true;
  }

  return changed;
}

/**
 * How a driver nobody attends hands a step only a person can take to one: a driver without HITL, or one whose HITL is an
 * agent's, which answers optional gates but takes no step only a person can. `offers`: it offers the run to a person, so
 * the step waits, held for `hitl` as an interactive step is. `unoffered`: it could not, for `reason`, so the step fails
 * `hitl_required` saying so. A driver without HITL that hands nothing over sends none, and the step fails `hitl_required`.
 */
export type PersonHandoff = { kind: 'offers' } | { kind: 'unoffered'; reason: string };

/** Why step `step` of run `run`, which only a person can take, failed `hitl_required` under a driver without HITL. */
function personRequired(run: string, step: string, unoffered: string | undefined): WorkflowFailure {
  const retry = `${retryCommand(run, step)}; then teamai workflow resume ${run}`;

  return unoffered === undefined
    ? { code: 'hitl_required', message: `Step "${step}" needs a person's answer, and the driver declares no HITL (driver.can.hitl). Retry it, then resume the run where a person answers, from a terminal in an attended run (TEAMAI_MODE=attended, or neither TEAMAI_MODE nor CI set): ${retry}` }
    : { code: 'hitl_required', message: `Step "${step}" needs a person, and run ${run} could not be offered to one: ${unoffered}. Its state is on this machine. Retry the step here, then resume the run where a person answers: ${retry}` };
}

/** Fails each waiting step of `run` whose answer only a person gives, as a driver with an agent's HITL that could not offer the run to one, for `reason`. */
function failForPerson(run: RunState, reason: string): boolean {
  const definitionOf = stepDefinitions(run);
  let changed = false;

  for (const state of run.steps) {
    const hitl = state.status === 'waiting' ? definitionOf(state.id)?.hitl : undefined;

    if (!hitl || !onlyPersonAnswers(hitl, { autoApprove: true })) continue;
    const failure = personRequired(run.id, state.id, reason);
    log.warn(failure.message);
    failStep(state, failure, run.revision);
    changed = true;
  }

  return changed;
}

function answerWithoutHitl(run: RunState, now: string, { autoApprove, handoff }: { autoApprove: boolean; handoff: PersonHandoff | undefined }): boolean {
  let changed = autoApprove ? answerOptionalGates(run, now) : false;
  const definitionOf = stepDefinitions(run);

  for (const state of run.steps) {
    if (state.status !== 'waiting') continue;
    const hitl = definitionOf(state.id)?.hitl;

    if (!hitl) continue;

    if (onlyPersonAnswers(hitl, { autoApprove })) {
      if (handoff?.kind === 'offers') continue;
      const failure = personRequired(run.id, state.id, handoff?.kind === 'unoffered' ? handoff.reason : undefined);
      log.warn(failure.message);
      failStep(state, failure, run.revision);
    } else {
      log.warn(`Step "${state.id}" was skipped: its approve HITL request needs a person, and the driver declares no HITL (driver.can.hitl). Set workflows.auto_approve, pass --auto-approve, or run the workflow where a person answers, from a terminal in an attended run (TEAMAI_MODE=attended, or neither TEAMAI_MODE nor CI set).`);
      answerHitl(state, { choice: 'no', at: now, channel: 'no_hitl', agent: false });
    }

    changed = true;
  }

  return changed;
}

/** The steps of `run` that wait for an answer only a person gives, as held for `hitl` from a driver without it. */
function waitingForPerson(run: RunState, { autoApprove }: { autoApprove: boolean }): Held[] {
  const definitionOf = stepDefinitions(run);

  return run.steps.flatMap((state) => {
    const hitl = state.status === 'waiting' ? definitionOf(state.id)?.hitl : undefined;

    return hitl && onlyPersonAnswers(hitl, { autoApprove }) ? [heldFor(state.id, ['hitl'])] : [];
  });
}

/** A step ready now that only a person can take: one that waits for an answer, by the kind of its request, or an interactive one. */
export type PersonStep = { step: string; kind: StepHitl['kind'] | 'interactive' };

/**
 * The steps of `run` ready now that only a person can take, as a driver without HITL meets them in an unattended run
 * that answers optional gates when `autoApprove`: one waiting for an answer that does not give, or an interactive one.
 * It settles a copy, so `run` stays as it is.
 */
export function personSteps(run: RunState, now: string, { autoApprove }: { autoApprove: boolean }): PersonStep[] {
  const copy = structuredClone(run);
  const reconciled = reconcileRun(copy, now);
  const definitionOf = stepDefinitions(copy);

  const answers = copy.steps.flatMap((state): PersonStep[] => {
    const hitl = state.status === 'waiting' ? definitionOf(state.id)?.hitl : undefined;

    return hitl && onlyPersonAnswers(hitl, { autoApprove }) ? [{ step: state.id, kind: hitl.kind }] : [];
  });

  const interactive = 'ready' in reconciled ? reconciled.ready.flatMap((ready): PersonStep[] => (ready.definition.interactive ? [{ step: ready.lease.id, kind: 'interactive' }] : [])) : [];

  return [...answers, ...interactive];
}

/** The lease `next` answers with: what `LeaseWireSchema` reads, plus the run, the pass, and the gaps the engine names. */
type LeaseData = Omit<LeaseWire, 'attempt'> & {
  run: string; attempt: LeasedStep['lease']['attempt']; pass: number; unenforced?: LeasedStep['lease']['unenforced'];
};

type LeaseAnswer = { lease: LeaseData };

function leaseData(
  run: RunState, state: LeasedStep, definition: WorkflowStep, rendered: RenderedLease,
  { requires, envScope, maxTurns, setup, role }: Omit<GrantedTerms, 'unenforced' | 'limits'>, plan?: WorkspacePlan, confined?: ConfinedLease,
): LeaseAnswer {
  const expiresAt = leaseDeadline(run, state);

  const wire: LeaseData = {
    run: run.id,
    step: state.id,
    attempt: state.lease.attempt,
    revision: state.lease.revision,
    pass: state.pass ?? 1,
  };

  if (definition.command !== undefined) wire.command = definition.command;

  if (rendered.env) wire.env = rendered.env;

  if (rendered.prompt !== undefined) wire.prompt = rendered.prompt;

  if (definition.answer !== undefined) wire.answer = true;

  if (rendered.writes) wire.writes = rendered.writes;

  if (definition.agent !== undefined) wire.agent = definition.agent;

  if (definition.tool !== undefined) wire.tool = definition.tool;

  if (definition.permissions !== undefined) wire.permissions = definition.permissions;

  const model = definition.model instanceof Object ? definition.model : rendered.model;

  if (model) wire.model = model;

  if (rendered.defaultModel !== undefined) wire.defaultModel = rendered.defaultModel;

  if (definition.output) wire.output = definition.output;

  if (plan?.contract) wire.workspace = plan.contract;

  if (confined) wire.confined = confined;

  if (role !== undefined) wire.role = role;

  if (plan?.session) wire.session = plan.session;

  if (definition.interactive) wire.interactive = true;

  if (definition.workspace === 'read-only') wire.readOnly = true;

  if (Object.keys(requires).length > 0) wire.requires = requires;

  if (envScope) wire.envScope = envScope;

  if (maxTurns !== undefined) wire.maxTurns = maxTurns;

  if (state.lease.limits) wire.limits = state.lease.limits;

  if (setup) wire.setup = setup;

  if (state.lease.unenforced) wire.unenforced = state.lease.unenforced;

  if (expiresAt !== undefined) wire.expiresAt = expiresAt;

  return { lease: wire };
}

/**
 * Records who opened a workspace the first time a driver takes its branch, or who first leases a copy a claim brought in,
 * and, before the copy has a commit, the branch it starts from.
 */
function rememberCopy(run: RunState, plan: WorkspacePlan, driver: DriverIdentity): void {
  const { contract } = plan;

  // A step that publishes to a data branch makes no copy: what it staged is on origin, or pending, once it finished.
  if (!contract || isPublishContract(contract)) return;
  const { branch } = contract;
  const copy = (run.copies ??= {})[branch];

  if (contract.mode === 'team') {
    if (copy) copy.owner ??= driver;
    else run.copies[branch] = { owner: driver, kind: 'team' };

    return;
  }

  const from = contract.start.branch ?? contract.merge[0]?.branch;

  if (copy) {
    copy.owner ??= driver;

    if (!copy.from && !copy.commit && from && from !== branch) copy.from = from;
  }
  else {
    const opened: NonNullable<RunState['copies']>[string] = { owner: driver };

    if (from && from !== branch) opened.from = from;

    if (contractClone(contract)) opened.kind = 'clone';
    run.copies[branch] = opened;
  }
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
  outputs?: Record<string, ReturnType<typeof resolvePath>>;
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

/** How long a run's `finally` steps may take, from when its steps end. */
const FINALLY_MS = 10 * 60_000;

/**
 * Holds a run whose steps ended, by any outcome, while its `finally` steps run: its status stays `running`, and what it
 * ended with waits in `finalizing` until they settle, by `until` at the latest. False when there is nothing to run: no
 * `finally`, or it already runs.
 */
function enterFinalizing(run: RunState, { outcome, end, failure }: WorkflowResult, now: string): boolean {
  const steps = run.definition.finally;

  if (!steps || run.finalizing) return false;
  const until = new Date(Date.parse(now) + FINALLY_MS).toISOString();
  const ending: Omit<Finalizing, 'since' | 'until'> = { outcome };

  if (end !== undefined) ending.end = end;

  if (failure) ending.failure = failure;
  run.finalizing = { ...ending, since: now, until };
  // A run a retry reopened ran them before; they run again.
  const own = new Set(steps.map((step) => step.id));
  run.steps = [...run.steps.filter((state) => !own.has(state.id)), ...steps.map((step): StepState => ({ id: step.id, status: 'pending' }))];

  return true;
}

/** Ends the run. Every path that settles a run goes through here, so anything that reacts to a settled run hooks in here. */
function settleRun(run: RunState, now: string, result: WorkflowResult): void {
  // A run that ran its `finally` steps ends as its steps did, whatever those did.
  const { outcome, end, failure } = run.finalizing ?? result;
  run.status = outcome;

  if (end !== undefined) run.end = end;

  if (failure) run.failure = failure;
  delete run.finalizing;
  run.updatedAt = now;
}

/** What `finishRun` did: started the run's `finally` steps, or settled it, with whether its end record was queued. */
export type Finished = { kind: 'finalizing' } | { kind: 'settled'; queued: boolean };

/**
 * Finishes a run whose steps ended, in one order: its `finally` steps run; then, once they settle, it settles and queues
 * its end record in the same locked operation.
 */
export async function finishRun(
  config: LocalConfig,
  run: RunState,
  now: string,
  result: WorkflowResult,
  secrets: Record<string, string>,
  driver?: DriverIdentity,
): Promise<Finished> {
  if (enterFinalizing(run, result, now)) return { kind: 'finalizing' };
  settleRun(run, now, result);

  // The first end only: a run a retry reopened has `limitsFrom`, and another install sweeps by what that end published.
  if (run.limitsFrom === undefined) {
    const retainedUntil = retentionEnds(now, await resolveRetention(config, await loadTeamConfig(config.repo.localPath)));

    if (retainedUntil !== undefined) run.retainedUntil = new Date(retainedUntil).toISOString();
  }

  await fs.rm(runScratchDir(config, run.id), { recursive: true, force: true });
  const queued = await queueRunRecord(config, run, driver, 'end', secrets);
  run.endRecordQueued = queued;

  return { kind: 'settled', queued };
}

/** The run fields a manual control operation answers with. */
export type RunData = Pick<RunState, 'id' | 'status' | 'revision' | 'end' | 'failure' | 'finalizing'>;

/** The run summary returned by manual control operations. */
export function runData(run: RunState): RunData {
  const data: RunData = { id: run.id, status: run.status, revision: run.revision };

  if (run.end !== undefined) data.end = run.end;

  if (run.failure) data.failure = run.failure;

  if (run.finalizing) data.finalizing = run.finalizing;

  return data;
}

/** The end `next` answers once the run has settled. */
type DoneData = {
  done: {
    run: string; outcome: RunStatus; end?: string; failure?: WorkflowFailure; prs?: string[]; outputs?: Record<string, JsonValue>; finally?: FinallyStopped[];
    progress?: StepProgress[];
  };
};

/** The progress lines a step's latest pass reported. */
type StepProgress = { step: string; lines: string[] };

function doneData(run: RunState): DoneData {
  const prs = (run.deliveries ?? []).map((receipt) => receipt.url);
  const outputs = runOutputs(run);
  const unfinished = finallyStopped(run);
  const done: DoneData['done'] = { run: run.id, outcome: run.status };

  if (run.end !== undefined) done.end = run.end;

  if (run.failure) done.failure = run.failure;

  if (prs.length > 0) done.prs = prs;

  if (outputs) done.outputs = outputs;

  if (unfinished.length > 0) done.finally = unfinished;
  const progress = run.steps.flatMap((step): StepProgress[] => ('progress' in step && step.progress ? [{ step: step.id, lines: step.progress }] : []));

  if (progress.length > 0) done.progress = progress;

  return { done };
}

/**
 * The values a settled run returns, read from its steps and its `finally` steps as they ended. One whose step did not
 * give it, such as a `finally` step that failed, is absent.
 */
function runOutputs(run: RunState): Record<string, JsonValue> | undefined {
  if (!run.definition.outputs) return undefined;
  const scope = finallyScope(run);
  const context = contextOf(scope, statesIn(run, scope));

  return Object.fromEntries(Object.entries(run.definition.outputs).flatMap(([name, source]): Array<[string, JsonValue]> => {
    const parsed = parseExpression(source);
    const value = parsed.ok && parsed.expression.kind === 'path' ? pathValue(parsed.expression.path, context) : undefined;

    return value === undefined ? [] : [[name, value]];
  }));
}

/** A `finally` step that failed or was cancelled, with why. */
type FinallyStopped = { id: string; outcome: 'failed' | 'cancelled'; failure?: WorkflowFailure };

/** The `finally` steps that failed or were cancelled, with why. */
function finallyStopped(run: RunState): FinallyStopped[] {
  const own = new Set(run.definition.finally?.map((step) => step.id));

  return run.steps.flatMap((state): FinallyStopped[] => {
    if (!own.has(state.id) || (state.status !== 'failed' && state.status !== 'cancelled')) return [];
    const entry: FinallyStopped = { id: state.id, outcome: state.status };

    if (state.failure) entry.failure = state.failure;

    return [entry];
  });
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
  const child = stepWorkflow(step);

  if (child?.kind === 'inline') {
    const own = new Set(child.workflow.steps.map((childStep) => childStep.id));

    for (const inner of child.workflow.steps) for (const id of readsOf(inner, bindsItem)) if (!own.has(id)) ids.add(id);
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

  const parsedReads: RunReads = { conditions, whiles, breaks, items, reads, waits, outputs };

  if (loopWhile) parsedReads.loopWhile = loopWhile;

  return parsedReads;
}

/** How a settled step that stops what comes after it ended, as a skip message says it. */
function endedAs(step: StepState): string {
  return step.status === 'skipped' ? 'was skipped' : step.status === 'cancelled' ? 'was cancelled' : 'failed';
}

/**
 * Marks every pending step of a workflow that can no longer run as `skipped`, until nothing changes:
 * a stopped need its `if` does not read, all needs skipped, or a ready step whose `if` is false, each with that reason. A step that waits for
 * a loop is neither skipped nor ready until that loop is settled. A ready `deliver: publish` step of an isolated run is skipped too, so no
 * driver needs the team workspace for what the run keeps off the team's data anyway.
 * Returns whether a step is ready: everything it needs and everything its `if` and templates read has settled.
 */
function skipUnreachable(run: RunState, scope: Scope, states: StepState[], { conditions, reads, waits }: RunReads): (step: StepState) => boolean {
  const byId = new Map(states.map((step) => [localId(scope, step), step]));
  const declared = new Map(scope.definition.steps.map((step) => [step.id, step.needs ?? []]));
  const publishes = new Set(isIsolated(run) ? scope.definition.steps.filter((step) => step.deliver === 'publish').map((step) => step.id) : []);
  const needs = (step: StepState): Array<StepState | undefined> => (declared.get(localId(scope, step)) ?? []).map((id) => byId.get(id));
  const waiting = (step: StepState): boolean => (waits.get(localId(scope, step)) ?? []).some((owner) => !loopSettled(byId.get(owner)));

  const ready = (step: StepState): boolean => !waiting(step) && needs(step).every(settled)
    && [...reads.get(localId(scope, step)) ?? []].every((id) => settled(byId.get(id)));

  const ifOf = new Map(scope.definition.steps.map((step) => [step.id, step.if]));

  const skipReason = (step: StepState): string | undefined => {
    const id = localId(scope, step);
    const condition = conditions.get(id);
    const read = stepsRead(condition ? expressionPaths(condition) : []);
    const stepNeeds = needs(step);
    const stoppedNeed = stepNeeds.find((need) => need && stopped(need) && !read.has(localId(scope, need)));

    if (stoppedNeed) return `Step "${step.id}" was skipped: it needs "${stoppedNeed.id}", which ${endedAs(stoppedNeed)}.`;
    const skippedNeeds = stepNeeds.filter((need) => need?.status === 'skipped');

    if (stepNeeds.length > 0 && skippedNeeds.length === stepNeeds.length) {
      return `Step "${step.id}" was skipped: every step it needs was skipped: ${skippedNeeds.map((need) => `"${need?.id}"`).join(', ')}.`;
    }

    if (!ready(step)) return undefined;

    if (condition && !isTruthy(evaluateExpression(condition, contextOf(scope, states, step)))) return `Step "${step.id}" was skipped: its if is false: ${ifOf.get(id)}`;

    return publishes.has(id) ? `Step "${step.id}" was skipped: this run is isolated, so it publishes nothing to a data branch.` : undefined;
  };

  for (let changed = true; changed;) {
    changed = false;

    for (const step of states) {
      if (step.status !== 'pending' || waiting(step)) continue;
      const reason = skipReason(step);

      if (reason === undefined) continue;
      skip(step, run.revision, reason);
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
  let inputs: Scope['inputs'];

  if ('name' in child.definition) {
    const rendered = renderStrings(step.with ?? {}, contextOf(scope, states, state));

    if (!rendered.ok) return withTemplateFailure(state, rendered.error);
    const given = withInputDefaults(child.definition, rendered.value);
    const mismatch = inputsMismatch(child.definition.name, child.definition.inputs, given ?? rendered.value);

    if (mismatch) return { code: 'invalid_inputs', message: `step "${state.id}" with does not fit workflow "${child.definition.name}": ${mismatch}` };
    const unfit = itemLimitMismatch(child.definition.steps, given);

    if (unfit) return { code: 'invalid_inputs', message: `step "${state.id}" with does not fit workflow "${child.definition.name}": ${unfit}` };

    // inputsMismatch has checked that the rendered value is an object.
    if (child.definition.inputs && given) {
      inputs = given;
      child.inputs = inputs;
    }
  }

  start(state, inputs, startLimits(run, state, step, now));

  const steps = child.definition.steps.map((childStepDef): StepState => {
    const id = `${child.prefix}${childStepDef.id}`;
    const pass = firstPass(run, id);

    const pending: StepState = { id, status: 'pending' };

    if (pass > 1) pending.pass = pass;

    return pending;
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
  const settlement: Parameters<typeof succeed>[1] = { settledAt: result.settledAt };

  if (result.end !== undefined) settlement.end = result.end;

  if (result.outputs !== undefined) settlement.outputs = result.outputs;

  if (result.results) settlement.results = result.results;

  if (result.outcome !== 'succeeded') {
    const failed: Parameters<typeof fail>[1] = { ...settlement };

    if (result.failure) {
      failed.message = result.failure.message;
      failed.failure = result.failure;
    }

    fail(state, failed);

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
    ?? { unreadable: `Run ${run.id} step "${state.id}" runs workflow ${JSON.stringify(definition.workflow)}, which the run did not keep` };
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
 * The items `path` runs under that run beside the other items of their step, outermost first: each `<step>[<n>]` on
 * the way whose `for_each` declares `max_parallel`.
 */
function parallelItems(run: RunState, path: string): string[] {
  const segments = parseStepPath(path);

  return segments.flatMap((segment, index) => {
    if (segment.index === undefined) return [];
    const at = segments.slice(0, index + 1).map((part) => (part.index === undefined ? part.id : `${part.id}[${part.index}]`));
    const fanOut = [...at.slice(0, -1), segment.id].join('.');

    return locateStep(run, fanOut)?.step.forEach?.maxParallel === undefined ? [] : [at.join('.')];
  });
}

/**
 * Whether the step at `path` may run while the one at `other` does, for a driver that runs one step at a time: only
 * when they run under two items of one `for_each` that declares `max_parallel`, which bounds how many start.
 */
function runsBeside(run: RunState, path: string, other: string): boolean {
  const mine = parallelItems(run, path);
  const theirs = parallelItems(run, other);
  const split = mine.findIndex((item, index) => item !== theirs[index]);
  const fanOut = (item: string | undefined): string | undefined => item?.replace(/\[\d+\]$/u, '');

  return split !== -1 && theirs[split] !== undefined && fanOut(mine[split]) === fanOut(theirs[split]);
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

  // A start checks the template against its inputs, so only a changed run file fails here.
  const limited = itemLimit(definition, scope.inputs);

  if (!limited.ok) {
    const failure = { code: 'invalid_inputs', message: limited.message };
    stopWhere(run, isUnder(state.id), failure, run.revision, now);

    return { outcome: 'failed', failure, settledAt: run.revision };
  }

  const maxParallel = limited.limit;

  for (;;) {
    const items = itemsOf(run, state);
    const after = itemsAfter(state.id, items.map((item) => item.item));

    if (!Array.isArray(after)) return { unreadable: `Run ${run.id} ${after.message}` };
    const dependencies = (index: number): StepState[] => after[index]?.map((other) => items[other]!) ?? [];
    const standing = (index: number): ReturnType<typeof afterStanding> => afterStanding(dependencies(index));
    const dependents: number[][] = items.map(() => []);
    after.forEach((others, index) => others.forEach((other) => dependents[other]!.push(index)));
    let started = startedItems(items);
    let changed = false;
    const ready: Ready[] = [];

    for (const [index, item] of items.entries()) {
      if (item.status === 'pending' && standing(index) === 'skip') {
        // A skip makes the items after it skippable wherever they are in item order, so it reaches them all now.
        const skippable = [index];

        for (const next of skippable) {
          if (items[next]!.status !== 'pending' || standing(next) !== 'skip') continue;
          const before = dependencies(next).find((other) => stopped(other) || other.status === 'skipped');
          skip(items[next]!, run.revision, `Step "${items[next]!.id}" was skipped: it runs after ${before ? `"${before.id}", which ${endedAs(before)}` : 'an item that did not succeed'}.`);
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
function workflowOutputs(scope: Scope, states: StepState[], paths: Map<string, ExpressionPath>): WorkflowResult['outputs'] {
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

  if (isMessage(reads)) return { unreadable: reads };
  // A workflow that spent more than its budget stops what it still runs and fails: the run, or the step that runs it, so a step
  // around it that reads its outcome can recover.
  const spent = scope.budget === undefined ? 0 : budgetSpent(run, scope);

  if (scope.budget !== undefined && spent > scope.budget) {
    const failure = { code: 'budget_exceeded', message: `${workflowLabel(scope)} spent ${spent} of its ${scope.budget}-token budget` };
    stopWhere(run, (id) => id.startsWith(scope.prefix), failure, run.revision, now);

    return { outcome: 'failed', failure, settledAt: run.revision };
  }

  // A workflow step whose allowance is spent starts nothing more: what is still pending under it is skipped, and what
  // runs finishes its turn.
  for (const owner of spentAllowances(run, scope)) {
    for (const state of run.steps) {
      if (state.status === 'pending' && isUnder(owner)(state.id)) skip(state, run.revision, `Step "${state.id}" was skipped: step "${owner}" spent the timeout or budget it gives the steps under it.`);
    }
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

          if (!isMessage(message)) failStep(state, message, run.revision);
          else waitForAnswer(state);
          changed = true;
          break;
        }

        if (definition.hitl.kind === 'approve' && state.answer.choice === 'no') {
          skip(state, run.revision, `Step "${state.id}" was skipped: its approval was answered no.`);
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

        // Starting a step changes no other step's standing, so the scan goes on. Settling one can make an earlier step
        // ready, so the scan starts over.
        if (state.status === 'running') {
          changed = true;
          continue;
        }
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
        outcome: states.some((state) => stopped(state) && !definitionOf(state)?.continueOnFailure) ? 'failed' : 'succeeded',
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
  return expire(run, now) ?? settleScope(run, run.finalizing ? finallyScope(run) : topScope(run), now);
}

/**
 * `inputs` with the default of each input they leave out, from `definition.defaults.inputs`; undefined when they are
 * not an object, which `inputsMismatch` refuses.
 */
// oxlint-disable-next-line teamai/no-unknown-parameters -- fills inputs nothing has read yet: a start payload's, or what a step's `with` rendered to
function withInputDefaults(definition: Pick<WorkflowDefinition, 'defaults'>, inputs: unknown): RunState['inputs'] {
  return isRecord(inputs) ? { ...definition.defaults?.inputs, ...inputs } : undefined;
}

/** Why `inputs` do not fit what the workflow declares, naming the field, or null when they fit. Every declared input is required; fill defaults first. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- validates inputs nothing has read yet: a start payload's, or what a step's `with` rendered to
function inputsMismatch(name: string, declared: Record<string, OutputSchema> | undefined, inputs: unknown): string | null {
  if (!isRecord(inputs)) return 'inputs must be a JSON object';
  const mismatch = outputMismatch({ type: 'object', fields: declared ?? {} }, inputs, 'inputs');

  if (mismatch) return mismatch;
  // The shorthand allows extra object keys, so an undeclared input is checked here.
  const extra = Object.keys(inputs).find((key) => !declared || !Object.hasOwn(declared, key));

  return extra === undefined ? null : `inputs.${extra} is not an input workflow "${name}" declares`;
}

/**
 * Why the run file would not keep what `start` was given: masking would change an input that holds a secret value
 * without a word. Names the input and the secret, never the value. An input may share a name with an env key; only
 * values count. Admission checked the pinned definitions.
 */
function secretMismatch(inputs: RunState['inputs'], secrets: Record<string, string>): string | null {
  for (const [input, value] of Object.entries(inputs ?? {})) {
    const held = heldSecret(value, secrets);
    const secret = held && secretKey(held);

    if (secret) return `inputs.${input} holds the value of ${secret}, a secret on this machine, which a run never stores. Pass the step a way to read ${secret} instead, such as requires.env: [${secret}].`;
  }

  return null;
}

/**
 * Creates a run. `inputs` are checked against the declared inputs before the run file exists. `secrets` are what the
 * caller resolved for the operation.
 */
export async function startRun(
  config: LocalConfig,
  name: string,
  // oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: start's inputs as the CLI or a driver sent them, checked here first
  inputs: unknown,
  { secrets, ...options }: { secrets: Record<string, string>; runMode?: RunMode; startedBy?: StartedBy; awaits?: RunState['awaits']; driver?: DriverIdentity; base?: RunState['base']; checkout?: string; timeout?: number; alone?: DriverCan },
): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);

  if (!cached) {
    const conflict = await namespaceConflictOf(config, name);

    if (conflict) return error('workflow_namespace_conflict', conflict);

    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }

  const given = withInputDefaults(cached.definition, inputs);
  const mismatch = inputsMismatch(cached.definition.name, cached.definition.inputs, given ?? inputs);

  if (mismatch) return error('invalid_inputs', mismatch);
  const tree = await loadWorkflowTree(config, cached);

  // oxlint-disable-next-line teamai/workflow-failure-codes -- forwards a code from a classified workflow or scorer producer
  if ('failed' in tree) return error(tree.failed.code, tree.failed.message);
  const admission = await admitWorkflow(config, { kind: 'cached', definition: cached.definition, workflows: tree.workflows }, { secrets, base: options.base });

  // oxlint-disable-next-line teamai/workflow-failure-codes -- forwards a code from a classified workflow or scorer producer
  if ('failure' in admission) return error(admission.failure.code, admission.failure.message);

  // createRun reads an undefined inputs or teamRevision as not given.
  return createRun(config, {
    name: cached.definition.name,
    inputs: cached.definition.inputs ? given : undefined,
    sourceHash: tree.sourceHash,
    teamRevision: tree.teamRevision || undefined,
    origin: DefaultWorkflows.originOf(cached),
    ...admission.admitted,
    secrets,
    ...options,
  });
}

/**
 * Creates a run of a definition the caller already built and checked. The run file is written only when it would keep
 * what it was given unmasked. `secrets` are what the caller resolved for the operation. `alone`: what the run's only
 * driver, the local one, gives strict requirements; a start with a step it could never take for them is refused.
 * `driver`: the run's driver from its start, so that driver's first `next` takes it as its own.
 */
export async function createRun(
  config: LocalConfig,
  { secrets, driver, alone, ...input }: Pick<RunState, 'name' | 'inputs' | 'sourceHash' | 'teamRevision' | 'runMode' | 'startedBy' | 'awaits' | 'definition' | 'workflows' | 'base' | 'checkout' | 'timeout'>
    & Required<Pick<RunState, 'origin'>> & { secrets: Record<string, string>; driver?: DriverIdentity; alone?: DriverCan },
): Promise<WorkflowEnvelope> {
  const workflows = input.workflows ?? {};
  const unmet = alone && strictlyUnmet(input.definition, workflows, alone);

  if (unmet) return error('requirement_unmet', unmet);
  const holdsSecret = secretMismatch(input.inputs, secrets);

  if (holdsSecret) return error('invalid_inputs', holdsSecret);
  const unfit = itemLimitMismatch(input.definition.steps, input.inputs);

  if (unfit) return error('invalid_inputs', unfit);
  const now = new Date().toISOString();
  const alias = await startingAlias(config, input.definition);
  const team = await TeamPin.capture(config);

  // A field the run does not have stays undefined: the run file is JSON, which leaves it out, so the file keeps its key
  // order, and every reader of the run treats undefined as absent.
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: generateRunId(),
    name: input.definition.name,
    alias,
    revision: 1,
    status: 'running',
    inputs: input.inputs,
    sourceHash: input.sourceHash,
    teamRevision: input.teamRevision || undefined,
    teamPin: team?.pin,
    runMode: input.runMode,
    origin: input.origin,
    startedBy: input.startedBy,
    awaits: input.awaits,
    driver,
    definition: input.definition,
    workflows: Object.keys(workflows).length > 0 ? workflows : undefined,
    steps: input.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    base: input.base,
    checkout: input.checkout || undefined,
    timeout: input.timeout,
    createdAt: now,
    updatedAt: now,
  };

  if (team?.patch !== undefined) await TeamPin.keepPatch(config, run.id, team.patch);
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
  const record = await queueRunRecord(config, run, driver, 'start', secrets) ? await publishRunRecords(config) : undefined;
  const started: EnvelopeData = { run: run.id, name: run.name, status: run.status, revision: run.revision };

  if (record) started.record = record;

  return ok(started);
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
  prepare: boolean;
  /** The env keys any step of the run requires, read once per request rather than once per offered step. */
  runEnvKeys: Set<string>;
}

/** Terms a driver was granted, with the team role the lease carries: absent without one. */
type GrantedTerms = Terms & { role?: string };

/** What `offerTerms` decides: `negotiate`'s answer, whose grant carries the role the lease names. */
type OfferedTerms = Exclude<Negotiation, { kind: 'grant' }> | { kind: 'grant'; terms: GrantedTerms };

/**
 * What the driver asking for step instance `id` is offered. Both places that hand out a lease ask here. Setup comes with
 * every lease on a copy, and the driver runs it when it creates the copy or the copy's setup never finished.
 */
function offerTerms(
  run: RunState, id: string, { scope, step }: { scope: Scope; step: WorkflowStep }, plan: WorkspacePlan | undefined, context: OfferContext,
): OfferedTerms {
  const stepRole = stepRoleOf(run, id);
  let role: Pick<GrantedTerms, 'role'>;

  switch (stepRole.kind) {
    case 'role':
      role = { role: stepRole.role };
      break;
    case 'none':
      role = {};
      break;
    case 'unrenderable':
      return { kind: 'fail', failure: stepRole.failure };
    default: {
      const unhandled: never = stepRole;

      return unhandled;
    }
  }

  const endTurn = turnLimits(run, scope, step);

  const negotiation = negotiate({
    step: id,
    executor: step.command !== undefined ? 'command' : 'prompt',
    requires: mergeRequirements(scope.requires, step.requires),
    interactive: step.interactive === true,
    hasContract: plan?.contract !== undefined,
    envKeys: Object.keys(step.env ?? {}),
    runEnvKeys: context.runEnvKeys,
    budgeted: step.prompt !== undefined && scope.budgeted,
    // negotiate reads an undefined maxTurns, endTurn, setup or tool as not set. Setup prepares a copy of the run's
    // repository, never the team repo.
    maxTurns: step.maxTurns,
    endTurn,
    setup: plan?.contract && plan.contract.mode !== 'team' ? scope.setup : undefined,
    tool: step.tool,
    unattended: step.permissions === 'unattended',
    clone: contractClone(plan?.contract) !== undefined,
    prepare: context.prepare,
    ...role,
  }, context.can, context.allow, context.facts);

  return negotiation.kind === 'grant' ? { kind: 'grant', terms: { ...negotiation.terms, ...role } } : negotiation;
}

/**
 * The turn limits granted in `terms`, and the deadline of a lease issued at `since`, its `leasedAt`. The step's own timeout
 * counts from `since`, so a hand-back never extends it; only a call that lists the attempt `queued` moves it. A driver
 * that cannot end the turn gets the `on_limit: fail` lease, whose own timeout is its deadline. One that can gets what is left of it at `now`; with none left, the lease takes the
 * deadline it passed, so `expire` times it out.
 */
function turnTerms(
  run: RunState, state: StepState, definition: WorkflowStep, { limits }: Pick<Terms, 'limits'>, since: string, now: string,
): Pick<StepLease, 'expiresAt' | 'limits'> {
  const own = ownDeadline(run, state, { ...definition, onLimit: 'fail' }, since);

  if (!limits || definition.onLimit !== 'end_turn') return leaseTerms(own, limits);

  if (own === undefined) return { limits };
  const left = Date.parse(own) - Date.parse(now);

  return left > 0 ? { limits: { ...limits, timeoutMs: Math.min(limits.timeoutMs ?? left, left) } } : { expiresAt: own, limits };
}

/** Restarts the own timeout of each open lease of `driver` whose attempt `queued` lists, before anything reconciles the run. */
export function restartQueued(run: RunState, driver: DriverIdentity, queued: ReadonlySet<string>, now: string): void {
  for (const step of run.steps) {
    if (step.status === 'leased' && sameDriver(step.lease.driver, driver) && queued.has(step.lease.attempt)) restartClock(step.lease, now);
  }
}

/** Moves the start of `held`'s own timeout to `now`, and its deadline with it. A lease issued before teamai recorded when keeps its deadline. */
function restartClock(held: StepLease, now: string): void {
  if (held.leasedAt === undefined) return;
  const waited = Math.max(0, Date.parse(now) - Date.parse(held.leasedAt));

  if (held.expiresAt !== undefined) held.expiresAt = new Date(Date.parse(held.expiresAt) + waited).toISOString();
  held.leasedAt = now;
}

/** A lease's deadline and turn limits, each left out when it has none. */
function leaseTerms(expiresAt: string | undefined, limits: TurnLimits | undefined): Pick<StepLease, 'expiresAt' | 'limits'> {
  const terms: Pick<StepLease, 'expiresAt' | 'limits'> = {};

  if (expiresAt !== undefined) terms.expiresAt = expiresAt;

  if (limits) terms.limits = limits;

  return terms;
}

/**
 * Why the local driver, which gives strict requirements `can`, could never take a step of `definition`, as describe
 * holds it: the first step it lacks a strict `isolation` or `network` for.
 */
function strictlyUnmet(definition: WorkflowDefinition, workflows: Record<string, WorkflowDefinition>, can: DriverCan): string | undefined {
  const none = new Set<string>();
  const { facts } = describeWorkflow({ definition, source: 'team', workflows, ceiling: 1, can, allow: {}, env: { declared: none, secrets: none, present: none } });

  for (const { step, missing } of facts.held) {
    if (missing.includes('isolation')) {
      return `Step "${step}" requires strict isolation, and the local driver here is not a sandbox. Run it in CI or a container, and declare it with --sandbox or workflows.sandbox: true.`;
    }

    if (missing.includes('network')) return `Step "${step}" strictly requires no network, which the local driver cannot deny. Run it with a driver that declares can.network.`;
  }

  return undefined;
}

/** What `can` gets of step `state` confined to the directory `rendered` names; undefined for a step not confined. */
async function confinedFor(
  config: LocalConfig, run: RunState, state: StepState, definition: WorkflowStep, rendered: RenderedLease, can: DriverCan,
): Promise<ConfinedDecision | undefined> {
  if (rendered.confined === undefined) return undefined;
  // An empty model asks for the tool's default, as `leaseData` leaves it out.
  const model = definition.model instanceof Object ? definition.model : rendered.model || undefined;

  return decideConfined({
    step: state.id, dir: rendered.confined, runDir: runScratchDir(config, run.id), offers: can.confined ?? [], model, defaultModel: rendered.defaultModel, config,
  });
}

/** Why a step that names `tool` fails in a run whose only driver cannot launch it. */
function toolUnavailable(step: string, tool: string): WorkflowFailure {
  return { code: 'tool_unavailable', message: `Step "${step}" runs on ${tool}, which the driver of this run cannot launch here. Install ${tool} where the run is driven, or remove tool from the step.` };
}

/** Why a step with `permissions: unattended` fails in a run whose only driver cannot run it unattended. */
function unattendedUnavailable(step: string, tool: string | undefined): WorkflowFailure {
  const on = tool === undefined ? '' : ` on ${tool}`;

  return { code: 'tool_unavailable', message: `Step "${step}" sets permissions: unattended${on}, which the driver of this run cannot run unattended. Run it with a driver that declares can.unattended, or remove permissions from the step.` };
}

/** Why `next` has no lease to hand out yet, and the steps still delivering. */
type WaitData = { reason: string; delivering?: string[]; held?: Held[] };

/** What a driver tells `next` besides who it is. */
export interface NextOptions {
  /**
   * The attempts of its open leases the driver is still running. An open lease it does not list is handed back to it.
   */
  running?: string[];
  /**
   * The attempts in `running` the driver holds but has not started, such as one waiting for its checkout. The step's own
   * timeout of each counts from this call, so waiting does not use it up.
   */
  queued?: string[];
  /** False to reconcile without issuing a new lease: `next` answers `done`, an unlisted lease, `hitl`, or `wait`. */
  canTakeLease?: boolean;
  /** The checkout the run's workspaces start from. It fixes the run's base only when `workflow start` recorded none. */
  base?: { ref?: string; commit: string };
  /** What the driver can do on this request. An omitted `workspace` means read-only, so a `new` or `continue` step waits. */
  can?: DriverCan;
  /**
   * Answer optional approvals `yes` and choices with a default by it, recorded `auto_approve`. For a driver without HITL
   * it overrides `workflows.auto_approve`; a driver with HITL sends it when the person chose auto-approve for the run.
   * Required approvals, and choices without a default, are never answered this way.
   */
  autoApprove?: boolean;
  /** Take the run over from the install that published it before leasing; a run this install owns stays as it is. */
  claim?: boolean;
  /** The run mode the driver runs its leases in, the one it exports to their processes. A lease issued or handed back keeps it. */
  runMode?: RunMode;
  /**
   * Process-only: how a driver without HITL hands a run that reaches a step only a person can take to one, as the local
   * driver does when nobody answers at its terminal. Absent, such a step fails `hitl_required`.
   */
  handoff?: PersonHandoff;
  /** Process-only: the team env the caller resolved for this operation, so `next` does not resolve it again. */
  env?: WorkflowEnv;
  /**
   * Process-only: teamai prepares the lease's place, through `next --prepare` or the local driver. Without it a step in a
   * clone is held.
   */
  prepare?: boolean;
  /**
   * Process-only: the caller is the run's only driver, as the local driver is. A step that names a tool it cannot launch
   * fails `tool_unavailable` at once. For any other driver it stays pending.
   */
  alone?: boolean;
  /**
   * Process-only: the driver runs one lease at a time, except the items of a `for_each` that declares `max_parallel`,
   * which it runs beside each other up to that limit, as the local driver does when `workflows.max_parallel` is unset.
   * `next` then leases a step beside the open leases only where `runsBeside` allows.
   */
  isOneAtATime?: boolean;
}

/**
 * The gate before a pull request is opened: with what reports and controls left pending applied, whether the step still
 * delivers `job`, the branch's recorded commit is still the one `job` checked, and no step that writes the branch is
 * leased. If so, the run lists its request in the same write, so one opened by a process that then stops is looked up,
 * whatever becomes of the step, rather than lost.
 */
async function markCreating(config: LocalConfig, runId: string, secrets: Record<string, string>, job: DeliveryJob, settle: Settle): Promise<'open' | 'refused' | 'busy'> {
  const marked = await updateRun(config, runId, secrets, async (run): Promise<{ value: 'open' | 'refused' | 'busy'; write?: RunState }> => {
    if (run === 'missing' || run.status !== 'running') return { value: 'refused' };
    const now = new Date().toISOString();
    const settledRun = settle(run, now);
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

/** How a call reconciles the run at `now`: `reconcileRun`, after what the call itself applies first. */
type Settle = (run: RunState, now: string) => Settled;

/**
 * Delivers the run's delivering steps one at a time, before `next` answers, whichever driver called it, then looks up
 * each request in `run.creating` once, on an ended run too. The run lock is held to pick a delivery and to apply its
 * outcome, never across git or a provider. While another process of this machine delivers, it holds the delivery lock,
 * and this call leaves the work to it. Each pick and outcome reconciles the run through `settle`.
 */
async function drainDeliveries(config: LocalConfig, runId: string, secrets: Record<string, string>, settle: Settle): Promise<void> {
  if (!isRunId(runId)) return;
  const loaded = await readRun(config, runId);

  if (loaded === 'missing' || loaded === 'corrupt') return;
  const delivering = loaded.status === 'running' && loaded.steps.some((step) => step.status === 'delivering');

  // A team branch is delivered from the member's team clone, into the branch its origin defaults to.
  const team = Object.values(loaded.copies ?? {}).some((copy) => copy.kind === 'team')
    ? { checkout: config.repo.localPath, target: await getDefaultBranch(config.repo.localPath) }
    : undefined;

  if (!delivering && !unresolvedCreate(loaded, [], team)) return;

  const drained = await withFileLock(deliveryLockPath(config, runId), { attempts: 1, delayMs: 0 }, async () => {
    let requeued = false;
    const tried: Array<Omit<UnresolvedCreate, 'lookups'>> = [];
    const waiting: DeliveryKey[] = [];

    for (;;) {
      const picked = await updateRun(config, runId, secrets, async (run) => {
        if (run === 'missing') return { value: undefined };
        const before = JSON.stringify(run);
        const now = new Date().toISOString();
        const job = nextDelivery(run, (item) => settle(item, now), branchWriterLeased, waiting, team);
        const value = job ? { job } : unresolvedCreate(run, tried, team);

        return { value, write: JSON.stringify(run) !== before ? { ...run, updatedAt: now } : undefined };
      });

      if (picked.status !== 'done' || !picked.value) return requeued;
      let apply: (run: RunState, now: string) => { requeueEnd: boolean };

      if ('job' in picked.value) {
        const { job } = picked.value;
        tried.push({ ...job.key, target: job.target });
        // A team branch is delivered from the member's team repo, which teamai pull and push update under this lock.
        const syncLock = job.checkout === team?.checkout ? join(getDataHome(config), SYNC_LOCK_FILENAME) : undefined;

        if (syncLock !== undefined && !await acquireLock(syncLock)) return requeued;
        let outcome: Awaited<ReturnType<typeof deliverPr>>;

        try {
          outcome = await deliverPr(job, () => markCreating(config, runId, secrets, job, settle));
        } finally {
          if (syncLock !== undefined) await releaseLock(syncLock);
        }

        // As when the pick is busy: the step still delivers, and a later call checks and delivers it.
        if (outcome === 'busy') return requeued;

        if (!outcome.ok && outcome.fault.kind === 'branch_ahead') waiting.push(job.key);
        apply = (run, now) => completeDelivery(run, job, outcome, (item) => settle(item, now), branchWriterLeased);
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

        return { value: requeueEnd, write: JSON.stringify(run) !== before ? { ...run, updatedAt: now } : undefined };
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
    // As a resume does, before anything is leased: the branches of a run taken back go to the commits it recorded.
    const unreconciled = await reconcileTakenCopies(config, runId, driver.workspace);

    if (unreconciled) return { error: unreconciled };
  } else {
    // A run another install claimed moved on there, so this machine's copy of it leases nothing.
    const elsewhere = await claimedAway(config, runId);

    if (elsewhere) return { error: elsewhere };
  }

  // Resolved once, so the env this `next` offers against and the secrets its writes, deliveries' included, mask agree.
  const env = options.env ?? await resolveWorkflowEnv(config);
  const running = new Set(options.running);
  const unstarted = new Set((options.queued ?? []).filter((attempt) => running.has(attempt)));

  // Every reconcile of this call, a delivery's too, first restarts the clocks of the leases the driver lists queued.
  const settle: Settle = (run, now) => {
    restartQueued(run, driver, unstarted, now);

    return reconcileRun(run, now);
  };

  await drainDeliveries(config, runId, env.secrets, settle);
  const can = options.can ?? {};
  const maxParallel = config.workflows?.max_parallel;
  // The end record is queued under the run lock, so the run stores whether it
  // was in the same save. It publishes AFTER withRun releases the lock (#1126
  // P3): publication does a reports-branch push, and no network I/O may hold
  // the lock other engine operations wait on.
  let queued = false;
  let alreadySettled: RunState | undefined;

  const envelope = await withRun(config, runId, env.secrets, async (run, now) => {
    const before = JSON.stringify(run);

    const context: OfferContext = {
      // The HITL of a driver nobody attends is its agent's, which works in no interactive step: only a person does.
      can: can.hitl === true && options.handoff !== undefined ? { ...can, hitl: false } : can, allow: config.workflows?.allow ?? {}, facts: env.facts, prepare: options.prepare === true,
      // Admitted workflows too: their own steps' keys are withheld from the steps that do not require them.
      runEnvKeys: requiredEnvKeys([run.definition, ...Object.values(run.workflows ?? {}), ...Object.values(run.admitted ?? {}).map(({ definition }) => definition)]),
    };

    // Whatever settling changed is saved. `cancelled` is derived after settling: the attempts the driver runs that
    // are no longer its open leases. `deadlines` gives each queued attempt still open the deadline its restarted clock gives it.
    const answer = (data: EnvelopeData): RunOperation => {
      const open = run.steps.filter((step): step is LeasedStep => step.status === 'leased' && sameDriver(step.lease.driver, driver));

      const deadlines = Object.fromEntries(open.flatMap((step) => {
        const deadline = unstarted.has(step.lease.attempt) ? leaseDeadline(run, step) : undefined;

        return deadline === undefined ? [] : [[step.lease.attempt, deadline]];
      }));

      const replied: EnvelopeData = { ...data, cancelled: [...running].filter((attempt) => !open.some((step) => step.lease.attempt === attempt)) };

      if (Object.keys(deadlines).length > 0) replied.deadlines = deadlines;

      return { save: JSON.stringify(run) !== before, envelope: ok(replied) };
    };

    // Undefined once the run's `finally` steps start, so the loop hands them out.
    const done = async (result: WorkflowResult): Promise<{ save: boolean; envelope: WorkflowEnvelope } | undefined> => {
      const finished = await finishRun(config, run, now, result, env.secrets, driver);

      if (finished.kind === 'finalizing') return undefined;
      queued = finished.queued;

      return answer(doneData(run));
    };

    const wait = (open = run.steps.find((step) => step.status === 'leased'), people: Held[] = []): { save: boolean; envelope: WorkflowEnvelope } => {
      // Steps still delivering here are being delivered by another process of this machine, waited for a busy run
      // lock, or wait for a report: of the commit their branch is ahead at on origin, or of a leased step that writes
      // their branch. A driver polls until they settle.
      const delivering = run.steps.filter((step) => step.status === 'delivering').map((step) => step.id);

      const reason = open ? `${open.id} is leased` : delivering.length > 0 ? `${delivering[0]} is delivering`
        : people.length > 0 ? people.map((item) => item.reason).join('; ') : 'canTakeLease is false';

      const waiting: WaitData = { reason };

      if (delivering.length > 0) waiting.delivering = delivering;

      if (people.length > 0) waiting.held = people;

      return answer({ wait: waiting });
    };

    if (run.status !== 'running') {
      // Settled by an earlier next, which queued the end record unless usage
      // reporting was off; the done envelope reports that record's state.
      alreadySettled = run;

      return answer(doneData(run));
    }

    const older = missingNeeds(run);

    if (older) return { save: false, envelope: error('run_unreadable', older) };
    // Made before any step it leases runs; a run a retry reopened gets it again.
    await fs.mkdir(runScratchDir(config, run.id), { recursive: true });
    const { handoff } = options;
    const isAutoApproved = options.autoApprove ?? config.workflows?.auto_approve === true;
    // What a driver nobody attends that offers the run to a person is told it waits for: the answers only a person gives.
    // An agent's HITL answers every other gate, as auto-approve would.
    const personHolds = (): Held[] => (handoff?.kind === 'offers' ? waitingForPerson(run, { autoApprove: can.hitl === true || isAutoApproved }) : []);
    const byAgent = can.hitl === true && handoff !== undefined;

    for (;;) {
      // Ends reached through reports, and deadlines passed, apply before an open lease is handed back, so a restarted
      // driver does not run again what they already stopped, and a lease past its timeout no longer holds the run.
      const result = settle(run, now);

      if ('unreadable' in result) return { save: false, envelope: error('run_unreadable', result.unreadable) };

      if ('outcome' in result) {
        const ended = await done(result);

        if (ended) return ended;
        continue;
      }

      const other = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !sameDriver(step.lease.driver, driver));

      if (other) return wait(other);
      run.driver = driver;

      // A driver with HITL answers optional gates itself unless the person chose auto-approve for this run; it never
      // follows workflows.auto_approve.
      if (can.hitl && options.autoApprove === true && answerOptionalGates(run, now)) continue;

      if (options.canTakeLease !== false && !can.hitl && answerWithoutHitl(run, now, { autoApprove: isAutoApproved, handoff })) continue;

      if (options.canTakeLease !== false && byAgent && handoff?.kind === 'unoffered' && failForPerson(run, handoff.reason)) continue;
      // An open lease the driver does not list is handed back before another lease is issued, as a restarted driver expects.
      const leased = run.steps.find((step): step is LeasedStep => step.status === 'leased' && !running.has(step.lease.attempt));

      if (!leased) {
        if (options.canTakeLease === false || 'inProgress' in result) {
          const hitl = can.hitl ? waitingHitl(run, { byAgent }) : undefined;

          return hitl ? answer({ hitl }) : wait(undefined, personHolds());
        }

        const open = run.steps.filter((step) => step.status === 'leased').length;

        if (maxParallel !== undefined && open >= maxParallel) {
          return answer({ wait: { reason: `${open} steps are leased, as many as workflows.max_parallel allows on this machine` } });
        }

        // A step this driver must not take is held back, and the next ready one is tried. A failed or skipped step can
        // change what is ready, so the run settles again.
        const held: Held[] = [];
        let settledOne = false;
        const leasedSteps = run.steps.filter((step): step is LeasedStep => step.status === 'leased');
        let besideOpen: LeasedStep | undefined;

        for (const { lease: state, definition, rendered } of result.ready) {
          const blocking = options.isOneAtATime ? leasedSteps.find((leasedStep) => !runsBeside(run, state.id, leasedStep.id)) : undefined;

          // A step that may not run beside an open lease waits for it, as it would for a driver with no room.
          if (blocking) {
            besideOpen ??= blocking;
            continue;
          }

          const located = locateStep(run, state.id);

          if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${state.id}"`) };
          const spending = definition.prompt === undefined ? undefined : allowanceInUse(run, located.scope);

          if (spending !== undefined) {
            held.push({ step: state.id, reason: `step "${state.id}" waits for the prompt turn spending the allowance of step "${spending}"`, missing: [] });
            continue;
          }

          const plan = planWorkspace(run, located.scope, state, definition, {
            driver, modes: can.workspace, base: run.base ?? options.base,
          });

          if (plan.defer) {
            const stepRole = stepRoleOf(run, state.id);

            if (stepRole.kind === 'unrenderable') {
              failStep(state, stepRole.failure, run.revision);
              settledOne = true;
              break;
            }

            // A driver that cannot give the step its role is told so too, as it would be held for it once it had the place.
            const roleGap = stepRole.kind === 'role' && !can.role ? ['role' as const] : [];
            held.push({ step: state.id, reason: plan.defer.reason, missing: [...plan.defer.needs ? [`workspace.${plan.defer.needs}` as const] : [], ...roleGap] });
            continue;
          }

          if (plan.fail) {
            failStep(state, plan.fail, run.revision);
            settledOne = true;
            break;
          }

          const confined = await confinedFor(config, run, state, definition, rendered, can);

          if (confined?.kind === 'fail') {
            failStep(state, confined.failure, run.revision);
            settledOne = true;
            break;
          }

          if (confined?.kind === 'hold') {
            held.push(confined.held);
            continue;
          }

          const terms = offerTerms(run, state.id, located, plan, context);

          if (terms.kind === 'hold' && options.alone && definition.tool !== undefined && terms.missing.includes('tools')) {
            failStep(state, toolUnavailable(state.id, definition.tool), run.revision);
            settledOne = true;
            break;
          }

          if (terms.kind === 'hold' && handoff?.kind === 'unoffered' && terms.missing.includes('hitl')) {
            failStep(state, personRequired(run.id, state.id, handoff.reason), run.revision);
            settledOne = true;
            break;
          }

          if (terms.kind === 'hold' && options.alone && terms.missing.includes('unattended')) {
            failStep(state, unattendedUnavailable(state.id, definition.tool), run.revision);
            settledOne = true;
            break;
          }

          if (terms.kind === 'hold') {
            held.push(heldFor(state.id, terms.missing));
            continue;
          }

          if (terms.kind === 'fail') {
            failStep(state, terms.failure, run.revision);
            settledOne = true;
            break;
          }

          if (plan.contract && options.base && !run.base) run.base = options.base;
          const { unenforced } = terms.terms;

          const granted: StepLease = { attempt: `a${randomBytes(4).toString('hex')}`, revision: run.revision, driver, leasedAt: now };

          if (options.runMode) granted.runMode = options.runMode;

          if (unenforced.length > 0) granted.unenforced = unenforced;

          if (confined?.kind === 'grant') granted.confined = { level: confined.lease.level, tools: confined.lease.tools };
          const step = lease(state, offering({ ...granted, ...turnTerms(run, state, definition, terms.terms, now, now) }, plan.session));
          // A driver that takes a lease drives the run, whichever driver workflows.driver started it for.
          delete run.awaits;
          rememberCopy(run, plan, driver);

          return answer(leaseData(run, step, definition, rendered, terms.terms, plan, confined?.lease));
        }

        if (settledOne) continue;

        if (besideOpen && held.length === 0) return wait(besideOpen);
        const holds = [...held, ...personHolds()];

        return answer({ wait: { reason: holds.map((item) => item.reason).join('; '), held: holds } });
      }

      const located = locateStep(run, leased.id);

      if (!located) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no definition for step "${leased.id}"`) };
      const rendered = renderLease(located.scope, statesIn(run, located.scope), leased, located.step);

      if (!('code' in rendered)) {
        const plan = planWorkspace(run, located.scope, leased, located.step, {
          driver, modes: can.workspace, base: run.base ?? options.base,
        }, true);

        const offered = plan.fail ? undefined : plan;
        const confined = await confinedFor(config, run, leased, located.step, rendered, can);

        if (confined?.kind === 'fail') {
          stopAttempt(run, leased, now);
          failStep(leased, confined.failure, leased.lease.revision);
          continue;
        }

        const terms = offerTerms(run, leased.id, located, offered, context);

        // A driver that can no longer run its lease gives it up, so the step waits for one that can instead of looping.
        // No step has run in an unused copy, so the driver gives up the copy too, and another driver may take the step,
        // unless the driver still holds another lease in it.
        if (terms.kind === 'hold' || confined?.kind === 'hold') {
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
        // The driver's `can` may have changed since, so the turn's terms are decided again, as of the first lease. A lease
        // issued before teamai recorded when keeps its deadline.
        const { limits: _held, expiresAt: heldUntil, confined: _terms, ...held } = leased.lease;
        const since = held.leasedAt;
        const turn = since ? turnTerms(run, leased, located.step, terms.terms, since, now) : leaseTerms(heldUntil, terms.terms.limits);
        const renewed: StepLease = { ...held };

        if (unenforced.length > 0) renewed.unenforced = unenforced;

        if (options.runMode) renewed.runMode = options.runMode;

        // The report is checked against the terms decided now, as the lease answers with them.
        if (confined?.kind === 'grant') renewed.confined = { level: confined.lease.level, tools: confined.lease.tools };
        leased.lease = offering({ ...renewed, ...turn }, offered?.session);

        // A turn with none of its timeout left times out as any lease past its deadline does.
        if (turn.expiresAt !== undefined && Date.parse(turn.expiresAt) <= Date.parse(now)) continue;

        if (offered) rememberCopy(run, offered, driver);

        return answer(leaseData(run, leased, located.step, rendered, terms.terms, offered, confined?.lease));
      }

      failStep(leased, rendered, leased.lease.revision);
    }
  });

  const answered = 'data' in envelope ? envelope.data.done : undefined;
  const done = isRecord(answered) ? answered : undefined;
  // Every `next` that answers `done` publishes the end again, so an end saved by a process that stopped before it was
  // published still reaches teamai-reports; an end already there writes nothing.
  const notPublished = done ? await publishRunEnd(config, runId, driver.workspace) : undefined;

  const record = queued
    ? await publishRunRecords(config)
    : alreadySettled && await settledRecordState(config, alreadySettled);

  // A run another install owns had its record dropped, not published.
  if (done && record && notPublished?.code !== 'not_owner') done.record = record;

  if (done && notPublished) done.notPublished = notPublished;

  if (done) await cleanUpSucceededRun(config, { runId, checkout: driver.workspace, secrets: env.secrets, notPublished });

  return envelope;
}

/**
 * The record state of `run`, which settled before this `next`. A record still queued is published first: the run
 * control that ended the run, such as a cancel, may be publishing it at this moment, and the queue says so once it did.
 */
async function settledRecordState(config: LocalConfig, run: RunState): Promise<RecordState | undefined> {
  const state = await runRecordState(config, run);

  if (state !== 'pending') return state;
  await publishPendingRecords(config, { run: run.id }).catch((cause: unknown) => {
    log.warn(`The run record of ${run.id} was not published (${cause instanceof Error ? cause.message : String(cause)}). Publish it again: teamai workflow publish ${run.id}`);
  });

  return runRecordState(config, run);
}

/** A payload's `driver`: a kind, machine, and workspace, none of them empty. */
const PayloadDriverSchema = DriverSchema.refine((driver) => driver.kind !== '' && driver.machine !== '' && driver.workspace !== '');

const NonEmptyStringSchema = z.string().min(1);

/** Any integer; `z.number().int()` stops at the safe range, which the payload checks never did. */
const IntegerSchema = z.number().refine(Number.isInteger);

const ReportOutcomeSchema = z.enum(['success', 'failed', 'released']);

/** The session a report says the attempt resumed: a tool and an id, neither empty. */
const ResumedSchema = z.object({ tool: NonEmptyStringSchema, id: NonEmptyStringSchema });

/** The branch, base, and commit range a report's `changes` name; its commits and `pr_url` are checked apart. */
const ChangeEndsSchema = z.object({ branch: z.string(), base: z.string(), from: z.string(), to: z.string() });

/** A `next` payload's base: a commit, and a ref that is not empty when it is set. */
const NextBaseSchema = z.object({ ref: NonEmptyStringSchema.optional(), commit: NonEmptyStringSchema });

/** Known driver fields shared by next, report and respond. Any other driver field is reported back as `driver.<field>`. */
const DRIVER_FIELDS = new Set(['kind', 'machine', 'workspace', 'can']);

/** The top-level payload fields `parseNextPayload` reads. */
const NEXT_PAYLOAD_FIELDS = new Set(['driver', 'running', 'queued', 'canTakeLease', 'base', 'claim', 'autoApprove', 'runMode']);

/**
 * Where `parseReport` reads each ReportInput field from: the payload field of the same name, `changes.pr_url`, or
 * nowhere, as a field only this process sets. Typed against ReportInput, so a new field does not compile until it is
 * placed here.
 */
const REPORT_FIELD_SOURCES = {
  attempt: 'payload', revision: 'payload', outcome: 'payload', driver: 'payload', outputs: 'payload', exitCode: 'payload', message: 'payload',
  tool: 'payload', model: 'payload', session: 'payload', resumed: 'payload', tokens: 'payload', durationMs: 'payload', cost: 'payload',
  failure: 'payload', changes: 'payload', read: 'payload', agent: 'payload', used: 'payload', unenforced: 'payload', limit: 'payload',
  confined: 'payload', progress: 'payload', queued: 'payload', prUrl: 'changes.pr_url',
} as const satisfies Record<keyof ReportInput, 'payload' | 'changes.pr_url' | 'process'>;

/** The top-level payload fields `parseReport` reads. */
const REPORT_FIELDS = new Set(Object.entries(REPORT_FIELD_SOURCES).flatMap(([field, source]) => (source === 'payload' ? [field] : [])));

/**
 * The payload fields this CLI does not read: top-level names first, then `driver.<field>` names.
 * Names only, never values, because an unknown field may hold anything (#1164).
 */
function unreadFields(record: { driver?: unknown }, known: ReadonlySet<string>): string[] {
  const ignored = Object.keys(record).filter((key) => !known.has(key));
  const driver = record.driver;

  if (isRecord(driver)) {
    for (const key of Object.keys(driver)) {
      if (!DRIVER_FIELDS.has(key)) ignored.push(`driver.${key}`);
    }
  }

  return ignored;
}

/** The driver UI a `respond --json` payload declares the person answered in, and the payload fields it did not read. */
export interface ParsedResponsePayload {
  driver: DriverIdentity;
  /** As `next`'s `queued`: the driver's open leases it has not started, whose own timeout counts from this answer. */
  queued?: string[];
  ignored: string[];
}

// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: the respond payload as JSON.parse read it
export function parseResponsePayload(value: unknown): ParsedResponsePayload | string {
  if (!isRecord(value)) return 'respond payload must be a JSON object';
  const driver = PayloadDriverSchema.safeParse(value.driver);

  if (!driver.success) return 'driver must include kind, machine, and workspace';
  const parsed: ParsedResponsePayload = { driver: driver.data, ignored: unreadFields(value, new Set(['driver', 'queued'])) };

  if (value.queued !== undefined) {
    const queued = z.array(z.string()).safeParse(value.queued);

    if (!queued.success) return 'queued must be an array of attempt ids';
    parsed.queued = queued.data;
  }

  return parsed;
}

/** A parsed report and the payload fields the CLI did not read from it. */
export interface ParsedReport {
  report: ReportInput;
  ignored: string[];
}

/** Why a report's confined.model or confined.effort does not parse: each is an observation, never a bare name. */
const CONFINED_OBSERVED = {
  model: 'confined.model must be {"reported": "<model>"}, with "requested" and "alias" when known',
  effort: 'confined.effort must be {"reported": "<effort>"}, with "requested" when known',
} as const;

/** Why a report's `confined` does not parse, naming `field` when it is one a driver sends as a bare name by mistake. */
function confinedRefusal(field: PropertyKey | undefined): string {
  return field === 'model' || field === 'effort' ? CONFINED_OBSERVED[field] : 'confined must be what the confined run measured: its tool, isolation and access, and its model, effort and usage when known';
}

/** A parsed `next` payload and the fields the CLI did not read from it. */
export interface ParsedNextPayload {
  request: NextRequest;
  ignored: string[];
}

// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: the report payload as JSON.parse read it
export function parseReport(value: unknown): ParsedReport | string {
  if (!isRecord(value)) return 'report must be a JSON object';
  const record = value;
  const attempt = NonEmptyStringSchema.safeParse(record.attempt);

  if (!attempt.success) return 'attempt must be a string';
  const revision = IntegerSchema.safeParse(record.revision);

  if (!revision.success) return 'revision must be an integer';
  const outcome = ReportOutcomeSchema.safeParse(record.outcome);

  if (!outcome.success) return 'outcome must be success, failed, or released';
  const driver = PayloadDriverSchema.safeParse(record.driver);

  if (!driver.success) return 'driver must include kind, machine, and workspace';
  const report: ReportInput = { attempt: attempt.data, revision: revision.data, outcome: outcome.data, driver: driver.data };

  if ('outputs' in record) report.outputs = record.outputs;

  if (record.exitCode !== undefined) {
    const exitCode = IntegerSchema.safeParse(record.exitCode);

    if (!exitCode.success) return 'exitCode must be an integer';
    report.exitCode = exitCode.data;
  }

  if (record.message !== undefined) {
    const message = z.string().safeParse(record.message);

    if (!message.success) return 'message must be a string';
    report.message = message.data;
  }

  if (record.queued !== undefined) {
    const queued = z.array(z.string()).safeParse(record.queued);

    if (!queued.success) return 'queued must be an array of attempt ids';
    report.queued = queued.data;
  }

  if (record.progress !== undefined) {
    const progress = z.array(z.string()).safeParse(record.progress);

    if (!progress.success) return 'progress must be a list of lines';
    report.progress = progress.data.slice(-PROGRESS_LINES);
  }

  for (const field of ['tool', 'model', 'session'] as const) {
    if (record[field] === undefined) continue;
    const text = z.string().safeParse(record[field]);

    if (!text.success) return `${field} must be a string`;
    report[field] = text.data;
  }

  if (record.resumed !== undefined) {
    const resumed = ResumedSchema.safeParse(record.resumed);

    if (!resumed.success) return 'resumed must be a session: a tool and an id';
    report.resumed = resumed.data;
  }

  if (record.tokens !== undefined) {
    const tokenFields = record.tokens;

    if (!isRecord(tokenFields)) return 'tokens must be an object';
    const tokens: TokenUsage = {};

    for (const field of ['input', 'output', 'cachedInput'] as const) {
      if (tokenFields[field] === undefined) continue;
      // z.number() rejects Infinity and NaN.
      const count = z.number().safeParse(tokenFields[field]);

      if (!count.success) return `tokens.${field} must be a finite number`;
      tokens[field] = count.data;
    }

    report.tokens = tokens;
  }

  if (record.durationMs !== undefined) {
    const durationMs = z.number().refine((ms) => Number.isSafeInteger(ms) && ms >= 0).safeParse(record.durationMs);

    if (!durationMs.success) return 'durationMs must be a non-negative integer of milliseconds';
    report.durationMs = durationMs.data;
  }

  if (record.cost !== undefined) {
    const cost = CostSchema.safeParse(record.cost);

    if (!cost.success) return 'cost must be an amount and a unit, as the tool stated it';
    report.cost = cost.data;
  }

  if (record.failure !== undefined) {
    const failureFields = record.failure;

    if (!isRecord(failureFields)) return 'failure must be an object';
    const code = z.string().safeParse(failureFields.code);

    if (!code.success) return 'failure.code must be a string';
    const message = z.string().safeParse(failureFields.message);

    if (!message.success) return 'failure.message must be a string';
    report.failure = { code: code.data, message: message.data };
  }

  if (record.changes !== undefined) {
    const changesFields = record.changes;

    if (!isRecord(changesFields)) return 'changes must be an object';
    const ends = ChangeEndsSchema.safeParse(changesFields);

    if (!ends.success) return 'changes must include branch, base, from, and to';
    const commits = z.array(z.string()).safeParse(changesFields.commits);

    if (!commits.success) return 'changes.commits must be an array of strings';
    report.changes = { ...ends.data, commits: commits.data };

    if (changesFields.pr_url !== undefined) report.prUrl = changesFields.pr_url;
  }

  if (record.read !== undefined) {
    const read = ReadSchema.safeParse(record.read);

    if (!read.success) return 'read must include branch, base, and commit';
    report.read = read.data;
  }

  if (record.agent !== undefined) {
    const agent = parseReportedAgent(record.agent);

    if (!isRecord(agent)) return agent;
    report.agent = agent;
  }

  if (record.used !== undefined) {
    const used = parseReportedUsed(record.used);

    if (isRecord(used)) report.used = used;
    else if (used !== undefined) return used;
  }

  if (record.unenforced !== undefined) {
    const unenforced = ReportedUnenforcedSchema.safeParse(record.unenforced);

    if (!unenforced.success) return 'unenforced must list the requirements the driver did not enforce: max_turns or budget';
    report.unenforced = unenforced.data;
  }

  if (record.limit !== undefined) {
    const limit = LimitSchema.safeParse(record.limit);

    if (!limit.success) return 'limit must be the lease limit that ended the turn: timeout, budget or max_turns';
    report.limit = limit.data;
  }

  if (record.confined !== undefined) {
    const confined = ConfinedRunReportSchema.safeParse(record.confined);

    if (!confined.success) return confinedRefusal(confined.error.issues[0]?.path[0]);

    report.confined = confined.data;
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

// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse boundary: the next payload as JSON.parse read it
export function parseNextPayload(value: unknown): ParsedNextPayload | string {
  if (!isRecord(value)) return 'next payload must be a JSON object';
  const record = value;
  const driver = PayloadDriverSchema.safeParse(record.driver);

  if (!driver.success) return 'driver must include kind, machine, and workspace';
  const request: NextRequest = { driver: driver.data };

  if (record.running !== undefined) {
    const running = z.array(z.string()).safeParse(record.running);

    if (!running.success) return 'running must be an array of attempt ids';
    request.running = running.data;
  }

  if (record.queued !== undefined) {
    const queued = z.array(z.string()).safeParse(record.queued);

    if (!queued.success) return 'queued must be an array of attempt ids';
    request.queued = queued.data;
  }

  if (record.canTakeLease !== undefined) {
    const canTakeLease = z.boolean().safeParse(record.canTakeLease);

    if (!canTakeLease.success) return 'canTakeLease must be a boolean';
    request.canTakeLease = canTakeLease.data;
  }

  if (record.base !== undefined) {
    if (!isRecord(record.base)) return 'base must be an object';
    const base = NextBaseSchema.safeParse(record.base);

    if (!base.success) return 'base must include commit, and ref when it is set must not be empty';
    request.base = base.data;
  }

  if (record.claim !== undefined) {
    const claim = z.boolean().safeParse(record.claim);

    if (!claim.success) return 'claim must be a boolean';
    request.claim = claim.data;
  }

  if (record.runMode !== undefined) {
    const runMode = RunModeSchema.safeParse(record.runMode);

    if (!runMode.success) return 'runMode must be attended or unattended';
    request.runMode = runMode.data;
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

  // Only a driver with HITL reads it: for one without, workflows.auto_approve is the member's own setting.
  if (record.autoApprove !== undefined && request.can?.hitl === true) {
    const autoApprove = z.boolean().safeParse(record.autoApprove);

    if (!autoApprove.success) return 'autoApprove must be a boolean';
    request.autoApprove = autoApprove.data;
  } else if (record.autoApprove !== undefined) ignored.push('autoApprove');

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
  // The team clone's base is origin's default branch when the clone was made, which only the place knows.
  if (contract?.mode === 'team') {
    if (report.read) return `read names branch ${report.read.branch}, but attempt ${report.attempt} was leased team branch ${contract.branch}`;

    if (report.changes && report.changes.branch !== contract.branch) return `changes name branch ${report.changes.branch}, but attempt ${report.attempt} was leased team branch ${contract.branch}`;

    return undefined;
  }

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

  if (run === 'missing' || run === 'corrupt' || !run.checkout) return undefined;

  // TeamAI opens a team branch's pull request itself, and keeps no URL a driver reported for it.
  if (run.copies?.[report.changes.branch]?.kind === 'team') return `branch ${report.changes.branch} is a team repo branch, whose pull request TeamAI looks up itself`;
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
  const stoppedEntry = run.stoppedAttempts?.find((entry) => entry.attempt === report.attempt);

  if (!report.tokens || !stoppedEntry || !sameDriver(stoppedEntry.driver, report.driver)) return false;
  countLateTokens(run, stoppedEntry, report.tokens);

  return true;
}

/**
 * The leased step `report` settles, or how the run refuses it once the clocks of the attempts it lists `queued` restart
 * and the deadlines passed at `now` apply: the checks `reportAttempt` makes before it reads the report itself. `save`
 * says whether what they changed in `run`, the deadlines or a stopped attempt's late tokens, is saved.
 */
function reportedStep(run: RunState, report: ReportInput, now: string): { step: LeasedStep } | { refused: { save: boolean; envelope: WorkflowEnvelope } } {
  restartQueued(run, report.driver, new Set((report.queued ?? []).filter((attempt) => attempt !== report.attempt)), now);

  // Settled membership wins. An old revision of a settled attempt is still repeated_report.
  if (run.settledAttempts.includes(report.attempt)) {
    return { refused: { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) } };
  }

  // Before the driver check, so any driver learns that the attempt was cancelled.
  if (run.cancelledAttempts?.includes(report.attempt)) {
    return { refused: { save: countStoppedTokens(run, report), envelope: error('lease_cancelled', `Attempt ${report.attempt} was cancelled; its report is not recorded`) } };
  }

  const step = run.steps.find((item): item is LeasedStep => item.status === 'leased' && item.lease.attempt === report.attempt);

  if (!step) {
    if (report.revision !== run.revision) {
      return { refused: { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) } };
    }

    return { refused: { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) } };
  }

  const reconciled = reconcileRun(run, now);

  if ('unreadable' in reconciled) return { refused: { save: false, envelope: error('run_unreadable', reconciled.unreadable) } };

  if (run.cancelledAttempts?.includes(report.attempt)) {
    countStoppedTokens(run, report);

    return { refused: { save: true, envelope: error('lease_cancelled', `Attempt ${report.attempt} was cancelled; its report is not recorded`) } };
  }

  // A lease is checked against the revision it was handed out at, so a report of a parallel lease does not make it stale.
  if (report.revision !== step.lease.revision) {
    return { refused: { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; attempt ${report.attempt} was leased at ${step.lease.revision}`) } };
  }

  if (!sameDriver(step.lease.driver, report.driver)) {
    return { refused: { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') } };
  }

  return { step };
}

/**
 * What is wrong with the `limit` and `durationMs` of `report`, whose lease carried `limits` or none: a limit goes with a
 * successful turn, and only one its lease set; a successful turn under limits says how long its tool ran.
 */
function reportedLimitProblem(report: ReportInput, limits: TurnLimits | undefined): string | undefined {
  if (report.limit !== undefined) {
    if (!limits) return 'limit is for a prompt leased with limits, which end its turn; omit it';

    if (!setsLimit(limits, report.limit)) return `limit ${report.limit} is not one of the lease's limits; send limit only for a limit in the lease's limits that ended the turn`;

    if (report.outcome !== 'success') return "limit goes with outcome success, since a limit ends the agent's turn and the step succeeds; send outcome success, or omit limit";
  }

  if (limits && report.outcome === 'success' && report.durationMs === undefined) {
    return 'a prompt leased with limits reports durationMs, how long its tool ran, so its turn counts against them; send durationMs';
  }

  return undefined;
}

/**
 * Whether the run of `runId` takes `report` now, by the checks `reportAttempt` makes before it reads the report: the
 * attempt is leased to its driver at its revision once the deadlines that passed apply. It saves nothing.
 */
export async function reportable(config: LocalConfig, runId: string, report: ReportInput): Promise<boolean> {
  const run = await readRun(config, runId);

  return run !== 'missing' && run !== 'corrupt' && 'step' in reportedStep(run, report, new Date().toISOString());
}

/** `secrets`: what the run file masks, when the caller already resolved them for this operation. */
/**
 * The admission of the workflow output `report` gives its step, when the step's output has a workflow field and the
 * report succeeds with outputs. Read from the run as it stands before the report takes its lock.
 */
async function admitReported(
  config: LocalConfig, runId: string, report: ReportInput, secrets: Record<string, string>,
): Promise<{ attempt: string; output: AdmittedWorkflow['output']; admission: Awaited<ReturnType<typeof admitWorkflow>> } | undefined> {
  if (report.outcome !== 'success' || !isRecord(report.outputs)) return undefined;
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return undefined;
  const state = run.steps.find((item) => item.status === 'leased' && item.lease.attempt === report.attempt);
  const field = state && workflowField(locateStep(run, state.id)?.step.output);

  if (!state || field === undefined) return undefined;
  const admission = await admitWorkflow(config, { kind: 'output', step: state.id, field, output: report.outputs, runsUnder: fromRequirements(run, state.id) }, { secrets, base: run.base });

  return { attempt: report.attempt, output: report.outputs, admission };
}

/**
 * Freezes the output of producer `path` with `run`: the whole output, hashed and never rewritten, and the workflow its
 * `field` defines, which a `from` step runs. The workflows it runs by name join the run's. Why not, when the producer
 * already gave the run a workflow, or a name it brings is the run's already for something else.
 */
function admitInto(run: RunState, path: string, field: string, output: AdmittedWorkflow['output'], admitted: Admitted): WorkflowFailure | undefined {
  if (run.admitted?.[path]) {
    return { code: 'invalid_output', message: `Step "${path}" already gave this run a workflow, which the run keeps; a step with a workflow output runs once.` };
  }

  const taken = <Pinned>(mine: Record<string, Pinned> | undefined, theirs: Record<string, Pinned>): string | undefined => Object.keys(theirs)
    .find((key) => mine !== undefined && Object.hasOwn(mine, key) && JSON.stringify(mine[key]) !== JSON.stringify(theirs[key]));

  const name = taken(run.workflows, admitted.workflows);

  if (name !== undefined) {
    return { code: 'invalid_output', message: `Step "${path}" output ${field} brings "${name}", which this run already holds with other content; name each workflow by its content.` };
  }

  run.admitted = { ...run.admitted, [path]: { output, hash: createHash('sha256').update(JSON.stringify(output)).digest('hex'), field, definition: admitted.definition } };

  if (Object.keys(admitted.workflows).length > 0) run.workflows = { ...run.workflows, ...admitted.workflows };

  return undefined;
}

/**
 * Why the confined run a report names is not one `terms`, the lease's, allow: none named by a success, a tool the lease
 * did not name, or an isolation below its level, which is a minimum. A lease issued before teamai kept its terms is not
 * checked, and a report that did not succeed needs no confined run.
 */
function confinedMismatch(step: string, terms: LeasedConfined | undefined, ran: ConfinedRunReport | undefined, outcome: ReportInput['outcome']): WorkflowFailure | undefined {
  if (!terms) return undefined;

  if (!ran) {
    return outcome !== 'success' ? undefined : { code: 'confined_report_mismatch', message: `Step "${step}" was leased to run confined at ${terms.level} on ${terms.tools.join(', ')}, and its report names no confined run, so nothing shows it ran confined. Retry the step with a driver that reports the confined run it launched.` };
  }

  if (!terms.tools.includes(ran.tool)) {
    return { code: 'confined_report_mismatch', message: `Step "${step}" was leased to run confined on ${terms.tools.join(', ')}, and its report says ${ran.tool} ran it, so what judged it is not what was leased. Retry the step with a driver that runs it on a tool it offers.` };
  }

  if (CONFINED_LEVELS.indexOf(ran.isolation) < CONFINED_LEVELS.indexOf(terms.level)) {
    return { code: 'confined_report_mismatch', message: `Step "${step}" was leased to run confined at ${terms.level}, and its report says it ran at ${ran.isolation}, below that level. Retry the step with a driver that runs it at ${terms.level}.` };
  }

  return undefined;
}

export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput, secrets?: Record<string, string>): Promise<WorkflowEnvelope> {
  const install = await installOwner(config);
  const reported = report.prUrl === undefined ? undefined : sanitizePrUrl(report.prUrl);
  const unmatched = reported?.url ? await reportedPrUnmatched(config, runId, report, reported.url) : undefined;
  // Read here for every driver: the attempt has ended, so nothing appends to it any more.
  const outcomes = await readAttemptOutcomes(config, runId, report.attempt);
  const known = secrets ?? await knownSecrets(config);
  // Admission may read a team commit, so it runs before the run lock is taken.
  const admission = await admitReported(config, runId, report, known);

  return withRun(config, runId, known, async (run, now) => {
    const checked = reportedStep(run, report, now);

    if ('refused' in checked) return checked.refused;
    const { step } = checked;

    const located = locateStep(run, step.id);
    const defined = located?.step;

    const plan = located && planWorkspace(run, located.scope, step, located.step, {
      driver: step.lease.driver, modes: ['read-only', 'new', 'continue'],
    }, true);

    const contract = plan?.contract;
    const mismatch = workspaceMismatch(report, contract) ?? resumedMismatch(step, report.resumed);

    if (mismatch) return { save: false, envelope: error('invalid_report', mismatch) };
    const limits = step.lease.limits;
    const limitProblem = reportedLimitProblem(report, limits);

    if (limitProblem) return { save: false, envelope: error('invalid_report', `Attempt ${report.attempt} of step "${step.id}": ${limitProblem}`) };
    const added = reportedUnenforced(report.unenforced ?? [], { maxTurns: defined?.maxTurns, tokens: limits?.budget?.tokens });

    if (!Array.isArray(added)) return { save: false, envelope: error('invalid_report', `Attempt ${report.attempt} of step "${step.id}": ${added}`) };
    let outcome = report.outcome;
    let message = report.message;
    let failure = report.failure;
    const measured = report.tokens?.input !== undefined || report.tokens?.output !== undefined;
    const unmeasured = outcome === 'success' && defined?.prompt !== undefined && (located?.scope.budgeted === true || limits?.budget !== undefined) && !measured;
    // A person drives an interactive prompt, so its spend is recorded as not counted rather than failing their work. So
    // is a turn that another limit ended before its tool stated a total, as Codex states one only as it ends.
    const uncounted = unmeasured && (defined.interactive === true || report.limit !== undefined);
    const unenforced = unionUnenforced(step.lease.unenforced ?? [], [...added, ...(uncounted ? [{ requirement: 'budget' as const }] : [])]);

    if (unmeasured && !uncounted) {
      outcome = 'failed';
      message = limits?.budget !== undefined
        ? `Step "${step.id}" ends its turn at a token budget, and its report has no tokens, so the budget cannot count what it spent. Run its tool with a driver that reports its tokens, then retry the step.`
        : `Step "${step.id}" runs under a token budget, and its report has no tokens, so the budget cannot count what it spent. Run it with a driver that reports tokens (driver.can.tokens), then retry the step.`;
      failure = { code: 'budget_unmeasured', message };
    }

    const confinedProblem = outcome === 'released' ? undefined : confinedMismatch(step.id, step.lease.confined, report.confined, outcome);

    if (confinedProblem) {
      outcome = 'failed';
      message = confinedProblem.message;
      failure = confinedProblem;
    }

    if (outcome === 'success' && defined?.output && (!defined.interactive || report.outputs !== undefined)) {
      const outputProblem = outputMismatch(defined.output, report.outputs);

      if (outputProblem) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${outputProblem}`;
        failure = { code: 'invalid_output', message };
      }
    }

    const field = workflowField(defined?.output);

    if (outcome === 'success' && field !== undefined) {
      const refused = admission?.attempt === report.attempt
        ? 'failure' in admission.admission ? admission.admission.failure : admitInto(run, step.id, field, admission.output, admission.admission.admitted)
        : { code: 'invalid_output', message: `Step "${step.id}" output ${field} changed while it was admitted; report it again.` };

      if (refused) {
        outcome = 'failed';
        message = refused.message;
        failure = refused;
      }
    }

    // A turn ended at what an allowance had left spends it.
    if (outcome === 'success' && report.limit && limits && located) spendAllowances(run, located.scope, limits, report.limit);
    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;

    // A field the attempt did not report stays undefined, which the run file leaves out, and every reader of a step
    // treats undefined as absent.
    const settlement = {
      settledAt: run.revision,
      attempt: report.attempt,
      exitCode: report.exitCode,
      message,
      tool: report.tool,
      model: report.model,
      session: report.session,
      tokens: report.tokens,
      durationMs: report.durationMs,
      cost: report.cost,
      changes: report.changes,
      read: report.read,
      agent: settleObservation(report, defined?.agent),
      used: report.used,
      unenforced: unenforced.length > 0 ? unenforced : undefined,
      runMode: step.lease.runMode,
      outcomes: outcomes.length > 0 ? outcomes : undefined,
      limit: report.limit,
      confined: report.confined,
      progress: report.progress,
      installId: install.id,
    };

    if (outcome !== 'released') continueSession(run, report);
    else if (report.tokens) (run.releasedTokens ??= []).push({ step: step.id, attempt: report.attempt, tokens: report.tokens });

    if (report.changes) {
      const copy = (run.copies ??= {})[report.changes.branch] ?? { owner: report.driver };
      copy.owner ??= report.driver;
      copy.commit = report.changes.to;
      // A pull request from a team branch is compared with the default branch tip its last step started from.
      run.copies[report.changes.branch] = contract?.mode === 'team' ? { ...copy, kind: 'team', base: report.changes.base } : copy;
    }

    // The step itself ran in the copy, not only its staging or setup.
    if (contract && !isPublishContract(contract) && (report.outcome === 'success' || report.exitCode !== undefined || report.changes || report.read)) {
      ((run.copies ??= {})[contract.branch] ??= { owner: report.driver }).used = true;
    }

    const successful: Parameters<typeof succeed>[1] = { ...settlement };

    if (report.outputs !== undefined) successful.outputs = report.outputs;
    const delivery = outcome === 'success' && defined?.deliver === 'pr' ? deliverableOf(run, step, defined, report.changes) : undefined;
    const delivering: Parameters<typeof startDelivery>[2] | undefined = delivery && { ...delivery };

    if (delivering && reported?.url && !unmatched) delivering.reported = reported.url;

    const settledStep = outcome === 'released' ? release(step)
      : outcome !== 'success' ? fail(step, { ...settlement, failure })
        : delivering ? startDelivery(step, successful, delivering)
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

    const stepAnswer: EnvelopeData = { id: settledStep.id, status: settledStep.status, outcome };

    if (settledStep.status === 'failed') stepAnswer.failure = settledStep.failure;

    if (settlement.unenforced) stepAnswer.unenforced = settlement.unenforced;
    const accepted: EnvelopeData = { accepted: true, revision: run.revision, step: stepAnswer };

    if (cleanup) accepted.cleanup = true;

    if (dropReason) accepted.dropped = [{ field: 'changes.pr_url', reason: dropReason }];

    return { save: true, envelope: ok(accepted) };
  });
}
