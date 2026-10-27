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
import { isNameShaped, type RecordedAgent } from '../agent-observation.js';
import { loadTeamConfig } from '../config.js';
import type { LocalConfig } from '../types.js';
import { getDataHome, isUsageReportEnabled } from '../types.js';
import { log } from '../utils/logger.js';
import { redactJson } from '../utils/redact.js';
import { acquireLock, releaseLock } from '../update.js';
import { isLaunchTool } from '../tool-launch/tools.js';
import type { RunMode } from '../launch-context.js';
import { uniqueOutcomes, type WorkOutcome } from '../outcomes.js';
import { stepDefinitions } from './scope.js';
import { snapshotPath } from './snapshot.js';
import { installOwner, runLockPath } from './store.js';
import { settled, visibleOutcome, type StepPass, type StepState, type VisibleOutcome } from './step-state.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import { LIMIT_FAILURES, type Unenforced } from './requirements.js';
import type { DriverIdentity, RunState, RunStatus, WorkflowFailure } from './types.js';

/**
 * The failure codes the engine writes, then those the local driver sets. A code a model writes into its result, or
 * another driver reports, can be any text, so a record carries only these.
 */
const RECORDED_FAILURES = [
  'cancelled', 'hitl_required',
  'loop_exhausted', 'invalid_output', 'invalid_template', 'invalid_inputs', 'invalid_items', 'item_cycle',
  'tool_failed', 'tool_unavailable', 'agent_unavailable', 'model_unavailable', 'read_only_dirty', 'tool_unconfigured', 'tool_unsupported',
  'merge_conflict', 'base_config', 'push_failed', 'workspace_base', 'bad_session',
  ...LIMIT_FAILURES,
  'delivery_failed', 'protected_path',
] as const;
type RecordedFailure = (typeof RECORDED_FAILURES)[number];

function isRecordedFailure(failure: WorkflowFailure | undefined): failure is WorkflowFailure & { code: RecordedFailure } {
  return failure !== undefined && (RECORDED_FAILURES as readonly string[]).includes(failure.code);
}

/** The record's schema tag; see #1083 for the field contract. */
export type WorkflowRunRecord = {
  schemaVersion: 'v1alpha1';
  /** The run's logical key; a retry publishes the same id. */
  run: string;
  workflow: string;
  /** Exact workflow and prompt bytes that ran. Absent on records published before source provenance. */
  sourceHash?: string;
  /** Remote-reachable team commit that stores those bytes, when one commit stores the whole workflow tree. */
  teamRevision?: string;
  /** Which publication wrote this record; the end phase completes the file. */
  phase: 'start' | 'end';
  /** The run mode `workflow start` resolved. Absent on runs started before it was recorded. */
  runMode?: RunMode;
  /**
   * Driver kind only. The workspace is a local path (banned, #1083) and the
   * hostname is machine-identifying (#1126 review) — neither is published.
   */
  driver?: { kind: string };
  status: RunStatus;
  /** The named end the run reached, when it reached one. */
  end?: string;
  /** Why a run that reached no end failed, such as `loop_exhausted`. Code only: the message is free text. */
  failure?: { code: RecordedFailure };
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /**
   * Per-step entries (#1083: step, agent, tool/model, outcome, tokens) — a
   * run whose implementer runs on Codex and reviewer on Claude records each
   * step's own fields. A skipped step, which never ran, carries no outcome.
   * Every entry has its `pass`, 1 for a step that ran once. A step a loop ran
   * more than once has an entry per pass, so the entries hold the tokens of
   * every pass once.
   */
  steps?: Array<{
    step: string;
    pass: number;
    /** What the pass ran as (#1176); only the definition's name for a pass nothing observed. */
    agent?: RecordedAgent;
    tool?: string;
    model?: string;
    outcome?: Exclude<VisibleOutcome, 'skipped'>;
    tokens?: TokenUsage;
    /** Answer provenance only; free-text notes and answer times stay local. */
    answer?: Pick<NonNullable<StepPass['answer']>, 'choice' | 'channel' | 'agent'>;
    /** The best-effort requirements the pass's driver could not enforce. */
    unenforced?: Unenforced[];
    /** The run mode of the driver that ran the pass. Absent on passes settled before it was recorded. */
    runMode?: RunMode;
    /** What the pass delivered (#1387): the commits on its branch, its pull request, what its own commands reported. */
    outcomes?: WorkOutcome[];
  }>;
  /**
   * Counts of the step instances the run ended with, by status. A step a loop
   * ran again counts once, as its last pass ended.
   */
  stepCounts?: { total: number; succeeded: number; failed: number; skipped: number; cancelled: number };
  /** Settled attempts across the run — the cumulative iteration count. */
  iterations?: number;
  /** The pull requests the run delivered, in the order they first appeared. Public on a public team repo; absent when it delivered none. */
  prs?: string[];
  username: string;
  publishedAt: string;
};

