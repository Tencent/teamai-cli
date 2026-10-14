import { randomBytes } from 'node:crypto';
import { acquireLock, releaseLock } from '../update.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow } from './cache.js';
import { outputMismatch } from './output.js';
import { isRunId, readRun, runLockPath, writeRun } from './store.js';
import type { DriverIdentity, RunState, StepOutcome, StepState, WorkflowEnvelope } from './types.js';

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

function leasePayload(run: RunState, step: StepState): Record<string, unknown> {
  const definition = run.definition.steps.find((item) => item.id === step.id);
  return {
    run: run.id,
    step: step.id,
    attempt: step.lease?.attempt,
    revision: step.lease?.revision,
    command: definition?.command,
    ...(definition?.output ? { output: definition.output } : {}),
  };
}

export async function startRun(config: LocalConfig, name: string): Promise<WorkflowEnvelope> {
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
    steps: cached.definition.steps.map((step) => ({ id: step.id, status: 'pending' })),
    settledAttempts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeRun(config, run);
  return ok({ run: run.id, name: run.name, status: run.status, revision: run.revision });
}

export async function leaseNext(config: LocalConfig, runId: string, driver: DriverIdentity): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    if (run.status !== 'running') {
      return { save: false, envelope: ok({ done: { run: run.id, outcome: run.status } }) };
    }
    const leased = run.steps.find((step) => step.status === 'leased');
    if (leased?.lease) {
      if (sameDriver(leased.lease.driver, driver)) {
        return { save: false, envelope: ok({ lease: leasePayload(run, leased) }) };
      }
      return { save: false, envelope: ok({ wait: { reason: `${leased.id} is leased` } }) };
    }
    const index = run.steps.findIndex((step) => step.status === 'pending');
    if (index < 0) {
      const outcome = run.steps.every((step) => step.status === 'succeeded') ? 'succeeded' : 'failed';
      run.status = outcome;
      return { save: true, envelope: ok({ done: { run: run.id, outcome } }) };
    }
    if (run.steps.slice(0, index).some((step) => step.status !== 'succeeded')) {
      run.status = 'failed';
      return { save: true, envelope: ok({ done: { run: run.id, outcome: 'failed' } }) };
    }
    const step = run.steps[index];
    if (!step) return { save: false, envelope: error('run_unreadable', `Run ${run.id} has no step to lease`) };
    const attempt = `a${randomBytes(4).toString('hex')}`;
    step.status = 'leased';
    step.attempt = attempt;
    step.outcome = undefined;
    step.lease = { attempt, revision: run.revision, driver };
    return { save: true, envelope: ok({ lease: leasePayload(run, step) }) };
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

export async function reportAttempt(config: LocalConfig, runId: string, report: ReportInput): Promise<WorkflowEnvelope> {
  return withRun(config, runId, async (run) => {
    // Settled membership wins. An old revision of a settled attempt is still repeated_report.
    if (run.settledAttempts.includes(report.attempt)) {
      return { save: false, envelope: error('repeated_report', `Attempt ${report.attempt} was already reported`) };
    }
    if (report.revision !== run.revision) {
      return { save: false, envelope: error('stale_revision', `Revision ${report.revision} is stale; the run is at ${run.revision}`) };
    }
    const step = run.steps.find((item) => item.status === 'leased' && item.lease?.attempt === report.attempt);
    if (!step?.lease) {
      return { save: false, envelope: error('wrong_attempt', `Attempt ${report.attempt} is not the leased attempt`) };
    }
    if (!sameDriver(step.lease.driver, report.driver)) {
      return { save: false, envelope: error('wrong_driver', 'This lease belongs to a different driver') };
    }

    const defined = run.definition.steps.find((item) => item.id === step.id);
    let outcome = report.outcome;
    let message = report.message;
    if (outcome === 'success' && defined?.output) {
      const mismatch = outputMismatch(defined.output, report.outputs);
      if (mismatch) {
        outcome = 'failed';
        message = `stdout JSON does not match output: ${mismatch}`;
      }
    }

    step.lease = undefined;
    step.attempt = undefined;
    step.exitCode = report.exitCode;
    step.message = message;
    step.outcome = outcome;
    if (outcome === 'released') {
      step.status = 'pending';
    } else if (outcome === 'success') {
      step.status = 'succeeded';
      if (report.outputs !== undefined) step.outputs = report.outputs;
    } else {
      step.status = 'failed';
      run.status = 'failed';
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
