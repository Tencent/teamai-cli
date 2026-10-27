/**
 * The dashboard's Workflow Runs page (#1088): this machine's runs, the run
 * records the team published, and the HITL answers the page sends.
 *
 * Every row is built from a run record, the allowlist `records.ts` owns. A
 * local run goes through `buildEndRecord`, as the record it will publish, so
 * inputs, items, outputs, prompts, HITL messages and local paths have no field
 * to reach the API in. A published record is parsed through the same fields.
 * A local run adds only what the record lacks while it runs: the ids and
 * status of its steps, the kind, options and `required` flag of a waiting HITL
 * request, and the answer of a pass not yet settled.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from '../types.js';
import { knownSecrets } from '../env-resolution.js';
import { LabelStore, type PassScore } from '../scorers/label-store.js';
import { WorkOutcomeSchema, type WorkOutcome } from '../outcomes.js';
import { locateStep } from '../workflow/engine.js';
import { buildEndRecord, RECORDS_DIR, runRecordStates, type RecordState, type WorkflowRunRecord } from '../workflow/records.js';
import { callerProvenance, respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import { isRunId, readRun, runsDir } from '../workflow/store.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { StepHitl, RunState } from '../workflow/types.js';
import { HttpError } from './http.js';

/** The newest runs each source lists; a run still running on this machine is always listed. */
const RUN_LIMIT = 50;

/**
 * The record fields the page reads, from whichever version wrote the file.
 * `prs` is the delivered pull request list #1090 adds to the end record.
 */
type ReadRecord = Pick<WorkflowRunRecord,
  'run' | 'workflow' | 'sourceHash' | 'teamRevision' | 'driver' | 'status' | 'end' | 'startedAt' | 'endedAt' | 'durationMs' | 'stepCounts' | 'username'>
  & { steps?: StepEntry[]; prs?: unknown[] };
type StepEntry = Pick<NonNullable<WorkflowRunRecord['steps']>[number], 'step' | 'pass' | 'outcome' | 'tokens'>
  & { answer?: { choice: string; channel: string }; outcomes?: unknown[] };

const TokensSchema: z.ZodType<TokenUsage> = z.object({ input: z.number().optional(), output: z.number().optional(), cachedInput: z.number().optional() });
/** Only links a browser opens as a web page; a `javascript:` URL from either source never becomes a link. */
function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}
const RecordSchema: z.ZodType<ReadRecord, z.ZodTypeDef, unknown> = z.object({
  run: z.string().refine(isRunId),
  workflow: z.string(),
  sourceHash: z.string().optional(),
  teamRevision: z.string().optional(),
  driver: z.object({ kind: z.string() }).optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  end: z.string().optional(),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationMs: z.number().optional(),
  stepCounts: z.object({ total: z.number(), succeeded: z.number(), failed: z.number(), skipped: z.number(), cancelled: z.number() }).optional(),
  username: z.string(),
  steps: z.array(z.object({
    step: z.string(),
    pass: z.number(),
    outcome: z.enum(['success', 'failed', 'timeout', 'cancelled']).optional(),
    tokens: TokensSchema.optional(),
    answer: z.object({ choice: z.string(), channel: z.string() }).optional(),
    outcomes: z.array(z.unknown()).optional().catch(undefined),
  })).optional(),
  prs: z.array(z.unknown()).optional().catch(undefined),
});

/** One run as a row of the page. */
interface RunRow {
  run: string;
  workflow: string;
  driver?: string;
  status: WorkflowRunRecord['status'];
  end?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Input and output tokens of every pass. */
  tokens: number;
  sourceHash?: string;
  /** Absent when no pushed team commit holds the definitions the run used. */
  teamRevision?: string;
  prs: string[];
  stepCounts?: ReadRecord['stepCounts'];
}

/** A run on this machine, as its run file stands now. */
export type LocalRunRow = RunRow & {
  source: 'local';
  /** Agent leases and deliveries currently in progress. */
  current: string[];
  /** The steps whose HITL request waits for an answer. */
  waiting: string[];
  /** Whether the end record reached the team, for a settled run that queued one. */
  record?: RecordState;
};

/** A run as a member published it on the reports branch. */
export type ReportedRunRow = RunRow & { source: 'reported'; username: string };

/** A HITL request the page can answer. */
type Gate = Pick<StepHitl, 'kind' | 'options' | 'required'>;

