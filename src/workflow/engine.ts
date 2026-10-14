import { randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow } from './cache.js';
import {
  evaluateDeepTemplates,
  evaluateExpression,
  evaluateTemplate,
  extractReferencesFromText,
  type ExprContext,
} from './expr.js';
import { outputMismatch } from './output.js';
import { isRunId, readRun, runLockPath, writeRun } from './store.js';
import type {
  DriverIdentity,
  RunState,
  StepOutcome,
  StepState,
  TokenUsage,
  WorkflowDefinition,
  WorkflowEnvelope,
  WorkflowFailure,
  WorkflowStep,
} from './types.js';

const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

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
  tokens?: TokenUsage;
  failure?: WorkflowFailure;
}

function error(code: string, message: string): WorkflowEnvelope {
  return { error: { code, message } };
}

function ok(value: Record<string, unknown>): WorkflowEnvelope {
  return { data: value };
}

function sameDriver(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRun<T extends WorkflowEnvelope>(
  config: LocalConfig,
  runId: string,
  mutate: (run: RunState) => Promise<{ envelope: T; save: boolean }>,
): Promise<T> {
  if (!isRunId(runId)) return error('invalid_run', 'Run id must look like r followed by 8 hex digits') as T;
  const lock = runLockPath(config, runId);
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    held = await acquireLock(lock);
    if (!held) await delay(LOCK_WAIT_MS);
  }
  if (!held) return error('busy', `Run ${runId} is locked by another process`) as T;
  try {
    const loaded = await readRun(config, runId);
    if (loaded === 'missing') return error('run_not_found', `Run ${runId} was not found`) as T;
    if (loaded === 'corrupt') return error('run_unreadable', `Run ${runId} could not be read`) as T;
    const result = await mutate(loaded);
    if (result.save) {
      loaded.updatedAt = new Date().toISOString();
      await writeRun(config, loaded);
    }
    return result.envelope;
  } finally {
    await releaseLock(lock);
  }
}

function buildExprContext(run: RunState, enclosing?: ExprContext): ExprContext {
  const steps: Record<string, { outcome?: StepOutcome; outputs?: unknown; end?: string; exitCode?: number }> = {};
  for (const step of run.steps) {
    steps[step.id] = {
      outcome: step.outcome,
      outputs: step.outputs,
      end: step.end,
      exitCode: step.exitCode,
    };
  }
  return {
    inputs: run.inputs ?? {},
    steps,
    enclosing,
  };
}

function computeOutputs(outputsDef: Record<string, string> | undefined, context: ExprContext): Record<string, unknown> {
  if (!outputsDef) return {};
  const res: Record<string, unknown> = {};
  for (const [k, expr] of Object.entries(outputsDef)) {
    try {
      if (expr.includes('{{')) {
        res[k] = evaluateTemplate(expr, context);
      } else {
        res[k] = evaluateExpression(expr, context);
      }
    } catch {
      res[k] = undefined;
    }
  }
  return res;
}

function settleWorkflowWithEnd(run: RunState, endId: string, context: ExprContext): void {
  run.settledEnd = endId;
  const endSpec = run.definition.ends?.[endId];
  run.status = endSpec ?? 'succeeded';
  for (const s of run.steps) {
    if (s.status === 'pending') {
      s.status = 'skipped';
      s.outcome = 'skipped';
    }
  }
  run.outputs = computeOutputs(run.definition.outputs, context);
}

function settleWorkflowFinished(run: RunState, context: ExprContext): void {
  if (run.settledEnd) {
    const endSpec = run.definition.ends?.[run.settledEnd];
    run.status = endSpec ?? 'succeeded';
  } else {
    const hasFailed = run.steps.some((s) => s.status === 'failed');
    run.status = hasFailed ? 'failed' : 'succeeded';
  }
  run.outputs = computeOutputs(run.definition.outputs, context);
}

