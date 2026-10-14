/**
 * Privacy-preserving workflow run records on `teamai-reports` (#1083).
 *
 * Every driver gets the same durable run history: one record per run,
 * published once when the run starts and once when it ends, keyed by run id
 * so retries upsert instead of duplicating.
 *
 * Redaction is structural, not filtering: a record is built exclusively from
 * the allowlisted fields below — workflow, step counts, driver identity, run
 * status, timings, iterations, and the optional agent/model fields. Nothing
 * outside the allowlist has a field to land in, so prompts, command text,
 * outputs, diffs, secret values, and local workspace paths cannot appear even
 * when the underlying `RunState`/`DriverIdentity` carries them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalConfig } from '../types.js';
import { getDataHome } from '../types.js';
import type { DriverIdentity, RunState, RunStatus } from './types.js';

/** The record's schema tag; see #1083 for the field contract. */
export type WorkflowRunRecord = {
  schemaVersion: 'v1alpha1';
  /** The run's logical key; a retry publishes the same id. */
  run: string;
  workflow: string;
  /** Which publication wrote this record; the end phase completes the file. */
  phase: 'start' | 'end';
  /** Driver identity without the workspace: a local path is banned (#1083). */
  driver?: { kind: string; machine: string };
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  steps?: { total: number; succeeded: number; failed: number };
  /** Settled attempts across the run — the iteration count. */
  iterations?: number;
  /** Optional agent fields (SaulMoro, #1083): comparable aliases + pricing input. */
  tool?: string;
  model?: string;
  modelAlias?: string;
  /** Scorer labels (#1085) when they exist; `source` keeps sessions pluggable later. */
  labels?: Array<{ scorer: string; label: string; agent?: string; model?: string; source: 'workflow' }>;
  teamRevision?: string;
  prUrl?: string;
  ciJobUrl?: string;
  username: string;
  publishedAt: string;
};

/** A record's path on the reports branch, keyed by run id. */
export function recordPath(runId: string): string {
  return `workflows/runs/${runId}.json`;
}

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * Build the start-phase record. Only allowlisted fields are read off the
 * `RunState`/`DriverIdentity`; step outputs, messages, and the driver's
 * workspace are never touched.
 */
export function buildStartRecord(
  run: RunState,
  driver: DriverIdentity | undefined,
  username: string,
  now: Date = new Date(),
): WorkflowRunRecord {
  return {
    schemaVersion: 'v1alpha1',
    run: run.id,
    workflow: run.name,
    phase: 'start',
    // A start record may have no driver yet (a remote driver leases later);
    // the end record always carries the driver that completed the run.
    ...(driver ? { driver: { kind: driver.kind, machine: driver.machine } } : {}),
    status: 'running',
    startedAt: run.createdAt,
    username,
    publishedAt: iso(now),
  };
}

/**
 * Build the end-phase record: outcome, duration, iterations, and step counts,
 * all derived as counts so no step payload crosses into the record.
 */
export function buildEndRecord(
  run: RunState,
  driver: DriverIdentity | undefined,
  username: string,
  now: Date = new Date(),
): WorkflowRunRecord {
  const started = Date.parse(run.createdAt);
  const ended = Date.parse(run.updatedAt);
  const succeeded = run.steps.filter((step) => step.status === 'succeeded').length;
  const failed = run.steps.filter((step) => step.status === 'failed').length;
  return {
    ...buildStartRecord(run, driver, username, now),
    phase: 'end',
    status: run.status,
    endedAt: run.updatedAt,
    ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? { durationMs: ended - started }
      : {}),
    steps: { total: run.steps.length, succeeded, failed },
    // Cumulative when present; runs from before the counter fall back to the
    // bounded history length (their true count is unknowable now).
    iterations: run.settledCount ?? run.settledAttempts.length,
  };
}

/**
 * Merge a retried publication against what origin already holds.
 *
 * The end phase is terminal: once a run is ended, a queued start re-arriving
 * (both phases enqueued before a crash) must not resurrect a
 * started-but-not-ended view. Start fields are preserved from whichever record
 * carries them; identity fields come from the newer publication.
 */