/** A record built by this version; readers also accept legacy records without source provenance. */
export type CurrentWorkflowRunRecord = WorkflowRunRecord & { sourceHash: string };

type StepEntry = NonNullable<WorkflowRunRecord['steps']>[number];

/** What one pass of a step reported. */
type Reported = Pick<StepPass, 'outcome' | 'tool' | 'model' | 'tokens' | 'agent' | 'answer' | 'unenforced' | 'runMode' | 'changes' | 'outcomes'>;

/** The directory on the reports branch that holds every run record. */
export const RECORDS_DIR = 'workflows/runs';

/** A record's path on the reports branch, keyed by run id. */
export function recordPath(runId: string): string {
  return `${RECORDS_DIR}/${runId}.json`;
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
): CurrentWorkflowRunRecord {
  return {
    schemaVersion: 'v1alpha1',
    run: run.id,
    workflow: run.name,
    sourceHash: run.sourceHash,
    ...(run.teamRevision ? { teamRevision: run.teamRevision } : {}),
    phase: 'start',
    ...(run.runMode ? { runMode: run.runMode } : {}),
    // A start record may have no driver yet (a remote driver leases later);
    // the end record always carries the driver that completed the run.
    // Kind only: the workspace is a banned local path and the hostname is
    // machine-identifying (#1126 review).
    ...(driver ? { driver: { kind: driver.kind } } : {}),
    status: 'running',
    startedAt: run.createdAt,
    username,
    publishedAt: iso(now),
  };
}

/**
 * Why a run that reached no end failed, as the first failure with a code teamai sets: the run's own, from a looping
 * workflow that ran out, else that of the top-level step that failed first, else the first one under that step.
 */