function getStepDependencies(stepDef: WorkflowStep, allSteps: WorkflowStep[]): string[] {
  const hasAnyNeeds = allSteps.some((s) => s.needs && s.needs.length > 0);
  if (hasAnyNeeds) {
    return stepDef.needs ?? [];
  }
  const idx = allSteps.findIndex((s) => s.id === stepDef.id);
  if (idx > 0) {
    const prev = allSteps[idx - 1];
    return prev ? [prev.id] : [];
  }
  return [];
}

function leasePayload(
  run: RunState,
  step: StepState,
  stepDef: WorkflowStep,
  stepPath: string,
  context: ExprContext,
): Record<string, unknown> {
  let evaluatedEnv: Record<string, string> | undefined;
  if (stepDef.env) {
    evaluatedEnv = {};
    for (const [k, v] of Object.entries(stepDef.env)) {
      const rendered = evaluateTemplate(v, context);
      evaluatedEnv[k] = rendered === undefined || rendered === null ? '' : String(rendered);
    }
  }

  let promptText = stepDef.prompt;
  if (promptText) {
    const rendered = evaluateTemplate(promptText, context);
    promptText = rendered === undefined || rendered === null ? '' : String(rendered);
  }

  return {
    run: run.id,
    step: stepPath,
    attempt: step.lease?.attempt,
    revision: step.lease?.revision,
    ...(stepDef.command !== undefined ? { command: stepDef.command } : {}),
    ...(evaluatedEnv !== undefined ? { env: evaluatedEnv } : {}),
    ...(promptText !== undefined ? { prompt: promptText } : {}),
    ...(stepDef.agent !== undefined ? { agent: stepDef.agent } : {}),
    ...(stepDef.output ? { output: stepDef.output } : {}),
  };
}

export async function startRun(
  config: LocalConfig,
  name: string,
  inputs?: Record<string, unknown>,
): Promise<WorkflowEnvelope> {
  const cached = await loadCachedWorkflow(config, name);
  if (!cached) {
    return error('workflow_not_found', `Workflow "${name}" has no runnable version. Check workflows/${name}.yaml and pull again.`);
  }
  const now = new Date().toISOString();
  const run: RunState = {
    schemaVersion: 'v1alpha1',
    id: `r${randomBytes(4).toString('hex')}`,
    name: cached.definition.name,
    revision: 1,
    status: 'running',
    sourceHash: cached.sourceHash,
    definition: cached.definition,
    ...(inputs ? { inputs } : {}),
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRun(config, run);
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision });
}

interface ActiveLease {
  step: StepState;
  payload: Record<string, unknown>;
}

function findActiveLease(
  rootRun: RunState,
  run: RunState,
  prefix = '',
  enclosing?: ExprContext,
): ActiveLease | undefined {
  const context = buildExprContext(run, enclosing);
  for (const step of run.steps) {
    const stepDef = run.definition.steps.find((s) => s.id === step.id);
    const stepPath = prefix ? `${prefix}.${step.id}` : step.id;
    if (step.subRun && step.subRun.status === 'running') {
      const subEnclosing = typeof stepDef?.workflow === 'object' ? context : undefined;
      const found = findActiveLease(rootRun, step.subRun, stepPath, subEnclosing);
      if (found) return found;
    }
    if (step.status === 'leased' && step.lease && stepDef) {
      return {
        step,
        payload: leasePayload(rootRun, step, stepDef, stepPath, context),
      };
    }
  }
  return undefined;
}

type AdvanceResult =
  | { kind: 'lease'; lease: Record<string, unknown> }
  | { kind: 'wait'; reason: string }
  | { kind: 'done'; outcome: string }
  | { kind: 'error'; envelope: WorkflowEnvelope };

