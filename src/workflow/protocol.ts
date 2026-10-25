/** The workflow protocol in process: the calls behind `workflow start`, `next`, `report`, `respond`, `retry` and `cancel`, for every driver. */
import type { WorkflowEnv } from '../env-resolution.js';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, loadWorkflowTree } from './cache.js';
import { describeWorkflow, type WorkflowDescription } from './describe.js';
import { leaseNext, parseNextPayload, parseReport, parseResponsePayload, reportAttempt, startRun, withIgnored, type ReportInput } from './engine.js';
import { finishPlace, preparePlace, type PlaceLease, type PlacePrepared } from './place/place.js';
import { cancelRun, respondToHitl, retryStep } from './run-controls.js';
import { AttemptIdSchema, readRun, RunIdSchema, withRunLock, type RunLock } from './store.js';
import type { WorkflowEnvelope, WorkflowFailure } from './types.js';
import { headCommit } from './worktree.js';

/**
 * The protocol as one client, in process or through the built CLI. A report made with the run's `RunLock` does not take
 * the lock again; made without one, it takes the lock to finish the attempt's place.
 */
export interface WorkflowClient {
  /**
   * Describes workflow or alias `name` from the cache, with every workflow it runs. `ceiling` is the most steps the
   * caller's driver runs at once.
   */
  describe(name: string, options: { ceiling: number }): Promise<{ description: WorkflowDescription } | { error: WorkflowFailure }>;
  /**
   * Prepares the place of `lease`, an attempt the run has leased, in the checkout the run started from. A lease without
   * a workspace contract only, for now.
   */
  prepare(lock: RunLock, lease: PlaceLease): Promise<PlacePrepared>;
  /** Starts `name` with `inputs`, from `checkout` when given: the run's workspaces start from its HEAD. */
  start(name: string, options?: { inputs?: unknown; checkout?: string }): Promise<WorkflowEnvelope>;
  next(runId: string, body: unknown): Promise<WorkflowEnvelope>;
  report(runId: string, body: unknown, options?: { lock?: RunLock }): Promise<WorkflowEnvelope>;
  /** Records an answer through the client's channel. */
  respond(runId: string, step: string, choice: string, options?: { note?: string; pass?: number; json?: unknown }): Promise<WorkflowEnvelope>;
  /** Reopens the target step's dependency cone. */
  retry(runId: string, step: string): Promise<WorkflowEnvelope>;
  /** Stops the run or the named step. */
  cancel(runId: string, step?: string): Promise<WorkflowEnvelope>;
}

/** The client whose calls run in this process, against `config`, masking with `env`. */
export function inProcessClient({ config, env }: { config: LocalConfig; env: WorkflowEnv }): WorkflowClient {
  return {
    describe: async (name, { ceiling }) => {
      const cached = await loadCachedWorkflow(config, name);
      if (!cached) return { error: { code: 'workflow_not_found', message: `Workflow or alias ${name} has no unambiguous runnable version` } };
      const tree = await loadWorkflowTree(config, cached);
      if ('failed' in tree) return { error: tree.failed };
      return { description: describeWorkflow({ definition: cached.definition, workflows: tree.workflows, ceiling }) };
    },
    prepare: async (lock, lease) => {
      const run = await readRun(config, lock.run);
      if (typeof run !== 'object') return { kind: 'failed', failure: { code: 'run_unreadable', message: `Run ${lock.run} cannot be read, so attempt ${lease.attempt} has no place to run in` } };
      if (!run.steps.some((step) => step.status === 'leased' && step.lease.attempt === lease.attempt)) {
        return { kind: 'failed', failure: { code: 'wrong_attempt', message: `Attempt ${lease.attempt} is not the leased attempt` } };
      }
      if (run.checkout === undefined) {
        return { kind: 'failed', failure: { code: 'workspace_base', message: `Run ${lock.run} records no checkout it started from, so attempt ${lease.attempt} has no place to run in. Drive it with teamai workflow resume ${lock.run}.` } };
      }
      return preparePlace({ config, lock, root: run.checkout, lease });
    },
    start: async (name, options) => {
      const checkout = options?.checkout;
      const base = checkout === undefined ? undefined : await headCommit(checkout);
      return startRun(config, name, options?.inputs ?? {}, { secrets: env.secrets, ...(checkout !== undefined ? { checkout } : {}), ...(base ? { base } : {}) });
    },
    next: async (runId, body) => {
      const parsed = parseNextPayload(body);
      if (typeof parsed === 'string') return { error: { code: 'invalid_json', message: parsed } };
      const { driver, ...next } = parsed.request;
      return withIgnored(await leaseNext(config, runId, driver, { ...next, env }), parsed.ignored);
    },
    report: async (runId, body, options) => {
      const parsed = parseReport(body);
      if (typeof parsed === 'string') return { error: { code: 'invalid_report', message: parsed } };
      return withIgnored(await managedReport({ config, runId, report: parsed.report, secrets: env.secrets, lock: options?.lock }), parsed.ignored);
    },
    respond: async (runId, step, choice, options) => {
      const declared = options?.json !== undefined ? parseResponsePayload(options.json) : undefined;
      if (typeof declared === 'string') return { error: { code: 'invalid_json', message: declared } };
      return withIgnored(await respondToHitl(config, runId, env.secrets, {
        step, choice, note: options?.note, pass: options?.pass, ...(declared ? declared.response : { channel: 'cli', agent: true }),
      }), declared?.ignored ?? []);
    },
    retry: (runId, step) => retryStep(config, runId, env.secrets, step),
    cancel: (runId, step) => cancelRun(config, runId, env.secrets, step),
  };
}

/**
 * Reports an attempt, after finishing the place `prepare` gave it: a reader that changed the checkout fails. An
 * attempt without a place is reported as it is.
 */
async function managedReport(input: { config: LocalConfig; runId: string; report: ReportInput; secrets: Record<string, string>; lock: RunLock | undefined }): Promise<WorkflowEnvelope> {
  const { config, runId, report, secrets, lock } = input;
  const attempt = AttemptIdSchema.safeParse(report.attempt);
  const run = RunIdSchema.safeParse(runId);
  if (!attempt.success || !run.success) return reportAttempt(config, runId, report, secrets);
  const finished = async (held: RunLock): Promise<WorkflowEnvelope> => {
    const place = await finishPlace({ config, lock: held, attempt: attempt.data, outcome: report.outcome });
    const failure = place === 'unmanaged' ? undefined : place.failure;
    return reportAttempt(config, runId, failure ? { ...report, outcome: 'failed', message: failure.message, failure } : report, secrets);
  };
  return lock ? finished(lock) : withRunLock(config, run.data, finished, { waitMs: 0 });
}

/** The outputs a command step reports: its whole stdout, when that is JSON. */
export function commandOutputs(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}