export function mergeRecord(origin: WorkflowRunRecord | null, next: WorkflowRunRecord): WorkflowRunRecord {
  if (!origin) return next;
  if (origin.phase === 'end' && next.phase === 'start') return origin;
  return { ...origin, ...next, startedAt: origin.startedAt };
}

/**
 * Build, queue, and try to publish a run's phase record (#1083).
 *
 * The enqueue happens before the publish attempt, so a crash mid-publish
 * leaves the record queued for the next pull. Publication failures — no
 * remote, a busy reports lock, a rejected push — surface as `'pending'` and
 * never fail the run operation that produced the record.
 */
export async function noteRunRecord(
  config: LocalConfig,
  run: RunState,
  driver: DriverIdentity | undefined,
  phase: 'start' | 'end',
): Promise<'published' | 'pending'> {
  try {
    const username = config.username ?? 'unknown';
    const record = phase === 'start'
      ? buildStartRecord(run, driver, username)
      : buildEndRecord(run, driver, username);
    await enqueueRecord(config, record);
    return await publishPendingRecords(config, username);
  } catch {
    return 'pending';
  }
}

// ─── Local pending queue ────────────────────────────────
//
// A failed publication is queued under the data home and retried on the next
// pull (#1083): the queue is plain JSON files, so it survives restarts, and a
// publication crash cannot corrupt the run state that produced the record.

function pendingDir(config: LocalConfig): string {
  return path.join(getDataHome(config), 'workflows', 'pending');
}

function pendingPath(config: LocalConfig, record: WorkflowRunRecord): string {
  return path.join(pendingDir(config), `${record.run}.${record.phase}.json`);
}

/** Queue a record for (re)publication; the write is atomic per file. */
export async function enqueueRecord(config: LocalConfig, record: WorkflowRunRecord): Promise<void> {
  const dir = pendingDir(config);
  await fs.mkdir(dir, { recursive: true });
  const target = pendingPath(config, record);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  await fs.rename(tmp, target);
}

/** All queued records, oldest file first for stable drain order. */
export async function pendingRecords(config: LocalConfig): Promise<WorkflowRunRecord[]> {
  const dir = pendingDir(config);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const records: WorkflowRunRecord[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as WorkflowRunRecord);
    } catch {
      // A corrupt queue entry must not wedge the whole queue: the next enqueue
      // of the same run+phase overwrites it.
    }
  }
  return records;
}

async function dequeue(config: LocalConfig, record: WorkflowRunRecord): Promise<void> {
  await fs.rm(pendingPath(config, record), { force: true });
}

/**
 * Publish every queued record through the reports branch, then fold their
 * totals into the user's stats file in the same update.
 *
 * Returns `'published'` when the queue drained (or was empty) and `'pending'`
 * when anything remains queued — the value the engine surfaces as
 * `record: pending` (#1083).
 */