async function advanceWorkflow(
  config: LocalConfig,
  rootRun: RunState,
  run: RunState,
  driver: DriverIdentity,
  enclosing?: ExprContext,
  prefix = '',
): Promise<AdvanceResult> {
  for (;;) {
    if (run.status !== 'running') {
      return { kind: 'done', outcome: run.status };
    }

    const context = buildExprContext(run, enclosing);
    let stateChanged = false;

    // 1. Check for active or finished subRuns
    for (const step of run.steps) {
      if (step.subRun) {
        const stepDef = run.definition.steps.find((s) => s.id === step.id);
        const stepPath = prefix ? `${prefix}.${step.id}` : step.id;
        const subEnclosing = typeof stepDef?.workflow === 'object' ? context : undefined;

        if (step.subRun.status === 'running') {
          const subResult = await advanceWorkflow(config, rootRun, step.subRun, driver, subEnclosing, stepPath);
          if (subResult.kind === 'lease' || subResult.kind === 'wait' || subResult.kind === 'error') {
            return subResult;
          }
        }

        if (step.subRun.status !== 'running' && step.status === 'leased') {
          const subRun = step.subRun;
          step.status = subRun.status === 'succeeded' ? 'succeeded' : (subRun.status === 'stopped' ? 'stopped' : 'failed');
          step.outcome = subRun.status === 'succeeded' ? 'success' : (subRun.status === 'stopped' ? 'stopped' : 'failed');
          step.outputs = subRun.outputs;
          step.end = subRun.settledEnd;
          if (stepDef?.end) {
            step.end = stepDef.end;
            settleWorkflowWithEnd(run, stepDef.end, context);
          }
          stateChanged = true;
        }
      }
    }
    if (stateChanged) {
      continue;
    }

    // 2. Look for ready steps or skips
    let foundReadyStep: { step: StepState; stepDef: WorkflowStep } | undefined;

    for (const stepDef of run.definition.steps) {
      const step = run.steps.find((s) => s.id === stepDef.id);
      if (!step || step.status !== 'pending') continue;

      const deps = getStepDependencies(stepDef, run.definition.steps);
      const depStates = deps.map((id) => run.steps.find((s) => s.id === id)).filter((s): s is StepState => s !== undefined);

      const allDepsSettled = depStates.every(
        (d) => d.status === 'succeeded' || d.status === 'failed' || d.status === 'skipped' || d.status === 'stopped',
      );
      if (!allDepsSettled) {
        continue; // Still waiting for dependencies
      }

      // Join rule: a step with several dependencies is skipped only when every dependency was skipped.
      if (deps.length > 0 && depStates.every((d) => d.status === 'skipped')) {
        step.status = 'skipped';
        step.outcome = 'skipped';
        stateChanged = true;
        break;
      }

      // Failure/stopped propagation & recovery branch
      const failedDeps = depStates.filter((d) => d.status === 'failed' || d.status === 'stopped');
      if (failedDeps.length > 0) {
        if (!stepDef.if) {
          step.status = 'skipped';
          step.outcome = 'skipped';
          stateChanged = true;
          break;
        }
        const refs = extractReferencesFromText(stepDef.if).steps;
        if (failedDeps.some((d) => !refs.includes(d.id))) {
          step.status = 'skipped';
          step.outcome = 'skipped';
          stateChanged = true;
          break;
        }
        let cond = false;
        try {
          cond = Boolean(evaluateExpression(stepDef.if, context));
        } catch {
          cond = false;
        }
        if (!cond) {
          step.status = 'skipped';
          step.outcome = 'skipped';
          stateChanged = true;
          break;
        }
        foundReadyStep = { step, stepDef };
        break;
      }

      // Normal dependencies (none failed)
      if (stepDef.if) {
        let cond = false;
        try {
          cond = Boolean(evaluateExpression(stepDef.if, context));
        } catch {
          cond = false;
        }
        if (!cond) {
          step.status = 'skipped';
          step.outcome = 'skipped';
          stateChanged = true;
          break;
        }
      }

      foundReadyStep = { step, stepDef };
      break;
    }

    if (stateChanged) {
      continue;
    }

    if (foundReadyStep) {
      const { step, stepDef } = foundReadyStep;

      // Pure end step
      if (!stepDef.command && !stepDef.prompt && !stepDef.promptFile && !stepDef.workflow && stepDef.end) {
        step.status = 'succeeded';
        step.outcome = 'success';
        step.end = stepDef.end;
        settleWorkflowWithEnd(run, stepDef.end, context);
        return { kind: 'done', outcome: run.status };
      }

      // Sub-workflow step
      if (stepDef.workflow !== undefined) {
        let subDef: WorkflowDefinition | undefined = typeof stepDef.workflow === 'object'
          ? {
              schemaVersion: 'v1alpha1' as const,
              name: `${run.name}.${step.id}`,
              description: '',
              steps: stepDef.workflow.steps,
              outputs: stepDef.workflow.outputs,
            }
          : undefined;
        let sourceHash = run.sourceHash;

        if (typeof stepDef.workflow === 'string') {
          const cached = await loadCachedWorkflow(config, stepDef.workflow);
          if (!cached) {
            step.status = 'failed';
            step.outcome = 'failed';
            step.failure = { code: 'subworkflow_not_found', message: `Sub-workflow "${stepDef.workflow}" not found` };
            run.status = 'failed';
            return { kind: 'error', envelope: error('subworkflow_not_found', `Sub-workflow "${stepDef.workflow}" not found`) };
          }
          subDef = cached.definition;
          sourceHash = cached.sourceHash;
        }

        if (!subDef) {
          return { kind: 'error', envelope: error('run_unreadable', `Invalid workflow reference on step ${step.id}`) };
        }

        const evaluatedWith = stepDef.with
          ? (evaluateDeepTemplates(stepDef.with, context) as Record<string, unknown>)
          : {};
        const now = new Date().toISOString();

        step.subRun = {
          schemaVersion: 'v1alpha1',
          id: `${run.id}_${step.id}`,
          name: subDef.name,
          revision: 1,
          status: 'running',
          sourceHash,
          definition: subDef,
          inputs: evaluatedWith,
          steps: subDef.steps.map((s: WorkflowStep) => ({ id: s.id, status: 'pending' as const })),
          settledAttempts: [],
          createdAt: now,
          updatedAt: now,
        };
        step.status = 'leased';
        continue;
      }

      // Leaf step to lease
      const attempt = `a${randomBytes(4).toString('hex')}`;
      step.status = 'leased';
      step.attempt = attempt;
      step.outcome = undefined;
      step.lease = { attempt, revision: rootRun.revision, driver };
      const stepPath = prefix ? `${prefix}.${step.id}` : step.id;
      const payload = leasePayload(rootRun, step, stepDef, stepPath, context);
      return { kind: 'lease', lease: payload };
    }

    // No step ready or changed. Check if all steps settled
    const pendingSteps = run.steps.filter((s) => s.status === 'pending');
    if (pendingSteps.length === 0) {
      settleWorkflowFinished(run, context);
      return { kind: 'done', outcome: run.status };
    }

    // Deadlock: remaining pending steps cannot be satisfied
    for (const p of pendingSteps) {
      p.status = 'skipped';
      p.outcome = 'skipped';
    }
    settleWorkflowFinished(run, context);
    return { kind: 'done', outcome: run.status };
  }
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    if (run.status !== 'running') {
      return { save: false, envelope: ok({ done: { run: run.id, outcome: run.status } }) };
    }

    const leased = findActiveLease(run, run);
    if (leased?.step.lease) {
      if (sameDriver(leased.step.lease.driver, driver)) {
        return { save: false, envelope: ok({ lease: leased.payload }) };
      }
      return { save: false, envelope: ok({ wait: { reason: `${leased.step.id} is leased` } }) };
    }

    const result = await advanceWorkflow(config, run, run, driver);
    if (result.kind === 'error') {
      return { save: true, envelope: result.envelope };
    }
    if (result.kind === 'lease') {
      return { save: true, envelope: ok({ lease: result.lease }) };
    }
    if (result.kind === 'wait') {
      return { save: false, envelope: ok({ wait: { reason: result.reason } }) };
    }
    return { save: true, envelope: ok({ done: { run: run.id, outcome: result.outcome } }) };
  });
}

