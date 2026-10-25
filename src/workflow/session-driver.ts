import path from 'node:path';
import { z } from 'zod';
import { acquireLock, releaseLock } from '../update.js';
import { getDataHome, type LocalConfig } from '../types.js';
import type { WorkflowEnv } from '../env-resolution.js';
import { pathExists, readFileSafe, writeJsonAtomic } from '../utils/fs.js';
import { leaseNext, reportAttempt, type ReportInput } from './engine.js';
import { finishSessionWorkspace, prepareSessionWorkspace, type PreparedSessionWorkspace } from './drivers/local/local-driver.js';
import { DriverSchema } from '../driver-identity.js';
import { driverLockPath, readRun } from './store.js';
import type { DriverIdentity, WorkflowEnvelope } from './types.js';
import { removeWorktree, worktreePath } from './worktree.js';

const CommitSchema = z.object({ commit: z.string(), ref: z.string().optional() });
const WorkspaceSchema = z.object({
  mode: z.enum(['read-only', 'new', 'continue']), base: CommitSchema, configCommit: z.string(),
  branch: z.string(), start: z.object({ commit: z.string(), branch: z.string().optional() }),
  merge: z.array(z.object({ branch: z.string(), commit: z.string() })),
});
const PreparedSchema = z.object({
  driver: DriverSchema, active: z.string(),
  step: z.string(), attempt: z.string(), revision: z.number(), cwd: z.string(),
  workspace: WorkspaceSchema.optional(),
  interactive: z.literal(true).optional(), readOnly: z.literal(true).optional(),
  before: z.object({ ok: z.boolean(), head: z.string().optional(), branch: z.string(), files: z.array(z.tuple([z.string(), z.string()])) }).optional(),
  found: z.array(z.string()).optional(), overlay: z.string().optional(), rangeFrom: z.string().optional(),
  conflicts: z.array(z.tuple([z.string(), z.string()])).optional(),
});

function marker(config: LocalConfig, run: string, attempt: string): string | undefined {
  return /^a[0-9a-f]{8}$/.test(attempt) ? path.join(getDataHome(config), 'workflows', 'runs', run, 'attempts', attempt, 'workspace.json') : undefined;
}
function same(left: DriverIdentity, right: DriverIdentity): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}
async function locked(config: LocalConfig, run: string, fn: () => Promise<WorkflowEnvelope>): Promise<WorkflowEnvelope> {
  const lock = driverLockPath(config, run);
  if (!await acquireLock(lock)) return { error: { code: 'driver_running', message: `Run ${run} has another driver preparing or running work` } };
  try { return await fn(); } finally { await releaseLock(lock); }
}

/** Opt-in public next preparation. The original checkout, not the caller's cwd, owns all git operations. */
export async function prepareSessionLease(config: LocalConfig, runId: string, driver: DriverIdentity, raw: Record<string, unknown>, env: WorkflowEnv): Promise<WorkflowEnvelope> {
  return locked(config, runId, async () => {
    const run = await readRun(config, runId);
    if (typeof run !== 'object' || !run.checkout) return { error: { code: 'workspace_base', message: `Run ${runId} has no retained checkout; start a new run in the product repository` } };
    const state = run.steps.find((step) => step.status === 'leased' && step.attempt === raw.attempt);
    if (state?.status !== 'leased' || !same(state.lease.driver, driver)) return { error: { code: 'lease_cancelled', message: 'This attempt is no longer leased to this driver' } };
    const file = marker(config, runId, state.attempt);
    if (!file) return { error: { code: 'run_unreadable', message: 'The leased attempt id cannot identify a prepared workspace' } };
    const previous = await readFileSafe(file);
    if (previous !== null) {
      try {
        const saved = PreparedSchema.parse(JSON.parse(previous));
        if (same(saved.driver, driver) && saved.revision === state.lease.revision && saved.attempt === state.attempt && saved.step === state.id && saved.active === run.checkout) return { data: { lease: { ...raw, cwd: saved.cwd } } };
      } catch { /* Never reapply an overlay over work after a corrupt preparation record. */ }
      return { error: { code: 'workspace_base', message: 'The prepared workspace record is unreadable; preserve the worktree before retrying' } };
    }
    const prepared = await prepareSessionWorkspace(raw, run.checkout, runId, env.values, path.join(path.dirname(file), 'overlay'));
    if ('code' in prepared) {
      await reportAttempt(config, runId, { attempt: state.attempt, revision: state.lease.revision, driver, outcome: 'failed', failure: prepared, message: prepared.message }, env.secrets);
      return { error: prepared };
    }
    await writeJsonAtomic(file, { ...prepared, driver, active: run.checkout });
    return { data: { lease: { ...raw, cwd: prepared.cwd } } };
  });
}

/** Returns undefined for a driver that did not opt into public CLI preparation. */
export async function reportSessionLease(config: LocalConfig, runId: string, report: ReportInput, env: WorkflowEnv): Promise<WorkflowEnvelope | undefined> {
  const file = marker(config, runId, report.attempt);
  if (!file) return undefined;
  if (!await pathExists(file)) return undefined;
  return locked(config, runId, async () => {
    let run = await readRun(config, runId);
    if (typeof run === 'object') {
      const running = run.steps.filter((step) => step.status === 'leased' && same(step.lease.driver, report.driver)).map((step) => step.status === 'leased' ? step.attempt : '');
      const polled = await leaseNext(config, runId, report.driver, { running, canTakeLease: false, env });
      if ('error' in polled) return polled;
      run = await readRun(config, runId);
    }
    const active = typeof run === 'object' && run.steps.find((step) => step.status === 'leased' && step.attempt === report.attempt);
    // Reject stale/cancelled/repeated reports before touching the worktree.
    if (!active || active.status !== 'leased' || active.lease.revision !== report.revision || !same(active.lease.driver, report.driver)) return reportAttempt(config, runId, report, env.secrets);
    let prepared: z.infer<typeof PreparedSchema>;
    try { prepared = PreparedSchema.parse(JSON.parse((await readFileSafe(file)) ?? 'null')); }
    catch { return { error: { code: 'workspace_base', message: 'The prepared workspace record is unreadable; preserve the worktree before retrying' } }; }
    if (!same(prepared.driver, report.driver)) return { error: { code: 'wrong_driver', message: 'This prepared workspace belongs to another driver' } };
    if (prepared.attempt !== report.attempt || prepared.revision !== report.revision || prepared.step !== active.id || (typeof run === 'object' && run.checkout !== prepared.active)) return { error: { code: 'workspace_base', message: 'The prepared workspace no longer matches this attempt' } };
    const expected = prepared.workspace ? worktreePath(prepared.active, prepared.workspace.branch) : prepared.active;
    if (path.resolve(expected) !== path.resolve(prepared.cwd)) return { error: { code: 'workspace_base', message: 'The prepared directory does not match the leased workspace' } };
    if (report.changes || report.read) return { error: { code: 'invalid_report', message: 'Prepared workspace reports fill changes/read automatically; omit those fields' } };
    const metadata = prepared as PreparedSessionWorkspace & { active: string };
    const body = await finishSessionWorkspace(metadata, report);
    await writeJsonAtomic(file, prepared);
    const answer = await reportAttempt(config, runId, body, env.secrets);
    if ('data' in answer && answer.data.cleanup === true && body.outcome === 'success' && metadata.cwd) await removeWorktree(metadata.active, metadata.cwd);
    return answer;
  });
}
