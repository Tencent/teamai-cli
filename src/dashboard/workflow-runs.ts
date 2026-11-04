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
 * request, and the answer of a pass not yet settled. A run handed over on
 * `teamai-reports` (#1390) comes from `PublishedRuns`, which reads only the
 * snapshot header and the steps' status.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RunOriginSchema, type RunOrigin } from '../default-workflows.js';
import { agentHarnessOf, harnessChanges, readRecordedAgent, type AgentHarness, type HarnessChange } from '../agent-observation.js';
import { getReportsDir, usesBranchWorktree, type LocalConfig } from '../types.js';
import { knownSecrets, resolveWorkflowEnv } from '../env-resolution.js';
import { LabelStore, type PassScore, type ScoringTotal } from '../scorers/label-store.js';
import { RunJudging, type PassJudging } from '../scorers/run-judging.js';
import { WorkOutcomeSchema, type WorkOutcome } from '../outcomes.js';
import { benchmarkRecordFile, BenchmarkRunRecordSchema } from '../benchmark/result.js';
import { benchmarkCells, benchmarkTable, type BenchmarkCells } from '../benchmark/table.js';
import { locateStep } from '../workflow/engine.js';
import { benchmarkRecordPath, buildEndRecord, RECORDS_DIR, RunRecordFieldsSchema, runRecordStates, type RecordState, type WorkflowRunRecord } from '../workflow/records.js';
import { settledBranches, type SettledBranches } from '../workflow/leftovers.js';
import { ownRunSweptAt, resolveRetention, type ResolvedRetention } from '../workflow/retention.js';
import { loadTeamConfig } from '../config.js';
import { callerProvenance, respondProvenance, respondToHitl } from '../workflow/run-controls.js';
import { PublishedRuns, type PublishedRun, type Taker } from '../workflow-published-runs.js';
import { installOwner, isRunId, readRun, readRuns, runsDir } from '../workflow/store.js';
import type { TokenUsage } from '../tool-launch/stdout.js';
import type { StepHitl, RunState } from '../workflow/types.js';
import { HttpError, type JsonBody } from './http.js';

/** The newest runs each source lists; a run still running on this machine is always listed. */
const RUN_LIMIT = 50;

/**
 * The record fields the page reads, from whichever version wrote the file.
 * `prs` is the delivered pull request list #1090 adds to the end record.
 */
type ReadRecord = Pick<WorkflowRunRecord,
  'run' | 'workflow' | 'alias' | 'sourceHash' | 'teamRevision' | 'origin' | 'driver' | 'status' | 'end' | 'startedAt' | 'endedAt' | 'durationMs' | 'stepCounts' | 'username'>
  & { steps?: StepEntry[]; prs?: unknown[] };

type StepEntry = Pick<NonNullable<WorkflowRunRecord['steps']>[number], 'step' | 'pass' | 'outcome' | 'tokens' | 'agent'>
  & { answer?: { choice: string; channel: string }; outcomes?: unknown[] };

const TokensSchema: z.ZodType<TokenUsage> = z.object({ input: z.number().optional(), output: z.number().optional(), cachedInput: z.number().optional() });

/** Only links a browser opens as a web page; a `javascript:` URL from either source never becomes a link. */
const WebUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value);

    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
});

/** The web links among a record's delivered pull requests. */
function webUrls(prs: unknown[] | undefined): string[] {
  return (prs ?? []).flatMap((pr) => {
    const url = WebUrlSchema.safeParse(pr);

    return url.success ? [url.data] : [];
  });
}

const RecordSchema: z.ZodType<ReadRecord> = RunRecordFieldsSchema.extend({
  workflow: z.string(),
  alias: z.string().optional().catch(undefined),
  sourceHash: z.string().optional(),
  teamRevision: z.string().optional(),
  origin: RunOriginSchema.optional().catch(undefined),
  driver: z.object({ kind: z.string() }).optional(),
  end: z.string().optional(),
  startedAt: z.string(),
  durationMs: z.number().optional(),
  stepCounts: z.object({ total: z.number(), succeeded: z.number(), failed: z.number(), skipped: z.number(), cancelled: z.number() }).optional(),
  username: z.string(),
  steps: z.array(z.object({
    step: z.string(),
    pass: z.number(),
    outcome: z.enum(['success', 'failed', 'timeout', 'cancelled']).optional(),
    tokens: TokensSchema.optional(),
    agent: z.unknown().transform((agent) => readRecordedAgent(agent)).optional(),
    answer: z.object({ choice: z.string(), channel: z.string() }).optional(),
    outcomes: z.array(z.unknown()).optional().catch(undefined),
  })).optional(),
});

