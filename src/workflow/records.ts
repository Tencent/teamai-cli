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
import { z } from 'zod';
import { isRecordableName, type RecordedAgent } from '../agent-observation.js';
import { loadTeamConfig } from '../config.js';
import type { LocalConfig } from '../types.js';
import { getDataHome, isJsonObject, isUsageReportEnabled, type JsonValue } from '../types.js';
import { parseJson } from '../utils/json.js';
import { log } from '../utils/logger.js';
import { redactJson } from '@teamai/shared/redact';
import { acquireLock, releaseLock } from '../update.js';
import { runsSteps } from '../tool-registry.js';
import type { RunMode } from '../launch-context.js';
import type { RunOrigin } from '../default-workflows.js';
import { uniqueOutcomes, type WorkOutcome } from '../outcomes.js';
import { stepDefinitions } from './scope.js';
import { isIsolated, runBranchPrefix } from './workspace.js';
import { snapshotPath } from './snapshot.js';
import { installOwner, isRunId, runLockPath } from './store.js';
import { settled, visibleOutcome, type StepPass, type StepState, type VisibleOutcome } from './step-state.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import { LIMIT_FAILURES, type Unenforced } from './requirements.js';
import type { DriverIdentity, RunState, RunStatus, WorkflowFailure } from './types.js';
import { definedFields } from '../utils/defined-fields.js';
import { parseYaml } from '../utils/yaml.js';

/**
 * The failure codes the engine writes, then those the local driver sets. A code a model writes into its result, or
 * another driver reports, can be any text, so a record carries only these.
 */
const RECORDED_FAILURES = [
  'cancelled', 'hitl_required',
  'loop_exhausted', 'invalid_output', 'invalid_template', 'invalid_inputs', 'invalid_items', 'item_cycle', 'input_rejected', 'command_failed',
  'tool_failed', 'tool_unavailable', 'agent_unavailable', 'model_unavailable', 'read_only_dirty', 'unreported_changes', 'tool_unconfigured', 'tool_unsupported',
  'merge_conflict', 'base_config', 'push_failed', 'workspace_base', 'bad_session',
  ...LIMIT_FAILURES,
  'delivery_failed', 'protected_path',
  'trial_prepare_failed', 'clone_prepare_failed', 'role_unavailable',
  'confined_invalid', 'confined_tool_unavailable', 'confined_failed', 'confined_reply_invalid', 'confined_report_mismatch', 'confined_unoffered',
] as const;

type RecordedFailure = (typeof RECORDED_FAILURES)[number];

function isRecordedFailure(failure: WorkflowFailure | undefined): failure is WorkflowFailure & { code: RecordedFailure } {
  return failure !== undefined && RECORDED_FAILURES.some((code) => code === failure.code);
}