export async function publishPendingRecords(
  config: LocalConfig,
  username: string,
): Promise<'published' | 'pending'> {
  const queued = await pendingRecords(config);
  if (queued.length === 0) return 'published';
  const { updateReports, readReportsOriginFile } = await import('../utils/reports-branch.js');
  const outcome = await updateReports(config, async (worktree) => {
    const files: string[] = [];
    const byRun = new Map<string, WorkflowRunRecord[]>();
    for (const record of queued) {
      const list = byRun.get(record.run) ?? [];
      list.push(record);
      byRun.set(record.run, list);
    }
    const delivered: WorkflowRunRecord[] = [];
    const originByRun = new Map<string, WorkflowRunRecord | null>();
    for (const [runId, records] of byRun) {
      // Upsert per run id: the merge base is what origin holds, so a retry
      // never duplicates the logical record and an end phase stays terminal.
      const rel = recordPath(runId);
      const originRaw = await readReportsOriginFile(worktree, rel);
      let origin: WorkflowRunRecord | null = null;
      try {
        origin = originRaw === null ? null : JSON.parse(originRaw) as WorkflowRunRecord;
      } catch {
        origin = null;
      }
      originByRun.set(runId, origin);
      let merged: WorkflowRunRecord | null = null;
      for (const record of [...records].sort((a, b) => (a.phase === 'end' ? 1 : 0) - (b.phase === 'end' ? 1 : 0))) {
        merged = mergeRecord(merged, record);
      }
      if (origin !== null) {
        merged = mergeRecord(origin, merged!);
      }
      await fs.mkdir(path.join(worktree, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(worktree, rel), `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
      files.push(rel);
      delivered.push(...records);
    }
    // Workflow totals ride the same update: one lock, one push, and the stats
    // merge counts only what this update delivered.
    const statsRel = `stats/${username}.yaml`;
    const { default: YAML } = await import('yaml');
    const existingStatsRaw = await readReportsOriginFile(worktree, statsRel);
    let existingStats: Record<string, unknown> = {};
    if (existingStatsRaw !== null && existingStatsRaw.trim() !== '') {
      try {
        existingStats = YAML.parse(existingStatsRaw) as Record<string, unknown>;
      } catch {
        existingStats = {};
      }
    }
    const mergedStats = mergeWorkflowStats(
      ensureStatsShape(existingStats, username),
      statsDeltaRecords(originByRun, delivered),
    );
    await fs.mkdir(path.join(worktree, 'stats'), { recursive: true });
    await fs.writeFile(path.join(worktree, statsRel), YAML.stringify(mergedStats), 'utf-8');
    files.push(statsRel);
    return {
      files: [...new Set(files)],
      message: `[teamai] Publish ${byRun.size} workflow run record${byRun.size === 1 ? '' : 's'}`,
    };
  });
  const { isDelivered } = await import('../utils/branch-worktree.js');
  if (isDelivered(outcome)) {
    for (const record of queued) await dequeue(config, record);
    return 'published';
  }
  return 'pending';
}

// ─── Stats totals ───────────────────────────────────────

/**
 * Guarantee the fields digest's loadTeamStats requires (`username` AND
 * `skills`). A member whose first report is a workflow run — no usage events,
 * no session stats — still gets a digest-visible stats file (#1126 P1).
 * An existing well-formed stats object passes through untouched.
 */
export function ensureStatsShape(
  existing: Record<string, unknown>,
  username: string,
): Record<string, unknown> {
  if (existing.username === username && existing.skills) return existing;
  return {
    updatedAt: new Date().toISOString(),
    ...existing,
    ...(existing.username === username ? {} : { username }),
    ...(existing.skills ? {} : { skills: {} }),
  };
}

export interface WorkflowStats {
  runs: number;
  succeeded: number;
  failed: number;
  totalDurationMs: number;
}

/**
 * Fold end-phase records into the user's workflow totals, additively,
 * preserving every unrelated stats field (the #1056 preservation discipline).
 *
 * Idempotent against a queue replay: an end record whose run total already
 * appears is not counted twice — the delivery-merge guarantees one record file
 * per run, and the stats side derives from the same per-run collapse.
 */
export function mergeWorkflowStats(
  existing: Record<string, unknown>,
  records: WorkflowRunRecord[],
): Record<string, unknown> {
  const current = (existing.workflows ?? {}) as Partial<WorkflowStats>;
  const byRun = new Map<string, WorkflowRunRecord>();
  for (const record of records) {
    const prior = byRun.get(record.run);
    // End phase wins within one delivery; a start-only run has not ended yet
    // and is not counted as a run.
    if (!prior || (prior.phase === 'start' && record.phase === 'end')) byRun.set(record.run, record);
  }
  let { runs = 0, succeeded = 0, failed = 0, totalDurationMs = 0 } = current;
  for (const record of byRun.values()) {
    if (record.phase !== 'end') continue;
    runs += 1;
    if (record.status === 'succeeded') succeeded += 1;
    if (record.status === 'failed') failed += 1;
    totalDurationMs += record.durationMs ?? 0;
  }
  return { ...existing, workflows: { runs, succeeded, failed, totalDurationMs } };
}

/**
 * The records whose totals still need folding into stats: an end-phase record
 * whose run already shows an end phase on origin was counted by the delivery
 * that first published it, so a queue replay must not count it again. Pure
 * function of the merge base, so the idempotency is testable without git.
 */
export function statsDeltaRecords(
  originByRun: Map<string, WorkflowRunRecord | null>,
  records: WorkflowRunRecord[],
): WorkflowRunRecord[] {
  return records.filter((record) => {
    if (record.phase !== 'end') return false;
    const origin = originByRun.get(record.run);
    return !(origin && origin.phase === 'end');
  });
}