/** One pass of one step. `status` is the live status for a local run's current pass. */
interface StepRow {
  step: string;
  pass: number;
  status: string;
  tokens?: TokenUsage;
  answer?: { choice: string; channel: string };
  gate?: Gate;
  /** The labels scorers gave this pass. */
  scores?: PassScore[];
  /** What this pass delivered (#1387): the outcomes the page can read, a pull request only on https. */
  outcomes?: WorkOutcome[];
}

/** What judging a run cost, kept apart from the run's own tokens: every attempt on this machine, or the published labels. */
type ScoringTotal = Awaited<ReturnType<typeof LabelStore.scoringTotal>>;

export type RunDetail = { run: LocalRunRow | ReportedRunRow; steps: StepRow[]; scoring: ScoringTotal };

/** The team history, or why it could not be read; the local runs show either way. */
export type ReportedHistory = { state: 'ok'; runs: ReportedRunRow[] } | { state: 'unavailable' };

const STATUS_OF_OUTCOME = { success: 'succeeded', failed: 'failed', timeout: 'failed', cancelled: 'cancelled' } as const;

function tokenTotal(steps: StepEntry[] | undefined): number {
  return (steps ?? []).reduce((sum, entry) => sum + (entry.tokens?.input ?? 0) + (entry.tokens?.output ?? 0), 0);
}

function rowOf(record: ReadRecord): RunRow {
  return {
    run: record.run,
    workflow: record.workflow,
    ...(record.driver ? { driver: record.driver.kind } : {}),
    status: record.status,
    ...(record.end !== undefined ? { end: record.end } : {}),
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    tokens: tokenTotal(record.steps),
    ...(record.sourceHash !== undefined ? { sourceHash: record.sourceHash } : {}),
    ...(record.teamRevision !== undefined ? { teamRevision: record.teamRevision } : {}),
    prs: (record.prs ?? []).filter(isWebUrl),
    ...(record.stepCounts ? { stepCounts: record.stepCounts } : {}),
  };
}

function stepRow(entry: StepEntry, status: string, scores: ReadonlyMap<string, PassScore[]> | undefined, gate?: Gate): StepRow {
  const passScores = scores?.get(`${entry.step}#${entry.pass}`);
  const outcomes = entry.outcomes?.flatMap((outcome) => {
    const parsed = WorkOutcomeSchema.safeParse(outcome);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    step: entry.step,
    pass: entry.pass,
    status,
    ...(entry.tokens ? { tokens: entry.tokens } : {}),
    ...(entry.answer ? { answer: { choice: entry.answer.choice, channel: entry.answer.channel } } : {}),
    ...(gate ? { gate } : {}),
    ...(passScores ? { scores: passScores.map(({ scorer, label, passed }) => ({ scorer, label, passed })) } : {}),
    ...(outcomes?.length ? { outcomes } : {}),
  };
}

/** A local run as the record it will publish; a running run has no end time yet. */
function localRecord(run: RunState): ReadRecord {
  const record = buildEndRecord(run, run.driver, '');
  if (run.status !== 'running') return record;
  const { endedAt: _endedAt, durationMs: _durationMs, ...running } = record;
  return running;
}

function localRow(run: RunState, records: Map<string, RecordState>): LocalRunRow {
  const record = records.get(run.id);
  return {
    ...rowOf(localRecord(run)),
    source: 'local',
    current: run.steps.filter((state) => state.status === 'leased' || state.status === 'delivering').map((state) => state.id),
    waiting: run.steps.filter((state) => state.status === 'waiting').map((state) => state.id),
    ...(record ? { record } : {}),
  };
}

function reportedRow(record: ReadRecord): ReportedRunRow {
  return { ...rowOf(record), source: 'reported', username: record.username };
}

function newestFirst<T extends { startedAt: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function localRuns(config: LocalConfig): Promise<RunState[]> {
  const files = await fs.readdir(runsDir(config)).catch(() => []);
  const ids = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length)).filter(isRunId);
  const runs = await Promise.all(ids.map((id) => readRun(config, id)));
  return runs.filter((run): run is RunState => typeof run === 'object');
}

/** This machine's runs in the scope: every running one, then the newest settled ones. */
export async function listLocalRuns(config: LocalConfig): Promise<LocalRunRow[]> {
  const runs = (await localRuns(config)).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const running = runs.filter((run) => run.status === 'running');
  const settled = runs.filter((run) => run.status !== 'running').slice(0, Math.max(0, RUN_LIMIT - running.length));
  const records = await runRecordStates(config, settled);
  return [...running, ...settled].map((run) => localRow(run, records));
}

function recordsDir(config: LocalConfig): string {
  return path.join(getReportsDir(config), RECORDS_DIR);
}