/** One run as a row of the page. */
interface RunRow {
  run: string;
  workflow: string;
  /** The name people use for the workflow, which the page shows first; absent when it has none, and in older records. */
  alias?: string;
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
  /** Whether the run ran the team's definition or teamai's default, and which teamai shipped it; absent in older records. */
  origin?: RunOrigin;
  prs: string[];
  /** The ids of the learnings its passes recorded, once each, in the order they appear. */
  learnings: string[];
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
  /** Why a skipped step of a run of this machine was skipped, when the engine said. */
  message?: string;
  tokens?: TokenUsage;
  answer?: { choice: string; channel: string };
  gate?: Gate;
  /** The labels scorers gave this pass. */
  scores?: PassScore[];
  /** For a pass this machine judges, each scorer without a label and why. */
  unlabelled?: PassJudging['unlabelled'];
  /** The teamai-score runs of this pass on this machine, oldest first. */
  scoreRuns?: PassJudging['scoreRuns'];
  /** What this pass delivered (#1387): the outcomes the page can read, a pull request only on https. */
  outcomes?: WorkOutcome[];
  /** What the pass ran as, when its record observed a tool. */
  harness?: AgentHarness;
  /** What changed in `harness` since the previous pass of the step that recorded one, when anything did. */
  harnessChanges?: HarnessChange[];
}

type KeptRunBranches = Extract<SettledBranches, { state: 'kept' }> & { retention: ResolvedRetention; eligibleAt?: string };

/**
 * A settled local run's `teamai/<run>/…` branches (#1689), as `settledBranches` finds them. Kept branches carry the
 * retention in effect and, unless it is `never`, from when `doctor --fix` removes all but the pull request ones.
 */
export type RunBranches = Exclude<SettledBranches, { state: 'kept' }> | KeptRunBranches;

/** `benchmark` holds an ended benchmark run's tables, as the CLI prints them. */
export type RunDetail = { run: LocalRunRow | ReportedRunRow; steps: StepRow[]; scoring: ScoringTotal; benchmark?: BenchmarkCells; branches?: RunBranches };

/** A run handed over on teamai-reports: offered while `offer` is set, else held by its owner, who claimed it or resumed it. `isMine`: this install owns it. */
export type HandoffRow = PublishedRun & { isMine: boolean };

/** The team history and the runs handed over, or why they could not be read; the local runs show either way. */
export type ReportedHistory = { state: 'ok'; runs: ReportedRunRow[]; handoffs: HandoffRow[] } | { state: 'unavailable' };

const STATUS_OF_OUTCOME = { success: 'succeeded', failed: 'failed', timeout: 'failed', cancelled: 'cancelled' } as const;

function tokenTotal(steps: StepEntry[] | undefined): number {
  return (steps ?? []).reduce((sum, entry) => sum + (entry.tokens?.input ?? 0) + (entry.tokens?.output ?? 0), 0);
}

function learningsOf(steps: StepEntry[] | undefined): string[] {
  const ids = (steps ?? []).flatMap((entry) => (entry.outcomes ?? []).flatMap((outcome) => {
    const parsed = WorkOutcomeSchema.safeParse(outcome);

    return parsed.success && parsed.data.kind === 'learning' ? [parsed.data.id] : [];
  }));

  return [...new Set(ids)];
}

/** The row fields a record may lack; a row leaves out each one its record lacks. */
const OPTIONAL_ROW_FIELDS = [
  'alias', 'driver', 'end', 'endedAt', 'durationMs', 'sourceHash', 'teamRevision', 'origin', 'stepCounts',
] as const satisfies ReadonlyArray<keyof RunRow>;

/** A record as a page row, its fields in the order the page's JSON has always had them. */
function rowOf(record: ReadRecord): RunRow {
  const row: RunRow = {
    run: record.run,
    workflow: record.workflow,
    alias: record.alias,
    driver: record.driver?.kind,
    status: record.status,
    end: record.end,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    tokens: tokenTotal(record.steps),
    sourceHash: record.sourceHash,
    teamRevision: record.teamRevision,
    origin: record.origin,
    prs: webUrls(record.prs),
    learnings: learningsOf(record.steps),
    stepCounts: record.stepCounts,
  };

  for (const field of OPTIONAL_ROW_FIELDS) {
    if (row[field] === undefined) delete row[field];
  }

  return row;
}

/** What the page shows of judging, by `${step}#${pass}`: the labels, and on this machine why the others have none. */
type Judging = ReadonlyMap<string, Pick<PassJudging, 'scores'> & Partial<PassJudging>>;