/** The record's schema tag; see #1083 for the field contract. */
export type WorkflowRunRecord = {
  schemaVersion: 'v1alpha1';
  /** The run's logical key; a retry publishes the same id. */
  run: string;
  workflow: string;
  /** The alias that started the workflow when the run started: the name people use for it. */
  alias?: string;
  /** Exact workflow and prompt bytes that ran. Absent on records published before source provenance. */
  sourceHash?: string;
  /** Remote-reachable team commit that stores those bytes, when one commit stores the whole workflow tree. */
  teamRevision?: string;
  /** Which publication wrote this record; the end phase completes the file. */
  phase: 'start' | 'end';
  /** The run mode `workflow start` resolved. Absent on runs started before it was recorded. */
  runMode?: RunMode;
  /** Whether the run executed the team's workflow or teamai's default, with its version. Absent on runs started before it was recorded. */
  origin?: RunOrigin;
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
  /**
   * Until when what the run left is kept, which its owner's `workflows.retention` set as it ended. `teamai doctor --fix`
   * on another machine removes it only a grace period after this; absent, never.
   */
  retainedUntil?: string;
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
  /**
   * The run branches its pull requests use, the head and, when it is the run's, the base of each; absent when it
   * delivered none. `teamai doctor --fix` keeps them on origin once the run settled longer ago than workflows.retention.
   */
  prBranches?: string[];
  /** The run opens a clone, so it stays on the machine that started it, and its steps are measurements in no workflow total. */
  isolated?: true;
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

/** The directory on the reports branch that holds every benchmark record, one per benchmark run. */
export const BENCHMARK_RECORDS_DIR = 'benchmarks/runs';

/** A benchmark record's path on the reports branch, keyed by run id, so writing it again replaces it. */
export function benchmarkRecordPath(runId: string): string {
  return `${BENCHMARK_RECORDS_DIR}/${runId}.json`;
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
  // A start record may have no driver yet (a remote driver leases later); the end record always carries the driver
  // that completed the run. Kind only: the workspace is a banned local path and the hostname is machine-identifying
  // (#1126 review).
  return definedFields<CurrentWorkflowRunRecord>({
    schemaVersion: 'v1alpha1',
    run: run.id,
    workflow: run.name,
    alias: run.alias,
    sourceHash: run.sourceHash,
    teamRevision: run.teamRevision || undefined,
    phase: 'start',
    runMode: run.runMode || undefined,
    origin: run.origin || undefined,
    isolated: isIsolated(run) ? true : undefined,
    driver: driver ? { kind: driver.kind } : undefined,
    status: 'running',
    startedAt: run.createdAt,
    username,
    publishedAt: iso(now),
  });
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

    return definedFields<StepEntry>({
      step,
      answer: reported?.answer ? { choice: reported.answer.choice, channel: reported.answer.channel, agent: reported.answer.agent } : undefined,
      pass: pass ?? 1,
      agent,
      tool: reported?.tool && runsSteps(reported.tool) ? reported.tool : undefined,
      model: reported?.model && isRecordableName(reported.model) ? reported.model : undefined,
      outcome: outcome || undefined,
      tokens: reported?.tokens || undefined,
      unenforced: reported?.unenforced || undefined,
      runMode: reported?.runMode || undefined,
      outcomes: outcomes.length > 0 ? outcomes : undefined,
    });
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
  const prBranches = pullRequestBranches(run);

  return definedFields<CurrentWorkflowRunRecord>({
    ...buildStartRecord(run, driver, username, now),
    phase: 'end',
    status: run.status,
    end: run.end,
    failure: failure ? { code: failure } : undefined,
    endedAt: run.updatedAt,
    retainedUntil: run.retainedUntil,
    durationMs: Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : undefined,
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
    prs: prs.length ? prs : undefined,
    prBranches: prBranches.length ? prBranches : undefined,
  });
}

/** The fields of a run record on teamai-reports its readers share, from whichever version wrote it. */
export const RunRecordFieldsSchema = z.object({
  run: z.string().refine(isRunId),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']) satisfies z.ZodType<RunStatus>,
  endedAt: z.string().optional(),
  prs: z.array(z.unknown()).optional().catch(undefined),
});

/** The run branches its pull requests use: the branch each came from, and the one it went into when that is the run's. */
export function pullRequestBranches(run: Pick<RunState, 'id' | 'deliveries'>): string[] {
  const own = (branch: string): boolean => branch.startsWith(runBranchPrefix(run.id));

  return [...new Set((run.deliveries ?? []).flatMap((receipt) => [receipt.branch, receipt.base].filter(own)))];
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

  if (next.prBranches === undefined) delete merged.prBranches;

  if (next.retainedUntil === undefined) delete merged.retainedUntil;

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
 * the queue; false with usage reporting off, for a run of a private workflow,
 * which stays on this machine, or when it could not be queued, which logs a
 * warning and never fails the run operation that produced it. Queueing writes
 * only local files, so it may run under the run lock.
 */
export async function queueRunRecord(
  config: LocalConfig,
  run: RunState,
  driver: DriverIdentity | undefined,
  phase: 'start' | 'end',
  secrets: Record<string, string>,
): Promise<boolean> {
  try {
    if (run.definition.private || !await isRecordingEnabled(config)) return false;
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

/** Benchmark records wait apart from run records: they are another kind, which no stats total reads. */
function pendingBenchmarksDir(config: LocalConfig): string {
  return path.join(pendingDir(config), 'benchmarks');
}

/** What the queue reads of a benchmark record: its run. The rest is the benchmark module's, and is published as it is. */
const QueuedBenchmarkSchema = z.object({ run: z.string().min(1) }).passthrough();

type QueuedBenchmark = z.infer<typeof QueuedBenchmarkSchema>;

/**
 * Queues `record`, the benchmark record of run `record.run`, for publication at its own key, when the member's
 * recording allows publication. True once it is in the queue; false with usage reporting off. Queueing it again
 * replaces it, so a report that runs twice queues one record.
 */
export async function queueBenchmarkRecord(config: LocalConfig, record: QueuedBenchmark, secrets: Record<string, string>): Promise<boolean> {
  if (!await isRecordingEnabled(config)) return false;
  const dir = pendingBenchmarksDir(config);
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${record.run}.json`);
  await fs.writeFile(`${target}.tmp`, `${JSON.stringify(redactJson(record, secrets), null, 2)}\n`, 'utf-8');
  await fs.rename(`${target}.tmp`, target);

  return true;
}

/** The runs whose benchmark record waits in this machine's queue: a copy in the reports checkout may not be on its origin yet. */
export async function pendingBenchmarkRuns(config: LocalConfig): Promise<Set<string>> {
  return new Set((await pendingBenchmarks(config)).map(({ record }) => record.run));
}

/** The queued benchmark records, each with the file that holds it. A file that does not read as one is left for its next write. */
async function pendingBenchmarks(config: LocalConfig): Promise<Array<{ file: string; text: string; record: QueuedBenchmark }>> {
  const dir = pendingBenchmarksDir(config);
  const files = (await fs.readdir(dir).catch((): string[] => [])).filter((file) => file.endsWith('.json')).sort();

  const read = await Promise.all(files.map(async (file) => {
    const text = await fs.readFile(path.join(dir, file), 'utf-8').catch(() => undefined);
    const parsed = text === undefined ? undefined : QueuedBenchmarkSchema.safeParse(jsonOrUndefined(text));

    return text !== undefined && parsed?.success ? [{ file: path.join(dir, file), text, record: parsed.data }] : [];
  }));

  return read.flat();
}

/** `text` as a JSON value, or undefined when it is not JSON. */
function jsonOrUndefined(text: string): JsonValue | undefined {
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
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
      // SAFETY: only enqueueRecord writes this directory, and it writes each file from a WorkflowRunRecord.
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
      // SAFETY: only enqueueRecord writes the queue, and it writes each file from a WorkflowRunRecord.
      current = JSON.parse(await fs.readFile(target, 'utf-8')) as WorkflowRunRecord;
    } catch {
      return;
    }

    if (current.phase === record.phase && current.endedAt === record.endedAt) await fs.rm(target, { force: true });
  } finally {
    await releaseLock(lock);
  }
}

/** Removes a delivered benchmark record from the queue, unless it was queued again with other content meanwhile. */
async function dequeueBenchmark({ file, text }: { file: string; text: string }): Promise<void> {
  if (await fs.readFile(file, 'utf-8').catch(() => undefined) === text) await fs.rm(file, { force: true });
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
  const benchmarks = (await pendingBenchmarks(config)).filter(({ record }) => options.run === undefined || record.run === options.run);

  if (queued.length === 0 && benchmarks.length === 0) return { state: 'published' };
  const { updateReports, readReportsOriginFiles } = await import('../utils/reports-branch.js');
  const install = (await installOwner(config)).id;

  const outcome = await updateReports(config, async (worktree) => {
    const files: string[] = [];
    const byRun = new Map<string, WorkflowRunRecord[]>();
    // A queue that origin keeps refusing grows with every run, so its files are read by one git process, not two per run.
    const runIds = [...new Set(queued.map((record) => record.run))];
    const originFiles = await readReportsOriginFiles(worktree, runIds.flatMap((runId) => [snapshotPath(runId), recordPath(runId)]));

    for (const record of queued) {
      if (ownedElsewhere(originFiles.get(snapshotPath(record.run)) ?? null, install)) continue;
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
      const originRaw = originFiles.get(rel) ?? null;
      let origin: WorkflowRunRecord | null = null;

      try {
        // SAFETY: only this function writes record paths on the reports branch, each from a merged WorkflowRunRecord.
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

    const originStats = await readReportsOriginFiles(worktree, [...usernames].map((username) => `stats/${username}.yaml`));

    for (const username of usernames) {
      const statsRel = `stats/${username}.yaml`;
      const existingStatsRaw = originStats.get(statsRel) ?? null;
      let existingStats: MemberStats = {};

      if (existingStatsRaw !== null && existingStatsRaw.trim() !== '') {
        try {
          const document = parseYaml(existingStatsRaw);
          const parsed = MemberStatsSchema.safeParse(document);
          // Spread over the file's own keys, so the update writes them back in the order they were read.
          existingStats = parsed.success && isJsonObject(document) ? { ...document, ...parsed.data } : {};
        } catch {
          existingStats = {};
        }
      }

      const mergedStats = mergeWorkflowStats(ensureDigestFields(existingStats, username), username, delta, originByRun);
      await fs.mkdir(path.join(worktree, 'stats'), { recursive: true });
      await fs.writeFile(path.join(worktree, statsRel), YAML.stringify(mergedStats), 'utf-8');
      files.push(statsRel);
    }

    // A benchmark record replaces what its key holds, and folds into no stats total.
    for (const { record, text } of benchmarks) {
      const rel = benchmarkRecordPath(record.run);
      await fs.mkdir(path.join(worktree, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(worktree, rel), text, 'utf-8');
      files.push(rel);
    }

    const counts = [
      ...(byRun.size > 0 ? [`${byRun.size} workflow run record${byRun.size === 1 ? '' : 's'}`] : []),
      ...(benchmarks.length > 0 ? [`${benchmarks.length} benchmark record${benchmarks.length === 1 ? '' : 's'}`] : []),
    ];

    return {
      files: [...new Set(files)],
      message: `[teamai] Publish ${counts.join(' and ')}`,
    };
  });

  switch (outcome.status) {
    case 'published':
    case 'already-present': {
      for (const record of queued) await dequeue(config, record);

      for (const benchmark of benchmarks) await dequeueBenchmark(benchmark);
      const remaining = new Set(await fs.readdir(pendingDir(config)).catch(() => []));
      const remainingBenchmarks = new Set((await pendingBenchmarks(config)).map(({ file }) => file));

      return queued.some((record) => remaining.has(path.basename(pendingPath(config, record)))) || benchmarks.some(({ file }) => remainingBenchmarks.has(file))
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

/** The part of a published run snapshot that names the install owning the run. */
const SnapshotOwnerSchema = z.object({ owner: z.object({ id: z.string() }) });

/** Whether `snapshot`, a run's published state as origin holds it, names an install other than `install` as its owner. */
function ownedElsewhere(snapshot: string | null, install: string): boolean {
  if (snapshot === null) return false;

  try {
    const parsed = SnapshotOwnerSchema.safeParse(JSON.parse(snapshot));

    return parsed.success && parsed.data.owner.id !== install;
  } catch {
    return false;
  }
}

// ─── Stats totals ───────────────────────────────────────

/**
 * A member's stats file on the reports branch: the fields workflow totals read, with every other field kept as written,
 * so a stats update never drops what other reports put there. A total that is not a number reads as absent.
 */
const MemberStatsSchema = z.looseObject({
  username: z.string().optional().catch(undefined),
  workflows: z.object({
    runs: z.number().optional().catch(undefined),
    succeeded: z.number().optional().catch(undefined),
    failed: z.number().optional().catch(undefined),
    totalDurationMs: z.number().optional().catch(undefined),
  }).optional().catch(undefined),
});

export type MemberStats = z.infer<typeof MemberStatsSchema>;

/**
 * Guarantee the fields digest's loadTeamStats requires (`username` AND
 * `skills`). A member whose first report is a workflow run — no usage events,
 * no session stats — still gets a digest-visible stats file (#1126 P1).
 * An existing well-formed stats object passes through untouched.
 */
export function ensureDigestFields(existing: MemberStats, username: string): MemberStats {
  if (existing.username === username && existing.skills) return existing;
  const stats: MemberStats = { updatedAt: new Date().toISOString(), ...existing };

  if (existing.username !== username) stats.username = username;

  if (!existing.skills) stats.skills = {};

  return stats;
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
  existing: MemberStats,
  username: string,
  records: WorkflowRunRecord[],
  originByRun: ReadonlyMap<string, WorkflowRunRecord | null> = new Map(),
): MemberStats {
  const current = existing.workflows ?? {};
  const byRun = new Map<string, WorkflowRunRecord>();

  for (const record of records) {
    const prior = byRun.get(record.run);

    // End phase wins within one delivery; a start-only run has not ended yet
    // and is not counted as a run.
    if (!prior || (prior.phase === 'start' && record.phase === 'end')) byRun.set(record.run, record);
  }

  let { runs = 0, succeeded = 0, failed = 0, totalDurationMs = 0 } = current;

  const fold = (record: WorkflowRunRecord, sign: 1 | -1): void => {
    // An isolated run's steps are measurements, not workflow outcomes, so it is in no workflow total.
    if (record.username !== username || record.isolated === true) return;
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