function driverFrom(value: unknown): DriverIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const driver = value as DriverIdentity;
  if (typeof driver.kind !== 'string' || driver.kind === '') return undefined;
  if (typeof driver.machine !== 'string' || driver.machine === '') return undefined;
  if (typeof driver.workspace !== 'string' || driver.workspace === '') return undefined;
  return { kind: driver.kind, machine: driver.machine, workspace: driver.workspace };
}

export function parseReport(value: unknown): ReportInput | string {
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
  return report;
}

export function parseDriverPayload(value: unknown): DriverIdentity | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'next payload must be a JSON object';
  const driver = driverFrom((value as { driver?: unknown }).driver);
  return driver ?? 'driver must include kind, machine, and workspace';
}

function rememberSettledAttempt(run: RunState, attempt: string): void {
  run.settledAttempts.push(attempt);
  const extra = run.settledAttempts.length - SETTLED_ATTEMPTS_LIMIT;
  if (extra > 0) run.settledAttempts.splice(0, extra);
}

function findLeasedStep(
  run: RunState,
  attempt: string,
): { step: StepState; ownerRun: RunState; stepDef: WorkflowStep } | undefined {
  for (const step of run.steps) {
    if (step.subRun && step.subRun.status === 'running') {
      const found = findLeasedStep(step.subRun, attempt);
      if (found) return found;
    }
    if (step.status === 'leased' && step.lease?.attempt === attempt) {
      const stepDef = run.definition.steps.find((s) => s.id === step.id);
      if (stepDef) {
        return { step, ownerRun: run, stepDef };
      }
    }
  }
  return undefined;
}