function failureOf(run: RunState): RecordedFailure | undefined {
  if (run.status !== 'failed' || run.end !== undefined) return undefined;
  if (isRecordedFailure(run.failure)) return run.failure.code;
  const failed = run.steps
    .filter((step): step is Extract<StepState, { status: 'failed' | 'cancelled' }> => step.status === 'failed' || step.status === 'cancelled')
    .sort((left, right) => left.settledAt - right.settledAt);
  const top = new Set(run.definition.steps.map((step) => step.id));
  const first = failed.find((step) => top.has(step.id));
  if (!first) return undefined;
  const under = (step: StepState): boolean => step.id.startsWith(`${first.id}.`) || step.id.startsWith(`${first.id}[`);
  return [first, ...failed.filter(under)].map((step) => step.failure).find(isRecordedFailure)?.code;
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
): CurrentWorkflowRunRecord {
  const started = Date.parse(run.createdAt);
  const ended = Date.parse(run.updatedAt);
  const count = (status: StepState['status']): number => run.steps.filter((step) => step.status === status).length;
  const failure = failureOf(run);
  // An entry per pass: path, and what that pass reported. Message, outputs,
  // results, and session ids never cross.
  const definitionOf = stepDefinitions(run);
  const entry = (step: string, pass: number | undefined, reported: Reported | undefined): StepEntry => {
    const name = definitionOf(step)?.agent;
    const agent = reported?.agent ?? (name ? { definition: { name } } : undefined);
    const outcome = reported?.outcome === 'skipped' ? undefined : reported?.outcome;
    const outcomes = uniqueOutcomes([
      ...(reported?.changes?.commits ?? []).map((sha): WorkOutcome => ({ kind: 'commit', sha })),
      ...(run.deliveries ?? []).filter((receipt) => receipt.step === step && receipt.pass === (pass ?? 1)).map((receipt): WorkOutcome => ({ kind: 'pr', url: receipt.url })),
      ...(reported?.outcomes ?? []),
    ]);
    return {
      step,
      ...(reported?.answer ? { answer: { choice: reported.answer.choice, channel: reported.answer.channel, agent: reported.answer.agent } } : {}),
      pass: pass ?? 1,
      ...(agent ? { agent } : {}),
      ...(reported?.tool && isLaunchTool(reported.tool) ? { tool: reported.tool } : {}),
      ...(reported?.model && isNameShaped(reported.model) ? { model: reported.model } : {}),
      ...(outcome ? { outcome } : {}),
      ...(reported?.tokens ? { tokens: reported.tokens } : {}),
      ...(reported?.unenforced ? { unenforced: reported.unenforced } : {}),
      ...(reported?.runMode ? { runMode: reported.runMode } : {}),
      ...(outcomes.length > 0 ? { outcomes } : {}),
    };
  };
  // A loop keeps a step's earlier passes in `passes`, and the passes of the
  // instances it removed from the run, such as the items of a for_each it ran
  // again, in `archive`.
  const steps = [
    ...run.steps.flatMap((step) => [
      ...(step.passes ?? []).map((earlier) => entry(step.id, earlier.pass, earlier)),
      entry(step.id, step.pass, settled(step) ? { ...step, outcome: visibleOutcome(step) } : undefined),
    ]),
    ...(run.archive ?? []).map((archived) => entry(archived.step, archived.pass, archived)),
  ];
  // Receipts are what delivery recorded, never a step's outputs, and each URL appears once.
  const prs = (run.deliveries ?? []).map((receipt) => receipt.url);
  return {
    ...buildStartRecord(run, driver, username, now),
    phase: 'end',
    status: run.status,
    ...(run.end !== undefined ? { end: run.end } : {}),
    ...(failure ? { failure: { code: failure } } : {}),
    endedAt: run.updatedAt,
    ...(Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? { durationMs: ended - started }
      : {}),
    steps,
    stepCounts: {
      total: run.steps.length,
      succeeded: count('succeeded'),
      failed: count('failed'),
      skipped: count('skipped'),
      cancelled: count('cancelled'),
    },
    // Cumulative when present; runs from before the counter fall back to the
    // bounded history length (their true count is unknowable now).
    iterations: run.settledCount ?? run.settledAttempts.length,
    ...(prs.length ? { prs } : {}),
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
  const merged = { ...origin, ...next, startedAt: origin.startedAt };
  if (next.end === undefined) delete merged.end;
  if (next.failure === undefined) delete merged.failure;
  if (next.prs === undefined) delete merged.prs;
  return merged;
}

/** Whether a run record was delivered or still waits in the local queue. */
export type RecordState = 'published' | 'pending';

/** The opt-out `pull` applies to stat commits covers run records too: the member's `usageReportEnabled`, else teamai.yaml `usageReport`. */
async function isRecordingEnabled(config: LocalConfig): Promise<boolean> {
  return isUsageReportEnabled(config, (await loadTeamConfig(config.repo.localPath)) ?? {});
}

/**
 * Build and queue a run's phase record (#1083). True once the record is in
 * the queue; false with usage reporting off, or when it could not be queued,
 * which logs a warning and never fails the run operation that produced it.
 * Queueing writes only local files, so it may run under the run lock.
 */
export async function queueRunRecord(
  config: LocalConfig,
  run: RunState,
  driver: DriverIdentity | undefined,
  phase: 'start' | 'end',
  secrets: Record<string, string>,
): Promise<boolean> {
  try {
    if (!await isRecordingEnabled(config)) return false;
    const username = config.username ?? 'unknown';
    const record = phase === 'start'
      ? buildStartRecord(run, driver, username)
      : buildEndRecord(run, driver, username);
    await enqueueRecord(config, record, secrets);
    return true;
  } catch (error) {
    log.warn(`[workflows] Could not queue the ${phase} record of run ${run.id}, so the team report will not include it: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Try to publish the queued records. A record is queued before this attempt,
 * so a crash mid-publish leaves it for the next pull. Publication failures —
 * no remote, a busy reports lock, a rejected push — surface as `'pending'`
 * and never fail the run operation that queued the record.
 */
export async function publishRunRecords(config: LocalConfig): Promise<RecordState> {
  try {
    return (await publishPendingRecords(config)).state;
  } catch {
    return 'pending';
  }
}

/** The record state of a run that settled earlier: none when it queued no end record, pending while any of its records waits in the queue. */
export async function runRecordState(config: LocalConfig, run: RunState): Promise<RecordState | undefined> {
  return (await runRecordStates(config, [run])).get(run.id);
}

/** `runRecordState` of several runs, reading the team config and the queue once for all of them. */
export async function runRecordStates(config: LocalConfig, runs: RunState[]): Promise<Map<string, RecordState>> {
  const queued = runs.filter((run) => run.endRecordQueued);
  if (queued.length === 0 || !await isRecordingEnabled(config)) return new Map();
  const pending = new Set((await pendingRecords(config)).map((record) => record.run));
  return new Map(queued.map((run): [string, RecordState] => [run.id, pending.has(run.id) ? 'pending' : 'published']));
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
export async function enqueueRecord(config: LocalConfig, record: CurrentWorkflowRunRecord, secrets: Record<string, string>): Promise<void> {
  const dir = pendingDir(config);
  await fs.mkdir(dir, { recursive: true });
  const target = pendingPath(config, record);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(redactJson(record, secrets), null, 2)}\n`, 'utf-8');
  await fs.rename(tmp, target);
}

/** Removes the provisional end of a reopened run so a later drain cannot publish it. */
export async function removeQueuedEndRecord(config: LocalConfig, runId: string): Promise<void> {
  await fs.rm(path.join(pendingDir(config), `${runId}.end.json`), { force: true });
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
  const lock = runLockPath(config, record.run);
  if (!await acquireLock(lock)) return;
  try {
    const target = pendingPath(config, record);
    let current: WorkflowRunRecord;
    try {
      current = JSON.parse(await fs.readFile(target, 'utf-8')) as WorkflowRunRecord;
    } catch {
      return;
    }
    if (current.phase === record.phase && current.endedAt === record.endedAt) await fs.rm(target, { force: true });
  } finally {
    await releaseLock(lock);
  }
}

/** Whether a drain delivered the records it took, and when it did not, why they are still queued. */
export type RecordDelivery = { state: 'published' } | { state: 'pending'; reason: string };

/**
 * Publish every queued record, or only run `options.run`'s, through the reports branch, then fold their
 * totals into each record's own member stats file in the same update. The records of a run that origin shows
 * another install owns are dropped instead: they describe this machine's copy, which that install's records replace.
 *
 * Pending when the update did not land, or when a delivered run+phase path was queued again meanwhile;
 * the engine surfaces that as `record: pending` (#1083). Records queued at other paths during delivery
 * do not affect it.
 */
export async function publishPendingRecords(config: LocalConfig, options: { run?: string } = {}): Promise<RecordDelivery> {
  const queued = (await pendingRecords(config)).filter((record) => options.run === undefined || record.run === options.run);
  if (queued.length === 0) return { state: 'published' };
  const { updateReports, readReportsOriginFile } = await import('../utils/reports-branch.js');
  const install = (await installOwner(config)).id;
  const outcome = await updateReports(config, async (worktree) => {
    const files: string[] = [];
    const byRun = new Map<string, WorkflowRunRecord[]>();
    for (const record of queued) {
      if (ownedElsewhere(await readReportsOriginFile(worktree, snapshotPath(record.run)), install)) continue;
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
    // merge counts only what this update delivered. Each total lands in the
    // stats file of the member who ran it, not of whoever drains the queue.
    // An end that replaces another member's end also moves that run out of
    // the other member's totals.
    const { default: YAML } = await import('yaml');
    const delta = statsDeltaRecords(originByRun, delivered);
    const usernames = new Set(delta.flatMap((record) => {
      const origin = originByRun.get(record.run);
      return origin?.phase === 'end' ? [record.username, origin.username] : [record.username];
    }));
    for (const username of usernames) {
      const statsRel = `stats/${username}.yaml`;
      const existingStatsRaw = await readReportsOriginFile(worktree, statsRel);
      let existingStats: Record<string, unknown> = {};
      if (existingStatsRaw !== null && existingStatsRaw.trim() !== '') {
        try {
          existingStats = YAML.parse(existingStatsRaw) as Record<string, unknown>;
        } catch {
          existingStats = {};
        }
      }
      const mergedStats = mergeWorkflowStats(ensureStatsShape(existingStats, username), username, delta, originByRun);
      await fs.mkdir(path.join(worktree, 'stats'), { recursive: true });
      await fs.writeFile(path.join(worktree, statsRel), YAML.stringify(mergedStats), 'utf-8');
      files.push(statsRel);
    }
    return {
      files: [...new Set(files)],
      message: `[teamai] Publish ${byRun.size} workflow run record${byRun.size === 1 ? '' : 's'}`,
    };
  });
  switch (outcome.status) {
    case 'published':
    case 'already-present': {
      for (const record of queued) await dequeue(config, record);
      const remaining = new Set(await fs.readdir(pendingDir(config)).catch(() => []));
      return queued.some((record) => remaining.has(path.basename(pendingPath(config, record))))
        ? { state: 'pending', reason: 'a record of the same run was still queued after they were delivered' }
        : { state: 'published' };
    }
    case 'busy':
      return { state: 'pending', reason: 'another teamai process is writing teamai-reports' };
    case 'failed':
      return { state: 'pending', reason: outcome.reason };
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** Whether `snapshot`, a run's published state as origin holds it, names an install other than `install` as its owner. */
function ownedElsewhere(snapshot: string | null, install: string): boolean {
  if (snapshot === null) return false;
  try {
    const value: unknown = JSON.parse(snapshot);
    if (typeof value !== 'object' || value === null || !('owner' in value)) return false;
    const { owner } = value;
    return typeof owner === 'object' && owner !== null && 'id' in owner && typeof owner.id === 'string' && owner.id !== install;
  } catch {
    return false;
  }
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
 * Fold `username`'s end-phase records into that member's workflow totals,
 * additively, preserving every unrelated stats field (the #1056 preservation
 * discipline). Records of other members are skipped.
 *
 * Idempotent against a queue replay: an end record whose run total already
 * appears is not counted twice. An end that replaces a different end on origin
 * (a retried run that ended again) withdraws that end's run, outcome and
 * duration from the totals of the member who published it, so a run counts
 * once, for the member whose end origin holds. A cancelled run counts toward
 * runs and duration only.
 */
export function mergeWorkflowStats(
  existing: Record<string, unknown>,
  username: string,
  records: WorkflowRunRecord[],
  originByRun: ReadonlyMap<string, WorkflowRunRecord | null> = new Map(),
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
  const fold = (record: WorkflowRunRecord, sign: 1 | -1): void => {
    if (record.username !== username) return;
    runs += sign;
    if (record.status === 'succeeded') succeeded += sign;
    if (record.status === 'failed') failed += sign;
    totalDurationMs += sign * (record.durationMs ?? 0);
  };
  for (const record of byRun.values()) {
    if (record.phase !== 'end') continue;
    const origin = originByRun.get(record.run);
    if (origin?.phase === 'end') {
      if (origin.endedAt === record.endedAt) continue;
      fold(origin, -1);
    }
    fold(record, 1);
  }
  return { ...existing, workflows: { runs, succeeded, failed, totalDurationMs } };
}

/**
 * The records whose totals still need folding into stats: an end-phase record
 * whose run already shows the same end on origin was counted by the delivery
 * that first published it, so a queue replay must not count it again. An end
 * with a different `endedAt` replaces the one on origin. Pure function of the
 * merge base, so the idempotency is testable without git.
 */
export function statsDeltaRecords(
  originByRun: Map<string, WorkflowRunRecord | null>,
  records: WorkflowRunRecord[],
): WorkflowRunRecord[] {
  return records.filter((record) => {
    if (record.phase !== 'end') return false;
    const origin = originByRun.get(record.run);
    return origin?.phase !== 'end' || origin.endedAt !== record.endedAt;
  });
}