/** Adds to `row` its pass's labels, and on this machine why its other scorers have none and its score runs. */
function addJudging(row: StepRow, judging: Judging): void {
  const pass = judging.get(`${row.step}#${row.pass}`);

  if (pass?.scores.length) row.scores = pass.scores;

  if (pass?.unlabelled?.length) row.unlabelled = pass.unlabelled;

  if (pass?.scoreRuns?.length) row.scoreRuns = pass.scoreRuns;
}

function stepRow(entry: StepEntry, status: string, judging: Judging, gate?: Gate): StepRow {
  const outcomes = entry.outcomes?.flatMap((outcome) => {
    const parsed = WorkOutcomeSchema.safeParse(outcome);

    return parsed.success ? [parsed.data] : [];
  });

  const harness = agentHarnessOf(entry.agent);
  const row: StepRow = { step: entry.step, pass: entry.pass, status };

  if (entry.tokens) row.tokens = entry.tokens;

  if (entry.answer) row.answer = { choice: entry.answer.choice, channel: entry.answer.channel };

  if (gate) row.gate = gate;

  addJudging(row, judging);

  if (outcomes?.length) row.outcomes = outcomes;

  if (harness) row.harness = harness;

  return row;
}

/** `steps` with what changed in each pass's harness since the previous pass of its step that recorded one. */
function withHarnessChanges(steps: StepRow[]): StepRow[] {
  return steps.map((row) => {
    if (!row.harness) return row;
    let previous: AgentHarness | undefined;
    let previousPass = 0;

    for (const other of steps) {
      if (other.step !== row.step || !other.harness || other.pass >= row.pass || other.pass < previousPass) continue;
      previous = other.harness;
      previousPass = other.pass;
    }

    const changes = previous ? harnessChanges(previous, row.harness) : [];

    return changes.length > 0 ? { ...row, harnessChanges: changes } : row;
  });
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

  const row: LocalRunRow = {
    ...rowOf(localRecord(run)),
    source: 'local',
    current: run.steps.filter((state) => state.status === 'leased' || state.status === 'delivering').map((state) => state.id),
    waiting: run.steps.filter((state) => state.status === 'waiting').map((state) => state.id),
  };

  if (record) row.record = record;

  return row;
}

function reportedRow(record: ReadRecord): ReportedRunRow {
  return { ...rowOf(record), source: 'reported', username: record.username };
}

function newestFirst<T extends { startedAt: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

/** The runs Local runs lists: every running one, then the newest settled ones, none of a private workflow. */
export async function listedRuns(config: LocalConfig): Promise<RunState[]> {
  // A private workflow's runs, such as one per judged pass, would bury the runs a person started.
  const runs = (await readRuns(config)).filter((run) => !run.definition.private).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const running = runs.filter((run) => run.status === 'running');

  return [...running, ...runs.filter((run) => run.status !== 'running').slice(0, Math.max(0, RUN_LIMIT - running.length))];
}

/** This machine's runs in the scope: every running one, then the newest settled ones. */
export async function listLocalRuns(config: LocalConfig): Promise<LocalRunRow[]> {
  const runs = await listedRuns(config);
  const records = await runRecordStates(config, runs.filter((run) => run.status !== 'running'));

  return runs.map((run) => localRow(run, records));
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

/** A person at this machine's terminal, who would take an offered run with the local driver. */
const PERSON: Taker = { caller: { evidence: { kind: 'none' }, confirmed: false, mode: 'attended' }, driver: 'local', tools: {}, sandbox: false, hasPerson: true };

/**
 * The runs handed over on the scope's reports checkout, as `listReportedRuns` last refreshed it: each offered one says
 * what in its steps left needs a person, which keeps a runner's unattended `workflow resume --next` from taking it.
 */
export async function listHandoffs(config: LocalConfig): Promise<HandoffRow[]> {
  const [runs, self] = await Promise.all([PublishedRuns.list(config, { taker: PERSON, env: await resolveWorkflowEnv(config) }), installOwner(config)]);

  return runs.map((run) => ({ ...run, isMine: run.owner.id === self.id }));
}

/**
 * The tables of the benchmark record in `file`, which a run has once its `teamai benchmark report` wrote it. A record
 * this version cannot read leaves the run shown, without its tables.
 */
async function benchmarkOf(file: string): Promise<Pick<RunDetail, 'benchmark'>> {
  try {
    const parsed = BenchmarkRunRecordSchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));

    return parsed.success ? { benchmark: benchmarkCells(benchmarkTable({ benchmark: parsed.data })) } : {};
  } catch {
    return {};
  }
}

/** `row` with why its step was skipped, when the engine said. */
function withSkipReason(row: StepRow, state: RunState['steps'][number] | undefined): StepRow {
  if (state?.status === 'skipped' && state.message !== undefined) row.message = state.message;

  return row;
}