function hasRecoveryBranchFor(stepId: string, steps: WorkflowStep[]): boolean {
  for (const step of steps) {
    if (step.if) {
      const refs = extractReferencesFromText(step.if).steps;
      if (refs.includes(stepId)) return true;
    }
  }
  return false;
}

export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    // Settled membership wins. An old revision of a settled attempt is still repeated_report.
    if (run.settledAttempts.includes(report.attempt)) {
      return { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) };
    }
    if (report.revision !== run.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
    }

    const found = findLeasedStep(run, report.attempt);
    if (!found?.step.lease) {
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    const { step, ownerRun, stepDef } = found;

    if (!step.lease || !sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    let outcome = report.outcome;
    let message = report.message;
    let failure = report.failure;
    if (outcome === 'success' && stepDef.output) {
      const mismatch = outputMismatch(stepDef.output, report.outputs);
      if (mismatch) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${mismatch}`;
        failure = { code: 'invalid_output', message };
      }
    }

    step.lease = undefined;
    step.attempt = undefined;
    step.exitCode = report.exitCode;
    step.message = message;
    step.tool = report.tool;
    step.model = report.model;
    step.session = report.session;
    step.tokens = report.tokens;
    step.failure = failure;
    step.outcome = outcome;

    if (outcome === 'released') {
      step.status = 'pending';
    } else if (outcome === 'success') {
      step.status = 'succeeded';
      if (report.outputs !== undefined) step.outputs = report.outputs;
      if (stepDef.end) {
        step.end = stepDef.end;
        settleWorkflowWithEnd(ownerRun, stepDef.end, buildExprContext(ownerRun));
      }
    } else {
      step.status = 'failed';
      if (!hasRecoveryBranchFor(step.id, ownerRun.definition.steps)) {
        ownerRun.status = 'failed';
      }
    }

    rememberSettledAttempt(run, report.attempt);
    run.revision += 1;
    return {
      save: true,
      envelope: ok({
        accepted: true,
        revision: run.revision,
        step: { id: step.id, status: step.status, outcome },
      }),
    };
  });
}