async function readRecord(file: string): Promise<ReadRecord | undefined> {
  try {
    const parsed = RecordSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The run records on the scope's reports checkout, refreshed from origin first like every reader of it.
 * A record this version cannot read is left out rather than failing the page.
 */
export async function listReportedRuns(config: LocalConfig): Promise<ReportedRunRow[]> {
  if (usesBranchWorktree(config)) {
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(config);
  }
  const dir = recordsDir(config);
  const files = (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.json'));
  const records = await Promise.all(files.map((file) => readRecord(path.join(dir, file))));
  return newestFirst(records.filter((record) => record !== undefined).map(reportedRow)).slice(0, RUN_LIMIT);
}

function localDetail(run: RunState, row: LocalRunRow, scores: ReadonlyMap<string, PassScore[]> | undefined, scoring: ScoringTotal): RunDetail {
  const live = new Map(run.steps.map((state) => [`${state.id}#${state.pass ?? 1}`, state]));
  const steps = (localRecord(run).steps ?? []).map((entry) => {
    const state = live.get(`${entry.step}#${entry.pass}`);
    const hitl = state?.status === 'waiting' ? locateStep(run, state.id)?.step.hitl : undefined;
    const gate = hitl ? { kind: hitl.kind, options: hitl.options, required: hitl.required } : undefined;
    // A record entry keeps the answer only once its pass settles; an answered step still pending shows it too.
    const answer = entry.answer ?? state?.answer;
    return stepRow({ ...entry, ...(answer ? { answer } : {}) }, state?.status ?? (entry.outcome ? STATUS_OF_OUTCOME[entry.outcome] : 'skipped'), scores, gate);
  });
  return { run: row, steps, scoring };
}

/** One run with a row per pass of each step, or undefined when the source holds no such run. */
export async function workflowRunDetail(config: LocalConfig, source: 'local' | 'reported', runId: string): Promise<RunDetail | undefined> {
  if (!isRunId(runId)) return undefined;
  if (source === 'local') {
    const run = await readRun(config, runId);
    if (typeof run !== 'object') return undefined;
    const [records, scores, scoring] = await Promise.all([
      runRecordStates(config, run.status === 'running' ? [] : [run]),
      LabelStore.ofRuns(config, [runId], { published: false }),
      LabelStore.scoringTotal(config, runId, 'local'),
    ]);
    return localDetail(run, localRow(run, records), scores.get(runId), scoring);
  }
  if (usesBranchWorktree(config)) {
    // The history refreshes the checkout; a detail only checks it is this repository's.
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(config, { dryRun: true });
  }
  const record = await readRecord(path.join(getReportsDir(config), RECORDS_DIR, `${runId}.json`));
  if (!record) return undefined;
  const [scores, scoring] = await Promise.all([
    LabelStore.ofRuns(config, [runId], { published: true }),
    LabelStore.scoringTotal(config, runId, 'published'),
  ]);
  const passes = scores.get(runId);
  return {
    run: reportedRow(record),
    steps: (record.steps ?? []).map((entry) => stepRow(entry, entry.outcome ? STATUS_OF_OUTCOME[entry.outcome] : 'skipped', passes)),
    scoring,
  };
}

const AnswerSchema = z.object({
  run: z.string().refine(isRunId, 'run must be a run id'),
  step: z.string().min(1),
  /** The pass the page showed, so an answer to a replaced HITL request is refused. */
  pass: z.number().int().positive(),
  choice: z.string().min(1),
});

/** Engine refusals that mean the page showed an old state; the page reloads and asks again. */
const STALE_CODES = new Set(['stale_response', 'repeated_response', 'not_waiting', 'run_settled']);

/**
 * Records a person's answer from the page through the engine's `respond`, as channel `dashboard`. An agent session in
 * the server's environment makes it an agent's answer, as it would make one from that shell. The page must send the
 * pass it showed. Throws an HttpError the page shows when the engine refuses it.
 */
export async function answerFromDashboard(config: LocalConfig, body: Record<string, unknown>): Promise<{ answered: unknown }> {
  const parsed = AnswerSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Send run, step, pass and choice of the HITL request you answer.');
  const { run, step, pass, choice } = parsed.data;
  const provenance = respondProvenance({ kind: 'dashboard', caller: callerProvenance(process.env, process.stdin) });
  const envelope = await respondToHitl(config, run, await knownSecrets(config), { step, choice, pass, provenance });
  if ('error' in envelope) throw new HttpError(STALE_CODES.has(envelope.error.code) ? 409 : 400, envelope.error.message);
  return { answered: envelope.data.answered };
}