function localDetail(run: RunState, row: LocalRunRow, judging: Judging, scoring: ScoringTotal): Omit<RunDetail, 'benchmark'> {
  const live = new Map(run.steps.map((state) => [`${state.id}#${state.pass ?? 1}`, state]));
  const record = localRecord(run);

  const steps = (record.steps ?? []).map((entry) => {
    const state = live.get(`${entry.step}#${entry.pass}`);
    const hitl = state?.status === 'waiting' ? locateStep(run, state.id)?.step.hitl : undefined;
    const gate = hitl ? { kind: hitl.kind, options: hitl.options, required: hitl.required } : undefined;
    // A record entry keeps the answer only once its pass settles; an answered step still pending shows it too.
    const answer = entry.answer ?? state?.answer;

    const answered: StepEntry = { ...entry };

    if (answer) answered.answer = answer;

    return withSkipReason(stepRow(answered, state?.status ?? (entry.outcome ? STATUS_OF_OUTCOME[entry.outcome] : 'skipped'), judging, gate), state);
  });

  return { run: row, steps: withHarnessChanges(steps), scoring };
}

/** What `run` left of its branches, once it settled and left any. */
async function branchesOf(config: LocalConfig, run: RunState): Promise<Pick<RunDetail, 'branches'>> {
  const branches = settledBranches(run);

  if (branches?.state !== 'kept') return branches ? { branches } : {};
  const retention = await resolveRetention(config, await loadTeamConfig(config.repo.localPath));
  const kept: KeptRunBranches = { ...branches, retention };
  const ends = ownRunSweptAt(run, retention);

  if (ends !== undefined) kept.eligibleAt = new Date(ends).toISOString();

  return { branches: kept };
}

/** A run of this machine with how judging stands for it here, or undefined when there is no such run. */
async function localRunDetail(config: LocalConfig, runId: string): Promise<RunDetail | undefined> {
  const run = await readRun(config, runId);

  if (run === 'missing' || run === 'corrupt') return undefined;

  const [records, judging, benchmark, branches] = await Promise.all([
    runRecordStates(config, run.status === 'running' ? [] : [run]),
    RunJudging.of(config, [run], new Date().toISOString()).then((byRun) => byRun.get(runId)),
    benchmarkOf(benchmarkRecordFile(runsDir(config), runId)),
    branchesOf(config, run),
  ]);

  return { ...localDetail(run, localRow(run, records), judging?.passes ?? new Map(), await RunJudging.total(config, runId, judging)), ...benchmark, ...branches };
}

/** One run with a row per pass of each step, or undefined when the source holds no such run. */
export async function workflowRunDetail(config: LocalConfig, source: 'local' | 'reported', runId: string): Promise<RunDetail | undefined> {
  if (!isRunId(runId)) return undefined;

  if (source === 'local') return localRunDetail(config, runId);

  if (usesBranchWorktree(config)) {
    // The history refreshes the checkout; a detail only checks it is this repository's.
    const { readableReportsWorktree } = await import('../utils/reports-branch.js');
    await readableReportsWorktree(config, { dryRun: true });
  }

  const record = await readRecord(path.join(getReportsDir(config), RECORDS_DIR, `${runId}.json`));

  if (!record) return undefined;

  const [scores, scoring, benchmark] = await Promise.all([
    LabelStore.ofRuns(config, [runId], { published: true }),
    LabelStore.scoringTotal(config, runId, 'published'),
    benchmarkOf(path.join(getReportsDir(config), benchmarkRecordPath(runId))),
  ]);

  const passes = new Map([...scores.get(runId) ?? []].map(([key, labels]) => [key, { scores: labels }]));

  return {
    run: reportedRow(record),
    steps: withHarnessChanges((record.steps ?? []).map((entry) => stepRow(entry, entry.outcome ? STATUS_OF_OUTCOME[entry.outcome] : 'skipped', passes))),
    scoring,
    ...benchmark,
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
export async function answerFromDashboard(config: LocalConfig, body: JsonBody): Promise<{ answered: unknown }> {
  const parsed = AnswerSchema.safeParse(body);

  if (!parsed.success) throw new HttpError(400, 'Send run, step, pass and choice of the HITL request you answer.');
  const { run, step, pass, choice } = parsed.data;
  const provenance = respondProvenance({ kind: 'dashboard', caller: callerProvenance(process.env, process.stdin) });
  const envelope = await respondToHitl(config, run, await knownSecrets(config), { step, choice, pass, provenance });

  if ('error' in envelope) throw new HttpError(STALE_CODES.has(envelope.error.code) ? 409 : 400, envelope.error.message);

  return { answered: envelope.data.answered };
}
